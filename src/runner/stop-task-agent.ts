/** Stop a turn without taking the task's shared environment away. */
import type { Runner } from './types';
import { containerProtocolDir } from '../capture/claude';
import { logger } from '../utils/logger';

export async function stopTaskAgent(runner: Runner, runName: string, protocolDir: string): Promise<void> {
  if (!runner.usesSandbox()) {
    // A dead supervisor can leave its agent alive. Both operations resolve
    // that orphan from the run record; isRunning only probes the supervisor.
    await runner.stopRun(runName);
    try {
      await runner.removeRun(runName);
    } catch (err) {
      // The stop already ran; record cleanup is best-effort, as before.
      logger.warn(`Could not remove stopped agent run ${runName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (!await runner.isRunning(runName)) return;
  const dir = containerProtocolDir(protocolDir);
  // Signal the supervisor and its direct children (the harness or current
  // hook), never their descendants: a service started by the agent is valuable
  // too. Never fall back to killing the whole environment.
  // Old wrappers have no pid file: refuse safely; an explicit environment
  // replacement upgrades them without pretending their services survived.
  const code = await runner.execInRun(runName, ['sh', '-c', STOP_TASK_AGENT_SCRIPT, 'stop-task-agent', dir], { timeoutMs: 45_000 });
  if (code !== 0) {
    throw new Error(`Could not stop the agent in ${runName} (exit ${code}). The environment was left intact; explicitly replace it to upgrade an older environment.`);
  }
}

export const STOP_TASK_AGENT_SCRIPT = `
    dir=$1
    supervisor=$(cat "$dir/supervisor.pid") || exit 2
    case "$supervisor" in ''|*[!0-9]*) exit 2;; esac
    [ "$supervisor" -gt 1 ] || exit 2
    request="$dir/agent-stop-request"
    ack="$dir/agent-stop-ack"
    token=$$
    printf '%s\\n' "$token" > "$request" || exit 2
    trap 'rm -f "$request"' EXIT
    # A PID change may be a new supervisor consuming this same queued turn.
    # Stop each invocation until the wrapper acknowledges an idle boundary and
    # holds it. The lifecycle lock excludes a later turn while we cancel this one.
    signalled=""
    attempts=0
    while [ "$(cat "$ack" 2>/dev/null)" != "$token" ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 35 ] || exit 3
      supervisor=$(cat "$dir/supervisor.pid") || exit 2
      case "$supervisor" in ''|*[!0-9]*) exit 2;; esac
      [ "$supervisor" -gt 1 ] || exit 2
      if [ "$supervisor" != "$signalled" ]; then
        pids="$(ps -eo pid=,ppid= | awk -v p="$supervisor" '$2 == p {print $1}') $supervisor"
        kill -TERM $pids 2>/dev/null || true
        sleep 1
        for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
        signalled=$supervisor
      else
        sleep 1
      fi
    done
    # No supervisor can read the mailbox until the EXIT trap releases the hold.
    rm -f "$dir/command.json" || exit 2
  `;
