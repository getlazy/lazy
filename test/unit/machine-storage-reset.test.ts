/**
 * resetMachineDockerStorage — the daemon's half of "reset this machine's Docker
 * storage": confirmation, who may ask (the RPC), one at a time, dockerd recovery
 * held off for the duration, and the guest's narration kept in order.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetMachineDockerStorage, resetStorageResetForTests, resetMachineRestartForTests, restartMachineService, observeMachine, MachineRestartError, GUEST_PATHS,
} from '../../src/daemon/machine-observation';
import { requestedDockerdRestartRunning } from '../../src/daemon/guest-dockerd';
import { handleResetMachineDockerStorage } from '../../src/daemon/rpc-handlers';

let dir: string;
const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };

async function init(body: string): Promise<string> {
  const p = join(dir, 'lazy-guest-init');
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}
async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'storage-reset-'));
  process.env.LAZY_MANAGED = '1';
  process.env.LAZY_MANAGED_BACKEND = 'microvm';
  resetStorageResetForTests();
  resetMachineRestartForTests();
});
afterEach(async () => {
  for (const [k, v] of [['LAZY_MANAGED', saved.m], ['LAZY_MANAGED_BACKEND', saved.b]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe('resetMachineDockerStorage', () => {
  // INVARIANT: the reset deletes every image, container, volume and build cache, so it never starts without an explicit confirm.
  test('refuses without confirm: true and runs nothing', async () => {
    const ran = join(dir, 'ran');
    const g = await init(`touch ${ran}`);
    for (const c of [undefined, false, 'yes', 1]) {
      expect(() => resetMachineDockerStorage(c, { guestInit: () => g })).toThrow(/confirm: true/);
    }
    await new Promise(r => setTimeout(r, 100));
    expect(await Bun.file(ran).exists()).toBe(false);
  });

  test('narrates the guest\'s steps in order, holds dockerd recovery off while running, then says builds are cold', async () => {
    const g = await init(`
echo reset_step=Stopping dockerd and containerd
sleep 0.3
echo reset_step=Unmounting 2 mount\\(s\\)
echo reset_freed_kb=2097152
echo reset_result=done
echo ready=yes
echo source=reset-storage`);
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    expect(view.state).toBe('running');
    await until(() => view.steps.length >= 2, 'the first narration');
    expect(requestedDockerdRestartRunning()).toBe(true);
    await until(() => view.state !== 'running', 'the reset');
    expect(view.state).toBe('succeeded');
    expect(requestedDockerdRestartRunning()).toBe(false);
    expect(view.freedKb).toBe(2097152);
    expect(view.steps[0]).toMatch(/Holding off/);
    expect(view.steps[1]).toBe('Stopping dockerd and containerd');
    expect(view.steps.at(-1)).toMatch(/cold/);
  });

  test('a failed reset reports why, in words, and says whether dockerd is running', async () => {
    const g = await init('echo reset_step=Stopping dockerd and containerd\necho reset_step=Unmounting 1 mount\\(s\\)\necho reset_step=Starting dockerd again regardless\necho reset_result=failed\necho reset_reason=reset-unmount-failed\necho ready=yes\nexit 1');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    await until(() => view.state !== 'running', 'the reset');
    expect(view.state).toBe('failed');
    expect(view.failure).toContain('some mounts under the Docker storage would not unmount, so nothing was removed');
    expect(view.failure).toContain('dockerd is running again');
    expect(requestedDockerdRestartRunning()).toBe(false);
  });

  test('one at a time, and not beside a restart', async () => {
    const g = await init('sleep 0.5\necho ready=yes');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    expect(() => resetMachineDockerStorage(true, { guestInit: () => g })).toThrow(/already running/);
    expect(() => restartMachineService('forwarder', { guestInit: () => g })).toThrow(/reset of Docker storage is running/);
    await until(() => view.state !== 'running', 'the reset');
  });

  test('off a microVM, or with no guest init, nothing is reset', () => {
    expect(() => resetMachineDockerStorage(true, { guestInit: () => null })).toThrow(/not installed/);
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    expect(() => resetMachineDockerStorage(true, { guestInit: () => '/x' })).toThrow(/not a Lazy Teams microVM/);
    delete process.env.LAZY_MANAGED;
    expect(() => resetMachineDockerStorage(true, { guestInit: () => '/x' })).toThrow(MachineRestartError);
  });

  test('machineState carries the reset, so the Machine page and the CLI can narrate it', async () => {
    const g = await init('echo reset_step=Stopping dockerd\necho ready=yes');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    await until(() => view.state !== 'running', 'the reset');
    const paths = { ...GUEST_PATHS, dockerdLog: join(dir, 'd.log'), dockerdPid: join(dir, 'd.pid'), forwarderLog: join(dir, 'f.log'), forwarderPid: join(dir, 'f.pid') };
    const observed = await observeMachine(dir, { lines: 0 }, { paths, guestInit: () => g, dockerBinary: async () => null, proxy: async () => null });
    expect(observed.storageReset?.state).toBe('succeeded');
    expect(observed.storageReset?.steps).toContain('Stopping dockerd');
  });
});

describe('the resetMachineDockerStorage RPC', () => {
  // INVARIANT: like a restart, only the control plane asks; Rails decides which admins may, and a member token is refused whoever holds it.
  test('refuses a member token', async () => {
    await expect(handleResetMachineDockerStorage(dir, { confirm: true }, { kind: 'user', email: 'a@b.c', name: 'A' } as never)).rejects.toThrow(/Forbidden/);
  });
  test('the control caller without confirm is a 400', async () => {
    await expect(handleResetMachineDockerStorage(dir, {}, { kind: 'control' } as never)).rejects.toThrow(/confirm: true/);
  });
});

describe('what a failed reset says about Docker, and the page while it runs', () => {
  // INVARIANT: the failure text claims only what the narration backs — an old guest image or a refused data root never touched Docker.
  test('an older guest image (no --reset-storage) says Docker was not touched', async () => {
    const g = await init('echo "lazy-guest-init: unknown argument: --reset-storage" >&2\nexit 2');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    await until(() => view.state !== 'running', 'the reset');
    expect(view.state).toBe('failed');
    expect(view.failure).toContain('Docker was not touched');
    expect(view.failure).not.toContain('NOT running');
  });

  test('a refused data root says Docker was not touched', async () => {
    const g = await init('echo ready=no\necho reason=reset-refused-data-root\nexit 1');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    await until(() => view.state !== 'running', 'the reset');
    expect(view.failure).toContain('not where lazy expects it');
    expect(view.failure).toContain('Docker was not touched');
  });

  test('a stop that failed after dockerd was stopped says it is NOT running', async () => {
    const g = await init('echo reset_step=Stopping dockerd and containerd\necho reset_step=Starting dockerd on an empty store\necho ready=no\necho reason=dockerd-timeout\nexit 1');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    await until(() => view.state !== 'running', 'the reset');
    expect(view.failure).toContain('dockerd is NOT running');
  });

  // INVARIANT: dockerd being down during a reset is expected, so the page shows no "container runtime is not running" escalation for it.
  test('dockerd is shown as being reset, with no maintainer escalation, while it runs', async () => {
    const g = await init('echo reset_step=Stopping dockerd and containerd\nsleep 1\necho ready=yes');
    const view = resetMachineDockerStorage(true, { guestInit: () => g });
    const paths = { ...GUEST_PATHS, dockerdLog: join(dir, 'd.log'), dockerdPid: join(dir, 'd.pid'), dockerdHistory: join(dir, 'h.log'), dockerdRestarts: join(dir, 'r'), dockerdGaveUp: join(dir, 'g'), dockerdUnresponsiveSince: join(dir, 'u'), forwarderLog: join(dir, 'f.log'), forwarderPid: join(dir, 'f.pid') };
    const docker = join(dir, 'docker');
    await writeFile(docker, '#!/bin/sh\nexit 1\n');
    await chmod(docker, 0o755);
    const observed = await observeMachine(dir, { lines: 0 }, { paths, guestInit: () => g, dockerBinary: async () => docker, proxy: async () => null });
    const dockerd = observed.services.find((s) => s.name === 'dockerd')!;
    expect(dockerd.detail).toContain('being reset');
    expect(dockerd.escalation).toBeNull();
    await until(() => view.state !== 'running', 'the reset');
  });
});
