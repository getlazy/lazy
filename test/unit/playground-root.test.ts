import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join, resolve } from 'path';
import { resolveDemoRoot, findLegacyDemoRoot, MANIFEST_FILE } from '../../src/demo/paths';
import { legacyRootNotice } from '../../src/cli/commands/demo';

const saved = { p: process.env.LAZY_PLAYGROUND_ROOT, d: process.env.LAZY_DEMO_ROOT };
let home: string;

beforeEach(async () => {
  delete process.env.LAZY_PLAYGROUND_ROOT;
  delete process.env.LAZY_DEMO_ROOT;
  home = await mkdtemp(join(tmpdir(), 'playground-root-'));
});
afterEach(async () => {
  if (saved.p === undefined) delete process.env.LAZY_PLAYGROUND_ROOT; else process.env.LAZY_PLAYGROUND_ROOT = saved.p;
  if (saved.d === undefined) delete process.env.LAZY_DEMO_ROOT; else process.env.LAZY_DEMO_ROOT = saved.d;
  await rm(home, { recursive: true, force: true });
});

describe('resolveDemoRoot', () => {
  // INVARIANT: explicit root, then LAZY_PLAYGROUND_ROOT, then the old
  // LAZY_DEMO_ROOT, then ~/.lazy-playground. The old variable is honoured for
  // one release after the rename so a shell profile setting it keeps working.
  test('precedence', () => {
    expect(resolveDemoRoot()).toBe(join(homedir(), '.lazy-playground'));
    process.env.LAZY_DEMO_ROOT = '/tmp/old';
    expect(resolveDemoRoot()).toBe('/tmp/old');
    process.env.LAZY_PLAYGROUND_ROOT = '/tmp/new';
    expect(resolveDemoRoot()).toBe('/tmp/new');
    expect(resolveDemoRoot('/tmp/explicit')).toBe(resolve('/tmp/explicit'));
  });
});

describe('findLegacyDemoRoot', () => {
  // INVARIANT: an environment left at the old default ~/.lazy-demo is reported
  // when the caller relies on the new default — otherwise its daemon keeps
  // running unnoticed after the rename.
  test('finds a manifest at the old default root', async () => {
    await mkdir(join(home, '.lazy-demo'));
    await writeFile(join(home, '.lazy-demo', MANIFEST_FILE), '{}');
    expect(await findLegacyDemoRoot(undefined, home)).toBe(join(home, '.lazy-demo'));
  });

  test('null when nothing is there', async () => {
    expect(await findLegacyDemoRoot(undefined, home)).toBeNull();
  });

  test('null when the caller named a root', async () => {
    await mkdir(join(home, '.lazy-demo'));
    await writeFile(join(home, '.lazy-demo', MANIFEST_FILE), '{}');
    expect(await findLegacyDemoRoot('/tmp/x', home)).toBeNull();
    process.env.LAZY_PLAYGROUND_ROOT = '/tmp/y';
    expect(await findLegacyDemoRoot(undefined, home)).toBeNull();
    delete process.env.LAZY_PLAYGROUND_ROOT;
    process.env.LAZY_DEMO_ROOT = '/tmp/z';
    expect(await findLegacyDemoRoot(undefined, home)).toBeNull();
  });
});

describe('legacyRootNotice', () => {
  // INVARIANT: the old-environment warning names the path twice — where it is,
  // and in the teardown command. A notice with the path missing tells the human
  // something is left running without saying where or how to remove it.
  test('names the old root in both places', () => {
    const line = legacyRootNotice('/home/someone/.lazy-demo');
    expect(line).toContain('is still at /home/someone/.lazy-demo —');
    expect(line).toContain('lazy playground down --root /home/someone/.lazy-demo');
  });
});
