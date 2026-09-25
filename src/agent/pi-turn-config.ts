/**
 * Per-turn pi configuration — the files a pi turn reads out of its ephemeral
 * HOME, and the launch env that governs them.
 *
 * Two files, both written on the prepareTurnMcp chokepoint (the enforced
 * per-turn place for "files this turn's agent will read out of its HOME",
 * same as cursor's cli-config):
 *
 * 1. `~/.pi/agent/models.json` — pins pi's provider base URLs to lazy's proxy.
 *    pi has no ANTHROPIC_BASE_URL env var; models.json is its documented
 *    provider-override mechanism (verified against 0.84.4: the built-in
 *    anthropic override keeps the whole catalog and the env credential; a
 *    custom `ollama` provider with api "anthropic-messages" sends real
 *    /v1/messages wire — which is exactly what the proxy's path allowlist and
 *    extractor accept, and what lazy's anthropic-wire upstreams already serve
 *    for Claude Code; and lazy's openai provider — declared under the
 *    `lazy-openai` key, see PI_PROVIDER_KEY — with api "openai-completions" at
 *    `<proxy>/v1` sends real /v1/chat/completions wire, which the proxy's
 *    openai tier forwards to the endpoint of the profile on this turn's
 *    grant). Without this file pi would dial the providers
 *    directly, outside lazy's audit plane — so a failed write FAILS THE TURN.
 *
 *    It also declares what those custom models can DO, which is not cosmetic:
 *    pi resolves the effort lazy passes on `--thinking` against the model's own
 *    declaration, so an under-declared model runs with reasoning off no matter
 *    what the task's effort says (see {@link customModelEntry}).
 *
 * 2. `~/.pi/agent/extensions/lazy-mcp.ts` — the MCP bridge. pi has no built-in
 *    MCP (deliberate, per its own docs); its extension API is the sanctioned
 *    tool surface. The bridge spawns lazy's MCP server (the same command
 *    ~/.claude.json names), lists its tools over stdio JSON-RPC, and registers
 *    each as a native pi tool. Verified end-to-end against 0.84.4: registration,
 *    a model-initiated tool call, and the result round-trip all work, and the
 *    child must be unref()'d + killed on session_shutdown or pi never exits.
 *
 * The file is rewritten every turn, so lazy's routing self-heals from any
 * in-container edit by the previous turn's agent.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { getHome } from '../utils/home';
import type { AgentProfile } from '../config/agent-profiles';
import { isAnthropicApiEndpoint } from '../config/agent-profiles';
import { LAZY_PI_PROVIDER_ENV, PI_PROVIDER_KEY, resolvePiProvider, type PiProvider } from './pi';

/**
 * Launch env var carrying the RAW ceiling lazy's proxy enforces on one model
 * request, in milliseconds (0 = no ceiling).
 *
 * It is a statement about the PROXY, assembled at launch where `config` is in
 * scope. The margin that turns it into a statement about pi — "wait LONGER
 * than the proxy could possibly wait" — is computed in this module's writer
 * ({@link writePiSettingsConfig}), so the invariant logic lives in one file.
 */
export const LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV = 'LAZY_PI_UPSTREAM_TIMEOUT_MS';

/**
 * Headroom over lazy's upstream ceiling, so pi's own idle timeout fires AFTER
 * the proxy's. pi's default is 300s — shorter than lazy's 1800s ceiling — and
 * a pi-side timeout that fires first turns a slow-but-alive request into a
 * dead turn: the upstream answered at 349s while pi had already given up at
 * 300s (the 2026-09-16 local-Ollama incident).
 */
const PI_HTTP_IDLE_TIMEOUT_MARGIN_MS = 60_000;

