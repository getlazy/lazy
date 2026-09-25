/**
 * A merge turn launches the TASK's agent, not a hardcoded `claude`.
 *
 * The live failure (fix-merge-agent-nonclaude): merge_and_fix spawned the
 * `claude` binary but appended the TASK's parameters, so a Cursor task ran
 *
 *     claude --model auto --resume <a cursor session id>
 *
 * which exits 1 before doing anything. Every retry did the same, no agent ever
 * saw the conflicts, and the worktree was left mid-merge. It happened four
 * times across two tasks in one overnight run.
 *
 * These drive real stand-in binaries on PATH, so they exercise the actual
 * spawn path rather than a mock of it — and the `claude` stand-in installed
 * here EXITS 1 like the real one did, so a regression cannot pass quietly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { runGit } from '../../src/utils/git';
import { runSyncWithUpstream, DEFAULT_MERGE_HARNESS } from '../../src/supervisor/merge';
import { resetElevatedGitChannel } from '../../src/supervisor/elevated-git';

async function initRepoWithConflict(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'conflict.txt'), 'base\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });

  await runGit(['checkout', '-q', '-b', 'task'], { cwd: dir });
  await writeFile(join(dir, 'conflict.txt'), 'task side\n');
  await runGit(['commit', '-q', '-am', 'task change'], { cwd: dir });

  await runGit(['checkout', '-q', 'main'], { cwd: dir });
  await writeFile(join(dir, 'conflict.txt'), 'main side\n');
  await runGit(['commit', '-q', '-am', 'main change'], { cwd: dir });

  await runGit(['checkout', '-q', 'task'], { cwd: dir });
}

async function installBin(binDir: string, name: string, body: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

describe('merge turns launch the task\'s own agent', () => {
  let repo: string;
  let binDir: string;
  let originalPath: string | undefined;
  let claudeLog: string;
  let cursorLog: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-mergeagent-'));
    binDir = await mkdtemp(join(tmpdir(), 'lazy-mergeagentbin-'));
    claudeLog = join(binDir, 'claude-argv.log');
    cursorLog = join(binDir, 'cursor-argv.log');
    await initRepoWithConflict(repo);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    // The `claude` stand-in behaves like the real binary did when handed a
    // Cursor model and session: it records the attempt and exits 1.
    await installBin(binDir, 'claude', `
      echo "$@" >> "${claudeLog}"
      exit 1
    `);
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    resetElevatedGitChannel();
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  /** A cursor-agent stand-in that really resolves the conflict and commits. */
  async function installResolvingCursor(): Promise<void> {
    await installBin(binDir, 'cursor-agent', `
      echo "$@" >> "${cursorLog}"
      git merge main --no-ff -m "Merge main" >/dev/null 2>&1
      printf 'both sides\\n' > conflict.txt
      git add conflict.txt
      git commit -q --no-edit >/dev/null 2>&1
      echo '{"type":"result","result":"Resolved conflict.txt keeping both sides.","session_id":"cursor-sess-xyz"}'
    `);
  }

  // INVARIANT (fix-merge-agent-nonclaude): a cursor task's conflicts are
  // resolved by cursor-agent. Its model (`auto`) and its session id are valid
  // for that CLI and are passed to it — the exact pair that was fatal when
  // handed to `claude`.
  test('a cursor task resolves with cursor-agent, and claude is never spawned', async () => {
    await installResolvingCursor();

    const result = await runSyncWithUpstream(repo, 'main', 'auto', 'cursor-sess-xyz', undefined, {
      harness: 'cursor',
      noProgressTimeoutMs: 0,
      windDownTimeoutMs: 500,
    });

    expect(result.merged).toBe(true);
    expect(result.conflicts.length).toBe(1);
    expect(result.postMergeSha).not.toBe(result.preMergeSha);
    expect(result.resolution?.result).toContain('Resolved conflict.txt');

    // The `claude` stand-in exits 1 — if the resolver had reached for it, the
    // sync would have failed. Prove it was never even invoked.
    expect(existsSync(claudeLog)).toBe(false);

    const cursorArgv = await readFile(cursorLog, 'utf-8');
    expect(cursorArgv).toContain('--model auto');
    expect(cursorArgv).toContain('--resume cursor-sess-xyz');
  }, 30000);

  // INVARIANT: a cursor merge-resolution turn records the concrete model
  // cursor-agent reported on its init line. The resolution is parsed from the
  // isolated result line, which never names a model, so without the init
  // model carried through, every merge turn reads as if it ran the alias.
  test('a cursor resolution records the init-line model as model_id', async () => {
    await installBin(binDir, 'cursor-agent', `
      echo '{"type":"system","subtype":"init","session_id":"cursor-sess-xyz","model":"claude-opus-4-5-20251101"}'
      git merge main --no-ff -m "Merge main" >/dev/null 2>&1
      printf 'both sides\\n' > conflict.txt
      git add conflict.txt
      git commit -q --no-edit >/dev/null 2>&1
      echo '{"type":"result","result":"Resolved conflict.txt keeping both sides.","session_id":"cursor-sess-xyz"}'
    `);

    const result = await runSyncWithUpstream(repo, 'main', 'auto', 'cursor-sess-xyz', undefined, {
      harness: 'cursor',
      noProgressTimeoutMs: 0,
      windDownTimeoutMs: 500,
    });

    expect(result.merged).toBe(true);
    expect(result.resolution?.model_id).toBe('claude-opus-4-5-20251101');
  }, 30000);

  // A task with no agent recorded still resolves with Claude Code, so nothing
  // about the existing path changes.
  test('the default resolver is still claude-code', async () => {
    await installBin(binDir, 'claude', `
      echo "$@" >> "${claudeLog}"
      git merge main --no-ff -m "Merge main" >/dev/null 2>&1
      printf 'both sides\\n' > conflict.txt
      git add conflict.txt
      git commit -q --no-edit >/dev/null 2>&1
      echo '{"type":"result","subtype":"success","result":"Resolved.","session_id":"s1","is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}'
    `);

    expect(DEFAULT_MERGE_HARNESS).toBe('claude-code');

    const result = await runSyncWithUpstream(repo, 'main', 'test-model', undefined, undefined, {
      noProgressTimeoutMs: 0,
      windDownTimeoutMs: 500,
    });

    expect(result.merged).toBe(true);
    const claudeArgv = await readFile(claudeLog, 'utf-8');
    expect(claudeArgv).toContain('-p');
    // No foreign parameters were invented for it: the model is exactly the one
    // the caller resolved (a model-less merge launch is refused outright).
    expect(claudeArgv).toContain('--model test-model');
    expect(claudeArgv).not.toContain('--resume');
  }, 30000);
});
