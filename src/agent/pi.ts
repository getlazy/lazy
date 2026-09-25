/**
 * PiAgent — Agent implementation for the pi coding agent CLI (pi.dev).
 *
 * Everything here was verified against the REAL binary, pi 0.84.4
 * (add-pi-agent, 2026-09-02) — see that task's journal for the captured wire
 * and stream output. Key facts:
 *
 * - Headless mode is `pi -p --mode json "<prompt>"`: stdout is a JSONL event
 *   stream (session header, agent/turn/message lifecycle, tool_execution_*,
 *   agent_end). The final assistant message rides `agent_end` / the last
 *   assistant `message_end`.
 * - `--append-system-prompt` exists natively and lands in the Messages API
 *   `system` field (captured).
 * - `--session-id <uuid>` is create-or-resume with an EXACT id; the session
 *   file lands under `~/.pi/agent/sessions/--<cwd-with-dashes>--/`. Resume
 *   verified: the next request body carries the prior turn's messages.
 * - `--thinking <level>` accepts off|minimal|low|medium|high|xhigh|max — a
 *   superset of lazy's effort levels, passed through 1:1. The flag is only a
 *   REQUEST: pi resolves it against the selected model's declared thinking
 *   levels and clamps it, so for the custom providers the per-turn models.json
 *   has to declare the model reasoning-capable or every effort collapses to
 *   `off` (src/agent/pi-turn-config.ts).
 * - pi has NO permission prompts, NO plan mode, and NO built-in MCP (all by
 *   design — extensions provide tools). Plan/ask turns therefore run with a
 *   read-only builtin toolset (`--tools read,grep,find,ls`), and lazy's MCP
 *   tools arrive via a per-turn extension bridge (src/agent/pi-turn-config.ts).
 * - PROVIDERS: pi talks to 15+ providers, but every byte of lazy agent traffic
 *   must leave through lazy's proxy, so lazy supports exactly the pi providers
 *   the proxy can front — `anthropic` and `ollama` on the Anthropic wire (the
 *   Anthropic upstream, and any Anthropic-compatible one: local Ollama,
 *   ollama.com, a self-hosted gateway) and `openai` on the OpenAI wire
 *   (`/v1/chat/completions`, the proxy's `openai` allowlist tier: api.openai.com,
 *   OpenRouter) — and REFUSES anything else at launch. The provider is chosen by
 *   the task's AGENT PROFILE (`[agents.<name>]`) rather than by the task itself —
 *   `endpoint` is what picks it, since the profile's wire follows from harness +
 *   endpoint — and is delivered via {@link LAZY_PI_PROVIDER_ENV}; pi's provider
 *   base URLs are pinned to the proxy by the per-turn ~/.pi/agent/models.json
 *   write. A task's model is just the model: no lazy spelling selects a
 *   provider through the model string.
 * - DEFAULT UPSTREAM: the built-in `pi` profile points at a LOCAL OLLAMA
 *   (HARNESS_DEFAULT_ENDPOINT / HARNESS_DEFAULT_MODEL in
 *   src/config/agent-profiles.ts), not Anthropic. pi is lazy's local-model
 *   agent, so `--agent pi` must not quietly spend an Anthropic credential;
 *   Anthropic remains available to anyone who declares a profile for it.
 * - `-p` HANGS when stdin is an open pipe (reproduced); the runner spawns
 *   agents with stdin ignored, which is what avoids it.
 */

import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { getHome } from '../utils/home';
import type { AgentResponse, AgentTokenUsage } from '../types';
import type { Agent } from './interface';
import type { AgentActivityEvent, AgentActivityStream } from './activity-stream';
import { safeArgvPrompt } from './argv-safety';
import { classifyNoModelRefusal, requireLaunchModel } from './launch-model';
import { PI_INSTALL_HINT, PiPackaging } from './pi-packaging';
import { piUpstreamExamples } from '../config/agent-profile-advice';
import {
  classifyCommonFailureSignals,
  failureHaystack,
  type AgentFailure,
  type AgentFailureInput,
} from './failure-taxonomy';

