/**
 * Agent failure taxonomy — the shared vocabulary the supervisor uses to decide
 * whether a failed agent launch is worth retrying.
 *
 * WHY THIS EXISTS: the supervisor used to retry every failure identically —
 * 30s, 60s, 120s, 240s, 300s — with no idea what went wrong. A permanently
 * dead condition (no usable credential, so every launch fails with
 * `API Error: Unable to connect to API (ConnectionRefused)`) burned attempts
 * forever at 2-per-5-minutes, while a genuine 429 was ALSO retried at that
 * uselessly slow cadence. The supervisor must know WHY the agent failed.
 *
 * WHERE THE KNOWLEDGE LIVES: each agent maps its own raw stderr/stdout/exit
 * code to a class here (`Agent.classifyFailure`). The supervisor consumes the
 * class only — there is deliberately NO error-string matching in supervisor
 * code, so adding an agent never means teaching the supervisor its dialect.
 */

/**
 * The classes the supervisor understands.
 *
 * `fatal_*`   — cannot heal without a human. Stop immediately.
 * `transient_*` — can heal on its own. Retry (see src/supervisor/retry-policy.ts).
 * `unknown`   — unclassifiable. Retried conservatively; the crash-loop
 *               detector remains the backstop for fast crash loops.
 */
export type AgentFailureClass =
  /** Missing/invalid/exhausted credential — 401, 403, invalid API key, billing. */
  | 'fatal_auth'
  /** Bad invocation or environment — unknown model, unknown flag, missing binary. */
  | 'fatal_config'
  /** Capacity/rate limiting — 429, 529, 503, "overloaded", "rate limit". */
  | 'transient_overload'
  /** In-flight connectivity failure — ECONNRESET, ETIMEDOUT, socket hang up, 5xx. */
  | 'transient_network'
  /**
   * Nothing is listening / the endpoint cannot be resolved — ECONNREFUSED,
   * ENOTFOUND. Distinct from `transient_network` on purpose: it heals if (and
   * only if) whatever should be listening comes back. See the bounded policy in
   * src/supervisor/retry-policy.ts — bounded retries, then escalation to fatal,
   * so we never spin forever on an endpoint that is simply never coming up.
   */
  | 'transient_unreachable'
  /** Nothing matched. */
  | 'unknown';

/** Raw material an agent gets to classify a failed launch. */
export interface AgentFailureInput {
  /** Error message as surfaced to the supervisor (usually the CrashError message). */
  message: string;
  /** Process exit code, when the failure came from a crashed launch. */
  exitCode?: number;
  /** Tail of stderr, when captured. */
  stderr?: string;
  /** Error text extracted from stdout JSON, when the agent puts errors there. */
  stdoutError?: string;
}

export interface AgentFailure {
  class: AgentFailureClass;
  /** Short human-readable reason, agent-authored, shown to the human verbatim. */
  reason: string;
}

/** True when the class can never heal on its own. */
export function isFatalFailureClass(cls: AgentFailureClass): boolean {
  return cls === 'fatal_auth' || cls === 'fatal_config';
}

/** Join every field of the input into one lowercase haystack for matching. */
export function failureHaystack(input: AgentFailureInput): string {
  return [input.message, input.stderr, input.stdoutError]
    .filter((s): s is string => !!s)
    .join('\n')
    .toLowerCase();
}

/**
 * Signals shared by every HTTP/LLM-backed CLI agent (Anthropic, Cursor, …).
 * An agent calls this AFTER trying its own agent-specific patterns, so agent
 * dialect always wins over the generic fallback.
 *
 * Returns null when nothing matches — the caller decides what `unknown` means.
 *
 * Ordering matters: auth before overload (a 403 body can mention "limit"),
 * unreachable before network (ECONNREFUSED is also a connection failure).
 */
export function classifyCommonFailureSignals(input: AgentFailureInput): AgentFailure | null {
  const text = failureHaystack(input);

  // 127 = command not found. No amount of retrying installs the binary.
  if (input.exitCode === 127) {
    return { class: 'fatal_config', reason: 'agent binary not found (exit 127)' };
  }

  if (
    /\b401\b|\b403\b/.test(text) ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('authentication_error') ||
    text.includes('authentication error') ||
    text.includes('invalid api key') ||
    text.includes('invalid_api_key') ||
    text.includes('invalid bearer token') ||
    text.includes('oauth token has expired') ||
    text.includes('please run /login') ||
    text.includes('credit balance is too low')
  ) {
    return { class: 'fatal_auth', reason: 'agent rejected the credential (auth/billing)' };
  }

  if (
    /\b429\b|\b529\b|\b503\b/.test(text) ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('overloaded') ||
    text.includes('service unavailable') ||
    text.includes('usage limit reached') ||
    text.includes('capacity')
  ) {
    return { class: 'transient_overload', reason: 'model provider is rate limiting or overloaded' };
  }

  if (
    text.includes('econnrefused') ||
    text.includes('connectionrefused') ||
    text.includes('connection refused') ||
    text.includes('enotfound') ||
    text.includes('getaddrinfo')
  ) {
    return {
      class: 'transient_unreachable',
      reason: 'nothing answered at the model endpoint (refused/unresolvable)',
    };
  }

  if (
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('epipe') ||
    text.includes('eai_again') ||
    text.includes('socket hang up') ||
    text.includes('network error') ||
    text.includes('fetch failed') ||
    /\b500\b|\b502\b|\b504\b/.test(text) ||
    text.includes('timeout') ||
    text.includes('timed out')
  ) {
    return { class: 'transient_network', reason: 'network failure talking to the model provider' };
  }

  return null;
}
