/**
 * E2E: a REJECTED protected file is restored by lazy's supervisor before the
 * agent's next work turn — never left to the agent.
 *
 * Engineer decision 2026-09-28: "we cannot trust the agent to revert, so lazy's
 * supervisor does that." Real stack (fake `claude` binary on the host-process
 * runner): reject on the review page → unblock → the supervisor restores the
 * file to its base in a commit of its own, THEN the agent runs, told what was
 * restored → accept names the lazy-made restore.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, disablePreAccept, setProtectedPatterns } from '../helpers/fixtures';
import { successScenario } from '../helpers/fake-claude';
import { findFullTaskId, readTaskStatus, readTurns, worktreePathFor } from '../helpers/storage';
import { signInToDashboard } from '../helpers/dashboard-session';

const GUARD = 'guard.md';
const ORIGINAL = 'the original guard\n';
const AGENT_EDIT = 'the agent rewrote the guard\n';

function gitIn(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the supervisor restores a rejected protected file', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    disablePreAccept(ctx.root);
    setProtectedPatterns(ctx.root, [GUARD]);
    await writeFile(join(ctx.root, GUARD), ORIGINAL);
    ctx.git('add', 'lazy.toml', GUARD);
    ctx.git('commit', '-m', 'Protect the guard');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (supervisor-restores-rejected-files): a Reject is carried out by
  // lazy, before the agent's next turn, as lazy's own commit — the agent is told
  // what was restored, and its work window starts AFTER the restore, so the
  // restore is never attributed to it. Accept then names the restore, because
  // the merged tree is not the tree the agent first built.
  test('reject → unblock: file at base before the agent runs, restore commit is lazy\'s, prompt names it, accept notices', async () => {
    const shortId = await createTask(ctx, 'Touch the guard', 'Rewrite the guard');
    const taskId = findFullTaskId(ctx.root, shortId);
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'Rewrote it.', commit: { message: 'Rewrite guard', files: [{ path: GUARD, content: AGENT_EDIT }] } }),
        successScenario({ result: 'Nothing to add.' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', shortId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', shortId]));
    await waitFor('conflict', () => readTaskStatus(ctx.root, shortId) === 'conflict');

    // Reject on the web review page — the surface a person uses.
    const { base, fetch } = await signInToDashboard(ctx);
    const form = new FormData();
    form.set('file', GUARD);
    form.set('approved', '0');
    const decided = await fetch(`${base}/tasks/${taskId}/review/violation`, {
      method: 'POST', body: form, headers: { accept: 'application/json' },
    });
    expect(decided.status).toBe(200);

    const worktree = worktreePathFor(ctx.root, shortId);
    const baseSha = gitIn(ctx.root, 'rev-parse', 'main');
    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({
      result: 'Made the tree coherent.',
      commit: { message: 'Keep a feature', files: [{ path: 'feature.txt', content: 'kept\n' }] },
    }));
    const unblocked = await ctx.lazy(['unblock', shortId, '--message', 'Carry on', '--yes']);
    expectSuccess(unblocked);
    expect(unblocked.stdout + unblocked.stderr).toContain('Restoring 1 rejected protected file');
    expectSuccess(await ctx.lazy(['wait', shortId]));

    // The file is back at base, in a commit the supervisor made.
    expect(await readFile(join(worktree, GUARD), 'utf-8')).toBe(ORIGINAL);
    const restoreSha = gitIn(worktree, 'log', '-1', '--format=%H', '--author=Lazy Supervisor');
    expect(restoreSha).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(worktree, 'show', '--name-only', '--format=', restoreSha)).toBe(GUARD);
    expect(gitIn(worktree, 'show', `${restoreSha}:${GUARD}`)).toBe(gitIn(worktree, 'show', `${baseSha}:${GUARD}`));

    // BEFORE the agent: its commit sits on top of the restore, and the work
    // turn's window starts at the restore.
    gitIn(worktree, 'merge-base', '--is-ancestor', restoreSha, gitIn(worktree, 'log', '-1', '--format=%H', '--', 'feature.txt'));
    const work = readTurns(ctx.root, shortId).filter((t) => t.role === 'agent' && t.content.includes('Made the tree coherent'));
    expect(work.length).toBe(1);
    expect(work[0].start_sha_work).toBe(restoreSha);
    expect(work[0].violations).toEqual([
      expect.objectContaining({ file: GUARD, status: 'rejected', restore_sha: restoreSha }),
    ]);

    // The agent was told what lazy restored, and not asked to do it itself.
    const [first] = await ctx.claudeInvocations();
    const prompt = first.argv[first.argv.indexOf('-p') + 1];
    expect(prompt).toContain('REJECTED PROTECTED FILES RESTORED');
    expect(prompt).toContain(`- ${GUARD} (base: `);
    expect(prompt).toContain(restoreSha.substring(0, 8));
    expect(prompt).not.toContain('git checkout');
    expect(prompt).not.toContain('restore each one to its base version and commit');

    // Accept tells the reviewer the tree holds a lazy-made restore.
    await waitFor('parked', () => ['blocked', 'conflict'].includes(readTaskStatus(ctx.root, shortId) ?? ''));
    const accepted = await ctx.lazy(['accept', shortId, '--yes']);
    expectSuccess(accepted);
    const combined = accepted.stdout + accepted.stderr;
    expect(combined).toContain('reverted during this task');
    expect(combined).toContain(GUARD);
  }, 240_000);
});