/**
 * Thinking levels a CUSTOM provider's model declares beyond pi's standard set,
 * per wire — the other half of `reasoning: true` (see {@link customModelEntry}).
 *
 * pi's own rule (`getSupportedThinkingLevels`, verified in 0.84.4): with
 * `reasoning: true` the levels through `high` come from the provider's default
 * mapping, but `xhigh` and `max` count as supported ONLY when the model's
 * `thinkingLevelMap` names them — an absent entry makes the level unsupported
 * and `clampThinkingLevel` walks DOWN to the nearest one that exists. lazy's
 * effort scale runs low..max, so both extended levels need declaring or the two
 * highest efforts silently land on `high`.
 *
 * The values mirror what pi's OWN catalog declares for each wire, so a lazy
 * profile behaves like the equivalent built-in model:
 *  - Anthropic wire: Claude entries carry `{xhigh: "xhigh", max: "max"}`. The
 *    string is only ever read for adaptive thinking; the request body's
 *    `budget_tokens` comes from pi's per-level budget table, where xhigh/max
 *    both take `high`'s budget.
 *  - OpenAI wire: `reasoning_effort` is the sent value, and pi's gpt-5.x entries
 *    declare `xhigh` but NOT `max` — OpenAI has no `max` effort. Leaving `max`
 *    out lets pi clamp a `max` task down to `xhigh` rather than sending a value
 *    the API rejects.
 */
const THINKING_LEVEL_MAP_FOR_PROVIDER: Record<Exclude<PiProvider, 'anthropic'>, Record<string, string>> = {
  ollama: { xhigh: 'xhigh', max: 'max' },
  openai: { xhigh: 'xhigh' },
};

/**
 * Output-token ceiling declared for an Anthropic-wire custom model.
 *
 * pi funds thinking OUT OF `max_tokens` on that wire: it asks for
 * `min(maxTokens + budget, maxTokens)` and, when the budget does not fit,
 * shrinks the budget to whatever is left above a 1024-token answer floor. With
 * pi's default `maxTokens` of 16384 and its `high` budget of 16384, a
 * high-effort turn therefore ships `budget_tokens: 15360` and leaves the answer
 * 1024 tokens — enough to truncate a real turn mid-sentence. Declaring double
 * the high budget keeps thinking at its full 16384 and leaves as much again for
 * the answer (VERIFIED against 0.84.4 by capturing the request body).
 *
 * Not declared for the OpenAI wire, where thinking is a separate
 * `reasoning_effort` and does not come out of the completion budget.
 */
const PI_ANTHROPIC_WIRE_MAX_TOKENS = 32768;

/**
 * One model entry for a custom provider's `models` list.
 *
 * `reasoning: true` is the fix for lazy's effort reaching the model at all:
 * pi's model field defaults to FALSE, and a model that cannot reason has
 * exactly one supported thinking level — `off` — so pi clamped every
 * `--thinking <effort>` lazy passed down to `off` (reported back as
 * `PI_REASONING_LEVEL=off`, and no `thinking` field in the request body at all).
 * Declaring it is lazy's only lever: a custom provider's models are whatever
 * lazy writes here, and the models.json is rewritten per turn.
 *
 * It is declared UNCONDITIONALLY, because the endpoint is a service and lazy
 * cannot know which of its models reason — and the alternative default is the
 * bug. On the Anthropic wire this is safe by inspection: an Ollama that cannot
 * reason ignores the `thinking` block (VERIFIED against Ollama 0.32.14 with a
 * non-reasoning model, which answered normally). On the OpenAI wire a model
 * with no reasoning support at all — a legacy `gpt-4o` — will reject
 * `reasoning_effort`, which is a loud, legible provider error rather than a
 * silent downgrade.
 */
function customModelEntry(provider: Exclude<PiProvider, 'anthropic'>, id: string): Record<string, unknown> {
  return {
    id,
    reasoning: true,
    thinkingLevelMap: THINKING_LEVEL_MAP_FOR_PROVIDER[provider],
    ...(provider === 'ollama' ? { maxTokens: PI_ANTHROPIC_WIRE_MAX_TOKENS } : {}),
  };
}

/** pi's config dir inside the turn's HOME. */
function piAgentDir(): string {
  return join(getHome(), '.pi', 'agent');
}

export function piModelsConfigPath(): string {
  return join(piAgentDir(), 'models.json');
}

export function piBridgeExtensionPath(): string {
  return join(piAgentDir(), 'extensions', 'lazy-mcp.ts');
}

