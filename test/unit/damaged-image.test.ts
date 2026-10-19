import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DamagedImageError,
  forgetFailedDamagedImageRepair,
  isDamagedLayerError,
  resetDamagedImageRepairForTests,
  setDamagedImageReporter,
  withDamagedImageRepair,
  type DamagedImageRepairEvent,
} from '../../src/docker/damaged-image';

// The engineer's own message (Teams, project token-watch, 2026-10-15).
const FIELD_MESSAGE =
  'Failed to launch supervisor container: docker: Error response from daemon: apply layer error for "": ' +
  'failed to extract layer sha256:c315cf96: archive/tar: invalid tar header';

let dir: string;
let docker: string;
let log: string;

/** A stand-in `docker` that records every argv it is given, one line each. */
async function fakeDocker(rmExit = 0, rmStderr = ''): Promise<void> {
  await writeFile(docker,
    `#!/bin/sh\necho "$*" >> "${log}"\n` +
    `if [ "$1" = image ] && [ "$2" = rm ]; then printf '%s' "${rmStderr}" >&2; exit ${rmExit}; fi\nexit 0\n`);
  await chmod(docker, 0o755);
}

async function dockerCalls(): Promise<string[]> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'damaged-image-'));
  docker = join(dir, 'docker');
  log = join(dir, 'calls.log');
  await fakeDocker();
});

afterEach(async () => {
  resetDamagedImageRepairForTests();
  await rm(dir, { recursive: true, force: true });
});

function harness(opts: { failures: number; canRebuild?: boolean }) {
  const state = { launches: 0, rebuilds: 0, events: [] as DamagedImageRepairEvent[], notes: [] as string[] };
  setDamagedImageReporter(async (e) => { state.events.push(e); });
  const ctx = {
    binary: docker,
    subject: 'task',
    taskId: 'some-task',
    notify: (d: string) => state.notes.push(d),
    canRebuild: async () => opts.canRebuild ?? true,
    rebuild: async () => { state.rebuilds++; },
  };
  const launch = async () => {
    state.launches++;
    if (state.launches <= opts.failures) throw new DamagedImageError('lazy-runner:0.23', FIELD_MESSAGE);
    return 'launched';
  };
  return { state, ctx, launch };
}

