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
import { targetEnvVars, ANTHROPIC_DEFAULT_TARGET, proxyBaseUrlForRunner, LOCAL_BACKEND_CREDS, type ProxyAuditHints, type LaunchSurface } from '../utils/role-target';
import type { LaunchIdentity } from '../proxy/placeholder-env';
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
 * Thrown when the live proxy address cannot be resolved for a launch.
 *
 * INVARIANT (audit plane must not silently degrade): the proxy is ALWAYS ON —
 * there is no config option to turn it off — so every agent/builder launch
 * routes model traffic through lazy's local audit/policy proxy. If the address
 * cannot be resolved (daemon down, RPC failure, proxy not bound), the launch
 * FAILS. It must never fall through to a direct api.anthropic.com connection:
 * that traffic would be unaudited and unenforced while the trail recorded
 * nothing, and — being silent — would rot unnoticed. There is no opt-out to
 * offer as a remedy; the remedy is a healthy daemon.
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
      `lazy could not resolve the live proxy address.\n` +
      `Reason: ${reason}\n\n` +
      `lazy routes ALL agent model traffic through its local audit/policy proxy, always —\n` +
      `including ollama roles and roles with an explicit \`endpoint\`, which the proxy now\n` +
      `forwards to rather than the agent dialing them itself. Continuing without it would\n` +
      `connect straight to the upstream with no audit record and no policy enforcement, so\n` +
      `lazy refuses rather than silently degrade. There is no way to turn the proxy off and\n` +
      `no role configuration that opts out — the fix is to get it running.\n\n` +
      `What to do:\n` +
      `  - Check the daemon:    lazy daemon status\n` +
      `  - Start / restart it:  lazy daemon start   (or: lazy daemon restart)\n` +
      `  - Still failing? Its startup log says why the proxy did not bind: lazy daemon logs`,
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
 * FAILS LOUD (throws {@link ProxyUnavailableError}) when no address can be
 * resolved. Returns undefined in exactly ONE case, explicit rather than
 * incidental: the daemon RPC is bypassed by design (see {@link
 * proxyGateBypassed}).
 */
