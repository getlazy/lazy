/**
 * `branchProtection` RPC — is each of these branches protected?
 *
 * Asked by Lazy Teams' hosted git before it lets a member push: a task branch
 * (`lazy/…`) is a member's to push, any other branch only when the project's
 * own [protection] config says it is not protected. Teams keeps no branch list
 * of its own; this is the answer, computed by the same rule a task's status
 * line and accept's branch gate use (src/protection/status.ts).
 *
 * Read-only. Answers `{ enabled, branches: [{ branch, protected, source, reason }] }`
 * in the order asked. `protected` is null when it cannot be known (the default
 * branch is gated but unresolved) — never read that as "not protected".
 *
 * `foldCase: true` matches protected names without regard to letter case.
 * Hosted git always sends it (a case-insensitive filesystem makes `Release`
 * and `release` one ref file); nothing else does, and accept's gate is exact.
 */

import { loadConfig } from '../config/loader';
import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { optionalBoolean, optionalStringArray } from './rpc-params';
import {
  branchProtectionFor,
  loadProtectionContext,
  type BranchProtectionStatus,
} from '../protection/status';

/** A push names a handful of refs; this bounds a hand-rolled request, not git. */
export const MAX_BRANCHES_PER_QUERY = 1000;

export async function handleBranchProtection(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<{ enabled: boolean; branches: BranchProtectionStatus[] }> {
  const branches = optionalStringArray(params, 'branches');
  const foldCase = optionalBoolean(params, 'foldCase') ?? false;
  if (!branches || branches.length === 0) {
    throw new RpcError(400, 'branches is required (a non-empty array of branch names)');
  }
  if (branches.length > MAX_BRANCHES_PER_QUERY) {
    throw new RpcError(400, `branches may name at most ${MAX_BRANCHES_PER_QUERY} branches, got ${branches.length}`);
  }
  for (const [i, branch] of branches.entries()) {
    if (branch.trim() === '' || branch.startsWith('refs/')) {
      throw new RpcError(400, `branches[${i}] must be a short branch name (e.g. "main"), got ${JSON.stringify(branch)}`);
    }
  }

  const config = await loadConfig(projectRoot);
  const ctx = await loadProtectionContext(await getOrCreateStorage(), config, projectRoot);
  return {
    enabled: ctx.enabled,
    branches: branches.map((branch) => branchProtectionFor(ctx, branch, { foldCase })),
  };
}
