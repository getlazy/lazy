/**
 * Daemon-wide container queries on a solo smolvm project must ask the
 * project machine's engine, never only the host's: the run-container sweeps
 * at daemon start and shutdown, and agent-binary cleanup.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import { runContainerSweepCli, removeRunContainers, ensureRunContainer, runNetworkFor, RUN_NETWORK_SPEC } from '../../src/daemon/commit-run-container';
import { DockerRunner } from '../../src/runner/docker-runner';
import { agentBinaryMountSources } from '../../src/vm/smolvm-engines';
import { pruneAgentBinaries } from '../../src/agent/binary-install';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'smolvm-sweeps-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function configOf(type: ResolvedConfig['runner']['type']): ResolvedConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runner.type = type;
  return c;
}

/** A fake smolvm runner: a docker runner whose client is the given script. */
function fakeSmolvmRunner(cli: string, created: boolean) {
  const runner = new DockerRunner(cli, 'smolvm', root) as DockerRunner & { machineRunning(): Promise<boolean> };
  runner.machineRunning = async () => created;
  return async () => runner;
}

describe('the run-container sweep', () => {
  // INVARIANT: every container runner's run containers are swept at daemon
  // start and shutdown; on smolvm through the machine's client. A bare
  // `docker` would ask the host's engine and leave the guest's running forever.
  test('on smolvm, sweeps through the runner\'s own client', async () => {
    expect(await runContainerSweepCli(root, configOf('smolvm'), { smolvmRunner: fakeSmolvmRunner('/state/m/docker-1', true) })).toBe('/state/m/docker-1');

    const removed: string[] = [];
    const swept = await removeRunContainers(root, '/state/m/docker-1', {
      list: async () => 'lazyrun-abc\nlazyrun-def\n',
      remove: async (binary, name) => { removed.push(`${binary} ${name}`); },
    });
    expect(swept.removed).toBe(2);
    expect(removed.sort()).toEqual(['/state/m/docker-1 lazyrun-abc', '/state/m/docker-1 lazyrun-def']);
  });

  test('a machine that is not running is not started just to be swept', async () => {
    expect(await runContainerSweepCli(root, configOf('smolvm'), { smolvmRunner: fakeSmolvmRunner('/x', false) })).toBeNull();
  });

  test('docker and podman keep their own client; other runners are not swept', async () => {
    expect(await runContainerSweepCli(root, configOf('docker'))).toBe('docker');
    expect(await runContainerSweepCli(root, configOf('podman'))).toBe('podman');
    expect(await runContainerSweepCli(root, configOf('dangerously-host-process-without-any-isolation'))).toBeNull();
  });
});

/** A fake docker client: `ps` lists one container whose mounts are `mounts`. */
async function fakeClient(name: string, mounts: string[]): Promise<string> {
  const path = join(root, name);
  const lines = mounts.map((m) => `echo '${m}'`).join('\n');
  await writeFile(path, `#!/bin/sh\nif [ "$1" = ps ]; then ${mounts.length ? 'echo c1' : 'true'}; exit 0; fi\n${lines}\n`);
  await chmod(path, 0o755);
  return path;
}

async function oldBinary(binDir: string, name: string): Promise<string> {
  const path = join(binDir, name);
  await writeFile(path, 'agent');
  const old = new Date(Date.now() - 48 * 3600_000);
  await utimes(path, old, old);
  return path;
}

/**
 * A fake smolvm launcher: `machine ls --json` reports the machine's state from
 * <dir>/state (absent when the file says so), and `machine exec -- docker ps` /
 * `inspect` list one container mounting what <dir>/mounts names.
 */
