/**
 * Argv and timeout composition for machine one-shots — pure, so the execution
 * contract is assertable without spawning anything.
 *
 * WHY THIS IS NOT IN src/capture/claude.ts (where it used to live): both
 * concrete runners now compose one-shot argv, and `capture/claude.ts` is the
 * module the e2e module-mock seam replaces WHOLESALE. Leaving the composer
 * there would mean a runner's argv came from the mock in every mocked test —
 * i.e. the one thing these helpers exist to pin would be unpinned exactly where
 * it is tested. This module is small, dependency-light, and never mocked.
 *
 * See docs/oneshot-execution.md.
 */

import { markMachineOneshotPrompt } from '../import/machine-oneshot';

/**
 * How long any machine one-shot may run before it is killed.
 *
 * Every one-shot is a single `claude -p` call — one prompt, one answer, no
 * session continuity — so ten minutes is far beyond any real run and only ever
 * fires on a genuinely stuck call (an unreachable proxy answers nothing, ever).
 * Same value, and the same reasoning, as SUMMARIZER_TIMEOUT_MS in
 * src/synthesis/summarizer.ts, which stays explicit because an accept-time bound
 * is worth stating at its call site.
 */
export const DEFAULT_ONESHOT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Grace period between the SIGTERM a timeout sends and the SIGKILL that follows
 * it. Short on purpose: by this point the run is already ten minutes past due,
 * and the only thing left to wait for is a clean exit that is not coming.
 */
export const ONESHOT_KILL_GRACE_MS = 5_000;

/**
 * Resolve the effective timeout for a run: the default unless the caller named
 * one, and 0 (unbounded) only when the caller explicitly opted out.
 *
 * Exported so the polarity — omitted means BOUNDED — is assertable without
 * spawning anything.
 */
export function resolveOneshotTimeoutMs(opts: { timeoutMs?: number } = {}): number {
  if (opts.timeoutMs === undefined) return DEFAULT_ONESHOT_TIMEOUT_MS;
  return opts.timeoutMs > 0 ? opts.timeoutMs : 0;
}

/**
 * Compose headless argv for a one-shot using the project's configured agent.
 *
 * Never `--resume`/`--continue` — those flags would make housekeeping run inside
 * somebody's existing session instead of its own. Write tools are blocked via
 * `permissionMode: 'plan'` (Claude Code uses `--disallowedTools`; Cursor uses
 * `--exclude-tools` for the write ToolCall oneofs — not `--mode plan`, which
 * rejects MCP) — the same three write surfaces as DISALLOWED_TOOLS_IN_PLAN_MODE
 * in src/agent/claude-code.ts.
 *
 * The prompt is stamped with the machine-one-shot marker here (see
 * src/import/machine-oneshot.ts) so conversation capture skips the session JSONL
 * the agent writes for it. This is the ONLY place that stamps: every caller is
 * housekeeping by construction, so marking here means no caller can forget.
 */
export function buildOneshotAgentArgv(
  /** The agent BINARY to invoke — a harness, not a profile name. */
  harness: string,
  prompt: string,
  model?: string,
  /**
   * Effort for this run, fixed by the calling one-shot's KIND. Every harness in
   * the registry expresses it in its own dialect (`--effort`, codex's
   * `model_reasoning_effort`, pi's `--thinking`, cursor's model bracket), so
   * this is handed over as-is and `buildExecArgs` decides how to spell it.
   */
  effort?: string,
): string[] {
  // Deferred: importing the registry at module load time from docker-runner.ts
  // created a circular-init edge (docker-runner → args → registry → … →
  // runner/index → podman-runner → docker-runner). Call-time import is safe.
  const { getAgent } = require('../agent/registry') as typeof import('../agent/registry');
  const agent = getAgent(harness);
  const marked = markMachineOneshotPrompt(prompt);
  const args = agent.buildExecArgs({
    prompt: marked,
    modelId: model,
    effort,
    dangerouslySkipPermissions: false,
    permissionMode: 'plan',
  });

  // One-shots are a single prompt-in / JSON-out call — no session resume.
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--resume' || args[i] === '--continue') {
      args.splice(i, args[i + 1] !== undefined ? 2 : 1);
    }
  }

  // Claude Code's supervised turns use stream-json for watchdog progress; a
  // one-shot waits for one JSON blob and `--verbose` is not required for json.
  if (harness === 'claude-code') {
    const fmtIdx = args.indexOf('--output-format');
    if (fmtIdx >= 0 && args[fmtIdx + 1] === 'stream-json') {
      args[fmtIdx + 1] = 'json';
    }
    const verboseIdx = args.indexOf('--verbose');
    if (verboseIdx >= 0) {
      args.splice(verboseIdx, 1);
    }
  }

  return args;
}

/**
 * Legacy alias defaulting to claude-code. Production one-shots use
 * {@link buildOneshotAgentArgv} with the BUILDER role target's harness.
 */
export function buildOneshotArgs(prompt: string, model?: string, effort?: string): string[] {
  return buildOneshotAgentArgv('claude-code', prompt, model, effort);
}

/** The error a timed-out one-shot throws, phrased for the human who sees it. */
export function oneshotTimeoutError(timeoutMs: number): Error {
  const human = timeoutMs >= 60_000 ? ` (${Math.round(timeoutMs / 60_000)}m)` : '';
  return new Error(
    `Claude Code one-shot timed out after ${timeoutMs}ms${human} and was killed. ` +
    `A one-shot is a single model call, so this normally means the call never answered ` +
    `(an unreachable proxy or API endpoint). Check connectivity and retry.`,
  );
}
