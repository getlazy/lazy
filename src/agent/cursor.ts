/**
 * CursorAgent — Agent implementation for Cursor CLI (`cursor-agent` binary).
 *
 * Refreshed against cursor-agent 2026.08.11 (see docs/spike-codex-cursor-revisit.md
 * and the cursor-first-class-agent task for the empirical probes).
 *
 * Key differences from Claude Code:
 * - Binary is `cursor-agent` (the installer also drops a legacy `agent` symlink)
 * - No system-prompt flag exists (verified against 2026.08.11 --help) — the
 *   system prompt is prepended to the user prompt
 * - Prompt is a positional argument (at end of command), not a flag value
 * - Plan/ask/review turns do NOT use `--mode plan`: that mode rejects MCP tool
 *   calls (every Cursor review turn said "MCP calls were rejected" / "Shell is
 *   blocked in this review mode"). Instead they pass `--exclude-tools` for the
 *   write-capable ToolCall oneofs — same shape as Claude's `--disallowedTools`.
 * - Headless workspace trust has a first-class flag: `--trust`. The sibling
 *   `--approve-mcps` is deliberately NOT used — it would auto-approve a repo's
 *   own <cwd>/.cursor/mcp.json (arbitrary-exec-by-checkout); lazy's own MCP
 *   lives in ~/.cursor/mcp.json (home) and loads without approval. See
 *   buildExecArgs for the keyless probe results.
 * - Headless turns run on `--output-format stream-json`, so the supervisor sees
 *   live progress events (CursorActivityStream) instead of one blob at exit
 * - Session/chat files live under ~/.cursor/projects/<encoded-path>/ (layout
 *   mirrors Claude's ~/.claude/projects but the file format is unverified — see
 *   discoverSessionFiles)
 * - Auth via CURSOR_API_KEY env var or `cursor-agent login` session
 */

import type { AgentResponse } from '../types';
import { CURSOR_ENDPOINT_ENV } from '../proxy/cursor-route';
import type { AgentActivityEvent, AgentActivityStream } from './activity-stream';
import type { Agent } from './interface';
import { safeArgvPrompt } from './argv-safety';
import { classifyNoModelRefusal, requireLaunchModel } from './launch-model';
import { CURSOR_INSTALL_HINT, CursorPackaging } from './cursor-packaging';
import {
  classifyCommonFailureSignals,
  failureHaystack,
  type AgentFailure,
  type AgentFailureInput,
} from './failure-taxonomy';

const LAUNCH_BINARY = new CursorPackaging().binaryName();

/**
 * Write-capable Cursor tools excluded on ask / review / other read-only turns.
 *
 * These are the proto `ToolCall` oneof field names `cursor-agent --exclude-tools`
 * accepts (verified against cursor-agent 2026.09.10's `exclude-tools.ts`, which
 * builds the allow-list from `ToolCall.fields`). Parallel to Claude Code's
 * `Bash Write Edit` denylist:
 *   - shellToolCall / writeShellStdinToolCall ≈ Bash
 *   - editToolCall / deleteToolCall ≈ Edit / Write
 *
 * Why not `--mode plan`: Cursor's native plan mode also refuses MCP tool calls
 * (and Shell). Review turns need lazy_* (reads + lazy_raise); ask turns need
 * lazy_* reads. Excluding only the write oneofs keeps MCP available — the same
 * reason Claude Code uses `--disallowedTools` instead of `--permission-mode plan`.
 *
 * `--exclude-tools` is a hidden/internal CLI flag; lazy depends on it the same
 * way it depends on other headless Cursor flags. If a future cursor-agent drops
 * the flag, buildExecArgs will still pass it and the turn will fail loudly.
 */
const EXCLUDED_TOOLS_IN_PLAN_MODE =
  'shellToolCall,editToolCall,deleteToolCall,writeShellStdinToolCall';

/**
 * Field aliases accepted when parsing the final response object.
 *
 * A live success-path turn still cannot be captured without credentials (auth
 * is checked before any turn starts). The result object's shape is known from
 * the shipped bundle's emitters (docs/cursor-stream-json.md) — `result` is what
 * it writes — but the aliases stay: the parser accepts the plausible spellings
 * and fails with a diagnostic listing the keys it actually saw, so a version
 * that renames one is a one-line alias addition rather than an investigation.
 */
/**
 * The model name meaning "let Cursor choose". Recorded on the task/turn as a
 * concrete, human-readable name, and passed through to `--model auto` — see
 * buildExecArgs for why it must be passed rather than omitted.
 */
export const CURSOR_AUTO_MODEL = 'auto';

