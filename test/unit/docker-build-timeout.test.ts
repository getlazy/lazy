/**
 * Container image builds are UNBOUNDED by default.
 *
 * INVARIANT: lazy never kills an image build on a timer unless a human asked
 * for a bound with `--timeout`. `docker build` has no timeout of its own; a
 * build killed on a timer wastes every second it ran and produces nothing,
 * which is strictly worse than one that runs long and succeeds.
 *
 * This file exists because the chokepoint (`runDockerBuild` in
 * src/capture/claude.ts) used to hardcode `timeout: 20 * 60_000`. That cliff
 * killed a real engineer's build repeatedly and surfaced as a bare non-zero
 * exit code, so it read as Docker Desktop failing rather than as lazy killing
 * it. Do NOT reinstate a default bound to make a test pass.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

interface SpawnCall {
  cmd: string[];
  options: Record<string, unknown>;
}

const calls: SpawnCall[] = [];
/** Set by a test to delay the fake `docker build` exit. */
let buildDurationMs = 0;
/** Records that the fake subprocess was killed (i.e. some timer fired). */
let killed = false;

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

function progressStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
}

function fakeSpawn(cmd: string[], options?: Record<string, unknown>) {
  // PASS THROUGH anything that is not a container-runtime call. `mock.module`
  // is process-wide and bun has no unmock, so a fake that swallowed every
  // spawn would leak into later test files and silently break suites that
  // shell out to git — which is exactly what happened the first time this file
  // was written. Only `docker`/`podman` is faked here; everything else runs for
  // real, so the leak is inert.
  //
  // `realSpawn` must be a reference captured BEFORE the mock is registered:
  // bun rewrites the live namespace object's bindings in place, so reading
  // `spawnModule.spawn` here would find this very function and recurse.
  if (cmd[0] !== 'docker' && cmd[0] !== 'podman') {
    return realSpawn(cmd, options as never);
  }

  calls.push({ cmd, options: options ?? {} });

  const isBuild = cmd[1] === 'build';
  let settle!: (code: number) => void;
  const exited = new Promise<number>(resolve => { settle = resolve; });

  if (isBuild) {
    const timer = setTimeout(() => settle(0), buildDurationMs);
    return {
      stdout: emptyStream(),
      stderr: progressStream(['#1 [1/2] FROM docker.io/library/debian', '#1 DONE 0.1s']),
      exited,
      kill() { killed = true; clearTimeout(timer); settle(143); },
    };
  }

  // `docker info` and anything else: succeed immediately.
  settle(0);
  return { stdout: emptyStream(), stderr: emptyStream(), exited, kill() { killed = true; } };
}

// `mock.module` is process-wide and bun has no unmock: whatever is registered
// here stays registered for every later test file in the same `bun test` run.
// So the real implementation is captured first, and `fakeSpawn` delegates to it
// for every non-container command — the leak is then inert rather than silently
// breaking suites that shell out to git.
const realSpawnModule = await import('../../src/utils/spawn');
const realSpawn = realSpawnModule.spawn;

mock.module('../../src/utils/spawn', () => ({
  ...realSpawnModule,
  spawn: fakeSpawn,
}));

const { buildLazyRunnerImage } = await import('../../src/capture/claude');

function buildCall(): SpawnCall {
  const call = calls.find(c => c.cmd[1] === 'build');
  if (!call) throw new Error(`no docker build spawn recorded (got: ${calls.map(c => c.cmd.join(' ')).join(' | ')})`);
  return call;
}

describe('container image build timeout', () => {
  beforeEach(() => {
    calls.length = 0;
    buildDurationMs = 0;
    killed = false;
  });

  // INVARIANT: no default bound. spawn() only arms its kill timer when
  // `timeout > 0`, so passing 0 is what disables it — and runDockerBuild owns
  // any real bound itself. If someone reinstates a default here, this fails.
  test('a build with no explicit timeout arms no kill timer', async () => {
    await buildLazyRunnerImage({});

    expect(buildCall().options.timeout).toBe(0);
    expect(killed).toBe(false);
  });

  test('a build that outlasts the old 20-minute bound is not killed', async () => {
    // Not a 20-minute test: the point is that NOTHING but an explicit bound can
    // kill the build, so any delay proves it as long as no timer exists.
    buildDurationMs = 120;
    await buildLazyRunnerImage({});
    expect(killed).toBe(false);
  });

  // `--timeout 0` is the explicit spelling of the default, not a zero-length
  // deadline — a script computing a value must not accidentally kill instantly.
  test('timeoutMs 0 means unbounded, not instant', async () => {
    buildDurationMs = 120;
    await buildLazyRunnerImage({ timeoutMs: 0 });
    expect(killed).toBe(false);
  });

  test('an opt-in timeout kills the build and blames lazy, not Docker', async () => {
    buildDurationMs = 10_000;

    let error: Error | null = null;
    try {
      await buildLazyRunnerImage({ timeoutMs: 60 });
    } catch (err) {
      error = err as Error;
    }

    expect(killed).toBe(true);
    expect(error).not.toBeNull();
    const message = error!.message;
    // The whole point of the message: a killed build must never again read as
    // Docker failing, and the human must be told the bound is theirs to remove.
    expect(message).toContain('lazy killed it');
    expect(message).toContain('Docker did not fail');
    expect(message).toContain('--timeout');
    expect(message).toContain('UNBOUNDED by');
    // Never a bare exit code.
    expect(message).not.toContain('exit code 143');
  });
});
