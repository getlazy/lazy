/**
 * Podman availability guidance — pins the install URL.
 *
 * PodmanRunner existed with the correct podman.io link while DockerRunner('podman')
 * regressed to checkDocker's bogus docs.podman.com/get-podman/ template. Both paths
 * must cite podman.io/docs/installation.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

const realSpawnModule = await import('../../src/utils/spawn');
const realSpawn = realSpawnModule.spawn;

mock.module('../../src/utils/spawn', () => ({
  ...realSpawnModule,
  spawn: (cmd: string[], opts?: Parameters<typeof realSpawn>[1]) => {
    if (cmd[0] === 'podman' && cmd[1] === 'info') {
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(1),
        kill: () => {},
      };
    }
    return realSpawn(cmd, opts);
  },
}));

const { PodmanRunner } = await import('../../src/runner/podman-runner');
const { checkDocker } = await import('../../src/capture/claude');

const PODMAN_INSTALL = 'https://podman.io/docs/installation';

describe('Podman availability messages', () => {
  beforeEach(() => {
    // Each test expects podman info to fail via the mock above.
  });

  test('PodmanRunner.checkAvailability cites podman.io', async () => {
    const runner = new PodmanRunner();
    await expect(runner.checkAvailability()).rejects.toThrow(PODMAN_INSTALL);
    await expect(runner.checkAvailability()).rejects.not.toThrow('docs.podman.com');
  });

  test('checkDocker("podman") cites podman.io', async () => {
    await expect(checkDocker('podman')).rejects.toThrow(PODMAN_INSTALL);
    await expect(checkDocker('podman')).rejects.not.toThrow('docs.podman.com');
  });
});
