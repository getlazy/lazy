/**
 * The `branchProtection` RPC's boundary: it parses its input and refuses a
 * malformed request with a 400 naming the field, before reading any config.
 * The answer itself is `branchProtectionFor` (protection-status-vocabulary.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleBranchProtection, MAX_BRANCHES_PER_QUERY } from '../../src/daemon/branch-protection';
import { RpcError } from '../../src/daemon/rpc-error';
import { branchProtectionFor, loadProtectionContext } from '../../src/protection/status';
import type { ResolvedConfig } from '../../src/config';
import type { Storage } from '../../src/storage';

async function refusal(params: Record<string, unknown>): Promise<RpcError> {
  try {
    await handleBranchProtection('/nonexistent-project-root', params);
  } catch (err) {
    if (err instanceof RpcError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('branchProtection params', () => {
  test('branches is required and non-empty', async () => {
    expect((await refusal({})).status).toBe(400);
    expect((await refusal({ branches: [] })).message).toContain('branches is required');
  });

  test('every entry must be a string', async () => {
    expect((await refusal({ branches: ['main', 7] })).message).toContain('branches[1]');
  });

  // A full ref name would silently match no listed branch and read as
  // "unprotected" — exactly the wrong way for this question to fail.
  test('a full ref name is refused rather than answered unprotected', async () => {
    const err = await refusal({ branches: ['refs/heads/main'] });
    expect(err.status).toBe(400);
    expect(err.message).toContain('short branch name');
  });

  test('the request is bounded', async () => {
    const many = Array.from({ length: MAX_BRANCHES_PER_QUERY + 1 }, (_, i) => `b${i}`);
    expect((await refusal({ branches: many })).message).toContain(`at most ${MAX_BRANCHES_PER_QUERY}`);
  });
});

describe('loadProtectionContext and the default branch', () => {
  async function repo(withOriginHead: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-default-branch-'));
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args]);
    git('init', '-q', '-b', 'trunk');
    git('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    if (withOriginHead) {
      git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    }
    return dir;
  }

  const config = (gate: boolean) => ({
    protection: { enabled: true, protected_branches: ['release'], protected_tasks: [], gate_default_branch: gate },
    remote: { git_remote: 'origin' },
  }) as unknown as ResolvedConfig;
  const storage = {} as Storage;

  // INVARIANT: git failing to name the default branch is recorded, so the
  // per-branch answer can say "unknown" instead of a definite "not protected"
  // (hosted git then refuses a member's non-task push — fail closed).
  test('an unresolvable default branch makes unclassifiable branches unknown', async () => {
    const dir = await repo(false);
    try {
      const ctx = await loadProtectionContext(storage, config(true), dir);
      expect(ctx.defaultBranchResolved).toBe(false);
      expect(branchProtectionFor(ctx, 'feature').protected).toBeNull();
      expect(branchProtectionFor(ctx, 'release').protected).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a resolved default branch answers definitely', async () => {
    const dir = await repo(true);
    try {
      const ctx = await loadProtectionContext(storage, config(true), dir);
      expect(ctx.defaultBranchResolved).toBe(true);
      expect(branchProtectionFor(ctx, 'trunk').protected).toBe(true);
      expect(branchProtectionFor(ctx, 'feature').protected).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