/**
 * Which of pi's providers a profile runs.
 *
 * pi's BUILT-IN `anthropic` provider carries Anthropic's own catalog and
 * credential handling, so it is the right one whenever the upstream IS
 * Anthropic. That is no longer the harness default: a pi profile naming no
 * endpoint takes the local Ollama one (HARNESS_DEFAULT_ENDPOINT), so reaching
 * Anthropic is a profile that says so. The blank-endpoint branch below stays
 * all the same — it is what a hand-built profile or a test fixture produces,
 * and the built-in provider is still the right answer for it. The other two are
 * CUSTOM provider blocks, which declare their own models and their own auth
 * (see `writePiModelsConfig`), one per wire:
 *
 * - `openai` when the profile resolved to the OpenAI wire (api.openai.com,
 *   OpenRouter). pi's `openai-completions` api sends real
 *   POST /v1/chat/completions, which is exactly what the proxy's `openai`
 *   allowlist tier forwards.
 * - `ollama` for any other endpoint — an anthropic-wire server pi has no
 *   catalog for (a local Ollama, ollama.com, a self-hosted gateway).
 *
 * The wire is READ off the resolved profile, never re-derived from the endpoint
 * here: `wireForProfile` (src/config/agent-profiles.ts) is the one rule, and it
 * is what the proxy routes by, so a second rule in the launch path could only
 * disagree with it. The only endpoint question left is whether an
 * anthropic-wire upstream is Anthropic itself (built-in provider) or merely
 * speaks its protocol (custom provider) — which is what keeps the models.json
 * written here agreeing with the allowlist tier the proxy picked for the same
 * profile.
 *
 * The custom providers are declared under fixed KEYS ({@link PI_PROVIDER_KEY})
 * rather than the profile's name: those keys are what was verified end-to-end
 * against pi 0.84.4 (see docs/pi-agent-integration.md), and the OpenAI-wire
 * one is deliberately a name pi has no built-in catalog for, so an OpenRouter
 * id such as `openai/gpt-4o` can never be captured by pi's own `openai`
 * provider.
 */
export function piProviderForProfile(profile: Pick<AgentProfile, 'endpoint' | 'wire'>): PiProvider {
  const endpoint = profile.endpoint.trim();
  if (!endpoint) return 'anthropic';
  if (profile.wire === 'openai') return 'openai';
  return isAnthropicApiEndpoint(endpoint) ? 'anthropic' : 'ollama';
}

/**
 * Env vars a pi launch carries, beyond the credential/base-URL set every agent
 * gets. Called from the launch env assembly (host side), where the task's
 * resolved AGENT PROFILE is known. Returns [] for non-pi harnesses.
 *
 * - LAZY_PI_PROVIDER: which pi provider this turn runs. It answers "which
 *   profile did the human select", not "which role backend is configured" —
 *   the profile's endpoint is what decides (see `piProviderForProfile`), so two
 *   pi profiles in one project can run different upstreams, on different wires.
 * - NO model. The launch env is assembled from the PROFILE, whose model is a
 *   default the task stops using the moment it persists its own; a profile
 *   model in the env (it used to ride as LAZY_PI_OLLAMA_MODEL) read to the agent
 *   as "the model this turn runs" and fed models.json a silent fallback. The
 *   turn's model reaches the supervisor on the command — see
 *   `writePiModelsConfig`.
 * - PI_OFFLINE / PI_SKIP_VERSION_CHECK / PI_TELEMETRY: no startup egress —
 *   update checks, catalog refreshes and telemetry would leave the container
 *   outside the proxy's audit plane.
 *
 * `harness` is the harness the profile runs, NOT the task's `agent` — that names
 * a profile, and `[agents.local-ollama-pi] harness = "pi"` would fail an
 * `=== 'pi'` comparison and launch pi with no provider env at all.
 */
