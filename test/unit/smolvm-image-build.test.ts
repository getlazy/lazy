import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { buildImageInSmolvm, builderMachineName } from '../../src/vm/smolvm-image-build';
import { verifyImageTar } from '../../src/vm/image-tar-verify';
import { SmolvmDockerMachine, type SmolvmRunner, type SmolvmResult } from '../../src/vm/smolvm-docker-machine';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'smolvm-build-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A `docker save`-shaped OCI tar at `path`; `corrupt` writes a blob whose bytes do not match its name. */
async function writeImageTar(path: string, corrupt = false, extraLayer?: string): Promise<void> {
  const dir = await mkdtemp(join(root, 'img-'));
  const blob = Buffer.from('layer bytes '.repeat(200));
  const hex = createHash('sha256').update(blob).digest('hex');
  await mkdir(join(dir, 'blobs/sha256'), { recursive: true });
  await writeFile(join(dir, 'blobs/sha256', hex), corrupt ? Buffer.from('other bytes') : blob);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify([{ Config: `blobs/sha256/${hex}`, Layers: [`blobs/sha256/${hex}`, ...(extraLayer ? [extraLayer] : [])] }]));
  const proc = Bun.spawn(['tar', '-cf', path, '-C', dir, 'manifest.json', `blobs/sha256/${hex}`]);
  expect(await proc.exited).toBe(0);
}

interface FakeOpts { failOn?: string; tarCorrupt?: boolean; sourceId?: string; execNotReadyFor?: number }
/** The faked smolvm CLI: records every argv, and `docker save` writes into the shared host directory. */
function fakeSmolvm(work: () => string, opts: FakeOpts = {}): { run: SmolvmRunner; calls: string[][]; machines: Set<string> } {
  const calls: string[][] = [];
  const machines = new Set<string>();
  const ok = (stdout = ''): SmolvmResult => ({ exitCode: 0, stdout, stderr: '' });
  const run: SmolvmRunner = async (argv) => {
    calls.push(argv);
    const joined = argv.join(' ');
    if (opts.failOn && joined.includes(opts.failOn)) return { exitCode: 1, stdout: '', stderr: `boom at ${opts.failOn}` };
    if (argv.at(-1) === 'true' && opts.execNotReadyFor && opts.execNotReadyFor-- > 0) return { exitCode: 1, stdout: '', stderr: 'not ready' };
    if (argv[1] === 'ls') return ok(JSON.stringify([...machines].map((name) => ({ name }))));
    if (argv[1] === 'create') { machines.add(argv[3]!); return ok(); }
    if (argv[1] === 'delete') { machines.delete(argv[3]!); return ok(); }
    if (argv.includes('save')) { await writeImageTar(join(work(), 'out/image.tar'), opts.tarCorrupt); return ok(); }
    if (argv.includes('/opt/lazy/.source-fingerprint')) return ok(`${opts.sourceId ?? '0123456789abcdef'}\n`);
    return ok();
  };
  return { run, calls, machines };
}

async function exporter(_checkout: string, dir: string): Promise<void> {
  await mkdir(join(dir, 'context'), { recursive: true });
  await writeFile(join(dir, 'build-args'), '--platform\nlinux/arm64\n-t\nghcr.io/getlazy/lazy-daemon:sha-x\n');
  await writeFile(join(dir, 'dockerfile'), 'lazy-teams/deploy/daemon-image/Dockerfile\n');
  await writeFile(join(dir, 'image-ref'), 'ghcr.io/getlazy/lazy-daemon:sha-x\n');
}

async function options(output: string, fake: ReturnType<typeof fakeSmolvm>, lines: string[]) {
  const builderImage = join(root, 'builder.tar');
  await writeFile(builderImage, 'x');
  return { checkout: root, output, platform: 'linux/arm64', builderImage, allowCidrs: ['1.0.0.0/8'], run: fake.run, say: (l: string) => lines.push(l), exportContext: exporter };
}

