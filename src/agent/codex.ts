/**
 * CodexAgent — Agent implementation for OpenAI's Codex CLI (`codex` binary).
 *
 * Verified against codex-cli 0.152.1 (see docs/spike-codex-cursor-revisit.md
 * and the add-codex-agent task journal for the empirical probes — every flag
 * and event shape below was exercised against the real binary, driven by a
 * local fake OpenAI Responses server, so the *binary's* behavior is verified
 * even though no real OpenAI credentials were available).
 *
 * Key differences from Claude Code:
 * - Headless mode is a subcommand: `codex exec --json [PROMPT]`; resume is a
 *   nested subcommand: `codex exec resume <thread-id> --json [PROMPT]`.
 * - Output is a JSONL *event stream* (`--json`), not a single result object:
 *   `thread.started` (carries `thread_id` — the session id), `turn.started`,
 *   `item.started/updated/completed`, then `turn.completed` (usage) on success
 *   or `turn.failed` (error) on failure. Shapes confirmed both live and against
 *   codex-rs `exec/src/exec_events.rs`.
 * - No system-prompt flag exists on `codex exec` — the system prompt is
 *   prepended to the user prompt (the Cursor precedent; delivery verified:
 *   the prompt argument arrives verbatim as the final user message).
 * - Token usage on `turn.completed` uses OpenAI Responses conventions:
 *   `input_tokens` INCLUDES cached tokens (Anthropic's excludes them), and the
 *   numbers are summed across every wire request in the turn. parseResponse
 *   maps them to lazy's Anthropic-shaped AgentTokenUsage.
 * - Session rollouts live at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
 *   named after the thread id.
 * - Auth is the OPENAI_API_KEY env var: lazy's provider block in
 *   ~/.codex/config.toml declares `env_key = "OPENAI_API_KEY"`, so the CLI
 *   reads the launch's JIT placeholder from the environment and sends it as
 *   `Authorization: Bearer …` to lazy's proxy, which swaps in the real key.
 *   A missing env var fails the turn with its own clear message (verified).
 *   That one mechanism covers BOTH of the things codex can be paid with: an
 *   OpenAI API key, and a ChatGPT Plus/Pro subscription. Which one a turn bills
 *   is decided entirely on the host, by the profile's endpoint and credential
 *   slot — the container sees the same placeholder either way and never learns
 *   what stands behind it. See docs/codex-chatgpt-subscription.md.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentResponse, AgentTokenUsage } from '../types';
import { getHome } from '../utils/home';
import type { Agent } from './interface';
import type { AgentActivityEvent, AgentActivityStream } from './activity-stream';
import { safeArgvPrompt } from './argv-safety';
import { classifyNoModelRefusal, requireLaunchModel } from './launch-model';
import { AGENT_KEY_ENV } from './credentials';
import { envVarFor } from '../credentials/providers';
import { CODEX_INSTALL_HINT, CodexPackaging } from './codex-packaging';
import {
  classifyCommonFailureSignals,
  failureHaystack,
  type AgentFailure,
  type AgentFailureInput,
} from './failure-taxonomy';

const LAUNCH_BINARY = new CodexPackaging().binaryName();

/**
 * The model name meaning "let Codex choose". Codex has no `auto` model id in
 * its catalog — omitting `-m` is how "the CLI's own default" is spelled — but
 * lazy needs a concrete, human-readable name to record on the task/turn, and
 * `resolveAgentModel`'s precedence needs this agent to declare *something* (a
 * silent fall-through to `[models] default` would pass an Anthropic model name
 * to `-m`). Unlike Cursor, omission is safe here: lazy owns the whole
 * ~/.codex/config.toml in the sandbox (see src/agent/codex-config.ts) and
 * never writes a `model` key into it, so there is no persisted user default
 * that could hijack an omitted flag.
 */
export const CODEX_DEFAULT_MODEL = 'default';