describe('damaged runner image self-repair', () => {
  test('recognises Docker\'s layer-extraction failures, and nothing else', () => {
    expect(isDamagedLayerError(FIELD_MESSAGE)).toBe(true);
    expect(isDamagedLayerError('failed to register layer: unexpected EOF while extracting layer')).toBe(true);
    expect(isDamagedLayerError('docker: Error response from daemon: Conflict. The container name is already in use')).toBe(false);
    expect(isDamagedLayerError('unexpected EOF')).toBe(false);
  });

  // INVARIANT: a launch that fails on a damaged layer removes THAT image,
  // rebuilds it, and retries exactly once — narrated to whoever is watching.
  // A member giving feedback must not hit a wall that needs an admin to wipe
  // the machine (engineer, 2026-10-15: lifecycle self-heals).
  test('removes the image, rebuilds it and retries the launch once', async () => {
    const { state, ctx, launch } = harness({ failures: 1 });
    expect(await withDamagedImageRepair(ctx, launch)).toBe('launched');
    expect(state.launches).toBe(2);
    expect(state.rebuilds).toBe(1);
    expect(await dockerCalls()).toEqual(['image rm lazy-runner:0.23']);
    expect(state.notes[0]).toBe("The task's image was damaged; rebuilding it, then retrying");
    expect(state.events.map((e) => e.outcome)).toEqual(['repaired']);
  });

  // INVARIANT: one repair, one retry — never a loop. A second damaged-layer
  // failure means the damage is outside this image; the error keeps Docker's
  // words (the Teams banner reads them to offer Reset Docker storage).
  test('a retry that fails the same way is not repaired again', async () => {
    const { state, ctx, launch } = harness({ failures: 5 });
    const err = await withDamagedImageRepair(ctx, launch).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('invalid tar header');
    expect((err as Error).message).toContain('needs a reset');
    expect(state.launches).toBe(2);
    expect(state.rebuilds).toBe(1);
    expect(await dockerCalls()).toEqual(['image rm lazy-runner:0.23']);
    expect(state.events.map((e) => e.outcome)).toEqual(['failed']);
  });

  // INVARIANT: the repair never deletes volumes, other images or containers,
  // and never forces a removal Docker refused. Its only docker call is a plain
  // `image rm` of the one damaged image.
  test('never touches volumes, other images or containers, and never forces', async () => {
    await fakeDocker(1, 'Error response from daemon: conflict: unable to remove repository reference "lazy-runner:0.23" (must force) - container 1a2b is using its referenced image');
    const { state, ctx, launch } = harness({ failures: 1 });
    const err = await withDamagedImageRepair(ctx, launch).catch((e: Error) => e);
    expect((err as Error).message).toContain('could not remove the damaged image');
    const calls = await dockerCalls();
    expect(calls).toEqual(['image rm lazy-runner:0.23']);
    for (const c of calls) expect(c).not.toMatch(/volume|prune|system|--force|-f\b|container|rmi/);
    expect(state.rebuilds).toBe(0);
    expect(state.launches).toBe(1);
  });

  test('an image lazy may not rebuild (task-pinned, adopted) is left alone', async () => {
    const { state, ctx, launch } = harness({ failures: 1, canRebuild: false });
    const err = await withDamagedImageRepair(ctx, launch).catch((e: Error) => e);
    expect((err as Error).message).toContain('does not rebuild');
    expect(await dockerCalls()).toEqual([]);
    expect(state.launches).toBe(1);
  });

  test('concurrent launches on one damaged image share a single repair', async () => {
    const a = harness({ failures: 1 });
    const b = harness({ failures: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let rebuilds = 0;
    const slow = async () => { rebuilds++; await gate; };
    const pa = withDamagedImageRepair({ ...a.ctx, rebuild: slow }, a.launch);
    const pb = withDamagedImageRepair({ ...b.ctx, rebuild: slow }, b.launch);
    await new Promise((r) => setTimeout(r, 200));
    release();
    expect(await Promise.all([pa, pb])).toEqual(['launched', 'launched']);
    expect(rebuilds).toBe(1);
    expect(await dockerCalls()).toEqual(['image rm lazy-runner:0.23']);
  });

  test('other launch failures pass through untouched', async () => {
    const { state, ctx } = harness({ failures: 0 });
    const err = await withDamagedImageRepair(ctx, async () => { throw new Error('Conflict. The container name is in use'); }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Conflict. The container name is in use');
    expect(await dockerCalls()).toEqual([]);
    expect(state.rebuilds).toBe(0);
  });
});

describe('a retry that fails for another reason', () => {
  // INVARIANT: once the rebuilt image starts, the repair worked — a launch that
  // then fails for an unrelated reason is that reason, rethrown as is, and is
  // never recorded as a damaged store needing a reset.
  test('is recorded as repaired and rethrown unchanged', async () => {
    const events: DamagedImageRepairEvent[] = [];
    setDamagedImageReporter(async (e) => { events.push(e); });
    let launches = 0;
    const err = await withDamagedImageRepair(
      { binary: docker, subject: 'task', canRebuild: async () => true, rebuild: async () => {} },
      async () => {
        launches++;
        if (launches === 1) throw new DamagedImageError('lazy-runner:0.23', FIELD_MESSAGE);
        throw new Error('Conflict. The container name is already in use');
      },
    ).catch((e: Error) => e);
    expect((err as Error).message).toBe('Conflict. The container name is already in use');
    expect(launches).toBe(2);
    expect(events.map((e) => e.outcome)).toEqual(['repaired']);
    expect(events[0].error).toContain('Conflict');
  });
});

describe('review fixes: no loop, no full disk, one evidence collector', () => {
  // INVARIANT: a full or unwritable disk is never a damaged layer. Docker prints
  // "failed to extract layer" for it too; removing the image there deletes the
  // project's only image and the rebuild fails on the same full disk.
  test('a layer that failed to extract because the disk is full is not damaged', () => {
    expect(isDamagedLayerError('failed to register layer: failed to extract layer sha256:ab: write /var/lib/docker/x: no space left on device')).toBe(false);
    expect(isDamagedLayerError('apply layer error for "": failed to extract layer sha256:ab: input/output error')).toBe(false);
    expect(isDamagedLayerError(FIELD_MESSAGE)).toBe(true);
  });

  // INVARIANT: a repair that did not help is not run again for the same image
  // and error. A launch that still fails is parked interrupted and auto-resume
  // relaunches it many times; each relaunch used to run another no-cache
  // rebuild (the build that OOM-killed dockerd) and file another alert.
  test('a relaunch after a failed repair does not rebuild again, and its record carries no evidence', async () => {
    const first = harness({ failures: 5 });
    let collected = 0;
    const ctx = { ...first.ctx, collectEvidence: async () => { collected++; return 'blob facts'; } };
    await withDamagedImageRepair(ctx, first.launch).catch(() => {});
    expect(first.state.rebuilds).toBe(1);
    const again = await withDamagedImageRepair(ctx, first.launch).catch((e: Error) => e);
    expect((again as Error).message).toContain('invalid tar header');
    expect((again as Error).message).toContain('not rebuilt again');
    expect(first.state.rebuilds).toBe(1);
    expect(collected).toBe(1);
    expect(await dockerCalls()).toEqual(['image rm lazy-runner:0.23']);
    // Without evidence the second record collapses into the open alert.
    expect(first.state.events.map((e) => [e.outcome, !!e.evidence])).toEqual([['failed', true], ['failed', false]]);
  });

  test('asking for a rebuild makes the repair worth trying again', async () => {
    const { state, ctx, launch } = harness({ failures: 3 });
    await withDamagedImageRepair(ctx, launch).catch(() => {});
    forgetFailedDamagedImageRepair('lazy-runner:0.23');
    expect(await withDamagedImageRepair(ctx, launch)).toBe('launched');
    expect(state.rebuilds).toBe(2);
  });

  // INVARIANT: of concurrent launches on one damaged image, only the one that
  // starts the repair collects evidence — the single flight is claimed before
  // the first await, not after the evidence is in.
  test('concurrent launches collect the evidence once', async () => {
    const a = harness({ failures: 1 });
    const b = harness({ failures: 1 });
    let collected = 0;
    const collectEvidence = async () => { collected++; await Bun.sleep(100); return 'facts'; };
    await Promise.all([
      withDamagedImageRepair({ ...a.ctx, collectEvidence }, a.launch),
      withDamagedImageRepair({ ...b.ctx, collectEvidence }, b.launch),
    ]);
    expect(collected).toBe(1);
  });
});

describe('remembered failures across launch kinds and reasons', () => {
  // INVARIANT: the same damage is remembered once, whichever launch hit it —
  // a task launch and a builder launch word Docker's error differently, and
  // keying on the whole message let them each repair again.
  test('a failure remembered from a task launch is not repaired again by a builder launch', async () => {
    const { state, ctx } = harness({ failures: 0 });
    const task = async () => { throw new DamagedImageError('lazy-runner:0.23', FIELD_MESSAGE); };
    await withDamagedImageRepair(ctx, task).catch(() => {});
    expect(state.rebuilds).toBe(1);
    const builderMessage = 'Failed to start detached builder session (exit 125): docker: Error response from daemon: ' +
      'apply layer error for "": failed to extract layer sha256:c315cf96: archive/tar: invalid tar header';
    const err = await withDamagedImageRepair({ ...ctx, subject: 'builder' }, async () => { throw new DamagedImageError('lazy-runner:0.23', builderMessage); }).catch((e: Error) => e);
    expect((err as Error).message).toContain('not rebuilt again');
    expect(state.rebuilds).toBe(1);
  });

  // INVARIANT: a remembered failure never claims a rebuild that did not happen,
  // and never points at Rebuild for an image lazy does not rebuild.
  test('a pinned image\'s remembered failure claims no rebuild and offers none', async () => {
    const { state, ctx, launch } = harness({ failures: 5, canRebuild: false });
    await withDamagedImageRepair(ctx, launch).catch(() => {});
    const err = await withDamagedImageRepair(ctx, launch).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('removed and rebuilt');
    expect((err as Error).message).not.toContain('Rebuild the image');
    expect((err as Error).message).toContain('does not rebuild');
    expect(state.events.map((e) => !!e.repeat)).toEqual([false, true]);
  });
});
