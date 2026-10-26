/**
 * The routes between the host and a solo smolvm machine (src/vm/solo-routes.ts):
 * the daemon's route mux a task container's callbacks arrive at, the service
 * tunnels the host reaches task services through, the runner wiring both, and
 * the guest's per-connection scripts. Real sockets on loopback; smolvm and
 * the guest engine are faked. The VM path runs only on the engineer's Mac.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { connect, createServer, type Server, type Socket } from 'net';
import { join } from 'path';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import { clearDaemonContext, setDaemonContext } from '../../src/daemon/context';
import { createSmolvmRunner, closeSmolvmRelaysForTests, type SmolvmRunnerDeps } from '../../src/runner/smolvm-runner';
import type { DialedProcess } from '../../src/vm/docker-relay';
import type { SmolvmRunner as SmolvmCli, SmolvmResult } from '../../src/vm/smolvm-docker-machine';
import { soloMachineName, type MachineRecord, type SoloShareInputs } from '../../src/vm/smolvm-project-machine';
import { RpcError } from '../../src/daemon/rpc-error';
import { handleSmolvmServiceBindings, runsOnSmolvm } from '../../src/daemon/rpc-handlers';
import { RELAYS_SCRIPT, ServiceTunnels, guestRelayArgv, startRouteMux, type RouteMuxHandle } from '../../src/vm/solo-routes';

let root: string;
const servers: Server[] = [];
const sockets: Socket[] = [];
const muxes: RouteMuxHandle[] = [];
const savedEnv = { ...process.env };
beforeEach(async () => { root = await realpath(await mkdtemp(join('/tmp', 'svroutes-'))); });
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const m of muxes.splice(0)) await m.close();
  await closeSmolvmRelaysForTests();
  clearDaemonContext();
  process.env = { ...savedEnv };
  await rm(root, { recursive: true, force: true });
});

/** A loopback server that answers each connection with `<name>:` + everything it received, once the client half-closes. */
async function namedServer(name: string, port = 0): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    sockets.push(sock);
    let got = '';
    sock.on('data', (d) => { got += d.toString(); });
    sock.on('end', () => { seen.push(got); sock.end(`${name}:${got}`); });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  servers.push(server);
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, seen };
}

/** Send `payload`, half-close, and read the whole answer ('' when the far side just closed). */
function exchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const s: Socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    let out = '';
    s.on('data', (d) => { out += d.toString(); });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.on('connect', () => s.end(payload));
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const address = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return typeof address === 'object' && address ? address.port : 0;
}

