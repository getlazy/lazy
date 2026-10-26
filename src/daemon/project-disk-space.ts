import { createHash } from 'crypto';
import type { Storage } from '../storage';
import { currentDiskSpaceManager, DiskSpaceError, type DiskSpaceView } from '../docker/disk-space';
import { terminalCleanupFor } from './terminal-cleanup';

/** Docker pruning is private-engine only. Finished-task cleanup also works
 * on shared-engine and host-process projects, using their own task resources. */
export async function projectDiskSpace(root: string, storage: Storage, recoveryOnly = false) {
  const cleanup = await terminalCleanupFor(root, storage).view();
  const docker = currentDiskSpaceManager();
  let disk;
  let dockerError: string | undefined;
  try { disk = docker ? await (recoveryOnly ? docker.recoveryStatus() : docker.view()) : null; }
  catch (e) {
    if (!recoveryOnly) throw e;
    dockerError = e instanceof Error ? e.message : String(e);
    disk = docker ? await docker.recoveryStatus() : null;
  }
  const dockerPlan = disk && 'plan' in disk ? (disk as DiskSpaceView).plan : null;
  const id = createHash('sha256').update(JSON.stringify([dockerPlan?.id ?? null, cleanup.plan.id])).digest('hex');
  const items = [...(dockerPlan?.items ?? []), ...cleanup.plan.items];
  return { ...disk, supported: true, dockerSupported: !!docker, dockerError,
    terminalCleanup: cleanup, plan: { id, items,
      reclaimableBytes: (dockerPlan?.reclaimableBytes ?? 0) + cleanup.plan.reclaimableBytes },
    // Internal component ids never authorize removals without a fresh view.
    dockerPlanId: dockerPlan?.id, cleanupPlanId: cleanup.plan.id };
}

export async function reclaimProjectDiskSpace(root: string, storage: Storage, planId: string) {
  // A full engine may be unable to size Docker objects. Its recovery-only
  // preview still permits finished-task cleanup, without Docker removals.
  let view;
  try { view = await projectDiskSpace(root, storage); }
  catch { view = await projectDiskSpace(root, storage, true); }
  if (view.plan.id !== planId) {
    const filesOnly = await projectDiskSpace(root, storage, true);
    if (filesOnly.plan.id === planId) view = filesOnly;
  }
  if (view.plan.id !== planId) throw new DiskSpaceError(409, 'What can be freed has changed. Open Free space again.');
  const docker = currentDiskSpaceManager();
  const result = docker && view.dockerPlanId ? await docker.reclaim('Free space', view.dockerPlanId) : { freedBytes: 0 };
  const cleanup = await terminalCleanupFor(root, storage).run('Free space', view.cleanupPlanId);
  return { freedBytes: result.freedBytes + cleanup.freedBytes, estimated: cleanup.freedBytes > 0, errors: cleanup.errors };
}
