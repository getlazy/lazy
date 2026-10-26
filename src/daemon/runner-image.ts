import { currentDiskSpaceManager } from '../docker/disk-space';
/**
 * The project's custom runner image (`[docker] dockerfile`) is built when the
 * daemon BOOTS, and the daemon owns its state.
 *
 * Why: a Teams VM replacement wipes the guest's images, and the build used to
 * happen inside the first builder or task launch — the engineer's first
 * builder start after a replacement sat through a ~25-minute build and then
 * failed. Now:
 *
 * - The build starts in the background at boot. Everything short of launching
 *   an agent keeps working the whole time.
 * - Inside the daemon `ensureImage` asks this module (through the
 *   custom-image gate) instead of inspecting-and-building: a launch never
 *   starts its own build of the custom image, not while this one runs and not
 *   after it failed. A failed build stays `failed`, with its reason and the
 *   Dockerfile, until the Dockerfile changes or someone retries.
 * - While the image is not ready, builders start on lazy's DEFAULT runner image
 *   with a banner, and agent launches need an explicit confirmation to do the
 *   same (src/daemon/runner-image-choice.ts). Nothing switches back on its own.
 *
 * Only the ROOT image is governed here: `[docker] dockerfile`, or with it unset
 * a committed root Dockerfile.lazy (resolveCustomDockerfile decides both).
 * A task's consented pin
 * and a daemon adoption resolve before the gate in `ensureImage`, exactly as
 * before, and nothing here ever reads a task worktree.
 */
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger';
import { spawn } from '../utils/spawn';
import { autoBuildsRootDockerfile } from '../config/managed-mode';
import { loadConfig } from '../config/loader';
import { registerCustomImageGate, type CustomImageVerdict } from '../capture/custom-image-gate';
import { ensureImage, forgetBuildFailure, resetBuildFailuresForTests, resolveImageRepository, IMAGE_TAG, resolveCustomDockerfile, describeDockerfileSource, runWithBuildContext, rootIntegrationBranch, gitInRoot } from '../capture/claude';
import { runWithoutBuildObserver } from '../capture/build-observer';
import { startImageBuildJob, whileNotCancelled, type ImageBuildJob } from './image-build-job';
import { forgetFailedDamagedImageRepair } from '../docker/damaged-image';
import { exportTree, adoptionBuildStatus } from './image-adoption';
import { readBuiltFromLabel } from '../docker/image-built-from';

/**
 * Carried by `building` and `failed` when the build REPLACES a ready image (a
 * Rebuild): docker moves the tag only when the build succeeds, so the image
 * launches were using stays in use the whole time, and after a failure.
 */
interface Replacing {
  replacing?: boolean;
}

/** A commit on the project's acting branch an image was built from, or is being built from. */
export interface BranchCommit {
  branch: string;
  /** The full commit sha. */
  sha: string;
}

export type RunnerImageState =
  /** No custom image is configured, or the runner has no image: nothing to wait for. */
  | { state: 'none' }
  | { state: 'checking'; imageName: string; dockerfile: string; defaultImage: string; startedAt: string; buildId?: string | null; attemptedFrom?: BranchCommit }
  | ({
      state: 'building'; imageName: string; dockerfile: string; defaultImage: string; startedAt: string;
      /** Why the build runs (missing, inputs changed, too old, requested). */
      reason: string | null;
      /** The newest line the build printed. */
      progress: string | null;
      /** The build's log (`imageBuildLog`). */
      buildId?: string | null;
      /** The branch commit this build is from, when it follows the branch. */
      attemptedFrom?: BranchCommit;
      /** While replacing: the commit the image still in use was built from. */
      builtFrom?: BranchCommit;
    } & Replacing)
  | { state: 'ready'; imageName: string; dockerfile: string; defaultImage: string; readyAt: string; buildId?: string | null;
      /** The branch commit the image was last built from (set when the branch advanced and the daemon rebuilt it). */
      builtFrom?: BranchCommit;
      /** The last background refresh failed; the next one is not tried before this (ISO 8601). */
      refreshRetryAt?: string }
  | ({
      state: 'failed'; imageName: string; dockerfile: string; defaultImage: string; failedAt: string; error: string;
      buildId?: string | null;
      /** Somebody pressed Cancel; `error` says so. */
      cancelled?: boolean;
      /** An earlier attempt failed or never finished; the daemon builds again by itself once this time (ISO 8601) has passed. */
      retryAt?: string;
      /** The ref adoption's commit can no longer be found, so it cannot be rebuilt. */
      adoptionUnavailable?: boolean;
      /** The branch commit the failed build was from, when it follows the branch. */
      attemptedFrom?: BranchCommit;
      /** While replacing: the commit the image still in use was built from. */
      builtFrom?: BranchCommit;
    } & Replacing);

interface Tracker {
  projectRoot: string;
  binary: string;
  /**
   * Make the engine `binary` drives able to build, before a build (not a
   * periodic re-check): the smolvm runner brings its project machine up here,
   * which its relay deliberately never does by itself.
   */
  prepare?: () => Promise<void>;
  status: RunnerImageState;
  /** Bumped per build so a superseded build's completion cannot overwrite a newer state. */
  generation: number;
  /** When the ready image was last checked against its inputs and age. */
  checkedAt: number;
  refreshing: boolean;
  /** Consecutive failed background refreshes, and the earliest time (ms) the next may start. */
  refreshFailures: number;
  refreshRetryAtMs: number;
  /** The build running now (or last run), for its log and its Cancel. */
  job: ImageBuildJob | null;
  /** The acting branch's tip the daemon last looked at; null until the first look (which only records it). */
  seenTip?: string | null;
  /** The newest tip that arrived while a build ran: built once that one ends. Older ones in between are skipped. */
  queuedTip?: BranchCommit | null;
  /** An advance is being exported, resolved or built: another waits (queuedTip) until it ends. */
  advancing?: boolean;
  /** Test seams of the latest note, so a drain started by a build's end uses them too. */
  advanceDeps?: AdvanceDeps;
  /** The branch commit the image in use was built from; undefined when it was built from anything else. */
  servingFrom?: BranchCommit;
}

let tracker: Tracker | null = null;
/** Settles when the latest Rebuild of lazy's default image is over (never rejects) — what a damaged-image repair awaits. */
let defaultRebuildDone: Promise<void> = Promise.resolve();

/** The daemon's view of the custom image — what the `runnerImage` RPC answers. */
export function runnerImageStatus(): RunnerImageState {
  return tracker?.status ?? { state: 'none' };
}

/**
 * Whether a launch that wants the custom image can have it right now: it is
 * ready — or a Rebuild is replacing it, or failed to, and the image it was
 * replacing is still the one in use.
 */
export function customImageReady(): boolean {
  const s = runnerImageStatus();
  if (s.state === 'none' || s.state === 'ready') return true;
  return (s.state === 'building' || s.state === 'failed') && s.replacing === true;
}

/** The project image's current (or last) build job. */
export function runnerImageJob(): ImageBuildJob | null {
  return tracker?.job ?? null;
}

/** "main @ 1a2b3c4d5e6f" — the branch and the shortened commit an image was built from. */
export function describeBranchCommit(c: BranchCommit): string {
  return `${c.branch} @ ${c.sha.substring(0, 12)}`;
}

