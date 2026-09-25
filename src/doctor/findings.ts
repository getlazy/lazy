/**
 * Detection the doctor sweep and the remedy flags SHARE.
 *
 * A check can never report something a flag would not act on (or the reverse).
 * Lives in `src/doctor/` so the daemon can import it without reaching into
 * `src/cli/`. The CLI remedy commands stay in `doctor-remedies.ts` and call
 * these finders, then prompt and act.
 */

import { stat } from 'fs/promises';
import { displayId, getWorktreePath } from '../task/identity';
import { TERMINAL_STATUSES } from '../types';
import type { Storage } from '../storage/interface';
import { createRunnerFromType } from '../runner';
import { PROJECT_LABEL_KEY } from '../runner/docker-runner';
import { indexRunsByName } from '../runner/run-ownership';
import { listLazyImages, type LazyImageInfo } from '../capture/claude';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import { looksLikeTaskBranch } from '../git/branch-prefix';
import { withDoctorStorage } from './storage';
import {
  planLocalCommandCleanup,
  summaryLooksLikeScaffolding,
  type LocalCommandCleanupPlan,
} from '../import/local-command-cleanup';

/**
 * `du` is bounded per worktree: a tree with a 4 GB node_modules is exactly what
 * this reports on, and doctor must never hang on one. A timeout costs the size,
 * not the finding — the worktree is still listed, with its size unknown.
 */
const DU_TIMEOUT_MS = 10_000;

/** Bound on the container-runtime queries this module makes. */
const RUNTIME_TIMEOUT_MS = 10_000;

