/**
 * Solo lazy's per-project smolvm machine (src/vm/smolvm-project-machine.ts),
 * against a faked smolvm CLI: what it creates, what it keeps, and what it
 * refuses to do behind the user's back.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SoloSmolvmMachine, SmolvmMachineNeedsRecreateError, SmolvmMachineNotRunningError, SmolvmRecordUnreadableError, compareRecord, soloMachineName, soloShares,
  type MachineRecord, type SoloShareInputs,
} from '../../src/vm/smolvm-project-machine';
import { PUBLIC_EGRESS_CIDRS, type SmolvmRunner, type SmolvmResult } from '../../src/vm/smolvm-docker-machine';
import type { ResolvedConfig } from '../../src/config/types';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'smolvm-solo-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

type MachineState = 'running' | 'stopped';
/** A stateful fake of the smolvm CLI: records every argv and keeps a machine table. */
function fakeSmolvm(initial: Record<string, MachineState> = {}, opts: { lsFails?: boolean } = {}) {
  const calls: string[][] = [];
  /** The extra environment each call carried, by index into calls. */
  const envs: Array<Record<string, string> | undefined> = [];
  const machines = new Map<string, MachineState>(Object.entries(initial));
  const ok = (stdout = ''): SmolvmResult => ({ exitCode: 0, stdout, stderr: '' });
  const run: SmolvmRunner = async (argv, runOpts) => {
    calls.push(argv);
    envs.push(runOpts.env);
    const name = argv[argv.indexOf('--name') + 1]!;
    switch (argv[1]) {
      case 'ls':
        if (opts.lsFails) return { exitCode: 1, stdout: '', stderr: 'smolvm: cannot reach its state' };
        return ok(JSON.stringify([...machines].map(([n, state]) => ({ name: n, state }))));
      case 'create': machines.set(name, 'stopped'); return ok();
      case 'start': machines.set(name, 'running'); return ok();
      case 'stop': machines.set(name, 'stopped'); return ok();
      case 'delete': machines.delete(name); return ok();
      case 'exec': return machines.get(name) === 'running' ? ok('27.0.0\n') : { exitCode: 1, stdout: '', stderr: 'not running' };
      default: return ok();
    }
  };
  const verbs = () => calls.map((c) => c[1]);
  const envOf = (verb: string) => envs[calls.findIndex((c) => c[1] === verb)];
  return { run, calls, envs, machines, verbs, envOf };
}

interface Layout { inputs: SoloShareInputs; image: string; stateDir: string }
async function layout(extra: Partial<SoloShareInputs> = {}): Promise<Layout> {
  const home = join(root, 'home');
  const inputs: SoloShareInputs = {
    projectRoot: join(root, 'proj'),
    gitCommonDir: join(root, 'proj', '.git'),
    protocolProjectDir: join(home, '.lazy', 'protocol-smolvm', 'm'),
    agentBinDir: join(home, '.lazy', 'bin'),
    mcpConfigDir: join(home, '.lazy', 'daemon', 'proj-1234', 'mcp'),
    oneshotDir: join(home, '.lazy', 'oneshot', 'proj-1234'),
    mounts: [],
    runArgSources: [],
    ...extra,
  };
  for (const d of [inputs.projectRoot, inputs.gitCommonDir, inputs.protocolProjectDir, inputs.agentBinDir, inputs.mcpConfigDir, inputs.oneshotDir]) {
    await mkdir(d, { recursive: true });
  }
  const image = join(root, 'lazy-daemon.tar');
  await writeFile(image, 'tar');
  await writeFile(`${image}.source-id`, '0123456789abcdef\n');
  return { inputs, image, stateDir: join(home, '.lazy', 'smolvm', 'm') };
}

function smolvmConfig(image: string, over: Partial<ResolvedConfig['smolvm']> = {}): ResolvedConfig['smolvm'] {
  return { binary: '/opt/smolvm/smolvm', image, cpus: 4, memory_mib: 8192, storage_gib: 64, allow_cidrs: [], ...over };
}

function machineFor(l: Layout, fake: ReturnType<typeof fakeSmolvm>, over: Partial<ResolvedConfig['smolvm']> = {}, inputs?: () => SoloShareInputs) {
  return new SoloSmolvmMachine({
    projectRoot: l.inputs.projectRoot,
    smolvm: '/opt/smolvm/smolvm',
    run: fake.run,
    config: smolvmConfig(l.image, over),
    shareInputs: async () => (inputs ? inputs() : l.inputs),
    stateDir: l.stateDir,
    say: () => {},
    freshForMs: 0,
  });
}

