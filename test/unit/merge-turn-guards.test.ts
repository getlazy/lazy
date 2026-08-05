/**
 * Merge-conflict resolution turns run under the same two guards as the work
 * phase.
 *
 * A merge turn is an ordinary agent turn: it edits files, runs tests, and
 * commits. It used to be spawned with `timeout: 0` and no watchdog at all, on
 * the single-blob `--output-format json`, which left it with no activity
 * signal — a wedged conflict resolution hung the task forever, and a CLI that
 * would not exit after resolving hung it just as hard.
 *
 * INVARIANTS pinned here:
 *
 *   1. A wind-down kill (the agent emitted its result but did not exit) is NOT
 *      a merge failure. The resolution is already captured and the worktree
 *      state decides — the merge must still be reported as successful, with
 *      the agent's summary preserved for the turn record.
 *   2. A no-progress kill IS a failure, and it must not be retried: a wedged
 *      agent wedges again. Heartbeats emitted by a stuck tool call do not
 *      count as progress (the whole point of the stream parser).
 *
 * These drive a real `claude` stand-in on PATH, so they exercise the actual
 * spawn → stream-parse → guard path rather than a mock of it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { runSyncWithUpstream } from '../../src/supervisor/merge';

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'Resolved the conflict in conflict.txt by keeping both changes.',
  session_id: 'merge-sess-123',
  is_error: false,
  usage: { input_tokens: 10, output_tokens: 20 },
});

const HEARTBEAT_LINE = JSON.stringify({
  type: 'tool_progress',
  heartbeat: true,
  parent_tool_use_id: 'toolu_stuck',
  tool_name: 'Bash',
  elapsed_time_seconds: 30,
});

async function initRepoWithConflict(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'conflict.txt'), 'base\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });

  // Diverge: task and main both edit the same line.
  await runGit(['checkout', '-q', '-b', 'task'], { cwd: dir });
  await writeFile(join(dir, 'conflict.txt'), 'task side\n');
  await runGit(['commit', '-q', '-am', 'task change'], { cwd: dir });

  await runGit(['checkout', '-q', 'main'], { cwd: dir });
  await writeFile(join(dir, 'conflict.txt'), 'main side\n');
  await runGit(['commit', '-q', '-am', 'main change'], { cwd: dir });

  await runGit(['checkout', '-q', 'task'], { cwd: dir });
}

/**
 * Install a `claude` stand-in on PATH. `body` is shell run in the worktree;
 * it receives the same argv the supervisor would pass to the real CLI.
 */
async function installFakeClaude(binDir: string, body: string): Promise<void> {
  const path = join(binDir, 'claude');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

describe('merge turns run under the two guards', () => {
  let repo: string;
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-mergeguard-'));
    binDir = await mkdtemp(join(tmpdir(), 'lazy-mergebin-'));
    await initRepoWithConflict(repo);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  // INVARIANT 1: the summary is captured before the kill, and the worktree
  // state — not the exit code of a CLI that would not quit — decides whether
  // the merge succeeded.
  test('a wind-down kill is not a merge failure; the resolution survives', async () => {
    await installFakeClaude(binDir, `
      git merge main --no-ff -m "Merge main" >/dev/null 2>&1
      printf 'both sides\\n' > conflict.txt
      git add conflict.txt
      git commit -q --no-edit >/dev/null 2>&1
      echo '${RESULT_LINE}'
      # Emit the result, then refuse to exit — exactly the hang the wind-down
      # guard exists for.
      sleep 60
    `);

    const result = await runSyncWithUpstream(repo, 'main', undefined, undefined, undefined, {
      noProgressTimeoutMs: 0,
      windDownTimeoutMs: 500,
    });

    expect(result.merged).toBe(true);
    expect(result.conflicts.length).toBe(1);
    expect(result.postMergeSha).not.toBe(result.preMergeSha);
    // The agent's own summary must reach the turn record, not a raw NDJSON dump.
    expect(result.resolution?.result).toContain('Resolved the conflict');
    expect(result.resolution?.session_id).toBe('merge-sess-123');
  }, 30000);

  // INVARIANT 2: heartbeats are liveness, not progress. A stuck tool call
  // emits one every 30s forever; counting them would make a wedged merge
  // immortal, which is the failure mode this guard exists to catch.
  test('a merge agent that only heartbeats is killed and NOT retried', async () => {
    await installFakeClaude(binDir, `
      while true; do
        echo '${HEARTBEAT_LINE}'
        sleep 0.2
      done
    `);

    await expect(
      runSyncWithUpstream(repo, 'main', undefined, undefined, undefined, {
        noProgressTimeoutMs: 1000,
        windDownTimeoutMs: 500,
      }),
    ).rejects.toThrow(/no forward progress/);

    // The merge must be left clean, not half-applied.
    const status = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: repo });
    expect(status.stdout.trim()).toBe('');
  }, 30000);

  // A normal merge turn: the agent resolves, summarises, and exits on its own.
  // Neither guard fires, and nothing about the happy path changed.
  test('a well-behaved merge agent completes with its summary intact', async () => {
    await installFakeClaude(binDir, `
      git merge main --no-ff -m "Merge main" >/dev/null 2>&1
      printf 'both sides\\n' > conflict.txt
      git add conflict.txt
      git commit -q --no-edit >/dev/null 2>&1
      echo '{"type":"system","subtype":"init","session_id":"merge-sess-123"}'
      echo '${RESULT_LINE}'
    `);

    const result = await runSyncWithUpstream(repo, 'main', undefined, undefined, undefined, {
      noProgressTimeoutMs: 10000,
      windDownTimeoutMs: 5000,
    });

    expect(result.merged).toBe(true);
    expect(result.resolution?.result).toContain('Resolved the conflict');
  }, 30000);
});
