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

/** One MCP server as the agent itself reports it at session start. */
export interface AgentMcpServerStatus {
  name: string;
  /** Agent-defined; Claude Code uses `connected` / `failed` / `needs-auth`. */
  status?: string;
}

export interface AgentActivityEvent {
  kind: AgentActivityKind;
  /** Present on `session_start` (and on `result`, which repeats it). */
  sessionId?: string;
  /**
   * Present on `session_start` when the agent reports its MCP servers.
   *
   * `undefined` means the agent said nothing about MCP servers — NOT that it
   * has none. Only an empty array is evidence of "none". Agents with no
   * equivalent in their stream (Cursor) leave this undefined always.
   */
  mcpServers?: AgentMcpServerStatus[];
  /**
   * Present on `session_start` when the agent reports the tools it loaded.
   * Same `undefined` vs `[]` distinction as `mcpServers`.
   */
  toolNames?: string[];
  /**
   * Present on `session_start` when the agent reports the CONCRETE model it
   * is about to run. Claude Code and Cursor both put a `model` string on
   * their init line; the supervisor copies it onto `Turn.model_id` when
   * `parseResponse` did not already extract one (Cursor's result object
   * has no model field — the init line is the only report).
   *
   * `undefined` means the agent said nothing, not that a default ran.
   */
  model?: string;
  /** Present on `tool_start` / `tool_end` / `heartbeat`. */
  toolUseId?: string;
  /** Human-readable tool name, for diagnostics ("MCP tool `x` in flight"). */
  toolName?: string;
  /**
   * Present when the agent reports its full set of running BACKGROUND tasks
   * (background shells, background subagents, monitors). It is the whole
   * list's size, not a delta: `0` means nothing is running in the background
   * any more. `undefined` means this event says nothing about them.
   *
   * The watchdog reads it to keep the wind-down guard off a process that is
   * still doing work the agent started — see src/supervisor/watchdog.ts.
   */
  backgroundTasks?: number;
  /**
   * Present when that list changes: each running background task's id and the
   * best human label lazy has for it — the command the agent backgrounded
   * when the stream showed it, else the agent's own description.
   */
  backgroundTaskList?: BackgroundTaskRef[];
  /**
   * Present when a background task was STOPPED rather than finishing — Claude
   * Code's `task_updated` with `status: "killed"` or `task_notification` with
   * `status: "stopped"`. In `-p` mode Claude Code does this to a background
   * shell 5s after the turn's result (measured on 2.1.291).
   */
  backgroundTaskStopped?: BackgroundTaskRef;
  /**
   * Present on `result`: the raw line, retained verbatim so the supervisor can
   * hand it to `Agent.parseResponse()` even if the surrounding stream was
   * dropped to bound memory.
   */
  raw?: string;
}

/** One background task as lazy can name it to a person or an agent. */
export interface BackgroundTaskRef {
  id: string;
  label: string;
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
 *   {"type":"system","subtype":"background_tasks_changed",          → progress +
 *    "tasks":[{"task_id":"…","task_type":"local_bash",…}]}            backgroundTasks
 *
 * `background_tasks_changed` was read off Claude Code 2.1.291 running
 * `-p --output-format stream-json` (2026-10-06, docs/claude-code-background-tasks.md):
 * it carries the WHOLE list of running background tasks each time it changes,
 * and an empty `tasks` array once the last one ends. A turn with background
 * work can therefore emit a `result`, keep running, and later re-invoke the
 * model — a second `system/init`, more assistant events, a second `result`.
 *
 * Unknown `type` values are treated as progress rather than ignored: a new
 * event kind from a future Claude Code release is still evidence the turn is
 * advancing, and mistaking real progress for silence is the expensive error.
 */
export class ClaudeCodeActivityStream implements AgentActivityStream {
  /** tool_use id → the command the agent backgrounded with it. */
  private readonly backgroundCommands = new Map<string, string>();
  /** background task id → its label, learned from the events that start it. */
  private readonly taskLabels = new Map<string, string>();

  private labelFor(taskId: string, description: unknown): string {
    const known = this.taskLabels.get(taskId);
    if (known) return known;
    return typeof description === 'string' && description.trim() ? description.trim() : taskId;
  }

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
        // The init line is the only place the agent tells us what it actually
        // loaded — which MCP servers connected and which tools exist in ITS
        // process. Everything else in lazy can observe only what we *asked*
        // for. Both fields stay optional: a release that stops emitting them,
        // or an agent that never did, must read as "unknown", never as "zero".
        return {
          kind: 'session_start',
          sessionId: msg.session_id,
          mcpServers: parseMcpServers(msg.mcp_servers),
          toolNames: parseToolNames(msg.tools),
          // Same field Cursor's init carries. Claude Code's result line also
          // repeats it, and parseResponse prefers that; this is the fallback
          // and the ground truth at the moment the session actually started.
          ...(typeof msg.model === 'string' && msg.model.trim()
            ? { model: msg.model.trim() }
            : {}),
        };
      }
      if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
        const list: BackgroundTaskRef[] = [];
        for (const t of msg.tasks as unknown[]) {
          if (!t || typeof t !== 'object') continue;
          const task = t as Record<string, unknown>;
          if (typeof task.task_id !== 'string') continue;
          const label = this.labelFor(task.task_id, task.description);
          this.taskLabels.set(task.task_id, label);
          list.push({ id: task.task_id, label });
        }
        return { kind: 'progress', backgroundTasks: msg.tasks.length, backgroundTaskList: list };
      }
      if (msg.subtype === 'task_started' && typeof msg.task_id === 'string') {
        const command = typeof msg.tool_use_id === 'string' ? this.backgroundCommands.get(msg.tool_use_id) : undefined;
        if (command) this.taskLabels.set(msg.task_id, command);
        else if (typeof msg.description === 'string' && msg.description.trim()) this.taskLabels.set(msg.task_id, msg.description.trim());
        return { kind: 'progress' };
      }
      const stopped =
        (msg.subtype === 'task_updated' && (msg.patch as Record<string, unknown> | undefined)?.status === 'killed') ||
        (msg.subtype === 'task_notification' && msg.status === 'stopped');
      if (stopped && typeof msg.task_id === 'string') {
        return {
          kind: 'progress',
          backgroundTaskStopped: { id: msg.task_id, label: this.labelFor(msg.task_id, msg.summary) },
        };
      }
      return { kind: 'progress' };
    }

    if (type === 'assistant' || type === 'user') {
      const blocks = contentBlocks(msg.message);
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          const input = block.input as Record<string, unknown> | undefined;
          if (input && input.run_in_background === true) {
            const label = typeof input.command === 'string' ? input.command
              : typeof input.description === 'string' ? input.description : undefined;
            if (label?.trim()) this.backgroundCommands.set(block.id, label.trim());
          }
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

/**
 * `mcp_servers` from an init line, or `undefined` if the field is absent or not
 * an array. Entries without a string `name` are dropped rather than rejecting
 * the whole list — a partially-understood report is still better evidence than
 * none, and `parseLine` must never throw.
 */
function parseMcpServers(value: unknown): AgentMcpServerStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const servers: AgentMcpServerStatus[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.name !== 'string') continue;
    servers.push({
      name: rec.name,
      status: typeof rec.status === 'string' ? rec.status : undefined,
    });
  }
  return servers;
}

/** `tools` from an init line, or `undefined` if absent / not an array. */
function parseToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((t): t is string => typeof t === 'string');
}

/** Extract the content blocks of an Anthropic-shaped message, defensively. */
function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}