const RESULT_KEYS = ['result', 'text', 'response'] as const;
const SESSION_KEYS = ['session_id', 'sessionId', 'chat_id', 'chatId', 'threadId'] as const;

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Extract and join text from a Cursor response content array.
 *
 * Cursor's response may contain content blocks similar to Claude Code.
 * Each block's text should be joined with double newlines for readability.
 */
function extractContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;

    // Handle different block types — text, thinking, or other content
    const text = typeof rec.text === 'string' ? rec.text :
                 typeof rec.thinking === 'string' ? rec.thinking :
                 typeof rec.content === 'string' ? rec.content : null;

    if (text && text.trim()) {
      textParts.push(text.trim());
    }
  }

  return textParts.length > 0 ? textParts.join('\n\n') : null;
}

/**
 * Post-process Cursor result text to ensure proper formatting.
 *
 * Cursor's final `result` string often concatenates every mid-turn assistant
 * bubble with no separator — reviewers see walls like
 * `...before anything else.MCP calls were rejected...directly.Shell is blocked...`.
 * This is a best-effort un-flatten: it cannot perfectly reconstruct intentional
 * structure, but it restores the sentence / heading / fence breaks that make
 * review turns readable.
 *
 * Patterns that get a break:
 * - Sentence end (`.!?`) immediately followed by a capital letter (no space)
 * - Markdown headings (##, ###, …) stuck to previous text
 * - Fenced code blocks (```) stuck to previous text
 * - Common step starters ("Let me…", "I'll…", …) after sentence-ending punctuation
 */
