import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CANARY_LIMITS, canaryWord, clampCanaryOptions, describeCanaryResult, runMemoryCanary,
} from '../../src/docker/memory-canary';
import { blobsCommittedSince, classifyAudit, contentBlobDir, hashBlobs, type BlobCheck } from '../../src/docker/blob-audit';
import {
  AUDIT_IDLE_MS, CANARY_INTERVAL_MS, INTEGRITY_TITLES, auditAfterBuild, canarySkipReason, fileIntegrityAlert,
  integrityAlert, machineIntegrityDoctorResult, machineIntegrityTick, machineIntegrityView, parseMemAvailable,
  resetMachineIntegrityForTests, runIntegrityCanary, setMachineIntegrityDepsForTests, setMachineIntegrityReporter,
  type PressureSignals,
} from '../../src/daemon/machine-integrity';
import type { SystemMessageInput } from '../../src/types';

const quiet: PressureSignals = { buildRunning: false, launchInFlight: false, memAvailableBytes: 4 * 1024 ** 3 };

afterEach(() => resetMachineIntegrityForTests());

describe('memory canary', () => {
  // INVARIANT: the canary catches a word that does not read back as written.
  // The real race (lost stores under the hypervisor's lazy remap) cannot be
  // produced in CI, so detection is proven by flipping one bit after the fill.
  test('an injected corruption is reported as corrupt, with where it was', async () => {
    const r = await runMemoryCanary({ threads: 2, durationMs: 200, pauseMs: 0, injectCorruption: { thread: 1, round: 1, wordIndex: 77 } });
    expect(r.verdict).toBe('corrupt');
    expect(r.mismatchedWords).toBe(1);
    expect(r.examples).toEqual([{ thread: 1, round: 1, offset: 77 * 4, expected: canaryWord(1, 1, 77), actual: (canaryWord(1, 1, 77) ^ 1) >>> 0 }]);
    expect(describeCanaryResult(r)).toContain('FAILED');
  });

  test('a clean run is clean and verifies every byte it wrote', async () => {
    const r = await runMemoryCanary({ threads: 2, durationMs: 100, pauseMs: 0 });
    expect(r.verdict).toBe('clean');
    expect(r.rounds).toBeGreaterThan(0);
    expect(r.bytesVerified).toBe(r.rounds * r.bufferBytes);
  });

  // INVARIANT: the canary is bounded whatever it is asked for — at most 4
  // threads, 60 s, 16 MiB a buffer — and its buffers stay at least 8 MiB so
  // they are mapped and returned to the kernel, which is what it tests.
  test('requests are clamped to the bounds', () => {
    expect(clampCanaryOptions({ threads: 64, durationMs: 3_600_000, bufferBytes: 1024 ** 3 })).toEqual({
      threads: CANARY_LIMITS.maxThreads, durationMs: CANARY_LIMITS.maxDurationMs, bufferBytes: CANARY_LIMITS.maxBufferBytes,
    });
    expect(clampCanaryOptions({ bufferBytes: 4096 }).bufferBytes).toBe(CANARY_LIMITS.minBufferBytes);
    expect(clampCanaryOptions({}).threads * clampCanaryOptions({}).bufferBytes).toBe(32 * 1024 * 1024);
  });

  test('the pattern differs between rounds and threads, so a stale page is caught too', () => {
    expect(canaryWord(0, 0, 5)).not.toBe(canaryWord(0, 1, 5));
    expect(canaryWord(0, 0, 5)).not.toBe(canaryWord(1, 0, 5));
  });
});

describe('memory canary in a release bundle', () => {
  // INVARIANT: the canary's Worker source is its own function stringified, so
  // the release bundle's transforms (scripts/build.ts: --minify-syntax and the
  // LAZY_RELEASE_BUILD define) must leave it runnable — otherwise every run on
  // a real machine reports "incomplete" and nobody notices. Full minification
  // is checked too, so a later build-flag change cannot break it silently.
  for (const identifiers of [false, true]) {
    test(`a bundled canary still catches an injected corruption (identifiers minified: ${identifiers})`, async () => {
      const outdir = await mkdtemp(join(tmpdir(), 'canary-bundle-'));
      try {
        const result = await Bun.build({
          entrypoints: [join(import.meta.dir, '../../src/docker/memory-canary.ts')],
          outdir, target: 'bun',
          minify: { syntax: true, whitespace: identifiers, identifiers },
          define: { LAZY_RELEASE_BUILD: 'true' },
        });
        expect(result.success).toBe(true);
        const mod = await import(result.outputs[0].path) as typeof import('../../src/docker/memory-canary');
        const r = await mod.runMemoryCanary({ threads: 1, durationMs: 100, pauseMs: 0, injectCorruption: { thread: 0, round: 0, wordIndex: 3 } });
        expect(r.problem).toBeNull();
        expect(r.verdict).toBe('corrupt');
      } finally {
        await rm(outdir, { recursive: true, force: true });
      }
    });
  }
});

