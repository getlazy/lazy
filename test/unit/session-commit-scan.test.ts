/**
 * Unit tests for which commits a task RECORDS (src/task/session-commits.ts).
 *
 * INVARIANTS this file encodes:
 *
 *   1. A merge records the MERGE COMMIT only, never the merged-in branch's
 *      history. `<base>..HEAD` is a reachability query: the first time a task
 *      merged its upstream, it recorded every commit that upstream carried.
 *      That is how cluster tasks ended up with ~780 records — back to a release
 *      from four months earlier — for branches carrying fewer than 30 commits.
 *   2. The range ALWAYS starts at the branch point, never at a previously
 *      recorded commit. The old code used the LAST element of the stored list
 *      as "last known SHA", but the store sorts by write time while `git log`
 *      answers newest-first, so that element was the OLDEST commit of the last
 *      batch. Each turn's start walked further back into a merged-in line and
 *      the next turn's range was wider still — the bug compounded.
 *   3. Records are written OLDEST-first, so stored order is history order.
 *   4. A branch point that is not an ancestor of the tip degrades to the merge
 *      base rather than to a range that spans unrelated history.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import type { Storage } from '../../src/storage';
import type { Commit } from '../../src/types';
import { scanSessionCommits, recordSessionCommits } from '../../src/task/session-commits';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(cwd, file), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * The store's commit list, with the ORDERING the real FileStorage has: sorted
 * by the time each record was written, ties kept in insertion order.
 */
function fakeStorage(seed: Commit[] = []): { storage: Storage; commits: Commit[] } {
  const commits = [...seed];
  const storage = {
    async getSessionCommits(): Promise<Commit[]> {
      return [...commits].sort((a, b) => a.timestamp - b.timestamp);
    },
    async createCommit(sessionId: string, sha: string, message: string): Promise<Commit> {
      const existing = commits.find(c => c.sha === sha);
      if (existing) return existing;
      const record: Commit = {
        id: `c${commits.length}`,
        session_id: sessionId,
        sha,
        message,
        status: 'pending_review',
        timestamp: Date.now() + commits.length,
      };
      commits.push(record);
      return record;
    },
  } as unknown as Storage;
  return { storage, commits };
}

describe('session commit scan', () => {
  let root: string;
  let repo: string;
  /** The commit the task branch was cut from. */
  let branchPoint: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-commit-scan-'));
    repo = join(root, 'repo');
    await runGit(['init', '-q', '-b', 'main', repo], { cwd: root });
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');

    await commit(repo, 'base.txt', 'base\n', 'base');
    branchPoint = await commit(repo, 'base.txt', 'base2\n', 'upstream: before the branch');
    await git(repo, 'checkout', '-q', '-b', 'lazy/task');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Upstream moves on `main` while the task works, then the task merges it. */
  async function upstreamMovesAndTaskMerges(count: number): Promise<string[]> {
    const upstream: string[] = [];
    await git(repo, 'checkout', '-q', 'main');
    for (let i = 0; i < count; i++) {
      upstream.push(await commit(repo, `up${i}.txt`, `${i}\n`, `upstream: change ${i}`));
    }
    await git(repo, 'checkout', '-q', 'lazy/task');
    await git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge main', 'main');
    return upstream;
  }

  test('a merge records the merge commit, never the merged-in history', async () => {
    const own = await commit(repo, 'task.txt', 'work\n', 'task: real work');
    const upstream = await upstreamMovesAndTaskMerges(3);
    const mergeSha = await git(repo, 'rev-parse', 'HEAD');

    const { storage } = fakeStorage();
    const scan = await scanSessionCommits(storage, { id: 's1', git_start_sha: branchPoint }, repo);

    // INVARIANT 1: the task's own commit plus the merge commit — and nothing
    // the merged-in branch brought with it.
    expect(scan.commits.map(c => c.sha)).toEqual([own, mergeSha]);
    for (const sha of upstream) {
      expect(scan.commits.some(c => c.sha === sha)).toBe(false);
    }
  });

  test('the range starts at the branch point, not at the last stored record', async () => {
    await commit(repo, 'task.txt', 'work\n', 'task: real work');
    const upstream = await upstreamMovesAndTaskMerges(3);

    // The shape the old bug left behind: an ancient upstream commit recorded
    // LAST, which the previous code would have used as the next range start.
    const { storage } = fakeStorage([{
      id: 'stale',
      session_id: 's1',
      sha: upstream[0],
      message: 'upstream: change 0',
      status: 'pending_review',
      timestamp: Date.now() + 10_000,
    }]);

    const scan = await scanSessionCommits(storage, { id: 's1', git_start_sha: branchPoint }, repo);

    // INVARIANT 2: the stale record neither widens the range nor narrows it —
    // the answer is still exactly what the branch carries.
    expect(scan.all.length).toBe(2);
    expect(scan.base).toBe(branchPoint);
  });

  test('records are written oldest-first and recording twice adds nothing', async () => {
    const own = await commit(repo, 'task.txt', 'work\n', 'task: real work');
    await upstreamMovesAndTaskMerges(2);
    const mergeSha = await git(repo, 'rev-parse', 'HEAD');

    const { storage, commits } = fakeStorage();
    await recordSessionCommits(storage, { id: 's1', git_start_sha: branchPoint }, repo, 'test');

    // INVARIANT 3: insertion order is history order.
    expect(commits.map(c => c.sha)).toEqual([own, mergeSha]);

    await recordSessionCommits(storage, { id: 's1', git_start_sha: branchPoint }, repo, 'test');
    expect(commits.length).toBe(2);
  });

  test('a branch point that is not an ancestor of the tip falls back to the merge base', async () => {
    const own = await commit(repo, 'task.txt', 'work\n', 'task: real work');

    // A branch point on a line the task branch never contained.
    await git(repo, 'checkout', '-q', '-b', 'sideline', 'main');
    const sideline = await commit(repo, 'side.txt', 'side\n', 'sideline: unrelated');
    await git(repo, 'checkout', '-q', 'lazy/task');

    const { storage } = fakeStorage();
    const scan = await scanSessionCommits(storage, { id: 's1', git_start_sha: sideline }, repo);

    // INVARIANT 4: the merge base is an ancestor by construction, so the range
    // is bounded; the sideline commit is never recorded as this task's work.
    expect(scan.base).toBe(branchPoint);
    expect(scan.commits.map(c => c.sha)).toEqual([own]);
  });

  test('no branch point means no guess — nothing is recorded', async () => {
    await commit(repo, 'task.txt', 'work\n', 'task: real work');

    const { storage, commits } = fakeStorage();
    const scan = await recordSessionCommits(storage, { id: 's1', git_start_sha: '' }, repo, 'test');

    expect(scan.base).toBeNull();
    expect(scan.reason).toContain('no branch-point SHA');
    expect(commits.length).toBe(0);
  });
});

