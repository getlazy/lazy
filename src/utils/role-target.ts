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

import type { ResolvedConfig, RoleName, RoleTarget, RunnerType } from '../config/types';
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
  /** Live lazy-proxy base URL for an `anthropic` role (see {@link RoleTarget.proxyUrl}). */
  proxyUrl?: string;
}

/**
 * The anthropic-default target: "use the normal Anthropic model chain". Used as
 * the fallback for runners that have no per-role targets set (the in-container
 * supervisor's runner), preserving credential-inheritance behavior.
 */
export const ANTHROPIC_DEFAULT_TARGET: RoleTarget = { backend: 'anthropic', model: '', endpoint: '' };

/**
 * The base URL an agent should use to reach the daemon's passthrough proxy,
 * given the runner it launches under and the proxy's actual (possibly
 * OS-assigned) bound port. Container runners reach host services via
 * `host.docker.internal`; the host-process runner reaches the proxy on its own
 * bind address (loopback by default). Used to fill in a `backend = "proxy"`
 * role that left `endpoint` unset, so the port need not be pinned in config.
 */
export function proxyBaseUrlForRunner(
  runnerType: RunnerType,
  proxyPort: number,
  bind: string,
): string {
  const host =
    runnerType === 'docker' || runnerType === 'podman'
      ? 'host.docker.internal'
      : bind && bind !== '0.0.0.0'
        ? bind
        : '127.0.0.1';
  return `http://${host}:${proxyPort}`;
}

export type TargetCheckResult =
  | { reachable: true; endpoint: string }
  | { reachable: false; endpoint: string; reason: string };

/**
 * Where the process being launched will actually run.
 *
 * This is NOT the same thing as `[runner] type`. `lazy pair`, `lazy chat`, and
 * the host-process runner all launch Claude Code as a HOST process even when
 * the project's runner is docker — so they must be handed host-reachable
 * addresses, not the Docker-internal ones a container would use.
 *
 * Every env-building call site must declare its surface (see {@link targetEnvVars}):
 * the parameter is required precisely so a new launch path cannot silently
 * inherit the wrong one.
 */
export type LaunchSurface = 'host' | 'container';

/**
 * Adapt a resolved target to the surface the process will run on.
 *
 * `host.docker.internal` is Docker's internal DNS alias for the host. It only
 * resolves INSIDE a container; a host process handed that name dies with
 * ENOTFOUND. So for a host launch every address on the target — the backend
 * `endpoint` AND the injected `proxyUrl` — is rewritten to its host-reachable
 * form. Container launches are returned untouched: they genuinely need the
 * Docker-internal name, and blanket-converting would break them in the other
 * direction.
 *
 * This is the SINGLE conversion point shared by the reachability preflight and
 * by env building, which is what makes their agreement structural rather than a
 * convention two call sites have to remember (see {@link preflightRoleTarget}).
 */
export function targetForSurface(target: RoleTarget, surface: LaunchSurface): RoleTarget {
  if (surface !== 'host') return target;
  const adapted: RoleTarget = { ...target };
  if (adapted.endpoint) adapted.endpoint = endpointForHost(adapted.endpoint);
  if (adapted.proxyUrl) adapted.proxyUrl = endpointForHost(adapted.proxyUrl);
  return adapted;
}

/*
 * REMOVED: `anthropicEnvVarsFromProcess()`.
 *
 * It read the Anthropic credential out of the CLIENT process's own environment,
 * and its only callers were `lazy pair` (×2) and `lazy chat` — the three
 * interactive host launches. That is the wrong source: the daemon owns the
 * credential (see daemon/credential-gate.ts), so a shell exporting nothing —
 * the normal case in a daemon-only-env setup, and what any freshly opened
 * terminal looks like — silently handed Claude Code no credential at all and
 * left it to fall through to the host store or a `/login` prompt.
 *
 * All three now go through `src/cli/interactive-auth.ts`, which sources the
 * credential from the daemon over RPC. The function is deleted rather than left
 * exported-but-unused so the next launch surface cannot reach for it: a tolerant
 * reader that returns `[]` on a missing credential looks safe at the call site
 * and is exactly what made this failure silent. Use `resolveAuthEnvFromDaemon`.
 */

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
 * Audit routing hints attached to an agent's traffic when its role runs THROUGH
 * the lazy proxy (`backend = "proxy"`). The proxy reads `x-lazy-role` /
 * `x-lazy-task-id` off each request to attribute the audited call to the agent
 * and task that made it, then strips them before forwarding upstream
 * (`src/proxy/server.ts`). They reach Claude Code via `ANTHROPIC_CUSTOM_HEADERS`,
 * which the CLI forwards on every request to its `ANTHROPIC_BASE_URL` — here, the
 * proxy. Only the proxy backend emits them (real Anthropic / ollama must never
 * receive lazy-internal headers).
 */