export function piLaunchEnvVars(opts: {
  harness?: string;
  /** The task's resolved agent profile — what decides provider and model. */
  profile?: Pick<AgentProfile, 'endpoint' | 'wire'>;
  /**
   * The proxy's upstream ceiling for one model request, in ms (0 = none).
   * Required so TypeScript makes every launch path state it — a launch that
   * omits it would put pi back on its 300s default, reproducing the bug.
   */
  upstreamTimeoutMs: number;
}): Array<{ key: string; value: string }> {
  if (opts.harness !== 'pi') return [];
  const provider = opts.profile ? piProviderForProfile(opts.profile) : 'anthropic';
  const vars: Array<{ key: string; value: string }> = [
    { key: LAZY_PI_PROVIDER_ENV, value: provider },
    { key: 'PI_OFFLINE', value: '1' },
    { key: 'PI_SKIP_VERSION_CHECK', value: '1' },
    { key: 'PI_TELEMETRY', value: '0' },
    { key: LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV, value: String(opts.upstreamTimeoutMs) },
  ];
  return vars;
}

/**
 * Mirror a claude-shaped credential placeholder into an env var pi reads.
 *
 * An OAuth-credentialed daemon mints the launch placeholder into
 * CLAUDE_CODE_OAUTH_TOKEN, which pi does not read. The proxy's credential
 * exchange detects placeholders BY VALUE LOOKUP across the credential headers
 * (src/proxy/inject.ts), not by which env var carried them — so mirroring the
 * same value into ANTHROPIC_AUTH_TOKEN changes nothing about attribution or
 * exchange, it only makes the value visible to pi.
 */
export function piCredentialMirror(
  authEnvVars: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const has = (key: string) => authEnvVars.some((v) => v.key === key);
  if (has('ANTHROPIC_API_KEY') || has('ANTHROPIC_AUTH_TOKEN')) return [];
  const oauth = authEnvVars.find((v) => v.key === 'CLAUDE_CODE_OAUTH_TOKEN');
  return oauth ? [{ key: 'ANTHROPIC_AUTH_TOKEN', value: oauth.value }] : [];
}

/**
 * Write `~/.pi/agent/models.json`, wholesale.
 *
 * Deliberately NOT a merge: lazy owns this file in the turn's sandbox HOME,
 * and rewriting it each turn means an agent-edited base URL (a would-be proxy
 * bypass) does not survive into the next turn. There is no user state to
 * preserve here — the sandbox home starts empty.
 *
 * Reads the proxy address and provider from the launch env (ANTHROPIC_BASE_URL,
 * LAZY_PI_PROVIDER) — the same env the supervisor inherited from the launch
 * assembly, which is where the task's agent profile was resolved.
 *
 * `turnModel` is the ONE model this turn runs, and the only one declared.
 * INVARIANT (turn-model stickiness): every pi turn runs the task's persisted
 * model — resolved on the host by the daemon (`resolveTurnLaunchIdentity`,
 * which falls back to the profile default only when the task has never had a
 * model, and persists that) and delivered as `cmd.model_id` (for a pair
 * session, as `--model`). A custom provider offers exactly the models declared
 * here, so declaring the profile default alongside the turn's model would hand
 * pi a silent fallback for any launch that omitted `--model`. One declared
 * model, and a refusal when there is none, makes "which model is this turn?"
 * answerable by reading one file.
 */