/**
 * Reasoning-effort values codex accepts. The `-c model_reasoning_effort=…`
 * override is passed through to the API's `reasoning.effort` verbatim
 * (verified: "xhigh" produced `reasoning:{"effort":"xhigh"}` on the wire, and
 * an unknown value is ALSO passed through untouched — the API, not the CLI,
 * would reject it). Only known-valid values are sent; lazy's `max` maps to
 * codex's ceiling rather than being forwarded for a remote 400.
 */
/**
 * Append codex's model flag for a launch that MUST name a model.
 *
 * A launch with no model is refused (requireLaunchModel,
 * src/agent/launch-model.ts). The {@link CODEX_DEFAULT_MODEL} sentinel is a
 * model that WAS named — the task's persisted choice — and omitting `-m` is
 * the only way to spell it, so it stays: the model that runs is codex's
 * compiled-in default, and nothing outside lazy can redirect the omission
 * because lazy owns ~/.codex/config.toml and never writes a `model` key.
 * (Cursor's `auto` is the opposite case: an omitted flag there reads the
 * human's persisted selection, so `auto` is always passed.)
 */
function pushCodexModel(args: string[], modelId: string | null | undefined): void {
  const model = requireLaunchModel('codex', modelId);
  if (model.toLowerCase() !== CODEX_DEFAULT_MODEL) args.push('-m', model);
}

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

function codexEffort(effort: string): string | null {
  const normalized = effort.trim().toLowerCase();
  if (CODEX_EFFORTS.has(normalized)) return normalized;
  if (normalized === 'max') return 'xhigh';
  return null;
}

/** Parse one JSON object, or null if the line isn't one. */
function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Not JSON — normal for a truncated tail line after a kill; the caller
    // scans other lines.
    return null;
  }
}

/** The `item` payload of an item.* event, or null. */
function eventItem(obj: Record<string, unknown>): Record<string, unknown> | null {
  const item = obj.item;
  return item && typeof item === 'object' && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : null;
}

/**
 * Map codex's turn usage to lazy's Anthropic-shaped AgentTokenUsage.
 *
 * Codex (OpenAI Responses convention): `input_tokens` INCLUDES
 * `cached_input_tokens`; Anthropic (lazy's shape): `input_tokens` EXCLUDES
 * cache reads, which ride in `cache_read_input_tokens`. Subtracting keeps a
 * turn's total = input + cache_read + cache_creation + output identical under
 * both conventions, so codex turns aggregate correctly next to Claude turns
 * and are not double-counted against the proxy's own wire-side extraction.
 */
function mapUsage(raw: Record<string, unknown>): AgentTokenUsage {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(raw.input_tokens);
  const cached = num(raw.cached_input_tokens);
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: num(raw.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: num(raw.cache_write_input_tokens),
  };
}

/** Item types that represent a tool invocation in flight. */
const TOOL_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'collab_tool_call']);

/** Human-readable tool label for diagnostics ("MCP tool `x` in flight"). */
function toolLabel(item: Record<string, unknown>): string | undefined {
  const type = typeof item.type === 'string' ? item.type : undefined;
  if (type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    return server && tool ? `${server}.${tool}` : type;
  }
  if (type === 'command_execution' && typeof item.command === 'string') {
    return `command: ${item.command.slice(0, 80)}`;
  }
  return type;
}

/**
 * Parser for `codex exec --json` JSONL output.
 *
 * Stateful per turn (the supervisor constructs a fresh one per execution via
 * `agent.activityStream()`): the `turn.completed` line alone carries no thread
 * id and no message text, so the parser retains the `thread.started` and last
 * `agent_message` lines and emits a small verbatim JSONL excerpt as the
 * `result` event's `raw`. That excerpt parses under `parseResponse` exactly
 * like full stdout does — one format, whichever path delivers it (the watchdog
 * keeps only the result line in full; stdout is a bounded tail).
 */
export class CodexActivityStream implements AgentActivityStream {
  private threadStartedLine: string | null = null;
  private agentMessageLines: string[] = [];

