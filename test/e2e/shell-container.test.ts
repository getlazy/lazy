/**
 * `lazy shell <task>` container default — the exec seam.
 *
 * A scriptable `docker` on PATH stands in for the runtime, so the argv lazy
 * composes (and the fact that it execs into the task's OWN container rather
 * than the host worktree) is asserted for real.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

const FAKE_DOCKER = `#!/usr/bin/env bash
set -uo pipefail
STATE="__STATE_DIR__"
printf '%s\\n' "\$*" >> "\$STATE/invocations.log"
case "\${1:-}" in
  ps)
    if [ -f "\$STATE/running" ]; then echo "deadbeef1234"; fi
    exit 0
    ;;
  exec)
    exit "\$(cat "\$STATE/exec-code" 2>/dev/null || echo 0)"
    ;;
esac
exit 0
`;

describe('lazy shell --container', () => {
  let ctx: TestContext;
  let binDir: string;
  let stateDir: string;

  beforeEach(async () => {
    // A session and worktree are needed, and only the daemon reconciler creates
    // them — so this suite starts a real (mocked-agent) task.
    ctx = await setupTestLazy({ withDaemon: true });
    binDir = join(ctx.root, 'fake-bin');
    stateDir = join(ctx.root, 'fake-docker-state');
    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const script = join(binDir, 'docker');
    await writeFile(script, FAKE_DOCKER.replace('__STATE_DIR__', stateDir));
    await chmod(script, 0o755);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function shell(args: string[]) {
    return ctx.lazy(['shell', ...args], { env: { PATH: `${binDir}:${process.env.PATH}` } });
  }

  async function invocations(): Promise<string[]> {
    try {
      const raw = await readFile(join(stateDir, 'invocations.log'), 'utf-8');
      return raw.split('\n').filter(l => l.trim().length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`fake docker: failed to read invocations: ${(err as Error).message}`);
    }
  }

  async function startedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    return taskId;
  }

  // The container is the DEFAULT: no flag needed. This is the flipped
  // behavior — `lazy shell <task>` lands in the agent's environment.
  test('runs a passthrough command inside the container, not on the host', async () => {
    const taskId = await startedTask('Container exec');
    await writeFile(join(stateDir, 'running'), '');

    const result = await shell([taskId, '--', 'npm', 'test']);
    expectSuccess(result);

    const execs = (await invocations()).filter(l => l.startsWith('exec '));
    expect(execs.length).toBe(1);
    expect(execs[0]).toContain('npm test');
    // The container is addressed by name — the exec goes to THIS task's
    // environment, never to whatever container happens to be around.
    expect(execs[0]).toContain(taskId);
  });

  // `--container` stays accepted as a no-op alias for one release so existing
  // scripts keep working; it means what the default already means.
  test('--container is still accepted and does the same thing', async () => {
    const taskId = await startedTask('Container alias');
    await writeFile(join(stateDir, 'running'), '');

    expectSuccess(await shell([taskId, '--container', '--', 'echo', 'hi']));
    expect((await invocations()).filter(l => l.startsWith('exec ')).length).toBe(1);
  });

  // INVARIANT: the passthrough form's exit code is lazy's exit code, so it
  // composes in scripts exactly like the host-worktree form does.
  test('propagates the command exit code', async () => {
    const taskId = await startedTask('Exit code');
    await writeFile(join(stateDir, 'running'), '');
    await writeFile(join(stateDir, 'exec-code'), '3');

    const result = await shell([taskId, '--', 'false']);
    expect(result.exitCode).toBe(3);
  });

  // INVARIANT: a script-facing exec must not be given a pty — `-it` would make
  // docker frame the output and break whatever parses it.
  test('a passthrough exec is not interactive', async () => {
    const taskId = await startedTask('No pty');
    await writeFile(join(stateDir, 'running'), '');

    expectSuccess(await shell([taskId, '--', 'echo', 'hi']));
    const execs = (await invocations()).filter(l => l.startsWith('exec '));
    expect(execs[0]).not.toContain('-it');
  });

  test('-c is accepted as the short form', async () => {
    const taskId = await startedTask('Short flag');
    await writeFile(join(stateDir, 'running'), '');

    expectSuccess(await shell([taskId, '-c', '--', 'echo', 'hi']));
    expect((await invocations()).filter(l => l.startsWith('exec ')).length).toBe(1);
  });

  test('--host runs the command on the host worktree, never in the container', async () => {
    const taskId = await startedTask('Host form');
    await writeFile(join(stateDir, 'running'), '');

    expectSuccess(await shell([taskId, '--host', '--', 'pwd']));
    expect((await invocations()).filter(l => l.startsWith('exec ')).length).toBe(0);
  });

  test('--host and --container together are refused', async () => {
    const taskId = await startedTask('Contradiction');
    const result = await shell([taskId, '--host', '--container', '--', 'pwd']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('pick one');
  });

  // Published ports are fixed when a container is CREATED, so a [serve] edit
  // can only reach a live task by recreating it. Without --restart a running
  // container is entered as-is; with it, the relaunch happens and is announced —
  // recreating kills whatever was running inside, so silence would be wrong.
  //
  // (The relaunch itself runs daemon-side, where the module mock stands in for
  // the container runtime, so what this asserts is the decision and the notice,
  // not a real `docker run`.)
  test('--restart relaunches a container that is already running, loudly', async () => {
    const taskId = await startedTask('Restart');
    await writeFile(join(stateDir, 'running'), '');

    const plain = await shell([taskId, '--', 'echo', 'hi']);
    expectSuccess(plain);
    expect(plain.stdout).not.toContain('Recreating');

    const restarted = await shell([taskId, '--restart', '--', 'echo', 'hi']);
    expectSuccess(restarted);
    expectOutput(restarted, 'Recreating container');
  });

  test('--restart with --host is refused', async () => {
    const taskId = await startedTask('Restart on host');
    const result = await shell([taskId, '--host', '--restart', '--', 'pwd']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--host');
  });

  test('usage documents the flags, including the deprecated alias', async () => {
    const result = await ctx.lazy(['shell', '--help']);
    expectOutput(result, '--host');
    expectOutput(result, '--container');
    expectOutput(result, 'DEPRECATED');
  });
});
