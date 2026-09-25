import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import {
  DEFAULT_BRANCH_PREFIX,
  branchPrefixError,
  getBranchPrefix,
  looksLikeTaskBranch,
  normalizeBranchPrefix,
  resetBranchPrefix,
  taskBranchFor,
  taskRefFromBranch,
} from '../../src/git/branch-prefix';

/**
 * `[git] default_branch_prefix` — where the value comes from, and what is
 * rejected.
 *
 * INVARIANT: the prefix is installed PROCESS-WIDE by loadConfig, and always from
 * the PROJECT ROOT's lazy.toml. lazy.toml is tracked in git, so every task
 * worktree carries a copy on an agent-writable branch: taking the prefix from a
 * worktree's copy would let one task's committed config re-point branch naming
 * for every other task in the same long-lived daemon, and re-point
 * `looksLikeTaskBranch`, which decides whether accept merges locally or through
 * the forge. Here that falls out of the loader having no starting-directory
 * parameter at all — no key is read from a worktree config (see "A task
 * worktree's lazy.toml has no authority" in src/config/loader.ts) — rather than
 * from a carve-out for this one key.
 *
 * INVARIANT: an unusable prefix is rejected at the config boundary, not by
 * `git branch` partway through starting a task.
 */
describe('[git] default_branch_prefix', () => {
  let root: string;
  let worktree: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-branch-prefix-'));
    worktree = join(root, '.lazy', 'worktrees', 'wt');
    await mkdir(worktree, { recursive: true });
    resetBranchPrefix();
  });

  afterEach(async () => {
    // The prefix is process-global: leaving a fixture's value installed would
    // rename task branches in every suite that runs after this one.
    resetBranchPrefix();
    await rm(root, { recursive: true, force: true });
  });

  const writeRoot = (body: string) => writeFile(join(root, 'lazy.toml'), body, 'utf-8');
  const writeWorktree = (body: string) => writeFile(join(worktree, 'lazy.toml'), body, 'utf-8');

  /**
   * Load the fixture project. No cwd to pass: loadConfig resolves the project
   * root's lazy.toml and nothing else, whatever the caller's cwd is.
   */
  const loadFromRoot = () => loadConfig(root);

  describe('installation', () => {
    test('a configured prefix reaches the process-global branch namespace', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n');

      const config = await loadFromRoot();

      expect(config.git.default_branch_prefix).toBe('wip');
      expect(getBranchPrefix()).toBe('wip');
      expect(taskBranchFor('my-task')).toBe('wip/my-task');
    });

    test('no [git] section leaves the built-in default', async () => {
      await writeRoot('[session]\nverbose = false\n');

      const config = await loadFromRoot();

      expect(config.git.default_branch_prefix).toBe(DEFAULT_BRANCH_PREFIX);
      expect(taskBranchFor('my-task')).toBe('lazy/my-task');
    });

    test('a trailing slash names the same namespace', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip/"\n');

      const config = await loadFromRoot();

      expect(config.git.default_branch_prefix).toBe('wip');
      expect(taskBranchFor('my-task')).toBe('wip/my-task');
    });

    // INVARIANT: the prefix is a PROJECT-level fact. A task worktree's own
    // lazy.toml is agent-writable, and all worktrees share one git directory —
    // so a per-worktree branch namespace is both dangerous and incoherent.
    test('a worktree lazy.toml cannot re-point the branch namespace', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n');
      await writeWorktree('[git]\ndefault_branch_prefix = "evil"\n');

      const config = await loadConfig(root);

      expect(getBranchPrefix()).toBe('wip');
      expect(config.git.default_branch_prefix).toBe('wip');
      expect(taskBranchFor('my-task')).toBe('wip/my-task');
    });

    // The same protection, stated as the consequence that makes it matter:
    // `looksLikeTaskBranch` is what tells accept a target is an intermediate
    // task branch it may merge into LOCALLY, skipping the forge's protection
    // check. A worktree config must not be able to widen that classification.
    test('a worktree lazy.toml cannot widen task-branch classification', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n');
      await writeWorktree('[git]\ndefault_branch_prefix = "release"\n');

      await loadConfig(root);

      expect(looksLikeTaskBranch('release/2.0')).toBe(false);
    });

    // The prefix needs no carve-out here: NO setting is read from a worktree
    // config, so a worktree copy cannot reach any of them. See
    // test/e2e/worktree-config-authority.test.ts and
    // test/unit/config-root-anchored.test.ts for that rule in general.
    test('no setting comes from the worktree config, prefix included', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n[session]\nverbose = false\n');
      await writeWorktree('[git]\ndefault_branch_prefix = "evil"\n[session]\nverbose = true\n');

      const config = await loadConfig(root);

      expect(config.session.verbose).toBe(false);
      expect(config.git.default_branch_prefix).toBe('wip');
    });

    test('a project with no root lazy.toml gets the default, not a worktree copy', async () => {
      await writeWorktree('[git]\ndefault_branch_prefix = "wip"\n');

      const config = await loadConfig(root);

      expect(config.git.default_branch_prefix).toBe(DEFAULT_BRANCH_PREFIX);
      expect(getBranchPrefix()).toBe(DEFAULT_BRANCH_PREFIX);
    });
  });

  // INVARIANT: external surfaces validate their inputs and reject loudly. A
  // prefix git cannot use must fail the load, naming the file and the key —
  // not fail `git branch` with a worktree already created.
  describe('validation', () => {
    const rejected: Array<[string, string]> = [
      ['a leading slash', '/wip'],
      ['an interior space', 'my branches'],
      ['an empty path segment', 'wip//tasks'],
      ['a ".." component', 'wip/../main'],
      ['a reflog suffix', 'wip@{0}'],
      ['a git-reserved character', 'wip^2'],
      ['a hidden segment', '.wip'],
      ['a .lock segment', 'wip.lock'],
      ['a trailing dot', 'wip.'],
    ];

    for (const [label, value] of rejected) {
      test(`rejects ${label}`, async () => {
        await writeRoot(`[git]\ndefault_branch_prefix = ${JSON.stringify(value)}\n`);
        await expect(loadFromRoot()).rejects.toThrow(/default_branch_prefix/);
      });
    }

    const accepted = ['wip', 'wip/', 'team/wip', 'lazy', 'la', 'WIP-2', 'wip.tasks'];
    for (const value of accepted) {
      test(`accepts ${JSON.stringify(value)}`, () => {
        expect(branchPrefixError(value)).toBeNull();
      });
    }

    // INVARIANT: an empty string means "unset, use the default" throughout
    // lazy.toml (`[storage] external_path`, `[docker] dockerfile`, `[docs] url`),
    // so this must not be the one key where writing "" refuses to load. A user
    // who has it set today gets `lazy/...` branches; upgrading must not turn
    // that into a daemon that will not start.
    const emptyValues: Array<[string, string]> = [
      ['an empty prefix', ''],
      ['whitespace only', '   '],
      ['slashes only', '//'],
    ];
    for (const [label, value] of emptyValues) {
      test(`treats ${label} as unset and uses the default`, async () => {
        await writeRoot(`[git]\ndefault_branch_prefix = ${JSON.stringify(value)}\n`);

        const config = await loadFromRoot();

        expect(config.git.default_branch_prefix).toBe(DEFAULT_BRANCH_PREFIX);
        expect(getBranchPrefix()).toBe(DEFAULT_BRANCH_PREFIX);
        expect(taskBranchFor('my-task')).toBe('lazy/my-task');
      });
    }

    test('the rejection names the offending file', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "/wip"\n');
      await expect(loadFromRoot()).rejects.toThrow(join(root, 'lazy.toml'));
    });

    // A worktree's prefix is ignored, so it must not fail the load either — the
    // check applies to the value that is actually used.
    test('an unusable prefix in a worktree config does not fail the load', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n');
      await writeWorktree('[git]\ndefault_branch_prefix = "/nonsense"\n');

      const config = await loadConfig(root);

      expect(config.git.default_branch_prefix).toBe('wip');
    });
  });

  describe('classification after a prefix change', () => {
    beforeEach(() => {
      resetBranchPrefix();
    });

    // INVARIANT: a project that switched prefixes still has `lazy/...` branches
    // and stored refs from before the switch. Misclassifying one of those as a
    // real integration branch is the dangerous direction.
    test('branches from before the switch are still recognised as lazy branches', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n');
      await loadFromRoot();

      expect(looksLikeTaskBranch('lazy/old-task')).toBe(true);
      expect(looksLikeTaskBranch('wip/new-task')).toBe(true);
      expect(looksLikeTaskBranch('main')).toBe(false);
      expect(looksLikeTaskBranch('release/2.0')).toBe(false);
      // A branch merely STARTING with the prefix text is not in its namespace —
      // the separator is part of the match, so `lazy-release` stays an
      // integration branch.
      expect(looksLikeTaskBranch('lazy-release')).toBe(false);
      expect(looksLikeTaskBranch('wip-release')).toBe(false);
    });

    test('a ref survives a round trip through either namespace', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "wip"\n');
      await loadFromRoot();

      expect(taskRefFromBranch(taskBranchFor('my-task'))).toBe('my-task');
      expect(taskRefFromBranch('lazy/my-task')).toBe('my-task');
      // Not a task branch in either namespace: passed through unchanged, which
      // is what the `.replace('lazy/', '')` this replaced did.
      expect(taskRefFromBranch('main')).toBe('main');
    });

    // A prefix that is a prefix of the built-in one must not smear the two
    // namespaces together.
    test('a prefix that is a substring of the default stays distinct', async () => {
      await writeRoot('[git]\ndefault_branch_prefix = "la"\n');
      await loadFromRoot();

      expect(looksLikeTaskBranch('la/new-task')).toBe(true);
      expect(looksLikeTaskBranch('lazy/old-task')).toBe(true);
      // `lazy` is not swallowed by the shorter `la` namespace: `lazy/x` is a
      // task branch because of the built-in prefix, not because it starts with
      // the letters "la".
      expect(looksLikeTaskBranch('latest/thing')).toBe(false);
      expect(taskRefFromBranch('lazy/old-task')).toBe('old-task');
      expect(taskRefFromBranch('la/new-task')).toBe('new-task');
    });
  });

  describe('normalizeBranchPrefix', () => {
    // Total by construction: it runs on every install, and the loud rejection
    // lives at the config boundary instead.
    test('falls back to the default rather than throwing', () => {
      expect(normalizeBranchPrefix('')).toBe(DEFAULT_BRANCH_PREFIX);
      expect(normalizeBranchPrefix(null)).toBe(DEFAULT_BRANCH_PREFIX);
      expect(normalizeBranchPrefix(undefined)).toBe(DEFAULT_BRANCH_PREFIX);
      expect(normalizeBranchPrefix('  wip/// ')).toBe('wip');
    });
  });
});
