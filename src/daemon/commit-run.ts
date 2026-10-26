/**
 * COMMIT RUNS — the product running at one commit, without a task.
 *
 * Tasks exist to ship a product, and until this existed there was no way to
 * look at the product itself — the default branch, a colleague's branch, the
 * commit a bug report names — through lazy. A run is that: a detached
 * checkout lazy owns (./commit-run-checkout.ts), a container with the
 * project's image and `[serve]` ports and no agent credential in it
 * (./commit-run-container.ts), and the same Start services, service proxy and
 * shell a task's Services tab has.
 *
 * WHAT A RUN TARGETS. A commit, named one of two ways:
 *   - `{ kind: 'branch', branch }` FOLLOWS the branch: it starts at the
 *     branch's HEAD on the remote, and Pull latest moves it to the newest one;
 *   - `{ kind: 'sha', sha }` is PINNED to one commit; there is nothing to pull.
 * With no target, the remote's default branch. Whatever is named must be on
 * the project's REMOTE — never something only this clone has.
 *
 * WHAT A RUN IS NOT. A task: it has no session, turns, review, accept or PR,
 * and no list or count of tasks includes it (its rows live apart, behind
 * Storage's commit-run methods). Nothing ever starts one by itself and nothing
 * stops one for being idle; a daemon restart stops its container, as it stops
 * task containers, and the record and checkout stay.
 *
 * ONE RUN PER BRANCH, ONE PER COMMIT, per project, SHARED by everybody on it —
 * as task services are. Any member may start, stop, pull or remove it; every
 * write names who did it (`applyCallerActor`). A second create of the same
 * target answers with the existing run.
 *
 * The RPC shapes are documented for clients in docs/design/run-any-commit.md.
 */

import { randomUUID } from 'crypto';
import type { Storage } from '../storage';
import type { CommitRun, CommitRunPerson, CommitRunTarget } from '../storage/types';
import type { ActorInput } from '../types';
import { actorEmail, actorName } from '../actor-ref';
import { RpcError } from './rpc-error';
import { getOrCreateStorage } from './rpc-handlers';
import { requireString, optionalBoolean, optionalString, optionalActorInput } from './rpc-params';
import { createRunner } from '../runner';
import { clearTaskEnv } from './task-env';
import { forgetTaskFiles } from './task-files';
import { readServicesRunState, runStartServices } from './serve-run';
import { containerCliOf } from '../runner/container-cli';
import { PhaseReporter, type PlannedPhase, type ProgressEmitter } from './progress';
import { logger } from '../utils/logger';
import { pathExists } from '../utils/fs';
import {
  assertRemoteReachable,
  checkoutChanges,
  checkoutHead,
  hasChanges,
  commitsAhead,
  dirtyCheckoutRefusal,
  describeCommit,
  ensureRunCheckout,
  fetchRemoteBranchHead,
  lastFetchedBranchHead,
  listRemoteBranches,
  moveCheckout,
  remoteDefaultBranch,
  removeRunCheckout,
  resolveRemoteCommit,
  runRemoteName,
  withRunLock,
} from './commit-run-checkout';
import { removeRunContainer, resolveCommitRun, stopRunContainer } from './commit-run-container';
import {
  describeCommitRunTarget,
  isShaLike,
  runAttachSessionId,
  runContainerName,
  runPagePath,
  runSlugFor,
  runWorktreePath,
  sameRunTarget,
} from '../run/identity';
import { taskHostLabel } from '../serve/subdomain';
import { isTerminalStatus } from '../task-state-machine';