const LAUNCH_BINARY = new PiPackaging().binaryName();

/**
 * Launch env var carrying which pi provider this turn runs on. Set by the
 * launch path from the task's resolved agent profile (anthropic | ollama |
 * openai); absent means anthropic. Reserved from task [env] via the LAZY_ prefix.
 */
export const LAZY_PI_PROVIDER_ENV = 'LAZY_PI_PROVIDER';

/** The pi providers lazy's proxy can front today. */
export const PI_SUPPORTED_PROVIDERS = ['anthropic', 'ollama', 'openai'] as const;
export type PiProvider = (typeof PI_SUPPORTED_PROVIDERS)[number];

/**
 * The provider NAME pi is given for each of lazy's providers — the `--provider`
 * argument and the key under `providers` in the per-turn models.json
 * (src/agent/pi-turn-config.ts). Two are pi's own; `anthropic` is its
 * built-in, and `ollama` is a custom declaration under a name pi has no
 * catalog for.
 *
 * The OpenAI wire deliberately does NOT reuse pi's built-in `openai` key.
 * VERIFIED against pi 0.84.4: a custom declaration under a built-in key is
 * MERGED with that provider's catalog, and `--provider openai --model
 * openai/gpt-4o` — an OpenRouter id — has its `openai/` prefix stripped by
 * pi and then matches the catalog's `gpt-4o`, which carries the catalog's own
 * `openai-responses` api: the turn silently leaves on the wrong wire with the
 * wrong id. Under a key pi has never heard of, the models lazy declares are
 * the only ones that exist, so every id — slashed, `openai/`-prefixed, or
 * plain — resolves to its declaration verbatim (probed: Q1–Q4 in the
 * pi-openai-providers task journal).
 */
export const PI_PROVIDER_KEY: Record<PiProvider, string> = {
  anthropic: 'anthropic',
  ollama: 'ollama',
  openai: 'lazy-openai',
};

/**
 * Write-capable builtins excluded on plan/ask turns. pi has no plan mode, so
 * read-only is expressed as a DENYLIST (mirroring Claude Code's
 * `--disallowedTools`): `--tools <allowlist>` would also strip the extension
 * tools lazy's MCP bridge registers (VERIFIED against 0.84.4 — the allowlist
 * left only builtins on the wire, the denylist kept `read` plus the bridged
 * tool), and the read-only lazy_* toolset must survive an ask turn.
 */
const PLAN_MODE_EXCLUDED_TOOLS = 'bash,edit,write,powershell';

/** Marker for lazy's own pre-flight provider refusal, matched in classifyFailure. */
const UNSUPPORTED_PROVIDER_PREFIX = 'pi provider not supported by lazy';

/**
 * Resolve this turn's provider from the launch env, refusing anything lazy's
 * proxy cannot front. The refusal is deliberately at lazy's layer: pi itself
 * would also fail (no credential for any other provider exists in the
 * container), but with a message pointing at pi's /login instead of at lazy's
 * config.
 */
export function resolvePiProvider(env: NodeJS.ProcessEnv = process.env): PiProvider {
  const raw = (env[LAZY_PI_PROVIDER_ENV] ?? 'anthropic').trim().toLowerCase();
  if ((PI_SUPPORTED_PROVIDERS as readonly string[]).includes(raw)) return raw as PiProvider;
  throw new Error(
    `${UNSUPPORTED_PROVIDER_PREFIX}: "${raw}". lazy routes every agent's model traffic ` +
    `through its own proxy, which currently fronts only these pi providers: ` +
    `${PI_SUPPORTED_PROVIDERS.join(', ')}. ${piUpstreamExamples()}`,
  );
}