describe('the route mux (task containers → lazy on the host)', () => {
  // INVARIANT: the mux reaches the daemon and its proxy and NOTHING else. The
  // first line picks one of those two; any other line, or a route that is not
  // listening, closes the connection without dialing anything.
  test('the first line picks the daemon or the proxy, and the rest of the connection goes through', async () => {
    const daemon = await namedServer('daemon');
    const proxy = await namedServer('proxy');
    const mux = await startRouteMux(await freePort(), () => ({
      daemon: { host: '127.0.0.1', port: daemon.port }, proxy: { host: '127.0.0.1', port: proxy.port },
    }));
    muxes.push(mux);
    expect(await exchange(mux.port, 'LAZY-ROUTE daemon\nPOST /mcp/x HTTP/1.1\r\n\r\n')).toBe('daemon:POST /mcp/x HTTP/1.1\r\n\r\n');
    expect(await exchange(mux.port, 'LAZY-ROUTE proxy\nPOST /v1/messages HTTP/1.1\r\n\r\n')).toBe('proxy:POST /v1/messages HTTP/1.1\r\n\r\n');
  });

  test('an unknown route, a route that is not listening, or no route line reaches nothing', async () => {
    const daemon = await namedServer('daemon');
    const mux = await startRouteMux(await freePort(), () => ({ daemon: { host: '127.0.0.1', port: daemon.port }, proxy: null }));
    muxes.push(mux);
    expect(await exchange(mux.port, 'LAZY-ROUTE ssh\nhello')).toBe('');
    expect(await exchange(mux.port, 'LAZY-ROUTE proxy\nhello')).toBe('');
    expect(await exchange(mux.port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n')).toBe('');
    expect(await exchange(mux.port, 'x'.repeat(200))).toBe('');
    expect(daemon.seen).toEqual([]);
  });

  test('listens on loopback only', async () => {
    const mux = await startRouteMux(await freePort(), () => ({ daemon: null, proxy: null }));
    muxes.push(mux);
    const other = Object.values(require('os').networkInterfaces()).flat()
      .find((i: any) => i && i.family === 'IPv4' && !i.internal) as { address: string } | undefined;
    if (!other) return; // a host with no non-loopback address has nothing to check
    const refused = await new Promise<boolean>((resolve) => {
      const s = connect({ host: other.address, port: mux.port });
      s.on('connect', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});

const SECRET = 'ab'.repeat(32);

/** A fake of the machine's published services port: reads `LAZY-PORT <secret> <n>` and answers as that guest port. */
async function fakeServicesRouter(port = 0): Promise<{ port: number; lines: string[] }> {
  const lines: string[] = [];
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    sockets.push(sock);
    let got = '';
    sock.on('data', (d) => { got += d.toString(); });
    sock.on('end', () => {
      const nl = got.indexOf('\n');
      lines.push(got.slice(0, nl));
      sock.end(`guest ${got.slice(0, nl).split(' ').pop()} got ${got.slice(nl + 1)}`);
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  servers.push(server);
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, lines };
}

describe('service tunnels (the host → task services)', () => {
  test('a tunnel names the guest port to the machine\'s one published port and splices the connection', async () => {
    const router = await fakeServicesRouter();
    const tunnels = new ServiceTunnels();
    try {
      const port = await tunnels.open(router.port, 49154, SECRET);
      expect(await exchange(port, 'GET / HTTP/1.1\r\n\r\n')).toBe('guest 49154 got GET / HTTP/1.1\r\n\r\n');
      expect(router.lines).toEqual([`LAZY-PORT ${SECRET} 49154`]);
      // The same guest port keeps its host port; another gets its own.
      expect(await tunnels.open(router.port, 49154, SECRET)).toBe(port);
      expect(await tunnels.open(router.port, 49155, SECRET)).not.toBe(port);
    } finally {
      await tunnels.closeAll();
    }
  });

  test('a tunnel unused for a day, with nothing open, is closed', async () => {
    const router = await fakeServicesRouter();
    let now = 1_000;
    const tunnels = new ServiceTunnels(() => now);
    try {
      const port = await tunnels.open(router.port, 40000, SECRET);
      now += 25 * 60 * 60 * 1000;
      await tunnels.open(router.port, 40001, SECRET); // any open sweeps
      expect(await exchange(port, 'x')).toBe('');
    } finally {
      await tunnels.closeAll();
    }
  });
});

// ── the runner wiring both ────────────────────────────────────────────────

/** A docker CLI fake answering `port <name>` the way docker does for a guest-loopback publish. */
const DOCKER = `#!/bin/sh
if [ "$1" = port ]; then echo "3000/tcp -> 127.0.0.1:49154"; exit 0; fi
if [ "$1" = --version ]; then echo "Docker version 27.0.0"; exit 0; fi
exit 0
`;

async function runnerFixture() {
  const project = join(root, 'proj');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'sock'), { recursive: true });
  const image = join(root, 'lazy-daemon.tar');
  await writeFile(image, 'tar');
  const docker = join(root, 'docker');
  await writeFile(docker, DOCKER);
  await chmod(docker, 0o755);
  const calls: string[][] = [];
  const machines = new Map<string, string>();
  const cli: SmolvmCli = async (argv) => {
    calls.push(argv);
    const name = argv[argv.indexOf('--name') + 1]!;
    const ok = (stdout = ''): SmolvmResult => ({ exitCode: 0, stdout, stderr: '' });
    if (argv[1] === 'ls') return ok(JSON.stringify([...machines].map(([n, state]) => ({ name: n, state }))));
    if (argv[1] === 'create') machines.set(name, 'stopped');
    if (argv[1] === 'start') machines.set(name, 'running');
    return ok('27.0.0');
  };
  const shares: SoloShareInputs = {
    projectRoot: project, gitCommonDir: join(project, '.git'), protocolProjectDir: project, agentBinDir: project,
    mcpConfigDir: project, oneshotDir: project, mounts: [], runArgSources: [],
  };
  const deps: SmolvmRunnerDeps = {
    stateRoot: join(root, 'state'), socketRoot: join(root, 'sock'), dockerCli: docker,
    verifyBinary: async (p) => p, cli: () => cli,
    dial: () => () => Bun.spawn(['true'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as DialedProcess,
    shareInputs: async () => shares,
  };
  const config = structuredClone(DEFAULT_CONFIG) as ResolvedConfig;
  config.runner.type = 'smolvm';
  config.smolvm = { ...config.smolvm, binary: '/opt/smolvm/smolvm', image };
  const recordPath = join(deps.stateRoot, soloMachineName(project), 'machine.json');
  return { project, config, deps, calls, recordPath };
}

describe('the smolvm runner wires the routes', () => {
  test('in the daemon, a launch starts the route mux on the recorded port and the guest relays carry the daemon and proxy ports', async () => {
    process.env.LAZY_IS_DAEMON = '1';
    const daemon = await namedServer('daemon');
    const proxy = await namedServer('proxy');
    setDaemonContext({ webPort: daemon.port, token: 't', bindHost: '127.0.0.1', proxyPort: proxy.port });
    const f = await runnerFixture();
    const runner = await createSmolvmRunner(f.project, f.config, f.deps);
    await runner.ensureMachine();

    const record = JSON.parse(await readFile(f.recordPath, 'utf8')) as MachineRecord;
    const relays = f.calls.find((c) => c.includes('lazy-solo-relays'))!;
    expect(relays.slice(-4)).toEqual(['daemon', String(daemon.port), 'proxy', String(proxy.port)]);
    // What a guest relay sends through smolvm's mapping arrives at the daemon.
    expect(await exchange(record.routes!.hostService.hostPort, 'LAZY-ROUTE daemon\nhi')).toBe('daemon:hi');
    expect(await exchange(record.routes!.hostService.hostPort, 'LAZY-ROUTE proxy\nhi')).toBe('proxy:hi');
  });

  // INVARIANT: a smolvm task's published ports are answered as HOST addresses
  // that go through the machine's one published port — so `lazy url`, the
  // dashboard and the serve proxy (which dial binding.hostAddress:hostPort)
  // reach the service with nothing smolvm-specific of their own.
  test('a run\'s published guest port is answered with a loopback tunnel through the machine\'s services port', async () => {
    process.env.LAZY_IS_DAEMON = '1';
    const f = await runnerFixture();
    const runner = await createSmolvmRunner(f.project, f.config, f.deps);
    await runner.ensureMachine();
    const record = JSON.parse(await readFile(f.recordPath, 'utf8')) as MachineRecord;
    const router = await fakeServicesRouter(record.routes!.services.hostPort);

    const bindings = await runner.getRunPortBindings('lazy-task-1');
    expect(bindings).toHaveLength(1);
    expect(bindings![0]!.containerPort).toBe(3000);
    expect(bindings![0]!.hostAddress).toBe('127.0.0.1');
    expect(bindings![0]!.hostPort).not.toBe(49154);
    expect(await exchange(bindings![0]!.hostPort, 'GET /hello HTTP/1.1\r\n\r\n')).toBe('guest 49154 got GET /hello HTTP/1.1\r\n\r\n');
    // The line carries the machine's services secret, kept 0600 in its state dir.
    const secretPath = join(f.deps.stateRoot, soloMachineName(f.project), 'services-secret');
    const secret = (await readFile(secretPath, 'utf8')).trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    expect(router.lines).toEqual([`LAZY-PORT ${secret} 49154`]);
    // …and the guest relays were handed the same one.
    expect(f.calls.find((c) => c.includes('lazy-solo-relays'))).toContain(secret);
  });
});

describe('the guest relays', () => {
  test('are one sh -c exec with the run dir, gateway and both guest ports, plus each callback route', () => {
    const argv = guestRelayArgv({ daemon: 26024, proxy: 40123 }, SECRET);
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(argv.slice(3)).toEqual(['lazy-solo-relays', '/run/lazy-solo', '100.96.0.1', '26090', '26091', SECRET, 'daemon', '26024', 'proxy', '40123']);
    expect(guestRelayArgv(null, SECRET).slice(3)).toEqual(['lazy-solo-relays', '/run/lazy-solo', '100.96.0.1', '26090', '26091', SECRET]);
  });

  // INVARIANT: the guest relays bind one address each — the docker bridge
  // gateway for callbacks, the link address for services — never 0.0.0.0.
  test('never listen on every address', () => {
    const listens = RELAYS_SCRIPT.match(/TCP4-LISTEN:[^"\s]*/g) ?? [];
    expect(listens.length).toBeGreaterThan(0);
    for (const l of listens) expect(l).toMatch(/^TCP4-LISTEN:\$port,bind=\$bind/);
    expect(RELAYS_SCRIPT).not.toMatch(/bind=0\.0\.0\.0|TCP4-LISTEN:\$port,(?!bind)/);
  });

  // The per-connection scripts, run for real under socat where it is installed.
  const socat = Bun.which('socat');
  const routeScript = (name: string) => {
    const m = new RegExp(`cat >"\\$RUN/${name}" <<'EOF'\\n([\\s\\S]*?)\\nEOF`).exec(RELAYS_SCRIPT);
    if (!m) throw new Error(`no ${name} in the relays script`);
    return m[1]!;
  };
  async function socatListener(script: string, args: string): Promise<{ port: number; stop: () => void }> {
    // Beside the script, as the relays script leaves it in the run dir.
    await writeFile(join(root, 'service-secret'), `${SECRET}\n`, { mode: 0o600 });
    const path = join(root, `route-${Math.random().toString(36).slice(2)}.sh`);
    await writeFile(path, script);
    await chmod(path, 0o755);
    const port = await freePort();
    const proc = Bun.spawn([socat!, `TCP4-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork`, `EXEC:${path}${args ? ` ${args}` : ''}`], { stdout: 'ignore', stderr: 'ignore' });
    for (let i = 0; i < 50; i++) {
      const up = await new Promise<boolean>((r) => { const s = connect({ host: '127.0.0.1', port }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
      if (up) break;
      await Bun.sleep(50);
    }
    return { port, stop: () => proc.kill() };
  }

  test.skipIf(!socat)('the services router reads one line and connects to that guest-loopback port, consuming nothing after it', async () => {
    const service = await namedServer('svc');
    const l = await socatListener(routeScript('service-route.sh'), '');
    try {
      expect(await exchange(l.port, `LAZY-PORT ${SECRET} ${service.port}\nGET / HTTP/1.1\r\n\r\n`)).toBe('svc:GET / HTTP/1.1\r\n\r\n');
      expect(await exchange(l.port, `LAZY-PORT ${SECRET} 22\nx`)).toBe('');
      expect(await exchange(l.port, 'GET / HTTP/1.1\r\n\r\n')).toBe('');
    } finally { l.stop(); }
  });

  // INVARIANT: every container in the machine can reach the services router
  // (it is on the guest's own link address), so a route line WITHOUT the
  // machine's secret reaches nothing — otherwise a task or run container could
  // reach another's published services and break turn/run isolation.
  test.skipIf(!socat)('the services router refuses a route line without the machine\'s secret', async () => {
    const service = await namedServer('svc');
    const l = await socatListener(routeScript('service-route.sh'), '');
    try {
      expect(await exchange(l.port, `LAZY-PORT ${service.port}\nGET / HTTP/1.1\r\n\r\n`)).toBe('');
      expect(await exchange(l.port, `LAZY-PORT ${'cd'.repeat(32)} ${service.port}\nGET /\r\n\r\n`)).toBe('');
      expect(await exchange(l.port, `LAZY-PORT ${SECRET.slice(0, 10)} ${service.port}\nGET /\r\n\r\n`)).toBe('');
      expect(await exchange(l.port, `LAZY-PORT  ${service.port}\nGET /\r\n\r\n`)).toBe('');
      expect(await exchange(l.port, `LAZY-PORT ${SECRET}\nGET /\r\n\r\n`)).toBe('');
      expect(service.seen).toEqual([]);
    } finally { l.stop(); }
  });

  test('the guest keeps the secret 0600 in its run dir, never on a container mount, and the router reads it from there', () => {
    expect(RELAYS_SCRIPT).toContain('umask 077; printf \'%s\\n\' "$SECRET" >"$RUN/service-secret.tmp"');
    expect(RELAYS_SCRIPT).toContain('chmod 0700 "$RUN"');
    expect(routeScript('service-route.sh')).toContain('want=$(cat "$dir/service-secret"');
  });

  // INVARIANT: the callback relays a container is MEANT to reach lead only to
  // the host's route mux, which serves the daemon and its proxy and nothing
  // else — so they need no secret, and must not be able to name another target.
  test('callback relays only ever dial the one mapping, naming a route the mux allows', () => {
    const cb = routeScript('callback-route.sh');
    expect(cb).toContain('exec 3<>"/dev/tcp/$2/$3"');
    expect(RELAYS_SCRIPT).toContain('"EXEC:$RUN/callback-route.sh $route $GATEWAY $HS_PORT"');
    expect(RELAYS_SCRIPT).toContain("case \"$route\" in *[!a-z]*|'') fail");
  });

  /**
   * An upstream that closes FIRST: `answer` replies to the first data it gets
   * and closes; `idle` closes after a quiet spell without reading anything.
   */
  async function closingUpstream(mode: 'answer' | 'idle'): Promise<{ port: number; got: () => string }> {
    let got = '';
    const server = createServer((sock) => {
      sockets.push(sock);
      if (mode === 'idle') { setTimeout(() => sock.destroy(), 300); return; }
      sock.on('data', (d) => {
        got += d.toString();
        if (got.includes('\r\n\r\n')) sock.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    const address = server.address();
    return { port: typeof address === 'object' && address ? address.port : 0, got: () => got };
  }

  /** Write without half-closing (a keep-alive client), and time how long until the far side closes. */
  function untilClosed(port: number, payload: string, limitMs = 5000): Promise<{ out: string; ms: number | null }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const s: Socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      sockets.push(s);
      let out = '';
      const timer = setTimeout(() => { s.destroy(); resolve({ out, ms: null }); }, limitMs);
      const done = () => { clearTimeout(timer); resolve({ out, ms: Date.now() - started }); };
      s.on('data', (d) => { out += d.toString(); });
      s.once('end', done);
      s.once('close', done);
      s.on('error', () => {});
      s.on('connect', () => { if (payload) s.write(payload); });
    });
  }

  // INVARIANT: when the HOST side closes first — a response with
  // Connection: close, or an idle keep-alive the daemon or proxy drops — the
  // container sees the close at once. A relay that held the connection open
  // would leave an MCP client or a model request waiting on a dead socket.
  test.skipIf(!socat)('a callback relay passes a host-first close straight to the container', async () => {
    const answering = await closingUpstream('answer');
    const l = await socatListener(routeScript('callback-route.sh'), `proxy 127.0.0.1 ${answering.port}`);
    try {
      const r = await untilClosed(l.port, 'POST /v1/messages HTTP/1.1\r\n\r\n');
      expect(r.out).toContain('200 OK');
      expect(r.ms).not.toBeNull();
      expect(r.ms!).toBeLessThan(2000);
      expect(answering.got()).toStartWith('LAZY-ROUTE proxy\n');
    } finally { l.stop(); }
    const idle = await closingUpstream('idle');
    const l2 = await socatListener(routeScript('callback-route.sh'), `daemon 127.0.0.1 ${idle.port}`);
    try {
      const r = await untilClosed(l2.port, '');
      expect(r.ms).not.toBeNull();
      expect(r.ms!).toBeLessThan(2000);
    } finally { l2.stop(); }
  });

  test.skipIf(!socat)('the services router passes a host-first close straight to the host', async () => {
    const answering = await closingUpstream('answer');
    const l = await socatListener(routeScript('service-route.sh'), '');
    try {
      const r = await untilClosed(l.port, `LAZY-PORT ${SECRET} ${answering.port}\nGET / HTTP/1.1\r\n\r\n`);
      expect(r.out).toContain('200 OK');
      expect(r.ms).not.toBeNull();
      expect(r.ms!).toBeLessThan(2000);
    } finally { l.stop(); }
    const idle = await closingUpstream('idle');
    const l2 = await socatListener(routeScript('service-route.sh'), '');
    try {
      const r = await untilClosed(l2.port, `LAZY-PORT ${SECRET} ${idle.port}\n`);
      expect(r.ms).not.toBeNull();
      expect(r.ms!).toBeLessThan(2000);
    } finally { l2.stop(); }
  });

  test.skipIf(!socat)('a callback relay names its route on the one mapping, then splices', async () => {
    const mapping = await namedServer('host');
    const l = await socatListener(routeScript('callback-route.sh'), `daemon 127.0.0.1 ${mapping.port}`);
    try {
      expect(await exchange(l.port, 'POST /mcp HTTP/1.1\r\n\r\n')).toBe('host:LAZY-ROUTE daemon\nPOST /mcp HTTP/1.1\r\n\r\n');
    } finally { l.stop(); }
  });
});

describe('the smolvmServiceBindings RPC', () => {
  const docker = async () => ({ runner: { type: 'docker' } });
  const storageWith = (tasks: Array<{ id: string; runner_type?: string; session?: { container_name: string; runner_type: string } }>) => async () => ({
    listTasks: async () => tasks as never,
    getSessionByTaskId: async (id: string) => (tasks.find((t) => t.id === id)?.session ?? null) as never,
  });

  // INVARIANT: nothing smolvm-related is set up for a project or a run that is
  // not on smolvm — the RPC refuses before it creates a smolvm runner (relay,
  // machine state).
  test('refuses with 400 for a run that is not on smolvm, before creating anything', async () => {
    const err = await handleSmolvmServiceBindings(root, { runName: 'lazy-task-1' }, { loadConfig: docker, getStorage: storageWith([]) }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('does not run on the smolvm runner');
    const notSmolvmTask = await handleSmolvmServiceBindings(root, { runName: 'lazy-task-1' }, {
      loadConfig: docker, getStorage: storageWith([{ id: 't1', runner_type: 'docker', session: { container_name: 'lazy-task-1', runner_type: 'docker' } }]),
    }).catch((e) => e);
    expect(notSmolvmTask.status).toBe(400);
  });

  test('a smolvm project, or a task on smolvm by override, is a smolvm run', async () => {
    expect(await runsOnSmolvm(root, 'lazy-x', { loadConfig: async () => ({ runner: { type: 'smolvm' } }), getStorage: storageWith([]) })).toBe(true);
    expect(await runsOnSmolvm(root, 'lazy-task-1', {
      loadConfig: docker, getStorage: storageWith([{ id: 't1', runner_type: 'smolvm', session: { container_name: 'lazy-task-1', runner_type: 'smolvm' } }]),
    })).toBe(true);
    expect(await runsOnSmolvm(root, 'lazy-other', {
      loadConfig: docker, getStorage: storageWith([{ id: 't1', runner_type: 'smolvm', session: { container_name: 'lazy-task-1', runner_type: 'smolvm' } }]),
    })).toBe(false);
  });
});

describe('a client that resets while its upstream is still being dialed', () => {
  /** A dialer that holds until released, then connects for real; records what it handed back. */
  function slowDialer() {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const handed: Socket[] = [];
    const dialer = async (host: string, port: number) => {
      await released;
      const s = await new Promise<Socket>((resolve, reject) => {
        const c = connect({ host, port, allowHalfOpen: true });
        c.once('connect', () => resolve(c));
        c.once('error', reject);
      });
      handed.push(s);
      return s;
    };
    return { dialer, release, handed };
  }

  /** A loopback server that records every byte any connection sends it. */
  async function recordingServer(): Promise<{ port: number; bytes: () => string }> {
    let all = '';
    const server = createServer((sock) => { sockets.push(sock); sock.on('data', (d) => { all += d.toString(); }); sock.on('error', () => {}); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    const address = server.address();
    return { port: typeof address === 'object' && address ? address.port : 0, bytes: () => all };
  }

  /** Connect, send `payload`, then RESET (RST, not FIN) the connection. */
  async function connectAndReset(port: number, payload: string): Promise<void> {
    const s = connect({ host: '127.0.0.1', port });
    s.on('error', () => {});
    await new Promise<void>((r) => s.once('connect', () => r()));
    if (payload) s.write(payload);
    await Bun.sleep(50);
    (s as Socket & { resetAndDestroy?: () => void }).resetAndDestroy?.() ?? s.destroy();
    await Bun.sleep(50);
  }

  // INVARIANT: a client reset during the dial never reaches the process as an
  // uncaught exception (in the daemon that is a crash), and the upstream that
  // connects afterwards is dropped rather than spliced to a dead socket.
  test('the route mux survives it and drops the late upstream', async () => {
    const upstream = await recordingServer();
    const slow = slowDialer();
    const mux = await startRouteMux(await freePort(), () => ({ daemon: { host: '127.0.0.1', port: upstream.port }, proxy: null }), slow.dialer);
    muxes.push(mux);
    await connectAndReset(mux.port, 'LAZY-ROUTE daemon\nhello');
    slow.release();
    for (let i = 0; i < 40 && !(slow.handed[0]?.destroyed); i++) await Bun.sleep(25);
    expect(slow.handed).toHaveLength(1);
    expect(slow.handed[0]!.destroyed).toBe(true);
    await Bun.sleep(50);
    expect(upstream.bytes()).toBe(''); // never spliced to the dead client
    // Still serving afterwards.
    const daemon = await namedServer('daemon');
    const mux2 = await startRouteMux(await freePort(), () => ({ daemon: { host: '127.0.0.1', port: daemon.port }, proxy: null }));
    muxes.push(mux2);
    expect(await exchange(mux.port, 'LAZY-ROUTE daemon\nok')).toBe(''); // mux 1's dialer stays held: nothing reached
    expect(await exchange(mux2.port, 'LAZY-ROUTE daemon\nok')).toBe('daemon:ok');
  });

  test('a service tunnel survives it and drops the late upstream', async () => {
    const router = await recordingServer();
    const slow = slowDialer();
    const tunnels = new ServiceTunnels(Date.now, slow.dialer);
    try {
      const port = await tunnels.open(router.port, 49154, SECRET);
      await connectAndReset(port, 'GET / HTTP/1.1\r\n\r\n');
      slow.release();
      for (let i = 0; i < 40 && !(slow.handed[0]?.destroyed); i++) await Bun.sleep(25);
      expect(slow.handed[0]!.destroyed).toBe(true);
      await Bun.sleep(50);
      expect(router.bytes()).toBe(''); // no route line: never spliced to the dead client
    } finally {
      await tunnels.closeAll();
    }
  });
});
