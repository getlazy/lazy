/**
 * Adopting the project's Dockerfile from a git REF — Lazy Teams' way out of a
 * project whose Dockerfile.lazy fails to build.
 *
 * A project admin picks a branch, or a task (meaning that task's branch),
 * looks at its Dockerfile next to the project branch's, and confirms. Lazy then
 * builds it and, only if the build succeeds, records it as the project's
 * image through the SAME daemon adoption `lazy upgrade` writes
 * (src/daemon/adopted-image.ts), with a `source` saying where it came from and
 * who confirmed it. There is no parallel mechanism: the record, the snapshot
 * file, the build-context rule and `lazy doctor`'s view are the existing ones.
 *
 * WHAT IS NEW IS THE SOURCE: a commit, not a worktree. Nothing here ever reads
 * a working tree. The Dockerfile is the committed blob (`git ls-tree` must say
 * it is a regular file, then `git cat-file blob`), and the build context is
 * that commit's tree exported with `git archive` into a lazy-owned directory
 * under the daemon dir — the same "snapshot the committed bytes" posture the
 * root Dockerfile.lazy convention takes (inspectConventionalDockerfile).
 *
 * CONSENT IS BOUND TO WHAT WAS SHOWN. `preview` answers the ref's commit and
 * the file's content hash; `adopt` must send both back and is refused (409)
 * when the ref has moved since, so the admin can never confirm one file and
 * get another.
 *
 * WHO MAY: a human, through the daemon's RPC, never the MCP door (there is
 * deliberately no tool for choosing an image). In Lazy Teams the admin bar is
 * the Rails policy (`ProjectPolicy#adopt_runner_image?`) on the page, and the
 * Teams CLI proxy does not map these commands at all, so a bound clone cannot
 * reach them; in managed mode the daemon additionally refuses a caller whose
 * token names no person (HUMAN_INITIATED_RPC_COMMANDS), so the record always
 * says who.
 */
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'fs/promises';
import { pathExists } from '../utils/fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import { spawn } from '../utils/spawn';
import { loadConfig } from '../config/loader';
import {
  CONVENTIONAL_DOCKERFILE,
  buildDockerfileCandidate,
  gitInRoot,
  rootIntegrationBranch,
} from '../capture/claude';
import {
  clearAdoptedImage,
  describeRefAdoption,
  hashDockerfileContent,
  loadValidAdoptedImage,
  refAdoptionContextDir,
  refAdoptionContextsRoot,
  writeAdoptedImage,
  type AdoptedImageState,
  type RefAdoptionSource,
} from './adopted-image';
import { getDaemonDir } from './paths';
import { describeHiddenCharacters, findHiddenCharacters } from './dockerfile-characters';
import type { Storage } from '../storage';
import { getBranchName } from '../task/identity';
import { startImageBuildJob, whileNotCancelled, type ImageBuildJob } from './image-build-job';

/** The directory holding the adopted ref's exported tree (the build context). */
/** Prefix of a context being exported, before it is moved into place. */
const STAGING_PREFIX = 'staging-';

/** Where an earlier build of this feature put contexts — the daemon dir; only ever removed now. */
const LEGACY_DAEMON_CONTEXT_PREFIX = 'adopted-context';

export class ImageAdoptionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RefDockerfile {
  ref: string;
  refKind: 'branch' | 'task';
  branch: string;
  /** Full ref name read (`refs/heads/x` or `refs/remotes/origin/x`). */
  gitRef: string;
  commit: string;
  blob: string;
  dockerfile: string;
  content: string;
  contentHash: string;
}

/** The project branch's copy of the Dockerfile, or null when it has none. */
export interface MainDockerfile {
  branch: string;
  blob: string;
  content: string;
}