  parseLine(line: string): AgentActivityEvent | null {
    const obj = tryParseObject(line);
    if (!obj) return null;
    const type = typeof obj.type === 'string' ? obj.type : '';

    if (type === 'thread.started') {
      this.threadStartedLine = line.trim();
      return {
        kind: 'session_start',
        sessionId: typeof obj.thread_id === 'string' ? obj.thread_id : undefined,
        // Codex's stream has no equivalent of Claude's init-line MCP/tool
        // report — leave both fields undefined ("said nothing"), never [].
      };
    }

    if (type === 'turn.completed') {
      return {
        kind: 'result',
        sessionId: this.sessionId(),
        raw: [this.threadStartedLine, ...this.agentMessageLines, line.trim()]
          .filter((l): l is string => !!l)
          .join('\n'),
      };
    }

    if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
      const item = eventItem(obj);
      const itemType = item && typeof item.type === 'string' ? item.type : '';
      if (item && itemType === 'agent_message' && type === 'item.completed') {
        this.agentMessageLines.push(line.trim());
        return { kind: 'progress' };
      }
      if (item && TOOL_ITEM_TYPES.has(itemType)) {
        const toolUseId = typeof item.id === 'string' ? item.id : undefined;
        if (type === 'item.started') {
          return { kind: 'tool_start', toolUseId, toolName: toolLabel(item) };
        }
        if (type === 'item.completed') {
          return { kind: 'tool_end', toolUseId, toolName: toolLabel(item) };
        }
        // item.updated on a running command means output arrived — the
        // *process* is alive, but a command looping forever would emit these
        // indefinitely, so it must not reset the progress clock (same
        // reasoning as Claude's tool_progress heartbeats).
        return { kind: 'heartbeat', toolUseId, toolName: toolLabel(item) };
      }
      return { kind: 'progress' };
    }

    // turn.started, error (in-stream reconnect notices), turn.failed, and any
    // event a future codex release adds: evidence the turn is advancing (or at
    // least the CLI is alive and reporting) — mistaking real activity for
    // silence is the expensive error. turn.failed deliberately does NOT emit
    // `result`: there is no summary to protect, and the process exits 1
    // immediately after, taking the failure down the CrashError path.
    return { kind: 'progress' };
  }

  private sessionId(): string | undefined {
    const obj = this.threadStartedLine ? tryParseObject(this.threadStartedLine) : null;
    return obj && typeof obj.thread_id === 'string' ? obj.thread_id : undefined;
  }
}

export class CodexAgent implements Agent {
  readonly id = 'codex';