describe('the machine name', () => {
  // INVARIANT: every lazy process for a project finds the same machine, and two
  // projects never share one — the name is derived from the project root alone.
  test('is stable per project root and distinct across roots', () => {
    expect(soloMachineName('/work/My App')).toBe(soloMachineName('/work/My App'));
    expect(soloMachineName('/work/My App')).not.toBe(soloMachineName('/other/My App'));
    expect(soloMachineName('/work/My App')).toMatch(/^lazy-solo-my-app-[0-9a-f]{8}$/);
  });
});

describe('the share set', () => {
  test('shares every mount source directory once, at its own path, and only the MCP part of the daemon dir', () => {
    const inputs: SoloShareInputs = {
      projectRoot: '/p', gitCommonDir: '/p/.git', protocolProjectDir: '/h/.lazy/protocol-smolvm/m', agentBinDir: '/h/.lazy/bin',
      mcpConfigDir: '/h/.lazy/daemon/p-1/mcp', oneshotDir: '/h/.lazy/oneshot/p-1',
      mounts: [
        { source: '/data/cache', target: '/cache' },
        { source: 'vendor', target: '/vendor' }, // project-relative: inside /p already
        { source: '{worktree}/node_modules', target: '/nm' }, // inside a worktree: inside /p
        { type: 'volume', name: 'gems', target: '/gems' }, // not a host path
        { source: '/data/cache/sub', target: '/sub' }, // inside another share
      ],
      runArgSources: ['/opt/tools'],
    };
    const shares = soloShares(inputs).map((s) => s.path);
    expect(shares).toEqual(['/p', '/h/.lazy/protocol-smolvm/m', '/h/.lazy/bin', '/h/.lazy/daemon/p-1/mcp', '/h/.lazy/oneshot/p-1', '/data/cache', '/opt/tools']);
    // INVARIANT: only THIS project's protocol subtree crosses into its machine —
    // never the shared protocol base, which holds every project's task mailboxes.
    expect(shares).not.toContain('/h/.lazy/protocol');
    // INVARIANT: the agent binaries (every project's) and the MCP configs are
    // shared read-only; the guest only reads them.
    const ro = soloShares(inputs).filter((x) => x.readOnly).map((x) => x.path);
    expect(ro).toEqual(['/h/.lazy/bin', '/h/.lazy/daemon/p-1/mcp']);
    // INVARIANT: the daemon state dir holds the shared daemon token and every
    // task's MCP token registry; only its mcp/ subdirectory crosses into the guest.
    expect(shares).not.toContain('/h/.lazy/daemon/p-1');
    expect(shares.some((s) => s === '/h/.lazy' || s === '/h')).toBe(false);
  });

  test('a git directory outside the project root is shared too', () => {
    const shares = soloShares({
      projectRoot: '/work/wt', gitCommonDir: '/work/main/.git', protocolProjectDir: '/h/p', agentBinDir: '/h/b',
      mcpConfigDir: '/h/m', oneshotDir: '/h/o', mounts: [], runArgSources: [],
    }).map((s) => s.path);
    expect(shares).toContain('/work/main/.git');
  });

  test('a share that contains an earlier one replaces it', () => {
    const shares = soloShares({
      projectRoot: '/p', gitCommonDir: '/p/.git', protocolProjectDir: '/h/.lazy/protocol-smolvm/m', agentBinDir: '/h/.lazy/bin',
      mcpConfigDir: '/h/m', oneshotDir: '/h/o', mounts: [{ source: '/h/.lazy', target: '/x' }], runArgSources: [],
    }).map((s) => s.path);
    expect(shares).toEqual(['/p', '/h/m', '/h/o', '/h/.lazy']);
  });

  test('a writable share inside a read-only one is kept as its own share', () => {
    const shares = soloShares({
      projectRoot: '/p', gitCommonDir: '/p/.git', protocolProjectDir: '/h/pr', agentBinDir: '/h/bin',
      mcpConfigDir: '/h/m', oneshotDir: '/h/o', mounts: [{ source: '/h/bin/cache', target: '/c' }], runArgSources: [],
    });
    expect(shares.map((x) => [x.path, !!x.readOnly])).toContainEqual(['/h/bin/cache', false]);
    expect(shares.map((x) => [x.path, !!x.readOnly])).toContainEqual(['/h/bin', true]);
  });
});