describe('every getNewCommits caller asks for the first-parent walk', () => {
  test('no call site in src/ omits firstParent', async () => {
    // INVARIANT: every `getNewCommits` call in src/ passes `firstParent: true`.
    // The flag is opt-IN, so the default is the reachability query that caused
    // this whole incident, and the failure is silent — a call site reads fine
    // and reports a months-old upstream as the task's own work. This guard is
    // mechanical because that is exactly how it spread: the recording paths
    // were fixed while the accept gate's "stale by N commits" kept the bare
    // call, unnoticed, because nothing about it looks wrong in review.
    const { readdir, readFile } = await import('fs/promises');
    const { join: joinPath } = await import('path');

    const srcRoot = joinPath(import.meta.dir, '../../src');

    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    }

    const offenders: string[] = [];
    for (const file of await walk(srcRoot)) {
      // The declaration itself lives here, and is the one place the option is
      // read rather than passed.
      if (file.endsWith(joinPath('src', 'git', 'operations.ts'))) continue;

      const source = stripComments(await readFile(file, 'utf-8'));
      for (const call of callsTo('getNewCommits', source)) {
        if (!call.includes('firstParent')) {
          offenders.push(`${file.slice(srcRoot.length + 1)}: getNewCommits(${collapse(call)})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('countNewCommits walks first-parent in its own implementation', async () => {
    // INVARIANT: the COUNTING twin of the walk above is first-parent too.
    // `countNewCommits` answers the same question as `getNewCommits` — what
    // has this branch done since X — so a bare `rev-list --count` reports
    // every commit of every merged-in line as work done this turn. The live
    // progress readout had exactly that, and the call-site guard above could
    // not see it: this function takes no options, so there is no flag at a
    // call site to check and the walk is a property of the implementation.
    const { readFile } = await import('fs/promises');
    const { join: joinPath } = await import('path');

    const source = stripComments(
      await readFile(joinPath(import.meta.dir, '../../src/git/operations.ts'), 'utf-8'),
    );

    const body = source.slice(source.indexOf('export async function countNewCommits'));
    const revList = callsTo('runGit', body)[0];
    expect(revList).toBeDefined();
    expect(collapse(revList!)).toContain('--first-parent');
  });
});

/** Drop comments so a commented-out or merely DESCRIBED call is not a finding. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The full argument text of every call to `name`, parens balanced.
 *
 * Reading one LINE is what the old version of this guard did, and it had the
 * defect it exists to catch: a call broken across lines puts `name(` on one
 * line and its options object on another, so the flag looked absent on the
 * first line and the whole call was never checked against. Several call sites
 * in this codebase are formatted exactly that way.
 */
function callsTo(name: string, source: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`(^|[^\\w.$])${name}\\s*\\(`, 'g');

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    // `function getNewCommits(` is the declaration, not a call.
    const before = source.slice(0, match.index + match[1].length);
    if (/\b(function|async function)\s*$/.test(before)) continue;

    const open = source.indexOf('(', match.index + match[1].length);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue; // unbalanced — nothing honest to say about it
    calls.push(source.slice(open + 1, end));
  }
  return calls;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
