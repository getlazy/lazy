/**
 * Unit tests: the harness reaper for stranded machine one-shots.
 *
 * THE LEAK THIS ENCODES
 * ---------------------
 * `runClaudeOneshot` spawns a bare `claude -p` on the host. It is a child of
 * whichever process ran it, it has no pidfile, and none of the three existing
 * test reapers ever looked for one: `ctx.cleanup()` reaps daemons and
 * supervisors by pidfile and command line, the daemon-registry exit net reaps
 * the same two, and `LAZY_TEST_PARENT_PID` is a daemon/supervisor mechanism.
 * Containers accumulated stranded `claude` pids carrying the one-shot marker.
 *
 * These tests drive the matcher and the sweep against a REAL process — a fake
 * `claude` that hangs, spawned with a one-shot argv in a known cwd. Anything
 * weaker asserts on our own string handling rather than on whether the process
 * actually dies.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ONESHOT_MARKER, markMachineOneshotPrompt } from '../../src/import/machine-oneshot';
import {
  isMachineOneshotClaudeCommand,
  findOneshotClaudeUnderDirs,
  killOneshotClaudeUnderDirs,
} from '../helpers/daemon-registry';
import { spawn } from '../../src/utils/spawn';

/**
 * INVARIANT: daemon-registry.ts duplicates this nonce instead of importing
 * ONESHOT_MARKER, because it is loaded by the global preload and may only
 * import leaf modules. That duplication is only safe while the two agree — this
 * test is what keeps it from rotting silently.
 */
test('the reaper nonce is still part of the real one-shot marker', () => {
  expect(ONESHOT_MARKER).toContain('lazy-machine-oneshot/v1/');
});

describe('machine one-shot command matching', () => {
  const marked = markMachineOneshotPrompt('summarize this');

  test('matches a one-shot argv, including a shebang-script agent', () => {
    expect(isMachineOneshotClaudeCommand(`claude -p ${marked} --output-format json`)).toBe(true);
    // /proc reports the interpreter first for the harness's fake agent.
    expect(
      isMachineOneshotClaudeCommand(`/usr/bin/bun /tmp/fake/bin/claude -p ${marked}`),
    ).toBe(true);
  });

  test('never matches a human`s own claude, or another lazy process', () => {
    // A developer's interactive or scripted run carries no marker. This is the
    // check that keeps the sweep from reaping someone's real work.
    expect(isMachineOneshotClaudeCommand('claude -p "what does this repo do"')).toBe(false);
    expect(isMachineOneshotClaudeCommand('claude')).toBe(false);
    // Marker present but not a claude one-shot: e.g. a grep for it.
    expect(isMachineOneshotClaudeCommand(`grep -r ${marked} src`)).toBe(false);
  });
});

describe('one-shot sweep against a live process', () => {
  let dir: string;
  let binPath: string;
  let workDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-oneshot-reaper-'));
    const binDir = join(dir, 'bin');
    workDir = join(dir, 'work');
    await mkdir(binDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    binPath = join(binDir, 'claude');
    // A `claude` that never answers — the wedged one-shot this reaper is for.
    await writeFile(binPath, `#!${process.execPath}\nsetTimeout(() => {}, 120000);\n`);
    await chmod(binPath, 0o755);
  });

  afterEach(async () => {
    killOneshotClaudeUnderDirs([dir]);
    await rm(dir, { recursive: true, force: true });
  });

  test('finds a stranded one-shot by marker + cwd, and reaps it', async () => {
    const proc = spawn([binPath, '-p', markMachineOneshotPrompt('hello'), '--output-format', 'json'], {
      cwd: workDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // The process table takes a beat to reflect the new pid.
    let found: number[] = [];
    for (let i = 0; i < 40 && found.length === 0; i++) {
      await new Promise(r => setTimeout(r, 50));
      found = findOneshotClaudeUnderDirs([dir]);
    }
    expect(found).toContain(proc.pid);

    // INVARIANT: the cwd tie is load-bearing. A marker match alone would reap
    // one-shots belonging to a concurrently running `bun test` — or to the
    // developer's own daemon — so a directory this run does not own finds
    // nothing, even though the very same process carries the marker.
    expect(findOneshotClaudeUnderDirs([join(tmpdir(), 'lazy-oneshot-reaper-not-ours')])).toEqual([]);

    expect(killOneshotClaudeUnderDirs([dir])).toContain(proc.pid);
    await proc.exited;
    expect(findOneshotClaudeUnderDirs([dir])).toEqual([]);
  }, 15000);
});
