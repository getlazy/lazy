/**
 * `lazy system repair-commits` — the explicit repair for commit lists that a
 * historical range bug filled with an upstream branch's history.
 *
 * INVARIANTS this file encodes:
 *
 *   1. The command REPORTS by default and writes nothing. A store cleanup that
 *      happened as a side effect of looking would be exactly the silent
 *      rewrite this repair was asked not to be.
 *   2. `--apply` removes only records that are not on the task's branch, and
 *      leaves the task's own commits alone.
 *   3. `--apply` without a terminal needs `--yes`.
 *   4. The plan NAMES the records it would delete. Deleting stored history is
 *      the one irreversible thing here, and a count is not something a human
 *      can review.
 *   5. When the task's worktree is gone, the fallback ref only earns the right
 *      to delete for records it actually CONTAINS. A ref that is behind the
 *      real tip would otherwise classify every unpushed commit as foreign and
 *      delete it with nothing left to re-derive it from.
 *   6. `--json` puts JSON and nothing else on stdout, including under --apply.
 *   7. An EMPTY answer from the branch never authorises deleting every record.
 *      A git failure used to be indistinguishable from "this branch has no
 *      commits", which turned one unreadable branch into a wiped commit list.
 *   8. A record whose commit OBJECT is gone is unprovable, not foreign. That
 *      record may be the only surviving trace of the work.
 *   9. A worktree is only authoritative while it is ON the task's branch. One
 *      checked out elsewhere describes another branch's commits, which would
 *      make every genuine record look foreign.
 *  10. A colleague's commits, pushed to THIS task's branch and merged in by a
 *      sync, are the task's work even though the first-parent walk skips them.
 *      Deleting their records is destroying real history.
 *  11. The command NARRATES while it works — a sweep is hundreds of tasks and
 *      several git spawns each, and a silent command is indistinguishable from
 *      a hung one. Under --json that narration stays off stdout.
 *  12. The apply is handed the plan the human confirmed and re-plans only those
 *      tasks, instead of sweeping the whole store a second time. It still
 *      re-runs every refusal, so what it writes stays a subset of what was
 *      confirmed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { taskFilePath, readSessionJson, writeSessionJson } from '../helpers/storage';

interface StoredCommit {
  id: string;
  session_id: string;
  sha: string;
  message: string;
  status: string;
  timestamp: number;
}

function readCommits(root: string, taskId: string): StoredCommit[] {
  const file = taskFilePath(root, taskId, 'commits.json');
  return JSON.parse(readFileSync(file, 'utf-8')).commits ?? [];
}

function writeCommits(root: string, taskId: string, commits: StoredCommit[]): void {
  writeFileSync(taskFilePath(root, taskId, 'commits.json'), JSON.stringify({ commits }, null, 2));
}

describe('lazy system repair-commits', () => {
  let ctx: TestContext;
  let taskId: string;
  /** A commit on `main` that the task's branch never carried. */
  let foreignSha: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();

    taskId = await createTask(ctx, 'Repair commits test', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    // Somebody else's commit, on the default branch, after the task branched.
    writeFileSync(join(ctx.root, 'upstream.txt'), 'upstream work\n');
    expect(ctx.git('-C', ctx.root, 'add', 'upstream.txt').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'Somebody else work').exitCode).toBe(0);
    foreignSha = ctx.git('-C', ctx.root, 'rev-parse', 'HEAD').stdout.trim();

    // Seed the bug's result: that commit recorded against this task.
    const commits = readCommits(ctx.root, taskId);
    const sessionId = commits[0]?.session_id
      ?? JSON.parse(readFileSync(taskFilePath(ctx.root, taskId, 'session.json'), 'utf-8')).id;
    commits.push({
      id: 'seeded-foreign',
      session_id: sessionId,
      sha: foreignSha,
      message: 'Somebody else work',
      status: 'pending_review',
      timestamp: Date.now(),
    });
    writeCommits(ctx.root, taskId, commits);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports the foreign record and writes nothing without --apply', async () => {
    const before = readCommits(ctx.root, taskId).length;

    const result = await ctx.lazy(['system', 'repair-commits', taskId]);
    expectSuccess(result);
    expectOutput(result, '--apply');

    // INVARIANT 1: a report changes nothing.
    expect(readCommits(ctx.root, taskId).length).toBe(before);
  });

  test('--apply leaves exactly the commits the task branch carries', async () => {
    const session = JSON.parse(readFileSync(taskFilePath(ctx.root, taskId, 'session.json'), 'utf-8'));
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const onBranch = ctx
      .git('-C', worktree, 'rev-list', '--first-parent', `${session.git_start_sha}..HEAD`)
      .stdout.trim().split('\n').filter(Boolean);
    expect(onBranch.length).toBeGreaterThan(0);

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']);
    expectSuccess(result);

    // INVARIANT 2: the repaired list IS the branch — the foreign record is
    // gone and every commit the branch carries is there.
    const after = readCommits(ctx.root, taskId).map(c => c.sha);
    expect(after).not.toContain(foreignSha);
    expect(after.slice().sort()).toEqual(onBranch.slice().sort());
  });

  test('--apply refuses without --yes when there is no terminal', async () => {
    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--yes');
    expect(readCommits(ctx.root, taskId).map(c => c.sha)).toContain(foreignSha);
  });

  test('a task whose list already matches its branch reports nothing to repair', async () => {
    expectSuccess(await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']));

    const result = await ctx.lazy(['system', 'repair-commits', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Nothing to repair');
  });

  test('the plan names each record it would remove, not just a count', async () => {
    const result = await ctx.lazy(['system', 'repair-commits', taskId]);
    expectSuccess(result);

    // INVARIANT 4: the SHA and the subject, so the human approving the
    // deletion can see what they are approving.
    expect(result.stdout).toContain(foreignSha.substring(0, 8));
    expect(result.stdout).toContain('Somebody else work');
  });

  test('--json --apply --yes emits parseable JSON and nothing else', async () => {
    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--json', '--yes']);
    expectSuccess(result);

    // INVARIANT 6: a scripted repair has to be able to read its own output.
    const parsed = JSON.parse(result.stdout);
    expect(parsed.applied).toBe(true);
    expect(readCommits(ctx.root, taskId).map(c => c.sha)).not.toContain(foreignSha);
  });

  test('--json --apply without --yes refuses rather than prompting', async () => {
    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--json']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--yes');
    expect(readCommits(ctx.root, taskId).map(c => c.sha)).toContain(foreignSha);
  });

  test('a branch reporting no commits never authorises deleting the whole list', async () => {
    // Drive the scan to an empty answer the same way a failed read did: with
    // the range start AT the tip, there is nothing on the first-parent walk.
    // Every stored record is then "not on the branch" — and acting on that is
    // how an unreadable branch wiped a commit list.
    const session = readSessionJson(ctx.root, taskId)!;
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const tip = ctx.git('-C', worktree, 'rev-parse', 'HEAD').stdout.trim();
    writeSessionJson(ctx.root, taskId, { ...session, git_start_sha: tip });

    const before = readCommits(ctx.root, taskId).map(c => c.sha);
    expect(before.length).toBeGreaterThan(0);

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']);
    expectSuccess(result);

    // INVARIANT 7: reported and skipped, with every record intact.
    expectOutput(result, 'skipped');
    expect(readCommits(ctx.root, taskId).map(c => c.sha).sort()).toEqual(before.sort());
  });

  test('a record whose commit object is gone is never treated as foreign', async () => {
    // A commit that is no longer in the object database — unpushed work whose
    // branch was deleted and GC'd — is the case where the store record is the
    // ONLY surviving trace of it. The worktree is present here, so this is the
    // hole that the containment check alone did not close.
    const commits = readCommits(ctx.root, taskId);
    const missingSha = 'f'.repeat(40);
    commits.push({
      id: 'seeded-missing',
      session_id: commits[0].session_id,
      sha: missingSha,
      message: 'Work whose object is gone',
      status: 'pending_review',
      timestamp: Date.now(),
    });
    writeCommits(ctx.root, taskId, commits);

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']);
    expectSuccess(result);

    // INVARIANT 8: skipped, and BOTH records survive — including the foreign
    // one, because the task is skipped whole rather than half-repaired.
    expectOutput(result, 'skipped');
    const after = readCommits(ctx.root, taskId).map(c => c.sha);
    expect(after).toContain(missingSha);
    expect(after).toContain(foreignSha);
  });

  test('a worktree checked out on another branch is not treated as the task branch', async () => {
    // INVARIANT 9: the worktree is authoritative only while it is on the task's
    // branch. Checked out elsewhere, the first-parent walk from the branch
    // point answers with THAT branch's commits, so every genuine record lands
    // in `remove` — and the worktree source also skips the containment test,
    // so nothing downstream would catch it. A mismatch must fall back to the
    // branch ref, not merely be relabelled: it is the TIP that decides what
    // the walk returns.
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);

    // First put the store in its CORRECT state, so there is genuine history to
    // lose. Without this the task has only the seeded foreign record and the
    // assertion below is vacuous.
    expectSuccess(await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']));
    const genuine = readCommits(ctx.root, taskId).map(c => c.sha);
    expect(genuine.length).toBeGreaterThan(0);
    expect(genuine).not.toContain(foreignSha);

    // Now send the worktree off to a branch built on the default branch, whose
    // first-parent walk shares none of this task's commits.
    expect(ctx.git('-C', worktree, 'checkout', '-q', '-b', 'somewhere-else', 'main').exitCode).toBe(0);

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']);
    expectSuccess(result);

    // Every genuine record survives: reading the branch REF instead of the
    // wandering worktree is what keeps them.
    const after = readCommits(ctx.root, taskId).map(c => c.sha);
    for (const sha of genuine) {
      expect(after).toContain(sha);
    }
  });

  test("a colleague's commits merged into this task's branch are not deleted", async () => {
    // INVARIANT 10: sync step 1 merges `origin/<task-branch>` with --no-ff when
    // somebody else pushed to this task's branch. Their commits land on the
    // merge's SECOND parent, so the first-parent walk never records them — and
    // reading that as "foreign" would delete correct records for work that
    // really is this task's. Told apart structurally: for that merge the first
    // parent is an ancestor of the second (origin was simply ahead), which is
    // never true of the divergent parent-branch merge.
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const session = readSessionJson(ctx.root, taskId)!;
    const g = (...args: string[]) => {
      const r = ctx.git('-C', worktree, ...args);
      expect(r.exitCode).toBe(0);
      return r.stdout.trim();
    };

    // Somebody else's commit, built on top of this branch's current tip.
    g('checkout', '-q', '-b', 'colleague');
    writeFileSync(join(worktree, 'colleague.txt'), 'their work\n');
    g('add', '.');
    g('commit', '-m', 'Colleague work on this task branch');
    const colleagueSha = g('rev-parse', 'HEAD');

    // The sync-step-1 shape: --no-ff merge of a branch that is simply ahead.
    g('checkout', '-q', session.git_branch);
    g('merge', '--no-ff', '-m', 'Merge origin/task-branch', 'colleague');

    // Their commit is recorded, correctly, as this task's work.
    const commits = readCommits(ctx.root, taskId);
    commits.push({
      id: 'seeded-colleague',
      session_id: commits[0].session_id,
      sha: colleagueSha,
      message: 'Colleague work on this task branch',
      status: 'pending_review',
      timestamp: Date.now(),
    });
    writeCommits(ctx.root, taskId, commits);

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']);
    expectSuccess(result);

    // Their record survives; the genuinely foreign one still goes.
    const after = readCommits(ctx.root, taskId).map(c => c.sha);
    expect(after).toContain(colleagueSha);
    expect(after).not.toContain(foreignSha);
  });

  test('--json --apply still reports a task it refused to repair', async () => {
    // INVARIANT 6 again: the apply only re-plans the tasks the human confirmed,
    // and a refused task is never among them — so the reported result has to
    // carry the plan's entry for it. Without that, a scripted repair cannot
    // tell "nothing was wrong" from "this task was refused, and here is why".
    rmSync(join(ctx.root, '.lazy', 'worktrees', taskId), { recursive: true, force: true });

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--json', '--yes']);
    expectSuccess(result);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.applied).toBe(true);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].skipped).toBeTruthy();
    expect(readCommits(ctx.root, taskId).map(c => c.sha)).toContain(foreignSha);
  });

  test('narrates the scan instead of running silent', async () => {
    // INVARIANT 11: a sweep is hundreds of tasks and several git spawns each.
    // A human-facing command that prints nothing while it works is
    // indistinguishable from one that has hung.
    const result = await ctx.lazy(['system', 'repair-commits', '--all']);
    expectSuccess(result);

    expectOutput(result, 'Scan recorded commit lists');
    expect(result.stdout).toContain('[1/');
  });

  test('--json keeps the narration off stdout', async () => {
    // INVARIANT 6 again, now that the command narrates: stdout is the payload.
    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--json', '--yes']);
    expectSuccess(result);
    JSON.parse(result.stdout);
    expect(result.stderr).toContain('Scan recorded commit lists');
  });

  test('the apply re-plans only the tasks the human confirmed', async () => {
    // INVARIANT 12: the apply is handed the plan it is applying. It re-plans
    // those tasks (so every refusal runs again) rather than sweeping the whole
    // store a second time — which on a real store doubled the work, silently.
    const other = await createTask(ctx, 'Other task', 'Nothing wrong here');
    expectSuccess(await ctx.lazyMocked(['start', other, '--yes'], MOCK_CLAUDE_SUCCESS));

    // Put the whole store in its correct state first, so the run under test has
    // exactly one task to repair out of two.
    expectSuccess(await ctx.lazy(['system', 'repair-commits', '--all', '--apply', '--yes']));
    const commits = readCommits(ctx.root, taskId);
    commits.push({
      id: 'seeded-foreign-again',
      session_id: commits[0].session_id,
      sha: foreignSha,
      message: 'Somebody else work',
      status: 'pending_review',
      timestamp: Date.now(),
    });
    writeCommits(ctx.root, taskId, commits);

    const result = await ctx.lazy(['system', 'repair-commits', '--all', '--apply', '--yes']);
    expectSuccess(result);

    // The first pass scans both tasks; the second scans only the one with
    // something to repair.
    const scanned = [...result.stdout.matchAll(/\((\d+) task\(s\)\)…/g)].map(m => Number(m[1]));
    expect(scanned).toEqual([2, 1]);

    expect(readCommits(ctx.root, taskId).map(c => c.sha)).not.toContain(foreignSha);
  });

  test('with the worktree gone, a ref that does not contain a record will not delete it', async () => {
    // The worktree is the only view that is the branch's real tip by
    // definition. Without it the command falls back to the branch ref — and
    // here that ref cannot account for the foreign record (it was never on
    // this branch), which is indistinguishable from a ref sitting behind an
    // unpushed tip. So it must decline.
    rmSync(join(ctx.root, '.lazy', 'worktrees', taskId), { recursive: true, force: true });

    const result = await ctx.lazy(['system', 'repair-commits', taskId, '--apply', '--yes']);
    expectSuccess(result);

    // INVARIANT 5: reported and skipped, never guessed at — and above all,
    // the records are still there.
    expectOutput(result, 'skipped');
    expect(readCommits(ctx.root, taskId).map(c => c.sha)).toContain(foreignSha);
  });
});
