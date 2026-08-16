/**
 * `Runner.execInRun` — the seam `lazy doctor <task-id>` uses to run
 * `lazy-agent doctor` where the agent actually lives.
 *
 * Like docker-runner-stop.test.ts, this file mocks '../../src/utils/spawn' and
 * therefore must be the FIRST importer of DockerRunner in its own module scope
 * (DockerRunner binds `spawn` at module evaluation time). It uses the project's
 * mockModule/restoreMockedModules helper rather than raw mock.module for the
 * same reason: a leaked fake spawn corrupts every later unit file.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

const SPAWN_PATH = resolve(import.meta.dir, '../../src/utils/spawn.ts');

describe('DockerRunner.execInRun', () => {
  afterEach(() => {
    restoreMockedModules();
  });

  test('execs the argv in the named container and returns its exit code', async () => {
    const calls: string[][] = [];
    const opts: { stdout?: string; stderr?: string; timeout?: number }[] = [];
    await mockModule(SPAWN_PATH, () => ({
      spawn: (cmd: string[], o?: { stdout?: string; stderr?: string; timeout?: number }) => {
        calls.push(cmd);
        opts.push(o ?? {});
        return { exited: Promise.resolve(3), kill: () => {} };
      },
      spawnSync: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const { DockerRunner } = await import('../../src/runner/docker-runner');
    const runner = new DockerRunner('docker');

    const code = await runner.execInRun('lazy-abc12345', ['lazy-agent', 'doctor']);

    expect(code).toBe(3);
    expect(calls).toEqual([['docker', 'exec', 'lazy-abc12345', 'lazy-agent', 'doctor']]);

    // INVARIANT: output is INHERITED, never captured.
    // The caller is passing a human-readable diagnostic through. Capturing it
    // would reorder stdout against stderr and hold every line back until the
    // command finished — the opposite of what a diagnostic is for.
    expect(opts[0].stdout).toBe('inherit');
    expect(opts[0].stderr).toBe('inherit');

    // INVARIANT: the default 60s subprocess timeout is too short here.
    // The in-container doctor's MCP self-test alone allows 20s and
    // --probe-agent allows 90s; a timeout kill would be indistinguishable
    // from a failing check.
    expect(opts[0].timeout).toBeGreaterThan(60_000);
  });

  test('honors an explicit timeoutMs', async () => {
    const opts: { timeout?: number }[] = [];
    await mockModule(SPAWN_PATH, () => ({
      spawn: (_cmd: string[], o?: { timeout?: number }) => {
        opts.push(o ?? {});
        return { exited: Promise.resolve(0), kill: () => {} };
      },
      spawnSync: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const { DockerRunner } = await import('../../src/runner/docker-runner');
    const runner = new DockerRunner('docker');

    await runner.execInRun('lazy-abc12345', ['true'], { timeoutMs: 1234 });
    expect(opts[0].timeout).toBe(1234);
  });
});

describe('HostProcessRunner.execInRun', () => {
  // INVARIANT: no-inside-returns-null.
  // A host-process run is a plain process on this machine — there is no
  // environment to enter. It must answer null ("cannot look") rather than 0
  // ("looked, all fine"), because callers report the two differently.
  test('returns null — a host process has no inside to enter', async () => {
    const { HostProcessRunner } = await import('../../src/runner/host-process-runner');
    const runner = new HostProcessRunner();
    expect(await runner.execInRun('whatever', ['lazy-agent', 'doctor'])).toBeNull();
  });
});
