/**
 * File system utilities for async operations.
 *
 * Provides common async file system helpers to avoid repetitive patterns.
 */

import { stat, mkdir, readFile, writeFile, readdir, unlink, copyFile, chmod, rm, rename } from 'fs/promises';

/**
 * Check if a path exists (file or directory).
 * Returns true if the path exists, false otherwise.
 *
 * This is the async equivalent of existsSync() from the 'fs' module.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path exists and is a directory.
 * Returns true if the path exists and is a directory, false otherwise.
 */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * This is the async equivalent of mkdirSync(path, { recursive: true }).
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Safely read a file, returning null if it doesn't exist.
 * This avoids the try/catch boilerplate for "file might not exist" patterns.
 */
export async function readFileSafe(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string | null> {
  try {
    return await readFile(path, encoding);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Safely unlink a file, ignoring ENOENT errors.
 * This is useful for cleanup operations where the file may already be gone.
 */
export async function unlinkSafe(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Atomically write a file by writing to a temp file and renaming.
 * This is the async equivalent of the common write+rename pattern.
 */
export async function writeFileAtomic(path: string, data: string, tmpPath: string): Promise<void> {
  await writeFile(tmpPath, data, 'utf-8');
  await rename(tmpPath, path);
}

// Re-export commonly used fs/promises functions for convenience
export { stat, mkdir, readFile, writeFile, readdir, unlink, copyFile, chmod, rm, rename };
