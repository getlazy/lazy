import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { outstandingFromDetection } from '../../src/protection/outstanding';
import { violationDecisionOf } from '../../src/protection/rejected-files';
import {
  applyProtectedRestores,
  assertRestorePlanShape,
  buildRestoredProtectedFilesNotice,
  planRejectedRestores,
  restoredViolationRecords,
  RESTORE_COMMIT_AUTHOR,
} from '../../src/protection/rejected-restore';
import { revertedProtectedFiles } from '../../src/protection/reverted-files';
import { runGit } from '../../src/utils/git';
import type { FileViolation, Turn } from '../../src/types';

function turn(violations: FileViolation[], sequence = 1): Turn {
  return {
    id: `t${sequence}`, session_id: 's1', sequence, role: 'agent', content: '', timestamp: 1,
    usage: null, start_sha: null, start_sha_work: null, end_sha_work: null, end_sha: null,
    violations,
  } as Turn;
}

describe('what Reject on a protected file means', () => {
  test('the three decisions a reviewer sees', () => {
    expect(violationDecisionOf({ status: 'pending' })).toBe('undecided');
    expect(violationDecisionOf({ status: 'pending', rejected_at: 5 })).toBe('rejected');
    expect(violationDecisionOf({ status: 'approved' })).toBe('approved');
    expect(violationDecisionOf({ status: 'rejected' })).toBe('rejected');
  });

  // INVARIANT: a rejection survives re-detection as an OUTSTANDING file — it
  // stays pending (accept refuses) and keeps its rejected_at (the next unblock
  // restores it). Dropping either would make Reject mean nothing.
  test('re-detection keeps a rejected file outstanding and still rejected', () => {
    const detected: FileViolation[] = [
      { file: 'a.ts', base_sha: 'b1', status: 'pending' },
      { file: 'b.ts', base_sha: 'b2', status: 'pending' },
    ];
    const out = outstandingFromDetection(detected, [
      turn([{ file: 'a.ts', base_sha: 'b1', status: 'pending', rejected_at: 9 }]),
    ]);
    expect(out).toEqual([
      { file: 'a.ts', base_sha: 'b1', status: 'pending', rejected_at: 9 },
      { file: 'b.ts', base_sha: 'b2', status: 'pending' },
    ]);
  });
});

describe('planning the restore', () => {
  test('plans only rejected files, sorted, each with its base', () => {
    expect(planRejectedRestores([
      { file: 'z.ts', base_sha: 'bz', status: 'pending', rejected_at: 1 },
      { file: 'undecided.ts', base_sha: 'bu', status: 'pending' },
      { file: 'a.ts', base_sha: 'ba', status: 'pending', rejected_at: 2 },
    ])).toEqual([{ file: 'a.ts', base_sha: 'ba' }, { file: 'z.ts', base_sha: 'bz' }]);
    expect(planRejectedRestores([{ file: 'u', base_sha: 'b', status: 'pending' }])).toEqual([]);
  });

  // INVARIANT: the plan crosses the container-writable protocol dir, so an
  // entry that is not a plain in-worktree path at a commit SHA is refused
  // before git sees it.
  test('refuses entries git could read as something other than one path', () => {
    const sha = 'a'.repeat(40);
    for (const file of ['-rf', '/etc/passwd', '../x', 'a/../../x', '']) {
      expect(() => assertRestorePlanShape([{ file, base_sha: sha }])).toThrow();
    }
    expect(() => assertRestorePlanShape([{ file: 'ok.ts', base_sha: 'HEAD~1' }])).toThrow();
    expect(() => assertRestorePlanShape([{ file: 'dir/ok.ts', base_sha: sha }])).not.toThrow();
  });

  test('the agent is told what lazy restored, and a failed restore is never presented as done', () => {
    const notice = buildRestoredProtectedFilesNotice([
      { file: 'a.ts', base_sha: 'ba', commit_sha: 'c0ffee1234' },
    ]);
    expect(notice).toContain('lazy restored each one');
    expect(notice).toContain('- a.ts (base: ba, restore commit: c0ffee12)');
    expect(notice).toContain('make the rest of the tree coherent');
    expect(notice).not.toContain('git checkout');
    const failed = buildRestoredProtectedFilesNotice([], { plan: [{ file: 'b.ts', base_sha: 'bb' }], error: 'boom' });
    expect(failed).toContain('could NOT restore');
    expect(failed).toContain('- b.ts (base: bb)');
    expect(buildRestoredProtectedFilesNotice([])).toBe('');
  });
});

