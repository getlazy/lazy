/**
 * Daemon TCP bind-host resolution.
 *
 * v0.18's daemon-bind-localhost change binds the daemon's TCP web/MCP/RPC server
 * to loopback (127.0.0.1) by default so the unauthenticated dashboard is not
 * exposed to the LAN. That is correct on macOS/Windows Docker Desktop, where
 * `host.docker.internal` is proxied to the host's loopback, so containers still
 * reach a loopback-bound daemon.
 *
 * On NATIVE LINUX Docker/Podman it is not: containers reach the host via
 * `--add-host=host.docker.internal:host-gateway`, which resolves to the bridge
 * gateway IP (the `docker0` interface, typically 172.17.0.1) — a NON-loopback
 * host interface. A daemon bound only to 127.0.0.1 REFUSES that connection, so
 * agents/supervisor/MCP inside containers cannot reach the daemon at all.
 *
 * This module decides which interfaces the daemon should bind so that:
 *   - the host CLI/browser still reaches it via loopback, and
 *   - containers on native Linux Docker reach it via the bridge gateway,
 * WITHOUT binding 0.0.0.0 (which would expose the unauthenticated dashboard to
 * the LAN). The docker bridge interface is host-local and the container network
 * only — it is NOT routable from the LAN, so binding it does not widen LAN
 * exposure beyond what daemon-bind-localhost intended.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from 'os';
import { spawnSyncUnsupervised } from '../utils/spawn';
import type { RunnerType } from '../config/types';
import { DEFAULT_SERVER_BIND, DEFAULT_PROXY_BIND } from '../config/constants';

/** Runner types that launch workloads inside containers (vs. host processes). */
export function isContainerRunner(runnerType: RunnerType): boolean {
  return runnerType === 'docker' || runnerType === 'podman';
}

/**
 * Interface names for the container bridge whose gateway IP a container reaches
 * the host through when launched with `--add-host=host.docker.internal:host-gateway`.
 * Docker's `host-gateway` magic string resolves to the DEFAULT bridge gateway —
 * the `docker0` interface (typically 172.17.0.1) — regardless of which network
 * the container attaches to. Podman's default bridge is `podman0` / `cni-podman0`.
 */
const BRIDGE_INTERFACE_NAMES = ['docker0', 'podman0', 'cni-podman0'];

/**
 * Detect the host-side IPv4 address(es) of the container bridge gateway — the
 * interface(s) a container reaches the host through via `host-gateway`.
 *
 * Returns an empty array when no bridge interface is present (e.g. Docker is not
 * installed, or the daemon is not running on the docker host). `interfaces` is
 * injectable so the resolution logic is unit-testable without real interfaces.
 */
export function detectContainerBridgeHosts(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  readIpv4Addrs: (iface: string) => string[] = ipv4AddrsFromIpCommand,
): string[] {
  const hosts: string[] = [];
  for (const name of BRIDGE_INTERFACE_NAMES) {
    const addrs = interfaces[name];
    if (addrs) {
      for (const addr of addrs) {
        // The bridge gateway is a real (non-internal) IPv4 host interface address.
        // `family` is 'IPv4' on Bun/modern Node but historically was the number 4.
        const isIpv4 = addr.family === 'IPv4' || (addr.family as unknown as number) === 4;
        if (isIpv4 && !addr.internal && !hosts.includes(addr.address)) {
          hosts.push(addr.address);
        }
      }
      continue;
    }
    // MEASURED (smolvm fleet demo, run 5): a bridge with NO container attached
    // is NO-CARRIER — administratively up, operationally down — and
    // `os.networkInterfaces()` (libuv: IFF_UP && IFF_RUNNING) omits it, so a
    // daemon that starts on a fresh host, before its first container exists,
    // saw no bridge, bound loopback only, and every container it later launched
    // was refused. The address is assigned regardless of carrier, so ask the
    // kernel for it directly.
    for (const address of readIpv4Addrs(name)) {
      if (!hosts.includes(address)) hosts.push(address);
    }
  }
  return hosts;
}