describe('bringing the machine up', () => {
  test('creates it on first need with the shares, egress and size, records it, starts it and its dockerd', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    const machine = machineFor(l, fake);
    await machine.ensureUp();

    expect(fake.verbs()).toEqual(['ls', 'create', 'update', 'start', 'exec', 'exec', 'exec', 'exec']);
    const create = fake.calls.find((c) => c[1] === 'create')!;
    expect(create.slice(0, 6)).toEqual(['machine', 'create', '--name', machine.name, '-I', l.image]);
    expect(create.join(' ')).toContain('--cpus 4 --mem 8192 --storage 64');
    const volumes = create.flatMap((a, i) => (a === '-v' ? [create[i + 1]] : []));
    for (const p of [l.inputs.projectRoot, l.inputs.protocolProjectDir, l.inputs.oneshotDir]) {
      expect(volumes).toContain(`${p}:${p}`);
    }
    for (const p of [l.inputs.agentBinDir, l.inputs.mcpConfigDir]) expect(volumes).toContain(`${p}:${p}:ro`);
    const cidrs = create.flatMap((a, i) => (a === '--allow-cidr' ? [create[i + 1]] : []));
    // INVARIANT: a machine is never created without an egress policy; the
    // default is the fleet's — all of public IP space and nothing else.
    expect(cidrs).toEqual([...PUBLIC_EGRESS_CIDRS]);
    expect(fake.calls.some((c) => c.includes('lazy-guest-init') && c.includes('--ensure'))).toBe(true);

    const record = JSON.parse(await readFile(machine.recordPath, 'utf8')) as MachineRecord;
    expect(record.name).toBe(machine.name);
    expect(record.shares).toEqual(volumes.map((v) => v!.split(':')[0]));
    expect(record.imageSourceId).toBe('0123456789abcdef');
  });

  // INVARIANT: a machine that exists is KEPT. Its disk holds the images, build
  // cache and volumes turns made; a stopped one is started, never recreated.
  test('starts a stopped machine and waits for it, without creating or deleting anything', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await machineFor(l, fake).ensureUp();
    const name = soloMachineName(l.inputs.projectRoot);
    fake.machines.set(name, 'stopped');
    fake.calls.length = 0;

    await machineFor(l, fake).ensureUp();
    expect(fake.verbs()).toEqual(['ls', 'start', 'exec', 'exec', 'exec', 'exec']);
    expect(fake.verbs()).not.toContain('create');
    expect(fake.verbs()).not.toContain('delete');
    expect(fake.verbs()).not.toContain('stop');
  });

  test('a running machine is only checked', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await machineFor(l, fake).ensureUp();
    fake.calls.length = 0;
    await machineFor(l, fake).ensureUp();
    expect(fake.verbs()).toEqual(['ls', 'exec', 'exec', 'exec', 'exec']);
    // --ensure, never --force: a kept machine's running containers are not disturbed.
    expect(fake.calls.some((c) => c.includes('--force'))).toBe(false);
  });

  test('trusts a recent success instead of asking smolvm on every docker command', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    const machine = new SoloSmolvmMachine({
      projectRoot: l.inputs.projectRoot, smolvm: '/opt/smolvm/smolvm', run: fake.run, config: smolvmConfig(l.image),
      shareInputs: async () => l.inputs, stateDir: l.stateDir, say: () => {}, freshForMs: 60_000,
    });
    await machine.ensureUp();
    const n = fake.calls.length;
    await Promise.all([machine.ensureUp(), machine.ensureUp()]);
    expect(fake.calls.length).toBe(n);
    machine.invalidate();
    await machine.ensureUp();
    expect(fake.calls.length).toBeGreaterThan(n);
  });

  // INVARIANT: a launch confirms a recent success with `machine ls` and starts a
  // machine stopped by hand inside the trust window. Trusting it outright failed
  // that launch's first docker call and parked the task interrupted.
  test('a launch re-asks smolvm and starts a machine stopped by hand inside the trust window', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    const machine = new SoloSmolvmMachine({
      projectRoot: l.inputs.projectRoot, smolvm: '/opt/smolvm/smolvm', run: fake.run, config: smolvmConfig(l.image),
      shareInputs: async () => l.inputs, stateDir: l.stateDir, say: () => {}, freshForMs: 60_000,
    });
    await machine.ensureUpForLaunch();
    const n = fake.calls.length;
    await machine.ensureUpForLaunch();
    expect(fake.verbs().slice(n)).toEqual(['ls']);
    fake.machines.set(machine.name, 'stopped');
    const m = fake.calls.length;
    await machine.ensureUpForLaunch();
    expect(fake.verbs().slice(m)).toContain('start');
    expect(fake.machines.get(machine.name)).toBe('running');
  });

  // INVARIANT: a [[mounts]] change the machine cannot serve is REPORTED with the
  // command to recreate, and nothing is deleted or created. Serving it anyway
  // would mount an empty directory the guest's dockerd made up.
  test('a new [[mounts]] directory refuses with the recreate commands and changes nothing', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await machineFor(l, fake).ensureUp();
    const cache = join(root, 'cache');
    await mkdir(cache);
    fake.calls.length = 0;

    const machine = machineFor(l, fake, {}, () => ({ ...l.inputs, mounts: [{ source: cache, target: '/cache' }] }));
    const err = await machine.ensureUp().catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmMachineNeedsRecreateError);
    expect(err.message).toContain(`does not share ${cache}`);
    expect(err.message).toContain(`"/opt/smolvm/smolvm" machine delete --name ${machine.name} --force`);
    expect(err.message).toContain('lazy-guest-init --stop-docker');
    expect(fake.verbs()).toEqual(['ls']);
  });

  test('an egress change refuses too', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await machineFor(l, fake).ensureUp();
    fake.calls.length = 0;
    const err = await machineFor(l, fake, { allow_cidrs: ['1.0.0.0/8'] }).ensureUp().catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmMachineNeedsRecreateError);
    expect(err.message).toContain('egress policy');
    expect(fake.verbs()).toEqual(['ls']);
  });

  test('a new size is reported and the machine is kept as it is', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await machineFor(l, fake).ensureUp();
    fake.calls.length = 0;
    await machineFor(l, fake, { cpus: 8 }).ensureUp();
    expect(fake.verbs()).toEqual(['ls', 'exec', 'exec', 'exec', 'exec']);
  });

  test('a machine lazy has no record of is refused, not adopted or replaced', async () => {
    const l = await layout();
    const fake = fakeSmolvm({ [soloMachineName(join(root, 'proj'))]: 'running' });
    const err = await machineFor(l, fake).ensureUp().catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmMachineNeedsRecreateError);
    expect(err.message).toContain('no record of how it was created');
    expect(fake.verbs()).toEqual(['ls']);
  });

  // INVARIANT: a listing that fails is not "absent" — answering absent would
  // create a machine that may already exist.
  test('a failing machine listing throws instead of creating', async () => {
    const l = await layout();
    const fake = fakeSmolvm({}, { lsFails: true });
    await expect(machineFor(l, fake).ensureUp()).rejects.toThrow(/machine ls --json exited 1/);
    expect(fake.verbs()).toEqual(['ls']);
  });

  test('no configured image is a clear error before smolvm is asked anything', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await expect(machineFor(l, fake, { image: '' }).ensureUp()).rejects.toThrow(/\[smolvm\] image is not set/);
    expect(fake.calls).toEqual([]);
  });

  test('a file mount source is refused: smolvm shares directories', async () => {
    const l = await layout();
    const file = join(root, 'npmrc');
    await writeFile(file, 'x');
    const fake = fakeSmolvm();
    const machine = machineFor(l, fake, {}, () => ({ ...l.inputs, mounts: [{ source: file, target: '/home/user/.npmrc' }] }));
    await expect(machine.ensureUp()).rejects.toThrow(/is a file; smolvm shares directories/);
    expect(fake.calls).toEqual([]);
  });

  test('a missing mount source is refused before create', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    const machine = machineFor(l, fake, {}, () => ({ ...l.inputs, mounts: [{ source: join(root, 'nope'), target: '/n' }] }));
    await expect(machine.ensureUp()).rejects.toThrow(/does not exist, so it cannot be shared/);
    expect(fake.calls).toEqual([]);
  });

  test('a stale lifecycle lock from a dead process is replaced', async () => {
    const l = await layout();
    await mkdir(l.stateDir, { recursive: true });
    await writeFile(join(l.stateDir, 'lifecycle.lock'), `999999999 ${Date.now()}\n`);
    const fake = fakeSmolvm();
    await machineFor(l, fake).ensureUp();
    expect(fake.verbs()).toContain('create');
  });
});

