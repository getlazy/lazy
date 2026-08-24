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
 * - Plan/ask turns use the native read-only `--mode plan` (no tool-blocklist hack)
 * - Headless workspace trust has a first-class flag: `--trust`. The sibling
 *   `--approve-mcps` is deliberately NOT used — it would auto-approve a repo's
 *   own <cwd>/.cursor/mcp.json (arbitrary-exec-by-checkout); lazy's own MCP
 *   lives in ~/.cursor/mcp.json (home) and loads without approval. See
 *   buildExecArgs for the keyless probe results.
 * - Historic hanging bug in --print mode — uses non-zero default watchdog timeout
 * - Session/chat files live under ~/.cursor/projects/<encoded-path>/ (layout
 *   mirrors Claude's ~/.claude/projects but the file format is unverified — see
 *   discoverSessionFiles)
 * - Auth via CURSOR_API_KEY env var or `cursor-agent login` session
 */

import type { AgentResponse } from '../types';
import { CURSOR_ENDPOINT_ENV } from '../proxy/cursor-route';
import type { Agent } from './interface';
import { safeArgvPrompt } from './argv-safety';
import { CURSOR_INSTALL_HINT } from './cursor-packaging';
import {
  classifyCommonFailureSignals,
  failureHaystack,
  type AgentFailure,
  type AgentFailureInput,
} from './failure-taxonomy';

/**
 * Field aliases accepted when parsing the final response object.
 *
 * The success-path JSON of `cursor-agent --output-format json` could not be
 * captured without credentials (auth is checked before any turn starts), so the
 * parser accepts the plausible spellings and fails with a diagnostic that lists
 * the keys it actually saw — making the real-key pairing fix a one-line alias
 * addition rather than an investigation.
 */
/**
 * The model name meaning "let Cursor choose". Recorded on the task/turn as a
 * concrete, human-readable name, and translated back into "no --model flag" in
 * buildExecArgs — see the comment there for why omission is the right spelling.
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
 * Cursor CLI may concatenate logical blocks (thinking steps, summaries)
 * without proper line breaks. This function adds newlines before common
 * structural markers to improve readability.
 *
 * Patterns that get a newline before them:
 * - Markdown headings (##, ###, etc.)
 * - Common thinking step markers ("Let me...", "Now I...", "I'll...")
 *
 * This is a best-effort heuristic — it cannot perfectly reconstruct
 * intentional structure from a flattened string, but it prevents the
 * worst case of a wall of unreadable text.
 */
function formatCursorResultText(text: string): string {
  if (!text) return text;

  // Add newlines before markdown headings that are stuck to previous text.
  // Match cases like "...text## Heading" or "...text### Heading"
  let formatted = text.replace(/([^\n])(\n?)(#{2,6}\s+)/g, (match, before, existingNewline, heading) => {
    // If there's already a newline, keep it. Otherwise add two.
    return existingNewline ? match : `${before}\n\n${heading}`;
  });

  // Add newlines before common "step" phrases that are stuck to previous text.
  // These patterns indicate a new logical step and should start on a new line.
  // Only match when NOT at the start of the string and preceded by a sentence-ending character.
  const stepPatterns = [
    // Common step starters (only after sentence-ending punctuation)
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
    const args = ['cursor-agent', '--print', '--output-format', 'json', '--trust'];

    if (opts.permissionMode === 'plan') {
      // Native read-only mode: analyze/propose, no edits. Unlike Claude Code
      // there is no interactive plan-exit prompt in --print mode, so the real
      // mode flag is safe to use headless.
      args.push('--mode', 'plan');
    } else if (opts.dangerouslySkipPermissions) {
      // Run-everything, and disable Cursor's own sandbox: lazy only sets this
      // when the process is already externally isolated (container) or the
      // human explicitly chose bypass, and a nested sandbox breaks git/network.
      args.push('--force', '--sandbox', 'disabled');
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.modelId && opts.modelId.trim().toLowerCase() !== CURSOR_AUTO_MODEL) {
      // Plain ids and Cursor's bracket-parameter syntax
      // (e.g. 'claude-opus-4-8[context=1m,effort=high]') both pass through.
      args.push('--model', opts.modelId);
    }
    // `auto` is spelled by OMITTING --model: the flag is optional and
    // cursor-agent then applies its own model selection, which is precisely
    // what "auto" means. Passing the literal string would be a guess — the CLI
    // does no client-side model validation (verified against cursor-agent
    // 2026.08.11: an unknown --model value is not rejected locally, auth is
    // checked first), so a name the server does not know surfaces only as a
    // failed turn. Omitting is verifiable and cannot be wrong.

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
   * Accepts a single JSON object (`--output-format json`) and, defensively, a
   * newline-delimited stream from which the last `{"type":"result",…}` line is
   * taken (in case a future switch to stream-json lands before this parser is
   * revisited). Field names are matched against a small alias set because the
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

    return { ...(obj as unknown as AgentResponse), result: formattedResult, session_id: sessionId };
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
          classifyCommonFailureSignals(input) ?? {
            class: 'transient_overload',
            reason: 'Cursor capped this window — its own message says the cap clears shortly',
          }
        );
      }
      return { class: 'fatal_auth', reason: actionRequiredReason(input) };
    }

    if (text.includes('unknown option') || text.includes('unknown model')) {
      return { class: 'fatal_config', reason: 'Cursor rejected the invocation (model or flag)' };
    }

    return (
      classifyCommonFailureSignals(input) ?? {
        class: 'unknown',
        reason: 'unrecognized Cursor failure',
      }
    );
  }

  defaultWatchdogTimeoutMs(): number {
    // Cursor CLI has a historic hanging bug in --print mode (unconfirmed
    // whether it still exists — kept as belt-and-suspenders).
    // Default to 5 minutes of no output before killing the process.
    return 5 * 60 * 1000;
  }

  defaultModel(): string {
    // Cursor picks the model itself, and that is the sensible default for a
    // Cursor task: lazy's `[models] default` is an Anthropic model name chosen
    // for Claude Code, and forcing it onto Cursor pins every Cursor turn to one
    // (often plan-limited) model for no reason. An explicit per-task model
    // still wins — see Agent.defaultModel() for the full precedence.
    return CURSOR_AUTO_MODEL;
  }

  activityStream(): null {
    // No incremental event stream: `cursor-agent --print --output-format json`
    // emits a single blob at exit. The watchdog therefore keeps its byte-level
    // behavior for Cursor — any output is liveness, and the 5-minute default
    // above is what catches the --print hang. `--output-format stream-json`
    // exists but its event shapes are unverified without credentials; do not
    // "upgrade" this without capturing the real stream first — returning a
    // stream the agent doesn't produce would make every Cursor turn look silent.
    return null;
  }

  supportsPairing(): boolean {
    // SECURITY + utility, and it fails both tests.
    //
    // A Cursor task that ran in a container wrote its chat under the worktree
    // sandbox, which `cursor-agent` on the host cannot read. lazy will not copy
    // it over: that history is agent-written, and importing it makes it input to
    // a host session running as the human (it used to, and --autonomous then
    // resumed it with approvals off). So the human would get an EMPTY session
    // with no memory of the work — the danger without the benefit.
    //
    // Revisit when pairing itself moves into the container, where the session is
    // already on the right side of the boundary and nothing needs importing.
    return false;
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