/**
 * The model a pi launch runs, or a loud refusal — the shared rule
 * (requireLaunchModel, src/agent/launch-model.ts) under pi's name.
 *
 * INVARIANT (turn-model stickiness): every pi launch passes `--model`, and the
 * value is the task's persisted model (resolved on the host — see
 * src/daemon/launch-identity.ts). Without `--model` pi silently runs whatever
 * its config offers as a default, and nothing reports that it did: the exact
 * "which model is this turn running?" confusion this refusal exists to end.
 */
export function requirePiModel(modelId: string | null | undefined): string {
  return requireLaunchModel('pi', modelId);
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

/** Empty usage — pi reports usage per assistant message; missing means zero. */
function zeroUsage(): AgentTokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

interface PiAssistantSummary {
  text: string;
  usage: AgentTokenUsage;
  modelId?: string;
  errorMessage?: string;
  stopReason?: string;
}

/**
 * Fold pi's message array (from an `agent_end` event) into lazy's shape:
 * final text = the LAST assistant message's text blocks, usage = the sum over
 * every assistant message this run (each pi `usage` is per-LLM-call), model =
 * the last assistant's `model`.
 */
function summarizeAssistantMessages(messages: unknown): PiAssistantSummary | null {
  if (!Array.isArray(messages)) return null;
  const usage = zeroUsage();
  let last: Record<string, unknown> | null = null;
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const msg = entry as Record<string, unknown>;
    if (msg.role !== 'assistant') continue;
    last = msg;
    const u = msg.usage as Record<string, unknown> | undefined;
    if (u && typeof u === 'object') {
      usage.input_tokens += Number(u.input) || 0;
      usage.output_tokens += Number(u.output) || 0;
      usage.cache_creation_input_tokens! += Number(u.cacheWrite) || 0;
      usage.cache_read_input_tokens! += Number(u.cacheRead) || 0;
    }
  }
  if (!last) return null;

  const parts: string[] = [];
  if (Array.isArray(last.content)) {
    for (const block of last.content) {
      if (!block || typeof block !== 'object') continue;
      const rec = block as Record<string, unknown>;
      if (rec.type === 'text' && typeof rec.text === 'string' && rec.text.trim()) {
        parts.push(rec.text);
      }
    }
  }
  return {
    text: parts.join('\n\n').trim(),
    usage,
    modelId: typeof last.model === 'string' && last.model.trim() ? last.model.trim() : undefined,
    errorMessage: typeof last.errorMessage === 'string' ? last.errorMessage : undefined,
    stopReason: typeof last.stopReason === 'string' ? last.stopReason : undefined,
  };
}

/**
 * The self-contained result line lazy synthesizes from pi's stream.
 *
 * pi's own `agent_end` line does not carry the session id (that is on the
 * stream's FIRST line, the session header), but the supervisor's watchdog
 * hands `Agent.parseResponse` exactly one retained result line on the happy
 * path — so the line must stand alone. `PiActivityStream` folds the remembered
 * session id and the agent_end summary into this shape.
 */
interface PiResultLine {
  type: 'pi_result';
  result: string;
  session_id: string;
  usage: AgentTokenUsage;
  model_id?: string;
  error_message?: string;
  stop_reason?: string;
}

function buildPiResultLine(sessionId: string, summary: PiAssistantSummary): PiResultLine {
  return {
    type: 'pi_result',
    result: summary.text,
    session_id: sessionId,
    usage: summary.usage,
    ...(summary.modelId ? { model_id: summary.modelId } : {}),
    ...(summary.errorMessage ? { error_message: summary.errorMessage } : {}),
    ...(summary.stopReason ? { stop_reason: summary.stopReason } : {}),
  };
}

