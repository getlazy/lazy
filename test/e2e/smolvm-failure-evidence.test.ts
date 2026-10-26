import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { evidenceFiles, finishSmolvmHardwareTest, saveSmolvmFailureEvidence } from '../helpers/smolvm-failure-evidence';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { setupTestLazy } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';

// INVARIANT: inability to save diagnostics must never destroy their originals.
// All independent probes settle and print before the fixture is retained.
test('capture and filesystem write failures preserve originals and print every available probe', async () => {
  const root = await mkdtemp('/tmp/sv-save-error-');
  try {
    for (const fault of ['capture', 'directory', 'probe', 'report']) {
      const original = join(root, `${fault}.json`);
      await writeFile(original, 'original response');
      const destination = fault === 'directory' ? join(original, 'saved') : join(root, `saved-${fault}`);
      const printed: string[] = [];
      let lastProbeFinished = false;
      await finishSmolvmHardwareTest({
        succeeded: false, keepOnFailure: false, report: message => { printed.push(message); },
        capture: async () => {
          if (fault === 'capture') throw new Error('capture unavailable');
          return saveSmolvmFailureEvidence(destination, {
            response: async () => {
              if (fault === 'probe') await mkdir(join(destination, 'response.txt'));
              return readFile(original, 'utf8');
            },
            delayed: async () => {
              await Bun.sleep(20);
              if (fault === 'report') await mkdir(join(destination, 'report.txt'));
              lastProbeFinished = true;
              return 'later probe evidence';
            },
          });
        },
        cleanup: async keep => {
          expect(keep).toBe(true);
          if (fault !== 'capture') expect(lastProbeFinished).toBe(true);
          if (!keep) await rm(original);
        },
      });
      expect(await readFile(original, 'utf8')).toBe('original response');
      expect(printed.join('\n')).toContain('retaining the failed fixture');
      if (fault !== 'capture') {
        expect(printed.join('\n')).toContain('original response');
        expect(printed.join('\n')).toContain('later probe evidence');
      }
      if (fault === 'probe') expect(await readFile(join(destination, 'delayed.txt'), 'utf8')).toBe('later probe evidence');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// INVARIANT: failures in any phase, including Bun's timeout, capture evidence
// before cleanup; KEEP retains only failed fixtures and never suppresses reaping.
test('phase failures and a real Bun timeout save evidence before teardown, with and without KEEP', async () => {
  const root = await mkdtemp('/tmp/sv-evidence-');
  try {
    for (const keep of [false, true]) {
      const fixture = join(root, `failure-${keep}.test.ts`);
      const base = join(root, String(keep));
      await writeFile(fixture, `
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { finishSmolvmHardwareTest, saveSmolvmFailureEvidence } from ${JSON.stringify(resolve(import.meta.dir, '../helpers/smolvm-failure-evidence.ts'))};
let phase = ''; let succeeded = false;
const base = ${JSON.stringify(base)};
afterEach(async () => {
  await finishSmolvmHardwareTest({
    succeeded, keepOnFailure: ${keep},
    capture: () => saveSmolvmFailureEvidence(base + '/saved/' + phase, {
      protocol: () => readFile(base + '/' + phase + '/response.json', 'utf8'),
      brokenRelay: async () => { throw new Error('relay unavailable'); },
      daemon: async () => 'daemon evidence after relay failure',
    }),
    cleanup: async retained => {
      await writeFile(base + '/' + phase + '/reaped', 'yes');
      if (!retained) await rm(base + '/' + phase, { recursive: true });
    },
  });
}, 5000);
for (const name of ['setup', 'start', 'wait', 'service', 'reuse', 'mounts', 'timeout', 'success']) {
  test(name, async () => {
    phase = name; succeeded = false;
    await mkdir(base + '/' + phase, { recursive: true });
    await writeFile(base + '/' + phase + '/response.json', phase + ' evidence');
    if (name === 'timeout') await new Promise(() => {});
    if (name !== 'success') expect('deliberate phase failure').toBe('pass');
    succeeded = true;
  }, name === 'timeout' ? 500 : 5000);
}
`);
      const proc = Bun.spawn([process.execPath, 'test', fixture], {
        cwd: root, env: hardwareTestEnv(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(code).toBe(1);
      expect(stdout + stderr).toContain('timed out after 500ms');
      for (const phase of ['setup', 'start', 'wait', 'service', 'reuse', 'mounts', 'timeout']) {
        const report = await readFile(join(base, 'saved', phase, 'report.txt'), 'utf8');
        expect(report).toContain(`${phase} evidence`);
        expect(report).toContain('relay unavailable');
        expect(report).toContain('daemon evidence after relay failure');
        expect(stdout + stderr).toContain(report);
        expect(await Bun.file(join(base, phase, 'response.json')).exists()).toBe(keep);
        if (keep) expect(await readFile(join(base, phase, 'reaped'), 'utf8')).toBe('yes');
      }
      expect(await Bun.file(join(base, 'success', 'response.json')).exists()).toBe(false);
      expect(await Bun.file(join(base, 'saved', 'success', 'report.txt')).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test('snapshot follows the smolvm protocol symlink and keeps the complete response and supervisor output', async () => {
  const root = await mkdtemp('/tmp/sv-snapshot-');
  try {
    const shared = join(root, 'shared');
    const protocol = join(root, 'protocol');
    await mkdir(shared);
    await mkdir(protocol);
    await writeFile(join(shared, 'response.json'), '{"status":"error","error":"supervisor failed"}');
    await writeFile(join(shared, 'status.json'), '{"phase":"work"}');
    await writeFile(join(shared, 'supervisor.log'), 'supervisor evidence');
    await symlink(shared, join(protocol, 'task-id'));
    const snapshot = await evidenceFiles(protocol, name => /\.(json|log)$/.test(name));
    expect(JSON.stringify(snapshot)).toContain('supervisor failed');
    expect(JSON.stringify(snapshot)).toContain('supervisor evidence');
    await expect(saveSmolvmFailureEvidence(join(root, 'saved'), {
      protocol: async () => snapshot,
      unavailable: async () => { throw new Error('probe unavailable'); },
    })).resolves.toContain('probe unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserving a real test context keeps the project, external store and protocol until explicit cleanup', async () => {
  const ctx = await setupTestLazy();
  const store = storageDirFor(ctx.root);
  try {
    await writeFile(join(ctx.protocolBase, 'response.json'), 'protocol evidence');
    await ctx.cleanup({ preserveFiles: true });
    expect(await Bun.file(join(ctx.root, 'lazy.toml')).exists()).toBe(true);
    expect(await Bun.file(join(store, 'version.json')).exists()).toBe(true);
    expect(await readFile(join(ctx.protocolBase, 'response.json'), 'utf8')).toBe('protocol evidence');
  } finally {
    await ctx.cleanup();
  }
  expect(await Bun.file(join(ctx.root, 'lazy.toml')).exists()).toBe(false);
  expect(await Bun.file(join(store, 'version.json')).exists()).toBe(false);
}, 30_000);