  getAuthEnvVars(): Array<{ key: string; value: string }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      return [{ key: 'OPENAI_API_KEY', value: apiKey }];
    }
    // No key in the environment: the CLI can still authenticate via its own
    // `codex login` session (auth.json). Return nothing rather than an empty
    // key — lazy's provider block declares `env_key = "OPENAI_API_KEY"`, and
    // an empty-but-present value would be sent upstream as a bearer token
    // instead of producing codex's actionable "missing environment variable"
    // message.
    return [];
  }

  /**
   * NOT THE LAUNCH GATE, AND NOTHING CALLS IT. Read this before treating it as
   * one: `Agent.hasAuthEnv()` has no production caller anywhere in lazy — the
   * refusal that actually stops a codex launch is `resolveProfileCredential` in
   * src/capture/claude.ts, which runs before any container starts, resolves the
   * PROFILE's credential slot (the one the proxy will bill) across env, store and
   * key file, and throws naming both ways to fix it.
   *
   * It cannot BE the gate: it is synchronous and knows no project root, while
   * the credential store is per project and async — so a launch gated on this
   * would refuse a perfectly good stored credential. The method survives only
   * because it is on the `Agent` interface and asserted for other harnesses.
   *
   * What it now answers honestly is the env-only question. It used to return a
   * flat `true` with "let the CLI fail with its own auth error", which was a lie
   * by the time anyone asked: the CLI runs in a container that cannot see the
   * host's `codex login`, so "the CLI will sort it out" meant a container start,
   * a turn, and a bare 401 with no remedy in it. Both credential forms count —
   * an OpenAI API key and a ChatGPT subscription session — and anything answered
   * true here must be something the real gate would also accept.
   */
  hasAuthEnv(): boolean {
    return !!(
      process.env[AGENT_KEY_ENV.codex!]?.trim() ||
      process.env[envVarFor('chatgpt', 'oauth')!]?.trim()
    );
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
    // No system-prompt flag exists on `codex exec` (verified against 0.152.1
    // --help) — prepend the system prompt to the user prompt instead, the same
    // shape Cursor uses. (~/.codex/AGENTS.md would also inject globally, but
    // it rides a file outside this method's reach and mixes lazy's per-turn
    // instructions into a channel the repo's own AGENTS.md shares.)
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = `<system>\n${opts.systemPrompt}\n</system>\n\n${prompt}`;
    }

    // Resume is a nested subcommand with the thread id as a positional —
    // `codex exec resume <id> [PROMPT]` — so the argv prefix branches here.
    // A fresh turn is plain `codex exec [PROMPT]`.
    const args = opts.sessionId
      ? [LAUNCH_BINARY, 'exec', 'resume', opts.sessionId]
      : [LAUNCH_BINARY, 'exec'];

    // --json: the JSONL event stream this class's parsers consume.
    // --skip-git-repo-check: lazy always runs codex inside a task worktree (a
    //   real git repo), but ask-style turns can run against detached or
    //   partially-initialized states; the check guards interactive users, not
    //   a supervisor that already knows where it pointed the agent.
    args.push('--json', '--skip-git-repo-check');

    if (opts.permissionMode === 'plan') {
      // `--sandbox` exists on `codex exec` but NOT on its nested `resume`
      // subcommand (verified against codex-cli 0.152.1). Low-high review is a
      // resumed turn, so passing that flag made clap reject the argv before
      // the agent ran. The config override is accepted by both commands and
      // selects the same native read-only sandbox.
      args.push('-c', 'sandbox_mode="read-only"');
    } else if (opts.dangerouslySkipPermissions) {
      // Run-everything, and disable codex's own Landlock/seccomp sandbox: lazy
      // only sets this when the process is already externally isolated (the
      // task container), where a nested sandbox breaks git and network. The
      // flag's own name says exactly what it is for: "Intended solely for
      // running in environments that are externally sandboxed."
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    pushCodexModel(args, opts.modelId);
    // CODEX_DEFAULT_MODEL omits -m on purpose: codex's built-in default (a
    // real OpenAI model id, e.g. gpt-5.6-sol on 0.152.1) then applies. Safe
    // because lazy owns ~/.codex/config.toml and never writes a `model` key —
    // there is no Cursor-style persisted user default to hijack the omission.

    if (opts.effort) {
      const effort = codexEffort(opts.effort);
      if (effort) {
        // -c values are parsed as TOML; the quotes make it a string literal.
        args.push('-c', `model_reasoning_effort="${effort}"`);
      }
      // Unknown efforts are dropped rather than forwarded: the CLI passes the
      // raw value through to the API's reasoning.effort (verified), so a bad
      // value would fail the turn remotely instead of here.
    }

    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    // Prompt must be the last positional argument. A raw NUL anywhere in argv
    // is fatal to the spawn, so escape rather than let the turn crash-loop.
    args.push(safeArgvPrompt(prompt, 'prompt'));

    return args;
  }

  /**
   * Parse codex JSONL output into an AgentResponse.
   *
   * Accepts either the full `codex exec --json` stdout or the compact excerpt
   * `CodexActivityStream` emits as the result event's `raw` — both are JSONL
   * with the same event shapes, so one scan handles both:
   *   - `thread.started` → session id (`thread_id`)
   *   - `item.completed` with `item.type === "agent_message"` → result text
   *     (multiple messages join with blank lines, in stream order)
   *   - `turn.completed` → usage (mapped to Anthropic-shaped counts)
   *   - `turn.failed` → throw with codex's own error message
   */
  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Failed to parse Codex output: empty stdout');
    }

    let sessionId: string | undefined;
    let usage: AgentTokenUsage | undefined;
    let failure: string | undefined;
    let sawTurnCompleted = false;
    const messages: string[] = [];

    for (const line of trimmed.split('\n')) {
      const obj = tryParseObject(line);
      if (!obj || typeof obj.type !== 'string') continue;

      if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') {
        sessionId = obj.thread_id;
      } else if (obj.type === 'item.completed') {
        const item = eventItem(obj);
        if (item && item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
          messages.push(item.text);
        }
      } else if (obj.type === 'turn.completed') {
        sawTurnCompleted = true;
        const rawUsage = obj.usage;
        if (rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)) {
          usage = mapUsage(rawUsage as Record<string, unknown>);
        }
      } else if (obj.type === 'turn.failed') {
        const error = obj.error;
        const message =
          error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
            ? ((error as Record<string, unknown>).message as string)
            : 'unknown error';
        failure = message;
      }
    }

    if (failure) {
      // Quote codex verbatim: the message carries the actionable half (which
      // provider URL failed, the HTTP status, OpenAI's own remedy text).
      throw new Error(`Codex turn failed: ${failure}`);
    }

    if (messages.length === 0 || !sessionId || !sawTurnCompleted) {
      const missing = [
        messages.length === 0 ? 'an agent_message item' : null,
        !sessionId ? 'a thread.started line' : null,
        !sawTurnCompleted ? 'a turn.completed line' : null,
      ].filter(Boolean).join(', ');
      throw new Error(
        `Codex output is missing ${missing} (${trimmed.split('\n').length} line(s), ${stdout.length} bytes)`,
      );
    }

    return {
      result: messages.join('\n\n'),
      session_id: sessionId,
      usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      // No model_id: codex's JSONL does not report which model actually ran.
    };
  }

  isPromptTooLongError(errorMessage: string): boolean {
    // OpenAI wire spellings; none could be triggered live (needs a real
    // backend to enforce a context limit).
    const text = errorMessage.toLowerCase();
    return (
      text.includes('context_length_exceeded') ||
      text.includes('context length') ||
      text.includes('maximum context') ||
      text.includes('prompt is too long')
    );
  }

  isSessionNotFoundError(errorMessage: string): boolean {
    // Verified live (bogus resume id, 0.152.1, stderr, exit 1):
    // "Error: thread/resume: thread/resume failed: no rollout found for
    //  thread id 99999999-… (code -32600)"
    return (
      errorMessage.includes('no rollout found for thread id') ||
      errorMessage.includes('session not found') ||
      errorMessage.includes('thread not found')
    );
  }

  /**
   * Codex-specific failure classification.
   *
   * Messages verified against codex-cli 0.152.1:
   * - missing env key: `Missing environment variable: \`OPENAI_API_KEY\`.`
   *   (turn.failed on stdout, exit 1)
   * - bad key (real api.openai.com 401): "unexpected status 401 Unauthorized:
   *   Incorrect API key provided … auth error code: invalid_api_key"
   * - not logged in: `codex login status` prints "Not logged in" (exit 1) —
   *   an exec turn without any auth source surfaces the missing-env message
   *   above when lazy's provider block is in place.
   * Quota/rate-limit spellings below are OpenAI's documented error codes and
   * could not be triggered without real credentials — see the task journal's
   * pairing checklist.
   */
  classifyFailure(input: AgentFailureInput): AgentFailure {
    const text = failureHaystack(input);

    // lazy's own refusal to launch without a model (src/agent/launch-model.ts).
    const noModel = classifyNoModelRefusal(input);
    if (noModel) return noModel;

    // Binary not installed (the spawn wrapper's ENOENT diagnosis). Fatal —
    // retrying can never install it — and the reason carries the install hint,
    // because this is exactly what a custom Dockerfile without the codex
    // install line produces.
    if (/spawn failed: binary 'codex' not found/.test(text)) {
      return {
        class: 'fatal_config',
        reason: `codex is not installed in this environment. ${CODEX_INSTALL_HINT}`,
      };
    }

    // Lazy's provider block reads the key from the environment; a launch that
    // lost it can only fail the same way forever.
    if (text.includes('missing environment variable') && text.includes('openai_api_key')) {
      return {
        class: 'fatal_auth',
        reason:
          'Codex found no OPENAI_API_KEY in its environment — set one with ' +
          '`lazy system agent set-key codex`',
      };
    }

    // OpenAI's exhausted-billing error. Deliberately BEFORE the common
    // signals: its body usually also carries a 429, which would otherwise
    // classify as transient_overload and burn the retry ladder on a wall that
    // only a billing change clears. `insufficient_quota` is the documented
    // discriminator between "slow down" (transient) and "out of money"
    // (fatal) on OpenAI's wire.
    if (text.includes('insufficient_quota') || text.includes('exceeded your current quota')) {
      return {
        class: 'fatal_auth',
        reason: 'OpenAI reports the account is out of quota (billing) — a human must top up or switch models',
      };
    }

    if (
      text.includes('invalid_api_key') ||
      text.includes('incorrect api key') ||
      text.includes('not logged in') ||
      text.includes('codex login')
    ) {
      return { class: 'fatal_auth', reason: 'Codex CLI is not authenticated' };
    }

    // "The model `x` does not exist or you do not have access to it." — the
    // API's wording for a bad -m value. Nothing heals inside the turn; a
    // human must pick a model the account can use.
    if (/model .{0,60}(does not exist|not found|do not have access)/.test(text) || text.includes('model_not_found')) {
      return { class: 'fatal_config', reason: 'OpenAI rejected the model id — pick one this account can use' };
    }

    return (
      classifyCommonFailureSignals(input, [LAUNCH_BINARY]) ?? {
        class: 'unknown',
        reason: 'unrecognized Codex failure',
      }
    );
  }

  defaultWatchdogTimeoutMs(): number {
    // 0 = "no agent-specific default". Codex emits a JSONL activity stream, so
    // the supervisor measures silence between forward-progress events, same as
    // Claude Code; the configured [agent] watchdog_output_timeout_ms applies.
    return 0;
  }

  defaultModel(): string {
    // Let codex pick: lazy's `[models] default` is an Anthropic model name
    // chosen for Claude Code, and passing it to `-m` would fail every turn.
    // See CODEX_DEFAULT_MODEL for why this is a named sentinel rather than
    // null or an omitted flag.
    return CODEX_DEFAULT_MODEL;
  }

  activityStream(): CodexActivityStream {
    return new CodexActivityStream();
  }

  supportsPairing(): boolean {
    // Both Agent.supportsPairing() conditions hold, the same way they do for
    // Cursor: pairing runs INSIDE the task container on the same mounted
    // ~/.codex the supervised turns wrote (nothing crosses the boundary), and
    // the thread id on the session record lets the interactive session resume
    // with the work in it.
    return true;
  }

  buildInteractiveArgs(opts: {
    sessionId?: string | null;
    modelId?: string | null;
    dangerouslySkipPermissions: boolean;
  }): string[] {
    // Interactive TUI: `codex [PROMPT]` with no subcommand; resume is the
    // top-level `codex resume <id>`. No --json (that is the machine surface).
    const args = opts.sessionId ? [LAUNCH_BINARY, 'resume', opts.sessionId] : [LAUNCH_BINARY];
    if (opts.dangerouslySkipPermissions) {
      // Same trust decision as a supervised turn: this runs in the task's
      // container, so codex's own sandbox is redundant and breaks git/network.
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    pushCodexModel(args, opts.modelId);
    return args;
  }

  discoverSessionFiles(opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // Rollouts live at <configDir>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
    // (verified, 0.152.1). The filename embeds the thread id, so a sessionId
    // filter is a substring match on the basename.
    const configDir = opts.configDir ?? join(getHome(), '.codex');
    const sessionsDir = join(configDir, 'sessions');
    if (!existsSync(sessionsDir)) return [];

    const results: string[] = [];
    const walk = (dir: string, depth: number): void => {
      let entries: import('fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // Directory vanished between listing and descent — nothing to report.
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Bounded: sessions/YYYY/MM/DD is exactly 3 levels of directories.
          if (depth < 3) walk(full, depth + 1);
        } else if (
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith('.jsonl') &&
          (!opts.sessionId || entry.name.includes(opts.sessionId))
        ) {
          results.push(full);
        }
      }
    };
    walk(sessionsDir, 0);
    return results.sort();
  }
}