/** One sentence for a refusal, a banner or a start timeline. */
export function describeRunnerImage(s: RunnerImageState = runnerImageStatus()): string {
  switch (s.state) {
    case 'none': return 'This project runs on lazy\'s default runner image.';
    case 'checking': return `Checking the project's runner image ${s.imageName} (from ${s.dockerfile}).`;
    case 'building':
      if (s.replacing) return `The project's runner image ${s.imageName} is being rebuilt from ${s.dockerfile}; the current one stays in use until it succeeds.`;
      return `The project's runner image ${s.imageName} (from ${s.dockerfile}) is still building` +
        (s.reason ? ` — ${s.reason}` : '') + '.';
    case 'ready': return `The project's runner image ${s.imageName} is ready` +
      (s.builtFrom ? `, built from ${describeBranchCommit(s.builtFrom)}` : '') + '.' +
      (s.refreshRetryAt ? ` Refreshing it failed; the next attempt is not before ${s.refreshRetryAt}.` : '');
    case 'failed':
      if (s.replacing) return `Rebuilding the project's runner image ${s.imageName} from ${s.dockerfile}${s.attemptedFrom ? ` (${describeBranchCommit(s.attemptedFrom)})` : ''} failed; the current one stays in use: ${s.error}`;
      return `The project's runner image ${s.imageName} failed to build from ${s.dockerfile}: ${s.error}`;
  }
}

function verdict(): CustomImageVerdict {
  const ready = customImageReady();
  return {
    ready,
    message: ready
      ? describeRunnerImage()
      : `${describeRunnerImage()} Run on lazy's default runner image instead, or wait for it.`,
  };
}


/**
 * Build-attempt memory ACROSS daemon restarts. A guest dockerd that dies
 * during a build can take the daemon with it, and the fleet restarts a daemon
 * that comes back healthy with no backoff of its own, so without this every
 * restart re-ran the build that killed the machine. The record is local
 * housekeeping (`.lazy/`, never Storage): written before an attempt, so an
 * attempt that never reported back counts as a failure, and deleted on success.
 */
interface BootAttemptRecord { imageName: string; failures: number; lastAttemptAt: string; inProgress: boolean; error: string | null }

function bootAttemptPath(projectRoot: string): string {
  return join(projectRoot, '.lazy', 'runner-image-attempt.json');
}