/**
 * Name lazy's OWN proxy when the provider error pi recorded came from it.
 *
 * pi reports a proxy refusal verbatim — `502 {"type":"error","error":{"type":
 * "proxy_error","message":"…"}}` — which reads as an opaque upstream failure.
 * It is not: it is lazy's proxy saying it could not complete the call, and the
 * message inside is the actionable half. Saying so turns "the agent crashed"
 * into "lazy's proxy gave up talking to the model upstream: <why>", which is
 * what nobody could see during the 2026-09-16 local-Ollama incident.
 *
 * The raw text is always kept: classifyFailure reads it for the retry decision,
 * and a gloss that replaced the evidence would be worse than none.
 */
function describePiProviderError(errorMessage: string): string {
  if (!errorMessage.includes('proxy_error')) return errorMessage;
  return `lazy's proxy could not complete this request to the model upstream — ${errorMessage}`;
}

function responseFromResultLine(obj: PiResultLine): AgentResponse {
  if (obj.stop_reason === 'error' || obj.error_message) {
    // The provider (or pi) errored the final message. Surface pi's own text —
    // classifyFailure reads it for the retry decision.
    throw new Error(
      `pi turn ended in error${obj.error_message ? `: ${describePiProviderError(obj.error_message)}` : ''}`,
    );
  }
  if (!obj.result) {
    throw new Error('pi turn produced no assistant text (empty final message)');
  }
  const response: AgentResponse = {
    result: obj.result,
    session_id: obj.session_id,
    usage: obj.usage ?? zeroUsage(),
  };
  return obj.model_id ? { ...response, model_id: obj.model_id } : response;
}

/**
 * Parser for pi's `--mode json` JSONL stream (shapes verified against 0.84.4
 * and documented in the npm package's own docs/json.md).
 *
 * Stateful on purpose: the session id arrives on the FIRST line (the session
 * header) while the final messages arrive on the LAST (`agent_end`), and the
 * `result` event must be self-contained (see {@link PiResultLine}).
 */
export class PiActivityStream implements AgentActivityStream {
  private sessionId: string | undefined;

  parseLine(line: string): AgentActivityEvent | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Partial line at a kill boundary, or unstructured chatter — not an
      // error, and deliberately not progress (we cannot tell what it was).
      return null;
    }

    const type = typeof msg.type === 'string' ? msg.type : '';

    if (type === 'session') {
      if (typeof msg.id === 'string') this.sessionId = msg.id;
      return { kind: 'session_start', sessionId: this.sessionId };
    }

    if (type === 'tool_execution_start') {
      return {
        kind: 'tool_start',
        toolUseId: typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined,
        toolName: typeof msg.toolName === 'string' ? msg.toolName : undefined,
      };
    }

    if (type === 'tool_execution_end') {
      return {
        kind: 'tool_end',
        toolUseId: typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined,
      };
    }

    if (type === 'agent_end') {
      const summary = summarizeAssistantMessages(msg.messages);
      if (!summary || !this.sessionId) {
        // A truncated agent_end (kill mid-write) or a stream whose header was
        // never seen. Without both halves there is no self-contained result —
        // report progress and let parseResponse (full stdout) or the salvage
        // path handle the turn end.
        return { kind: 'progress' };
      }
      return {
        kind: 'result',
        sessionId: this.sessionId,
        raw: JSON.stringify(buildPiResultLine(this.sessionId, summary)),
      };
    }

    // Everything else — agent_start, turn_start/end, message lifecycle and
    // deltas, tool_execution_update, queue/compaction events — is evidence the
    // turn is advancing. pi has no heartbeat-shaped keep-alive event (its
    // message_update deltas are real model output), so nothing maps to
    // `heartbeat`. Unknown future event types count as progress for the same
    // reason ClaudeCodeActivityStream counts them: mistaking real progress for
    // silence is the expensive error.
    return { kind: 'progress' };
  }
}

export class PiAgent implements Agent {
  readonly id = 'pi';