describe('the lifecycle lock', () => {
  /** A fake whose calls are slow, counting how many lifecycles overlap. */
  function overlapCounting(fake: ReturnType<typeof fakeSmolvm>) {
    let inside = 0; let most = 0;
    const run: SmolvmRunner = async (argv, opts) => {
      inside++; most = Math.max(most, inside);
      try { await new Promise((r) => setTimeout(r, 20)); return await fake.run(argv, opts); } finally { inside--; }
    };
    return { run, most: () => most };
  }

  test('contenders over one stale lock never both take it over', async () => {
    // INVARIANT: a stale lock is taken over by exactly one contender. Two
    // callers that both judged it stale used to both delete it and both
    // create one, running two lifecycles (create/start) at once.
    const l = await layout();
    await mkdir(l.stateDir, { recursive: true });
    await writeFile(join(l.stateDir, 'lifecycle.lock'), `999999999 ${Date.now()}\n`);
    const fake = fakeSmolvm();
    const counted = overlapCounting(fake);
    const contenders = Array.from({ length: 8 }, () => machineFor(l, { ...fake, run: counted.run }));
    await Promise.all(contenders.map((m) => m.ensureUp()));
    expect(counted.most()).toBe(1);
    expect(fake.verbs().filter((v) => v === 'create')).toEqual(['create']);
    await expect(readFile(join(l.stateDir, 'lifecycle.lock'), 'utf8')).rejects.toThrow();
  });

  test('a lock that is no longer this process\'s is left alone on release', async () => {
    // INVARIANT: release removes only its own lock, never a holder that replaced it.
    const l = await layout();
    const lock = join(l.stateDir, 'lifecycle.lock');
    const fake = fakeSmolvm();
    const other = `${process.pid} ${Date.now()} someone-else\n`;
    const run: SmolvmRunner = async (argv, opts) => {
      if (argv[1] === 'create') await writeFile(lock, other);
      return fake.run(argv, opts);
    };
    await machineFor(l, { ...fake, run }).ensureUp();
    expect(await readFile(lock, 'utf8')).toBe(other);
  });
});