async function readBootAttempt(projectRoot: string, imageName: string): Promise<BootAttemptRecord | null> {
  let raw: string;
  try {
    raw = await readFile(bootAttemptPath(projectRoot), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${bootAttemptPath(projectRoot)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let rec: BootAttemptRecord;
  try {
    rec = JSON.parse(raw);
  } catch (err) {
    logger.warn(`Runner image: ignoring unreadable ${bootAttemptPath(projectRoot)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return rec.imageName === imageName ? rec : null;
}

async function writeBootAttempt(projectRoot: string, rec: BootAttemptRecord): Promise<void> {
  await mkdir(join(projectRoot, '.lazy'), { recursive: true });
  await writeFile(bootAttemptPath(projectRoot), JSON.stringify(rec));
}

async function clearBootAttempt(projectRoot: string): Promise<void> {
  await rm(bootAttemptPath(projectRoot), { force: true });
}

/**
 * The failure to show instead of building, when earlier attempts at this image
 * failed (or never finished) and their backoff has not elapsed. Null: go ahead.
 */
export function bootDeferral(rec: BootAttemptRecord | null, now = Date.now()): { failures: number; retryAt: string; error: string } | null {
  if (!rec) return null;
  const failures = rec.inProgress ? rec.failures + 1 : rec.failures;
  if (failures === 0) return null;
  const retryAtMs = Date.parse(rec.lastAttemptAt) + refreshBackoffMs(failures);
  if (!(retryAtMs > now)) return null;
  const error = rec.inProgress ? 'the previous build attempt never finished (the daemon or its build host went down during it)' : (rec.error ?? 'the previous build attempt failed');
  return { failures, retryAt: new Date(retryAtMs).toISOString(), error };
}

/**
 * Start (or restart) the build of `imageName`. The build runs through
 * `ensureImage` itself — same lock, same identity labels, same "is it current"
 * test — with the gate bypassed, so an up-to-date image settles in a second.
 */
function startBuild(
  t: Tracker,
  imageName: string,
  dockerfile: string,
  defaultImage: string,
  opts: {
    rebuild?: boolean; noCache?: boolean; replacing?: boolean; explicit?: boolean;
    /** A rebuild because the acting branch advanced: built from `dir`, that commit's exported tree. */
    advance?: { commit: BranchCommit; dir: string; /** The image id the tag named before: a build that leaves it unchanged did not build. */ imageBefore: string | null };
    /** The boot build: export `commit` inside the job and build from it (only if the image needs it, as before). */
    committed?: { commit: BranchCommit };
  } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const generation = ++t.generation;
  const startedAt = new Date().toISOString();
  // A superseded build is stopped, not left running beside its replacement.
  if (t.job && t.job.outcome === 'running') t.job.controller.abort();
  const job = startImageBuildJob('project', `${opts.rebuild ? 'Rebuild' : 'Build'} ${imageName} from ${dockerfile}`, t.projectRoot || undefined);
  job.metadata = { trigger: opts.advance ? 'branch advance' : opts.rebuild ? 'rebuild' : opts.explicit ? 'retry' : 'boot', commit: (opts.advance?.commit ?? opts.committed?.commit)?.sha, dockerfile, image: imageName };
  t.job = job;
  const replacing = opts.replacing === true;
  const attemptedFrom = opts.advance?.commit;
  const from = attemptedFrom ? { attemptedFrom } : {};
  // The image still in use while a rebuild replaces it keeps saying where it came from.
  const serving = replacing && t.servingFrom ? { builtFrom: t.servingFrom } : {};
  t.status = replacing
    ? { state: 'building', imageName, dockerfile, defaultImage, startedAt, reason: attemptedFrom ? `${attemptedFrom.branch} advanced to ${attemptedFrom.sha.substring(0, 12)}` : 'rebuild requested', progress: null, buildId: job.id, replacing, ...from, ...serving }
    : { state: 'checking', imageName, dockerfile, defaultImage, startedAt, buildId: job.id, ...from };
  const current = () => t.generation === generation;
  // Retry / Rebuild are the person asking again: the launch-level failure memory must not refuse them.
  if (opts.explicit || opts.rebuild) forgetBuildFailure(imageName);
  // Whether this build actually rebuilt the image (a boot check of a current image does not).
  let rebuilt = false;
  // The boot build's export of the acting commit, made inside this job (the state already says `checking`).
  let committedDir: string | null = null;
  const done = (async () => {
    // Attempt memory across restarts (see BootAttemptRecord). A deferred build
    // is shown as failed with its next-attempt time; Retry / Rebuild ignore it.
    let failuresSoFar = 0;
    // A rebuild for an advance is not the boot build: its failures must not
    // defer the next daemon boot's build of an image that is fine.
    if (t.projectRoot && !opts.advance) {
      try {
        const rec = await readBootAttempt(t.projectRoot, imageName);
        failuresSoFar = rec ? (rec.inProgress ? rec.failures + 1 : rec.failures) : 0;
        if (failuresSoFar && job.metadata.trigger === 'boot') job.metadata.trigger = 'retry';
        const deferral = opts.explicit || opts.rebuild ? null : bootDeferral(rec);
        if (deferral) {
          job.finish('failed', deferral.error);
          if (!current()) return;
          const error = `${deferral.error}; ${deferral.failures} attempt(s) failed, so the daemon will not try again before ${deferral.retryAt} (Retry builds it now)`;
          t.status = { state: 'failed', imageName, dockerfile, defaultImage, failedAt: new Date().toISOString(), error, buildId: job.id, retryAt: deferral.retryAt, ...(replacing ? { replacing } : {}), ...serving };
          logger.warn(`Runner image: not building ${imageName}: ${error}`);
          return;
        }
        await writeBootAttempt(t.projectRoot, { imageName, failures: failuresSoFar, lastAttemptAt: new Date().toISOString(), inProgress: true, error: null });
      } catch (err) {
        logger.warn(`Runner image: build-attempt memory unavailable, building anyway: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      if (!job.metadata.commit && t.projectRoot) {
        const { loadValidAdoptedImage } = await import('./adopted-image');
        const adopted = await loadValidAdoptedImage(t.projectRoot);
        if (adopted?.source?.kind === 'ref') job.metadata.commit = adopted.source.commit;
        else {
          const ref = await gitInRoot(t.projectRoot, ['rev-parse', '--verify', 'HEAD']);
          if (ref.exitCode === 0) job.metadata.commit = ref.stdout.toString().trim();
          else job.note('Build commit unavailable: ' + ref.stderr.trim());
        }
      }
      // The default image alongside: it is what builders and confirmed agents
      // run on meanwhile. Concurrently, not first — an up-to-date custom image
      // must not read as "checking" for as long as a missing default takes to
      // build. Both this and the custom build's base-first step take the
      // default image's build lock, so a Dockerfile FROM it builds it once.
      // Outside the job: it is not this build, and Cancel must not stop it.
      // (The custom build's own base-first step IS inside the job; if Cancel
      // stops that, this call — waiting on the same lock — builds it after.)
      await t.prepare?.();
      void runWithoutBuildObserver(() => ensureImage(t.binary, { useDefaultImage: true })).catch((err) => {
        logger.warn(`Runner image: lazy's default image ${defaultImage} could not be prepared: ${err instanceof Error ? err.message : String(err)}`);
      });
      const build = () => ensureImage(t.binary, {
        bypassGate: true,
        rebuild: opts.rebuild,
        noCache: opts.noCache,
        notify: (detail) => {
          job.narrate(detail);
          if (!current()) return;
          const s = t.status;
          const building = /^(re)?building /.test(detail);
          if (building) rebuilt = true;
          if (s.state === 'checking' && building) {
            t.status = { state: 'building', imageName, dockerfile, defaultImage, startedAt, reason: detail, progress: null, buildId: job.id, ...from };
            logger.info(`Runner image: ${detail}`);
          } else if (s.state === 'building') {
            t.status = { ...s, progress: detail };
          }
        },
      });
      if (opts.committed) committedDir = await prepareBootContext(t, opts.committed.commit, imageName, job.controller.signal);
      if (job.cancelled) throw new Error('the build was cancelled');
      const committedFrom = committedDir && opts.committed ? opts.committed.commit : undefined;
      const context = opts.advance ?? (committedDir && committedFrom ? { dir: committedDir, commit: committedFrom } : null);
      await whileNotCancelled(job, job.run(() => context ? runWithBuildContext(context.dir, build, context.commit) : build()));
      // ensureImage falls back to the existing image when a build fails while
      // offline and returns normally. For an advance that is a failure: the
      // image was NOT built from this commit.
      if (opts.advance) {
        const after = await imageId(t.binary, imageName);
        if (after === null || after === opts.advance.imageBefore) {
          throw new Error(`the image ${imageName} was not rebuilt from ${describeBranchCommit(opts.advance.commit)} (the build did not complete — offline, or it fell back to the existing image)`);
        }
      }
      job.metadata.imageProduced = rebuilt;
      job.finish('succeeded');
      if (t.projectRoot && !opts.advance) await clearBootAttempt(t.projectRoot).catch((e) => logger.warn(`Runner image: could not clear the attempt record: ${e instanceof Error ? e.message : String(e)}`));
      if (!current()) return;
      // An image the check left alone keeps saying where it came from.
      // A boot build that rebuilt from the committed tree came from that commit.
      if (attemptedFrom || rebuilt) t.servingFrom = attemptedFrom ?? committedFrom;
      const nowFrom = t.servingFrom;
      t.status = { state: 'ready', imageName, dockerfile, defaultImage, readyAt: new Date().toISOString(), buildId: job.id, ...(nowFrom ? { builtFrom: nowFrom } : {}) };
      t.checkedAt = Date.now();
      logger.info(`Runner image: ${imageName} is ready`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (job.cancelled) {
        // cancelRunnerImageBuild already settled the state; only the job's
        // own record is left to close.
        job.finish('cancelled');
        if (t.projectRoot) await clearBootAttempt(t.projectRoot).catch((e) => logger.warn(`Runner image: could not clear the attempt record: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      job.finish('failed', error);
      if (!current()) return; // superseded: the newer build owns the attempt record
      if (t.projectRoot && !opts.advance) await writeBootAttempt(t.projectRoot, { imageName, failures: failuresSoFar + 1, lastAttemptAt: new Date().toISOString(), inProgress: false, error }).catch((e) => logger.warn(`Runner image: could not record the failed attempt: ${e instanceof Error ? e.message : String(e)}`));
      if (!current()) return;
      t.status = { state: 'failed', imageName, dockerfile, defaultImage, failedAt: new Date().toISOString(), error, buildId: job.id, ...(replacing ? { replacing } : {}), ...from, ...serving };
      logger.warn(`Runner image: building ${imageName} from ${dockerfile} FAILED: ${error}`);
    }
  })();
  // Settles when this build is over and never rejects: callers that start a
  // build and walk away ignore it; the damaged-image repair awaits it.
  // The queued advance (if any) starts on its own: whoever awaits THIS build
  // — a damaged-image repair a launch waits on — never waits for the next one.
  return done.then(async () => { if (committedDir) await removeExport(committedDir); }).then(() => { void drainQueuedAdvance(t); }).then(() => job.outcome === 'succeeded'
    ? { ok: true as const }
    : { ok: false as const, error: job.failure?.error ?? (job.outcome === 'cancelled' ? 'the build was cancelled' : 'the build did not finish') });
}


/**
 * Cancel the project image's running build: the docker client is killed, and
 * the state settles AT ONCE — back to `ready` for a Rebuild that was replacing
 * a working image, otherwise `failed` saying it was cancelled (the image was
 * never built, so launches still need it). Null when nothing is building.
 */
export function cancelRunnerImageBuild(): RunnerImageState | null {
  const t = tracker;
  const s = t?.status;
  if (!t || !s || (s.state !== 'building' && s.state !== 'checking')) return null;
  t.generation++;
  t.job?.controller.abort();
  t.job?.finish('cancelled');
  const replacing = s.state === 'building' && s.replacing === true;
  t.status = replacing
    ? { state: 'ready', imageName: s.imageName, dockerfile: s.dockerfile, defaultImage: s.defaultImage, readyAt: new Date().toISOString(), buildId: t.job?.id ?? null, ...(s.builtFrom ? { builtFrom: s.builtFrom } : {}) }
    : {
        state: 'failed', imageName: s.imageName, dockerfile: s.dockerfile, defaultImage: s.defaultImage,
        failedAt: new Date().toISOString(), error: 'The build was cancelled before it finished.', buildId: t.job?.id ?? null, cancelled: true,
      };
  logger.info(`Runner image: the build of ${s.imageName} was cancelled`);
  return t.status;
}

/**
 * The project image follows the ACTING branch: when it gets a new commit, the
 * image is rebuilt in the background from THAT COMMIT's exported tree (never the
 * working tree, never a task branch), and the tag moves only if the build
 * succeeds — launches use the current image the whole time, running containers
 * are untouched, and a failed build is shown and changes nothing else.
 *
 * "The acting branch" is the branch the root image already resolves from: the
 * project root's checked-out branch (the project's branch on Teams). A task
 * branch checked out there, or a detached HEAD, means no branch to follow.
 */
async function actingBranchTip(projectRoot: string): Promise<BranchCommit | null> {
  let branch: string | null;
  try {
    branch = await rootIntegrationBranch(projectRoot);
  } catch (err) {
    // A detached HEAD or a task branch checked out mid-accept is "no branch to
    // follow", not a failure: the image never follows either. Reported at debug
    // because the caller asks on every tick.
    logger.debug(`Runner image: not following a branch: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!branch) return null;
  const local = await revParse(projectRoot, `refs/heads/${branch}`);
  if (!local) return null;
  // On a protected branch work lands on the FORGE (a PR/MR merged there), and
  // the checkout's branch moves only if the daemon's fast-forward of it
  // succeeds. So the remote-tracking ref the daemon's periodic fetch updates
  // counts too — read straight from git: nothing here fetches, and the
  // checked-out branch is never moved. Origin's tip wins only when it CONTAINS
  // the local one; a local branch with commits origin lacks (an accept not yet
  // pushed) stays what the image follows. Only the acting branch's refs are
  // read, so a task branch moving on origin is never followed.
  const remote = await actingRemote(projectRoot);
  const upstream = remote ? await revParse(projectRoot, `refs/remotes/${remote}/${branch}`) : null;
  if (upstream && upstream !== local) {
    const contains = await gitInRoot(projectRoot, ['merge-base', '--is-ancestor', local, upstream]);
    if (contains.exitCode === 0) return { branch, sha: upstream };
  }
  return { branch, sha: local };
}

async function revParse(projectRoot: string, ref: string): Promise<string | null> {
  const rev = await gitInRoot(projectRoot, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return rev.exitCode === 0 ? rev.stdout.toString().trim() || null : null;
}

/** The git remote the daemon's sync fetches (`[remote] git_remote`); null when lazy.toml does not load. */
async function actingRemote(projectRoot: string): Promise<string | null> {
  try {
    return (await loadConfig(projectRoot)).remote.git_remote || null;
  } catch (err) {
    logger.debug(`Runner image: not reading the remote's branch: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Seams for tests: which commit the branch is at, and how a commit's tree is exported. */
export interface AdvanceDeps {
  tip?: (projectRoot: string) => Promise<BranchCommit | null>;
  exportTree?: (projectRoot: string, commit: string, dir: string) => Promise<void>;
}

/**
 * Tell the daemon the acting branch may have moved (an accept landed, the
 * daemon's periodic fetch saw origin's branch move — a PR/MR merged on the
 * forge — or the reconciler's tick). The first look only
 * records the tip; a different tip afterwards queues a rebuild from it. Never
 * throws.
 */
export async function noteActingBranchAdvance(projectRoot: string, deps: AdvanceDeps = {}): Promise<void> {
  const t = tracker;
  if (!t || !t.projectRoot || t.projectRoot !== projectRoot) return;
  try {
    const tip = await (deps.tip ?? actingBranchTip)(projectRoot);
    if (!tip) return;
    if (t.seenTip == null) {
      t.seenTip = tip.sha;
      return;
    }
    if (tip.sha === t.seenTip) return;
    t.seenTip = tip.sha;
    // Newest wins: a tip still waiting behind a running build is replaced, so
    // the commits in between are never built.
    t.queuedTip = tip;
    t.advanceDeps = deps;
    // Not awaited: a build takes minutes and the callers (an accept, the reconciler's tick) must not wait for it.
    void drainQueuedAdvance(t, deps);
  } catch (err) {
    logger.warn(`Runner image: could not follow the ${projectRoot} branch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Start the build of the queued tip when nothing is building; otherwise the running build's end calls this again. Never rejects. */
async function drainQueuedAdvance(t: Tracker, deps: AdvanceDeps = t.advanceDeps ?? {}): Promise<void> {
  if (!t.queuedTip || t.advancing) return;
  if (t.status.state === 'checking' || t.status.state === 'building') return;
  t.advancing = true;
  const tip = t.queuedTip;
  t.queuedTip = null;
  try {
    // The image in use already came from this commit (the boot build built it from there).
    if (t.servingFrom?.sha === tip.sha) return;
    const s = t.status;
    // Nothing to follow: no project image, or one a person's adoption governs.
    if (s.state === 'none' || (s.state === 'failed' && s.adoptionUnavailable)) return;
    // The shared-dockerd backend never auto-builds a project Dockerfile (AGENTS.md).
    if (!autoBuildsRootDockerfile()) return;
    const { loadValidAdoptedImage } = await import('./adopted-image');
    if (await loadValidAdoptedImage(t.projectRoot)) return;
    await buildFromAdvance(t, tip, deps);
  } catch (err) {
    logger.warn(`Runner image: the rebuild after ${describeBranchCommit(tip)} did not start: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    t.advancing = false;
  }
  if (t.queuedTip) await drainQueuedAdvance(t, deps);
}

async function buildFromAdvance(t: Tracker, tip: BranchCommit, deps: AdvanceDeps): Promise<void> {
  const probe = await resolveTarget(t.projectRoot);
  if (!probe) return;
  const parent = advanceContextsRoot(t.projectRoot);
  const s = t.status;
  // Docker moves the tag only when the build succeeds, so a ready image (or
  // one a failed rebuild left in place) stays in use throughout.
  const inUse = s.state === 'ready' || (s.state === 'failed' && s.replacing === true) ? s : null;
  let dir: string | null = null;
  let target = probe;
  try {
    try {
      await mkdir(parent, { recursive: true });
      dir = await mkdtemp(join(parent, `${tip.sha.substring(0, 12)}-`));
      await (deps.exportTree ?? exportTree)(t.projectRoot, tip.sha, dir);
      // Named from the exported commit too: its Dockerfile is what gets built.
      target = (await runWithBuildContext(dir, () => resolveTarget(t.projectRoot), tip)) ?? probe;
    } catch (err) {
      // A build that fails is shown; so is a commit that could not even be
      // exported, or the image would read "ready" while the project's branch
      // has moved on without it.
      const error = `could not prepare ${describeBranchCommit(tip)} for the rebuild: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`Runner image: ${error}; the current image stays in use`);
      if (inUse && t.status === s) {
        t.status = {
          state: 'failed', imageName: inUse.imageName, dockerfile: inUse.dockerfile, defaultImage: inUse.defaultImage,
          failedAt: new Date().toISOString(), error, replacing: true, attemptedFrom: tip,
          ...(t.servingFrom ? { builtFrom: t.servingFrom } : {}),
        };
      }
      return;
    }
    const replacing = inUse !== null && inUse.imageName === target.imageName;
    const before = await imageId(t.binary, target.imageName);
    logger.info(`Runner image: ${describeBranchCommit(tip)} is the new tip; rebuilding ${target.imageName} from it in the background`);
    const result = await startBuild(t, target.imageName, target.dockerfile, target.defaultImage, { rebuild: true, replacing, advance: { commit: tip, dir, imageBefore: before } });
    if (!result.ok) {
      logger.warn(`Runner image: the rebuild from ${describeBranchCommit(tip)} failed; the current image stays in use: ${result.error}`);
      return;
    }
    await pruneSuperseded(t.binary, target.imageName, before);
  } finally {
    if (dir) await removeExport(dir);
  }
}

/** Remove one exported tree. Never throws. */
async function removeExport(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((e) => logger.warn(`Runner image: could not remove the exported context ${dir}: ${e instanceof Error ? e.message : String(e)}`));
}

/** Where the boot build exports the acting commit — its own directory, so it never races an advance's export. */
function bootContextsRoot(projectRoot: string): string {
  return join(projectRoot, '.lazy', 'image-boot');
}

/**
 * Export `commit` for the boot build and check it names the same image the
 * checkout does. Null — build from the checkout, as before — when the export
 * fails or the commit's Dockerfile names a different image than the one
 * launches resolve (a build of that one would be aborted by the next sync).
 */
async function prepareBootContext(t: Tracker, commit: BranchCommit, imageName: string, signal: AbortSignal): Promise<string | null> {
  let dir: string | null = null;
  try {
    const parent = bootContextsRoot(t.projectRoot);
    await mkdir(parent, { recursive: true });
    dir = await mkdtemp(join(parent, `${commit.sha.substring(0, 12)}-`));
    await exportTree(t.projectRoot, commit.sha, dir, signal);
    const exportedDir = dir;
    const resolved = await runWithBuildContext(exportedDir, () => resolveTarget(t.projectRoot), commit);
    if (resolved && resolved.imageName !== imageName) {
      logger.info(`Runner image: ${describeBranchCommit(commit)} names ${resolved.imageName}, the checkout ${imageName}; the boot build uses the checkout, which is what launches resolve`);
      await removeExport(dir);
      return null;
    }
    return dir;
  } catch (err) {
    logger.warn(`Runner image: could not export ${describeBranchCommit(commit)} for the boot build; building from the checkout instead: ${err instanceof Error ? err.message : String(err)}`);
    if (dir) await removeExport(dir);
    return null;
  }
}

/** Where advance rebuilds export a commit — inside the project's own checkout, like a ref adoption's context. */
function advanceContextsRoot(projectRoot: string): string {
  return join(projectRoot, '.lazy', 'image-advance');
}

async function imageId(binary: string, ref: string): Promise<string | null> {
  const proc = spawn([binary, 'image', 'inspect', ref, '--format', '{{.Id}}'], { stdout: 'pipe', stderr: 'ignore', timeout: 30_000 });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() || null : null;
}

/**
 * Remove the image the moved tag used to name. By ID and never forced: docker
 * refuses while a container (a task's, stopped or not) still uses it or another
 * tag — a task's pin — still names it, which is exactly when it must stay.
 */
async function pruneSuperseded(binary: string, imageName: string, before: string | null): Promise<void> {
  // Guest disk maintenance retains the previous image and reclaims older ones.
  if (currentDiskSpaceManager()) return;
  const after = await imageId(binary, imageName);
  if (!before || !after || before === after) return;
  const proc = spawn([binary, 'image', 'rm', before], { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code === 0) logger.info(`Runner image: removed the superseded image ${before}`);
  else logger.info(`Runner image: kept the superseded image ${before} (still in use): ${err.trim()}`);
}

/** How often a READY image is re-checked against its inputs and its age. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Backoff for a failing background refresh: 1 min, doubling, capped at 1 h. Each attempt is a full build, which can OOM a small guest dockerd. */
export function refreshBackoffMs(failures: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, failures - 1));
}

/**
 * A ready image goes stale with time (what its Dockerfile pulls drifts — the
 * 14-day rebuild in `ensureImage`), and a long-running daemon must not keep it
 * forever just because it was ready at boot. Re-checked in the BACKGROUND,
 * through the same `ensureImage`: a rebuild keeps the same tag, and docker
 * moves the tag only when the build succeeds, so launches keep using the
 * current image the whole time and the state stays `ready`. A failed refresh
 * is logged, backed off (refreshBackoffMs) and leaves the working image in place.
 */
function maybeRefresh(t: Tracker, force = false): void {
  const s = t.status;
  if (s.state !== 'ready' || t.refreshing || Date.now() < t.refreshRetryAtMs || (!force && Date.now() - t.checkedAt < REFRESH_INTERVAL_MS)) return;
  t.refreshing = true;
  // A refresh builds from the checkout, so an image it actually rebuilt is no longer "built from" a branch commit.
  let rebuilt = false;
  void ensureImage(t.binary, { bypassGate: true, notify: (detail) => { if (/^(re)?building /.test(detail)) rebuilt = true; } })
    .then(() => {
      logger.debug(`Runner image: ${s.imageName} re-checked`);
      if (rebuilt) t.servingFrom = undefined;
      t.refreshFailures = 0;
      t.refreshRetryAtMs = 0;
      if (t.status === s || (t.status.state === 'ready' && t.status.imageName === s.imageName)) {
        const { refreshRetryAt: _cleared, builtFrom: _from, ...rest } = t.status as Extract<RunnerImageState, { state: 'ready' }>;
        t.status = rebuilt || !t.servingFrom ? rest : { ...rest, builtFrom: t.servingFrom };
      }
    })
    .catch((err) => {
      t.refreshFailures++;
      t.refreshRetryAtMs = Date.now() + refreshBackoffMs(t.refreshFailures);
      const retryAt = new Date(t.refreshRetryAtMs).toISOString();
      if (t.status.state === 'ready' && t.status.imageName === s.imageName) t.status = { ...t.status, refreshRetryAt: retryAt };
      logger.warn(`Runner image: refreshing ${s.imageName} failed; launches keep the current image; next attempt not before ${retryAt}: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => { t.refreshing = false; t.checkedAt = Date.now(); });
}

async function syncTracker(t: Tracker): Promise<void> {
  if (!t.projectRoot) return;
  let next: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    next = await resolveTarget(t.projectRoot);
  } catch (err) {
    if (await recordUnavailableAdoption(t, err)) return;
    logger.warn(`Runner image: could not re-resolve the custom image: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!next) {
    // No root custom image in use any more (unset, or an adoption took over):
    // nothing to wait for, and any build of the old one no longer matters.
    if (t.status.state !== 'none') {
      t.generation++;
      t.status = { state: 'none' };
    }
    return;
  }
  const s = t.status;
  if (s.state === 'none' || s.imageName !== next.imageName) {
    startBuild(t, next.imageName, next.dockerfile, next.defaultImage);
  } else if (s.state === 'failed' && s.retryAt && Date.parse(s.retryAt) <= Date.now() && !s.replacing) {
    // The deferral from an earlier attempt has elapsed: build again by itself.
    startBuild(t, next.imageName, next.dockerfile, next.defaultImage);
  }
}

/**
 * A ref adoption whose commit can no longer be found (a recreated machine,
 * a branch deleted from origin): the project's image FAILED, shown with its
 * reason and the usual ways out — never a silent switch back to the
 * project's own Dockerfile. True when `err` was that and is now recorded.
 */
async function recordUnavailableAdoption(t: Tracker, err: unknown): Promise<boolean> {
  const { RefAdoptionUnavailableError } = await import('./image-adoption');
  if (!(err instanceof RefAdoptionUnavailableError)) return false;
  const { loadValidAdoptedImage, describeRefAdoption } = await import('./adopted-image');
  const adopted = await loadValidAdoptedImage(t.projectRoot).catch(() => null);
  t.generation++;
  t.status = {
    state: 'failed',
    imageName: adopted?.imageName ?? '(unavailable)',
    dockerfile: adopted?.source ? describeRefAdoption(adopted.source) : 'the adopted Dockerfile',
    defaultImage: await resolveImageRepository(t.projectRoot, true)
      .then(({ repository }) => `${repository}:${IMAGE_TAG}`)
      .catch(() => `lazy-runner:${IMAGE_TAG}`),
    failedAt: new Date().toISOString(),
    error: err.message,
    adoptionUnavailable: true,
  };
  logger.warn(`Runner image: ${err.message}`);
  return true;
}

/**
 * Bring the tracked image in line with the project's current Dockerfile before
 * answering whether it is ready (see `CustomImageGate.sync`). Every readiness
 * question a launch decision rests on calls this first.
 */
export async function syncRunnerImageTarget(): Promise<void> {
  if (tracker) await syncTracker(tracker);
}

async function resolveTarget(projectRoot: string): Promise<{ imageName: string; dockerfile: string; defaultImage: string } | null> {
  // The SAME resolution launches use: the configured `[docker] dockerfile`, or
  // with that unset a root Dockerfile.lazy committed on the root's branch (on a
  // backend that builds it). Reading only the key here left a launch that
  // resolved the committed file as custom waiting on a build nobody started.
  const config = await loadConfig(projectRoot);
  const customPath = await resolveCustomDockerfile(projectRoot);
  if (!customPath) return null;
  // A consented worktree adoption (`lazy upgrade`) is what launches run on,
  // resolved before the gate in `ensureImage` and built by the upgrade itself —
  // the root image is not in use, so there is nothing for the boot build to
  // track. A REF adoption (src/daemon/image-adoption.ts) is the opposite: it
  // IS the custom Dockerfile resolveCustomDockerfile returned, and this build
  // owns it — after a version bump or a VM replacement included.
  const { loadValidAdoptedImage } = await import('./adopted-image');
  const adopted = await loadValidAdoptedImage(projectRoot);
  if (adopted && adopted.source?.kind !== 'ref') return null;
  const dockerfile = adopted ? describeDockerfileSource(customPath) : (config.docker.dockerfile || describeDockerfileSource(customPath));
  const { repository, isCustom } = await resolveImageRepository(projectRoot);
  if (!isCustom) return null;
  const { repository: def } = await resolveImageRepository(projectRoot, true);
  return { imageName: `${repository}:${IMAGE_TAG}`, dockerfile, defaultImage: `${def}:${IMAGE_TAG}` };
}

/**
 * Called once at daemon boot. Gated on a custom Dockerfile being configured
 * and the runner being a container runner; anything else leaves the state
 * `none` and registers no gate, so `ensureImage` behaves as it always did.
 */
export async function startRunnerImageBoot(
  projectRoot: string,
  deps: { isContainerRunner?: () => Promise<{ binary: string; prepare?: () => Promise<void> } | null> } = {},
): Promise<void> {
  try {
    // Registered for EVERY container-runner daemon, even one with no custom
    // image (or an adoption) today: a Dockerfile configured, or an adoption
    // dropped, after boot must still be built by the daemon — never inline by
    // whichever launch notices first.
    const runner = await (deps.isContainerRunner ?? (() => containerRunnerBinary(projectRoot)))();
    if (!runner) return;
    const t: Tracker = { projectRoot, binary: runner.binary, ...(runner.prepare ? { prepare: runner.prepare } : {}), status: { state: 'none' }, generation: 0, checkedAt: 0, refreshing: false, refreshFailures: 0, refreshRetryAtMs: 0, job: null };
    tracker = t;
    // An export a killed daemon left behind: no build runs yet, so none is in use.
    await rm(bootContextsRoot(projectRoot), { recursive: true, force: true })
      .catch((e) => logger.warn(`Runner image: could not clear ${bootContextsRoot(projectRoot)}: ${e instanceof Error ? e.message : String(e)}`));
    await rm(advanceContextsRoot(projectRoot), { recursive: true, force: true })
      .catch((e) => logger.warn(`Runner image: could not clear ${advanceContextsRoot(projectRoot)}: ${e instanceof Error ? e.message : String(e)}`));
    // The branch's tip now is what the boot build below covers; only a LATER tip is an advance.
    t.seenTip = (await actingBranchTip(projectRoot))?.sha ?? null;
    registerCustomImageGate({
      repair: (imageName) => repairTrackedImage(t, imageName),
      check(imageName) {
        const s = t.status;
        if (s.state === 'none' || s.imageName !== imageName) {
          // The Dockerfile changed since the build we track: the daemon builds
          // the new one itself; the launch never does.
          void resolveTarget(projectRoot).then((next) => {
            if (next && next.imageName === imageName && (t.status.state === 'none' || t.status.imageName !== imageName)) {
              startBuild(t, next.imageName, next.dockerfile, next.defaultImage);
            }
          }).catch((err) => logger.warn(`Runner image: could not resolve the custom image: ${err instanceof Error ? err.message : String(err)}`));
          return {
            ready: false,
            message: `The project's runner image ${imageName} is not built yet; the daemon is building it. ` +
              `Run on lazy's default runner image instead, or wait for it.`,
          };
        }
        maybeRefresh(t);
        return verdict();
      },
      ready: () => customImageReady(),
      sync: () => syncTracker(t),
      stale(imageName) {
        if (t.status.state === 'ready' && t.status.imageName === imageName) maybeRefresh(t, true);
      },
      invalidate(imageName) {
        const s = t.status;
        if (s.state === 'ready' && s.imageName === imageName) {
          logger.warn(`Runner image: ${imageName} disappeared from the container runtime; rebuilding it`);
          startBuild(t, s.imageName, s.dockerfile, s.defaultImage);
        }
      },
    });
    // Resolved AFTER the tracker and gate exist, so a resolution failure (an
    // adopted commit gone after a machine was recreated) is recorded as a
    // failed image the surfaces show, not lost.
    const target = await resolveTarget(projectRoot);
    if (target) {
      // The image in use may be one an advance rebuilt: it says so on a label.
      // Seed what it came from, and when the branch has moved on since — an
      // advance build a restart killed — queue one for the tip. The boot
      // build below only rebuilds for Dockerfile/input changes or age, so
      // without this the advance would be lost for good. No label: as before.
      const labelled = await readBuiltFromLabel(target.imageName, runner.binary).catch((err) => {
        logger.warn(`Runner image: could not read the built-from label of ${target.imageName}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (labelled) {
        t.servingFrom = labelled;
        const tip = await actingBranchTip(projectRoot);
        if (tip && tip.sha !== labelled.sha) t.queuedTip = tip; // drained when the boot build ends
      }
      await startBootBuild(t, target);
    }
  } catch (err) {
    if (tracker && await recordUnavailableAdoption(tracker, err)) return;
    // A config that cannot resolve its Dockerfile (a typo in the path) is a
    // build that failed before it started — record it so every surface shows it.
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(`Runner image: could not start the boot build: ${error}`);
    const config = await loadConfig(projectRoot).catch(() => null);
    const dockerfile = config?.docker.dockerfile;
    const runner = dockerfile
      ? await (deps.isContainerRunner ?? (() => containerRunnerBinary(projectRoot)))().catch(() => null)
      : null;
    if (dockerfile && runner) {
      tracker = { projectRoot, binary: runner.binary, generation: 0, checkedAt: 0, refreshing: false, refreshFailures: 0, refreshRetryAtMs: 0, job: null, status: {
        state: 'failed', imageName: '(unresolved)', dockerfile, defaultImage: `lazy-runner:${IMAGE_TAG}`,
        failedAt: new Date().toISOString(), error,
      } };
      registerCustomImageGate({ check: () => verdict(), invalidate: () => {}, stale: () => {}, ready: () => customImageReady(), sync: () => syncTracker(tracker!) });
    }
  }
}

/**
 * Retry a failed build (or rebuild after the Dockerfile was fixed). Refuses
 * while a build is in flight — the daemon never runs two of the same image.
 */
export async function retryRunnerImageBuild(): Promise<{ ok: true; status: RunnerImageState } | { ok: false; message: string; buildId?: string }> {
  return startRequestedBuild({});
}

/**
 * A project admin's Rebuild: build the project's image again even when it is
 * up to date (`noCache` also refetches everything the Dockerfile pulls).
 * Returns as soon as the build has STARTED — the build log is where it is
 * watched. Rebuilding a READY image replaces it: launches keep using the
 * current one until the new one succeeds, and after a failure. Refused while
 * a build runs (Cancel it first).
 */
export async function rebuildRunnerImage(opts: { noCache?: boolean } = {}): Promise<{ ok: true; status: RunnerImageState; defaultBuild?: { id: string; imageName: string } } | { ok: false; message: string; buildId?: string }> {
  return startRequestedBuild({ rebuild: true, noCache: opts.noCache === true });
}

/** The running (or last) Rebuild of lazy's DEFAULT image, for a project with no custom one. */
let defaultRebuildJob: ImageBuildJob | null = null;

/**
 * Rebuild lazy's DEFAULT runner image for a project that runs on it: the work
 * `ensureImage` does at launch, but forced — a fresh local build without the
 * cache, because it is asked for when the image there is broken, and the
 * published image or the build cache could hand back the same layers — and
 * narrated into a build job an admin can watch and cancel. Only ever the
 * default image: nothing here reads a task branch or a worktree Dockerfile.
 */
async function startDefaultImageRebuild(t: Tracker, trigger = 'retry'): Promise<{ ok: true; status: RunnerImageState; defaultBuild?: { id: string; imageName: string } } | { ok: false; message: string; buildId?: string }> {
  const { repository } = await resolveImageRepository(t.projectRoot, true);
  // Checked AFTER the await and with none until the job is recorded below: a
  // check before it let an admin's Rebuild and a damaged-image repair both
  // pass it and start two builds of the same image.
  const busy = trigger === 'rebuild' ? runningImageBuildRefusal() : null;
  if (busy) return busy;
  if (defaultRebuildJob?.outcome === 'running') {
    return { ok: false, message: `lazy's default runner image is already being rebuilt (build ${defaultRebuildJob.id}).`, buildId: defaultRebuildJob.id };
  }
  const imageName = `${repository}:${IMAGE_TAG}`;
  const job = startImageBuildJob('project', `Rebuild lazy's default image ${imageName}`, t.projectRoot || undefined);
  job.metadata = { trigger, image: imageName, dockerfile: 'Lazy default runner Dockerfile' };
  defaultRebuildJob = job;
  forgetBuildFailure(imageName);
  job.narrate(`rebuilding lazy's default runner image ${imageName} — rebuild requested`);
  defaultRebuildDone = (async () => {
    try {
      await t.prepare?.();
      await whileNotCancelled(job, job.run(() => ensureImage(t.binary, {
        useDefaultImage: true,
        rebuild: true,
        noCache: true,
        notify: (detail) => job.narrate(detail),
      })));
      job.metadata.imageProduced = true;
      job.finish('succeeded');
      logger.info(`Runner image: lazy's default image ${imageName} was rebuilt`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (job.outcome === 'running') job.finish(job.cancelled ? 'cancelled' : 'failed', error);
      logger.warn(`Runner image: rebuilding lazy's default image ${imageName} failed: ${error}`);
    }
  })();
  return { ok: true, status: t.status, defaultBuild: { id: job.id, imageName } };
}


/**
 * The damaged-image repair (src/docker/damaged-image.ts) inside the daemon:
 * the damaged image was just removed, and it is rebuilt by the build the
 * daemon owns — the project's image through its tracked build (so its state,
 * its build log and Cancel all show it), lazy's default image through the
 * default-image Rebuild — never inline by the launch. Resolves when the build
 * succeeded; throws with the build's error otherwise.
 */
async function repairTrackedImage(t: Tracker, imageName: string): Promise<void> {
  const s = t.status;
  if (s.state !== 'none' && s.imageName === imageName) {
    const result = await startBuild(t, imageName, s.dockerfile, s.defaultImage, { rebuild: true, noCache: true, explicit: true });
    if (!result.ok) throw new Error(`rebuilding ${imageName} failed: ${result.error}`);
    return;
  }
  const { repository } = await resolveImageRepository(t.projectRoot, true);
  if (imageName !== `${repository}:${IMAGE_TAG}`) {
    throw new Error(`${imageName} is not an image this daemon builds`);
  }
  // One already running (an admin's Rebuild, another repair) is waited for, not doubled.
  if (defaultRebuildJob?.outcome !== 'running') {
    const started = await startDefaultImageRebuild(t);
    // Refused only because one started meanwhile: that one is waited for.
    if (!started.ok && !defaultImageRebuildJob()) throw new Error(started.message);
  }
  const job = defaultRebuildJob;
  await defaultRebuildDone;
  if (job?.outcome !== 'succeeded') {
    throw new Error(`rebuilding ${imageName} failed: ${job?.failure?.error ?? (job?.outcome === 'cancelled' ? 'the build was cancelled' : 'the build did not finish')}`);
  }
}
/** Cancel a running Rebuild of lazy's default image; its build id, or null when none runs. */
export function cancelDefaultImageRebuild(buildId?: string | null): string | null {
  const job = defaultRebuildJob;
  if (!job || job.outcome !== 'running' || (buildId && buildId !== job.id)) return null;
  job.controller.abort();
  job.finish('cancelled');
  return job.id;
}

/** The running Rebuild of lazy's default image, or null. */
export function defaultImageRebuildJob(): ImageBuildJob | null {
  return defaultRebuildJob?.outcome === 'running' ? defaultRebuildJob : null;
}

/** Synchronous so the last refusal check and recording a new job are atomic. */
export function runningImageBuildRefusal(): { ok: false; message: string; buildId?: string } | null {
  const adoption = adoptionBuildStatus();
  if (adoption.state === 'building') {
    return { ok: false, message: `An adoption of ${adoption.branch} is building; cancel it before rebuilding the project's image.`, buildId: adoption.buildId ?? undefined };
  }
  const job = defaultImageRebuildJob() ?? runnerImageJob();
  if (job?.outcome === 'running') {
    return { ok: false, message: 'An image build is already running. Open its log or cancel it before rebuilding.', buildId: job.id };
  }
  const status = runnerImageStatus();
  if (status.state === 'checking' || status.state === 'building') {
    return { ok: false, message: describeRunnerImage(status), buildId: status.buildId ?? undefined };
  }
  return null;
}

async function startRequestedBuild(opts: { rebuild?: boolean; noCache?: boolean }): Promise<{ ok: true; status: RunnerImageState; defaultBuild?: { id: string; imageName: string } } | { ok: false; message: string; buildId?: string }> {
  const t = tracker;
  if (!t) return { ok: false, message: 'This project has no custom runner image to build: it does not run its tasks in containers.' };
  const busy = runningImageBuildRefusal();
  if (busy) return busy;
  const wasReady = t.status.state === 'ready' || (t.status.state === 'failed' && t.status.replacing === true);
  const readyImage = t.status.state === 'ready' || t.status.state === 'failed' ? t.status.imageName : null;
  let target: Awaited<ReturnType<typeof resolveTarget>>;
  // "Build it again" is the explicit retry: ask git and origin afresh.
  const { forgetAdoptionUnavailability } = await import('./image-adoption');
  forgetAdoptionUnavailability();
  try {
    target = await resolveTarget(t.projectRoot);
  } catch (err) {
    if (await recordUnavailableAdoption(t, err)) return { ok: false, message: (err as Error).message };
    throw err;
  }
  if (!target) {
    // A Rebuild on a project with no custom image rebuilds lazy's default
    // image — the one its tasks actually run on. A worktree adoption
    // (`lazy upgrade`) is neither, and stays refused.
    const { loadValidAdoptedImage } = await import('./adopted-image');
    if (opts.rebuild && !(await loadValidAdoptedImage(t.projectRoot))) {
      // A person asked: a damaged-image repair that failed before is worth
      // trying again. Never cleared from startDefaultImageRebuild itself,
      // which the automated repair also calls.
      const { repository } = await resolveImageRepository(t.projectRoot, true);
      forgetFailedDamagedImageRepair(`${repository}:${IMAGE_TAG}`);
      return startDefaultImageRebuild(t, 'rebuild');
    }
    return {
      ok: false,
      message: 'This project has no custom runner image to build ([docker] dockerfile is not set, or an adopted image is in use).',
    };
  }
  // No await may separate this check from startBuild: another request or
  // branch advance may have started a build while resolveTarget was reading.
  const nowBusy = runningImageBuildRefusal();
  if (nowBusy) return nowBusy;
  // A rebuild replaces the working image only when it IS that image: a
  // Dockerfile changed since resolves to a new name, which was never ready.
  const replacing = opts.rebuild === true && wasReady && readyImage === target.imageName;
  // A person asked for this build: a damaged-image repair that failed before is worth trying again.
  forgetFailedDamagedImageRepair(target.imageName);
  startBuild(t, target.imageName, target.dockerfile, target.defaultImage, { ...opts, replacing, explicit: true });
  return { ok: true, status: t.status };
}

/** The container runtime binary this project's daemon builds with, or null for a non-container runner. */
export async function containerRunnerBinary(projectRoot: string): Promise<{ binary: string; prepare?: () => Promise<void> } | null> {
  const { createRunner } = await import('../runner');
  const { DockerRunner } = await import('../runner/docker-runner');
  const { SmolvmRunner } = await import('../runner/smolvm-runner');
  const runner = await createRunner(projectRoot);
  if (!(runner instanceof DockerRunner)) return null;
  if (runner instanceof SmolvmRunner) return { binary: runner.containerCli, prepare: () => runner.ensureMachine() };
  return { binary: runner.containerCli };
}

/** Tests only: forget the tracker and unregister the gate. */
export function resetRunnerImageForTests(state?: RunnerImageState): void {
  resetBuildFailuresForTests();
  // A build still running from the previous test must not outlive it and settle a later test's state.
  if (tracker?.job?.outcome === 'running') tracker.job.controller.abort();
  if (defaultRebuildJob?.outcome === 'running') defaultRebuildJob.controller.abort();
  defaultRebuildJob = null;
  tracker = state ? { projectRoot: '', binary: 'docker', status: state, generation: 0, checkedAt: Date.now(), refreshing: false, refreshFailures: 0, refreshRetryAtMs: 0, job: null } : null;
  registerCustomImageGate(state ? { check: () => verdict(), invalidate: () => {}, stale: () => {}, ready: () => customImageReady(), sync: async () => {} } : null);
}

/**
 * The boot build, from the acting branch's COMMITTED tree like an advance
 * build. It still builds only when the image needs it (Dockerfile or inputs
 * changed, missing, aged). It falls back to the checkout's working tree with
 * no branch commit to export (a detached HEAD, a task branch checked out
 * mid-accept), under a ref adoption (whose own exported commit is the
 * context), when the export fails, or when the commit names a different image
 * than the checkout (see prepareBootContext) — each logged.
 */
async function startBootBuild(t: Tracker, target: NonNullable<Awaited<ReturnType<typeof resolveTarget>>>): Promise<void> {
  const projectRoot = t.projectRoot;
  const { loadValidAdoptedImage } = await import('./adopted-image');
  const adopted = await loadValidAdoptedImage(projectRoot).catch((err) => {
    // Unknown whether an adoption governs: build exactly as before (the checkout), never an export beside an adoption.
    logger.warn(`Runner image: could not read the adoption for the boot build; building from the checkout: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown' as const;
  });
  const tip = adopted ? null : await actingBranchTip(projectRoot);
  // The export runs INSIDE the build job, so the state reads `checking` from the start and Cancel stops it.
  startBuild(t, target.imageName, target.dockerfile, target.defaultImage, tip ? { committed: { commit: tip } } : {});
}
