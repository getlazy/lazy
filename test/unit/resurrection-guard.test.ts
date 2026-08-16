/**
 * Unit tests for the deleted-file resurrection guard
 * (src/protection/resurrection-guard.ts).
 *
 * These build REAL git repositories rather than mocking git: the whole guard is
 * a claim about what git's 3-way merge does with a particular history shape, and
 * a mocked `git` would only ever confirm the author's model of it. Every
 * scenario that asserts a resurrection also asserts that the squash merge really
 * does re-add the file, so the fixture can never drift away from the defect.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectResurrections,
  enforceResurrectionGuard,
  ResurrectionRefusedError,
  resurrectionRefusalMessage,
  stackedChildAdvisory,
} from '../../src/protection/resurrection-guard';
import { runGit } from '../../src/utils/git';

let repo: string;

async function git(...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd: repo });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

async function commit(message: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await git('rm', '-q', path);
    } else {
      const full = join(repo, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content);
      await git('add', path);
    }
  }
  await git('commit', '-q', '-m', message);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'lazy-resurrect-'));
  await git('init', '-q', '-b', 'main', '.');
  await git('config', 'user.email', 'test@lazy.local');
  await git('config', 'user.name', 'Lazy Test');
  await commit('root', { 'README.md': 'root\n' });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/**
 * The exact topology from docs/spikes/v012-release-resurrection-audit.md:
 *
 *   main ── root ── "Release v011" (SQUASH of v011) ── "delete sse.ts"
 *              \
 *               v011 ── (adds sse.ts) ── v012 ── (own work) ── Merge main
 *
 * v011's ORIGINAL commits are not ancestors of main, so merge-base(main, v012)
 * predates them and sse.ts has no version there.
 */
async function buildStaleBaseHub(): Promise<void> {
  await git('checkout', '-q', '-b', 'v011');
  await commit('v011: add sse.ts', { 'src/sse.ts': 'export const sse = 1;\n' });

  await git('checkout', '-q', '-b', 'v012');
  await commit('v012: own work', { 'src/v012.ts': 'export const v = 12;\n' });

  await git('checkout', '-q', 'main');
  await runGit(['merge', '--squash', 'v011'], { cwd: repo });
  await git('commit', '-q', '-m', 'Release v011 (squash)');
  await commit('Remove dead SSE module', { 'src/sse.ts': null });

  await git('checkout', '-q', 'v012');
  await git('merge', '-q', '--no-edit', 'main');
}

