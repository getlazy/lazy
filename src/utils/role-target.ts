/**
 * Per-role model target resolution.
 *
 * This is the SINGLE decision point for "which model + which backend does this
 * role run against". It collapses the logic that used to be duplicated at every
 * launch site (`if ollama.enabled force ollama.model`) into one resolver, and
 * generalizes it from ollama-only to anthropic / ollama / proxy backends.
 *
 * Two guardrails are baked in here (see CLAUDE.md: fail hard, least surprise):
 *  - No silent name substitution: an ollama/proxy role with no configured model
 *    throws rather than guessing.
 *  - The resolved model is authoritative for non-anthropic backends — alias names
 *    like "claude-opus-4-8" don't exist there, so a caller's preferred model is
 *    intentionally ignored for those backends.
 *
 * Reachability preflight (`preflightRoleTarget`) lives here too so every launch
 * path enforces the same fail-hard contract: an unreachable local backend fails
 * with an actionable error and NEVER silently falls back to a different backend.
 */

import type { ResolvedConfig, RoleName, RoleTarget } from '../config/types';
import { spawn } from './spawn';

export interface AuthEnvVar {
  key: string;
  value: string;
}

export interface ResolvedRoleTarget {
  backend: RoleTarget['backend'];
  /** Resolved model to pass to the agent via `--model` (empty string ⇒ caller decides the fallback). */
  model: string;
  /** ANTHROPIC_BASE_URL for ollama/proxy; empty for anthropic. */
  endpoint: string;
}

/**
 * The anthropic-default target: "use the normal Anthropic model chain". Used as
 * the fallback for runners that have no per-role targets set (the in-container
 * supervisor's runner), preserving credential-inheritance behavior.
 */
export const ANTHROPIC_DEFAULT_TARGET: RoleTarget = { backend: 'anthropic', model: '', endpoint: '' };

export type TargetCheckResult =
  | { reachable: true; endpoint: string }
  | { reachable: false; endpoint: string; reason: string };

/**
 * Read the Anthropic credential from the process environment.
 *
 * The canonical, *throwing* version is ClaudeCodeAgent.getAuthEnvVars() — used at
 * launch time where a missing credential is fatal. This reader is deliberately
 * tolerant (returns []): it is used where the daemon credential gate, not this
 * function, is the enforcement point.
 */
export function anthropicEnvVarsFromProcess(): AuthEnvVar[] {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) return [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauth }];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return [{ key: 'ANTHROPIC_API_KEY', value: apiKey }];
  return [];
}

/**
 * Env vars that keep Claude Code stable when pointed at a local backend that
 * doesn't implement the full Anthropic API surface (telemetry/count_tokens
 * endpoints return 404/500 and can hang the server). See docs/spikes/local-model-agents.md §1.
 */
const LOCAL_BACKEND_STABILITY_ENV: AuthEnvVar[] = [
  { key: 'DISABLE_TELEMETRY', value: '1' },
  { key: 'DISABLE_ERROR_REPORTING', value: '1' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
];

/**
 * Compute the environment variables that point Claude Code at a resolved target.
 *
 * `anthropicCreds` is the Anthropic credential to forward — supplied by the
 * caller because its source differs by launch path (the daemon reads its own
 * process env; client launches fetch it over RPC). It is ignored for the ollama
 * backend (which uses self-contained dummy credentials).
 *
 * - ollama: dummy credentials + base URL + stability flags (fully self-contained).
 * - proxy: base URL override forwarded with the real Anthropic credential.
 * - anthropic: the real Anthropic credential.
 */
export function targetEnvVars(target: RoleTarget, anthropicCreds: AuthEnvVar[]): AuthEnvVar[] {
  switch (target.backend) {
    case 'ollama':
      return [
        { key: 'ANTHROPIC_BASE_URL', value: target.endpoint },
        { key: 'ANTHROPIC_AUTH_TOKEN', value: 'ollama' },
        { key: 'ANTHROPIC_API_KEY', value: 'ollama' },
        ...LOCAL_BACKEND_STABILITY_ENV,
      ];
    case 'proxy':
      return [
        { key: 'ANTHROPIC_BASE_URL', value: target.endpoint },
        ...anthropicCreds,
      ];
    case 'anthropic':
    default:
      return anthropicCreds;
  }
}

/**
 * Resolve the model + backend + endpoint for a role.
 *
 * @param opts.overrideModel - an EXPLICIT user override (e.g. `lazy builder
 *   --model X`). Wins over the configured model for EVERY backend: it sets the
 *   model name while the backend + endpoint (the "server") stay as configured.
 *   This makes a local [models.roles.*] entry effectively *server* configuration
 *   — its `model` is a default the explicit flag overrides, so you can point the
 *   same Ollama server at a different model without editing config.
 * @param opts.preferredModel - a SOFT default (sticky / task model). Honored for
 *   the anthropic backend; ignored for ollama/proxy, where the configured model
 *   is authoritative — otherwise an opus-defaulted task would silently clobber
 *   the local model on every ollama launch. Use overrideModel, not this, for a
 *   hard CLI override.
 * @param opts.agentId - the task's agent. Only "claude-code" can talk to a local
 *   backend; any other agent forces the anthropic path regardless of config.
 *
 * For the anthropic backend the returned model may be the empty string, meaning
 * "the caller should fall back to its own default" (e.g. config.models.default,
 * or omitting `--model` entirely). For ollama/proxy the model is always concrete
 * (the override, else the authoritative configured name) and never empty.
 */
/**
 * Short names lazy recognizes as Anthropic models, in addition to any `claude-*`
 * id. The `claude-*` prefix is the escape hatch for models newer than this list;
 * these short aliases cover the known models so users can pass `--model opus`
 * etc. Used to validate an explicit `--model` override against the anthropic
 * backend, where an unrecognized name would be handed to the Anthropic API and
 * fail opaquely — the way to run anything else is a local server (ollama/proxy).
 */
export const KNOWN_ANTHROPIC_SHORT_NAMES = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'] as const;

/** True if `model` is a model the Anthropic API can serve directly (no local server). */
export function isKnownAnthropicModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith('claude-') || (KNOWN_ANTHROPIC_SHORT_NAMES as readonly string[]).includes(m);
}

