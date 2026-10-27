import { pathExists } from '../utils/fs';
import { readFile } from 'fs/promises';
import { createInspectionRunner } from '../runner';
import { taskRef } from './identity';
import { runGit } from '../utils/git';
import type { Storage } from '../storage';
import type { Task } from '../types';
import { protocolDir } from '../protocol';
import { readSupervisorStatusAsync } from '../utils/working-substate';
import { readWorktreeMergeState } from '../git/operations';

// Provenance only, never a sync plan or progress counter. Matching BOTH git
// endpoints and the owning command makes an old record inert after a later turn.
export const UNFINISHED_SYNC_MERGE_KEY = 'unfinished_sync_merge';

export interface UnfinishedSyncMerge {
  head: string;
  mergeHead: string;
  conflicts: number;
}

/**
 * The merge in progress in a worktree, with NO claim about who started it:
 * HEAD, the incoming commit (MERGE_HEAD) and the conflicted-file count. Null
 * when there is no worktree or no merge. Read-only. Close and reject show this
 * to a person and abort it only on their explicit confirmation.
 */
export async function inspectWorktreeMerge(worktreePath: string): Promise<UnfinishedSyncMerge | null> {
  if (!await pathExists(worktreePath)) return null;
  const state = await readWorktreeMergeState(worktreePath);
  if (!state.mergeInProgress) return null;
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath });
  const incoming = await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: worktreePath });
  if (head.exitCode !== 0 || incoming.exitCode !== 0) return null;
  return { head: head.stdout.trim(), mergeHead: incoming.stdout.trim(), conflicts: state.unmergedFiles.length };
}

export async function unfinishedSyncMerge(
  storage: Storage, task: Task, worktreePath: string, projectRoot?: string,
): Promise<UnfinishedSyncMerge | null> {
  // Inspection is read-only; callers must stop a live agent before aborting.
  if (task.status === 'pairing') return null;
  const result = await inspectWorktreeMerge(worktreePath);
  if (!result) return null;
  const own = await storage.getTaskMetadata(task.id, UNFINISHED_SYNC_MERGE_KEY);
  let owningCommand: string | null = null;
  if (own) {
    owningCommand = await syncCommandId(task.id);
    const marker = JSON.parse(own) as { head: string; mergeHead: string; commandId?: string };
    if (!owningCommand || marker.commandId !== owningCommand) return null;
    if (marker.head === result.head && marker.mergeHead === result.mergeHead) return result;
    // The supervisor may have resolved the host's first conflict and reached
    // the next merge in THIS command. Its current checkpoint can prove that
    // step; a record belonging to any other command must remain inert.
  }

  // A remaining supervisor checkpoint identifies syncs launched
  // before this feature existed. Do not infer provenance merely from MERGE_HEAD.
  const status = await readSupervisorStatusAsync(protocolDir(task.id));
  if (!status && projectRoot) {
    // Older syncs predate the durable marker, and Stop clears status.json.
    // Their retained supervisor log is still a sync-owned record. Require the
    // latest command to be THIS task's sync and both merge endpoints to match.
    const session = await storage.getSessionByTaskId(task.id);
    if (!session) return null;
    const runner = await createInspectionRunner(projectRoot, session.runner_type ?? undefined);
    const logs = await runner.getRunLogs(session.container_name ?? runner.runNameForTask(taskRef(task)), 5000);
    const recordedHead = logs ? syncLogHead(logs, task.id, result.mergeHead) : null;
    if (!recordedHead) return null;
    const resolved = await runGit(['rev-parse', '--verify', recordedHead], { cwd: worktreePath });
    return resolved.exitCode === 0 && resolved.stdout.trim() === result.head ? result : null;
  }
  if (status?.task_id !== task.id || status.command_type !== 'sync') return null;
  if (owningCommand && status.sync_command_id !== owningCommand) return null;
  if (status.sync_merge_sha || status.sync_merge_start_sha) {
    return status.sync_merge_sha === result.mergeHead && status.sync_merge_start_sha === result.head ? result : null;
  }
  if (status.upstream_merge_sha !== result.mergeHead) return null;
  if (![status.pre_turn_sha, status.post_remote_sync_sha].includes(result.head)) return null;
  return result;
}