/** A run as clients render it: the record, plus everything derived from it. */
export interface CommitRunView extends CommitRun {
  /** The host label its services answer on — the slug. */
  hostLabel: string;
  worktreePath: string;
  containerName: string;
  /** The session id a terminal attaches with (`attachSession`, `/rpc/sessions/:id/attach/ws`). */
  attachSessionId: string;
  /** The dashboard path the service proxy sends a dead service's navigation to. */
  pagePath: string;
  /** Only a branch-following run can be pulled. */
  canPull: boolean;
  /** The commit lazy checked out (`head_sha`), described; null when this clone cannot read it. */
  commit: { sha: string; committedAt: string; subject: string } | null;
  /**
   * The commit the checkout is ACTUALLY at — somebody in the run's shell can
   * commit or check out something else. `moved` is true when it is not
   * `head_sha`; then `commit` describes it. Null when the checkout is missing.
   */
  checkout: { head: string; moved: boolean; commit: { sha: string; committedAt: string; subject: string } | null } | null;
  /**
   * Branch runs: the branch's HEAD as the project last FETCHED it, and how many
   * commits that is ahead of the run. Never fetched for this answer.
   */
  remote: { sha: string | null; ahead: number | null } | null;
}

function personOf(actor: ActorInput | undefined): CommitRunPerson | null {
  const email = actorEmail(actor) ?? null;
  const name = actorName(actor) ?? null;
  return email || name ? { email, name } : null;
}

async function viewOf(projectRoot: string, run: CommitRun): Promise<CommitRunView> {
  const head = await checkoutHead(runWorktreePath(projectRoot, run.slug));
  const checkout: CommitRunView['checkout'] = head
    ? { head, moved: head !== run.head_sha, commit: head !== run.head_sha ? await describeCommit(projectRoot, head) : null }
    : null;
  let remote: CommitRunView['remote'] = null;
  if (run.target.kind === 'branch') {
    const name = await runRemoteName(projectRoot);
    const sha = await lastFetchedBranchHead(projectRoot, name, run.target.branch);
    remote = { sha, ahead: sha && sha !== run.head_sha ? await commitsAhead(projectRoot, run.head_sha, sha) : sha ? 0 : null };
  }
  return {
    ...run,
    hostLabel: run.slug,
    worktreePath: runWorktreePath(projectRoot, run.slug),
    containerName: runContainerName(projectRoot, run.slug),
    attachSessionId: runAttachSessionId(run.id),
    pagePath: runPagePath(run.id),
    canPull: run.target.kind === 'branch',
    commit: await describeCommit(projectRoot, run.head_sha),
    checkout,
    remote,
  };
}

/** Parse a `target` parameter: absent → the remote's default branch. */
export function parseRunTarget(params: Record<string, unknown>): CommitRunTarget | null {
  const raw = params.target;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError(400, `'target' must be { kind: 'branch', branch } or { kind: 'sha', sha }.`);
  }
  const t = raw as Record<string, unknown>;
  if (t.kind === 'branch') {
    if (typeof t.branch !== 'string' || !t.branch.trim()) throw new RpcError(400, `A branch target needs a 'branch' name.`);
    return { kind: 'branch', branch: t.branch.trim() };
  }
  if (t.kind === 'sha') {
    if (typeof t.sha !== 'string' || !isShaLike(t.sha.trim())) {
      throw new RpcError(400, `A sha target needs a 'sha' of 7 to 40 hexadecimal characters.`);
    }
    return { kind: 'sha', sha: t.sha.trim().toLowerCase() };
  }
  throw new RpcError(400, `Unknown target kind ${JSON.stringify(t.kind)}: use 'branch' or 'sha'.`);
}

// --- Reads ---

/** `listBranches` — the remote's branches, default first; `refresh` fetches first. */
export async function handleListBranches(projectRoot: string, params: Record<string, unknown>) {
  const remote = await runRemoteName(projectRoot);
  return listRemoteBranches(projectRoot, remote, { refresh: optionalBoolean(params, 'refresh') === true });
}

/** `resolveCommit` — validate a sha against the remote: the full id, what it is, which branches have it. */
export async function handleResolveCommit(projectRoot: string, params: Record<string, unknown>) {
  const input = requireString(params, 'sha');
  const remote = await runRemoteName(projectRoot);
  await assertRemoteReachable(projectRoot, remote);
  const { sha, branches } = await resolveRemoteCommit(projectRoot, remote, input);
  return { sha, commit: await describeCommit(projectRoot, sha), branches };
}

