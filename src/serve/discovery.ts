/**
 * Discovery for `[serve]` ports: what a task's environment publishes RIGHT NOW.
 *
 * Everything here reads the runtime rather than lazy's config, because that is
 * where the truth is: host ports are OS-assigned, and a container created before
 * a `[serve]` edit still publishes what it was created with. Reporting the
 * config as if it were the state is exactly how a user ends up staring at a
 * `lazy url` that does not answer.
 */

import { createRunner } from '../runner';
import { loadConfig } from '../config/loader';
import { resolveServices, type ResolvedService, type ServicePort } from './ports';
import { withPublicUrls } from './subdomain';
import type { Session, Task } from '../types';
import { taskRef } from '../task/identity';
import type { Runner } from '../runner';
import type { RunnerType } from '../config/types';
import type { CommitRun } from '../storage/types';
import { runContainerName } from '../run/identity';

/** Why a task's services could not be resolved, when they could not. */
export type ServeUnavailableReason =
  /** This runner has no container, so there is nothing to publish through. */
  | 'no-container-runner'
  /** The task's container is not running. */
  | 'not-running';

export interface TaskServeState {
  /** Declared services from the project's `[serve]` config, in declaration order. */
  declared: ServicePort[];
  /** Declared services joined with the live bindings — empty when unavailable. */
  services: ResolvedService[];
  /** Set when the live mapping could not be read; `services` is then empty. */
  unavailable: ServeUnavailableReason | null;
  containerName: string;
  runnerType: string;
  /** Whether the task's container was seen running (false when not asked). */
  containerRunning?: boolean;
}

/**
 * Resolve a task's declared `[serve]` services against its live port bindings.
 *
 * Config is read from the PROJECT ROOT, like every other lazy.toml read: a task
 * worktree's copy has no authority (see findConfigDir in src/config/loader.ts).
 * This used to read the worktree so a task that added a port saw its own value —
 * which was also inconsistent with reality, since the container's published
 * ports are decided by the root's `[serve]` at launch (`launchSupervisorAsync`).
 * A task that adds a port therefore sees it once the change is on the root, and
 * the ports listed here are the ports actually published.
 *
 * Each resolved service is decorated with its `publicUrl` here — the ONE place,
 * so every surface downstream (the CLI, the Services card, the `servePorts` RPC,
 * `lazy show`) gets the subdomain URL without any of them composing hostnames.
 */
export async function getTaskServeState(
  root: string,
  task: Task,
  session: Session | null,
  opts: { alwaysProbe?: boolean } = {},
): Promise<TaskServeState> {
  return serveStateFor(root, {
    host: task,
    runnerType: session?.runner_type ?? task.runner_type ?? undefined,
    containerName: (runner) => session?.container_name ?? runner.runNameForTask(taskRef(task)),
  }, opts);
}

/**
 * The same state for a COMMIT RUN (src/daemon/commit-run.ts): its container,
 * on the project's runner, addressed by its slug.
 */
export async function getRunServeState(
  root: string,
  run: CommitRun,
  opts: { alwaysProbe?: boolean } = {},
): Promise<TaskServeState> {
  return serveStateFor(root, {
    host: { id: run.id, code: run.slug },
    runnerType: undefined,
    containerName: () => runContainerName(root, run.slug),
  }, opts);
}

/**
 * What a service host — a task, or a commit run — publishes right now. The
 * ONE resolution both share: the root config's declared services, the
 * container's live bindings, the public URL named by the host's label.
 */
async function serveStateFor(
  root: string,
  subject: {
    /** Named in hostnames by {@link withPublicUrls}' label rule (code, else short id). */
    host: { id: string; code?: string | null };
    runnerType: RunnerType | undefined;
    containerName: (runner: Runner) => string;
  },
  opts: { alwaysProbe?: boolean },
): Promise<TaskServeState> {
  const config = await loadConfig(root);
  const declared = config.serve.services;

  // Nothing declared means nothing to look up — and every caller that renders
  // this opportunistically (`lazy show`) then pays no runtime call at all.
  // `alwaysProbe` is for the Services surfaces, which show the container's
  // state (and what Start services is doing in it) whether or not any port
  // is declared: Start services needs no declaration.
  if (declared.length === 0 && !opts.alwaysProbe) {
    return { declared, services: [], unavailable: null, containerName: '', runnerType: '', containerRunning: false };
  }

  const runner = await createRunner(root, subject.runnerType);
  const containerName = subject.containerName(runner);

  const base = { declared, containerName, runnerType: runner.type };

  if (!runner.usesSandbox()) {
    return { ...base, services: [], unavailable: 'no-container-runner', containerRunning: false };
  }
  if (!(await runner.isRunning(containerName))) {
    return { ...base, services: [], unavailable: 'not-running', containerRunning: false };
  }
  if (declared.length === 0) {
    return { ...base, services: [], unavailable: null, containerRunning: true };
  }

  const bindings = (await runner.getRunPortBindings(containerName)) ?? [];
  const services = withPublicUrls(subject.host, resolveServices(declared, bindings));
  return { ...base, services, unavailable: null, containerRunning: true };
}

/**
 * The root lazy.toml's `[serve] start_services_cmd` — the one-time IMPORT source
 * for the project's Start services command, which lives in the store. Callers
 * wanting the command itself use `resolveProjectStartServicesCmd`
 * (src/serve/start-cmd.ts), which prefers the store.
 *
 * Read from the PROJECT ROOT's lazy.toml, like every config read: a task
 * worktree's lazy.toml is agent-writable, so honouring it would let a task's own
 * branch decide what a human's button runs on the daemon's behalf.
 *
 * Returns '' when the key is unset. Never throws: an unreadable root config is
 * one missing button, not a failed page render.
 */
export async function getStartServicesCmd(root: string): Promise<string> {
  try {
    const config = await loadConfig(root);
    return config.serve.start_services_cmd;
  } catch {
    // A root config that will not parse is already loud everywhere that
    // matters (every command loads it); the dashboard just shows no button.
    return '';
  }
}