/** The Dockerfile path the project builds: `[docker].dockerfile`, else Dockerfile.lazy. */
async function projectDockerfilePath(projectRoot: string): Promise<string> {
  const config = await loadConfig(projectRoot);
  return (config.docker.dockerfile || CONVENTIONAL_DOCKERFILE).replace(/^\.\//, '');
}

async function git(projectRoot: string, args: string[]) {
  return gitInRoot(projectRoot, args);
}

/**
 * Resolve what the admin picked to one commit. A task code or id means that
 * task's branch. A branch name is checked with `git check-ref-format` and read
 * from the local branch, else from `origin` (a branch someone pushed and the
 * project has fetched).
 */
async function resolveRef(projectRoot: string, storage: Storage, ref: string): Promise<{ refKind: 'branch' | 'task'; branch: string; gitRef: string; commit: string }> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ImageAdoptionError(400, 'Name a branch or a task to adopt the Dockerfile from.');

  let refKind: 'branch' | 'task' = 'branch';
  let branch = trimmed;
  // A storage failure surfaces as itself; only "no such task" falls through to
  // reading the name as a branch.
  const { task, ambiguousMatches } = await storage.resolveTask(trimmed);
  if (!task && ambiguousMatches && ambiguousMatches.length > 0) {
    const names = ambiguousMatches.slice(0, 5).map((t) => t.code ?? t.id.substring(0, 8)).join(', ');
    throw new ImageAdoptionError(400, `"${trimmed}" matches more than one task (${names}). Name the task by its full code.`);
  }
  if (task) {
    refKind = 'task';
    branch = getBranchName(task);
  }

  const check = await git(projectRoot, ['check-ref-format', '--branch', branch]);
  if (check.exitCode !== 0) {
    throw new ImageAdoptionError(400, `"${branch}" is not a branch name or a task in this project.`);
  }

  for (const gitRef of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const rev = await git(projectRoot, ['rev-parse', '--verify', '-q', `${gitRef}^{commit}`]);
    if (rev.exitCode === 0) return { refKind, branch, gitRef, commit: rev.stdout.toString().trim() };
    if (rev.exitCode !== 1) {
      throw new Error(`git could not resolve ${gitRef} in ${projectRoot} (exit ${rev.exitCode}): ${rev.stderr.trim()}`);
    }
  }
  throw new ImageAdoptionError(
    404,
    refKind === 'task'
      ? `Task ${trimmed}'s branch ${branch} has no commits in this project yet.`
      : `No branch named ${branch} in this project (locally or on origin).`,
  );
}

/** The committed Dockerfile at `commit`, refusing anything but a regular file. */
async function committedDockerfile(projectRoot: string, commit: string, path: string, where: string): Promise<{ blob: string; content: string } | null> {
  const tree = await git(projectRoot, ['ls-tree', '-z', commit, '--', path]);
  if (tree.exitCode !== 0) throw new Error(`git could not list ${path} at ${commit} in ${projectRoot}: ${tree.stderr.trim()}`);
  const line = tree.stdout.toString().split('\0')[0];
  if (!line) return null;
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(line);
  if (!match) throw new Error(`unexpected git ls-tree output for ${path} at ${commit}: ${line}`);
  const entry = { mode: match[1], type: match[2], sha: match[3] };
  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
    throw new ImageAdoptionError(
      422,
      `${path} on ${where} is ${entry.mode === '120000' ? 'a symlink' : `a ${entry.type} (mode ${entry.mode})`}, ` +
      `not a regular file — lazy only builds a committed Dockerfile itself.`,
    );
  }
  const bytes = await git(projectRoot, ['cat-file', 'blob', entry.sha]);
  if (bytes.exitCode !== 0) throw new Error(`git could not read ${path} (${entry.sha}) in ${projectRoot}: ${bytes.stderr.trim()}`);
  return { blob: entry.sha, content: bytes.stdout.toString('utf-8') };
}

/** The ref's committed Dockerfile; a ref without one is a 404. */
export async function readRefDockerfile(projectRoot: string, storage: Storage, ref: string): Promise<RefDockerfile> {
  const resolved = await resolveRef(projectRoot, storage, ref);
  const dockerfile = await projectDockerfilePath(projectRoot);
  const file = await committedDockerfile(projectRoot, resolved.commit, dockerfile, resolved.branch);
  if (!file) {
    throw new ImageAdoptionError(404, `${resolved.branch} has no committed ${dockerfile} to adopt.`);
  }
  return { ref: ref.trim(), ...resolved, dockerfile, ...file, contentHash: hashDockerfileContent(file.content) };
}

/**
 * The project branch's committed Dockerfile — what the project builds without
 * an adoption. Null means the branch genuinely has none (or has no commits).
 * THROWS when it cannot be read — the root has a task branch checked out
 * mid-accept, a detached HEAD, a Dockerfile committed as a symlink — because
 * "unreadable" must never be mistaken for "absent" (that read as "main's file
 * changed" on every poll).
 */
export async function readMainDockerfile(projectRoot: string): Promise<MainDockerfile | null> {
  const branch = await rootIntegrationBranch(projectRoot);
  if (!branch) return null;
  const dockerfile = await projectDockerfilePath(projectRoot);
  const file = await committedDockerfile(projectRoot, `refs/heads/${branch}`, dockerfile, branch);
  return file ? { branch, ...file } : null;
}

/** The last "could not read the project branch" reason logged, so a poll does not repeat it. */
let lastMainReadWarning: string | null = null;