describe('serving docker commands (the relay\'s precondition)', () => {
  // INVARIANT: the relay needs only a RUNNING machine. A machine a launch would
  // refuse (needs recreate) still serves ps/inspect/stop/rm for what runs in it,
  // and nothing here creates or starts a machine.
  test('a machine that needs recreating still serves, with nothing but a listing', async () => {
    const l = await layout();
    const fake = fakeSmolvm({ [soloMachineName(join(root, 'proj'))]: 'running' }); // no record: a launch refuses
    const machine = machineFor(l, fake);
    await expect(machine.ensureUp()).rejects.toBeInstanceOf(SmolvmMachineNeedsRecreateError);
    fake.calls.length = 0;
    await machine.ensureServing();
    expect(fake.verbs()).toEqual(['ls']);
  });

  test('a stopped or absent machine is refused by name and left as it is', async () => {
    const l = await layout();
    const name = soloMachineName(join(root, 'proj'));
    const stopped = fakeSmolvm({ [name]: 'stopped' });
    const err = await machineFor(l, stopped).ensureServing().catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmMachineNotRunningError);
    expect(err.message).toContain('is stopped, so none of its containers is running');
    expect(stopped.verbs()).toEqual(['ls']);
    const absent = fakeSmolvm();
    await expect(machineFor(l, absent).ensureServing()).rejects.toThrow(/does not exist yet/);
    expect(absent.verbs()).toEqual(['ls']);
  });

  test('a listing that fails is unknown, never "not running"', async () => {
    const l = await layout();
    const err = await machineFor(l, fakeSmolvm({}, { lsFails: true })).ensureServing().catch((e) => e);
    expect(err).not.toBeInstanceOf(SmolvmMachineNotRunningError);
    expect(err.message).toContain('machine ls --json exited 1');
  });
});

