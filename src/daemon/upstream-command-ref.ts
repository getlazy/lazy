/**
 * Resolve the upstream merge ref for turn commands (start/unblock/auto-resume).
 *
 * Everything that must agree with `lazy accept` about a parent branch goes
 * through `resolveUpstreamMergeRef` — violation detection included. Turn
 * commands carry the logical parent branch name for display; this helper
 * produces the resolved ref the supervisor should merge against and compare
 * protected-file content against.
 */

import { join } from 'path';
import type { ResolvedConfig } from '../config/types';
import { createDriver, resolveUpstreamMergeRef } from '../remote';
import { isOfflineMode } from '../utils/offline';
import { logger } from '../utils/logger';

export async function resolveUpstreamMergeRefForCommand(
  projectRoot: string,
  worktreePath: string,
  parentBranch: string,
  config: ResolvedConfig,
): Promise<{ ref: string | undefined; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
    const driver = createDriver(config, undefined, { offline });
    const resolution = await resolveUpstreamMergeRef(driver, parentBranch, worktreePath, {
      remoteName: config.remote.git_remote,
    });
    warnings.push(...resolution.warnings);
    return { ref: resolution.ref, warnings };
  } catch (err) {
    logger.warn(
      `Failed to resolve upstream merge ref for ${parentBranch}: ${err instanceof Error ? err.message : err}`,
    );
    return { ref: undefined, warnings };
  }
}