/** `ip -4 -o addr show dev <iface>` → its IPv4 addresses; empty when there is no such interface or no `ip`. */
export function ipv4AddrsFromIpCommand(iface: string): string[] {
  if (process.platform !== 'linux') return [];
  try {
    const result = spawnSyncUnsupervised(['ip', '-4', '-o', 'addr', 'show', 'dev', iface], { timeout: 5_000 });
    if (result.exitCode !== 0) return [];
    return parseIpAddrOutput(result.stdout.toString());
  } catch {
    // No `ip` binary (or it could not be spawned): the interface list above is
    // all there is, which is the pre-existing behaviour.
    return [];
  }
}

/** The `inet` addresses in `ip -4 -o addr show` output. */
export function parseIpAddrOutput(output: string): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(/\binet (\d{1,3}(?:\.\d{1,3}){3})\//g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

export interface BindHostResolution {
  /**
   * Interfaces to bind the TCP server to. The first entry is the PRIMARY bind:
   * it drives port selection and the user-facing dashboard URL. Any further
   * entries are additional interfaces bound on the same port.
   */
  hosts: string[];
  /**
   * True when a container runner on Linux should have a reachable bridge
   * interface but none could be detected — the caller should surface an
   * actionable warning so agents don't silently fail to reach the daemon.
   */
  bridgeUnreachable: boolean;
}

/**
 * Resolve the interface(s) the daemon TCP server should bind to.
 *
 * - If the user explicitly set `[server] bind` to anything other than the
 *   loopback default, respect it EXACTLY (principle of least surprise — don't
 *   silently add interfaces). `0.0.0.0` already covers containers; a specific
 *   IP is the user's deliberate choice.
 * - Otherwise (default loopback), on native Linux with a container runner, also
 *   bind the docker/podman bridge gateway so containers can reach the daemon
 *   without exposing the dashboard to the LAN. macOS/Windows need nothing extra
 *   (host.docker.internal proxies to loopback).
 */
export function resolveDaemonBindHosts(opts: {
  configBind: string;
  platform: NodeJS.Platform;
  runnerType: RunnerType;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readIpv4Addrs?: (iface: string) => string[];
}): BindHostResolution {
  return resolveBindHosts({ ...opts, defaultBind: DEFAULT_SERVER_BIND });
}

/**
 * The same resolution for the CREDENTIAL PROXY, which a task container dials
 * at `http://host.docker.internal:<port>` (proxyBaseUrlForRunner) — the very
 * address that is the bridge gateway on native Linux. The proxy's default bind
 * is loopback and managed mode pins it there; both are kept, and the bridge
 * gateway is bound IN ADDITION under exactly the daemon port's conditions.
 *
 * Security posture is unchanged (container-credential-and-egress-posture):
 * the proxy authenticates every request by placeholder LOOKUP, not by where
 * it came from, and the container bridge is precisely the set of clients the
 * proxy exists to serve. `0.0.0.0` is never chosen here; an explicit
 * `[proxy] bind` is respected exactly.
 */
export function resolveProxyBindHosts(opts: {
  configBind: string;
  platform: NodeJS.Platform;
  runnerType: RunnerType;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readIpv4Addrs?: (iface: string) => string[];
}): BindHostResolution {
  return resolveBindHosts({ ...opts, defaultBind: DEFAULT_PROXY_BIND });
}

function resolveBindHosts(opts: {
  configBind: string;
  defaultBind: string;
  platform: NodeJS.Platform;
  runnerType: RunnerType;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readIpv4Addrs?: (iface: string) => string[];
}): BindHostResolution {
  const { configBind, defaultBind, platform, runnerType } = opts;

  if (configBind !== defaultBind) {
    return { hosts: [configBind], bridgeUnreachable: false };
  }

  const hosts = [defaultBind];
  if (platform === 'linux' && isContainerRunner(runnerType)) {
    // Injected interfaces are a test's whole world: no kernel fallback unless
    // the test injects that too, or a docker0 on the machine running the suite
    // would leak into a "no bridge" case.
    const bridgeHosts = detectContainerBridgeHosts(
      opts.interfaces,
      opts.readIpv4Addrs ?? (opts.interfaces ? () => [] : undefined),
    );
    for (const h of bridgeHosts) {
      if (!hosts.includes(h)) hosts.push(h);
    }
    return { hosts, bridgeUnreachable: bridgeHosts.length === 0 };
  }
  return { hosts, bridgeUnreachable: false };
}