/** readMainDockerfile, with an unreadable branch answered as `{ unreadable }` and logged once per reason. */
async function readMainDockerfileForView(projectRoot: string): Promise<{ main: MainDockerfile | null } | { unreadable: string }> {
  try {
    const main = await readMainDockerfile(projectRoot);
    lastMainReadWarning = null;
    return { main };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason !== lastMainReadWarning) {
      logger.warn(`Image adoption: could not read the project branch's Dockerfile: ${reason}`);
      lastMainReadWarning = reason;
    }
    return { unreadable: reason };
  }
}

/** What the admin is shown before confirming. */
export async function previewImageAdoption(projectRoot: string, storage: Storage, ref: string) {
  const candidate = await readRefDockerfile(projectRoot, storage, ref);
  const read = await readMainDockerfileForView(projectRoot);
  // Shown beside the diff, and the reason an adoption of this file refuses.
  const hiddenCharacters = findHiddenCharacters(candidate.content);
  return 'unreadable' in read
    ? { candidate, main: null, mainUnreadable: read.unreadable, hiddenCharacters }
    : { candidate, main: read.main, hiddenCharacters };
}

// ---------------------------------------------------------------------------
// The adoption build — one at a time, its outcome readable by every surface.
// ---------------------------------------------------------------------------

/**
 * Where a running adoption is: exporting the commit's tree, verifying the
 * exported Dockerfile against the bytes the admin was shown, building, or
 * recording the result (past the point where Cancel can stop it).
 */
export type AdoptionPhase = 'exporting' | 'verifying' | 'building' | 'publishing';
/** Which step an adoption failed at. */
export type AdoptionFailedStep = 'export' | 'verify' | 'build' | 'publish';

export type AdoptionBuildState =
  | { state: 'none' }
  | {
      state: 'building'; ref: string; branch: string; commit: string; startedAt: string; progress: string | null;
      phase: AdoptionPhase;
      /** The adoption's log (`imageBuildLog`); null only for the instant the slot is reserved. */
      buildId: string | null;
    }
  | {
      state: 'failed'; ref: string; branch: string; commit: string; failedAt: string; error: string;
      failedStep: AdoptionFailedStep;
      buildId: string | null;
    };

let build: AdoptionBuildState = { state: 'none' };
let generation = 0;
/** The running (or last) adoption's job, for its log and its Cancel. */
let adoptionJob: ImageBuildJob | null = null;

export function adoptionBuildStatus(): AdoptionBuildState {
  return build;
}

/** The adoption's current (or last) build job. */
export function adoptionJobStatus(): ImageBuildJob | null {
  return adoptionJob;
}

/**
 * Cancel the running adoption: its export or docker build is killed and the
 * project keeps exactly what it had — an adoption is recorded only after its
 * build succeeds. Null when nothing is running; refused (409) once the build
 * has succeeded and the record is being written, which Cancel cannot undo.
 */
export function cancelImageAdoption(): AdoptionBuildState | null {
  if (build.state !== 'building') return null;
  if (build.phase === 'publishing') {
    throw new ImageAdoptionError(409, `The adoption of ${build.branch} has built and is being recorded; it can no longer be cancelled.`);
  }
  const branch = build.branch;
  generation++;
  adoptionJob?.controller.abort();
  adoptionJob?.finish('cancelled');
  build = { state: 'none' };
  logger.info(`Image adoption from ${branch} was cancelled; the project keeps its current image`);
  return build;
}

/**
 * Put a failed adoption away: the project keeps the image it has, and the
 * panel stops offering that failure. Its log stays readable. False when there
 * was no failed adoption.
 */
export function dismissImageAdoptionFailure(): boolean {
  if (build.state !== 'failed') return false;
  build = { state: 'none' };
  return true;
}

export interface AdoptRequest {
  ref: string;
  /** The commit the admin was shown — refused when the ref has moved since. */
  commit: string;
  /** The content hash of the Dockerfile the admin was shown. */
  contentHash: string;
  adoptedBy: { email: string | null; name: string | null };
}

export interface AdoptDeps {
  /**
   * The container runtime the build runs on, or null when this project does
   * not run agents in containers (refused). Asked AFTER the request is
   * validated, so a stale confirmation is reported as such everywhere.
   */
  resolveBinary: () => Promise<string | null>;
  /** Builds the candidate; replaceable in tests (the e2e has no docker). */
  buildCandidate?: typeof buildDockerfileCandidate;
  /** Publishes the record; replaceable in tests (an injected failure must keep the old adoption). */
  writeRecord?: typeof writeAdoptedImage;
  /** Called after the adoption is recorded, so the boot tracker re-resolves. */
  onAdopted?: () => Promise<void>;
}