// INVARIANT (supervisor-restores-rejected-files): once lazy restored a file, the
// record says so — `rejected` + `restored_*` — which is what accept's notice
// reads, and what takes the file out of every "undecided" count. A re-edit in a
// later record is a NEW pending question and wins.
describe('recording the restore', () => {
  test('restored records drive the accept notice until a later re-edit supersedes them', () => {
    const restored = restoredViolationRecords([{ file: 'a.ts', base_sha: 'ba', commit_sha: 'c1' }], 42);
    expect(restored).toEqual([{ file: 'a.ts', base_sha: 'ba', status: 'rejected', restored_at: 42, restore_sha: 'c1' }]);
    expect(revertedProtectedFiles([turn(restored, 1)])).toEqual(['a.ts']);
    const reEdited = [turn(restored, 1), turn([{ file: 'a.ts', base_sha: 'ba', status: 'pending' }], 2)];
    expect(revertedProtectedFiles(reEdited)).toEqual([]);
    expect(outstandingFromDetection([{ file: 'a.ts', base_sha: 'ba', status: 'pending' }], reEdited))
      .toEqual([{ file: 'a.ts', base_sha: 'ba', status: 'pending' }]);
  });
});

describe('applying the restore', () => {
  let dir: string;
  let base: string;
  const git = async (...args: string[]) => {
    const r = await runGit(args, { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-restore-')));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 'T');
    await writeFile(join(dir, 'keep.md'), 'original\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'base');
    base = await git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'keep.md'), 'agent edit\n');
    await writeFile(join(dir, 'new.md'), 'agent created\n');
    await writeFile(join(dir, 'other.ts'), 'unrelated agent work\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'agent');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('checks out files that existed at base, removes ones that did not, commits only those as lazy', async () => {
    const sha = await applyProtectedRestores(dir, [
      { file: 'keep.md', base_sha: base },
      { file: 'new.md', base_sha: base },
    ]);
    expect(sha).toBe(await git('rev-parse', 'HEAD'));
    expect(await readFile(join(dir, 'keep.md'), 'utf8')).toBe('original\n');
    expect(await git('ls-files', 'new.md')).toBe('');
    expect(await readFile(join(dir, 'other.ts'), 'utf8')).toBe('unrelated agent work\n');
    expect(await git('log', '-1', '--format=%an <%ae>')).toBe(RESTORE_COMMIT_AUTHOR);
    expect((await git('show', '--name-only', '--format=', 'HEAD')).split('\n').sort()).toEqual(['keep.md', 'new.md']);
  });

  test('nothing to commit when the files already match their base', async () => {
    await applyProtectedRestores(dir, [{ file: 'keep.md', base_sha: base }]);
    const head = await git('rev-parse', 'HEAD');
    expect(await applyProtectedRestores(dir, [{ file: 'keep.md', base_sha: base }])).toBeNull();
    expect(await git('rev-parse', 'HEAD')).toBe(head);
  });
});

// INVARIANT (supervisor-restores-rejected-files): every path that launches an
// UNBLOCK hands the supervisor the restore plan — a person's
// (launchUnblockTaskRun) and the daemon's own (autoUnblockTask: auto-review fix
// feedback, CI results, forge comments). A path that forgot would leave a
// Rejected file in place while the page says the next unblock restores it.
// Scanned like cluster-type-constraints, because the daemon path cannot run in
// a unit test without a runner.
describe('every unblock launch path carries the restore plan', () => {
  for (const file of ['src/daemon/task-lifecycle.ts', 'src/daemon/auto-deliver.ts']) {
    test(file, async () => {
      const src = await Bun.file(new URL(`../../${file}`, import.meta.url)).text();
      expect(src).toContain('planRejectedRestores(');
      expect(src).toContain('restore_rejected_files: restoreRejectedFiles');
    });
  }
});

// INVARIANT (supervisor-restores-rejected-files): the dashboard's Current review
// names a file lazy restored — it is out of the diff, and the reviewer must
// know the tree being accepted holds lazy's own restore commit.
describe('the dashboard names restored files beside accept', () => {
  test('lists each restored file, escaped, and says nothing when none', async () => {
    const { restoredProtectedFilesHtml } = await import('../../src/server/current-review');
    const html = restoredProtectedFilesHtml(['a<b>.md']);
    expect(html).toContain('id="restored-protected-files"');
    expect(html).toContain('<code>a&lt;b&gt;.md</code>');
    expect(html).toContain("lazy's own restore commit");
    expect(restoredProtectedFilesHtml([])).toBe('');
  });
});