export function resolveRoleTarget(
  role: RoleName,
  config: ResolvedConfig,
  opts?: { preferredModel?: string | null; overrideModel?: string | null; agentId?: string },
): ResolvedRoleTarget {
  const configured = config.models.roles[role];
  // An explicit CLI override wins over the configured model on every backend
  // (the backend/endpoint — the "server" — is left untouched). preferredModel,
  // by contrast, is soft and never overrides an authoritative local model.
  const override = opts?.overrideModel?.trim() || null;

  // Local backends (ollama/proxy) only work through Claude Code. For any other
  // agent, fall back to the standard Anthropic model chain — the configured
  // local model name is meaningless against the Anthropic API.
  const agentSupportsLocal = !opts?.agentId || opts.agentId === 'claude-code';
  if (!agentSupportsLocal && configured.backend !== 'anthropic') {
    return { backend: 'anthropic', model: override ?? opts?.preferredModel ?? '', endpoint: '' };
  }

  if (configured.backend === 'anthropic') {
    return { backend: 'anthropic', model: override ?? opts?.preferredModel ?? configured.model, endpoint: '' };
  }

  // ollama / proxy: keep the configured backend + endpoint (the "server"). The
  // model is the explicit override when given, else the authoritative configured
  // model — but never the soft preferredModel. A missing model is caught at
  // config load, but guard here too in case a target is constructed by hand.
  const model = override ?? configured.model;
  if (!model) {
    throw new Error(
      `No model configured for the "${role}" role with backend "${configured.backend}". ` +
      `Set model in lazy.toml [models.roles.${role}].`,
    );
  }
  return { backend: configured.backend, model, endpoint: configured.endpoint };
}

/**
 * Resolve the concrete model name for a task/agent launch — the single
 * replacement for the `if ollama.enabled force ollama.model` blocks that used to
 * be duplicated across every daemon launch site.
 *
 * Returns the authoritative ollama/proxy model, the caller's preferred anthropic
 * model, or `config.models.default` when nothing else is specified. Always
 * non-empty (the model is recorded on the turn/task, so it must be concrete).
 */
export function resolveAgentModel(
  config: ResolvedConfig,
  opts?: { preferredModel?: string | null; agentId?: string },
): string {
  return resolveRoleTarget('agent', config, opts).model || config.models.default;
}

/**
 * Convert a Docker-internal endpoint to one reachable from the host.
 * Uses URL parsing so it only replaces the hostname, not substrings that
 * happen to contain "host.docker.internal".
 */
export function endpointForHost(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.hostname === 'host.docker.internal') {
      url.hostname = 'localhost';
      return url.toString().replace(/\/$/, '');
    }
    return endpoint;
  } catch {
    return endpoint;
  }
}

/** Async HTTP probe via curl. Returns the HTTP status code, or null on connection failure. */
async function probeHttpStatus(url: string): Promise<string | null> {
  try {
    const proc = spawn(
      ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url],
      { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Preflight reachability for a role target. Anthropic reachability is the
 * credential gate's concern, so it is always reported reachable here.
 */
export async function checkTargetConnectivity(target: RoleTarget): Promise<TargetCheckResult> {
  if (target.backend === 'ollama') {
    const endpoint = endpointForHost(target.endpoint);
    const status = await probeHttpStatus(`${endpoint}/api/tags`);
    if (status === '200') return { reachable: true, endpoint };
    return {
      reachable: false,
      endpoint,
      reason: `Ollama is not responding at ${endpoint}. Start it with: ollama serve`,
    };
  }
  if (target.backend === 'proxy') {
    const endpoint = endpointForHost(target.endpoint);
    // Any HTTP response (even 4xx/5xx) proves the proxy is reachable; only a
    // connection failure (null) means it is down.
    const status = await probeHttpStatus(endpoint);
    if (status !== null) return { reachable: true, endpoint };
    return {
      reachable: false,
      endpoint,
      reason: `Proxy backend did not respond at ${endpoint}. Verify the endpoint is running and reachable.`,
    };
  }
  return { reachable: true, endpoint: 'anthropic' };
}

/**
 * Fail-hard preflight for a role's resolved target. Throws an actionable error
 * if a local backend (ollama/proxy) is unreachable — NEVER silently falls back
 * to a different backend (CLAUDE.md: fail hard on remote failures).
 *
 * Anthropic targets are a no-op here (credential presence is the daemon gate's job).
 */
export async function preflightRoleTarget(role: RoleName, target: RoleTarget): Promise<void> {
  if (target.backend === 'anthropic') return;
  const check = await checkTargetConnectivity(target);
  if (!check.reachable) {
    throw new Error(
      `Preflight failed for the "${role}" role: ${check.reason} ` +
      `(backend = "${target.backend}", endpoint = "${check.endpoint}"). ` +
      `Fix the backend or change [models.roles.${role}] in lazy.toml — ` +
      `lazy will not silently fall back to a different backend.`,
    );
  }
}
