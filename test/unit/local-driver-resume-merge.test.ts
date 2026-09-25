import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalDriver } from '../../src/remote/local-driver';

/**
 * The local squash on a RESUMED accept is idempotent; on a fresh accept it is not.
 *
 * Field incident (2026-09-08): an accept squashed a task onto its parent and
 * died before the store recorded it. The re-run squash found nothing to commit
 * and refused, so merged work sat on a task that could never be accepted.
 */

let root: string;

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function commitFile(name: string, content: string, message: string): Promise<void> {
  await writeFile(join(root, name), content);
  git('add', name);
  git('commit', '-m', message);
}

const task = { id: 'task-1', goal: 'Add feature' } as any;
const mergeOpts = (resume?: boolean) => ({
  sourceBranch: 'lazy/child', targetBranch: 'lazy/parent', task, taskShortId: 'child', root, ...(resume ? { resume } : {}),
});

describe('LocalDriver.merge on resume', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-resume-merge-')));
    git('init', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    await commitFile('base.txt', 'base\n', 'base');
    git('branch', 'lazy/parent');
    git('checkout', '-b', 'lazy/child');
    await commitFile('feature.txt', 'feature\n', 'feature');
    // The merge runs from wherever the project root sits; park it on main so
    // the parent is not checked out here (the Case-2 separate-worktree path is
    // not the subject).
    git('checkout', 'main');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a resumed accept whose squash already landed answers `merged`
  // (alreadyLanded) instead of refusing — the earlier merge IS the accept.
  test('a squash that already landed is recognised, even after another accept landed in between', async () => {
    const driver = new LocalDriver();
    expect((await driver.merge(mergeOpts())).status).toBe('merged');
    const afterFirst = git('rev-parse', 'lazy/parent');

    // An unrelated accept lands into the same parent between the crash and the resume.
    git('checkout', 'lazy/parent');
    await commitFile('other.txt', 'other\n', 'other accept');
    git('checkout', 'main');
    const beforeResume = git('rev-parse', 'lazy/parent');
    expect(beforeResume).not.toBe(afterFirst);

    const resumed = await driver.merge(mergeOpts(true));
    expect(resumed).toMatchObject({ status: 'merged', alreadyLanded: true });
    // Nothing was merged a second time.
    expect(git('rev-parse', 'lazy/parent')).toBe(beforeResume);
  });

  // INVARIANT: a FRESH accept of a branch whose changes are already on the
  // parent (a net-empty task) still refuses — idempotence is resume-only.
  test('a fresh accept of an already-landed branch still refuses', async () => {
    const driver = new LocalDriver();
    await driver.merge(mergeOpts());
    const again = await driver.merge(mergeOpts());
    expect(again.status).toBe('failed');
  });

  test('a resume whose merge never landed performs it', async () => {
    const driver = new LocalDriver();
    const before = git('rev-parse', 'lazy/parent');
    const resumed = await driver.merge(mergeOpts(true));
    expect(resumed.status).toBe('merged');
    expect((resumed as any).alreadyLanded).toBeUndefined();
    expect(git('rev-parse', 'lazy/parent')).not.toBe(before);
    expect(git('show', 'lazy/parent:feature.txt')).toBe('feature');
  });
});