export interface ProxyAuditHints {
  /** Whose traffic this is — `builder` or `agent`. */
  role?: RoleName;
  /** Short task id for per-task attribution. Omitted for the taskless builder. */
  taskId?: string;
}

/**
 * Values are interpolated into a header line, so a crafted id must not be able to
 * inject a newline (a second header) or otherwise break the pair. Role is a fixed
 * literal; task ids are short tokens — restrict to a simple safe charset and drop
 * anything that doesn't match rather than emitting a malformed/injected header.
 */
const SAFE_HEADER_VALUE = /^[A-Za-z0-9._-]+$/;

/**
 * Build the `ANTHROPIC_CUSTOM_HEADERS` env var carrying the audit hints, or null
 * when there is nothing safe to emit. Claude Code parses this var as newline- or
 * comma-separated `Name: Value` pairs and sends each header on every request to
 * its base URL. We newline-separate (our values never contain commas) and skip
 * any hint whose value isn't a simple token.
 */
export function proxyAuditHeaderEnv(hints: ProxyAuditHints | undefined): AuthEnvVar | null {
  if (!hints) return null;
  const lines: string[] = [];
  if (hints.role && SAFE_HEADER_VALUE.test(hints.role)) lines.push(`x-lazy-role: ${hints.role}`);
  if (hints.taskId && SAFE_HEADER_VALUE.test(hints.taskId)) lines.push(`x-lazy-task-id: ${hints.taskId}`);
  if (lines.length === 0) return null;
  return { key: 'ANTHROPIC_CUSTOM_HEADERS', value: lines.join('\n') };
}

/**
 * Compute the environment variables that point Claude Code at a resolved target.
 *
 * `anthropicCreds` is the Anthropic credential to forward — supplied by the
 * caller because its source differs by launch path (the daemon reads its own
 * process env; client launches fetch it over RPC). It is ignored for the ollama
 * backend (which uses self-contained dummy credentials).
 *
 * `surface` says where the launched process will run and is REQUIRED — a host
 * process cannot resolve `host.docker.internal`, so an endpoint that is correct
 * for a container is a guaranteed ENOTFOUND on the host. Making it a required
 * parameter means a new launch path has to state which it is instead of
 * inheriting whichever the previous caller happened to want. See
 * {@link targetForSurface}.
 *
 * `hints` (optional) attach `x-lazy-role` / `x-lazy-task-id` audit headers via
 * `ANTHROPIC_CUSTOM_HEADERS` — emitted ONLY for the proxy backend, so the audit
 * plane can attribute proxied traffic to its role/task (§6.1). A no-op for
 * anthropic/ollama, and for proxy when the hints carry nothing usable.
 *
 * - ollama: dummy credentials + base URL + stability flags (fully self-contained).
 * - proxy: base URL override forwarded with the real Anthropic credential (+ audit headers).
 * - anthropic: the real Anthropic credential.
 */
