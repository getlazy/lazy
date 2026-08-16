/**
 * End-to-end contract for the builder scratch dir.
 *
 * The unit suite (test/unit/builder-scratch-mount.test.ts) pins the argv-level
 * contract — the container mount, the env var, and the fact that no agent launch
 * path can reach it. This suite pins the two things only a real CLI run can show:
 * the human can FIND the dir (it is named by `lazy system status` and reported by
 * `lazy doctor`), and it really is outside the repo — invisible to git, so it can
 * never be committed, and absent from every agent worktree.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join, relative } from 'path';
import { mkdir, writeFile, readFile, readdir, stat, chmod } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { builderScratchDir } from '../../src/builder/scratch';

/**
 * The scratch dir as the CLI subprocesses see it. `setupTestLazy` redirects
 * LAZY_SCRATCH_BASE_DIR per context, so this must be resolved with the same env
 * the subprocess got — not with this test process's own environment.
 */
function scratchDirFor(ctx: TestContext): string {
  const previous = process.env.LAZY_SCRATCH_BASE_DIR;
  process.env.LAZY_SCRATCH_BASE_DIR = ctx.scratchBaseDir;
  try {
    return builderScratchDir(ctx.root);
  } finally {
    if (previous === undefined) delete process.env.LAZY_SCRATCH_BASE_DIR;
    else process.env.LAZY_SCRATCH_BASE_DIR = previous;
  }
}

/**
 * Switch the project to the host-process builder runner and install a fake
 * `claude` that records its argv and the scratch env var it was handed, then
 * exits 0.
 *
 * Why the host-process runner: `lazy builder` runs `checkAvailability()` before
 * anything else, and the default docker runner aborts on a machine without
 * Docker. permission_mode is pinned to "bypass" for the same reason the other
 * builder suites pin it — the subject here is the scratch contract, not whether
 * bwrap and socat are installed.
 *
 * Why a fake binary rather than the module mock: the scratch dir reaches the
 * builder through the real launch path (argv + process env), which is exactly
 * what the module mock replaces.
 */
async function hostBuilderProbe(root: string): Promise<{
  env: Record<string, string>;
  argv: () => Promise<string[]>;
  scratchEnv: () => Promise<string>;
}> {
  const tomlPath = join(root, 'lazy.toml');
  const config = await readFile(tomlPath, 'utf-8');
  const patched = config.replace(
    /^type\s*=\s*"[^"]*"/m,
    'type = "dangerously-host-process-without-any-isolation"\npermission_mode = "bypass"',
  );
  if (patched === config) throw new Error('could not switch [runner] type in the generated lazy.toml');
  await writeFile(tomlPath, patched);

  const binDir = join(root, 'fakebin');
  const argvLog = join(root, 'claude-argv.log');
  const envLog = join(root, 'claude-env.log');
  await mkdir(binDir, { recursive: true });
  const claudePath = join(binDir, 'claude');
  await writeFile(
    claudePath,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvLog}"\nprintf '%s\\n' "$LAZY_SCRATCH_DIR" >> "${envLog}"\nexit 0\n`,
  );
  await chmod(claudePath, 0o755);

  const read = async (path: string): Promise<string[]> => {
    try {
      return (await readFile(path, 'utf-8')).split('\n').filter((l) => l.length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  };
  return {
    env: { PATH: `${binDir}:${process.env.PATH}` },
    argv: () => read(argvLog),
    scratchEnv: async () => (await read(envLog))[0] ?? '',
  };
}

describe('builder scratch dir', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Discoverability: the dir lives outside the repo, so nothing a human browses
  // would ever lead them to it. It has to be named by a command they run.
  test('`lazy system status` names the scratch dir', async () => {
    const result = await ctx.lazy(['system', 'status']);
    expectSuccess(result);
    expectOutput(result, 'Scratch');
    expectOutput(result, scratchDirFor(ctx));
  });

  // No expectSuccess here: `lazy doctor` exits non-zero whenever ANY check
  // reports an issue, and a test environment always has some (shell completions,
  // tmux). The subject is the scratch line, not doctor's overall verdict.
  test('`lazy doctor` reports it, and says it is empty when it is', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'scratch dir');
    expectOutput(result, scratchDirFor(ctx));
    expectOutput(result, 'empty');
  });

  test('`lazy doctor` reports the item count and size once artifacts exist', async () => {
    const dir = scratchDirFor(ctx);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'accept-msg.md'), 'x'.repeat(4096));

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, '1 item(s)');
    expectOutput(result, '4.0 KB');
  });

  // INVARIANT: it cannot be committed. Not "is gitignored" — not in the tree at
  // all, so there is no ignore rule to forget, edit, or override with `git add -f`.
  test('is outside the repo and invisible to git', async () => {
    const dir = scratchDirFor(ctx);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'draft.md'), 'builder notes');

    expect(relative(ctx.root, dir).startsWith('..')).toBe(true);

    const status = ctx.git('status', '--porcelain');
    expect(status.stdout.trim()).toBe('');
    // `git add` cannot even name it — a path outside the work tree.
    const added = ctx.git('add', dir);
    expect(added.exitCode).not.toBe(0);
  });

  // INVARIANT (load-bearing): a task agent must not be able to reach it. Agents
  // work in worktrees under .lazy/worktrees/; the scratch dir is not below any
  // of them, and no worktree path is below the scratch dir.
  test('is not reachable from any agent worktree path', async () => {
    const dir = scratchDirFor(ctx);
    const worktreeBase = join(ctx.root, '.lazy', 'worktrees');
    expect(relative(worktreeBase, dir).startsWith('..')).toBe(true);
    expect(relative(dir, worktreeBase).startsWith('..')).toBe(true);
  });

  // CONTRACT PARITY: the container runner's side of this is pinned at the argv
  // level in the unit suite (a -v mount + -e env var). This is the host-process
  // runner's side, end to end — same capability, same env var name, so a builder
  // never has to ask which runner it is on.
  test('host-process builder launch creates the dir, exports it, and adds it as a workspace dir', async () => {
    const probe = await hostBuilderProbe(ctx.root);
    const dir = scratchDirFor(ctx);

    const result = await ctx.lazy(['builder'], { env: probe.env });
    expectSuccess(result);

    // 1. The human is told where it is, at launch.
    expectOutput(result, dir);
    expectOutput(result, 'Scratch dir');

    // 2. It exists and is writable before the builder starts.
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o777);

    // 3. The builder gets the path in its environment...
    expect(await probe.scratchEnv()).toBe(dir);

    // 4. ...and the dir is a workspace dir, so the file tools and the OS sandbox
    //    both allow writes there (the repo mount stays read-only).
    const argv = await probe.argv();
    const addDirIndex = argv.indexOf('--add-dir');
    expect(addDirIndex).toBeGreaterThanOrEqual(0);
    expect(argv[addDirIndex + 1]).toBe(dir);
  });

  // LIFECYCLE: persistent, never auto-wiped. Reporting on it must not mutate it —
  // a human may read an artifact days after the builder session that wrote it.
  test('is never pruned by the commands that report on it', async () => {
    const dir = scratchDirFor(ctx);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'keep-me.md'), 'still here');

    await ctx.lazy(['doctor']);
    await ctx.lazy(['system', 'status']);

    expect(await readdir(dir)).toEqual(['keep-me.md']);
    expect((await stat(join(dir, 'keep-me.md'))).size).toBe('still here'.length);
  });
});