async function fakeSmolvm(machine: string, state: 'running' | 'stopped' | 'absent' | 'ls-fails', mounts: string[]): Promise<string> {
  const dir = join(root, `smolvm-${state}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'smolvm');
  const ls = state === 'ls-fails' ? 'exit 1'
    : state === 'absent' ? "echo '[]'; exit 0"
      : `echo '[{"name":"${machine}","state":"${state}"}]'; exit 0`;
  await writeFile(path, [
    '#!/bin/sh',
    `if [ "$2" = ls ]; then ${ls}; fi`,
    // machine exec --name M -- docker <cmd> ...
    `if [ "$2" = exec ]; then shift 5; if [ "$1" = ps ]; then ${mounts.length ? 'echo c1' : 'true'}; exit 0; fi; ${mounts.map((m) => `echo '${m}'`).join('; ') || 'true'}; exit 0; fi`,
    'echo "unexpected smolvm call: $*" >&2; exit 2',
  ].join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}

/** The pin check, faked as passing: the fake launchers are not a vendored smolvm. */
const pinned = async () => {};

describe('agent-binary cleanup', () => {
  const MACHINE = 'lazy-solo-proj-12345678';
  async function setUp(record: Record<string, unknown> = {}) {
    const binDir = join(root, 'bin');
    const stateRoot = join(root, 'state');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(stateRoot, MACHINE), { recursive: true });
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify(record));
    const current = await oldBinary(binDir, 'lazy-agent-current-id');
    const stale = await oldBinary(binDir, 'lazy-agent-stale-id');
    const hostEmpty = await fakeClient('host-docker', []);
    return { binDir, stateRoot, current, stale, hostEmpty };
  }
  async function prune(binDir: string, current: string, referenced: string[] | null) {
    return pruneAgentBinaries(binDir, { keep: [current], referenced });
  }

  // INVARIANT: on a host with a solo smolvm machine, the host engine answering
  // "nothing in use" is not an answer for the guest: a binary a RUNNING
  // machine's container mounts is kept.
  test('a smolvm project whose host engine answers empty keeps the binary a guest container mounts', async () => {
    const { binDir, stateRoot, current, stale, hostEmpty } = await setUp();
    const smolvm = await fakeSmolvm(MACHINE, 'running', [stale]);
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify({ smolvmBinary: smolvm }));
    const referenced = await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map() });
    expect(referenced).toEqual([stale]);
    expect(await prune(binDir, current, referenced)).toEqual([]);
    expect(await readdir(binDir)).toContain('lazy-agent-stale-id');
  });

  test('with every engine asked and none mounting it, a superseded binary is collected', async () => {
    const { binDir, stateRoot, current, stale, hostEmpty } = await setUp();
    const smolvm = await fakeSmolvm(MACHINE, 'running', []);
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify({ smolvmBinary: smolvm }));
    expect(await prune(binDir, current, await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map() }))).toEqual([stale]);
  });

  // INVARIANT: cleanup never starts a machine, and a stale record does not
  // switch it off forever: a stopped machine runs nothing, and a record of a
  // machine that no longer exists is ignored.
  test('a stopped machine holds no mounts and is not started to be asked', async () => {
    const { binDir, stateRoot, current, stale, hostEmpty } = await setUp();
    const smolvm = await fakeSmolvm(MACHINE, 'stopped', [stale]);
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify({ smolvmBinary: smolvm }));
    expect(await prune(binDir, current, await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map() }))).toEqual([stale]);
  });

  test('the record of a machine that no longer exists is ignored', async () => {
    const { binDir, stateRoot, current, stale, hostEmpty } = await setUp();
    const smolvm = await fakeSmolvm(MACHINE, 'absent', []);
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify({ smolvmBinary: smolvm }));
    expect(await prune(binDir, current, await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map() }))).toEqual([stale]);
  });

  test('a record naming no launcher falls back to the one this process registered', async () => {
    const { stateRoot, stale, hostEmpty } = await setUp({});
    const smolvm = await fakeSmolvm(MACHINE, 'running', [stale]);
    expect(await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map([[MACHINE, smolvm]]) })).toEqual([stale]);
  });

  // INVARIANT: cleanup never executes a smolvm that fails the pin; that machine
  // cannot be asked, so nothing is deleted.
  test('a recorded launcher that fails the pin is never run, and deletes nothing', async () => {
    const { binDir, stateRoot, current } = await setUp();
    const smolvm = await fakeSmolvm(MACHINE, 'running', []);
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify({ smolvmBinary: smolvm }));
    const ran: string[] = [];
    const referenced = await agentBinaryMountSources({
      ambient: (await fakeClient('host-docker', [])), stateRoot, registered: new Map(),
      verify: async () => { throw new Error('not the pinned smolvm'); },
      machineState: async (b) => { ran.push(b); return 'running'; },
    });
    expect(referenced).toBeNull();
    expect(ran).toEqual([]);
    expect(await prune(binDir, current, referenced)).toEqual([]);
  });

  test('anything unknown deletes nothing: no launcher, a failing listing, an unanswering engine', async () => {
    const { binDir, stateRoot, current, hostEmpty } = await setUp({});
    expect(await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map() })).toBeNull();
    const lsFails = await fakeSmolvm(MACHINE, 'ls-fails', []);
    await writeFile(join(stateRoot, MACHINE, 'machine.json'), JSON.stringify({ smolvmBinary: lsFails }));
    const referenced = await agentBinaryMountSources({ ambient: hostEmpty, stateRoot, verify: pinned, registered: new Map() });
    expect(referenced).toBeNull();
    expect(await prune(binDir, current, referenced)).toEqual([]);
    const failing = join(root, 'failing');
    await writeFile(failing, '#!/bin/sh\nexit 1\n');
    await chmod(failing, 0o755);
    expect(await agentBinaryMountSources({ ambient: failing, stateRoot: join(root, 'none') })).toBeNull();
  });
});

describe('commit runs ("Run services" without a task)', () => {
  // INVARIANT: on the smolvm runner a run goes through the launch gate task
  // turns go through (pin, machine record, create/start) BEFORE anything is
  // asked of the machine's engine. Runs were refused there until the machine
  // had routes for their services; a run that skipped the gate would start a
  // container on a machine nobody checked.
  test('on the smolvm runner, pass the launch gate before any container or checkout work', async () => {
    const run = { id: 'run-1', slug: 'main-abc' };
    const storage = { getCommitRun: async () => run, getCommitRunBySlug: async () => run } as never;
    const runner = Object.assign(new DockerRunner('/state/m/docker-1', 'smolvm', root), {
      ensureMachine: async () => { order.push('gate'); throw new Error('The smolvm runner cannot run tasks: the machine needs recreating'); },
    });
    const order: string[] = [];
    runner.isRunning = async () => { order.push('isRunning'); return false; };
    const err = await ensureRunContainer(root, { runId: 'run-1' } as never, {
      getStorage: async () => storage,
      createRunner: (async () => runner) as never,
    }).catch((e) => e);
    expect(err.message).toContain('the machine needs recreating');
    expect(order).toEqual(['gate']);
  });

  // INVARIANT: a run's isolated network is decided by runner TYPE — the smolvm
  // runner's client is a script path, and a name check would silently drop
  // the isolation on the machine's engine.
  test('join the isolated lazy-runs network on smolvm, as on docker', () => {
    expect(runNetworkFor('smolvm')).toBe(RUN_NETWORK_SPEC);
    expect(runNetworkFor('docker')).toBe(RUN_NETWORK_SPEC);
    expect(runNetworkFor('podman')).toBeNull();
  });
});
