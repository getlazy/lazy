/**
 * The port through which the dashboard's Run pages (`/runs`, `/runs/:id`)
 * reach COMMIT RUNS — the product running at one commit without a task
 * (src/daemon/commit-run.ts, docs/design/run-any-commit.md).
 *
 * INVARIANT (same as ./task-actions.ts): the web layer only RENDERS. Every
 * rule — which commit a branch names, whether a sha is on the remote, whether
 * a checkout holds somebody's changes, what Run services does — is decided by
 * the daemon behind this port, which calls the same functions the `runs.*`,
 * `listBranches`, `serve.run` / `serve.stop` and `servePorts` RPCs do. So the
 * dashboard and Lazy Teams cannot disagree about a run. This file lives in
 * src/server/ because src/daemon/server.ts already imports src/server; the
 * reverse import would be a module cycle.
 *
 * Without an injected implementation (a Storage-only web handler) the Run
 * pages answer 503 rather than half-working.
 *
 * The shapes below are deliberately loose copies of the daemon's answers —
 * only the fields a page renders — so daemon result types stay out of
 * src/server.
 */

import type { ProgressEmitter } from '../daemon/progress';
import type { CommitRunTarget } from '../storage/types';
import type { TaskServeState } from '../serve/discovery';
import type { ProbedService } from '../serve/probe';
import type { EnsureContainerResult } from './task-actions';

export type RunTarget = CommitRunTarget;

export interface RunCommit {
  sha: string;
  committedAt: string;
  subject: string;
}

export interface RunPerson {
  email: string | null;
  name: string | null;
}

/** A remote branch, as `listBranches` answers it. */
export interface RunBranch {
  name: string;
  sha: string;
  committedAt: string;
  subject: string;
  isDefault: boolean;
  /** `lazy/*` — a task's branch; the page hides these behind a toggle. */
  isTaskBranch: boolean;
}

export interface RunBranchList {
  remote: string;
  defaultBranch: string | null;
  /** True when this answer fetched first. */
  fetched: boolean;
  branches: RunBranch[];
}

/** A run as the daemon describes it (`CommitRunView`). */
export interface RunView {
  id: string;
  slug: string;
  target: RunTarget;
  head_sha: string;
  image_choice: 'default' | null;
  created_at: string;
  created_by: RunPerson | null;
  last_pulled_at: string | null;
  last_pulled_by: RunPerson | null;
  hostLabel: string;
  pagePath: string;
  canPull: boolean;
  commit: RunCommit | null;
  checkout: { head: string; moved: boolean; commit: RunCommit | null } | null;
  remote: { sha: string | null; ahead: number | null } | null;
}

/** `runs.show`: the view plus the two things probed per request. */
export interface RunDetail extends RunView {
  containerRunning: boolean;
  checkoutExists: boolean;
}

/** One process Start services launched, as the container reports it. */
export interface RunServicesProcess {
  pid: number;
  procState: string;
  command: string;
  listeningPorts: number[];
  wrapper?: boolean;
  /** The declared services its listening ports serve, with the published port's probe. */
  services?: Array<{ name: string; port: number; listening: boolean | null }>;
}

/** What Start services is doing in the run's environment (`servicesRun`). */
export interface RunServicesRun {
  state: 'running' | 'stopped' | 'never';
  log: string;
  phase?: 'starting' | 'running' | 'exited' | 'stopped' | 'never';
  command?: string | null;
  startedAt?: string | null;
  exitCode?: number | null;
  processes?: RunServicesProcess[];
  logTruncated?: boolean;
}

/** `servePorts { runId, includeServicesRun }`, narrowed. */
export interface RunServeView extends Omit<TaskServeState, 'services'> {
  services: ProbedService[];
  /** The project's Start services command ('' when none is designated). */
  startServicesCmd: string;
  /** null when nothing ran, or the container could not be asked. */
  servicesRun: RunServicesRun | null;
}

export interface RunCreateResult {
  run: RunView;
  existed: boolean;
}

export interface RunPullResult {
  moved: boolean;
  from: string;
  to: string;
  discarded: string[];
  discardedCommits: string[];
  kept: string[];
  servicesRestarted: boolean;
  servicesRestartError?: string;
}

export interface RunRemoveResult {
  slug: string;
  discarded: string[];
  discardedCommits: string[];
}

export interface RunActions {
  /** `listBranches`; `refresh` fetches from the remote first. */
  listBranches(opts: { refresh: boolean }): Promise<RunBranchList>;
  /** `runs.list`. */
  listRuns(): Promise<RunView[]>;
  /** `runs.show` — id or slug. Throws a 404-status error for an unknown run. */
  showRun(runId: string): Promise<RunDetail>;
  /** `runs.create` — null target is the remote's default branch. Narrated. */
  createRun(input: { target: RunTarget | null; confirmDiscard: boolean }, onProgress?: ProgressEmitter): Promise<RunCreateResult>;
  /** `runs.pull`. Narrated. */
  pullRun(runId: string, input: { confirmDiscard: boolean }, onProgress?: ProgressEmitter): Promise<RunPullResult>;
  /** `runs.remove`. */
  removeRun(runId: string, input: { confirmDiscard: boolean }): Promise<RunRemoveResult>;
  /** `runs.setImageChoice`. */
  setImageChoice(runId: string, choice: 'default' | 'project'): Promise<void>;
  /** `serve.run { runId }`. Narrated. */
  runServices(runId: string, onProgress?: ProgressEmitter): Promise<void>;
  /** `serve.stop { runId }`. */
  stopServices(runId: string): Promise<{ stopped: boolean }>;
  /** `runs.stopContainer` — the environment goes, the checkout and record stay. */
  stopEnvironment(runId: string): Promise<{ stopped: boolean }>;
  /** `ensureTaskContainer { runId }` — what the web shell needs before it connects. */
  ensureContainer(runId: string, onProgress?: (detail: string) => void): Promise<EnsureContainerResult>;
  /** `servePorts { runId, includeServicesRun: true }`. */
  serveState(runId: string): Promise<RunServeView>;
}

/**
 * The structured half of a daemon refusal (`RpcError.code` / `.details`),
 * read off a thrown error without importing the daemon's error class: the
 * in-process port throws the daemon's own error object, which carries both.
 */
export interface RunRefusal {
  status: number | null;
  code: string | null;
  details: Record<string, unknown> | null;
}

export function runRefusalOf(err: unknown): RunRefusal {
  if (!err || typeof err !== 'object') return { status: null, code: null, details: null };
  const e = err as { status?: unknown; code?: unknown; details?: unknown };
  return {
    status: typeof e.status === 'number' ? e.status : null,
    code: typeof e.code === 'string' ? e.code : null,
    details: e.details && typeof e.details === 'object' ? e.details as Record<string, unknown> : null,
  };
}

/** The files and commits a `run_checkout_dirty` refusal names, as display lines. */
export function dirtyItemsOf(refusal: RunRefusal): string[] | null {
  if (refusal.code !== 'run_checkout_dirty') return null;
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const files = strings(refusal.details?.dirtyFiles);
  const commits = strings(refusal.details?.localCommits).map((c) => `commit ${c}`);
  return [...files, ...commits];
}
