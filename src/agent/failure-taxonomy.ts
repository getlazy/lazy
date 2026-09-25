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
 * True when the haystack carries a shell's own "command not found" for `binary`.
 * Anchored to a full line so quoted output from inside the agent's turn cannot
 * trip it — only a line that IS the shell diagnostic counts.
 */
function agentBinaryCommandNotFoundLine(text: string, binary: string): boolean {
  const escaped = binary.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:.*: )?${escaped}: command not found$`, 'm').test(text);
}

/**
 * True when a bare `404` in the haystack is evidence about the MODEL API
 * rather than a number the agent happened to print.
 *
 * The structured spellings (`not_found_error`, `model_not_found`) say what they
 * are and need nothing else. The bare number does not: an agent quoting its own
 * work — a curl against a service, a failing test that asserts a status, a stack
 * trace from the worktree — puts 404 in the same text, and reading that as
 * "your model does not exist" stops a task with a confident, wrong reason.
 *
 * Same defence, and the same reason, as {@link agentBinaryCommandNotFoundLine}:
 * this file already learned that a bare substring is not evidence when agents
 * quote their own output. So the number must sit next to something that only a
 * model-API failure produces — an `API Error`/`HTTP` prefix, or a JSON error
 * envelope — within the same line, which is how the real samples read:
 *
 *   API Error: 404 {"type":"error","error":{"type":"not_found_error",…}}
 *   http 404 from https://api.anthropic.com/v1/messages
 *
 * Anything else keeps falling through to `unknown`, which retries — the
 * direction the tiebreak above says ambiguity must resolve.
 */
function bareModelApi404(text: string): boolean {
  return text
    .split('\n')
    .some((line) => /\b404\b/.test(line) && /(api error|api_error|\bhttp\b|\{\s*"|"error"|"type"\s*:)/.test(line));
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
export function classifyCommonFailureSignals(
  input: AgentFailureInput,
  agentBinaries: readonly string[],
): AgentFailure | null {
  const text = failureHaystack(input);

  // 127 = command not found. No amount of retrying installs the binary.
  if (input.exitCode === 127) {
    return { class: 'fatal_config', reason: 'agent binary not found (exit 127)' };
  }

  // The spawn wrapper's ENOENT diagnosis (src/utils/spawn.ts): the binary is
  // not installed in this environment. Retrying can never install it — this
  // crash-looped a real cursor task for a full session before it was
  // classified (cursor-first-class-agent, item 1).
  //
  // A bare "command not found" substring is deliberately NOT matched: agents
  // often quote shell output from the worktree, and that must not stop retries.
  // Only an anchored line naming one of this agent's binaries counts.
  if (
    /spawn failed: binary '[^']+' not found/.test(text) ||
    agentBinaries.some((binary) => agentBinaryCommandNotFoundLine(text, binary))
  ) {
    return { class: 'fatal_config', reason: 'agent binary not installed in this environment' };
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
    text.includes('credit balance is too low') ||
    // Anthropic's spent-balance wording, observed on a real turn (pi, 2026-09-13):
    // `400 invalid_request_error … "You're out of extra usage. Add more at
    // claude.ai/settings/usage"`. A human-actionable WALL with no healing
    // evidence — it is a purchase, not a window that reopens — so it is
    // fatal_auth (the taxonomy's "exhausted credential — billing"), not the
    // transient_overload that "usage limit reached" earns for the 5-hour
    // window below. It was classified `unknown` and retried until the
    // crash-loop backstop, on a 400 no attempt could ever change.
    text.includes('out of extra usage')
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
      reason:
        'nothing answered at the model endpoint — if lazy was just upgraded or the daemon ' +
        'restarted, lazy retries with a fresh proxy address (not a firewall block)',
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

  // A 404 from a model API means the MODEL does not exist on the upstream this
  // task's agent profile routes to — never a capacity or connectivity problem,
  // and never something a retry heals. It is a real, seen failure: a pi task
  // whose profile pinned no endpoint (so its traffic goes to Anthropic) ran an
  // Ollama model name, and Anthropic answered 404 to every attempt while lazy
  // classified it `unknown` and retried into the crash-loop backstop. The
  // reason names the two halves a human has to reconcile — the model and the
  // upstream the profile chose — because the model alone reads like a typo.
  //
  // LAST of the shared signals, deliberately. The taxonomy's standing tiebreak
  // (see src/agent/cursor.ts) is that ambiguity resolves toward "keep trying":
  // a wrong fatal blocks a task that would have recovered, a wrong transient
  // only costs the retry ladder. So any auth, overload or connectivity evidence
  // in the same text wins, and the BARE numeric form additionally has to sit
  // next to model-API evidence — see {@link bareModelApi404}.
  if (
    text.includes('not_found_error') ||
    text.includes('model_not_found') ||
    text.includes('model not found') ||
    bareModelApi404(text)
  ) {
    return {
      class: 'fatal_config',
      reason:
        'the model this task runs does not exist on the upstream it was sent to (404) — ' +
        'check the task\'s model against the endpoint of its agent profile (a profile with no ' +
        '`endpoint` runs Anthropic, so a local Ollama or OpenAI model name will 404 there)',
    };
  }

  return null;
}
