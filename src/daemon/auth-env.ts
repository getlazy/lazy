/**
 * Client-side auth env resolution — source the model credential from the daemon.
 *
 * The daemon is the single owner of credentials (see credential-gate.ts). Most
 * containers inherit the daemon's environment because the daemon spawns them.
 * But some launch paths run in the CLI CLIENT process and spawn their OWN
 * container — most notably `lazy builder`. In a daemon-only-env deployment the
 * user's interactive shell legitimately has no credential, so reading the
 * client's `process.env` to populate the container's auth would wrongly fail
 * with "Authentication required" even though the daemon holds a valid token.
 *
 * This helper closes that gap: client launch paths call it to obtain the auth
 * env from the daemon over RPC, never from their own environment.
 *
 * Secrets hygiene: the credential travels over the local, token-authenticated
 * unix socket only and is never written to disk or logged here.
 */

import { tryRpc, isDaemonRpcBypassed } from './client';
import { getAuthEnvVars } from '../capture/claude';
import type { RoleTarget, ResolvedConfig } from '../config/types';
import { targetEnvVars, ANTHROPIC_DEFAULT_TARGET, proxyBaseUrlForRunner, type ProxyAuditHints, type LaunchSurface } from '../utils/role-target';
import { hasDaemonContext, getDaemonContext } from './context';

export interface AuthEnvVar {
  key: string;
  value: string;
}

/**
 * What the DAEMON's environment holds, credential-wise — presence and label
 * only, never the secret. See `handleGetCredentialState`.
 */
export interface DaemonCredentialState {
  /** Is a usable (present, non-blank) credential in the daemon's env? */
  present: boolean;
  /** Which env var carries it (e.g. `CLAUDE_CODE_OAUTH_TOKEN`), or null. */
  source: string | null;
  /** Ollama-backed project: a local dummy credential is used, none needed. */
  ollama: boolean;
}

/**
 * Ask the daemon what credential it holds.
 *
 * Same motivation as {@link resolveAuthEnvFromDaemon} — the daemon is the
 * credential owner, so the client's own `process.env` is the wrong source — but
 * for REPORTING rather than launching, so no secret crosses the socket.
 *
 * Returns null when the daemon RPC is bypassed by design (test / daemon-self).
 * Throws `tryRpc`'s actionable error when the daemon is simply not reachable;
 * callers that must still say something (diagnostics) catch it and fall back to
 * the local env WITH a caveat naming which environment they actually read.
 */
export async function fetchDaemonCredentialState(): Promise<DaemonCredentialState | null> {
  return await tryRpc<DaemonCredentialState>('getCredentialState', {});
}

/**
 * Thrown when `[proxy]` is enabled but the live proxy address cannot be
 * resolved for a launch.
 *
 * INVARIANT (audit plane must not silently degrade): with the proxy enabled —
 * which is the DEFAULT — every agent/builder launch routes model traffic
 * through lazy's local audit/policy proxy. If the address cannot be resolved
 * (daemon down, RPC failure, proxy not bound), the launch FAILS. It must never
 * fall through to a direct api.anthropic.com connection: that traffic would be
 * unaudited and unenforced while the trail recorded nothing, and — being
 * silent — would rot unnoticed. `[proxy] enabled = false` is the explicit
 * opt-out; a daemon blip is not.
 *
 * The wording deliberately does NOT say "cannot launch". Proxy targets are
 * resolved in `createRunner`, which read-only commands (`lazy list`, `lazy
 * status`) also call to get a runner handle for container queries — they would
 * be told a launch failed when they never attempted one. The remedy is
 * identical either way, so the message states the condition, not the caller.
 */
export class ProxyUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `[proxy] is enabled but lazy could not resolve the live proxy address.\n` +
      `Reason: ${reason}\n\n` +
      `lazy routes all agent model traffic through its local audit/policy proxy. Continuing\n` +
      `without it would connect straight to api.anthropic.com with no audit record and no\n` +
      `policy enforcement, so lazy refuses rather than silently degrade.\n\n` +
      `What to do:\n` +
      `  - Check the daemon:    lazy daemon status\n` +
      `  - Start / restart it:  lazy daemon start   (or: lazy daemon restart)\n` +
      `  - Or opt out of the audit plane explicitly, in lazy.toml:\n` +
      `        [proxy]\n` +
      `        enabled = false`,
    );
    this.name = 'ProxyUnavailableError';
  }
}

