import { checkProjectStoreOwnership, FileStorage, resolveStorePath, type Storage } from '../storage';
import { UnownedStoreError } from '../storage/store-owner';

/** Re-read the backend's refusal after startup failed; never infer it from error text. */
export async function unownedProjectStore(root: string): Promise<UnownedStoreError | null> {
  try {
    await checkProjectStoreOwnership(root);
    return null;
  } catch (err) {
    if (err instanceof UnownedStoreError) return err;
    throw new Error(`Cannot verify store ownership: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
}

/** Local maintenance while the daemon is stopped; never an RPC or MCP write. */
export async function rehomeProjectStore(root: string, previousProject: string): Promise<void> {
  // Do not initialize: the existing owner is precisely what this explicit
  // transfer replaces. The backend compares --from while holding its lock.
  const storage: Storage = new FileStorage(root, {
    basePath: await resolveStorePath(root), lockTimeoutMs: 100,
  });
  try {
    await storage.rehomeOwnership(previousProject);
  } finally {
    await storage.close();
  }
}