export async function resolveLiveProxyUrl(config: ResolvedConfig): Promise<string | undefined> {
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
    // Address only — this caller has no launch to inject a credential into,
    // so the daemon is told not to send one.
    rpc = await tryRpc<{ proxyBaseUrl?: string }>('getAuthEnv', {
      credentials: false,
      // Required by the handler even here, where no credential is requested:
      // the parameter is mandatory at the boundary precisely so that no caller
      // can reach it without having decided.
      proxied: false,
    });
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
 * EVERY backend gets `proxyUrl`, with no exceptions — that is the point. An
 * ollama role and a role with an explicit `endpoint` used to be skipped here and
 * connected direct; now their `endpoint` is the upstream the PROXY forwards to
 * (src/proxy/role-upstreams.ts), so they need the proxy's address like everyone
 * else and they trigger the same fail-loud gate.
 *
 * A target that already carries a `proxyUrl` is returned unchanged: it was
 * resolved by whoever stamped it (the runner factory), and re-resolving would
 * only risk disagreeing with the address the launch is already built around.
 */
export async function withLiveProxyTarget(
  target: RoleTarget,
  config: ResolvedConfig,
): Promise<RoleTarget> {
  if (!needsLiveProxyUrl(target)) return target;
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
export function needsLiveProxyUrl(target: RoleTarget): boolean {
  // INVARIANT: backend-independent. Every role is proxied, so the only question
  // is whether this target already carries the address.
  return !target.proxyUrl;
}

/**
 * Attach an already-resolved live proxy address to a role target.
 *
 * Sets `proxyUrl` and NEVER touches `endpoint`. It used to overwrite a `proxy`
 * role's endpoint with the proxy's own address, which made "endpoint" mean two
 * incompatible things depending on who had written it last. `endpoint` is now
 * exclusively the upstream the proxy forwards this role to, and clobbering it
 * here would erase the very routing the daemon reads at request time.
 */
export function applyLiveProxyUrl(target: RoleTarget, proxyUrl: string): RoleTarget {
  return { ...target, proxyUrl };
}

/**
 * Resolve the auth env vars for a client-launched container, preferring the
 * daemon as the credential source.
 *
 * - Ollama: the ollama server ignores auth, so there is no real credential to
 *   fetch — but the launch still needs the proxy's address and a placeholder to
 *   present to it, so the RPC is told the caller is self-credentialed and mints
 *   a grant over {@link LOCAL_BACKEND_CREDS} instead of the user's token. This
 *   is what keeps ollama-only projects (which legitimately have no Anthropic
 *   credential at all) launchable while still being fully proxied.
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
 * `config` is accepted for symmetry with {@link withLiveProxyTarget} and is no
 * longer load-bearing: the proxy is always on, so an anthropic role that ends up
 * with no proxy address fails whether or not a config was passed. Callers that
 * resolved their target through `withLiveProxyTarget` already passed the gate;
 * this last hop checks rather than assumes.
 */
export async function resolveAuthEnvFromDaemon(
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  config?: ResolvedConfig,
  identity?: LaunchIdentity,
): Promise<AuthEnvVar[]> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;

  // The ollama server ignores auth, so the daemon has no real credential to
  // source for this role — and demanding one would break the very projects
  // ollama exists to serve. The launch is proxied all the same: the daemon
  // mints a placeholder over these synthetic vars, and the proxy strips it
  // before forwarding to an upstream mapped to "no credential".
  const selfCredentialed = resolved.backend === 'ollama';

  // JIT CREDENTIALS: every role's traffic reaches lazy's proxy now, so the only
  // question left is whether this caller identified itself well enough to mint
  // a grant. A caller that passes no identity gets the real credential,
  // unchanged. That is not a loophole to widen: every launch path in lazy passes
  // one, and the remaining callers are diagnostics that never hand the value to
  // a process.
  const proxied = identity !== undefined;

  const rpc = await tryRpc<{ authEnvVars: AuthEnvVar[]; proxyBaseUrl?: string }>('getAuthEnv', {
    proxied,
    ...(selfCredentialed ? { selfCredentialed: true } : {}),
    ...(proxied ? { role: identity!.role, taskId: identity!.taskId ?? null, label: identity!.label } : {}),
  });
  if (rpc) {
    // The RPC returns the bare credential; the base URL (and the audit headers)
    // are layered on top here. The client can't read the daemon context itself,
    // so the daemon's live proxy URL (OS-assigned port) comes back over the RPC.
    // An already-set proxyUrl (from the resolved role targets) wins.
    //
    // `resolved.endpoint` is deliberately NOT consulted: it is the upstream the
    // PROXY forwards to, never an address this launch dials.
    const proxyUrl = resolved.proxyUrl ?? rpc.proxyBaseUrl;
    if (proxyUrl) {
      return targetEnvVars({ ...resolved, proxyUrl }, rpc.authEnvVars, surface, hints);
    }
    // No proxy address for a role that should have one: the audit plane would
    // be silently bypassed, so fail loud (same contract as resolveLiveProxyUrl).
    if (!proxyGateBypassed()) {
      throw new ProxyUnavailableError(
        'the daemon is running but reports no live proxy address (its proxy is not running)',
      );
    }
    return rpc.authEnvVars;
  }

  // Daemon bypassed (test or daemon-self mode): the credential is in this
  // process — or, for an ollama role, is synthetic and needs no process at all.
  // getAuthEnvVars throws an actionable error if it is genuinely absent, which
  // is the correct behavior for those modes.
  //
  // No placeholder swap here on purpose: these are the modes with no daemon,
  // and therefore no proxy to exchange a placeholder against. The daemon-self
  // case never reaches this function for a launch — in-daemon launches go
  // through getLaunchAuthEnvVars, which does swap.
  if (selfCredentialed) return targetEnvVars(resolved, LOCAL_BACKEND_CREDS, surface, hints);
  return getAuthEnvVars(resolved, hints, surface);
}
