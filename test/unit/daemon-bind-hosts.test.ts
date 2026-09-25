import { describe, test, expect } from 'bun:test';
import type { NetworkInterfaceInfo } from 'os';
import {
  detectContainerBridgeHosts,
  resolveDaemonBindHosts,
  resolveProxyBindHosts,
  isContainerRunner,
  parseIpAddrOutput,
} from '../../src/daemon/bind-hosts';

// INVARIANT: on native Linux Docker, a container reaches the daemon via
// host.docker.internal -> the docker bridge gateway (a NON-loopback interface).
// A daemon bound only to 127.0.0.1 refuses that connection. So when the bind is
// the loopback default AND a container runner is configured on Linux, the
// daemon must ALSO bind the bridge gateway — WITHOUT binding 0.0.0.0 (which
// would expose the unauthenticated dashboard to the LAN). The bridge interface
// is host-local + container-network only, not routable from the LAN.

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.0.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/16`,
  } as NetworkInterfaceInfo;
}

function ipv6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  } as NetworkInterfaceInfo;
}

describe('detectContainerBridgeHosts', () => {
  test('finds the docker0 bridge gateway IPv4 address', () => {
    const ifaces = {
      lo: [ipv4('127.0.0.1', true)],
      eth0: [ipv4('192.168.1.50')],
      docker0: [ipv4('172.17.0.1')],
    };
    expect(detectContainerBridgeHosts(ifaces)).toEqual(['172.17.0.1']);
  });

  test('finds the podman bridge gateway', () => {
    const ifaces = { 'cni-podman0': [ipv4('10.88.0.1')] };
    expect(detectContainerBridgeHosts(ifaces)).toEqual(['10.88.0.1']);
  });

  test('ignores IPv6 and internal addresses on the bridge', () => {
    const ifaces = {
      docker0: [ipv4('172.17.0.1'), ipv6('fe80::1'), ipv4('127.0.0.5', true)],
    };
    expect(detectContainerBridgeHosts(ifaces)).toEqual(['172.17.0.1']);
  });

  test('returns empty when no bridge interface is present', () => {
    const ifaces = { lo: [ipv4('127.0.0.1', true)], eth0: [ipv4('10.0.0.2')] };
    expect(detectContainerBridgeHosts(ifaces)).toEqual([]);
  });
});

describe('isContainerRunner', () => {
  test('docker and podman are container runners', () => {
    expect(isContainerRunner('docker')).toBe(true);
    expect(isContainerRunner('podman')).toBe(true);
  });
  test('host-process is not a container runner', () => {
    expect(isContainerRunner('dangerously-host-process-without-any-isolation')).toBe(false);
  });
});

describe('resolveDaemonBindHosts', () => {
  const docker0 = { docker0: [ipv4('172.17.0.1')] };

  test('linux + docker + bridge present: binds loopback AND the bridge gateway', () => {
    const r = resolveDaemonBindHosts({
      configBind: '127.0.0.1',
      platform: 'linux',
      runnerType: 'docker',
      interfaces: docker0,
    });
    expect(r.hosts).toEqual(['127.0.0.1', '172.17.0.1']);
    expect(r.bridgeUnreachable).toBe(false);
  });

  test('linux + docker + NO bridge: loopback only, flagged unreachable', () => {
    const r = resolveDaemonBindHosts({
      configBind: '127.0.0.1',
      platform: 'linux',
      runnerType: 'docker',
      interfaces: { lo: [ipv4('127.0.0.1', true)] },
    });
    expect(r.hosts).toEqual(['127.0.0.1']);
    // The container runner WILL need a bridge-reachable bind but none was found.
    expect(r.bridgeUnreachable).toBe(true);
  });

  test('macOS + docker: loopback only (host.docker.internal proxies to loopback)', () => {
    const r = resolveDaemonBindHosts({
      configBind: '127.0.0.1',
      platform: 'darwin',
      runnerType: 'docker',
      interfaces: docker0,
    });
    expect(r.hosts).toEqual(['127.0.0.1']);
    expect(r.bridgeUnreachable).toBe(false);
  });

  test('linux + host-process runner: loopback only, no bridge bind', () => {
    const r = resolveDaemonBindHosts({
      configBind: '127.0.0.1',
      platform: 'linux',
      runnerType: 'dangerously-host-process-without-any-isolation',
      interfaces: docker0,
    });
    expect(r.hosts).toEqual(['127.0.0.1']);
    expect(r.bridgeUnreachable).toBe(false);
  });

  test('explicit non-loopback bind is respected exactly — no auto-added interfaces', () => {
    // INVARIANT: principle of least surprise. If the user set [server] bind,
    // we bind exactly that and nothing else (0.0.0.0 already covers containers;
    // a specific IP is the user's deliberate choice).
    const r = resolveDaemonBindHosts({
      configBind: '0.0.0.0',
      platform: 'linux',
      runnerType: 'docker',
      interfaces: docker0,
    });
    expect(r.hosts).toEqual(['0.0.0.0']);
    expect(r.bridgeUnreachable).toBe(false);
  });
});

// Mechanism check: two listeners on the SAME port but different local IPs (the
// loopback + bridge dual-bind the daemon relies on) is a valid socket setup.
// SECOND_LOOPBACK_HOST stands in for a second host interface — it's in the
// loopback range and bindable on Linux without privileges. Not every host has
// it (macOS configures only 127.0.0.1 on lo0), so the suite is gated on the
// address actually being bindable and says so when it skips; see
// test/helpers/second-loopback.ts for why that costs no coverage.
import { tryBindTcpPort } from '../../src/server';
import { SECOND_LOOPBACK_HOST, secondLoopbackSuiteSkipped } from '../helpers/second-loopback';

describe.skipIf(secondLoopbackSuiteSkipped('dual-bind mechanism'))(
  'dual-bind mechanism (same port, two interfaces)',
  () => {
    test('a second interface can bind the exact port the primary already holds', () => {
      const handler = async () => new Response('ok');
      const primary = tryBindTcpPort(0, handler, 1, '127.0.0.1');
      expect(primary).not.toBeNull();
      const port = primary!.server.port!;
      let secondary: ReturnType<typeof tryBindTcpPort> = null;
      try {
        secondary = tryBindTcpPort(port, handler, 1, SECOND_LOOPBACK_HOST);
        expect(secondary).not.toBeNull();
        expect(secondary!.server.port).toBe(port);
        expect(secondary!.server.hostname).toBe(SECOND_LOOPBACK_HOST);
      } finally {
        primary!.server.stop(true);
        secondary?.server.stop(true);
      }
    });
  },
);

// INVARIANT: the credential proxy is bound where a task container can reach
// it, under exactly the daemon port's conditions. A container dials the proxy
// at host.docker.internal:<port>; on native Linux Docker that is the bridge
// gateway, and a loopback-only proxy refuses every model call the container
// makes — no fleet turn can complete. Managed mode pins `[proxy] bind` to
// loopback and that pin stays: the gateway is bound IN ADDITION, never
// 0.0.0.0. The proxy authenticates by placeholder lookup, not by source
// address, so binding the bridge changes who can connect, not who is served.
describe('resolveProxyBindHosts', () => {
  const ifaces = { docker0: [ipv4('172.17.0.1')], lo: [ipv4('127.0.0.1', true)] };

  test('linux + docker + bridge present: loopback AND the bridge gateway', () => {
    const r = resolveProxyBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'docker', interfaces: ifaces });
    expect(r.hosts).toEqual(['127.0.0.1', '172.17.0.1']);
    expect(r.bridgeUnreachable).toBe(false);
  });

  test('linux + podman + bridge present: same, off the podman bridge', () => {
    const r = resolveProxyBindHosts({
      configBind: '127.0.0.1', platform: 'linux', runnerType: 'podman', interfaces: { podman0: [ipv4('10.88.0.1')] },
    });
    expect(r.hosts).toEqual(['127.0.0.1', '10.88.0.1']);
  });

  test('linux + docker + NO bridge: loopback only, flagged unreachable', () => {
    const r = resolveProxyBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'docker', interfaces: { lo: [ipv4('127.0.0.1', true)] } });
    expect(r.hosts).toEqual(['127.0.0.1']);
    expect(r.bridgeUnreachable).toBe(true);
  });

  test('macOS + docker, and the host-process runner anywhere: loopback only', () => {
    expect(resolveProxyBindHosts({ configBind: '127.0.0.1', platform: 'darwin', runnerType: 'docker', interfaces: ifaces }).hosts)
      .toEqual(['127.0.0.1']);
    expect(resolveProxyBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'dangerously-host-process-without-any-isolation', interfaces: ifaces }).hosts)
      .toEqual(['127.0.0.1']);
  });

  test('an explicit [proxy] bind is respected exactly — nothing is added, and 0.0.0.0 is never chosen', () => {
    expect(resolveProxyBindHosts({ configBind: '10.0.0.5', platform: 'linux', runnerType: 'docker', interfaces: ifaces }).hosts)
      .toEqual(['10.0.0.5']);
    expect(resolveProxyBindHosts({ configBind: '0.0.0.0', platform: 'linux', runnerType: 'docker', interfaces: ifaces }).hosts)
      .toEqual(['0.0.0.0']);
    for (const r of [
      resolveProxyBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'docker', interfaces: ifaces }),
      resolveDaemonBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'docker', interfaces: ifaces }),
    ]) expect(r.hosts).not.toContain('0.0.0.0');
  });
});

// INVARIANT: a bridge with no container attached is NO-CARRIER, and
// `os.networkInterfaces()` omits it (libuv lists only IFF_UP && IFF_RUNNING).
// MEASURED on the smolvm fleet demo: dockerd assigned docker0 172.17.0.1 one
// second before the daemon started, bun listed only lo and eth0, the daemon
// warned "no docker/podman bridge interface was detected" and bound loopback
// only — then every container it launched was refused. A daemon on a fresh
// host ALWAYS starts before its first container, so the fallback reads the
// address from the kernel, which assigns it regardless of carrier.
describe('a NO-CARRIER bridge is still found', () => {
  const noBridgeListed = { lo: [ipv4('127.0.0.1', true)], eth0: [ipv4('100.96.0.2')] };
  const ipOutput = '4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever\n';

  test('the kernel fallback supplies the gateway when networkInterfaces omits the bridge', () => {
    const asked: string[] = [];
    const read = (iface: string) => { asked.push(iface); return iface === 'docker0' ? parseIpAddrOutput(ipOutput) : []; };
    expect(detectContainerBridgeHosts(noBridgeListed, read)).toEqual(['172.17.0.1']);
    expect(asked).toContain('docker0');
    const r = resolveProxyBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'docker', interfaces: noBridgeListed, readIpv4Addrs: read });
    expect(r.hosts).toEqual(['127.0.0.1', '172.17.0.1']);
    expect(r.bridgeUnreachable).toBe(false);
  });

  test('the fallback is not consulted for a bridge networkInterfaces already lists', () => {
    const asked: string[] = [];
    const read = (iface: string) => { asked.push(iface); return []; };
    expect(detectContainerBridgeHosts({ docker0: [ipv4('172.17.0.1')] }, read)).toEqual(['172.17.0.1']);
    expect(asked).not.toContain('docker0');
  });

  test('parses ip -4 -o addr show output, and nothing else', () => {
    expect(parseIpAddrOutput(ipOutput)).toEqual(['172.17.0.1']);
    expect(parseIpAddrOutput('')).toEqual([]);
    expect(parseIpAddrOutput('Device "docker0" does not exist.')).toEqual([]);
  });

  test('injected interfaces alone never reach the kernel (a docker0 on the test machine cannot leak in)', () => {
    expect(resolveDaemonBindHosts({ configBind: '127.0.0.1', platform: 'linux', runnerType: 'docker', interfaces: noBridgeListed }).hosts)
      .toEqual(['127.0.0.1']);
  });
});