function formatCursorResultText(text: string): string {
  if (!text) return text;

  // The dominant Cursor failure: "...else.MCP calls..." / "...directly.Shell..."
  // — sentence terminator with no whitespace before the next sentence's capital.
  // Run this FIRST so later step-marker rules see already-separated sentences.
  let formatted = text.replace(/([.!?])([A-Z])/g, '$1\n\n$2');

  // Code fences glued to the preceding sentence ("...JSON.```json").
  formatted = formatted.replace(/([^\n`])(```)/g, '$1\n\n$2');

  // Add newlines before markdown headings that are stuck to previous text.
  // Match cases like "...text## Heading" or "...text### Heading"
  formatted = formatted.replace(/([^\n])(\n?)(#{2,6}\s+)/g, (match, before, existingNewline, heading) => {
    // If there's already a newline, keep it. Otherwise add two.
    return existingNewline ? match : `${before}\n\n${heading}`;
  });

  // Add newlines before common "step" phrases that are stuck to previous text
  // with only spaces (the no-space case is already handled above).
  const stepPatterns = [
    /([.!?])(\s*)(Let me\s)/gi,
    /([.!?])(\s*)(Now I\s)/gi,
    /([.!?])(\s*)(I'll\s)/gi,
    /([.!?])(\s*)(I will\s)/gi,
    /([.!?])(\s*)(I need to\s)/gi,
    /([.!?])(\s*)(Next,?\s)/gi,
    /([.!?])(\s*)(First,?\s)/gi,
    /([.!?])(\s*)(Finally,?\s)/gi,
  ];

  for (const pattern of stepPatterns) {
    formatted = formatted.replace(pattern, (match, punct, space, phrase) => {
      // If there's already a newline, keep the original
      if (space && space.includes('\n')) return match;
      return `${punct}\n\n${phrase}`;
    });
  }

  return formatted;
}

/** Parse one JSON object, or null if the text isn't a single JSON object. */
function tryParseObject(text: string): Record<string, unknown> | null {
  if (!text || text[0] !== '{') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Not a single JSON object — the caller falls back to line scanning.
    return null;
  }
}

/**
 * Rebuild the un-lowercased failure text, so a reason can quote Cursor verbatim.
 * `failureHaystack` lowercases for matching; the human needs the real wording.
 */
function rawFailureText(input: AgentFailureInput): string {
  return [input.message, input.stderr, input.stdoutError]
    .filter((s): s is string => !!s)
    .join('\n');
}

/** Max length of Cursor's own text carried into a failure reason. */
const ACTION_REQUIRED_DETAIL_MAX = 320;

/**
 * Reason for a Cursor `ActionRequiredError`, carrying Cursor's own words.
 *
 * The actionable half of this failure ("switch to a different model or set a
 * Spend Limit") is knowledge only Cursor has — flattening it into a generic
 * "plan limit reached" would leave the human with nothing to do. So the reason
 * quotes the provider text, single-lined and clipped for the surfaces that
 * render it on one line.
 */
function actionRequiredReason(input: AgentFailureInput): string {
  const raw = rawFailureText(input);
  const match = raw.match(/ActionRequiredError:\s*([\s\S]+)/i);
  const detail = (match?.[1] ?? raw).replace(/\s+/g, ' ').trim();
  const clipped =
    detail.length > ACTION_REQUIRED_DETAIL_MAX
      ? `${detail.slice(0, ACTION_REQUIRED_DETAIL_MAX - 1).trimEnd()}…`
      : detail;
  return `Cursor needs a human to act before any turn can run — ${clipped}`;
}

/**
 * Does this failure text talk about a usage/quota wall at all?
 *
 * Broader than the literal `ActionRequiredError` prefix on purpose — Cursor
 * surfaces the same wall under more than one error name, and the incident
 * message led with wording, not with a code. Saying "this is about a wall" is
 * NOT yet a verdict: `capHealsOnItsOwn` below decides which kind.
 */
function mentionsUsageWall(text: string): boolean {
  return (
    text.includes('actionrequirederror') ||
    text.includes('spend limit') ||
    text.includes('hit your usage limit') ||
    text.includes('usage limits will reset') ||
    text.includes('upgrade your plan')
  );
}

/**
 * Does the wall carry evidence that it clears WITHOUT a human?
 *
 * Two signals, both meaning "come back shortly":
 *   - a rate-limit marker (429, "rate limit") — provider-side throttling;
 *   - a SHORT reset horizon stated as a duration ("resets in 20 minutes",
 *     "try again in 1 hour", a Retry-After header).
 *
 * A horizon stated as a DATE is the opposite signal and deliberately does not
 * match here: the incident text ends "your usage limits will reset when your
 * monthly cycle ends on 9/19/2026", which is four weeks away and needs a
 * billing change or a different model to clear sooner.
 */
function capHealsOnItsOwn(text: string): boolean {
  return (
    /\b429\b/.test(text) ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('retry-after') ||
    text.includes('retry after') ||
    /\b(resets?|resetting|retry|try again|available again)\b[^.\n]{0,24}\bin\s+(an?|\d+)\s*(seconds?|minutes?|hours?|min\b|mins\b|hr\b|hrs\b)/.test(text)
  );
}

/**
 * Parser for `cursor-agent --print --output-format stream-json` NDJSON.
 *
 * PROVENANCE — every shape below was read off the stdout emitters in the
 * shipped cursor-agent bundle (2026.09.02-c22c1a3,
 * `~/.local/share/cursor-agent/versions/<v>/1931.index.js`), not inferred from
 * the single-blob `json` format and not invented. In that bundle the
 * stream-json branch is `outputFormat === 'stream-json' || streamPartialOutput`
 * and it writes exactly these objects, one JSON per line:
 *
 *   {"type":"system","subtype":"init","session_id":…,"model":…,"cwd":…,
 *    "apiKeySource":…,"permissionMode":"default"}       ← first line
 *   {"type":"user","message":{…},"session_id":…}
 *   {"type":"tool_call","subtype":"started","call_id":…,"tool_call":…,
 *    "model_call_id":…,"session_id":…,"timestamp_ms":…}
 *   {"type":"tool_call","subtype":"completed","call_id":…,"tool_call":…,…}
 *   {"type":"thinking","subtype":"delta"|"completed",…}
 *   {"type":"assistant","message":{…},…}                ← only with --stream-partial-output
 *   {"type":"interaction_query","subtype":"request"|"response",…}
 *   {"type":"system","subtype":"background_shell_timeout"|"task_notification",…}
 *   {"type":"result","subtype":"success","result":…,"session_id":…,"usage":{…},…}
 *
 * Two consequences worth stating, because they are what make the guard correct:
 *
 *  - There is NO keep-alive event. Cursor writes only on real state changes, so
 *    nothing here maps to `heartbeat` and every event is genuine forward
 *    progress. (A long tool call is still silent between `started` and
 *    `completed` — same situation as Claude Code, same guard semantics.)
 *  - The final `result` object is shape-identical to what `--output-format json`
 *    emitted, so `CursorAgent.parseResponse` needs no change: the watchdog hands
 *    it the isolated result line.
 */
export class CursorActivityStream implements AgentActivityStream {
  private sessionId: string | undefined;

  parseLine(line: string): AgentActivityEvent | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Partial line at a kill boundary, or non-JSON chatter — not an error,
      // and deliberately not progress (we cannot tell what it was).
      return null;
    }

    const type = typeof msg.type === 'string' ? msg.type : '';
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
    const sessionId = pickString(msg, SESSION_KEYS);
    if (sessionId) this.sessionId = sessionId;

    if (type === 'system' && subtype === 'init') {
      // mcpServers/toolNames stay undefined: Cursor's init reports neither, and
      // `undefined` is what verifyInitMcpTools reads as "said nothing I can
      // judge". Manufacturing empty arrays here would read as positive evidence
      // of zero tools and abort every Cursor turn at session start.
      //
      // `model` is the one init field we do keep: it is the concrete id
      // cursor-agent resolved from `--model` (an alias like `opus` becomes
      // `claude-opus-4-5-…`). The result object does not repeat it, so this
      // is the only place a Cursor turn learns what actually ran.
      const model = typeof msg.model === 'string' && msg.model.trim()
        ? msg.model.trim()
        : undefined;
      return { kind: 'session_start', sessionId: this.sessionId, ...(model ? { model } : {}) };
    }

    if (type === 'result') {
      return { kind: 'result', sessionId: this.sessionId, raw: trimmed };
    }

    if (type === 'tool_call' && subtype === 'started') {
      return {
        kind: 'tool_start',
        toolUseId: pickString(msg, ['call_id']),
        toolName: cursorToolName(msg.tool_call),
      };
    }

    if (type === 'tool_call' && subtype === 'completed') {
      return {
        kind: 'tool_end',
        toolUseId: pickString(msg, ['call_id']),
        toolName: cursorToolName(msg.tool_call),
      };
    }

    // Everything else — the echoed user message, thinking deltas, assistant
    // text, interaction queries, other system subtypes — is evidence the turn
    // is advancing. Unknown future event types count as progress for the same
    // reason ClaudeCodeActivityStream counts them: mistaking real progress for
    // silence is the expensive error, and it is the exact bug this stream was
    // added to fix.
    return { kind: 'progress' };
  }
}