describe('compareRecord', () => {
  const base: MachineRecord = {
    version: 1, name: 'm', createdAt: 'now', smolvmVersion: '1.29.0', image: '/i.tar', imageSourceId: null,
    cpus: 4, memoryMib: 8192, storageGib: 64, shares: ['/p', '/h/b'], allowCidrs: ['1.0.0.0/8'],
  };
  test('a share covered by a broader recorded share needs nothing', () => {
    expect(compareRecord({ ...base, shares: ['/p', '/h'] }, { ...base, shares: ['/p', '/h/b'] })).toEqual({ recreate: [], advisory: [] });
  });
  test('a share nothing needs any more is reported, not a reason to recreate', () => {
    expect(compareRecord({ ...base, shares: ['/p', '/h/b', '/old'] }, base)).toEqual({ recreate: [], advisory: ['it still shares /old, which nothing needs any more'] });
  });
  test('a share recorded writable that lazy now shares read-only requires a recreate', () => {
    const { recreate } = compareRecord({ ...base, readOnlyShares: [] }, { ...base, readOnlyShares: ['/h/b'] });
    expect(recreate).toEqual(['it shares /h/b writable; lazy now shares it read-only']);
  });

  test('identical asks for nothing', () => {
    expect(compareRecord(base, base)).toEqual({ recreate: [], advisory: [] });
  });

  // INVARIANT: with [smolvm] allow_cidrs empty the egress policy is lazy's own
  // built-in list. When an upgrade changes that list, the refusal stays (the
  // machine's boundary must be what lazy now says) but it names lazy's upgrade,
  // never a config change the user did not make.
  test('lazy\'s built-in egress list changing is blamed on lazy, and still requires a recreate', () => {
    const recorded = { ...base, allowCidrs: ['1.0.0.0/8'], allowCidrsSource: 'default' as const };
    const desired = { ...base, allowCidrs: ['1.0.0.0/8', '2.0.0.0/7'], allowCidrsSource: 'default' as const };
    const { recreate } = compareRecord(recorded, desired);
    expect(recreate).toHaveLength(1);
    expect(recreate[0]).toContain('built-in public egress list');
    expect(recreate[0]).toContain('changed in this version of lazy');
    expect(recreate[0]).not.toContain('allow_cidrs is not what');
    // A record written before the source was recorded reads the same way.
    expect(compareRecord({ ...recorded, allowCidrsSource: undefined }, desired).recreate[0]).toContain('changed in this version of lazy');
  });

  test('a changed or removed [smolvm] allow_cidrs is named as the user\'s', () => {
    const configured = { ...base, allowCidrs: ['3.0.0.0/8'], allowCidrsSource: 'config' as const };
    expect(compareRecord({ ...base, allowCidrsSource: 'default' }, configured).recreate[0]).toContain('[smolvm] allow_cidrs is not what the machine was created with');
    expect(compareRecord(configured, { ...base, allowCidrsSource: 'default' }).recreate[0]).toContain('[smolvm] allow_cidrs was removed');
  });
});

describe('recordDifference: what doctor compares, changing nothing', () => {
  test('no record → none; a matching record → no difference; a newly needed share → recreate', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    expect(await machineFor(l, fake).recordDifference()).toEqual({ kind: 'none' });
    await machineFor(l, fake).ensureUp();
    const created = fake.calls.length;
    expect(await machineFor(l, fake).recordDifference()).toEqual({ kind: 'present', diff: { recreate: [], advisory: [] } });
    const extra = join(root, 'data');
    await mkdir(extra, { recursive: true });
    const rec = await machineFor(l, fake, {}, () => ({ ...l.inputs, mounts: [{ source: extra, target: '/data' }] })).recordDifference();
    expect(rec.kind === 'present' && rec.diff.recreate.join(' ')).toContain(extra);
    // INVARIANT: comparing never runs smolvm.
    expect(fake.calls.length).toBe(created);
  });

  test('an unreadable record is its own error (the machine can only be recreated)', async () => {
    const l = await layout();
    await mkdir(l.stateDir, { recursive: true });
    await writeFile(join(l.stateDir, 'machine.json'), '{not json');
    await expect(machineFor(l, fakeSmolvm()).recordDifference()).rejects.toBeInstanceOf(SmolvmRecordUnreadableError);
  });
});