  getAuthEnvVars(): Array<{ key: string; value: string }> {
    // pi holds no credential of its own: turns ride lazy's Anthropic/Ollama/
    // OpenAI credentials (as per-launch proxy placeholders) in env vars pi
    // reads natively. ANTHROPIC_AUTH_TOKEN is included because every profile
    // that is not plain Anthropic — an Ollama server, an OpenAI-wire upstream —
    // carries its placeholder there (see resolveProfileLaunchCreds and
    // LOCAL_BACKEND_CREDS); the models.json this turn wrote points the matching
    // pi provider at it.
    const vars: Array<{ key: string; value: string }> = [];
    if (process.env.ANTHROPIC_API_KEY) {
      vars.push({ key: 'ANTHROPIC_API_KEY', value: process.env.ANTHROPIC_API_KEY });
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      vars.push({ key: 'ANTHROPIC_AUTH_TOKEN', value: process.env.ANTHROPIC_AUTH_TOKEN });
    }
    if (vars.length === 0) {
      throw new Error(
        'Authentication required for the pi agent. pi tasks use lazy\'s Anthropic, Ollama or ' +
        'OpenAI credentials via the proxy — set ANTHROPIC_API_KEY, or give the task an agent ' +
        'profile with an `endpoint` and a stored `credential` (lazy auth set <name>).',
      );
    }
    return vars;
  }

  hasAuthEnv(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
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
    // Provider comes from lazy's launch env, never from the task or the model
    // string. Throws (fatal_config) on anything the proxy cannot front.
    const provider = resolvePiProvider();

    // pi's --model also accepts "provider/id" and ":<thinking>" spellings. On
    // the BUILT-IN anthropic provider a "provider/id" is never a real model:
    // pi keeps the explicit --provider, warns "not found … using custom model
    // id", and the request then fails at Anthropic with a model-not-found
    // (VERIFIED, 0.84.4) — so refuse it here, where the message can name the
    // fix. On the CUSTOM providers (ollama, openai) every model this turn may
    // name is DECLARED in the per-turn models.json and resolves to that
    // declaration verbatim (VERIFIED: `anthropic/claude-sonnet-4.5`,
    // `openai/gpt-4o`, `hf.co/unsloth/foo` — see docs/pi-agent-integration.md).
    // Slashed ids are simply what OpenRouter models, and hf.co/… models on
    // Ollama, are called, so they pass through there.
    const modelId = requirePiModel(opts.modelId);
    if (provider === 'anthropic' && modelId && modelId.includes('/')) {
      throw new Error(
        `${UNSUPPORTED_PROVIDER_PREFIX}: model "${modelId}" carries a pi provider prefix. ` +
        `lazy selects the provider itself (${PI_SUPPORTED_PROVIDERS.join(', ')} via its proxy) ` +
        `from the task's agent profile; set a bare model name on the task or in lazy.toml instead.`,
      );
    }

    // SECURITY (same family as cursor's --approve-mcps omission):
    // --no-approve pins project trust OFF for this run, so a checked-in
    // .pi/extensions|settings.json|SYSTEM.md can never load — those run
    // arbitrary code / rewrite the system prompt on trust, and a task branch is
    // agent-writable. Non-interactive pi already defaults to ignoring them, but
    // a global settings file with defaultProjectTrust: "always" would flip that
    // — the flag closes the hole regardless of home-dir state.
    const args = [
      'pi',
      '-p',
      '--mode',
      'json',
      '--no-approve',
      '--provider',
      PI_PROVIDER_KEY[provider],
    ];

    if (opts.permissionMode === 'plan') {
      // pi has no plan mode and no permission prompts; excluding its
      // write-capable builtins is the honest equivalent. Lazy's MCP write
      // tools are withheld separately by the read-only MCP scope
      // (prepareTurnMcp), so what remains is `read` plus read-only lazy_* tools.
      args.push('--exclude-tools', PLAN_MODE_EXCLUDED_TOOLS);
    }
    // dangerouslySkipPermissions is meaningless to pi — it never prompts. The
    // container boundary is the isolation, exactly as for cursor --force.

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', safeArgvPrompt(opts.systemPrompt, 'system prompt'));
    }