/**
 * Best-effort tool name from a `tool_call` payload. Cursor serializes it as a
 * protobuf-style oneof — `{ tool: { case: "readToolCall", value: {…} } }` — so
 * the case name minus its suffix is the readable label. Undefined when the
 * shape is anything else; the name is only ever used for logging.
 */
function cursorToolName(toolCall: unknown): string | undefined {
  if (!toolCall || typeof toolCall !== 'object') return undefined;
  const tool = (toolCall as Record<string, unknown>).tool;
  if (!tool || typeof tool !== 'object') return undefined;
  const kase = (tool as Record<string, unknown>).case;
  if (typeof kase !== 'string' || !kase) return undefined;
  return kase.endsWith('ToolCall') ? kase.slice(0, -'ToolCall'.length) : kase;
}

export class CursorAgent implements Agent {
  readonly id = 'cursor';

  getAuthEnvVars(): Array<{ key: string; value: string }> {
    const apiKey = process.env.CURSOR_API_KEY;
    if (apiKey) {
      return [{ key: 'CURSOR_API_KEY', value: apiKey }];
    }
    // No key in the environment: the CLI can still authenticate via its own
    // `cursor-agent login` session on the host. Return nothing rather than an
    // empty CURSOR_API_KEY — an empty-but-present key makes the CLI report
    // "the provided API key is invalid" instead of its actionable login hint.
    return [];
  }

