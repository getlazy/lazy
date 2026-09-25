/**
 * The bounded spawn every one-shot goes through, shared by both runners.
 *
 * The isolation differs per runner (a container with no repo mount vs a host
 * process standing outside every git tree), but what happens around the spawn
 * does not: arm a kill timer, escalate SIGTERM to SIGKILL, report a timeout AS a
 * timeout rather than as an anonymous non-zero exit, and parse one JSON answer.
 * That was duplicated once already and drifted; it lives here now.
 *
 * See docs/oneshot-execution.md.
 */

import { spawn } from '../utils/spawn';
import type { AgentResponse } from '../types';
import { ONESHOT_KILL_GRACE_MS, oneshotTimeoutError } from './args';

export interface BoundedOneshotOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Already resolved by resolveOneshotTimeoutMs. 0 means unbounded. */
  timeoutMs: number;
  /**
   * Agent whose `parseResponse` normalizes stdout — a HARNESS, since the
   * dialect belongs to the binary, not to the profile that selected it. Cursor's
   * success JSON uses alias keys (`text`, `chatId`, …) that raw `JSON.parse`
   * would miss.
   */
  harness?: string;
  /**
   * Runner-specific cleanup to run when the timeout fires, alongside killing the
   * spawned process. The Docker runner needs it: killing the `docker run` CLIENT
   * does not necessarily reap the CONTAINER, so a timed-out one-shot would leave
   * the container running with nothing watching it.
   */
  onTimeout?: () => void | Promise<void>;
  /** What to call the thing in error messages (e.g. 'Claude Code', 'docker run'). */
  label?: string;
}

export async function execBoundedOneshot(
  argv: string[],
  opts: BoundedOneshotOptions,
): Promise<AgentResponse> {
  const label = opts.label ?? 'Claude Code';

  const proc = spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
    // The kill timer is armed below rather than handed to spawn()'s own
    // `timeout` so a timeout is reported as one, instead of as the anonymous
    // non-zero exit a killed process produces.
    timeout: 0,
  });

  const { timeoutMs } = opts;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // Already exited between the timer firing and this kill — nothing to do.
        }
        // Runner-specific reaping (see onTimeout). Fire-and-forget: the run is
        // already being torn down and there is nobody left to await it.
        void (async () => {
          try {
            await opts.onTimeout?.();
          } catch {
            // Best-effort cleanup of a run that is already failing; the timeout
            // error below is what the caller needs to see, not this.
          }
        })();
        // SIGTERM is a request. A one-shot that ignores it is exactly the wedged
        // process this timeout exists for, and leaving it running would strand a
        // process holding this run's pipes open — so escalate, the same way the
        // supervisor watchdog does.
        killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Exited during the grace period — the escalation was unnecessary.
          }
        }, ONESHOT_KILL_GRACE_MS);
      }, timeoutMs)
    : undefined;

  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);

  if (timedOut) throw oneshotTimeoutError(timeoutMs);

  if (exitCode !== 0) {
    const tail = stderr.trim().split('\n').slice(-20).join('\n  ');
    throw new Error(`${label} exited with code ${exitCode}${tail ? `\n\nLast output:\n  ${tail}` : ''}`);
  }

  // Route through the configured agent's parser — the same path supervised turns
  // use — so alias-tolerant dialects (Cursor's `text`/`chatId` keys) normalize
  // to `{ result, session_id }` instead of coming back empty.
  const { getAgent } = await import('../agent/registry');
  const agent = getAgent(opts.harness ?? 'claude-code');
  try {
    return agent.parseResponse(output);
  } catch (err) {
    // A one-shot that answered with something other than JSON is a real failure
    // mode (a container that printed a runtime warning before the agent ran, a
    // wrapper that emitted its own diagnostics). Say what came back instead of
    // letting a bare parse error surface with no context.
    const excerpt = output.trim().slice(0, 400);
    throw new Error(
      `${label} one-shot did not return a parseable answer: ${err instanceof Error ? err.message : String(err)}. ` +
      `Received: ${excerpt || '(no output)'}`,
    );
  }
}