describe('memory pressure gate', () => {
  // INVARIANT: no canary runs while a build or a launch is in flight, or with
  // under 512 MiB available — the machine has nothing to spare then, and builds
  // have OOM-killed dockerd before.
  test('builds, launches and low memory each hold the canary off', () => {
    expect(canarySkipReason(quiet)).toBeNull();
    expect(canarySkipReason({ ...quiet, buildRunning: true })).toContain('build');
    expect(canarySkipReason({ ...quiet, launchInFlight: true })).toContain('launch');
    expect(canarySkipReason({ ...quiet, memAvailableBytes: 100 * 1024 * 1024 })).toContain('100 MiB');
    // After an extraction failure the failing launch is the one in flight.
    expect(canarySkipReason({ ...quiet, launchInFlight: true }, { ignoreLaunches: true })).toBeNull();
  });

  test('MemAvailable is read from /proc/meminfo', () => {
    expect(parseMemAvailable('MemTotal:  8000000 kB\nMemAvailable:    2048 kB\n')).toBe(2048 * 1024);
    expect(parseMemAvailable('MemTotal: 1 kB\n')).toBeNull();
  });

  test('a scheduled canary under pressure is skipped and retried on the next tick', async () => {
    let pressure: PressureSignals = { ...quiet, buildRunning: true };
    let runs = 0;
    setMachineIntegrityDepsForTests({
      supervised: () => true, pressure: async () => pressure, now: () => 1_000,
      canary: async () => { runs++; return { verdict: 'clean', threads: 4, durationMs: 1, bufferBytes: 8 << 20, rounds: 1, bytesVerified: 8 << 20, mismatchedWords: 0, examples: [], problem: null }; },
    });
    await machineIntegrityTick();
    expect(runs).toBe(0);
    expect(machineIntegrityView().lastChecked).toContain('an image build is running');
    pressure = quiet;
    await machineIntegrityTick();
    expect(runs).toBe(1);
    expect(machineIntegrityView().canary?.outcome).toBe('clean');
  });
});