/** Read only explicit supervisor sync/merge records, never an agent's narrative. */
export function syncLogHead(logs: string, taskId: string, incoming: string): string | null {
  const commands = [...logs.matchAll(/\[supervisor\] Received command: (\w+) for task ([^\s]+)[^\n]*\n/g)];
  const latest = commands.at(-1);
  if (!latest || latest[1] !== 'sync' || latest[2] !== taskId) return null;
  const syncLog = logs.slice(latest.index! + latest[0].length);
  const merges = [...syncLog.matchAll(/\[git\] Merging ([^\s]+)/g)];
  const merge = merges.at(-1);
  if (!merge || merge[1] !== incoming) return null;
  const heads = [...syncLog.slice(0, merge.index).matchAll(/\[(?:merge|remote-sync)\] Pre-merge HEAD: ([a-f0-9]{8,40})(?:\s|$)/g)];
  return heads.at(-1)?.[1] ?? null;
}

/** The dispatch record outlives Stop's status cleanup, but a new turn replaces it. */
export async function syncCommandId(taskId: string): Promise<string | null> {
  try {
    return (await readFile(`${protocolDir(taskId)}.dispatched-command`, 'utf8')).trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read the command owning task ${taskId}'s sync: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Record exact endpoints before a daemon-owned sync merge starts. */
export async function recordUnfinishedSyncMerge(storage: Storage, taskId: string, head: string, mergeHead: string): Promise<void> {
  await storage.updateTaskMetadata(taskId, UNFINISHED_SYNC_MERGE_KEY, JSON.stringify({
    head, mergeHead, commandId: await syncCommandId(taskId),
  }));
}

/** Bind the host's conflicted trial merge to the supervisor that will retry it. */
export async function correlateSyncMerge(storage: Storage, taskId: string, commandId: string): Promise<void> {
  const own = await storage.getTaskMetadata(taskId, UNFINISHED_SYNC_MERGE_KEY);
  if (!own) return;
  const marker = JSON.parse(own) as { head: string; mergeHead: string };
  await storage.updateTaskMetadata(taskId, UNFINISHED_SYNC_MERGE_KEY, JSON.stringify({ head: marker.head, mergeHead: marker.mergeHead, commandId }));
}

/**
 * Close/reject on a worktree stuck mid-merge that lazy cannot prove is its own
 * sync: say exactly what is there and name the confirmed way past it on every
 * surface, instead of sending the person to finish a sync or to git by hand.
 */
export function unprovenMergeRefusalMessage(
  displayTaskId: string, command: 'close' | 'reject', merge: UnfinishedSyncMerge,
  options: { prompting?: boolean; working?: boolean } = {},
): string {
  const verb = command === 'close' ? 'closed' : 'rejected';
  // A running task is never force-aborted (its agent may be the one merging):
  // confirming stops it and discards the worktree with the merge in it.
  const effect = options.working
    ? `The task is running, so confirming stops its agent and discards the worktree with the merge still in it — every commit is kept, the branch stays at ${merge.head.substring(0, 7)}. `
    : `Aborting it keeps every commit — the branch stays at ${merge.head.substring(0, 7)} — and discards the uncommitted merge AND anything else uncommitted in the worktree. `;
  return `Task ${displayTaskId} has a merge in progress in its worktree that lazy cannot confirm came from its own sync:\n` +
    `  HEAD:      ${merge.head}\n` +
    `  incoming:  ${merge.mergeHead} (MERGE_HEAD)\n` +
    `  conflicts: ${merge.conflicts} file${merge.conflicts === 1 ? '' : 's'}\n` +
    effect +
    (options.prompting ? '' : `The task was not ${verb}. `) +
    `To abort the merge and ${command} anyway, confirm it: ` +
    `\`lazy ${command} ${displayTaskId} --accept-dirty-worktree\` (prompted at a terminal), ` +
    `\`accept_dirty_worktree: true\` on lazy_${command}, or "Abort the merge and ${command}" in the dashboard and Lazy Teams.`;
}