describe('the machine\'s routes (task containers reach lazy; lazy reaches task services)', () => {
  function routedMachine(l: Layout, fake: ReturnType<typeof fakeSmolvm>, callbackPorts: (() => { daemon?: number; proxy?: number } | null) | undefined, ports = [41001, 41002]) {
    const queue = [...ports];
    return new SoloSmolvmMachine({
      projectRoot: l.inputs.projectRoot, smolvm: '/opt/smolvm/smolvm', run: fake.run, config: smolvmConfig(l.image),
      shareInputs: async () => l.inputs, stateDir: l.stateDir, say: () => {}, freshForMs: 0,
      callbackPorts, pickPort: async () => queue.shift()!,
    });
  }
  const relayCall = (fake: ReturnType<typeof fakeSmolvm>) => fake.calls.find((c) => c.includes('lazy-solo-relays'))!;

  // INVARIANT: smolvm fixes a machine's guest-to-host mapping and its published
  // ports at create, so both are in the create-time spec and in the record —
  // compared like shares, never changed in place.
  test('create carries the one host-service mapping and publishes the one services port, and the record keeps both', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    const machine = routedMachine(l, fake, () => ({ daemon: 26024, proxy: 39999 }));
    await machine.ensureUp();

    expect(fake.envOf('create')).toEqual({ SMOLVM_GUEST_HOST_SERVICE: '26090:41001' });
    expect(fake.envOf('start')).toEqual({ SMOLVM_GUEST_HOST_SERVICE: '26090:41001' });
    const update = fake.calls.find((c) => c[1] === 'update')!;
    expect(update).toEqual(['machine', 'update', '--name', machine.name, '-p', '41002:26091']);
    // Published before the first start: smolvm publishes only on a stopped machine.
    expect(fake.verbs().indexOf('update')).toBeLessThan(fake.verbs().indexOf('start'));

    const record = JSON.parse(await readFile(machine.recordPath, 'utf8')) as MachineRecord;
    expect(record.routes).toEqual({ hostService: { guestPort: 26090, hostPort: 41001 }, services: { guestPort: 26091, hostPort: 41002 } });
    expect(await machine.recordedRoutes()).toEqual(record.routes!);
  });

  // INVARIANT: a machine is recorded the moment it exists — before its port is
  // published — so a publish that fails never leaves a machine lazy cannot
  // account for; the owed publish is finished on the next bring-up.
  test('the record exists before the publish, and a failed publish is finished on the next bring-up', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    let recordAtPublish: MachineRecord | null = null;
    let failPublish = true;
    const run: SmolvmRunner = async (argv, opts) => {
      if (argv[1] === 'update') {
        recordAtPublish = JSON.parse(await readFile(join(l.stateDir, 'machine.json'), 'utf8'));
        if (failPublish) { fake.calls.push(argv); return { exitCode: 1, stdout: '', stderr: 'smolvm: something broke' }; }
      }
      return fake.run(argv, opts);
    };
    const wrapped = { ...fake, run };
    const err = await routedMachine(l, wrapped, undefined).ensureUp().catch((e) => e);
    expect(err.message).toContain('something broke');
    expect(recordAtPublish!.routes!.services.hostPort).toBe(41002);
    expect(recordAtPublish!.publishPending).toBe(true);
    expect(fake.verbs()).not.toContain('start');

    failPublish = false;
    fake.calls.length = 0;
    await routedMachine(l, wrapped, undefined, [50001]).ensureUp();
    expect(fake.verbs()).toEqual(['ls', 'update', 'start', 'exec', 'exec', 'exec', 'exec']);
    const record = JSON.parse(await readFile(join(l.stateDir, 'machine.json'), 'utf8')) as MachineRecord;
    expect(record.publishPending).toBeUndefined();
    expect(record.routes!.services.hostPort).toBe(41002);
  });

  test('a host port taken meanwhile is retried with another free port, and the record keeps the one that stuck', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    let taken = 1;
    const run: SmolvmRunner = async (argv, opts) => {
      if (argv[1] === 'update' && taken-- > 0) { fake.calls.push(argv); return { exitCode: 1, stdout: '', stderr: 'Error: address already in use' }; }
      return fake.run(argv, opts);
    };
    const machine = routedMachine(l, { ...fake, run }, undefined, [41001, 41002, 41003]);
    await machine.ensureUp();
    const updates = fake.calls.filter((c) => c[1] === 'update').map((c) => c[5]);
    expect(updates).toEqual(['41002:26091', '41003:26091']);
    const record = JSON.parse(await readFile(machine.recordPath, 'utf8')) as MachineRecord;
    expect(record.routes!.services.hostPort).toBe(41003);
    expect(record.publishPending).toBeUndefined();
  });

  test('a kept machine is started with the mapping it was created with', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await routedMachine(l, fake, undefined).ensureUp();
    fake.machines.set(soloMachineName(l.inputs.projectRoot), 'stopped');
    fake.calls.length = 0; fake.envs.length = 0;
    // Other free ports now: the recorded ones win, nothing is re-chosen.
    await routedMachine(l, fake, undefined, [50001, 50002]).ensureUp();
    expect(fake.envOf('start')).toEqual({ SMOLVM_GUEST_HOST_SERVICE: '26090:41001' });
    expect(fake.verbs()).not.toContain('update');
  });

  test('the guest relays get the daemon and proxy ports in the daemon, and only the services router elsewhere', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await routedMachine(l, fake, () => ({ daemon: 26024, proxy: 39999 })).ensureUp();
    const inDaemon = relayCall(fake);
    expect(inDaemon.slice(0, 4)).toEqual(['machine', 'exec', '--name', soloMachineName(l.inputs.projectRoot)]);
    const secret = (await readFile(join(l.stateDir, 'services-secret'), 'utf8')).trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(inDaemon.slice(-9)).toEqual(['/run/lazy-solo', '100.96.0.1', '26090', '26091', secret, 'daemon', '26024', 'proxy', '39999']);

    fake.calls.length = 0;
    await routedMachine(l, fake, () => null).ensureUp();
    // The same secret on every bring-up: the guest's copy is on tmpfs and is rewritten each time.
    expect(relayCall(fake).slice(-5)).toEqual(['/run/lazy-solo', '100.96.0.1', '26090', '26091', secret]);
  });

  // INVARIANT: a machine created before routes existed cannot reach the host
  // and cannot gain a route in place; it is reported for recreate with the
  // commands, and nothing is deleted.
  test('a machine recorded without routes is refused with the recreate commands', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    const machine = routedMachine(l, fake, undefined);
    await machine.ensureUp();
    const record = JSON.parse(await readFile(machine.recordPath, 'utf8')) as MachineRecord;
    delete record.routes;
    await writeFile(machine.recordPath, JSON.stringify(record));
    fake.calls.length = 0;

    const err = await routedMachine(l, fake, undefined).ensureUp().catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmMachineNeedsRecreateError);
    expect(err.message).toContain('no route for task containers to reach lazy on this host');
    expect(err.message).toContain(`machine delete --name ${machine.name} --force`);
    expect(fake.verbs()).toEqual(['ls']);
  });

  test('compareRecord: a changed guest port is a recreate; the host ports chosen at create are not compared', () => {
    const recorded: MachineRecord = {
      version: 1, name: 'm', createdAt: 'now', smolvmVersion: '1.29.0', image: '/i.tar', imageSourceId: null,
      cpus: 4, memoryMib: 8192, storageGib: 64, shares: ['/p'], allowCidrs: ['1.0.0.0/8'],
      routes: { hostService: { guestPort: 26090, hostPort: 41001 }, services: { guestPort: 26091, hostPort: 41002 } },
    };
    const { routes: _routes, ...rest } = recorded;
    expect(compareRecord(recorded, { ...rest, routeGuestPorts: { hostService: 26090, services: 26091 } })).toEqual({ recreate: [], advisory: [] });
    const changed = compareRecord(recorded, { ...rest, routeGuestPorts: { hostService: 26190, services: 26091 } });
    expect(changed.recreate).toEqual(['its route to lazy on this host is on guest port 26090; this lazy uses 26190']);
  });

  // INVARIANT: the routes never widen the machine's egress — it is created with
  // the same public-CIDR policy, and the only way to the host is the mapping.
  test('egress is unchanged: the same public CIDRs and no private range', async () => {
    const l = await layout();
    const fake = fakeSmolvm();
    await routedMachine(l, fake, () => ({ daemon: 26024, proxy: 39999 })).ensureUp();
    const create = fake.calls.find((c) => c[1] === 'create')!;
    const cidrs = create.flatMap((a, i) => (a === '--allow-cidr' ? [create[i + 1]] : []));
    expect(cidrs).toEqual([...PUBLIC_EGRESS_CIDRS]);
    for (const priv of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10']) expect(cidrs).not.toContain(priv);
  });
});