    if (opts.sessionId) {
      // Exact-id create-or-resume (verified): the same id resumes the same
      // session file across supervisor relaunches in the same cwd.
      args.push('--session-id', opts.sessionId);
    }

    args.push('--model', modelId);

    if (opts.effort) {
      // lazy's effort levels (low..max) are a subset of pi's --thinking levels.
      args.push('--thinking', opts.effort);
    }

    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    // Prompt is the last positional argument. A raw NUL anywhere in argv is
    // fatal to the spawn, so escape rather than let the turn crash-loop.
    args.push(safeArgvPrompt(opts.prompt, 'prompt'));

    return args;
  }

  /**
   * Parse pi output into an AgentResponse.
   *
   * Accepts, in order of preference:
   *  - the self-contained `pi_result` line the activity stream synthesized
   *    (what the watchdog retains on the happy path),
   *  - the full `--mode json` JSONL stream (push-back/maintain turns hand raw
   *    stdout over): session header supplies the id, the last `agent_end`
   *    supplies messages/usage.
   */
  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Failed to parse pi output: empty stdout');
    }

    const single = tryParseObject(trimmed);
    if (single && single.type === 'pi_result') {
      return responseFromResultLine(single as unknown as PiResultLine);
    }

    const lines = trimmed.split('\n');
    let sessionId: string | undefined;
    let summary: PiAssistantSummary | null = null;
    const typesSeen = new Set<string>();
    for (const line of lines) {
      const obj = tryParseObject(line.trim());
      if (!obj) continue;
      const type = typeof obj.type === 'string' ? obj.type : '';
      if (type) typesSeen.add(type);
      if (type === 'session' && typeof obj.id === 'string') {
        sessionId = obj.id;
      } else if (type === 'pi_result') {
        return responseFromResultLine(obj as unknown as PiResultLine);
      } else if (type === 'agent_end') {
        summary = summarizeAssistantMessages(obj.messages) ?? summary;
      }
    }

    if (!sessionId || !summary) {
      throw new Error(
        `Failed to parse pi output: missing ${sessionId ? 'agent_end messages' : 'session header'} ` +
        `(${lines.length} line(s), ${stdout.length} bytes, event types seen: ` +
        `${[...typesSeen].join(', ') || '(none)'})`,
      );
    }
    return responseFromResultLine(buildPiResultLine(sessionId, summary));
  }

  isPromptTooLongError(errorMessage: string): boolean {
    return (
      errorMessage.includes('Prompt is too long') ||
      errorMessage.includes('prompt is too long') ||
      errorMessage.includes('context length exceeded') ||
      errorMessage.includes('exceeds the context window')
    );
  }

  isSessionNotFoundError(errorMessage: string): boolean {
    // --session-id is create-or-resume (a missing id creates the session and
    // only warns), so this should never fire; matched anyway for the --session
    // spelling and future dialect drift.
    return (
      errorMessage.includes('No session found') ||
      errorMessage.includes('session not found') ||
      errorMessage.includes('No project session found')
    );
  }

  /**
   * pi-specific failure classification.
   *
   * Messages verified against pi 0.84.4:
   * - no credential:      "No API key found for <provider>." + /login hint (stderr, exit 1)
   * - unknown provider:   "Unknown provider \"x\". Use --list-models …" (stderr, exit 1)
   * Everything else falls through to the shared HTTP/network signals.
   */
  classifyFailure(input: AgentFailureInput): AgentFailure {
    const text = failureHaystack(input);

    // Binary not installed (the spawn wrapper's ENOENT diagnosis). Fatal —
    // retrying can never install it — and the reason carries the install hint,
    // which is exactly what a custom Dockerfile without pi's install produces.
    if (/spawn failed: binary 'pi' not found/.test(text)) {
      return {
        class: 'fatal_config',
        reason: `pi is not installed in this environment. ${PI_INSTALL_HINT}`,
      };
    }

    // lazy's own pre-flight refusals (resolvePiProvider / the model-prefix
    // guard in buildExecArgs). Every launch fails identically until config
    // changes.
    const noModel = classifyNoModelRefusal(input);
    if (noModel) return noModel;
    if (text.includes('pi provider not supported by lazy')) {
      return { class: 'fatal_config', reason: 'this pi provider is not supported by lazy (anthropic, ollama, openai only)' };
    }

    if (text.includes('no api key found for') || text.includes('use /login')) {
      return { class: 'fatal_auth', reason: 'pi found no usable credential for this provider' };
    }

    if (
      text.includes('unknown provider') ||
      text.includes('unknown option') ||
      text.includes('no models matching') ||
      text.includes('unknown model')
    ) {
      return { class: 'fatal_config', reason: 'pi rejected the invocation (model, provider, or flag)' };
    }

    return (
      classifyCommonFailureSignals(input, [LAUNCH_BINARY]) ?? {
        class: 'unknown',
        reason: 'unrecognized pi failure',
      }
    );
  }

  defaultWatchdogTimeoutMs(): number {
    // pi emits a real event stream (see PiActivityStream), so the supervisor
    // measures silence between forward-progress events; the configured
    // watchdog default applies, same as Claude Code.
    return 0;
  }

  defaultModel(): null {
    // No opinion: lazy's model resolution already yields something pi can run —
    // an Anthropic model name on the anthropic backend, the authoritative
    // configured model on an ollama backend. Declaring one here would hardcode
    // project policy into an agent class.
    return null;
  }

  activityStream(): PiActivityStream {
    return new PiActivityStream();
  }

  supportsPairing(): boolean {
    // Both Agent.supportsPairing() conditions hold: task-mode pairing runs
    // INSIDE the container on the same mounted ~/.pi the supervised turns use
    // (nothing crosses the boundary), and the session id on the task record
    // resumes the actual work (verified: --session-id resume carries context).
    return true;
  }

  buildInteractiveArgs(opts: {
    sessionId?: string | null;
    modelId?: string | null;
    dangerouslySkipPermissions: boolean;
  }): string[] {
    // Interactive: no -p/--mode (those make it headless), no prompt positional.
    // --no-approve for the same security reason as supervised turns: the
    // worktree may carry agent-written .pi/ resources, and a pairing human
    // should not have them auto-loaded by saying yes to a generic trust prompt.
    const args = ['pi', '--no-approve', '--provider', PI_PROVIDER_KEY[resolvePiProvider()]];
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    args.push('--model', requirePiModel(opts.modelId));
    // dangerouslySkipPermissions: pi never prompts; nothing to pass.
    return args;
  }

  discoverSessionFiles(opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // pi stores sessions at <configDir>/agent/sessions/--<cwd-dashes>--/
    // <timestamp>_<session-id>.jsonl (verified layout, and documented in the
    // package's own docs/session-format.md — a stable, versioned format).
    const configDir = opts.configDir ?? join(getHome(), '.pi');
    const sessionsDir = join(configDir, 'agent', 'sessions');
    if (!existsSync(sessionsDir)) return [];

    const results: string[] = [];
    try {
      const projectDirs = readdirSync(sessionsDir, { withFileTypes: true });
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = join(sessionsDir, projectDir.name);
        try {
          for (const file of readdirSync(projectPath)) {
            if (!file.endsWith('.jsonl')) continue;
            if (opts.sessionId && !file.endsWith(`_${opts.sessionId}.jsonl`)) continue;
            results.push(join(projectPath, file));
          }
        } catch {
          // Skip unreadable project directories — same tolerance as Claude's
          // discovery; a partial listing beats none.
        }
      }
    } catch {
      // Sessions directory unreadable: report none rather than failing capture.
    }
    return results;
  }
}
