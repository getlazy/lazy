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
