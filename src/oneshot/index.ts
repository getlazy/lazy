/**
 * The one entry point for machine one-shots: daemon → Runner → runner infra.
 *
 * Every caller — the accept-time fidelity summarizer inside the daemon, and
 * `lazy report`, memory compaction and `lazy ask <session-id>` (the stored
 * CONVERSATION branch) from the CLI — calls {@link runOneshot} and nothing else.
 * Nobody spawns `claude` themselves any more.
 *
 * `lazy ask <task>` is NOT here and is not a one-shot: it resumes that task's
 * agent session read-only, on the task's own agent/model/effort. Only the
 * conversation branch of the same verb reaches this module.
 *
 * WHY THE DAEMON, EVEN FOR A CLI COMMAND
 * --------------------------------------
 * Isolation and credentials both live there. The daemon holds the credential
 * (in a daemon-only-env deployment the invoking shell legitimately has none) and
 * runs the audit/policy proxy that one-shot traffic must go through to be
 * audited, billed and counted. A CLI-side spawn had neither: `lazy ask` and
 * `lazy report` authenticated off whatever happened to be in the user's
 * environment, which is exactly why they failed in some environments and not
 * others. Routing through the daemon fixes that by construction rather than by
 * teaching three call sites to find a credential.
 *
 * The honest consequence: these commands now need a daemon. That is not a new
 * dependency in practice — the CLI dispatcher auto-starts one for every command
 * outside SKIP_AUTO_START, and none of these are in it — but if the daemon
 * cannot start, the command fails instead of quietly running unaudited.
 *
 * This verb is deliberately CLI-only and NOT exposed over MCP: "run a model with
 * this arbitrary prompt" is an ungated primitive with no task attached, and the
 * MCP surface is deliberately narrower than the CLI (docs/surface-asymmetries.md).
 *
 * See docs/oneshot-execution.md.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Actor, AgentResponse } from '../types';
import type { OneshotRequest } from './types';
import { tryRpc, isDaemonRpcBypassed, DaemonNotRunningError } from '../daemon/client';
import { findLazyRoot } from '../project-paths';

export type { OneshotRequest, OneshotRepoAccess } from './types';

/**
 * One admitted one-shot COMMAND: calls made inside {@link OneshotCommand.run}
 * carry the daemon's allowance.
 */
export interface OneshotCommand {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const commandScope = new AsyncLocalStorage<{ allowance: string | null }>();

/**
 * Admit one command of many one-shot calls through the daemon's usage pause
 * ([usage_pause]) — `lazy report`, `lazy ask` on a stored conversation, the
 * `lazy_conversation_ask` tool.
 *
 * Judged per call, a person's one-shot override let the first call through
 * and was gone, and the next call was refused mid-command. So the command is
 * judged ONCE, here, and every call made inside `run` carries the allowance
 * the daemon returned, which skips its per-call gate
 * (src/daemon/usage-pause.ts, `admitOneshotCommand`). Call it before
 * collecting input a refusal would waste; it throws the daemon's refusal (a
 * 429 naming the paused credential).
 *
 * Scoped with AsyncLocalStorage rather than held per process, because the MCP
 * server is long-lived: one tool call is one command there. `actor` is the
 * channel asking — only a person's command may use their override, and a
 * command that names none is judged as nobody's (it never gets it).
 *
 * INVARIANT: running INSIDE the daemon is not a way around the gate. The MCP
 * route the daemon serves runs `lazy_conversation_ask` in the daemon's own
 * process, where the RPC path is bypassed (the daemon never calls itself) and
 * the one-shot runs its Runner directly — so admission there calls the daemon's
 * own gate in-process instead of skipping it. Only the in-process TEST harness
 * (`LAZY_TEST=1`, no daemon at all) skips it.
 */
export async function admitOneshotCommand(opts: { actor?: Actor } = {}): Promise<OneshotCommand> {
  if (process.env.LAZY_IS_DAEMON === '1' && process.env.LAZY_TEST !== '1') {
    const { getDaemonProjectRoot } = await import('../daemon/rpc-handlers');
    const root = getDaemonProjectRoot() ?? findLazyRoot();
    if (!root) throw new Error('Cannot judge a one-shot against the usage pause: no lazy project root found.');
    const { admitOneshotCommand: admitInDaemon } = await import('../daemon/usage-pause');
    // Judged and admitted here; the in-daemon calls that follow run the Runner
    // directly and never reach the per-call gate, so no allowance is carried.
    await admitInDaemon(root, opts.actor);
    return { run: (fn) => fn() };
  }
  if (isDaemonRpcBypassed()) return { run: (fn) => fn() };
  const state = await tryRpc<{ oneshotAllowance?: string }>('usagePause', {
    action: 'admitOneshot',
    ...(opts.actor ? { actor: opts.actor } : {}),
  });
  const allowance = state?.oneshotAllowance ?? null;
  return { run: (fn) => commandScope.run({ allowance }, fn) };
}

/**
 * Run a one-shot and return the agent's response.
 *
 * In the daemon (or when the RPC path is bypassed by design — see
 * `isDaemonRpcBypassed`), this runs the project's Runner directly. Everywhere
 * else it goes over RPC so the run happens inside the daemon, with the daemon's
 * credential and proxy.
 */
export async function runOneshot(req: OneshotRequest, projectRoot?: string): Promise<AgentResponse> {
  const root = projectRoot ?? findLazyRoot() ?? undefined;

  if (isDaemonRpcBypassed()) {
    // Either we ARE the daemon (it must never RPC itself) or the harness has
    // bypassed the daemon deliberately. Both mean: run the Runner here.
    return runOneshotWithRunner(req, root);
  }

  let result: AgentResponse | null;
  try {
    const usagePauseAllowance = commandScope.getStore()?.allowance;
    result = await tryRpc<AgentResponse>('runOneshot', {
      ...(usagePauseAllowance ? { usagePauseAllowance } : {}),
      prompt: req.prompt,
      model: req.model,
      effort: req.effort,
      repoAccess: req.repoAccess,
      timeoutMs: req.timeoutMs,
      taskId: req.taskId,
    });
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      // Say WHY a command that used to need nothing now needs a daemon —
      // "Daemon is not running" alone reads like a regression here.
      throw new Error(
        `${err.message}\n` +
        'This command runs a model through the daemon, which holds the credential\n' +
        'and the audit proxy — it no longer authenticates off your shell environment.\n',
      );
    }
    throw err;
  }
  if (!result) {
    // tryRpc only returns null when it bypassed the daemon, and the bypass was
    // already handled above. Reaching here means the two disagree — say so
    // rather than returning an empty response that reads like an answer.
    throw new Error('One-shot RPC returned no result and the daemon was not bypassed');
  }
  return result;
}

/**
 * Run a one-shot through this process's Runner. The daemon's RPC handler and the
 * bypass path above are the only callers — everything else goes through
 * {@link runOneshot}.
 */
export async function runOneshotWithRunner(
  req: OneshotRequest,
  projectRoot?: string,
): Promise<AgentResponse> {
  const root = projectRoot ?? findLazyRoot();
  if (!root) {
    throw new Error('Cannot run a one-shot: not in a lazy project. Run `lazy init` first.');
  }
  // Imported lazily: the runner graph pulls in the whole capture/container
  // stack, and the CLI-side callers of runOneshot never touch it.
  const { createOneshotRunner } = await import('./container-runner');
  const runner = await createOneshotRunner(root);
  return runner.runOneshot(req);
}