export async function writePiModelsConfig(opts: { turnModel: string | null | undefined }): Promise<void> {
  const provider = resolvePiProvider();
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      'ANTHROPIC_BASE_URL is not set in this turn\'s environment, so pi\'s providers cannot be ' +
      'pinned to lazy\'s proxy. Refusing to run an unproxied pi turn — this indicates a launch-path ' +
      'bug (the daemon sets the proxied base URL on every agent launch).',
    );
  }

  const providers: Record<string, unknown> = {
    // Built-in provider override: catalog and env-credential handling stay
    // native, only the base URL moves to the proxy. Pinned on EVERY turn
    // (openai ones included) so no pi provider ever has a direct-egress base.
    anthropic: { baseUrl },
  };

  if (provider !== 'anthropic') {
    const turnModel = opts.turnModel?.trim();
    if (!turnModel) {
      throw new Error(
        `${LAZY_PI_PROVIDER_ENV}=${provider} but this turn names no model, so there is nothing ` +
        'to declare in pi\'s models.json. Refusing to run pi on a model nobody chose — this is a ' +
        'launch-path bug: every turn and pair session carries the task\'s model (or its profile\'s ' +
        'default, resolved on the host). `lazy edit <task> --model <name>` pins one explicitly.',
      );
    }
    const models = [customModelEntry(provider, turnModel)];
    // Both custom providers read the SAME env var for their key: the launch
    // places every non-Anthropic credential in ANTHROPIC_AUTH_TOKEN
    // (resolveProfileLaunchCreds), as a per-launch PLACEHOLDER. The proxy
    // matches it by value across the credential headers and swaps in the real
    // key for this profile's upstream — routing is by the grant's PROFILE,
    // never by which env var carried the placeholder.
    providers[PI_PROVIDER_KEY[provider]] = provider === 'ollama'
      ? {
          baseUrl,
          // Anthropic wire, NOT pi's default OpenAI-compat route: on this wire
          // the proxy forwards only the model API surface (/v1/messages …),
          // and lazy's anthropic-wire upstreams already serve it for Claude Code.
          api: 'anthropic-messages',
          apiKey: '$ANTHROPIC_AUTH_TOKEN',
          models,
        }
      : {
          // Chat Completions wire at the proxy root's /v1: the profile resolved
          // to the openai wire, so the proxy put this turn on its `openai`
          // allowlist tier, which forwards exactly POST /v1/chat/completions
          // (plus model discovery) to the profile's endpoint.
          baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
          api: 'openai-completions',
          apiKey: '$ANTHROPIC_AUTH_TOKEN',
          models,
        };
  }

  await mkdir(piAgentDir(), { recursive: true });
  await writeFile(piModelsConfigPath(), JSON.stringify({ providers }, null, 2) + '\n', 'utf-8');
}

export function piSettingsConfigPath(): string {
  return join(piAgentDir(), 'settings.json');
}

/**
 * Read the pi-side request timeout off the launch env, in milliseconds.
 *
 * - absent → undefined (the writer refuses: without the env the launch path is
 *   broken, and pi would silently run its 300s default);
 * - `0` → 0 (pi treats 0 as "no timeout" — matches the proxy's 0 = no ceiling);
 * - otherwise the proxy ceiling PLUS {@link PI_HTTP_IDLE_TIMEOUT_MARGIN_MS}.
 */
