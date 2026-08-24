/**
 * `lazy_internal_git` — the host-side escape hatch for ref-writing operations
 * the supervisor legitimately needs once the container's git common dir is
 * mounted read-only (see src/capture/git-mounts.ts).
 *
 * The whole point of the read-only mount is that a rogue agent cannot merge a
 * sibling branch or rewrite history. The supervisor runs inside that same
 * container, so this tool is the one channel that CAN move refs — which makes
 * its validation load-bearing: it must not become a "merge anything" primitive
 * reachable by anything holding the container's bearer token.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { createStorage, type Storage } from '../../src/storage';
import { createInternalGitHandler } from '../../src/mcp/internal-git';
import { INTERNAL_GIT_TOOL_NAME } from '../../src/mcp/types';
import { allTools, createCommitHandler } from '../../src/mcp/tools';
import type { McpToolContext } from '../../src/mcp/tools';
import { branchTarget } from '../../src/task-target';
import { elevatedTag, resetElevatedGitChannel } from '../../src/supervisor/elevated-git';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

describe('lazy_internal_git', () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-internal-git-'));
    repo = join(root, 'repo');
    worktree = join(root, 'wt');
    await mkdir(join(repo, '.lazy'), { recursive: true });

    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');

    // A sibling task's branch, with a commit of its own.
    git(repo, 'branch', 'lazy/sibling');
    git(repo, 'worktree', 'add', worktree, '-b', 'lazy/mine');
    const sibWt = join(root, 'sib');
    git(repo, 'worktree', 'add', sibWt, 'lazy/sibling');
    await writeFile(join(sibWt, 'sibling.txt'), 'sibling work\n');
    git(sibWt, 'add', '.');
    git(sibWt, 'commit', '-m', 'sibling commit');

    // Advance main so there is something legitimate to merge.
    await writeFile(join(repo, 'upstream.txt'), 'upstream\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'upstream commit');

    storage = await createStorage(repo, { backend: 'external' });
    const task = await storage.createTask('Test task');
    await storage.updateTaskTarget(task.id, branchTarget('main'));
    ctx = { taskId: task.id, worktreePath: worktree, storage };
  });

  afterEach(async () => {
    await storage?.close();
    await rm(root, { recursive: true, force: true });
  });

  test('is not advertised to agents', () => {
    // INVARIANT: this tool can move refs host-side. It is reachable only over the
    // supervisor's authenticated daemon channel and must never appear in the
    // agent-facing tool list, where it would be discoverable and pre-approved.
    expect(allTools.some(t => t.name === INTERNAL_GIT_TOOL_NAME)).toBe(false);
  });

  test('merges the task\'s own upstream', async () => {
    const handler = createInternalGitHandler(ctx);
    const result = await handler({ op: 'merge', target: 'main', message: 'Merge main' }) as any;

    expect(result.exit_code).toBe(0);
    const log = git(worktree, 'log', '--oneline');
    expect(log).toContain('Merge main');
    expect(log).toContain('upstream commit');
  });

  test('refuses a sibling task branch', async () => {
    const handler = createInternalGitHandler(ctx);

    // INVARIANT: the supervisor reads its merge target from the protocol dir,
    // which IS writable inside the container. A compromised container could name
    // any ref, so the daemon validates reachability from this task's own
    // upstreams rather than trusting the request. This is the rogue-agent
    // sibling-merge that motivated the split mount.
    await expect(
      handler({ op: 'merge', target: 'lazy/sibling', message: 'Merge sibling' }),
    ).rejects.toThrow(/not contained in any upstream this task may merge from/);

    expect(git(worktree, 'log', '--oneline')).not.toContain('sibling commit');
  });

  test('accepts a SHA contained in the upstream, not just the branch name', async () => {
    // Sync merges a SHA the daemon pinned earlier, not a ref name — that SHA is
    // an ancestor of the upstream ref, which is why validation is reachability
    // rather than string equality.
    const sha = git(repo, 'rev-parse', 'main~1');
    const handler = createInternalGitHandler(ctx);
    const result = await handler({ op: 'merge', target: sha, message: 'Merge pinned upstream' }) as any;
    expect(result.exit_code).toBe(0);
  });

  test('refuses a tag name outside this task\'s namespace', async () => {
    const handler = createInternalGitHandler(ctx);
    // INVARIANT: tagging is elevated too, so it must not become a way to write
    // arbitrary refs (a tag is a ref). Only this task's own turn tags are allowed.
    await expect(handler({ op: 'tag', name: 'v1.0.0' })).rejects.toThrow(/Refusing to write tag/);
    await expect(
      handler({ op: 'tag', name: `turn/${'0'.repeat(8)}/pre/abcdef1` }),
    ).rejects.toThrow(/Refusing to write tag/);

    const head = git(worktree, 'rev-parse', 'HEAD');
    const ok = await handler({
      op: 'tag',
      name: `turn/${ctx.taskId.substring(0, 8)}/pre/${head.substring(0, 8)}`,
    }) as any;
    expect(ok.exit_code).toBe(0);
  });

  test('tag name validation is structural, not a RegExp built from the task id', async () => {
    // INVARIANT: `turn/<taskid8>/<phase>/<sha>` is checked by splitting on '/'
    // and comparing the four segments, NOT by interpolating the task id into a
    // RegExp. A task id carrying a regex metacharacter must fail the check like
    // any other mismatch — it must never be able to alter what the check means.
    // The check gates which refs the supervisor may write, so weakening it is a
    // privilege escalation, not a cosmetic bug.
    const head = git(worktree, 'rev-parse', 'HEAD').substring(0, 8);
    // Exactly 8 chars, all legal in a git ref name, and all regex metacharacters:
    // interpolated into a pattern, `a+b(c)dd` means "one-or-more a, b, c, dd".
    const handler = createInternalGitHandler({ ...ctx, taskId: 'a+b(c)dd' });

    // The literal id is the only namespace this task may write.
    const ok = await handler({ op: 'tag', name: `turn/a+b(c)dd/pre/${head}` }) as any;
    expect(ok.exit_code).toBe(0);

    // The old dynamic RegExp accepted this — a namespace that is NOT this
    // task's. Structural comparison rejects it.
    await expect(
      handler({ op: 'tag', name: `turn/aaabcdd/pre/${head}` }),
    ).rejects.toThrow(/Refusing to write tag/);
  });

  test('rejects tag names with the wrong segment count or charset', async () => {
    const handler = createInternalGitHandler(ctx);
    const short = ctx.taskId.substring(0, 8);
    const head = git(worktree, 'rev-parse', 'HEAD').substring(0, 8);
    for (const name of [
      `turn/${short}/pre`,                       // too few segments
      `turn/${short}/pre/${head}/extra`,         // too many segments
      `turns/${short}/pre/${head}`,              // wrong literal prefix
      `turn/${short}/PRE/${head}`,               // phase charset
      `turn/${short}/pre/${head.toUpperCase()}`, // sha charset
      `turn/${short}/pre/abcdef`,                // sha too short
    ]) {
      await expect(handler({ op: 'tag', name })).rejects.toThrow(/Refusing to write tag/);
    }
  });

  test('rejects unknown ops instead of passing them to git', async () => {
    const handler = createInternalGitHandler(ctx);
    await expect(handler({ op: 'push' })).rejects.toThrow(/unknown op/);
  });

  test('lazy_commit concludes a merge whose resolution matches HEAD', async () => {
    // Set up a conflicted merge, then resolve every conflict in favour of ours,
    // so the staged diff against HEAD is empty.
    git(worktree, 'merge', 'main', '--no-edit'); // absorb existing upstream first
    await writeFile(join(worktree, 'shared.txt'), 'ours\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'ours');

    const mainWt = repo;
    await writeFile(join(mainWt, 'shared.txt'), 'theirs\n');
    git(mainWt, 'add', '.');
    git(mainWt, 'commit', '-m', 'theirs');

    const handler = createInternalGitHandler(ctx);
    const merge = await handler({ op: 'merge', target: 'main', message: 'Merge main' }) as any;
    expect(merge.exit_code).not.toBe(0); // conflicted, left in place for the agent

    git(worktree, 'checkout', '--ours', 'shared.txt');
    git(worktree, 'add', 'shared.txt');
    expect(git(worktree, 'diff', '--cached', '--stat')).toBe('');

    // INVARIANT: an in-progress merge must still be concluded when the resolution
    // happens to equal HEAD. The agent cannot run `git commit` itself — the
    // shared git dir is read-only in its container — so an early "nothing to
    // commit" return here would strand the merge with no way out.
    const commit = createCommitHandler(ctx);
    const result = await commit({ message: 'Merge main' }) as any;
    expect(result.committed).toBe(true);
    expect(git(worktree, 'log', '--oneline', '-1')).toContain('Merge main');
    expect(git(worktree, 'rev-list', '--count', '--merges', 'HEAD')).not.toBe('0');
  });
});

/**
 * Which side runs a ref-writing operation is decided by the repository's own
 * mount, not by an environment variable.
 */