/** Human-readable size, or `size unknown` when `du` could not answer. */
export function formatDiskBytes(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

/** On-disk size of a directory, or null when it cannot be measured in time. */
async function directorySizeBytes(path: string): Promise<number | null> {
  try {
    const proc = spawn(['du', '-sk', path], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: DU_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    // du missing, or killed by the timeout on a huge tree. The worktree is
    // still reported; only its size is unknown, which beats dropping the
    // finding — the finding is the point, the size is the motivation.
    return null;
  }
}

// ── terminal-task worktrees ──────────────────────────────────────────────

/** A worktree still on disk for a task that is finished with. */
export interface TerminalWorktree {
  taskId: string;
  taskCode: string;
  status: string;
  path: string;
  sizeBytes: number | null;
  /** Session whose agent log must be captured before the tree is removed. */
  sessionId: string | null;
}

/**
 * Worktrees still on disk for tasks in a terminal state.
 *
 * These are pure disk cost: the task is complete or abandoned (closed and
 * rejected tasks land in `abandoned`), its branch is kept either way, and
 * nothing will ever run in the tree again. They accumulate because not every
 * ending has always removed the tree, and each one can carry a full
 * `node_modules` or Rust `target` — 169 GB of them was found in one project in
 * the wild, which is why the size is measured and reported rather than just the
 * count.
 *
 * Read-only, and takes the Storage the caller already has so the doctor sweep
 * does not open a second one against a lock the daemon holds for life.
 */
export async function findTerminalTaskWorktrees(
  root: string,
  storage: Storage,
): Promise<TerminalWorktree[]> {
  const tasks = await storage.listTasksWithOptions({});
  const terminal = tasks.filter(task => TERMINAL_STATUSES.has(task.status));

  const found: TerminalWorktree[] = [];
  for (const task of terminal) {
    const path = getWorktreePath(root, task);
    try {
      const info = await stat(path);
      if (!info.isDirectory()) continue;
    } catch {
      // No worktree for this task — the common, healthy case.
      continue;
    }
    const session = await storage.getSessionByTaskId(task.id);
    found.push({
      taskId: task.id,
      taskCode: displayId(task),
      status: task.status,
      path,
      sizeBytes: null,
      sessionId: session?.id ?? null,
    });
  }

  // Measure in parallel: one bounded `du` per worktree in series would dominate
  // the sweep on exactly the machines this check exists for.
  const sizes = await Promise.all(found.map(w => directorySizeBytes(w.path)));
  sizes.forEach((size, i) => { found[i]!.sizeBytes = size; });

  // Biggest first — the reclaim is the point.
  return found.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

/** Size summary for a set of worktrees, e.g. `3 worktree(s), 4.2 GB`. */
export function describeWorktreeReclaim(worktrees: TerminalWorktree[]): string {
  const measured = worktrees.filter(w => w.sizeBytes !== null);
  const total = measured.length > 0
    ? formatDiskBytes(measured.reduce((sum, w) => sum + (w.sizeBytes ?? 0), 0))
    : formatDiskBytes(null);
  const partial = measured.length < worktrees.length ? ' measured' : '';
  return `${worktrees.length} worktree(s), ${total}${partial}`;
}

// ── stale runner images ──────────────────────────────────────────────────

/**
 * Lazy-built images no launch on this machine can reach.
 *
 * Failure is a THROW, not an empty list. An empty list means "scanned, found
 * nothing stale", and the remedy prints exactly that — so a scan that could not
 * run must not be able to produce it. Which failure it was decides how a caller
 * reports it, hence `kind`.
 */
export class StaleImageScanError extends Error {
  constructor(
    /**
     * `runtime` — the container runtime could not be queried at all (absent
     * binary, daemon down). The runtime checks already report that, so the
     * stale-image CHECK stays silent about it (one warning per problem) while
     * the REMEDY must refuse loudly rather than print a clean bill.
     *
     * `in-use` — the runtime answered but what is in use could not be resolved.
     * Nothing else reports this, so it warrants a warning of its own.
     */
    readonly kind: 'runtime' | 'in-use',
    message: string,
  ) {
    super(message);
    this.name = 'StaleImageScanError';
  }
}

export async function findStaleLazyImages(
  imageName: string,
  binary: string = 'docker',
  root?: string | null,
  storage?: Storage,
): Promise<LazyImageInfo[]> {
  let images: LazyImageInfo[];
  try {
    images = await listLazyImages(binary);
  } catch (err) {
    throw new StaleImageScanError(
      'runtime',
      `could not list images with ${binary}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (images.length === 0) return [];

  const keep = new Set<string>([imageName]);
  if (root) {
    try {
      const { inspectAdoptedImage } = await import('../daemon/adopted-image');
      const adopted = await inspectAdoptedImage(root);
      // Only a VALID adoption is protected: an expired or drifted one is
      // cleared by the adopted-image check, and its image really is dead.
      if (adopted.status === 'valid') keep.add(adopted.state.imageName);

      const { pinnedCustomImage } = await import('../docker/worktree-image');
      const addPins = async (handle: Storage): Promise<void> => {
        // Every task, terminal ones included: a closed task's pinned image is
        // still what a reopen would launch with, and a pin that outlives its
        // task costs one image — deleting it wedges the task.
        for (const task of await handle.listTasksWithOptions({})) {
          const pinned = pinnedCustomImage(task);
          if (pinned) keep.add(pinned);
        }
      };
      if (storage) await addPins(storage);
      else await withDoctorStorage(root, addPins);
    } catch (err) {
      // Cannot resolve what is in use, so nothing may be called stale: naming
      // an image a live launch needs is the failure this exists to prevent.
      throw new StaleImageScanError(
        'in-use',
        `could not resolve which images are in use: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Anything sharing a kept image's ID is that same image under another tag.
  const keptIds = new Set(images.filter(image => keep.has(image.ref)).map(image => image.id));
  return images.filter(image => !keep.has(image.ref) && !keptIds.has(image.id));
}

// ── orphaned containers ──────────────────────────────────────────────────

/** A lazy container no task in this project still needs. */
export interface OrphanedContainer {
  name: string;
  running: boolean;
  /** The runtime's own one-word state (`running`, `exited`, `created`, …). */
  state: string;
  taskCode: string;
  taskStatus: string;
  /** Session recording this container name, so the record can be cleared too. */
  sessionId: string | null;
}

/**
 * Lazy containers belonging to THIS project that nothing needs any more: a
 * stopped container for any task of ours, and a running container for a task
 * that has already reached a terminal state.
 *
 * A running container for a live task is never listed — that is a turn in
 * progress, and killing it is the opposite of a remedy.
 *
 * Ownership comes from `indexRunsByName` — the same function that NAMED the
 * run — plus the project label. Enumeration is async (`spawn`, not
 * `spawnSync`) so a slow runtime cannot pin the daemon event loop.
 */
export async function findOrphanedContainers(
  root: string,
  storage: Storage,
  binary: 'docker' | 'podman' = 'docker',
): Promise<OrphanedContainer[]> {
  // Naming only — deliberately the config-free, proxy-free constructor, so
  // reading this list never depends on the daemon being up.
  const owned = await indexRunsByName(storage, createRunnerFromType(binary));

  const proc = spawn(
    [
      binary, 'ps', '-a', '--filter', 'name=^lazy-',
      '--format', `{{.Names}}\t{{.State}}\t{{.Label "${PROJECT_LABEL_KEY}"}}`,
    ],
    { stdout: 'pipe', stderr: 'ignore', timeout: RUNTIME_TIMEOUT_MS },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return [];

  const output = stdout.trim();
  if (!output) return [];

  const orphans: OrphanedContainer[] = [];
  for (const line of output.split('\n')) {
    const [name, state, label] = line.split('\t');
    if (!name) continue;
    // Same rule the runner's own discovery uses: our label, or no label at all
    // (containers created before the label existed).
    if (label && label !== root) continue;

    const task = owned.get(name);
    // Not one of our task's runs → not ours to touch. Covers another project's
    // containers and the suffixed one-shot/pair runs, which are `--rm` and
    // nobody's to reap here.
    if (!task) continue;

    // `.State` is the machine-readable one word (`running`, `exited`,
    // `created`, `paused`, `dead`, …) — `.Status` is prose ("Up 3 minutes"),
    // and sniffing it for "Up"/"Exited" silently dropped every other state.
    const running = state === 'running';
    if (running && !TERMINAL_STATUSES.has(task.status)) continue;

    const session = await storage.getSessionByTaskId(task.id);
    orphans.push({
      name,
      running,
      state: state ?? 'unknown',
      taskCode: displayId(task),
      taskStatus: task.status,
      sessionId: session?.container_name === name ? session.id : null,
    });
  }
  // Stopped first: removing those is uncontroversial, so a human scanning the
  // list meets the surprising entries (a running container) last.
  return orphans.sort((a, b) => Number(a.running) - Number(b.running));
}

// ── task-branch upstream tracking ────────────────────────────────────────

/** A `lazy/...` branch carrying upstream tracking config. */
export interface TrackedTaskBranch {
  branch: string;
  remote: string;
  /** The ref the branch is configured to merge, e.g. `refs/heads/lazy/foo`. */
  merge: string | null;
  /**
   * True when `merge` names a DIFFERENT branch — the only genuinely hazardous
   * shape, because `git pull` on this branch then merges that other branch in.
   */
  mismatched: boolean;
}

/**
 * `lazy/...` branches with `branch.<name>.remote` set, and how each is
 * configured.
 *
 * The `mismatched` split is why this reports the merge ref rather than a bare
 * count. Tracking that points a task branch at its OWN remote counterpart is
 * ordinary git config: `git pull` consults only the CURRENT branch's upstream,
 * so it cannot make a task branch flow into main — the old warning's claim
 * ("this can cause 'git pull' to merge task branches into main") was simply not
 * how git behaves. Tracking whose `.merge` names a DIFFERENT branch is a real
 * hazard, and that is the case worth escalating.
 */
export async function findTrackedTaskBranches(cwd: string): Promise<TrackedTaskBranch[]> {
  const result = await runGit(['branch', '--format=%(refname:short)'], {
    cwd,
    stderr: 'ignore',
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return [];

  const branches = result.stdout
    .split('\n')
    .map(b => b.trim())
    .filter(b => looksLikeTaskBranch(b));

  const tracked: TrackedTaskBranch[] = [];
  for (const branch of branches) {
    const remote = await runGit(['config', `branch.${branch}.remote`], {
      cwd,
      stderr: 'ignore',
      timeout: 5_000,
    });
    if (remote.exitCode !== 0 || !remote.stdout.trim()) continue;
    const merge = await runGit(['config', `branch.${branch}.merge`], {
      cwd,
      stderr: 'ignore',
      timeout: 5_000,
    });
    const mergeRef = merge.exitCode === 0 && merge.stdout.trim() ? merge.stdout.trim() : null;
    tracked.push({
      branch,
      remote: remote.stdout.trim(),
      merge: mergeRef,
      mismatched: mergeRef !== null && mergeRef !== `refs/heads/${branch}`,
    });
  }
  return tracked;
}

// ── interrupted tasks ────────────────────────────────────────────────────

/** A task the reconciler would resume on its own, and the run that stopped. */
export interface ResumableTask {
  taskId: string;
  taskCode: string;
  runName: string | null;
}

/** Interrupted tasks, with the container their last turn ran in when known. */
export async function findResumableTasks(storage: Storage): Promise<ResumableTask[]> {
  const tasks = await storage.listTasksWithOptions({ interruptedOnly: true });
  const out: ResumableTask[] = [];
  for (const task of tasks) {
    const session = await storage.getSessionByTaskId(task.id);
    out.push({
      taskId: task.id,
      taskCode: displayId(task),
      runName: session?.container_name ?? null,
    });
  }
  return out;
}

// ── local-command scaffolding in stored conversations ────────────────────

/**
 * Stored conversations still carrying Claude Code's local-command scaffolding,
 * and what cleaning them would do.
 *
 * Reads every transcript, which is why it backs the REMEDY and not the sweep:
 * the check uses `countScaffoldingSummaries` below, which reads the
 * conversation index instead.
 */
export async function findLocalCommandConversations(
  storage: Storage,
): Promise<LocalCommandCleanupPlan> {
  return planLocalCommandCleanup(await storage.listConversations());
}

/**
 * How many stored conversations LIST as local-command scaffolding — the visible
 * symptom, counted off the conversation index rather than the transcripts.
 *
 * A strict subset of what `findLocalCommandConversations` cleans (see
 * `summaryLooksLikeScaffolding`), so the check can never point at a remedy with
 * nothing to do.
 */
export async function countScaffoldingSummaries(
  storage: Storage,
): Promise<{ affected: number; total: number }> {
  const summaries = await storage.listConversationSummaries();
  return {
    affected: summaries.filter(s => summaryLooksLikeScaffolding(s.summary ?? '')).length,
    total: summaries.length,
  };
}