export function piHttpIdleTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV} must be a non-negative number of milliseconds ` +
      `(0 = no ceiling), got "${raw}".`,
    );
  }
  return parsed === 0 ? 0 : parsed + PI_HTTP_IDLE_TIMEOUT_MARGIN_MS;
}

/**
 * Write pi's request timeout into the GLOBAL settings file
 * (`~/.pi/agent/settings.json`), merging with whatever is already there.
 *
 * pi kills a request whose upstream has been silent for `httpIdleTimeoutMs`
 * (settings key of `core/settings-manager.js`, default 300_000 — see pi
 * 0.84.4), and the key can only be set through a settings file. The GLOBAL
 * file is the right one: `--no-approve` pins project trust off, so a
 * `<worktree>/.pi/settings.json` would not load — and writing it would dirty
 * the task branch anyway.
 *
 * Merge, not wholesale: unlike models.json (which lazy owns outright), the
 * settings file may carry real state in this HOME. Only `httpIdleTimeoutMs` is
 * lazy's key, and it is OVERWRITTEN every turn so a stale value cannot outlive
 * a config change.
 */
export async function writePiSettingsConfig(): Promise<void> {
  const timeoutMs = piHttpIdleTimeoutMsFromEnv();
  if (timeoutMs === undefined) {
    throw new Error(
      `${LAZY_PI_UPSTREAM_TIMEOUT_MS_ENV} is not set in this turn's environment, so pi's request ` +
      'timeout cannot be pinned above lazy\'s proxy ceiling — the turn would die at pi\'s own ' +
      '300s default while the proxy was still serving it. This indicates a launch-path bug ' +
      '(the daemon sets the proxy ceiling on every agent launch).',
    );
  }

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(piSettingsConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json exists but is not a JSON object');
    }
    existing = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not pin pi's request timeout in ${piSettingsConfigPath()} — refusing to run a turn ` +
        `that would keep pi's 300s default and die mid-proxy-wait. Fix or move that file aside ` +
        `and re-run the turn.\n  Cause: ${detail}`,
      );
    }
    // No file yet — this HOME has no pi settings; write one fresh.
    existing = {};
  }

  const settings = { ...existing, httpIdleTimeoutMs: timeoutMs };
  await mkdir(piAgentDir(), { recursive: true });
  await writeFile(piSettingsConfigPath(), JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Write the lazy MCP bridge extension for this turn.
 *
 * The MCP server command is baked into the generated file (it changes per turn
 * with task id, worktree, and read-only scope). Global extensions
 * (~/.pi/agent/extensions) load without any trust decision, and --no-approve
 * only blocks PROJECT-local resources — so the bridge loads while a checked-in
 * .pi/extensions does not.
 */
export async function writePiBridgeExtension(
  mcpServerConfig: { command: string; args: string[] },
): Promise<void> {
  const extensionsDir = join(piAgentDir(), 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  const commandJson = JSON.stringify({
    command: mcpServerConfig.command,
    args: mcpServerConfig.args,
  });
  const source = PI_BRIDGE_TEMPLATE.replace('__LAZY_MCP_COMMAND_JSON__', () => commandJson);
  await writeFile(piBridgeExtensionPath(), source, 'utf-8');
}

/**
 * The bridge source. Kept as a template string rather than a standalone asset
 * so the single-binary build carries it without a loader special case; it is
 * TypeScript for PI's runtime, not for lazy's compiler.
 *
 * Verified end-to-end against pi 0.84.4 (see the add-pi-agent journal):
 * async factories are awaited before session start, MCP inputSchema objects
 * are accepted as `parameters` verbatim, thrown errors set isError on the
 * tool result, and the unref()+kill pair is what lets pi exit cleanly.
 */
const PI_BRIDGE_TEMPLATE = `// lazy MCP bridge — GENERATED BY LAZY EVERY TURN; edits do not survive.
// Spawns lazy's MCP server and registers its tools as native pi tools.
import { spawn } from "node:child_process";

const MCP_SERVER = __LAZY_MCP_COMMAND_JSON__;

/** Newline-delimited JSON-RPC client over the MCP server's stdio. */
class McpClient {
  constructor(command, args) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    // Without unref, the child keeps pi's event loop alive after agent_end and
    // a -p run never exits (reproduced against 0.84.4).
    this.child.unref();
    this.child.on("exit", (code) => {
      const err = new Error("lazy MCP server exited" + (code === null ? "" : " with code " + code));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf("\\n")) !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
          else p.resolve(msg.result);
        }
      }
    });
  }

  request(method, params, timeoutMs = 300000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("lazy MCP request " + method + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
  }

  kill() {
    try { this.child.kill(); } catch { /* already dead */ }
  }
}

export default async function (pi) {
  const client = new McpClient(MCP_SERVER.command, MCP_SERVER.args);
  pi.on("session_shutdown", async () => { client.kill(); });

  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lazy-pi-bridge", version: "1" },
  }, 60000);
  client.notify("notifications/initialized");

  const listed = await client.request("tools/list", {}, 60000);
  for (const tool of listed.tools ?? []) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      // MCP inputSchema is plain JSON Schema, which pi accepts verbatim.
      parameters: tool.inputSchema,
      async execute(_toolCallId, params) {
        // Long default timeout: lazy_wait legitimately blocks for many minutes.
        const result = await client.request(
          "tools/call",
          { name: tool.name, arguments: params ?? {} },
          45 * 60 * 1000,
        );
        const blocks = Array.isArray(result?.content) ? result.content : [];
        const text = blocks
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\\n");
        if (result?.isError) throw new Error(text || "lazy MCP tool call failed");
        return { content: [{ type: "text", text: text || "(no output)" }], details: {} };
      },
    });
  }
}
`;