/** Bound on exporting one commit's whole tree. */
const ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run one export command, killed when `signal` aborts (an adoption's Cancel).
 * Exit null means it was killed — by the timeout or by the signal.
 */
async function runExportCommand(
  cmd: string[], cwd: string, timeoutMs: number, signal?: AbortSignal,
): Promise<{ exitCode: number | null; stderr: string }> {
  if (signal?.aborted) throw new Error('Cancelled');
  const proc = spawn(cmd, { cwd, stdout: 'ignore', stderr: 'pipe', timeout: timeoutMs });
  const onAbort = () => {
    try { proc.kill(); } catch (err) { logger.debug(`Image adoption: ${cmd[0]} had already exited when cancelled: ${err}`); }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (signal?.aborted) throw new Error('Cancelled');
    return { exitCode, stderr };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Export `commit`'s tree into `dir` — the build context, never a worktree. */
export async function exportTree(projectRoot: string, commit: string, dir: string, signal?: AbortSignal): Promise<void> {
  const tar = join(dir, '..', `${dir.split('/').pop()}.tar`);
  // A whole tree can take far longer than a ref lookup; note that `git archive`
  // omits `export-ignore` paths, so such a path is not in the context.
  // Inside the try: a Cancel (or timeout) kills `git archive` mid-write, and
  // the partial tar it leaves must go too.
  try {
    const archive = await runExportCommand(['git', 'archive', '--format=tar', '-o', tar, commit], projectRoot, ARCHIVE_TIMEOUT_MS, signal);
    if (archive.exitCode !== 0) {
      throw new Error(archive.exitCode === null
        ? `git archive of ${commit} did not finish within ${ARCHIVE_TIMEOUT_MS / 60000} minutes`
        : `git archive of ${commit} failed: ${archive.stderr.trim()}`);
    }
    await mkdir(dir, { recursive: true });
    const untar = await runExportCommand(['tar', '-xf', tar, '-C', dir], projectRoot, 120_000, signal);
    if (untar.exitCode !== 0) throw new Error(`extracting ${commit}'s tree failed: ${untar.stderr.trim() || `exit ${untar.exitCode}`}`);
  } finally {
    await rm(tar, { force: true });
  }
}

/**
 * Start adopting `req.ref`'s Dockerfile. Only the CHEAP checks run inside the
 * call — the backend, the ref, the commit and content-hash binding, the
 * project branch's baseline, the container runtime — so a refusal is still the
 * RPC's answer and the call returns in well under a second. Everything slow
 * (exporting the commit's whole tree, verifying the exported Dockerfile
 * against the bytes the admin was shown, the docker build) runs in the
 * background as steps of the adoption's build job, and fails the way a build
 * fails: `state: 'failed'` with the step and the reason. Only a successful
 * build records the adoption; until then the project keeps what it had.
 */
export async function startImageAdoption(
  projectRoot: string,
  storage: Storage,
  req: AdoptRequest,
  deps: AdoptDeps,
): Promise<AdoptionBuildState> {
  if (build.state === 'building') {
    throw new ImageAdoptionError(409, `An adoption of ${build.branch} is already building; wait for it to finish or cancel it.`);
  }
  // RESERVE the single adoption slot before the first await, so two admins
  // confirming at once cannot both pass the check above. Released (to what
  // was there before) if anything below refuses.
  const previous = build;
  const mine = ++generation;
  build = { state: 'building', ref: req.ref, branch: req.ref, commit: req.commit, startedAt: new Date().toISOString(), progress: null, phase: 'exporting', buildId: null };
  try {
    return await validateAndStartAdoption(projectRoot, storage, req, deps, mine);
  } catch (err) {
    if (mine === generation) build = previous;
    throw err;
  }
}

async function validateAndStartAdoption(
  projectRoot: string,
  storage: Storage,
  req: AdoptRequest,
  deps: AdoptDeps,
  mine: number,
): Promise<AdoptionBuildState> {
  // Fail closed where a build would run on a dockerd SHARED with other
  // projects (Teams' local-docker backend): the fleet red-team ruled builds
  // there are the project OWNER's explicit choice (`[docker] dockerfile`), and
  // an adoption is a team admin's. Solo installs and the microVM backend build.
  const { autoBuildsRootDockerfile } = await import('../config/managed-mode');
  if (!autoBuildsRootDockerfile()) {
    throw new ImageAdoptionError(
      409,
      'This install builds images on a machine shared with other projects, so a Dockerfile is not adopted from a ' +
      'branch here. The project owner can name one with [docker] dockerfile in the project configuration.',
    );
  }
  const candidate = await readRefDockerfile(projectRoot, storage, req.ref);
  if (candidate.commit !== req.commit || candidate.contentHash !== req.contentHash) {
    throw new ImageAdoptionError(
      409,
      `${candidate.branch} has changed since you looked at it (now ${candidate.commit.substring(0, 12)}). ` +
      `Look at its ${candidate.dockerfile} again and confirm that.`,
    );
  }
  // A file whose rendering can differ from its bytes cannot be consented to.
  const hidden = findHiddenCharacters(candidate.content);
  if (hidden.length > 0) {
    throw new ImageAdoptionError(422, describeHiddenCharacters(hidden, candidate.dockerfile));
  }
  // Recorded as the baseline of the "main changed" notice; an unreadable
  // branch refuses rather than recording a baseline that is not true.
  let main: MainDockerfile | null;
  try {
    main = await readMainDockerfile(projectRoot);
  } catch (err) {
    throw new ImageAdoptionError(
      409,
      `The project branch's Dockerfile cannot be read right now (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`,
    );
  }
  const binary = await deps.resolveBinary();
  if (!binary) {
    throw new ImageAdoptionError(409, 'This project does not run agents in containers, so there is no image to adopt.');
  }
  // Cancelled (or superseded) while the checks above were awaited: the slot
  // was released, so nothing may be started — and `build` must not be
  // overwritten back to "building" with no job behind it.
  if (mine !== generation) {
    throw new ImageAdoptionError(409, `The adoption of ${candidate.branch} was cancelled before it started.`);
  }

  const source: RefAdoptionSource = {
    kind: 'ref',
    ref: candidate.ref,
    refKind: candidate.refKind,
    branch: candidate.branch,
    commit: candidate.commit,
    blob: candidate.blob,
    dockerfile: candidate.dockerfile,
    adoptedBy: req.adoptedBy,
    mainBlobAtAdoption: main?.blob ?? null,
  };
  const short = candidate.commit.substring(0, 12);
  const job = startImageBuildJob('adoption', `Adopt ${candidate.dockerfile} from ${candidate.branch} (${short})`, projectRoot);
  job.metadata = { trigger: 'admin adoption', commit: candidate.commit, dockerfile: candidate.dockerfile, requestedBy: req.adoptedBy.name || req.adoptedBy.email || undefined };
  // A previous adoption's job still running cannot exist (the slot refuses),
  // but its record is replaced: this is the adoption the admin watches now.
  adoptionJob = job;
  job.planStep('export', `Export ${candidate.branch} (${short})`);
  job.planStep('verify', `Verify the exported ${candidate.dockerfile}`);
  build = {
    state: 'building', ref: candidate.ref, branch: candidate.branch, commit: candidate.commit,
    startedAt: job.startedAt, progress: null, phase: 'exporting', buildId: job.id,
  };
  logger.info(
    `Image adoption: adopting ${candidate.dockerfile} from ${candidate.branch} (${short}) ` +
    `for ${req.adoptedBy.email ?? 'the local user'}; exporting and building in the background`,
  );
  void runAdoption(projectRoot, candidate, source, binary, deps, mine, job);
  return build;
}

/** The background half of an adoption: export → verify → build → publish. */
async function runAdoption(
  projectRoot: string,
  candidate: RefDockerfile,
  source: RefAdoptionSource,
  binary: string,
  deps: AdoptDeps,
  mine: number,
  job: ImageBuildJob,
): Promise<void> {
  const current = () => mine === generation;
  const setPhase = (phase: AdoptionPhase) => {
    if (current() && build.state === 'building') build = { ...build, phase };
  };
  const finalDir = refAdoptionContextDir(projectRoot, source);
  let staging: string | null = null;
  let step: AdoptionFailedStep = 'export';
  // Once the record is published, the context it names is the project's:
  // nothing that fails afterwards (old-context cleanup, the tracker
  // callback) may delete it or report the adoption as failed.
  let published = false;
  try {
    // EXPORT. Into the project's own checkout — inside the machine — never the
    // daemon dir, which Teams mounts from the HOST (see
    // refAdoptionContextsRoot). Built in a private staging dir, moved to its
    // per-commit-and-blob place only once it builds.
    job.beginStep('export', `Export ${candidate.branch} (${candidate.commit.substring(0, 12)})`);
    const contextsRoot = refAdoptionContextsRoot(projectRoot);
    await mkdir(contextsRoot, { recursive: true });
    staging = await mkdtemp(join(contextsRoot, STAGING_PREFIX));
    await exportTree(projectRoot, candidate.commit, staging, job.signal);
    job.endStep('export', 'done');

    // VERIFY. The exported file must be the bytes that were shown — git
    // archive reads the same tree, but nothing about the build should rest on
    // that.
    step = 'verify';
    setPhase('verifying');
    job.beginStep('verify', `Verify the exported ${candidate.dockerfile}`);
    const exported = await readFile(join(staging, candidate.dockerfile), 'utf-8').catch(() => null);
    if (exported === null || hashDockerfileContent(exported) !== candidate.contentHash) {
      throw new Error(`the exported ${candidate.dockerfile} of ${candidate.commit} does not match its committed blob`);
    }
    job.endStep('verify', 'done');

    // BUILD.
    step = 'build';
    setPhase('building');
    const ctx = staging;
    const { imageName } = await whileNotCancelled(job, job.run(() => (deps.buildCandidate ?? buildDockerfileCandidate)(projectRoot, {
      dockerfilePath: join(ctx, candidate.dockerfile),
      contextDir: ctx,
      source: describeRefAdoption(source),
      binary,
      selfcheck: true,
      notify: (line) => {
        job.narrate(line);
        if (current() && build.state === 'building') build = { ...build, progress: line };
      },
    })));
    job.metadata.image = imageName;
    if (!current()) {
      // Cancelled, or superseded by a test reset. Never publish; the context
      // is removed below.
      throw new Error('Cancelled');
    }

    // PUBLISH — past the point Cancel can undo.
    step = 'publish';
    setPhase('publishing');
    // Into place. The same commit and blob may already be there (the
    // adoption in force, re-adopted): identical bytes, so it is kept.
    let createdFinal = false;
    if (await pathExists(finalDir)) {
      await rm(staging, { recursive: true, force: true });
    } else {
      await rename(staging, finalDir);
      createdFinal = true;
    }
    staging = null;
    try {
      await publishAdoption(projectRoot, finalDir, candidate, source, imageName, deps.writeRecord ?? writeAdoptedImage);
    } catch (err) {
      // Only a context THIS attempt created is removed; one the previous
      // record names stays, so the project keeps its image.
      if (createdFinal) await rm(finalDir, { recursive: true, force: true }).catch((e) => logger.warn(`Image adoption: could not remove ${finalDir}: ${e}`));
      throw err;
    }
    published = true;
    forgetAdoptionUnavailability();
    build = { state: 'none' };
    job.metadata.imageProduced = true;
    job.finish('succeeded');
    logger.info(`Image adoption: ${imageName} from ${candidate.branch} is now the project's image`);
    await removeAdoptedContexts(projectRoot, finalDir).catch((e) =>
      logger.warn(`Image adoption: published, but could not remove older contexts: ${e instanceof Error ? e.message : String(e)}`));
    await deps.onAdopted?.();
  } catch (err) {
    if (published) {
      logger.warn(`Image adoption from ${candidate.branch} is in force, but a follow-up step failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Best-effort: a staging dir left behind is only disk, and the failure
    // below is what the admin must see — not a cleanup error.
    if (staging) {
      const dir = staging;
      await rm(dir, { recursive: true, force: true }).catch((e) => logger.warn(`Image adoption: could not remove ${dir}: ${e}`));
    }
    if (job.cancelled || !current()) {
      // cancelImageAdoption settled the state already.
      job.finish('cancelled');
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    job.finish('failed', error);
    build = {
      state: 'failed', ref: candidate.ref, branch: candidate.branch, commit: candidate.commit,
      failedAt: new Date().toISOString(), error, failedStep: step, buildId: job.id,
    };
    logger.warn(`Image adoption from ${candidate.branch} FAILED at ${step}; the project keeps its current image: ${error}`);
  }
}

/**
 * Publish the adoption: ONE atomic record write naming the new, already-built
 * context. Until that write lands, the previous record — and the context it
 * names, which nothing here touches — stays in force; if it fails, the
 * caller removes the new context and the project keeps its current image.
 * Only after success are older contexts removed.
 */
async function publishAdoption(
  projectRoot: string,
  contextDir: string,
  candidate: RefDockerfile,
  source: RefAdoptionSource,
  imageName: string,
  writeRecord: typeof writeAdoptedImage,
): Promise<AdoptedImageState> {
  const state = await writeRecord(projectRoot, {
    // Inside the lazy-owned context, whose ROOT is the build context
    // wherever the Dockerfile sits in it (refAdoptionContextDir).
    dockerfilePath: join(contextDir, candidate.dockerfile),
    contentHash: candidate.contentHash,
    imageName,
    contextCommit: candidate.commit,
    source,
  }, { snapshot: false });
  return state;
}

/**
 * Remove every adoption context except `keep` (best-effort: it is only disk):
 * the ones in the checkout, and any an earlier build of this feature left in
 * the daemon dir — which on Teams is HOST storage that must not keep
 * repository contents.
 */
async function removeAdoptedContexts(projectRoot: string, keep: string | null): Promise<void> {
  const sweep = async (dir: string, match: (name: string) => boolean) => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (!match(name) || path === keep) continue;
      await rm(path, { recursive: true, force: true })
        .catch((e) => logger.warn(`Image adoption: could not remove the old context ${path}: ${e}`));
    }
  };
  await sweep(refAdoptionContextsRoot(projectRoot), () => true);
  await sweep(getDaemonDir(projectRoot), (name) => name.startsWith(LEGACY_DAEMON_CONTEXT_PREFIX));
}

/** The build context the current ref adoption uses, or null. */
export async function currentAdoptedContextDir(projectRoot: string): Promise<string | null> {
  const adopted = await loadValidAdoptedImage(projectRoot);
  return adopted?.source?.kind === 'ref' ? refAdoptionContextDir(projectRoot, adopted.source) : null;
}

/**
 * The adoption's commit can no longer be found, so its context cannot be
 * re-exported (a recreated machine whose fresh clone lacks it). Surfaced as a
 * failed runner image with the usual ways out — never a silent switch back.
 */
export class RefAdoptionUnavailableError extends Error {}

const ensuring = new Map<string, Promise<string>>();

/**
 * Unavailability verdicts per context dir. `final`: the branch was fetched
 * and the commit is still absent — held until an explicit retry (a new
 * adoption, switch back, or "Build it again"). Otherwise origin could not be
 * reached, and the fetch is retried after FETCH_RETRY_BACKOFF_MS.
 */
const unavailable = new Map<string, { message: string; at: number; final: boolean }>();

const FETCH_RETRY_BACKOFF_MS = 10 * 60 * 1000;

/** Forget every unavailability verdict, so the next resolution asks git (and origin) again. */
export function forgetAdoptionUnavailability(): void {
  unavailable.clear();
}

/**
 * The adopted Dockerfile's path inside its context, its bytes verified against
 * the consented hash. A missing or damaged context — a recreated machine has a
 * fresh clone and no export — is RE-EXPORTED from the recorded commit (fetched
 * from origin by its branch when the clone lacks it) and verified before use.
 * Concurrent callers share one export.
 */
export async function ensureRefAdoptionContext(projectRoot: string, state: AdoptedImageState): Promise<string> {
  const source = state.source!;
  const dir = refAdoptionContextDir(projectRoot, source);
  const file = join(dir, source.dockerfile);
  const current = await readFile(file, 'utf-8').catch(() => null);
  if (current !== null && hashDockerfileContent(current) === state.contentHash) return file;

  // A recent verdict is answered at once: resolution runs on every page
  // load, builder start and launch, and must never re-run a slow fetch each
  // time while the project's image is unavailable.
  const known = unavailable.get(dir);
  if (known && (known.final || Date.now() - known.at < FETCH_RETRY_BACKOFF_MS)) {
    throw new RefAdoptionUnavailableError(known.message);
  }

  const inFlight = ensuring.get(dir);
  if (inFlight) return inFlight;
  const work = (async () => {
    const exists = async () => (await git(projectRoot, ['cat-file', '-e', `${source.commit}^{commit}`])).exitCode === 0;
    let fetchError: string | null = null;
    if (!(await exists())) {
      const fetch = await gitInRoot(projectRoot, ['fetch', '--quiet', 'origin', `refs/heads/${source.branch}`], ARCHIVE_TIMEOUT_MS);
      if (fetch.exitCode !== 0) {
        fetchError = fetch.exitCode === null
          ? `fetching ${source.branch} from origin did not finish within ${ARCHIVE_TIMEOUT_MS / 60000} minutes`
          : `could not fetch ${source.branch} from origin: ${fetch.stderr.trim() || `exit ${fetch.exitCode}`}`;
      }
    }
    if (!(await exists())) {
      const what = `The adopted ${source.dockerfile} from ${source.branch} (${source.commit.substring(0, 12)})`;
      const ways = 'Adopt from another branch or task, fix it in a task, or switch back to the project\'s own file.';
      // Say WHY: an unreachable origin is not the same as a commit that is gone,
      // and only the second is final until somebody asks to build again.
      const message = fetchError
        ? `${what} is not in this machine's copy of the repository and ${fetchError}. Build it again once origin is reachable. ${ways}`
        : `${what} is not on ${source.branch} any more (fetched from origin), so its image cannot be rebuilt. ${ways}`;
      unavailable.set(dir, { message, at: Date.now(), final: fetchError === null });
      throw new RefAdoptionUnavailableError(message);
    }
    unavailable.delete(dir);
    const root = refAdoptionContextsRoot(projectRoot);
    await mkdir(root, { recursive: true });
    const staging = await mkdtemp(join(root, STAGING_PREFIX));
    try {
      await exportTree(projectRoot, source.commit, staging);
      const exported = await readFile(join(staging, source.dockerfile), 'utf-8').catch(() => null);
      if (exported === null || hashDockerfileContent(exported) !== state.contentHash) {
        throw new RefAdoptionUnavailableError(
          `The adopted ${source.dockerfile} at ${source.commit.substring(0, 12)} no longer matches what was adopted.`);
      }
      await rm(dir, { recursive: true, force: true });
      try {
        await rename(staging, dir);
      } catch (err) {
        // Another process (a CLI next to the daemon) exported the same
        // context first: identical bytes are a win, anything else an error.
        const code = (err as NodeJS.ErrnoException).code;
        const theirs = await readFile(file, 'utf-8').catch(() => null);
        if ((code === 'ENOTEMPTY' || code === 'EEXIST') && theirs !== null && hashDockerfileContent(theirs) === state.contentHash) {
          await rm(staging, { recursive: true, force: true });
          return file;
        }
        throw new Error(`could not move the re-exported adopted context into ${dir}: ${(err as Error).message}`, { cause: err });
      }
      logger.info(`Image adoption: re-exported ${source.branch} (${source.commit.substring(0, 12)}) as the adopted image's build context`);
      return file;
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch((e) => logger.warn(`Image adoption: could not remove ${staging}: ${e}`));
      throw err;
    }
  })().finally(() => ensuring.delete(dir));
  ensuring.set(dir, work);
  return work;
}

/** "Switch back": drop a ref adoption so the project builds its own Dockerfile again. */
export async function clearRefImageAdoption(projectRoot: string, deps: { onCleared?: () => Promise<void> } = {}): Promise<{ cleared: boolean }> {
  const adopted = await loadValidAdoptedImage(projectRoot);
  if (!adopted) return { cleared: false };
  if (adopted.source?.kind !== 'ref') {
    throw new ImageAdoptionError(
      409,
      'This project\'s image was adopted from a worktree with `lazy upgrade`; run `lazy upgrade` again to change it.',
    );
  }
  // Not while an adoption builds: its context lives beside the current one,
  // and the two decisions must not race.
  if (build.state === 'building') {
    throw new ImageAdoptionError(409, `An adoption of ${build.branch} is building; wait for it to finish, then switch back.`);
  }
  if (build.state === 'failed') build = { state: 'none' };
  await clearAdoptedImage(projectRoot);
  forgetAdoptionUnavailability();
  await removeAdoptedContexts(projectRoot, null);
  logger.info(`Image adoption from ${adopted.source.branch} cleared; the project builds its own ${adopted.source.dockerfile} again`);
  await deps.onCleared?.();
  return { cleared: true };
}

/** The current ref adoption as surfaces show it, with the "main changed" notice. */
export async function refAdoptionView(projectRoot: string) {
  const adopted = await loadValidAdoptedImage(projectRoot);
  if (adopted?.source?.kind !== 'ref') return null;
  const read = await readMainDockerfileForView(projectRoot);
  const main = 'unreadable' in read ? null : read.main;
  return {
    ref: adopted.source.ref,
    refKind: adopted.source.refKind,
    branch: adopted.source.branch,
    commit: adopted.source.commit,
    dockerfile: adopted.source.dockerfile,
    imageName: adopted.imageName,
    adoptedAt: adopted.adoptedAt,
    adoptedBy: adopted.source.adoptedBy,
    mainBranch: main?.branch ?? null,
    // Sticky: a change on the project branch is a NOTICE, never a switch.
    // An unreadable branch is NOT a change (and says so).
    mainChanged: 'unreadable' in read ? false : (main?.blob ?? null) !== adopted.source.mainBlobAtAdoption,
    ...('unreadable' in read ? { mainUnreadable: read.unreadable } : {}),
  };
}

/** Tests only. */
export async function resetImageAdoptionForTests(): Promise<void> {
  generation++;
  adoptionJob?.controller.abort();
  adoptionJob = null;
  build = { state: 'none' };
  forgetAdoptionUnavailability();
}

