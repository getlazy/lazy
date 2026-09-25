/**
 * Per-task runner stamping + cross-runner session bridging for launch points.
 *
 * A task can override the global `[runner] type` via `task.runner_type`. Every
 * launch point (start/unblock/ask/sync/resume/auto-*) resolves the runner as
 * `task.runner_type ?? config.runner.type` (via `createRunner(root, override)`),
 * then calls {@link stampSessionRunner} to record the resolved runner on the
 * session it launches (the monitoring source of truth) and — when the task
 * switched runners since the session last ran — bridge the agent's session
 * JSONL across the host↔container boundary so `claude --resume` finds it under
 * the new runner. The switch takes effect on the NEXT launch; an in-flight
 * supervisor is never killed.
 *
 * Kept separate from the runner factory so all launch sites share one
 * implementation and the bridge/stamp logic is unit-testable.
 */
import type { RunnerType } from '../config/types';
import type { Storage } from '../storage/interface';
import type { Session } from '../types';
import { loadConfig } from '../config/loader';
import { bridgeSessionForRunnerSwitch } from '../cli/commands/pair-bridge';
import { logger } from '../utils/logger';

/**
 * Bridge the agent session across a runner boundary (if one is being crossed)
 * and stamp the resolved runner onto the session. Idempotent: a no-op when the
 * session already records `resolvedType` and no boundary is crossed.
 *
 * The global `config.runner.type` is the "from" runner for legacy sessions
 * whose `runner_type` is null.
 */
export async function stampSessionRunner(
  storage: Storage,
  projectRoot: string,
  session: Session,
  worktreePath: string,
  resolvedType: RunnerType,
): Promise<void> {
  const config = await loadConfig(projectRoot);
  // The global type is only the "from" fallback for legacy sessions whose
  // runner_type is null. Guard against a partial config (only seen in tests
  // that mock loadConfig) by falling back to the resolved type — which means
  // "no boundary crossed", the safe default when the prior runner is unknown.
  const globalType = config.runner?.type ?? resolvedType;
  const fromType = session.runner_type ?? globalType;
  if (fromType !== resolvedType && session.agent_session_id) {
    const result = await bridgeSessionForRunnerSwitch(
      worktreePath,
      session.agent_session_id,
      fromType,
      resolvedType,
    );
    for (const d of result.diagnostics) logger.debug(`[runner-switch] ${d}`);
    if (!result.bridged) {
      logger.warn(
        `Runner switch ${fromType} → ${resolvedType}: could not bridge agent session ` +
          `${session.agent_session_id}; the agent may start a fresh conversation this turn.`,
      );
    }
  }
  if (session.runner_type !== resolvedType) {
    await storage.updateSessionRunnerType(session.id, resolvedType);
  }
}

/**
 * Whether a running container was launched for a different agent profile than
 * this turn needs.
 *
 * Agent env (LAZY_CODEX_API_BASE, CURSOR_API_ENDPOINT, credential placeholders,
 * …) is fixed at container creation. Reusing across an agent switch leaves the
 * new harness without its wiring — the failure on load-lazy-md-files-into-context
 * after a Claude→Codex switch was exactly `LAZY_CODEX_API_BASE is not set`.
 *
 * Returns false when the stamp is absent (legacy session never stamped): the
 * agent-switch path seeds `container_agent_id` from the previous profile so a
 * first switch after upgrade still detects the mismatch.
 */
export function mustRecreateForContainerAgent(
  session: { container_agent_id?: string | null },
  taskAgentId: string,
): boolean {
  const launchedFor = session.container_agent_id;
  if (launchedFor == null || launchedFor === '') return false;
  return launchedFor !== taskAgentId;
}

/**
 * Remove a task's run, clearing the session's stored container name FIRST.
 *
 * Order matters, and it is the whole point of this helper. A container's
 * published ports are OS-assigned at creation and read back from the runtime —
 * nothing about them is persisted — so the only durable trace that a task's
 * ports changed is `session.container_name`. The daemon's event tap hangs off
 * that write (`src/daemon/event-tap.ts`) and turns it into `ports.changed`.
 *
 * A teardown that called `runner.removeRun()` and wrote nothing was therefore
 * invisible on the feed: a subscriber went on believing the task still
 * published the mapping it last read, and if the relaunch that followed the
 * removal failed, the stale name stayed stored and NO event ever contradicted
 * it. Clearing first makes the removal observable and leaves the store honest
 * at every point in between.
 *
 * `session` is optional because a couple of teardown sites (a task with no
 * session yet) genuinely have nothing to clear; there the helper is just
 * `removeRun`. The write is skipped when no name is stored, so a relaunch loop
 * does not emit a `ports.changed` for a container that was never there.
 *
 * Clearing also drops `container_agent_id`: the stamp describes the container
 * we just removed, and the next launch must re-stamp for whoever it creates.
 */
export async function removeTaskRun(
  runner: { removeRun(runName: string): Promise<void> },
  storage: Storage,
  session: {
    id: string;
    container_name: string | null;
    container_agent_id?: string | null;
  } | null | undefined,
  containerName: string,
): Promise<void> {
  if (session?.container_name) {
    await storage.updateSessionContainerName(session.id, null);
    // Keep the caller's copy consistent with the store: several launch paths
    // read `sess.container_name` again after this point.
    session.container_name = null;
    session.container_agent_id = null;
  }
  await runner.removeRun(containerName);
}