export function targetEnvVars(
  rawTarget: RoleTarget,
  anthropicCreds: AuthEnvVar[],
  surface: LaunchSurface,
  hints?: ProxyAuditHints,
): AuthEnvVar[] {
  const target = targetForSurface(rawTarget, surface);
  switch (target.backend) {
    case 'ollama':
      return [
        { key: 'ANTHROPIC_BASE_URL', value: target.endpoint },
        { key: 'ANTHROPIC_AUTH_TOKEN', value: 'ollama' },
        { key: 'ANTHROPIC_API_KEY', value: 'ollama' },
        ...LOCAL_BACKEND_STABILITY_ENV,
      ];
    case 'proxy': {
      // Never point Claude Code at an empty base URL — that would silently send
      // traffic to the default (real Anthropic), bypassing the proxy and its
      // audit/policy plane. An empty endpoint here means the daemon's live proxy
      // URL was never injected (proxy not running, or resolved outside daemon
      // reach); fail hard with an actionable message (CLAUDE.md: fail hard).
      if (!target.endpoint) {
        throw new Error(
          'backend = "proxy" role has no endpoint and the daemon did not supply a live proxy URL. ' +
          'Ensure a [proxy] section is configured and the daemon is running, or set an explicit ' +
          'endpoint on the role.',
        );
      }
      const vars: AuthEnvVar[] = [
        { key: 'ANTHROPIC_BASE_URL', value: target.endpoint },
        ...anthropicCreds,
      ];
      const header = proxyAuditHeaderEnv(hints);
      if (header) vars.push(header);
      return vars;
    }
    case 'anthropic':
    default: {
      // DEFAULT-ON PROXY: anthropic traffic used to go straight to
      // api.anthropic.com. When the proxy is running (which is the default),
      // `proxyUrl` is filled in at launch and this traffic flows through lazy's
      // local audit/policy plane instead — the proxy forwards to the very same
      // upstream, and the credential below is passed through untouched, so this
      // is transparent to Claude Code. No proxyUrl = direct, which reaching
      // here means `[proxy] enabled = false`: an enabled-but-unresolvable proxy
      // fails the launch upstream rather than arriving here unset (see
      // ProxyUnavailableError in daemon/auth-env.ts).
      if (!target.proxyUrl) return anthropicCreds;
      const vars: AuthEnvVar[] = [
        { key: 'ANTHROPIC_BASE_URL', value: target.proxyUrl },
        ...anthropicCreds,
      ];
      const header = proxyAuditHeaderEnv(hints);
      if (header) vars.push(header);
      return vars;
    }
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
 *
 * The probe itself always runs in a HOST process (lazy's CLI or daemon), so it
 * necessarily tests the host-reachable address — `targetForSurface(target,
 * 'host')`, the very same conversion `targetEnvVars(..., 'host')` applies. That
 * shared seam is what makes "the address we verified is the address we launch
 * with" true by construction for host launches. For a container launch the
 * address deliberately differs (`host.docker.internal`), but it names the same
 * service on the same port, which is what the probe established.
 */
export async function checkTargetConnectivity(target: RoleTarget): Promise<TargetCheckResult> {
  if (target.backend === 'ollama') {
    const endpoint = targetForSurface(target, 'host').endpoint;
    const status = await probeHttpStatus(`${endpoint}/api/tags`);
    if (status === '200') return { reachable: true, endpoint };
    return {
      reachable: false,
      endpoint,
      reason: `Ollama is not responding at ${endpoint}. Start it with: ollama serve`,
    };
  }
  if (target.backend === 'proxy') {
    const endpoint = targetForSurface(target, 'host').endpoint;
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
 *
 * Returns the address that was actually probed (host-reachable form, or
 * `'anthropic'` for the anthropic backend). A host launch site can hand this
 * straight to the process it spawns; it is by construction identical to what
 * `targetEnvVars(target, creds, 'host')` produces for the same target.
 */
export async function preflightRoleTarget(role: RoleName, target: RoleTarget): Promise<string> {
  if (target.backend === 'anthropic') return 'anthropic';
  const check = await checkTargetConnectivity(target);
  if (check.reachable) return check.endpoint;
  throw new Error(
    `Preflight failed for the "${role}" role: ${check.reason} ` +
    `(backend = "${target.backend}", endpoint = "${check.endpoint}"). ` +
    `Fix the backend or change [models.roles.${role}] in lazy.toml — ` +
    `lazy will not silently fall back to a different backend.`,
  );
}
