/**
 * The smolvm runner end to end on this host, with smolvm and the guest engine
 * faked: the runner's docker script → this process's relay socket → a faked
 * `machine exec … docker system dial-stdio` answering as the Engine API.
 * Nothing here boots a VM; the real path runs only on the engineer's Mac.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, readlink, lstat, realpath, rm, stat, writeFile, chmod } from 'fs/promises';
import { connect } from 'net';
import { join } from 'path';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import {
  createSmolvmRunner, closeSmolvmRelaysForTests, moveProtocolDirInto, SmolvmLivenessUnknownError, SmolvmRunner,
  SmolvmRunnerError, prepareSmolvmMcpConfig, type SmolvmRunnerDeps,
} from '../../src/runner/smolvm-runner';
import { containerCliOf } from '../../src/runner/container-cli';
import { FOREIGN_DOCKER_HOST_ENV } from '../../src/runner/sibling-containers';
import {
  engineErrorResponse, makeRelaySocketDir, relaySocketBase, startDockerRelay, sweepDeadRelayFiles, type DialedProcess,
} from '../../src/vm/docker-relay';
import type { SmolvmRunner as SmolvmCli, SmolvmResult } from '../../src/vm/smolvm-docker-machine';
import { soloMachineName, SmolvmMachineNeedsRecreateError, type SoloShareInputs } from '../../src/vm/smolvm-project-machine';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join('/tmp', 'svr-'))); });
afterEach(async () => {
  await closeSmolvmRelaysForTests();
  await rm(root, { recursive: true, force: true });
});

/** A faked guest engine on stdio: answers one HTTP request with the request line it got. */
const ENGINE = `
let buf = '';
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  const end = buf.indexOf('\\r\\n\\r\\n');
  if (end < 0) continue;
  const body = JSON.stringify({ engine: 'fake-guest', request: buf.slice(0, buf.indexOf('\\r\\n')) });
  process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\nConnection: close\\r\\n\\r\\n' + body);
  break;
}
`;

/** A faked docker CLI: one request (`<path> [METHOD]`) against DOCKER_HOST's unix socket, printing status and body. */
const DOCKER = `#!/usr/bin/env bun
// Like the real client, --version answers without asking the engine.
if (process.argv[2] === '--version') { console.log('Docker version 27.0.0, build fake'); process.exit(0); }
const sock = (process.env.DOCKER_HOST ?? '').replace(/^unix:\\/\\//, '');
const res = await fetch('http://engine/v1.47/' + (process.argv[2] ?? '_ping'), { unix: sock, method: process.argv[3] ?? 'GET' });
console.log(res.status, await res.text(), 'via', process.env.DOCKER_HOST, 'context', process.env.DOCKER_CONTEXT ?? '-');
process.exit(res.ok ? 0 : 1); // like the real client: an error response is a failed command
`;

async function fixtures() {
  const engine = join(root, 'engine.ts');
  await writeFile(engine, ENGINE);
  const docker = join(root, 'docker');
  await writeFile(docker, DOCKER);
  await chmod(docker, 0o755);
  const project = join(root, 'proj');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'sock'), { recursive: true });
  const image = join(root, 'lazy-daemon.tar');
  await writeFile(image, 'tar');
  return { engine, docker, project, image, machine: soloMachineName(project) };
}

/** A smolvm CLI fake with a machine table the test controls; `lsFails` makes the listing fail. */
function fakeCli(initial: Record<string, string> = {}) {
  const calls: string[][] = [];
  const machines = new Map<string, string>(Object.entries(initial));
  const state = { lsFails: false };
  const cli: SmolvmCli = async (argv) => {
    calls.push(argv);
    const name = argv[argv.indexOf('--name') + 1]!;
    const ok = (stdout = ''): SmolvmResult => ({ exitCode: 0, stdout, stderr: '' });
    if (argv[1] === 'ls') {
      if (state.lsFails) return { exitCode: 1, stdout: '', stderr: 'smolvm: cannot read its state' };
      return ok(JSON.stringify([...machines].map(([n, st]) => ({ name: n, state: st }))));
    }
    if (argv[1] === 'create') machines.set(name, 'stopped');
    if (argv[1] === 'start') machines.set(name, 'running');
    return ok('27.0.0');
  };
  return { cli, calls, machines, state };
}

