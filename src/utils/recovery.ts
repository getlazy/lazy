import { join } from 'path';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { getDataDir } from '../cli/init';

/**
 * Async twin of src/cli/editor.ts's saveRecoveryFile, for use inside the daemon.
 *
 * CLAUDE.md: human feedback must be durably saved BEFORE anything that can fail
 * (agent launch, container start, network) gets a chance to lose it. The CLI
 * version is sync because it runs once at CLI startup; the daemon must never
 * block its event loop, so this one is async and takes an explicit project root
 * (the daemon does not sit inside the user's cwd).
 *
 * Returns the recovery file path, or null if the write itself failed — callers
 * treat null as "no recovery file", never as "feedback is safe".
 */
export async function saveRecoveryFileAsync(
  projectRoot: string,
  content: string,
  tag: string,
): Promise<string | null> {
  try {
    const recoveryDir = join(projectRoot, getDataDir(projectRoot), 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveryPath = join(recoveryDir, `${tag}-${timestamp}.md`);
    await writeFile(recoveryPath, content, 'utf-8');
    return recoveryPath;
  } catch {
    // A recovery file is a belt-and-braces backup of feedback that is also
    // being persisted through Storage. If the backup itself cannot be written
    // we must not abort the operation that carries the real feedback — the
    // caller degrades to "no recovery path" and continues.
    return null;
  }
}

/**
 * Remove a recovery file once its content is durably persisted elsewhere.
 */
export async function removeRecoveryFileAsync(recoveryPath: string): Promise<void> {
  try {
    await unlink(recoveryPath);
  } catch {
    // Already gone (double-removal, manual cleanup) — nothing to recover.
  }
}