  hasAuthEnv(): boolean {
    // Cursor CLI can use either CURSOR_API_KEY or its own login session.
    // Always return true — let the CLI fail with its own auth error if needed.
    return true;
  }

  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
    effort?: string;
    permissionMode?: 'plan' | 'default';
    extraArgs?: string[];
  }): string[] {
    // No system-prompt flag exists (verified against cursor-agent 2026.08.11
    // --help) — prepend the system prompt to the user prompt instead.
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = `<system>\n${opts.systemPrompt}\n</system>\n\n${prompt}`;
    }

    // --trust: trust the workspace without prompting (headless-only flag; this
    //   was the historic container blocker). Verified keyless that --trust does
    //   NOT approve or load repo-supplied workspace MCP servers.
    // Do NOT pass --worktree — lazy manages its own worktrees; Cursor's flag
    // would create worktrees at ~/.cursor/worktrees/ which conflicts.
    // SECURITY: we deliberately do NOT pass --approve-mcps. That flag is
    // "Automatically approve all MCP servers" (a non-scopeable boolean), and a
    // checked-out repo can ship its own <cwd>/.cursor/mcp.json. Keyless probing
    // (cursor-agent 2026.08.11) established:
    //   - cursor-agent MERGES <cwd>/.cursor/mcp.json into its server list
    //     (`cursor-agent mcp list` shows a repo server as "needs approval");
    //   - a workspace server stays gated ("needs approval", not loaded) unless
    //     approval is granted — and --approve-mcps is exactly what grants it to
    //     ALL of them at once, --trust alone does NOT;
    //   - servers lazy writes to ~/.cursor/mcp.json (home) load WITHOUT any
    //     approval, so lazy's own MCP does not need --approve-mcps at all.
    // Passing it would buy nothing for lazy's own MCP while turning a malicious
    // `git checkout` into arbitrary command execution inside the task container
    // (which holds CURSOR_API_KEY and any forwarded credentials). The
    // authenticated-turn spawn could not be reproduced without a real key (auth
    // is checked before MCP loading, and `mcp list` never spawns), so omitting
    // the flag is the safe default; see the pairing checklist for the with-key
    // confirmation step.
    // --output-format stream-json (NOT the single-blob `json`): cursor-agent in
    // `json` mode writes nothing at all until the turn ends, so the supervisor's
    // no-progress guard saw pure silence and killed every turn that ran longer
    // than the window — the agent was working the whole time (2026-09-08, the
    // polish-ux-v022 loop: three consecutive 30-minute kills on one task, work
    // landing only because the retry ladder resumed the dirty worktree).
    // stream-json emits the same final `{"type":"result",…}` object plus a live
    // NDJSON event stream (see CursorActivityStream for the verified shapes),
    // so silence now means silence. parseResponse handles both.
    const args = ['cursor-agent', '--print', '--output-format', 'stream-json', '--trust'];

    if (opts.permissionMode === 'plan') {
      // Read-only via tool denylist, NOT `--mode plan`. Cursor's plan mode
      // blocks Shell AND rejects MCP calls — which is exactly why every Cursor
      // `lazy review` turn lost lazy_show / lazy_raise and fell back to a
      // mangled file-only pass. Claude Code already made this trade-off
      // (`--disallowedTools` instead of `--permission-mode plan`); Cursor now
      // mirrors it with `--exclude-tools` (proto ToolCall oneof names).
      args.push('--exclude-tools', EXCLUDED_TOOLS_IN_PLAN_MODE);
      if (opts.dangerouslySkipPermissions) {
        // Same as a work turn: auto-run the tools that remain (reads + MCP).
        // Without --force, Cursor may still prompt and stall headless.
        args.push('--force', '--sandbox', 'disabled');
      }
    } else if (opts.dangerouslySkipPermissions) {
      // Run-everything, and disable Cursor's own sandbox: lazy only sets this
      // when the process is already externally isolated (container) or the
      // human explicitly chose bypass, and a nested sandbox breaks git/network.
      args.push('--force', '--sandbox', 'disabled');
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    // A launch with no model at all is refused (requireLaunchModel,
    // src/agent/launch-model.ts) — omission is exactly the silent fallback
    // described below.
    requireLaunchModel('cursor', opts.modelId);
    // ALWAYS pass the resolved model, `auto` included. Plain ids and Cursor's
    // bracket-parameter syntax (e.g. 'claude-opus-4-8[context=1m,effort=high]')
    // both pass through.
    //
    // `auto` used to be spelled by OMITTING --model, on the theory that the
    // flag is optional and cursor-agent then "picks for itself". That is not
    // what omission means. cursor-agent resolves an absent --model against
    // its OWN persisted default in `~/.cursor/cli-config.json` (`model` /
    // `selectedModel`, guarded by `hasChangedDefaultModel`), which is the
    // model the human last selected in Cursor — verified in a real task
    // sandbox, where that file read `"model": {"modelId": "claude-opus-4-5"}`
    // and every turn ran Opus while lazy recorded `auto`. Changing the task's
    // model to `auto` then looked like a no-op: lazy dropped the flag and
    // Cursor went on using the model it had been set to (fix-cursor-model-turn-setting).
    //
    // `auto` IS a model in Cursor's catalog (id `default`, displayed `auto`),
    // and cursor-agent's `--model` resolution matches on model id, display
    // id, display name and aliases, all lowercased — so the literal string
    // resolves. If an account's catalog ever lacks it, cursor-agent exits
    // with "Cannot use this model: auto. Available models: …", which
    // classifyFailure already reports as fatal_config. A loud, named failure
    // is the right outcome; silently running a model nobody chose is not.
    // Verbatim (not the trimmed copy): the recorded id is what Cursor receives.
    args.push('--model', opts.modelId as string);

    // `effort` has no Cursor flag — express it via the model's bracket syntax
    // in the model id instead; silently dropping it here is deliberate.

    // Belt-and-braces with network.useHttp1ForAgent (see
    // src/agent/cursor-cli-config.ts): the agent stream can additionally be
    // redirected by a server-supplied agentUrl, and this flag pins it to lazy's
    // proxy. Same value as CURSOR_API_ENDPOINT, which the launch sites set to
    // the proxy's /_lazy/cursor/<placeholder> URL.
    const agentEndpoint = process.env[CURSOR_ENDPOINT_ENV];
    if (agentEndpoint) {
      args.push('--agent-endpoint', agentEndpoint);
    }

    // Runner-supplied extras. Today computeAgentExtraArgs() sends none for
    // Cursor (the host OS-sandbox --settings flag is Claude-specific), but the
    // contract is to append whatever arrives.
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    // Prompt must be the last positional argument. A raw NUL anywhere in argv
    // is fatal to the spawn, so escape rather than let the turn crash-loop.
    args.push(safeArgvPrompt(prompt, 'prompt'));

    return args;
  }

  /**
   * Parse Cursor output into an AgentResponse.
   *
   * Turns run on `--output-format stream-json`, whose final `{"type":"result",…}`
   * object is shape-identical to the single blob `--output-format json` used to
   * emit — so both are accepted: a lone JSON object, or a newline-delimited
   * stream from which the last result-typed line is taken. (The supervisor
   * normally hands over just the isolated result line the watchdog kept; the
   * stream scan covers the paths that pass raw stdout.) Field names are matched
   * against a small alias set because the
   * success-path shape could not be verified without credentials — the error
   * message lists the keys actually seen so a mismatch is trivial to fix.
   *
   * The result text is post-processed to ensure proper formatting — Cursor may
   * concatenate logical blocks (thinking steps, markdown sections) without
   * proper line breaks.
   */
  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Failed to parse Cursor output: empty stdout');
    }

    let obj = tryParseObject(trimmed);
    // The concrete model cursor-agent reported on its init line. Only a raw
    // stream carries one: the result object never repeats it, and the paths
    // that hand over just the isolated result line (the work turn) attach the
    // init model from the activity stream themselves. The supervisor's
    // follow-up invocations (self-review, wrap-up, walkthrough…) pass raw
    // stdout, and without this every one of their turns recorded no model_id —
    // looking like it ran the requested alias.
    let initModel: string | undefined;
    if (!obj) {
      // Stream fallback: scan backwards for a result-typed line.
      const lines = trimmed.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const candidate = tryParseObject(lines[i]!.trim());
        if (candidate && (candidate.type === 'result' || pickString(candidate, RESULT_KEYS))) {
          obj = candidate;
          break;
        }
      }
      // Read through the activity stream's parser so the init shape is
      // interpreted in exactly one place.
      const stream = new CursorActivityStream();
      for (const line of lines) {
        const event = stream.parseLine(line);
        if (event?.kind === 'session_start') {
          initModel = event.model;
          break;
        }
      }
    }

    if (!obj) {
      throw new Error(
        `Failed to parse Cursor output: no JSON object found (${trimmed.split('\n').length} line(s), ${stdout.length} bytes)`
      );
    }

    // Try to extract text from content blocks first (if result is structured).
    // This handles responses that contain content blocks similar to Claude Code.
    let result: string | undefined;

    // Check for content blocks in common locations
    const contentLocations = [
      obj.content,
      obj.message && typeof obj.message === 'object' ? (obj.message as Record<string, unknown>).content : null,
      obj.result && typeof obj.result === 'object' ? (obj.result as Record<string, unknown>).content : null,
    ];

    for (const content of contentLocations) {
      const extracted = extractContentText(content);
      if (extracted) {
        result = extracted;
        break;
      }
    }

    // Fall back to string extraction if no content blocks found
    if (!result) {
      result = pickString(obj, RESULT_KEYS);
    }

    const sessionId = pickString(obj, SESSION_KEYS);
    if (!result || !sessionId) {
      throw new Error(
        `Cursor response missing required fields (result, session id). ` +
        `Top-level keys seen: ${Object.keys(obj).join(', ') || '(none)'}`
      );
    }

    // Post-process the result text to ensure proper formatting.
    // This adds newlines before markdown headings and common step markers
    // that may have been concatenated without proper line breaks.
    const formattedResult = formatCursorResultText(result);

    const response: AgentResponse = { ...(obj as unknown as AgentResponse), result: formattedResult, session_id: sessionId };
    return !response.model_id && initModel ? { ...response, model_id: initModel } : response;
  }

  isPromptTooLongError(errorMessage: string): boolean {
    return (
      errorMessage.includes('Prompt is too long') ||
      errorMessage.includes('prompt too long') ||
      errorMessage.includes('context length exceeded')
    );
  }

  isSessionNotFoundError(errorMessage: string): boolean {
    return (
      errorMessage.includes('No conversation found with session ID') ||
      errorMessage.includes('session not found') ||
      errorMessage.includes('chat not found') ||
      errorMessage.includes('invalid session')
    );
  }

  /**
   * Cursor-specific failure classification.
   *
   * Messages verified against cursor-agent 2026.08.11:
   * - no credentials:  "Error: Authentication required. Please run 'agent login'
   *   first, or set CURSOR_API_KEY environment variable." (stderr, exit 1)
   * - bad API key:     "Warning: The provided API key is invalid." (stderr, exit 1)
   * - plan/quota wall: "ActionRequiredError: You've hit your usage limit for Opus … Switch
   *   to a different model or set a Spend Limit to continue with Opus." (observed live,
   *   2026-08-22, fix-cursor-action-required)
   * Everything else falls through to the shared HTTP/network signals.
   */
  classifyFailure(input: AgentFailureInput): AgentFailure {
    const text = failureHaystack(input);

    // lazy's own refusal to launch without a model (src/agent/launch-model.ts).
    const noModel = classifyNoModelRefusal(input);
    if (noModel) return noModel;

    // Binary not installed (the spawn wrapper's ENOENT diagnosis). Fatal —
    // retrying can never install it — and the reason carries the install
    // hint, because this is exactly what a custom Dockerfile without the
    // cursor-agent install line produces.
    if (/spawn failed: binary '(cursor-agent|agent)' not found/.test(text)) {
      return {
        class: 'fatal_config',
        reason: `cursor-agent is not installed in this environment. ${CURSOR_INSTALL_HINT}`,
      };
    }

    if (
      text.includes('authentication required') ||
      text.includes('api key is invalid') ||
      text.includes('not logged in') ||
      text.includes('agent login')
    ) {
      return { class: 'fatal_auth', reason: 'Cursor CLI is not authenticated' };
    }

    // Plan / quota / spend-limit walls. Cursor names this condition itself:
    // `ActionRequiredError` — by its own name, a human must act. Observed live
    // (fix-cursor-action-required):
    //   "ActionRequiredError: You've hit your usage limit for Opus … Switch to a
    //    different model or set a Spend Limit to continue with Opus. Your usage
    //    limits will reset when your monthly cycle ends on 9/19/2026."
    // Nothing about that heals inside a turn — it needs a new model id, a
    // billing change, or a new monthly cycle — so it is fatal, and the retry
    // ladder previously spun on it across two whole container generations.
    //
    // CLASS: `fatal_auth`, not a new class. The taxonomy already scopes it as
    // "missing/invalid/EXHAUSTED credential — 401, 403, invalid API key,
    // billing", which is exactly a spent plan quota, and its policy (stop on
    // the first failure, block the task for the human) is the behaviour wanted
    // here. A new class would buy a different label and identical semantics.
    //
    // DELIBERATELY CURSOR-LOCAL: the shared matcher in failure-taxonomy.ts maps
    // "usage limit reached" to `transient_overload` for Claude, whose 5-hour
    // window genuinely heals on its own. Making "usage limit" fatal there would
    // break that; Cursor's dialect wins here instead.
    //
    // The verdict needs EVIDENCE OF A HUMAN-ACTIONABLE WALL, not merely the
    // words "usage limit" — see mentionsUsageWall / capHealsOnItsOwn above.
    if (mentionsUsageWall(text)) {
      // ORDERING HAZARD, closed here: "usage limit" is not by itself a verdict.
      // Cursor can also surface a SHORT-window cap whose body says both at once
      // — "429 … you've hit your usage limit, resets in 20 minutes". Matching
      // the plan wording and stopping would block a task that was about to
      // recover: the same misclassification as the incident, pointed the other
      // way. So a wall that carries healing evidence falls through to the
      // shared transient signals BEFORE the fatal verdict can be reached.
      //
      // The direction of the tiebreak is the taxonomy's standing rule (pinned
      // by its own tests): a wrong `fatal_*` blocks a task that would have
      // recovered, so ambiguity resolves toward "keep trying". A wrong
      // `transient` merely costs the retry ladder before a human sees it.
      if (capHealsOnItsOwn(text)) {
        return (
          classifyCommonFailureSignals(input, [LAUNCH_BINARY]) ?? {
            class: 'transient_overload',
            reason: 'Cursor capped this window — its own message says the cap clears shortly',
          }
        );
      }
      return { class: 'fatal_auth', reason: actionRequiredReason(input) };
    }

    // "cannot use this model:" is cursor-agent's own wording when --model names
    // something outside the account's catalog (it prints the available ids
    // alongside). It is fatal for the same reason an unknown flag is: nothing
    // heals inside the turn, a human has to pick a different model.
    if (
      text.includes('unknown option') ||
      text.includes('unknown model') ||
      text.includes('cannot use this model')
    ) {
      return { class: 'fatal_config', reason: 'Cursor rejected the invocation (model or flag)' };
    }

    return (
      classifyCommonFailureSignals(input, [LAUNCH_BINARY]) ?? {
        class: 'unknown',
        reason: 'unrecognized Cursor failure',
      }
    );
  }

  defaultWatchdogTimeoutMs(): number {
    // 0 = "no agent-specific default"; the configured
    // `[agent] watchdog_output_timeout_ms` applies, same as Claude Code, Codex
    // and pi. Cursor now emits an activity stream (see CursorActivityStream),
    // so the supervisor measures silence between *forward progress* events
    // rather than between bytes.
    //
    // This used to be 5 minutes, as belt-and-braces against a historic --print
    // hang. On the single-blob `json` format that number was measuring the
    // wrong thing entirely — a working turn emits nothing until it ends, so the
    // window was really "how long may a Cursor turn take", and every longer
    // turn was killed and retried. A hang still trips the ceiling; a long turn
    // no longer does.
    return 0;
  }

  defaultModel(): string {
    // Cursor picks the model itself, and that is the sensible default for a
    // Cursor task: lazy's `[models] default` is an Anthropic model name chosen
    // for Claude Code, and forcing it onto Cursor pins every Cursor turn to one
    // (often plan-limited) model for no reason. An explicit per-task model
    // still wins — see Agent.defaultModel() for the full precedence.
    return CURSOR_AUTO_MODEL;
  }

  activityStream(): AgentActivityStream {
    // Verified, not assumed: the event shapes come from the stdout emitters in
    // the shipped cursor-agent bundle (2026.09.02-c22c1a3) — see the
    // CursorActivityStream docblock for the provenance and the exact objects.
    // buildExecArgs passes `--output-format stream-json`, so this stream is the
    // format the process really produces; the two must change together.
    return new CursorActivityStream();
  }

  supportsPairing(): boolean {
    // Was false, and the refusal named its own expiry: "revisit when pairing
    // itself moves into the container, where the session is already on the
    // right side of the boundary and nothing needs importing." That is what
    // pair-in-container did, so this is that revisit, not a flip-to-fix.
    //
    // Both conditions in Agent.supportsPairing() now hold for Cursor:
    //  1. Nothing is imported. `lazy pair <task>` execs cursor-agent INSIDE the
    //     task's container, on the same `<sandbox>/.cursor` the supervised
    //     turns wrote. Agent-written chat is never carried onto the host, and
    //     the human's own ~/.cursor is never read, written or consulted.
    //  2. It is useful. The chat id is on the task's session record (see
    //     SESSION_KEYS / parseResponse), so the session resumes with the work
    //     in it rather than starting empty — the exact gap that made pairing
    //     pointless before.
    //
    // KNOWN GAP, deliberately not papered over: discoverSessionFiles() is still
    // [], so lazy cannot detect the id of a chat STARTED during pairing and
    // cannot read the transcript afterwards. A Cursor pairing session therefore
    // gets no AI summary turn, and `lazy pair` says so at exit rather than
    // silently recording nothing.
    return true;
  }

  buildInteractiveArgs(opts: {
    sessionId?: string | null;
    modelId?: string | null;
    dangerouslySkipPermissions: boolean;
  }): string[] {
    // Interactive: no --print/--output-format (those make it headless and
    // machine-parsed), no prompt positional. --trust for the same reason the
    // headless path passes it, and --approve-mcps omitted for the same security
    // reason — see buildExecArgs.
    const args = ['cursor-agent', '--trust'];
    if (opts.dangerouslySkipPermissions) {
      // Same trust decision as a supervised turn: this runs in the task's
      // container, so Cursor's own sandbox is redundant and breaks git/network.
      args.push('--force', '--sandbox', 'disabled');
    }
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    // Always, `auto` included — the same reason buildExecArgs passes it: an
    // omitted --model reads the human's persisted selection in
    // ~/.cursor/cli-config.json, so a pair session on an `auto` task ran a
    // model nobody chose for it.
    args.push('--model', requireLaunchModel('cursor', opts.modelId));
    // Resolved INSIDE the container, where this argv is built — the endpoint
    // that matters is the one that process can reach.
    const agentEndpoint = process.env[CURSOR_ENDPOINT_ENV];
    if (agentEndpoint) args.push('--agent-endpoint', agentEndpoint);
    return args;
  }

  discoverSessionFiles(_opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // Cursor stores per-project chat state under ~/.cursor/projects/<encoded>/
    // (observed with 2026.08.11), but the file format and naming inside are
    // undocumented and could not be captured without credentials. Returning []
    // keeps transcript-dependent features (pair summaries, conversation
    // capture) honestly disabled rather than mis-parsing unknown files.
    // Real-key pairing TODO: run a turn, inspect ~/.cursor/projects, and
    // implement discovery if the layout proves stable.
    return [];
  }
}
