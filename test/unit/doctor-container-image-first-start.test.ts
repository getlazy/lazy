import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkContainerImage, containerImagePresent } from '../../src/doctor/sweep';

let dir: string;
let missing: string;
let present: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doctor-image-'));
  missing = join(dir, 'docker-missing');
  present = join(dir, 'docker-present');
  await writeFile(missing, '#!/bin/sh\necho "Error: No such image" >&2\nexit 1\n');
  await writeFile(present, '#!/bin/sh\necho sha256:abc\n');
  await chmod(missing, 0o755);
  await chmod(present, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Container image exists before the first task start', () => {
  // INVARIANT: a not-yet-built image is the expected state before the first
  // task start, which builds or pulls it — never a failing finding. As a
  // failure it made Teams tell members "tasks can't start" on every freshly
  // provisioned project.
  test('a missing image is ok with a note, not a failure', async () => {
    const result = await checkContainerImage('lazy-runner:test', missing);
    expect(result.ok).toBe(true);
    expect(result.detail).toBeUndefined();
    expect(result.warning).toContain('first task start');
    expect(await containerImagePresent('lazy-runner:test', missing)).toBe(false);
  });

  test('a present image is ok with no note', async () => {
    const result = await checkContainerImage('lazy-runner:test', present);
    expect(result).toEqual({ ok: true, label: 'Container image exists (lazy-runner:test)' });
    expect(await containerImagePresent('lazy-runner:test', present)).toBe(true);
  });
});