describe('buildImageInSmolvm', () => {
  test('builds inside the machine, exports a verified tar and sidecar, and deletes the machine', async () => {
    const output = join(root, 'fleet/lazy-daemon-x.tar');
    const fake = fakeSmolvm(() => `${output}.build.d`);
    const lines: string[] = [];
    const result = await buildImageInSmolvm(await options(output, fake, lines));

    expect(result.sourceId).toBe('0123456789abcdef');
    expect((await stat(output)).isFile()).toBe(true);
    expect(await readFile(`${output}.source-id`, 'utf8')).toBe('0123456789abcdef\n');
    // INVARIANT: the builder machine is gone once the build is over. A leftover machine holds its disk.
    expect(fake.machines.size).toBe(0);

    const create = fake.calls.find((c) => c[1] === 'create')!;
    expect(create).toContain('-v');
    expect(create[create.indexOf('-v') + 1]).toBe(`${output}.build.d:/lazy-image-build`);
    expect(create).toContain('--allow-cidr');
    const build = fake.calls.find((c) => c.includes('buildx'))!;
    expect(build.slice(build.indexOf('--'))).toEqual(['--', 'docker', 'buildx', 'build', '-f', '/lazy-image-build/context/lazy-teams/deploy/daemon-image/Dockerfile',
      '--platform', 'linux/arm64', '-t', 'ghcr.io/getlazy/lazy-daemon:sha-x', '--load', '/lazy-image-build/context']);
    expect(fake.calls.some((c) => c.includes('lazy-guest-init') && c.includes('--force'))).toBe(true);
    // Narration: every step is announced.
    for (const n of [1, 2, 3, 4, 5, 6]) expect(lines.some((l) => l.startsWith(`step ${n}/6`))).toBe(true);
  });

  test('a failed build names its step, writes no tar and still deletes the machine', async () => {
    const output = join(root, 'out.tar');
    const fake = fakeSmolvm(() => `${output}.build.d`, { failOn: 'buildx' });
    await expect(buildImageInSmolvm(await options(output, fake, []))).rejects.toThrow(/^build the image: /);
    await expect(stat(output)).rejects.toThrow();
    await expect(stat(`${output}.build.d`)).rejects.toThrow();
    expect(fake.machines.size).toBe(0);
  });

  test('a tar whose blob does not match its digest is refused and never moved into place', async () => {
    const output = join(root, 'out.tar');
    const fake = fakeSmolvm(() => `${output}.build.d`, { tarCorrupt: true });
    await expect(buildImageInSmolvm(await options(output, fake, []))).rejects.toThrow(/damaged/);
    await expect(stat(output)).rejects.toThrow();
  });

  test('a malformed source id fails the build', async () => {
    const output = join(root, 'out.tar');
    const fake = fakeSmolvm(() => `${output}.build.d`, { sourceId: 'nope' });
    await expect(buildImageInSmolvm(await options(output, fake, []))).rejects.toThrow(/^read the source id: /);
    expect(fake.machines.size).toBe(0);
  });

  test('a leftover machine from a killed run is removed before the new one is created', async () => {
    const output = join(root, 'out.tar');
    const fake = fakeSmolvm(() => `${output}.build.d`);
    fake.machines.add(builderMachineName(output));
    await buildImageInSmolvm(await options(output, fake, []));
    const firstDelete = fake.calls.findIndex((c) => c[1] === 'delete');
    const create = fake.calls.findIndex((c) => c[1] === 'create');
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeLessThan(create);
  });
});

describe('SmolvmDockerMachine', () => {
  test('waits for the guest to accept an exec before starting dockerd', async () => {
    const fake = fakeSmolvm(() => root, { execNotReadyFor: 2 });
    const m = new SmolvmDockerMachine(fake.run, { name: 'm', image: '/i.tar', cpus: 1, memoryMib: 1, storageGib: 1, allowCidrs: ['1.0.0.0/8'], volumes: [] }, () => {});
    await m.boot();
    expect(fake.calls.filter((c) => c.at(-1) === 'true').length).toBe(3);
  });

  test('a guest that never accepts an exec fails the start, naming it', async () => {
    const fake = fakeSmolvm(() => root, { execNotReadyFor: 1_000 });
    const m = new SmolvmDockerMachine(fake.run, { name: 'm', image: '/i.tar', cpus: 1, memoryMib: 1, storageGib: 1, allowCidrs: ['1.0.0.0/8'], volumes: [] }, () => {});

    await expect(m.awaitExecReady(50, 10)).rejects.toThrow(/^machine start: m did not accept an exec/);
  });

  test('INVARIANT: refuses a machine with no egress policy — smolvm cannot add one after create', async () => {
    const fake = fakeSmolvm(() => root);
    const m = new SmolvmDockerMachine(fake.run, { name: 'm', image: '/i.tar', cpus: 1, memoryMib: 1, storageGib: 1, allowCidrs: [], volumes: [] }, () => {});
    await expect(m.boot()).rejects.toThrow(/no egress policy/);
    expect(fake.calls.some((c) => c[1] === 'create')).toBe(false);
  });

  test('refuses a mount path smolvm would mis-split', async () => {
    const fake = fakeSmolvm(() => root);
    const m = new SmolvmDockerMachine(fake.run, { name: 'm', image: '/i.tar', cpus: 1, memoryMib: 1, storageGib: 1, allowCidrs: ['1.0.0.0/8'], volumes: [{ host: '/a:b', guest: '/g' }] }, () => {});
    await expect(m.boot()).rejects.toThrow(/cannot contain ':'/);
  });
});

describe('verifyImageTar', () => {
  test('refuses a tar missing a layer its manifest names', async () => {
    const p = join(root, 'short.tar');
    await writeImageTar(p, false, `blobs/sha256/${'0'.repeat(64)}`);
    await expect(verifyImageTar(p)).rejects.toThrow(/does not hold/);
  });

  test('counts verified blobs in a well-formed tar', async () => {
    const p = join(root, 'ok.tar');
    await writeImageTar(p);
    expect(await verifyImageTar(p)).toEqual({ verifiedBlobs: 1, hasManifest: true });
  });

  test('refuses a tar that is not an image', async () => {
    const p = join(root, 'plain.tar');
    await writeFile(join(root, 'f'), 'x');
    expect(await Bun.spawn(['tar', '-cf', p, '-C', root, 'f']).exited).toBe(0);
    await expect(verifyImageTar(p)).rejects.toThrow(/no manifest.json/);
  });
});
