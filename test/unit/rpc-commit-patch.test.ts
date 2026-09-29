/**
 * The `commitPatch` RPC and the commit identity on `show`'s commits — what the
 * Lazy Teams commit page and Commits tab render.
 *
 * INVARIANT: `commitPatch` answers only for a commit the task RECORDED, never an
 * arbitrary SHA. A remote client names a commit on a task; answering any object
 * in the repository would turn a per-task page into a read of every commit.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleShow,
  handleCommitPatch,
} from '../../src/daemon/rpc-handlers';
import { getCommitPatch } from '../../src/git/operations';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada Author', GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Cy Committer', GIT_COMMITTER_EMAIL: 'cy@example.com',
      GIT_AUTHOR_DATE: '2026-09-27T10:11:12+02:00', GIT_COMMITTER_DATE: '2026-09-27T10:11:12+02:00',
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('commitPatch RPC and commit identity on show', () => {
  let root: string;
  let taskId: string;
  let recordedSha: string;
  let otherSha: string;
  let commitId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-commit-patch-'));
    git(root, 'init', '-q', '-b', 'main');
    await writeFile(join(root, 'a.txt'), 'one\n');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-q', '-m', 'first');
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n');
    git(root, 'commit', '-q', '-am', 'second');
    recordedSha = git(root, 'rev-parse', 'HEAD');
    otherSha = git(root, 'rev-parse', 'HEAD~1');

    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Commit patch');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude', 'lazy/t', 'HEAD');
    commitId = (await storage.createCommit(session.id, recordedSha, 'second')).id;
    await storage.createCommit(session.id, 'f'.repeat(40), 'gone from the repo');
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('show commits carry author, committer and ISO 8601 times', async () => {
    const payload = (await handleShow(root, { taskId, sections: ["commits"] })) as unknown as { commits: Array<Record<string, unknown>> };
    const known = payload.commits.find((c) => c.sha === recordedSha)!;
    expect(known.author_name).toBe('Ada Author');
    expect(known.author_email).toBe('ada@example.com');
    expect(known.committer_name).toBe('Cy Committer');
    expect(known.committed_at).toBe('2026-09-27T10:11:12+02:00');
    // A SHA git no longer knows keeps its record, just without identity.
    const unknown = payload.commits.find((c) => c.sha === 'f'.repeat(40))!;
    expect(unknown.author_name).toBeUndefined();
  });

  test('answers the patch by record id and by SHA prefix', async () => {
    for (const id of [commitId, recordedSha.slice(0, 8)]) {
      const r = await handleCommitPatch(root, { taskId, commitId: id });
      expect(r.commit.sha).toBe(recordedSha);
      expect(r.commit.author_name).toBe('Ada Author');
      expect(r.patchAvailable).toBe(true);
      expect(r.patch).toContain('diff --git a/a.txt b/a.txt');
      expect(r.patch).toContain('+two');
    }
  });

  // INVARIANT: commitPatch answers only for a commit the task RECORDED. A remote
  // client names a commit on a task; answering any repository object would turn a
  // per-task page into a read of every commit.
  test('refuses a commit the task did not record', async () => {
    await expect(handleCommitPatch(root, { taskId, commitId: otherSha })).rejects.toThrow(/not a recorded commit/);
  });

  test('a recorded commit git cannot find answers with no patch', async () => {
    const r = await handleCommitPatch(root, { taskId, commitId: 'f'.repeat(40) });
    expect(r.patchAvailable).toBe(false);
    expect(r.missing).toBe(true);
  });

  test('a merge commit answers what it brought in, against its first parent', async () => {
    git(root, 'checkout', '-q', '-b', 'side', otherSha);
    await writeFile(join(root, 'b.txt'), 'from side\n');
    git(root, 'add', 'b.txt');
    git(root, 'commit', '-q', '-m', 'side');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '-q', '--no-edit', 'side');
    const mergeSha = git(root, 'rev-parse', 'HEAD');
    const storage = await getOrCreateStorage();
    const session = (await storage.getSessionByTaskId(taskId))!;
    await storage.createCommit(session.id, mergeSha, 'merge side');

    const r = await handleCommitPatch(root, { taskId, commitId: mergeSha });
    expect(r.missing).toBe(false);
    expect(r.patch).toContain('+from side');
  });

  // A git failure is an error, never "missing" and never "no changes".
  test('getCommitPatch throws on a git failure instead of answering missing or empty', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'lazy-not-a-repo-'));
    try {
      await expect(getCommitPatch(recordedSha, notARepo)).rejects.toThrow(/could not look up/);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
    await expect(getCommitPatch('HEAD; rm -rf', root)).rejects.toThrow(/not a hex commit SHA/);
  });
});
