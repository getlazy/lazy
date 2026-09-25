/**
 * probeContainerInfo — a container lookup that says whether the runtime
 * ANSWERED, driven against fake `docker` binaries.
 *
 * `getContainerInfo` returns null both for "no such container" and for a
 * runtime that never answered (timed out, could not connect). Health needs the
 * difference: only the first confirms a dead run.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeContainerInfo } from '../../src/capture/claude';

let dir: string;

async function fakeBinary(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'probe-container-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('probeContainerInfo', () => {
  test('a running container is answered with its state', async () => {
    const bin = await fakeBinary('running', `echo "true 0 0001-01-01T00:00:00Z"`);
    expect(await probeContainerInfo('lazy-x', bin)).toEqual({
      kind: 'answered', info: { running: true, exitCode: 0, finishedAt: null },
    });
  });

  test('"No such object" is an answer: the container does not exist', async () => {
    const bin = await fakeBinary('missing', `echo "Error: No such object: lazy-x" >&2; exit 1`);
    expect(await probeContainerInfo('lazy-x', bin)).toEqual({ kind: 'answered', info: null });
  });

  test('a daemon it cannot connect to is NOT an answer', async () => {
    const bin = await fakeBinary('down', `echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1`);
    const probe = await probeContainerInfo('lazy-x', bin);
    expect(probe.kind).toBe('no-answer');
    expect(probe.kind === 'no-answer' && probe.reason).toContain('Cannot connect to the Docker daemon');
  });

  test('a lookup that outlives its deadline is NOT an answer', async () => {
    const bin = await fakeBinary('slow', `sleep 5`);
    const probe = await probeContainerInfo('lazy-x', bin, 200);
    expect(probe.kind).toBe('no-answer');
    expect(probe.kind === 'no-answer' && probe.reason).toContain('did not answer within');
  });

  test('a binary that cannot be started is NOT an answer', async () => {
    const probe = await probeContainerInfo('lazy-x', join(dir, 'does-not-exist'));
    expect(probe.kind).toBe('no-answer');
  });
});
