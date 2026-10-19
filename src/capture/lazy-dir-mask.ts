/**
 * Hide the project's lazy data dir (`<root>/.lazy`) inside a container that
 * bind-mounts the project root read-only.
 *
 * The read-only root mount lets an agent read source, but `.lazy/` under it
 * holds what no agent may read: the builder's Claude config (seeded from the
 * human's `~/.claude.json`, MCP server secrets included), the proxy audit log,
 * other tasks' worktrees and transcripts. An empty tmpfs goes over it; a
 * container's OWN worktree, which lives beneath it, is bound back on top
 * (docker mounts in destination-depth order, tmpfs included). Nothing else a
 * container uses lives there: the split git mounts are under `.git`, and the
 * agent homes are bound at /home/user paths.
 *
 * Pure argv helpers, so every container builder stays inspectable without
 * Docker or a filesystem; resolving which dir exists is the async caller's job.
 */
import { stat } from 'fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'path';
import { LAZY_DIR, LEGACY_DIR } from '../project-paths';

/** The tmpfs argv masking `dataDirPath`, or nothing when there is none to mask. */
export function lazyDataDirMaskArgs(dataDirPath: string | null): string[] {
  return dataDirPath ? ['--tmpfs', `${dataDirPath}:rw,size=1m,mode=0755`] : [];
}

/**
 * The data dir a task worktree lives in (`<root>/<data>/worktrees/<name>` →
 * `<root>/<data>`), read off the path alone. null when the worktree is not laid
 * out under the root that way — then nothing is masked rather than guessed.
 */
export function dataDirOfWorktree(repoRoot: string, worktreePath: string): string | null {
  if (!worktreePath) return null;
  const worktrees = dirname(worktreePath);
  if (basename(worktrees) !== 'worktrees') return null;
  const dataDir = dirname(worktrees);
  const rel = relative(repoRoot, dataDir);
  if (rel !== LAZY_DIR && rel !== LEGACY_DIR) return null;
  return isAbsolute(rel) ? null : dataDir;
}

/** The project's existing data dir (`.lazy`, else legacy `.workshop`), or null. */
export async function resolveLazyDataDir(repoRoot: string): Promise<string | null> {
  for (const name of [LAZY_DIR, LEGACY_DIR]) {
    const path = join(repoRoot, name);
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`could not inspect ${path}: ${(err as Error).message}`, { cause: err });
      }
    }
  }
  return null;
}
