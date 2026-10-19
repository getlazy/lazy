import { loadConfig } from '../config/loader';
import { join } from 'path';
import { recoverMissingWorktree, recoverMissingWorktreeWithFetch, worktreeExistsAfterRecovery } from '../git/operations';
import { getBranchName, getWorktreePath } from '../task/identity';
import type { Task } from '../types';
import { isOfflineMode } from '../utils/offline';
import type { PhaseNotify } from './progress';
import { RpcError } from './rpc-error';

export async function ensureTaskWorktree(
  projectRoot: string,
  task: Task,
  branch?: string,
  notify?: PhaseNotify,
): Promise<string> {
  const worktreePath = getWorktreePath(projectRoot, task);
  if (await worktreeExistsAfterRecovery(worktreePath, projectRoot)) return worktreePath;
  notify?.('Restoring task files…');
  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  const branchName = branch ?? getBranchName(task);
  try {
    const result = offline
      ? await recoverMissingWorktree(worktreePath, branchName, projectRoot, { onProgress: notify })
      : await recoverMissingWorktreeWithFetch(worktreePath, branchName, config.remote.git_remote, projectRoot, { onProgress: notify });
    if (!result.recovered) {
      throw new RpcError(409, `Cannot restore task files: branch '${branchName}' is not available${offline ? ' locally (offline mode is enabled)' : ' locally or on the remote'}.`);
    }
    return worktreePath;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError(409, `Cannot restore task files: ${error instanceof Error ? error.message : String(error)}`);
  }
}