/**
 * True when the proxy fail-loud gate is deliberately not enforced.
 *
 * Gated on the EXPLICIT bypass signal (`isDaemonRpcBypassed`), never on "the
 * RPC returned null" — under LAZY_TEST the harness runs the whole CLI without a
 * daemon by design, and the daemon process itself never RPCs itself. In both
 * modes there is no daemon to report a proxy address and no launch to protect.
 *
 * `LAZY_FORCE_PROXY_GATE=1` re-arms the gate under LAZY_TEST so e2e tests can
 * exercise the real failure. Test-only, same family as `LAZY_FORCE_PREFLIGHT` /
 * `LAZY_FORCE_TTY` — never read it from anywhere but here.
 */
function proxyGateBypassed(): boolean {
  if (process.env.LAZY_FORCE_PROXY_GATE === '1') return false;
  return isDaemonRpcBypassed();
}

/**
 * The live base URL of this project's lazy proxy.
 *
 * Two sources, because launches happen in two kinds of process:
 *  - INSIDE the daemon (task/supervisor launches): read the actual bound port
 *    straight off the daemon context.
 *  - In a CLI CLIENT (e.g. `lazy builder`, `pair`, `chat`): ask the daemon over
 *    the `getAuthEnv` RPC, which reports the same live address.
 *
 * FAILS LOUD (throws {@link ProxyUnavailableError}) when the proxy is enabled
 * but no address can be resolved. Returns undefined in exactly two cases, both
 * explicit rather than incidental:
 *  - `[proxy] enabled = false` — the user's opt-out, so the escape hatch costs
 *    nothing; and
 *  - the daemon RPC is bypassed by design (see {@link proxyGateBypassed}).
 */
export async function resolveLiveProxyUrl(config: ResolvedConfig): Promise<string | undefined> {
  if (!config.proxy) return undefined;
  if (hasDaemonContext()) {
    const port = getDaemonContext().proxyPort;
    // The daemon refuses to start when the proxy cannot start, so a running
    // daemon always has a port here; this covers the brief window before the
    // proxy binds during startup — a launch in that window waits for a restart
    // rather than escaping the audit plane.
    if (!port) {
      throw new ProxyUnavailableError('the daemon has not bound its proxy port yet');
    }
    return proxyBaseUrlForRunner(config.runner.type, port, config.proxy.bind);
  }
  if (proxyGateBypassed()) return undefined;

  let rpc: { proxyBaseUrl?: string } | null;
  try {
    rpc = await tryRpc<{ proxyBaseUrl?: string }>('getAuthEnv', {});
  } catch (err) {
    // tryRpc already throws actionably for a missing/unreachable daemon. Keep
    // its FIRST line as the reason — the rest of its message is remediation
    // advice this error states itself, and repeating it reads as noise.
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProxyUnavailableError(detail.split('\n')[0]!.trim());
  }
  if (!rpc) {
    // Only the bypass modes return null, and those returned above.
    throw new ProxyUnavailableError('the daemon did not answer the getAuthEnv request');
  }
  if (!rpc.proxyBaseUrl) {
    throw new ProxyUnavailableError(
      'the daemon is running but reports no live proxy address (its proxy is not running)',
    );
  }
  return rpc.proxyBaseUrl;
}

/**
 * Point one role target at the live lazy proxy, or fail loud trying.
 *
 * This is the SINGLE seam every client launch path uses to fill in the proxy
 * address (`src/runner/index.ts`, `lazy pair` ×2, `lazy chat`), so the
 * fail-loud contract is structural instead of repeated at each call site.
 *
 *  - `anthropic` roles (the default) get `proxyUrl` — traffic that used to go
 *    straight to api.anthropic.com now flows through the proxy, which forwards
 *    to that same upstream with the credential passed through untouched.
 *  - `proxy` roles that left `endpoint` unset get it filled in (the port is
 *    OS-assigned, so it isn't knowable from config). An explicit endpoint wins.
 *  - `ollama` roles are deliberately untouched — and deliberately do NOT
 *    trigger the gate: the proxy has a single Anthropic-native upstream and a
 *    local model is not it, so a proxied launch was never in question.
 *
 * Targets are returned unchanged when `[proxy] enabled = false` (the explicit
 * opt-out) or the role is already pointed somewhere explicit.
 */
export async function withLiveProxyTarget(
  target: RoleTarget,
  config: ResolvedConfig,
): Promise<RoleTarget> {
  if (!needsLiveProxyUrl(target, config)) return target;
  const proxyUrl = await resolveLiveProxyUrl(config);
  // Undefined only reaches here in the explicit bypass modes (test harness /
  // daemon-self); every genuine resolution failure threw above.
  return proxyUrl ? applyLiveProxyUrl(target, proxyUrl) : target;
}