describe('blob audit', () => {
  const c = (digest: string, state: 'intact' | 'mismatch' | 'gone'): BlobCheck =>
    state === 'mismatch' ? { digest, size: 1, state, actual: 'f'.repeat(64) } : { digest, size: 1, state };

  // INVARIANT: wrong right after the build = damaged on the way down; right
  // after the build and wrong later = damaged after it was written. Which one
  // decides where the fault is, so the classification must not blur them.
  test('classifies on-write and after-write damage', () => {
    expect(classifyAudit([c('a', 'intact')]).verdict).toBe('intact');
    expect(classifyAudit([c('a', 'mismatch')]).verdict).toBe('damaged-on-write');
    expect(classifyAudit([c('a', 'intact')], [c('a', 'mismatch')]).verdict).toBe('damaged-after-write');
    expect(classifyAudit([c('a', 'mismatch')], [c('a', 'mismatch')]).verdict).toBe('damaged-on-write');
    expect(classifyAudit([c('a', 'mismatch'), c('b', 'intact')], [c('a', 'mismatch'), c('b', 'mismatch')]).verdict).toBe('damaged-after-write');
    // A deleted image is not damage.
    expect(classifyAudit([c('a', 'intact')], [c('a', 'gone')])).toMatchObject({ verdict: 'intact', gone: 1 });
  });

  test('finds the blobs a build committed and re-hashes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blob-audit-'));
    try {
      const dir = contentBlobDir(root);
      await mkdir(dir, { recursive: true });
      const good = Buffer.from('layer one');
      const goodName = createHash('sha256').update(good).digest('hex');
      await writeFile(join(dir, goodName), good);
      const badName = createHash('sha256').update('what was written').digest('hex');
      await writeFile(join(dir, badName), 'what is on disk');
      const oldName = createHash('sha256').update('old').digest('hex');
      await writeFile(join(dir, oldName), 'old');
      const longAgo = new Date(Date.now() - 86_400_000);
      await utimes(join(dir, oldName), longAgo, longAgo);

      const { blobs, leftOut } = await blobsCommittedSince(dir, Date.now() - 60_000);
      expect(blobs.map((b) => b.digest).sort()).toEqual([goodName, badName].sort());
      expect(leftOut).toBe(0);
      const checks = await hashBlobs(blobs);
      expect(classifyAudit(checks)).toMatchObject({ verdict: 'damaged-on-write', checked: 2, damaged: [{ digest: badName }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a blob damaged after the build is caught by the after-idle pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blob-audit-'));
    try {
      const dir = contentBlobDir(root);
      await mkdir(dir, { recursive: true });
      const bytes = Buffer.from('layer');
      const name = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(dir, name), bytes);
      let now = Date.now();
      const filed: SystemMessageInput[] = [];
      setMachineIntegrityReporter((m) => { filed.push(m); });
      setMachineIntegrityDepsForTests({
        supervised: () => true, dataRoot: async () => root, pressure: async () => ({ ...quiet, memAvailableBytes: 0 }), now: () => now,
      });
      expect((await auditAfterBuild('Project image build', now - 1000))?.verdict).toBe('intact');
      expect(filed).toHaveLength(0);
      await writeFile(join(dir, name), 'lAyer');
      now += AUDIT_IDLE_MS - 1;
      await machineIntegrityTick();
      expect(machineIntegrityView().audit?.phase).toBe('after-build');
      now += 2;
      await machineIntegrityTick();
      expect(machineIntegrityView().audit).toMatchObject({ phase: 'after-idle', verdict: 'damaged-after-write' });
      expect(filed.map((m) => m.title)).toEqual([INTEGRITY_TITLES['damaged-after-write']]);
      expect(filed[0].kind).toBe('alert');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('alerts', () => {
  // INVARIANT: a repeating finding is ONE open alert, not one per hour. Titles
  // are fixed per kind of finding (repeats collapse on source+kind+title), and
  // every alert is filed with collapseRepeats — refreshBody keeps the latest
  // evidence on it.
  test('repeated findings of a kind file identical titles and collapse', async () => {
    const a = integrityAlert({ kind: 'canary', text: 'run 1' });
    const b = integrityAlert({ kind: 'canary', text: 'run 2' });
    expect(a.title).toBe(b.title);
    expect(a.kind).toBe('alert');
    expect(a.source).toBe('machine-docker');
    expect(integrityAlert({ kind: 'audit', verdict: 'damaged-on-write', text: '' }).title)
      .not.toBe(integrityAlert({ kind: 'audit', verdict: 'damaged-after-write', text: '' }).title);
    const calls: unknown[] = [];
    await fileIntegrityAlert({ createSystemMessage: async (input, options) => { calls.push(options); return { ...input, id: 'x', created_at: 0 } as never; } }, a);
    expect(calls).toEqual([{ collapseRepeats: true, refreshBody: true }]);
  });

  test('an hourly corrupt canary alerts each run, clean runs file nothing', async () => {
    let now = 0;
    let verdict: 'clean' | 'corrupt' = 'clean';
    const filed: SystemMessageInput[] = [];
    setMachineIntegrityReporter((m) => { filed.push(m); });
    setMachineIntegrityDepsForTests({
      supervised: () => true, pressure: async () => quiet, now: () => now,
      canary: async () => ({ verdict, threads: 4, durationMs: 1, bufferBytes: 8 << 20, rounds: 1, bytesVerified: 8 << 20,
        mismatchedWords: verdict === 'corrupt' ? 1 : 0, examples: [], problem: null }),
    });
    await machineIntegrityTick();
    expect(filed).toHaveLength(0);
    now += CANARY_INTERVAL_MS - 1;
    verdict = 'corrupt';
    await machineIntegrityTick();
    expect(filed).toHaveLength(0); // not due yet
    now += 1;
    await machineIntegrityTick();
    now += CANARY_INTERVAL_MS;
    await machineIntegrityTick();
    expect(filed.map((m) => m.title)).toEqual([INTEGRITY_TITLES.canary, INTEGRITY_TITLES.canary]);
    expect(machineIntegrityView().damaged).toBe(true);
  });

  test('the post-failure canary runs despite the failing launch being in flight', async () => {
    setMachineIntegrityDepsForTests({
      supervised: () => true, pressure: async () => ({ ...quiet, launchInFlight: true }), now: () => 0,
      canary: async () => ({ verdict: 'clean', threads: 4, durationMs: 1, bufferBytes: 8 << 20, rounds: 3, bytesVerified: 3 * (8 << 20), mismatchedWords: 0, examples: [], problem: null }),
    });
    expect((await runIntegrityCanary('extraction-failure')).outcome).toBe('clean');
  });
});

describe('doctor', () => {
  test('an open alert fails the check with its evidence; otherwise the last-checked line', () => {
    const view = machineIntegrityView();
    const ok = machineIntegrityDoctorResult([], view, true);
    expect(ok.ok).toBe(true);
    expect(ok.label).toStartWith('Machine memory and image data checks');
    expect(ok.label).toContain('Memory not checked yet');
    const alert = integrityAlert({ kind: 'canary', text: 'evidence here' });
    const bad = machineIntegrityDoctorResult([{ ...alert, created_at: 5 }], view, true);
    expect(bad.ok).toBe(false);
    expect(bad.problem).toBe(INTEGRITY_TITLES.canary);
    expect(bad.detail).toContain('evidence here');
    // Somebody else's machine-docker message is not ours.
    expect(machineIntegrityDoctorResult([{ source: 'machine-docker', title: 'Docker stopped', body: '', created_at: 1 }], view, true).ok).toBe(true);
  });
});

describe('every container build is seen', () => {
  // INVARIANT: the audit follows EVERY successful container build and the
  // canary's gate counts every running one — not only image build jobs. The
  // image damaged in the field (lazy's default image) is built inline by a
  // launch and by the boot path, outside any job.
  test('the build chokepoint counts a running build and reports a success, not a failure', async () => {
    const { trackContainerBuild, runningContainerBuilds, onContainerBuildSucceeded } = await import('../../src/capture/build-observer');
    const seen: string[] = [];
    const stop = onContainerBuildSucceeded((image) => { seen.push(image); });
    try {
      let during = -1;
      await trackContainerBuild('lazy-runner:1', async () => { during = runningContainerBuilds(); });
      expect(during).toBe(1);
      expect(runningContainerBuilds()).toBe(0);
      await expect(trackContainerBuild('broken:1', async () => { throw new Error('build failed'); })).rejects.toThrow('build failed');
      expect(runningContainerBuilds()).toBe(0);
      expect(seen).toEqual(['lazy-runner:1']);
    } finally {
      stop();
    }
  });

  test('a running bare build holds the scheduled canary off', async () => {
    const { trackContainerBuild } = await import('../../src/capture/build-observer');
    let release!: () => void;
    const build = trackContainerBuild('lazy-runner:1', () => new Promise<void>((r) => { release = r; }));
    // The default pressure probe (no seam), so the real build count is read.
    setMachineIntegrityDepsForTests({ supervised: () => true, now: () => 0, canary: async () => { throw new Error('must not run'); } });
    const record = await runIntegrityCanary('scheduled');
    expect(record.outcome).toBe('skipped');
    expect(record.summary).toContain('image build');
    release();
    await build;
  });

  // INVARIANT: audits are queued, never dropped — two builds finishing together
  // each get the at-commit pass, and every blob of both gets the after-idle pass.
  test('two builds back to back both get both passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blob-audit-'));
    try {
      const dir = contentBlobDir(root);
      await mkdir(dir, { recursive: true });
      const write = async (text: string) => {
        const name = createHash('sha256').update(text).digest('hex');
        await writeFile(join(dir, name), text);
        return name;
      };
      let now = Date.now();
      setMachineIntegrityDepsForTests({ supervised: () => true, dataRoot: async () => root, pressure: async () => ({ ...quiet, memAvailableBytes: 0 }), now: () => now });
      const a = await write('first build layer');
      const firstPass = auditAfterBuild('first', now - 1000);
      const b = await write('second build layer');
      const secondPass = auditAfterBuild('second', now - 1000);
      expect((await firstPass)?.build).toBe('first');
      expect((await secondPass)?.build).toBe('second');
      expect(machineIntegrityView().auditPending?.blobs).toBe(2);
      now += AUDIT_IDLE_MS + 1;
      await machineIntegrityTick();
      const idle = machineIntegrityView().audit;
      expect(idle).toMatchObject({ phase: 'after-idle', verdict: 'intact', checked: 2 });
      expect(idle?.build).toContain('first');
      expect(idle?.build).toContain('second');
      expect([a, b]).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('persisted alerts', () => {
  test('an open alert keeps the view damaged after a restart forgot the result', async () => {
    const { withOpenIntegrityAlerts } = await import('../../src/daemon/machine-integrity');
    const alert = integrityAlert({ kind: 'canary', text: 'evidence' });
    const view = withOpenIntegrityAlerts(machineIntegrityView(), [{ ...alert, created_at: 1 }]);
    expect(view.damaged).toBe(true);
    expect(view.openAlerts).toEqual([{ title: INTEGRITY_TITLES.canary, body: alert.body, createdAt: new Date(1).toISOString() }]);
    expect(withOpenIntegrityAlerts(machineIntegrityView(), []).damaged).toBe(false);
  });
});
