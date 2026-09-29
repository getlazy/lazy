import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { createStorage, type Storage } from '../../src/storage';
import { createCommitHandler, type McpToolContext } from '../../src/mcp/tools';
import { branchTarget } from '../../src/task-target';
import { LAZY_COAUTHOR_TRAILER, withLazyCoauthorTrailer } from '../../src/constants';

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSyncUnsupervised(['git', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...AUTHOR },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('withLazyCoauthorTrailer', () => {
  test('starts a trailer paragraph after a plain body', () => {
    expect(withLazyCoauthorTrailer('Subject\n\nBody')).toBe(`Subject\n\nBody\n\n${LAZY_COAUTHOR_TRAILER}`);
  });
  test('joins an existing trailer block so git parses both', () => {
    const msg = 'Subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
    expect(withLazyCoauthorTrailer(msg))
      .toBe(`Subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${LAZY_COAUTHOR_TRAILER}`);
  });
  test('a one-line subject that looks like a trailer is not a trailer block', () => {
    expect(withLazyCoauthorTrailer('fix: thing')).toBe(`fix: thing\n\n${LAZY_COAUTHOR_TRAILER}`);
  });
  test('never duplicates, and disabled leaves the message alone', () => {
    const once = withLazyCoauthorTrailer('Subject');
    expect(withLazyCoauthorTrailer(once)).toBe(once);
    expect(withLazyCoauthorTrailer('Subject', false)).toBe('Subject');
    expect(withLazyCoauthorTrailer('', false)).toBe('');
  });
  test('a body that only quotes the line still gets the real trailer', () => {
    const msg = `Subject\n\n\`\`\`\n${LAZY_COAUTHOR_TRAILER}\n\`\`\`\n\nMore text.`;
    expect(withLazyCoauthorTrailer(msg)).toBe(`${msg}\n\n${LAZY_COAUTHOR_TRAILER}`);
  });
  test('a trailer already in the final block is not duplicated', () => {
    const msg = `Subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${LAZY_COAUTHOR_TRAILER}`;
    expect(withLazyCoauthorTrailer(msg)).toBe(msg);
  });
});

describe('lazy_commit co-author trailer', () => {
  let root: string;
  let worktree: string;
  let storage: Storage;
  let ctx: McpToolContext;
  const saved: Record<string, string | undefined> = {};
  let configPath: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-commit-coauthor-')));
    const repo = join(root, 'repo');
    worktree = join(root, 'wt');
    await mkdir(join(repo, '.lazy'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'worktree', 'add', worktree, '-b', 'lazy/mine');
    storage = await createStorage(repo, { backend: 'external' });
    const task = await storage.createTask('Test task');
    await storage.updateTaskTarget(task.id, branchTarget('main'));
    // The daemon's MCP route sets projectRoot; the handler reads THAT root's
    // lazy.toml, so the test does not depend on the runner's cwd.
    ctx = { taskId: task.id, worktreePath: worktree, storage, projectRoot: repo };
    configPath = join(repo, 'lazy.toml');
    const env: Record<string, string | undefined> = { ...AUTHOR, LAZY_CONFIG: undefined };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await storage?.close();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a commit lazy_commit writes carries lazy's co-author trailer by
  // default — lazy made it, so lazy signs it.
  test('adds the trailer by default', async () => {
    await writeFile(configPath, '');
    await writeFile(join(worktree, 'work.txt'), 'work\n');
    const result = await createCommitHandler(ctx)({ message: 'agent work' }) as { committed: boolean };
    expect(result.committed).toBe(true);
    expect(git(worktree, 'log', '-1', '--format=%B')).toBe(`agent work\n\n${LAZY_COAUTHOR_TRAILER}`);
    expect(git(worktree, 'log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)'))
      .toBe('Lazy <noreply@getlazy.dev>');
  });

  // INVARIANT: `[git] coauthor_trailer = false` removes it from lazy_commit too.
  test('omits the trailer when the project opts out', async () => {
    await writeFile(configPath, '[git]\ncoauthor_trailer = false\n');
    await writeFile(join(worktree, 'work.txt'), 'work\n');
    await createCommitHandler(ctx)({ message: 'agent work' });
    expect(git(worktree, 'log', '-1', '--format=%B')).toBe('agent work');
  });
});