describe('detectResurrections', () => {
  test('flags a file the target deleted that a stale-based hub carries back', async () => {
    await buildStaleBaseHub();

    const { resurrections, candidatesCapped } = await detectResurrections({
      projectRoot: repo, sourceBranch: 'v012', targetBranch: 'main',
    });

    expect(candidatesCapped).toBe(false);
    expect(resurrections.map(r => r.path)).toEqual(['src/sse.ts']);
    expect(resurrections[0]!.deletedBy.subject).toBe('Remove dead SSE module');
    expect(resurrections[0]!.deletedBy.sha).toMatch(/^[0-9a-f]{8}$/);
    expect(resurrections[0]!.deletedBy.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The fixture is only worth anything if the merge it describes really would
  // re-add the file. Assert that directly, so a fixture that stops reproducing
  // the defect fails loudly instead of quietly testing nothing.
  test('the squash merge the guard blocks really does re-add the file', async () => {
    await buildStaleBaseHub();
    await git('checkout', '-q', 'main');
    await runGit(['merge', '--squash', 'v012'], { cwd: repo });
    const staged = await git('diff', '--cached', '--name-status');
    expect(staged).toContain('A\tsrc/sse.ts');
  });

  test('says nothing about a branch that only adds new files', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await commit('feature work', { 'src/feature.ts': 'export const f = 1;\n' });

    const { resurrections } = await detectResurrections({
      projectRoot: repo, sourceBranch: 'feature', targetBranch: 'main',
    });
    expect(resurrections).toEqual([]);
  });

  // INVARIANT: the guard must not fire on ordinary staleness. A branch that
  // simply predates a deletion on main has a version of the file AT THE MERGE
  // BASE, so git resolves the deletion correctly on its own. Flagging it would
  // make the guard fire on routine work and train everyone to approve blindly.
  test('does NOT flag an ordinary stale branch, whose merge base has the file', async () => {
    await commit('add doomed.ts', { 'src/doomed.ts': 'export const d = 1;\n' });
    await git('checkout', '-q', '-b', 'ordinary');
    await commit('unrelated work', { 'src/other.ts': 'export const o = 1;\n' });

    await git('checkout', '-q', 'main');
    await commit('delete doomed.ts', { 'src/doomed.ts': null });

    const { resurrections } = await detectResurrections({
      projectRoot: repo, sourceBranch: 'ordinary', targetBranch: 'main',
    });
    expect(resurrections).toEqual([]);

    // And prove why it is safe to stay quiet: the merge deletes the file itself.
    await runGit(['merge', '--squash', 'ordinary'], { cwd: repo });
    const staged = await git('diff', '--cached', '--name-status');
    expect(staged).not.toContain('src/doomed.ts');
  });

  test('does not flag a path the target deleted and then re-added itself', async () => {
    await buildStaleBaseHub();
    await git('checkout', '-q', 'main');
    await commit('Bring sse.ts back on main', { 'src/sse.ts': 'export const sse = 2;\n' });

    const { resurrections } = await detectResurrections({
      projectRoot: repo, sourceBranch: 'v012', targetBranch: 'main',
    });
    expect(resurrections).toEqual([]);
  });

  test('reports the newest deletion when a path was deleted more than once', async () => {
    await buildStaleBaseHub();
    await git('checkout', '-q', 'main');
    await commit('re-add sse.ts by mistake', { 'src/sse.ts': 'export const sse = 9;\n' });
    await commit('delete sse.ts for good', { 'src/sse.ts': null });

    const { resurrections } = await detectResurrections({
      projectRoot: repo, sourceBranch: 'v012', targetBranch: 'main',
    });
    expect(resurrections.map(r => r.path)).toEqual(['src/sse.ts']);
    expect(resurrections[0]!.deletedBy.subject).toBe('delete sse.ts for good');
  });

  test('surfaces git failures instead of reporting a clean branch', async () => {
    await expect(detectResurrections({
      projectRoot: repo, sourceBranch: 'no-such-branch', targetBranch: 'main',
    })).rejects.toThrow(/resurrection guard/);
  });
});

describe('enforceResurrectionGuard', () => {
  test('refuses, naming the file, the deleting commit and the approve command', async () => {
    await buildStaleBaseHub();

    let err: unknown;
    try {
      await enforceResurrectionGuard({
        projectRoot: repo, sourceBranch: 'v012', targetBranch: 'main', displayId: 'abc12345',
      });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(ResurrectionRefusedError);
    const message = (err as Error).message;
    expect(message).toContain('src/sse.ts');
    expect(message).toContain('Remove dead SSE module');
    expect(message).toContain('lazy accept abc12345 --approve-file src/sse.ts');
  });

  test('passes when every resurrected path is approved, and says so', async () => {
    await buildStaleBaseHub();

    const result = await enforceResurrectionGuard({
      projectRoot: repo, sourceBranch: 'v012', targetBranch: 'main', displayId: 'abc12345',
      approvedFiles: ['src/sse.ts'],
    });
    expect(result.approved.map(r => r.path)).toEqual(['src/sse.ts']);
    expect(result.warnings.join(' ')).toContain('src/sse.ts');
  });

  test('a partial approval still refuses, listing only what is unapproved', async () => {
    await git('checkout', '-q', '-b', 'v011');
    await commit('v011', { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    await git('checkout', '-q', '-b', 'v012');
    await commit('v012 work', { 'src/v012.ts': 'v\n' });
    await git('checkout', '-q', 'main');
    await runGit(['merge', '--squash', 'v011'], { cwd: repo });
    await git('commit', '-q', '-m', 'Release v011 (squash)');
    await commit('drop a and b', { 'src/a.ts': null, 'src/b.ts': null });
    await git('checkout', '-q', 'v012');
    await git('merge', '-q', '--no-edit', 'main');

    let err: unknown;
    try {
      await enforceResurrectionGuard({
        projectRoot: repo, sourceBranch: 'v012', targetBranch: 'main', displayId: 'abc12345',
        approvedFiles: ['src/a.ts'],
      });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(ResurrectionRefusedError);
    expect((err as ResurrectionRefusedError).resurrections.map(r => r.path)).toEqual(['src/b.ts']);
    expect((err as Error).message).not.toContain('src/a.ts\n');
  });

  test('is a no-op on a clean branch', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await commit('feature work', { 'src/feature.ts': 'f\n' });

    const result = await enforceResurrectionGuard({
      projectRoot: repo, sourceBranch: 'feature', targetBranch: 'main', displayId: 'abc12345',
    });
    expect(result.approved).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('message helpers', () => {
  test('the refusal explains the mechanism, not just the symptom', () => {
    const msg = resurrectionRefusalMessage('t1', 'lazy/hub', 'main', [
      { path: 'x.ts', deletedBy: { sha: 'deadbeef', subject: 'drop x', date: '2026-04-12' } },
    ]);
    expect(msg).toContain('merge base');
    expect(msg).toContain('no conflict');
    expect(msg).toContain('docs/spikes/v012-release-resurrection-audit.md');
  });

  test('the stacked-child advisory names sync and stays quiet with no children', () => {
    expect(stackedChildAdvisory(0, 'main')).toBeNull();
    const advice = stackedChildAdvisory(2, 'main')!;
    expect(advice).toContain('lazy sync');
    expect(advice).toContain('merge base');
  });
});