/**
 * Whether this role needs the daemon's live proxy address filled in — i.e.
 * whether resolving it (and failing loud if it can't be) is in scope for this
 * target. The rules are documented on {@link withLiveProxyTarget}; they live
 * here so a caller resolving the address ONCE for several roles (the runner
 * factory) applies exactly the same rules as the single-target seam.
 */
export function needsLiveProxyUrl(target: RoleTarget, config: ResolvedConfig): boolean {
  if (!config.proxy) return false;
  if (target.backend === 'ollama') return false;
  if (target.backend === 'proxy') return !target.endpoint;
  return !target.proxyUrl;
}

/** Attach an already-resolved live proxy address to a role target. */
export function applyLiveProxyUrl(target: RoleTarget, proxyUrl: string): RoleTarget {
  if (target.backend === 'ollama') return target;
  return target.backend === 'proxy'
    ? { ...target, endpoint: proxyUrl }
    : { ...target, proxyUrl };
}

/**
 * Resolve the auth env vars for a client-launched container, preferring the
 * daemon as the credential source.
 *
 * - Ollama: dummy local credentials, no daemon needed — computed in-process.
 * - anthropic/proxy: the Anthropic credential is fetched from the daemon via the
 *   `getAuthEnv` RPC, then wrapped for the target (proxy prepends its base URL).
 * - Test (LAZY_TEST=1) / daemon-self (LAZY_IS_DAEMON=1): `tryRpc` returns null,
 *   so we fall back to the local env — in those modes the credential lives in
 *   this very process (tests set it; the daemon process holds it directly).
 *
 * `surface` says whether the resolved env is for a container or a host process
 * (see {@link targetEnvVars}). The daemon reports its proxy address in the form
 * the configured runner would use, so a host launch MUST say so — otherwise a
 * docker-runner project hands `host.docker.internal` to a host process.
 *
 * `config`, when supplied, arms the same fail-loud proxy gate as
 * {@link withLiveProxyTarget}: with `[proxy]` enabled, an anthropic role that
 * ends up with no proxy address fails instead of connecting direct. Callers
 * that resolved their target through `withLiveProxyTarget` already passed the
 * gate; passing config here makes this last hop check rather than assume.
 */
export async function resolveAuthEnvFromDaemon(
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  config?: ResolvedConfig,
): Promise<AuthEnvVar[]> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;

  // Ollama-backed setups use local dummy credentials — the daemon adds nothing.
  if (resolved.backend === 'ollama') {
    return targetEnvVars(resolved, [], surface, hints);
  }

  // anthropic/proxy: source the real Anthropic credential, preferring the daemon.
  const rpc = await tryRpc<{ authEnvVars: AuthEnvVar[]; proxyBaseUrl?: string }>('getAuthEnv', {});
  if (rpc) {
    // The RPC returns the bare Anthropic credential; for proxy targets the base
    // URL (and the audit headers) must still be layered on top here. When the
    // role omitted `endpoint`, use the daemon's live proxy URL (OS-assigned port)
    // from the RPC — the client can't read the daemon context itself.
    if (resolved.backend === 'proxy') {
      const endpoint = resolved.endpoint || rpc.proxyBaseUrl || '';
      return targetEnvVars({ ...resolved, endpoint }, rpc.authEnvVars, surface, hints);
    }
    // DEFAULT-ON PROXY: an anthropic role routes through the proxy too whenever
    // the daemon reports one, so client-launched containers (notably the docker
    // builder) get the same audit/policy coverage as daemon-launched agents.
    // Already-set proxyUrl (from the resolved role targets) wins.
    const proxyUrl = resolved.proxyUrl ?? rpc.proxyBaseUrl;
    if (proxyUrl) {
      return targetEnvVars({ ...resolved, proxyUrl }, rpc.authEnvVars, surface, hints);
    }
    // No proxy address for a role that should have one: the audit plane would
    // be silently bypassed, so fail loud (same contract as resolveLiveProxyUrl).
    if (config?.proxy && !proxyGateBypassed()) {
      throw new ProxyUnavailableError(
        'the daemon is running but reports no live proxy address (its proxy is not running)',
      );
    }
    return rpc.authEnvVars;
  }

  // Daemon bypassed (test or daemon-self mode): the credential is in this
  // process. getAuthEnvVars throws an actionable error if it is genuinely
  // absent, which is the correct behavior for those modes.
  return getAuthEnvVars(resolved, hints, surface);
}