function config(f: Awaited<ReturnType<typeof fixtures>>, over: Partial<ResolvedConfig['smolvm']> = {}): ResolvedConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runner.type = 'smolvm';
  c.smolvm = { ...c.smolvm, binary: '/opt/smolvm/smolvm', image: f.image, ...over };
  return c;
}

type Deps = SmolvmRunnerDeps & { dials: string[][]; fake: ReturnType<typeof fakeCli> };
function deps(f: Awaited<ReturnType<typeof fixtures>>, over: Partial<SmolvmRunnerDeps> = {}, machines: Record<string, string> = { [f.machine]: 'running' }): Deps {
  const dials: string[][] = [];
  const fake = fakeCli(machines);
  const shares: SoloShareInputs = {
    projectRoot: f.project, gitCommonDir: join(f.project, '.git'), protocolProjectDir: f.project, agentBinDir: f.project,
    mcpConfigDir: f.project, oneshotDir: f.project, mounts: [], runArgSources: [],
  };
  return {
    dials,
    fake,
    stateRoot: join(root, 'state'),
    socketRoot: join(root, 'sock'),
    dockerCli: f.docker,
    verifyBinary: async (p) => p,
    cli: () => fake.cli,
    dial: (binary, machine) => () => {
      dials.push([binary, machine]);
      return Bun.spawn(['bun', f.engine], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as DialedProcess;
    },
    shareInputs: async () => shares,
    ...over,
  };
}

async function runCli(cli: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, DOCKER_CONTEXT: 'desktop-linux' };
  const proc = Bun.spawn([cli, ...args], { stdout: 'pipe', stderr: 'pipe', env });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** A dial whose guest engine does not answer: the exec dies at once. */
const deadDial = () => () => Bun.spawn(['sh', '-c', 'echo "Cannot connect to the Docker daemon" >&2; exit 1'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as DialedProcess;

describe('the smolvm runner drives the guest engine through the docker runner', () => {
  test('its docker client reaches the machine\'s engine through this process\'s relay, never another context', async () => {
    const f = await fixtures();
    const d = deps(f);
    const runner = await createSmolvmRunner(f.project, config(f), d);
    expect(runner).toBeInstanceOf(SmolvmRunner);
    expect(runner.type).toBe('smolvm');
    const cli = containerCliOf(runner);
    const script = await readFile(cli, 'utf8');
    expect(script).toMatch(/DOCKER_HOST='unix:\/\/[^']+\/d\.sock'/);
    expect(script).toContain('unset DOCKER_CONTEXT');

    const { code, out } = await runCli(cli, 'containers/json');
    expect(code).toBe(0);
    expect(out).toContain('"engine":"fake-guest"');
    expect(out).toContain('GET /v1.47/containers/json');
    // INVARIANT: the user's active docker context cannot redirect the runner's
    // client to another engine (Docker Desktop's).
    expect(out).toContain('context -');
    expect(d.dials).toEqual([['/opt/smolvm/smolvm', runner.machineName]]);
  });

  // INVARIANT: the relay needs only a RUNNING machine. A machine a launch
  // refuses (here: no record of how it was created, so it needs recreating)
  // still answers ps and rm, so its live containers never look dead and can
  // still be stopped — while every launch is refused.
  test('a needs-recreate machine still answers ps and rm while a launch is refused', async () => {
    const f = await fixtures();
    const d = deps(f);
    const runner = await createSmolvmRunner(f.project, config(f), d);
    const ps = await runCli(containerCliOf(runner), 'containers/json');
    expect(ps.out).toContain('200');
    expect(ps.out).toContain('GET /v1.47/containers/json');
    const rmCall = await runCli(containerCliOf(runner), 'containers/lazy-abc?force=1', 'DELETE');
    expect(rmCall.out).toContain('200');
    expect(rmCall.out).toContain('DELETE /v1.47/containers/lazy-abc?force=1');

    const err = await runner.checkAvailability().catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmRunnerError);
    expect(err.message).toContain('has to be recreated');
    await expect(runner.runOneshot({ prompt: 'x', effort: 'low', repoAccess: 'none' } as never)).rejects.toThrow(/has to be recreated/);
    // Nothing was created, started or deleted on the way.
    expect(d.fake.calls.map((c) => c[1]).filter((v) => v !== 'ls')).toEqual([]);
  });

  // INVARIANT: lazy never executes an unverified smolvm — not for a launch,
  // not for the relay, not for a state probe. A pin failure is reported as
  // itself, never as "not running".
  test('a smolvm that fails the pin is never run: the relay and the liveness probe say why', async () => {
    const f = await fixtures();
    const d = deps(f, { verifyBinary: async () => { throw new Error('vendored for smolvm 1.9.3'); } });
    const runner = await createSmolvmRunner(f.project, config(f), d);
    const { out } = await runCli(containerCliOf(runner), 'containers/json');
    expect(out).toContain('503');
    expect(out).toContain('vendored for smolvm 1.9.3');
    await expect(runner.isRunning('lazy-abc')).rejects.toThrow(/vendored for smolvm 1\.9\.3/);
    await expect(runner.machineRunning()).resolves.toBe(false); // no record yet: nothing to ask
    await expect(runner.checkAvailability()).rejects.toThrow(/vendored for smolvm 1\.9\.3/);
    expect(d.fake.calls).toEqual([]);
    expect(d.dials).toEqual([]);
  });

  test('one relay per machine per process, however many runners', async () => {
    const f = await fixtures();
    const d = deps(f);
    const a = await createSmolvmRunner(f.project, config(f), d);
    const b = await createSmolvmRunner(f.project, config(f), d);
    expect(containerCliOf(a)).toBe(containerCliOf(b));
  });
});

describe('liveness when the machine is down or does not answer', () => {
  test('a stopped machine: docker commands say why, nothing is started, and no container is running', async () => {
    const f = await fixtures();
    const d = deps(f, {}, { [soloMachineName(join(root, 'proj'))]: 'stopped' });
    const runner = await createSmolvmRunner(f.project, config(f), d);
    const { out } = await runCli(containerCliOf(runner), 'containers/json');
    expect(out).toContain('503');
    expect(out).toContain('is stopped, so none of its containers is running');
    expect(await runner.isRunning('lazy-abc')).toBe(false);
    expect(await runner.probeRunInfo('lazy-abc')).toEqual({ kind: 'answered', info: null });
    expect(d.fake.calls.map((c) => c[1]).filter((v) => v !== 'ls')).toEqual([]);
    expect(d.dials).toEqual([]);
  });

  // INVARIANT: a machine smolvm lists as running whose engine does not answer
  // is "cannot tell", never "not running" — false would interrupt a turn whose
  // container may still be working.
  test('a running machine whose engine does not answer: liveness is unknown, not false', async () => {
    const f = await fixtures();
    const runner = await createSmolvmRunner(f.project, config(f), deps(f, { dial: deadDial }));
    await expect(runner.isRunning('lazy-abc')).rejects.toBeInstanceOf(SmolvmLivenessUnknownError);
  });

  test('a smolvm that cannot list its machines: liveness is unknown, not false', async () => {
    const f = await fixtures();
    const d = deps(f, { dial: deadDial });
    d.fake.state.lsFails = true;
    const runner = await createSmolvmRunner(f.project, config(f), d);
    await expect(runner.isRunning('lazy-abc')).rejects.toBeInstanceOf(SmolvmLivenessUnknownError);
  });
});

describe('the smolvm runner fails loudly, never falling back to another engine', () => {
  test('no docker client on the host', async () => {
    const f = await fixtures();
    const runner = await createSmolvmRunner(f.project, config(f), deps(f, { dockerCli: null }));
    const err = await runner.checkAvailability().catch((e) => e);
    expect(err.message).toContain('The smolvm runner cannot run tasks');
    expect(err.message).toContain('brew install docker');
    expect(err.message).toContain('Run `lazy doctor`');
    // The script itself refuses too, rather than reaching for any docker.
    const { code, err: stderr } = await runCli(containerCliOf(runner), 'ps');
    expect(code).toBe(127);
    expect(stderr).toContain('no `docker` on PATH');
  });

  test('no smolvm configured', async () => {
    const f = await fixtures();
    const prev = process.env.LAZY_SMOLVM_BINARY;
    delete process.env.LAZY_SMOLVM_BINARY;
    try {
      const runner = await createSmolvmRunner(f.project, config(f, { binary: '' }), deps(f));
      await expect(runner.checkAvailability()).rejects.toThrow(/no smolvm binary is configured\. Set \[smolvm\] binary/);
    } finally {
      if (prev !== undefined) process.env.LAZY_SMOLVM_BINARY = prev;
    }
  });

  test('the wrong smolvm', async () => {
    const f = await fixtures();
    const runner = await createSmolvmRunner(f.project, config(f), deps(f, { verifyBinary: async () => { throw new Error('vendored for smolvm 1.9.3'); } }));
    await expect(runner.checkAvailability()).rejects.toThrow(/The smolvm runner cannot run tasks: vendored for smolvm 1\.9\.3\nRun `lazy doctor`/);
  });

  // INVARIANT: LAZY_FOREIGN_DOCKER_HOST refuses the ambient engine only; the
  // smolvm runner's own machine gets past it (and on to its own checks).
  test('the foreign-Docker-host declaration does not refuse the smolvm runner', async () => {
    const f = await fixtures();
    const prev = process.env[FOREIGN_DOCKER_HOST_ENV];
    process.env[FOREIGN_DOCKER_HOST_ENV] = '1';
    try {
      const runner = await createSmolvmRunner(f.project, config(f), deps(f, { dockerCli: null }));
      const err = await runner.checkAvailability().catch((e) => e);
      expect(err.message).not.toContain('cannot launch agent containers');
      expect(err.message).toContain('The smolvm runner cannot run tasks');
    } finally {
      if (prev === undefined) delete process.env[FOREIGN_DOCKER_HOST_ENV];
      else process.env[FOREIGN_DOCKER_HOST_ENV] = prev;
    }
  });

  test('the builder is refused rather than mounting an empty ~/.claude in the guest', async () => {
    const f = await fixtures();
    const runner = await createSmolvmRunner(f.project, config(f), deps(f));
    await expect(runner.launchBuilderHeadless({} as never)).rejects.toThrow(/does not run on the smolvm runner yet/);
  });
});

describe('the relay', () => {
  // INVARIANT: a client half-close must both deliver stdin EOF and preserve
  // output the guest produces afterwards. Suppressing EOF hangs stdin readers.
  test('delivers guest output produced after the client closes stdin', async () => {
    const socketPath = join(root, 'eof.sock');
    const relay = await startDockerRelay({
      socketPath,
      ensureServing: async () => {},
      dial: () => Bun.spawn([process.execPath, '-e',
        "const input = await Bun.stdin.text(); await Bun.sleep(25); process.stdout.write(input + ':after-eof');"],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as DialedProcess,
    });
    try {
      const got = await new Promise<string>((resolve, reject) => {
        let output = '';
        const sock = connect(socketPath, () => sock.end('input'));
        sock.on('data', (chunk) => { output += chunk.toString(); });
        sock.on('end', () => resolve(output));
        sock.on('error', reject);
      });
      expect(got).toBe('input:after-eof');
    } finally {
      await relay.close();
    }
  });

  test('pipes both directions and passes the client\'s half-close through', async () => {
    const socketPath = join(root, 'r.sock');
    const relay = await startDockerRelay({
      socketPath,
      ensureServing: async () => {},
      dial: () => Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as DialedProcess,
    });
    try {
      const got = await new Promise<string>((resolve, reject) => {
        let text = '';
        const sock = connect(socketPath, () => { sock.write('hello '); sock.end('guest'); });
        sock.on('data', (c) => { text += c.toString(); });
        sock.on('end', () => resolve(text));
        sock.on('error', reject);
      });
      expect(got).toBe('hello guest');
    } finally {
      await relay.close();
    }
  });

  test('a refusal is an Engine-API error the docker client prints', () => {
    const response = engineErrorResponse('no image tar');
    expect(response.startsWith('HTTP/1.1 503 ')).toBe(true);
    expect(response.endsWith('{"message":"no image tar"}')).toBe(true);
  });

  test('sweeps relay files of dead processes only', async () => {
    const dir = join(root, 'state');
    await mkdir(join(dir, 'r-111-abc123'), { recursive: true });
    await mkdir(join(dir, 'r-222-def456'), { recursive: true });
    for (const n of ['docker-111', 'docker-222', 'machine.json']) await writeFile(join(dir, n), '');
    await sweepDeadRelayFiles(dir, (pid) => pid === 222);
    expect((await readdir(dir)).sort()).toEqual(['docker-222', 'machine.json', 'r-222-def456']);
  });
});

describe('the relay socket is private and short', () => {
  // INVARIANT: the relay socket is root in the guest for whoever can connect.
  // It lives in a fresh mkdtemp directory (0700) inside a per-user 0700 base,
  // so it is never reachable by another user, not even for the instant before
  // its own chmod.
  test('lives in a fresh 0700 directory inside a per-user 0700 base', async () => {
    const f = await fixtures();
    const d = deps(f);
    const runner = await createSmolvmRunner(f.project, config(f), d);
    const socket = /DOCKER_HOST='unix:\/\/([^']+)'/.exec(await readFile(containerCliOf(runner), 'utf8'))![1]!;
    const base = join(d.socketRoot, `lazy-${process.getuid!()}`);
    expect(socket.startsWith(`${base}/r-${process.pid}-`)).toBe(true);
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(join(socket, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
  });

  test('a base directory that is not private is refused, not used', async () => {
    const sockRoot = join(root, 'sock');
    const base = join(sockRoot, `lazy-${process.getuid!()}`);
    await mkdir(base, { recursive: true });
    await chmod(base, 0o755);
    await expect(relaySocketBase(sockRoot)).rejects.toThrow(/is not a private directory of this user/);
    await expect(relaySocketBase(sockRoot, process.getuid!() + 1)).rejects.toThrow();
    await chmod(base, 0o700);
    const { dir } = await makeRelaySocketDir(await relaySocketBase(sockRoot));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test('a state directory left wider than 0700 is tightened', async () => {
    const f = await fixtures();
    const d = deps(f);
    const stateDir = join(d.stateRoot, f.machine);
    await mkdir(stateDir, { recursive: true });
    await chmod(d.stateRoot, 0o755);
    await chmod(stateDir, 0o777);
    await createSmolvmRunner(f.project, config(f), d);
    expect((await stat(d.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  });

  test('a socket path too long for a unix socket is a runner error with the way out', async () => {
    const f = await fixtures();
    const long = join(root, 'x'.repeat(90));
    await mkdir(long, { recursive: true });
    const err = await createSmolvmRunner(f.project, config(f), deps(f, { socketRoot: long })).catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmRunnerError);
    expect(err.message).toContain('longer than a unix socket allows');
    expect(err.message).toContain('Run `lazy doctor`');
  });
});

// INVARIANT: a smolvm task can read its single-file MCP handoff even when the
// host daemon is non-root and the guest container runs under another UID.
test('the smolvm MCP handoff is readable without opening its private host ancestor', async () => {
  const privateDir = join(root, 'mcp');
  await mkdir(privateDir, { mode: 0o755 });
  const file = join(privateDir, 'daemon-mcp-lazy-task.json');
  await writeFile(file, '{"token":"fixture-only"}', { mode: 0o600 });
  await prepareSmolvmMcpConfig(file);
  expect((await stat(file)).mode & 0o777).toBe(0o644);
  expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
  expect(await readFile(file, 'utf8')).toBe('{"token":"fixture-only"}');
  await expect(prepareSmolvmMcpConfig(join(privateDir, 'missing'))).rejects.toThrow();
  await prepareSmolvmMcpConfig(undefined);
});

describe('the per-project protocol subtree', () => {
  // INVARIANT: a smolvm machine shares only its own project's protocol
  // subtree. A task's protocol directory is moved there at launch and the
  // usual path becomes a symlink, so host code keeps working by task id.
  test('moves what the daemon already wrote and leaves a symlink behind', async () => {
    const base = join(root, 'protocol');
    const taskDir = join(base, 'task-1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'command.json'), '{"type":"start"}');
    const projectDir = join(root, 'protocol-smolvm', 'lazy-solo-proj-1');
    const real = await moveProtocolDirInto(taskDir, projectDir);
    expect(real).toBe(join(projectDir, 'task-1'));
    expect((await lstat(taskDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(taskDir)).toBe(real);
    expect(await readFile(join(taskDir, 'command.json'), 'utf8')).toBe('{"type":"start"}');
    // Idempotent on the next launch.
    expect(await moveProtocolDirInto(taskDir, projectDir)).toBe(real);
  });
});

void SmolvmMachineNeedsRecreateError;

describe('the runner rows doctor shows for a smolvm project', () => {
  // INVARIANT: a smolvm project needs no Docker engine on the host, so its
  // runner diagnosis never reports one as missing or tells anyone to start
  // Docker Desktop. A machine that is not running is not a failure here;
  // doctor's own smolvm rows report the machine's state.
  test('a machine that is not running: one passing row naming the machine, nothing about Docker Desktop', async () => {
    const f = await fixtures();
    const d = deps(f, {}, { [f.machine]: 'stopped' });
    const runner = await createSmolvmRunner(f.project, config(f), d);
    const rows = await runner.diagnose();
    expect(rows).toEqual([{ state: 'ok', what: `Docker engine in smolvm machine ${f.machine} (not checked — the machine is not running, or lazy has no record of it)` }]);
    expect(JSON.stringify(rows)).not.toContain('Docker Desktop');
  });

  test('an unusable smolvm binary: still no Docker failure row (the smolvm binary row says why)', async () => {
    const f = await fixtures();
    let pinAsked = false;
    const runner = await createSmolvmRunner(f.project, config(f), deps(f, { verifyBinary: async () => { pinAsked = true; throw new Error('not pinned'); } }));
    await writeRecord(f);
    const rows = await runner.diagnose({ launchProbes: false });
    expect(pinAsked).toBe(true);
    expect(rows[0]!.state).toBe('ok');
    expect(rows[0]!.what).toContain('not checked');
    expect(JSON.stringify(rows)).not.toContain('Docker Desktop');
  });

  test('a running machine whose engine answers: "responds", and no host "Docker installed" row', async () => {
    const f = await fixtures();
    const runner = await createSmolvmRunner(f.project, config(f), deps(f));
    await writeRecord(f);
    const rows = await runner.diagnose({ launchProbes: false });
    expect(rows.find((r) => r.what === `Docker engine in smolvm machine ${f.machine} responds`)?.state).toBe('ok');
    expect(rows.some((r) => r.what.startsWith('Docker installed'))).toBe(false);
  });

  // INVARIANT: the engine-restart advice stops dockerd before the machine — a
  // machine stop under a running dockerd can tear layers on the machine's disk.
  test('a running machine whose engine does not answer: a failing row with the safe stop commands, no Docker Desktop', async () => {
    const f = await fixtures();
    const runner = await createSmolvmRunner(f.project, config(f), deps(f, { dial: deadDial }));
    await writeRecord(f);
    const rows = await runner.diagnose({ launchProbes: false });
    const fail = rows.find((r) => r.state === 'fail');
    expect(fail?.what).toBe(`Docker engine in smolvm machine ${f.machine} responds`);
    const reason = fail?.state === 'fail' ? fail.reason ?? '' : '';
    expect(reason.indexOf('lazy-guest-init --stop-docker')).toBeGreaterThan(-1);
    expect(reason.indexOf('lazy-guest-init --stop-docker')).toBeLessThan(reason.indexOf('machine stop'));
    expect(JSON.stringify(rows)).not.toContain('Docker Desktop');
  });
});

/** A machine record where the runner looks for one, so it asks smolvm about the machine. */
async function writeRecord(f: Awaited<ReturnType<typeof fixtures>>): Promise<void> {
  const dir = join(root, 'state', f.machine);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'machine.json'), '{}');
}