describe('elevated git routing', () => {
  let root: string;
  let repo: string;
  let savedConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-elevated-route-'));
    repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');

    savedConfig = process.env.LAZY_DAEMON_CONFIG;
    resetElevatedGitChannel();
  });

  afterEach(async () => {
    if (savedConfig === undefined) delete process.env.LAZY_DAEMON_CONFIG;
    else process.env.LAZY_DAEMON_CONFIG = savedConfig;
    resetElevatedGitChannel();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a writable git common dir means the operation runs locally, even
  // when LAZY_DAEMON_CONFIG happens to be set. That variable is inherited by
  // every child process of a supervisor's environment — including test runs and
  // nested lazy projects that own a completely different, writable repository —
  // so routing on it would send ref writes to a daemon that knows nothing about
  // the repo in hand. The mount is the only honest signal.
  test('runs locally when the git common dir is writable, regardless of LAZY_DAEMON_CONFIG', async () => {
    process.env.LAZY_DAEMON_CONFIG = join(root, 'no-such-daemon-config.json');

    const sha = git(repo, 'rev-parse', 'HEAD');
    const name = `turn/${'0'.repeat(8)}/pre/${sha.substring(0, 8)}`;
    const result = await elevatedTag(repo, name);

    expect(result.exitCode).toBe(0);
    expect(git(repo, 'tag', '--list', name)).toBe(name);
  });
});