export async function handleListRuns(projectRoot: string) {
  const storage = await getOrCreateStorage();
  return { runs: await Promise.all((await storage.listCommitRuns()).map((r) => viewOf(projectRoot, r))) };
}

export async function handleShowRun(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const run = await resolveCommitRun(storage, requireString(params, 'runId'));
  const view = await viewOf(projectRoot, run);
  const runner = await createRunner(projectRoot);
  const containerRunning = runner.usesSandbox() ? await runner.isRunning(view.containerName) : false;
  return { ...view, containerRunning, checkoutExists: await pathExists(view.worktreePath) };
}

// --- Create ---

export interface CreateRunDeps {
  getStorage?: () => Promise<Storage>;
}

/**
 * `runs.create` — register a run of a branch's HEAD or a commit, and check it
 * out. Nothing is started: Run services (`serve.run { runId }`) is the step
 * that brings a container up. The same target twice answers with the existing
 * run (`existed: true`).
 */
export async function createCommitRun(
  projectRoot: string,
  params: { target: CommitRunTarget | null; actor?: ActorInput; progress?: ProgressEmitter; confirmDiscard?: boolean },
  deps: CreateRunDeps = {},
): Promise<{ run: CommitRunView; existed: boolean; discarded: string[]; discardedCommits: string[] }> {
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  const remote = await runRemoteName(projectRoot);
  const reporter = new PhaseReporter(params.progress, 'runs.create');
  const P = CREATE_PHASES;
  reporter.announce([P.resolve, P.checkout]);

  // Everything that names a commit is checked against the remote, first.
  reporter.begin(P.resolve);
  let target: CommitRunTarget;
  let sha: string;
  try {
    await assertRemoteReachable(projectRoot, remote);
    if (params.target?.kind === 'sha') {
      sha = (await resolveRemoteCommit(projectRoot, remote, params.target.sha)).sha;
      target = { kind: 'sha', sha };
    } else {
      const branch = params.target?.kind === 'branch' ? params.target.branch : await remoteDefaultBranch(projectRoot, remote);
      sha = await fetchRemoteBranchHead(projectRoot, remote, branch);
      target = { kind: 'branch', branch };
    }
  } catch (err) {
    reporter.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
  reporter.end(`${describeCommitRunTarget({ target })} is at ${sha.slice(0, 12)}`);

  const slug = runSlugFor(target);
  return withRunLock(slug, async () => {
    const existing = await storage.getCommitRunBySlug(slug);
    if (existing) {
      if (!sameRunTarget(existing.target, target)) {
        throw new RpcError(409,
          `The name '${slug}' is already used by the run of ${describeCommitRunTarget(existing)}, so ${describeCommitRunTarget({ target })} cannot get one of its own. ` +
          `Remove that run first.`);
      }
      reporter.skip(P.checkout, 'the run already exists');
      return { run: await viewOf(projectRoot, existing), existed: true, discarded: [], discardedCommits: [] };
    }
    // A run answers on the same hostname a task would; refused while a live
    // task does (the store refuses it again inside its lock).
    const clash = (await storage.listTasks()).find((t) => !isTerminalStatus(t.status) && taskHostLabel(t) === slug);
    if (clash) {
      throw new RpcError(409,
        `Task ${slug} already answers on the name '${slug}', so a run of ${describeCommitRunTarget({ target })} there could not be reached. ` +
        `Close or rename that task first.`);
    }

    const now = new Date().toISOString();
    const run: CommitRun = {
      id: randomUUID(),
      slug,
      target,
      head_sha: sha,
      image_choice: null,
      created_at: now,
      created_by: personOf(params.actor),
      updated_at: now,
      last_pulled_at: null,
      last_pulled_by: null,
    };

    reporter.begin(P.checkout, `checking out ${sha.slice(0, 12)}`);
    const worktreePath = runWorktreePath(projectRoot, slug);
    let created = false;
    let moved = { discarded: [] as string[], discardedCommits: [] as string[] };
    try {
      // A checkout left with no record (a create that died between the two)
      // is moved like a Pull would move it — never deleted unasked, and its
      // changes refused until the caller confirms (`confirmDiscard`).
      if (await pathExists(worktreePath)) {
        moved = await moveCheckout(projectRoot, worktreePath, sha, { what: 'Running this commit', confirmDiscard: params.confirmDiscard });
      } else {
        created = (await ensureRunCheckout(projectRoot, run, (d) => reporter.note(d))).created;
      }
      await storage.createCommitRun(run);
    } catch (err) {
      reporter.fail(err instanceof Error ? err.message : String(err));
      // A checkout THIS call made, untouched since, is nobody's: removed, so a
      // refused create leaves no orphan behind.
      if (created) {
        await removeRunCheckout(projectRoot, slug, {}).catch((rmErr) => {
          logger.warn(`Could not remove the checkout ${worktreePath} of a run that was not created: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
        });
      }
      if (err instanceof RpcError) throw err;
      throw new RpcError(409, err instanceof Error ? err.message : String(err));
    }
    reporter.end(`${worktreePath}`);
    logger.info(`Run ${slug} created for ${describeCommitRunTarget(run)} at ${sha.slice(0, 12)}${run.created_by?.email ? ` by ${run.created_by.email}` : ''}.`);
    return { run: await viewOf(projectRoot, run), existed: false, discarded: moved.discarded, discardedCommits: moved.discardedCommits };
  });
}

const CREATE_PHASES = {
  resolve: { id: 'resolve', label: 'Find the commit on the remote' },
  checkout: { id: 'checkout', label: 'Check out the commit' },
} as const satisfies Record<string, PlannedPhase>;

const PULL_PHASES = {
  fetch: { id: 'fetch', label: "Fetch the branch's newest commit" },
  checkout: { id: 'checkout', label: 'Move the checkout' },
  restart: { id: 'restart', label: 'Restart services', optional: true },
} as const satisfies Record<string, PlannedPhase>;

export async function handleCreateRun(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  return createCommitRun(projectRoot, {
    target: parseRunTarget(params),
    actor: optionalActorInput(params),
    progress,
    confirmDiscard: optionalBoolean(params, 'confirmDiscard') === true,
  });
}

// --- Pull latest ---

export interface PullRunResult {
  run: CommitRunView;
  moved: boolean;
  from: string;
  to: string;
  discarded: string[];
  /** Commits made in the checkout that the move left unreachable. */
  discardedCommits: string[];
  kept: string[];
  /** Services were running and were started again on the new commit. */
  servicesRestarted: boolean;
  /** Why the services could not be started again, when they could not. */
  servicesRestartError?: string;
}

/**
 * `runs.pull` — move a branch run to the branch's newest commit on the remote.
 * Refused for a sha run. A checkout somebody changed is refused (409, the
 * files in `details.dirtyFiles`) unless `confirmDiscard`. Services that were
 * running are started again on the new commit, narrated.
 */
export async function pullCommitRun(
  projectRoot: string,
  params: { runId: string; confirmDiscard?: boolean; actor?: ActorInput; progress?: ProgressEmitter },
  deps: { getStorage?: () => Promise<Storage>; restartServices?: (runId: string) => Promise<unknown> } = {},
): Promise<PullRunResult> {
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  const initial = await resolveCommitRun(storage, params.runId);
  if (initial.target.kind !== 'branch') {
    throw new RpcError(409,
      `This run is pinned to commit ${initial.head_sha.slice(0, 12)}; there is nothing to pull. ` +
      `To run a newer commit, run its branch or that commit.`);
  }
  const branch = initial.target.branch;
  const remote = await runRemoteName(projectRoot);
  const reporter = new PhaseReporter(params.progress, 'runs.pull');
  const P = PULL_PHASES;
  reporter.announce([P.fetch, P.checkout, P.restart], initial.slug);

  const moved = await withRunLock(initial.slug, async () => {
    const run = await storage.getCommitRun(initial.id);
    if (!run) throw new RpcError(404, `Run not found: ${params.runId} (it was removed).`);
    reporter.begin(P.fetch);
    let to: string;
    try {
      await assertRemoteReachable(projectRoot, remote);
      to = await fetchRemoteBranchHead(projectRoot, remote, branch);
    } catch (err) {
      reporter.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
    const from = run.head_sha;
    if (to === from) {
      reporter.end(`already at the latest commit, ${to.slice(0, 12)}`);
      reporter.skip(P.checkout, 'already at the latest commit');
      return { run, from, to, moved: false, discarded: [] as string[], discardedCommits: [] as string[], kept: [] as string[] };
    }
    reporter.end(`${branch} is at ${to.slice(0, 12)}`);
    reporter.begin(P.checkout, `${from.slice(0, 12)} → ${to.slice(0, 12)}`);
    let move;
    try {
      const { worktreePath, created } = await ensureRunCheckout(projectRoot, { slug: run.slug, head_sha: to }, (d) => reporter.note(d));
      move = created ? { discarded: [], discardedCommits: [], kept: [] } : await moveCheckout(projectRoot, worktreePath, to, {
        confirmDiscard: params.confirmDiscard,
        what: 'Pulling the latest commit',
        recordedSha: from,
      });
    } catch (err) {
      reporter.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
    const updated = await storage.updateCommitRun(run.id, {
      head_sha: to,
      last_pulled_at: new Date().toISOString(),
      last_pulled_by: personOf(params.actor),
    });
    const lost = [...move.discarded, ...move.discardedCommits.map((c) => `commit ${c}`)];
    reporter.end(lost.length > 0 ? `discarded: ${lost.join(', ')}` : undefined);
    logger.info(`Run ${run.slug} pulled ${from.slice(0, 12)} → ${to.slice(0, 12)}${lost.length ? ` (discarded ${lost.join(', ')})` : ''}.`);
    return { run: updated, from, to, moved: true, discarded: move.discarded, discardedCommits: move.discardedCommits, kept: move.kept };
  });

  // Restarted OUTSIDE the run's lock: Start services takes it itself.
  let servicesRestarted = false;
  let servicesRestartError: string | undefined;
  const services = moved.moved ? await servicesRunning(projectRoot, moved.run) : 'not-running';
  if (typeof services === 'object') {
    servicesRestartError = `whether services were running could not be read (${services.unknown}); they were not restarted — Run services starts them on the new commit`;
    reporter.skip(P.restart, servicesRestartError);
  } else if (services === 'running') {
    reporter.begin(P.restart, 'services were running on the previous commit');
    try {
      await (deps.restartServices ?? ((runId: string) => runStartServices(projectRoot, { runId })))(moved.run.id);
      servicesRestarted = true;
      reporter.end('running on the new commit');
    } catch (err) {
      servicesRestartError = err instanceof Error ? err.message : String(err);
      reporter.fail(servicesRestartError);
    }
  } else {
    reporter.skip(P.restart, moved.moved ? 'services were not running' : 'nothing moved');
  }
  return {
    run: await viewOf(projectRoot, moved.run),
    moved: moved.moved,
    from: moved.from,
    to: moved.to,
    discarded: moved.discarded,
    discardedCommits: moved.discardedCommits,
    kept: moved.kept,
    servicesRestarted,
    ...(servicesRestartError ? { servicesRestartError } : {}),
  };
}

/**
 * Whether Start services is running in the run's container right now:
 * `unknown` (with why) when the container could not be asked — which is not
 * "not running", and is said so.
 */
async function servicesRunning(projectRoot: string, run: CommitRun): Promise<'running' | 'not-running' | { unknown: string }> {
  const runner = await createRunner(projectRoot);
  if (!runner.usesSandbox()) return 'not-running';
  const name = runContainerName(projectRoot, run.slug);
  if (!(await runner.isRunning(name))) return 'not-running';
  try {
    const state = await readServicesRunState(containerCliOf(runner), name);
    if (state === null) return { unknown: `${name} did not answer` };
    return state.state === 'running' ? 'running' : 'not-running';
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    logger.warn(`Run ${run.slug}: could not read whether services run in ${name}: ${why}`);
    return { unknown: why };
  }
}

export async function handlePullRun(projectRoot: string, params: Record<string, unknown>, progress?: ProgressEmitter) {
  return pullCommitRun(projectRoot, {
    runId: requireString(params, 'runId'),
    confirmDiscard: optionalBoolean(params, 'confirmDiscard') === true,
    actor: optionalActorInput(params),
    progress,
  });
}

// --- Remove ---

/**
 * `runs.remove` — remove the run's container (and everything running in it),
 * its checkout and its record, and forget its environment and files. A
 * checkout somebody changed is refused (409, `details.dirtyFiles`) unless
 * `confirmDiscard`; nothing is touched before that check.
 */
export async function removeCommitRun(
  projectRoot: string,
  params: { runId: string; confirmDiscard?: boolean; actor?: ActorInput },
  deps: { getStorage?: () => Promise<Storage> } = {},
): Promise<{ removed: true; runId: string; slug: string; discarded: string[]; discardedCommits: string[] }> {
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  const initial = await resolveCommitRun(storage, params.runId);
  return withRunLock(initial.slug, async () => {
    const run = await storage.getCommitRun(initial.id);
    if (!run) throw new RpcError(404, `Run not found: ${params.runId} (it was already removed).`);
    // The changes check first: nothing is stopped or deleted for a refusal.
    const worktreePath = runWorktreePath(projectRoot, run.slug);
    if (await pathExists(worktreePath) && !params.confirmDiscard) {
      const changes = await checkoutChanges(worktreePath, run.head_sha);
      if (hasChanges(changes)) throw dirtyCheckoutRefusal('Removing the run', changes);
    }
    const runner = await createRunner(projectRoot);
    if (runner.usesSandbox()) await removeRunContainer(containerCliOf(runner), runContainerName(projectRoot, run.slug));
    const { discarded, discardedCommits } = await removeRunCheckout(projectRoot, run.slug, { confirmDiscard: true, recordedSha: run.head_sha });
    await storage.deleteCommitRun(run.id);
    await clearTaskEnv(projectRoot, run.id);
    await forgetTaskFiles(projectRoot, run.id);
    const who = actorEmail(params.actor);
    const lost = [...discarded, ...discardedCommits.map((c) => `commit ${c}`)];
    logger.info(`Run ${run.slug} (${describeCommitRunTarget(run)}) removed${who ? ` by ${who}` : ''}${lost.length ? `; discarded ${lost.join(', ')}` : ''}.`);
    return { removed: true as const, runId: run.id, slug: run.slug, discarded, discardedCommits };
  });
}

export async function handleRemoveRun(projectRoot: string, params: Record<string, unknown>) {
  return removeCommitRun(projectRoot, {
    runId: requireString(params, 'runId'),
    confirmDiscard: optionalBoolean(params, 'confirmDiscard') === true,
    actor: optionalActorInput(params),
  });
}

// --- Container and image choice ---

/** `runs.stopContainer` — remove the run's container (its services go with it); checkout and record stay. */
export async function handleStopRunContainer(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const run = await resolveCommitRun(storage, requireString(params, 'runId'));
  return withRunLock(run.slug, () => stopRunContainer(projectRoot, run));
}

/**
 * `runs.setImageChoice` — `default` runs this run on lazy's default image
 * while the project's own is not ready (the answer to a
 * `runner_image_not_ready` refusal); `project` goes back to the project's
 * image. Takes effect the next time the container is created.
 */
export async function handleSetRunImageChoice(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  const run = await resolveCommitRun(storage, requireString(params, 'runId'));
  const choice = optionalString(params, 'choice');
  if (choice !== 'default' && choice !== 'project') {
    throw new RpcError(400, `'choice' must be 'default' (lazy's default image) or 'project' (the project's image).`);
  }
  const updated = await storage.updateCommitRun(run.id, { image_choice: choice === 'default' ? 'default' : null });
  return { run: await viewOf(projectRoot, updated) };
}
