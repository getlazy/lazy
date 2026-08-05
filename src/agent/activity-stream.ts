/**
 * Agent activity streams — the supervisor's view of what an agent is doing
 * *while* it runs, rather than only at exit.
 *
 * Motivation: `claude -p --output-format json` writes a single JSON blob when
 * the process exits and NOTHING before then. With no incremental signal, the
 * supervisor could not tell "thinking hard for 40 minutes" from "wedged", so
 * turn-end had to be guessed from a side channel (a marker file written by
 * `lazy_commit`). That guess was wrong — agents commit mid-turn, and the final
 * summary is produced *after* every tool call — so the marker's grace timer
 * routinely killed healthy turns mid-summary.
 *
 * An activity stream replaces the guess with an observation. An agent that
 * emits one lets the supervisor answer two questions directly:
 *
 *   1. "Is it still making forward progress?"  → liveness, from event arrival
 *   2. "Has the final summary been produced?"  → `result`, from the stream
 *
 * Agents that cannot emit one return `null` from `Agent.activityStream()` and
 * fall back to byte-level output watchdogging (see `supervisor/watchdog.ts`).
 *
 * ---------------------------------------------------------------------------
 * Empirically observed (Claude Code 2.1.220, `--output-format stream-json
 * --verbose`), because the distinction below is NOT guessable:
 *
 *   - A 25s `Bash` call emits its `tool_use`, then **22 seconds of complete
 *     silence**, then the `tool_result`. Long tool calls look exactly like a
 *     dead process to a byte-level watchdog.
 *   - A **wedged MCP call is not silent**: Claude Code emits a
 *     `{"type":"tool_progress", "heartbeat":true, ...}` line every 30s, forever,
 *     for an MCP call that never returns.
 *
 * The second point is why `heartbeat` is its own kind and NOT progress. If
 * heartbeats reset the liveness timer, a permanently wedged MCP tool call would
 * be immortal — strictly worse than the pre-stream behavior it replaces. A
 * heartbeat proves the *process* is alive; only a `progress` event proves the
 * *turn* is advancing.
 */

/**
 * What one line of an agent's stream tells the supervisor.
 *
 * `progress` is the load-bearing kind: it, and only it, means "the turn moved
 * forward", and only it resets the liveness timer.
 */
export type AgentActivityKind =
  /** Session established. Carries `sessionId` — available from the first line. */
  | 'session_start'
  /** Forward progress with nothing else to record. */
  | 'progress'
  /** Forward progress, and a tool call is now in flight. Carries `toolUseId`. */
  | 'tool_start'
  /** Forward progress, and a tool call finished. Carries `toolUseId`. */
  | 'tool_end'
  /**
   * The process is alive but nothing has advanced (periodic keep-alive).
   * Deliberately NOT progress — see the module note above.
   */
  | 'heartbeat'
  /**
   * The agent's final result — its summary — has been emitted. Everything after
   * this is the CLI winding itself down, so from here a bounded kill is safe.
   */
  | 'result';

export interface AgentActivityEvent {
  kind: AgentActivityKind;
  /** Present on `session_start` (and on `result`, which repeats it). */
  sessionId?: string;
  /** Present on `tool_start` / `tool_end` / `heartbeat`. */
  toolUseId?: string;
  /** Human-readable tool name, for diagnostics ("MCP tool `x` in flight"). */
  toolName?: string;
  /**
   * Present on `result`: the raw line, retained verbatim so the supervisor can
   * hand it to `Agent.parseResponse()` even if the surrounding stream was
   * dropped to bound memory.
   */
  raw?: string;
}

/**
 * A line-oriented parser for one agent's stdout stream.
 *
 * `parseLine` receives one complete line with no trailing newline. Returning
 * `null` means "nothing meaningful here" — the line is neither progress nor
 * liveness. Implementations MUST NOT throw: a malformed line is normal (the
 * stream can be truncated by a kill) and must never take a turn down.
 */
export interface AgentActivityStream {
  parseLine(line: string): AgentActivityEvent | null;
}

/**
 * Parser for Claude Code's `--output-format stream-json --verbose` output.
 *
 * One JSON object per line. The shapes that matter:
 *
 *   {"type":"system","subtype":"init","session_id":"..."}          → session_start
 *   {"type":"assistant","message":{"content":[{"type":"tool_use",  → tool_start
 *                                              "id":"toolu_…"}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",    → tool_end
 *                                         "tool_use_id":"toolu_…"}]}}
 *   {"type":"tool_progress","heartbeat":true,…}                    → heartbeat
 *   {"type":"result","result":"…","session_id":"…","usage":{…}}    → result
 *
 * Unknown `type` values are treated as progress rather than ignored: a new
 * event kind from a future Claude Code release is still evidence the turn is
 * advancing, and mistaking real progress for silence is the expensive error.
 */
export class ClaudeCodeActivityStream implements AgentActivityStream {
  parseLine(line: string): AgentActivityEvent | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A partial or non-JSON line. Normal at the tail of a killed process and
      // when the CLI prints something unstructured — not an error condition,
      // and deliberately not progress (we cannot tell what it was).
      return null;
    }

    const type = typeof msg.type === 'string' ? msg.type : '';

    if (type === 'result') {
      return {
        kind: 'result',
        sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined,
        raw: trimmed,
      };
    }

    if (type === 'tool_progress') {
      // Periodic keep-alive for a long-running (or wedged) tool call.
      return {
        kind: 'heartbeat',
        toolUseId: typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined,
        toolName: typeof msg.tool_name === 'string' ? msg.tool_name : undefined,
      };
    }

    if (type === 'system') {
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        return { kind: 'session_start', sessionId: msg.session_id };
      }
      return { kind: 'progress' };
    }

    if (type === 'assistant' || type === 'user') {
      const blocks = contentBlocks(msg.message);
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          return { kind: 'tool_start', toolUseId: block.id, toolName: typeof block.name === 'string' ? block.name : undefined };
        }
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          return { kind: 'tool_end', toolUseId: block.tool_use_id };
        }
      }
      return { kind: 'progress' };
    }

    return { kind: 'progress' };
  }
}

/** Extract the content blocks of an Anthropic-shaped message, defensively. */
function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}
