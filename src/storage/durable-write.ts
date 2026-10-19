/**
 * Durable atomic file writes for the file store.
 *
 * A temp-file-then-rename write is atomic for READERS, but not durable: the
 * kernel may still hold the file's bytes and the rename in its page cache when
 * the daemon answers. A machine crash then (on a Teams microVM the store sits
 * on a virtiofs mount) loses a write the caller was already told had landed —
 * human feedback included. So the bytes are fsynced before the rename, and the
 * directory after it, before the write resolves.
 *
 * The fs operations go through `DurableFsOps` so a test can record their order.
 */
import { open, rename } from 'fs/promises';

export interface DurableFsOps {
  writeAndSync(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDir(dir: string): Promise<void>;
}

/** Errors a filesystem may raise for fsync on a directory it cannot sync. */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF']);

export const realDurableFsOps: DurableFsOps = {
  async writeAndSync(path, content) {
    const fh = await open(path, 'w');
    try {
      await fh.writeFile(content, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  rename: (from, to) => rename(from, to),
  async syncDir(dir) {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } catch (err) {
      // Some filesystems refuse fsync on a directory handle. The file's own
      // bytes are already synced; there is nothing further we can force here.
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !DIR_SYNC_UNSUPPORTED.has(code)) {
        throw new Error(`failed to fsync directory ${dir}: ${(err as Error).message}`);
      }
    } finally {
      await fh.close();
    }
  },
};

let ops: DurableFsOps = realDurableFsOps;

export function durableFsOps(): DurableFsOps {
  return ops;
}

/** Test seam: replace the fs operations; returns a restore function. */
export function setDurableFsOpsForTest(next: DurableFsOps): () => void {
  const prev = ops;
  ops = next;
  return () => {
    ops = prev;
  };
}
