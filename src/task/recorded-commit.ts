import type { Storage } from '../storage/interface';
import type { Commit, Task } from '../types';

/**
 * Which RECORDED commit of a task `commitId` names — by record id, full SHA, or
 * a SHA prefix of at least 7 hex characters. Never an arbitrary repository
 * object. Shared by the dashboard's commit page and the `commitPatch` RPC so
 * the two agree on every commit URL.
 */
export async function findRecordedCommit(storage: Storage, task: Task, commitId: string): Promise<Commit | null> {
  const session = await storage.getSessionByTaskId(task.id);
  if (!session) return null;
  const commits = await storage.getSessionCommits(session.id);
  return commits.find((c) => c.id === commitId || c.sha === commitId)
    ?? (/^[0-9a-f]{7,}$/i.test(commitId) ? commits.find((c) => c.sha.startsWith(commitId.toLowerCase())) : undefined)
    ?? null;
}
