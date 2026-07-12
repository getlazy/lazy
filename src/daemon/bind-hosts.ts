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
import type { RunnerType } from '../config/types';
import { DEFAULT_SERVER_BIND } from '../config/constants';

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
): string[] {
  const hosts: string[] = [];
  for (const name of BRIDGE_INTERFACE_NAMES) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      // The bridge gateway is a real (non-internal) IPv4 host interface address.
      // `family` is 'IPv4' on Bun/modern Node but historically was the number 4.
      const isIpv4 = addr.family === 'IPv4' || (addr.family as unknown as number) === 4;
      if (isIpv4 && !addr.internal && !hosts.includes(addr.address)) {
        hosts.push(addr.address);
      }
    }
  }
  return hosts;
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
}): BindHostResolution {
  const { configBind, platform, runnerType } = opts;

  if (configBind !== DEFAULT_SERVER_BIND) {
    return { hosts: [configBind], bridgeUnreachable: false };
  }

  const hosts = [DEFAULT_SERVER_BIND];
  if (platform === 'linux' && isContainerRunner(runnerType)) {
    const bridgeHosts = detectContainerBridgeHosts(opts.interfaces);
    for (const h of bridgeHosts) {
      if (!hosts.includes(h)) hosts.push(h);
    }
    return { hosts, bridgeUnreachable: bridgeHosts.length === 0 };
  }
  return { hosts, bridgeUnreachable: false };
}
