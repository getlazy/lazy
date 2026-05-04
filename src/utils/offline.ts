/**
 * Offline mode state management.
 *
 * Offline mode is a per-project runtime toggle stored as
 * `${projectRoot}/.lazy/offline.json`. When enabled, all remote operations
 * (push, fetch, sync, PR creation) are skipped and the system operates in
 * local-only mode.
 *
 * Per-project because different projects may use different services: one
 * talks to GitLab (offline when on a plane), another uses Ollama locally
 * (always works). Each daemon reads its own project's offline state.
 *
 * This lets users work productively without network access even when
 * their project is configured with a remote driver (GitHub, GitLab).
 * When they come back online, `lazy system online` disables offline mode and
 * normal remote sync resumes.
 */

import { join } from 'path';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';

const OFFLINE_FILENAME = 'offline.json';

export interface OfflineState {
  enabled: boolean;
  enabled_at?: string;
  configured_driver?: string;
}

/**
 * Get the path to the offline state file for a project.
 */
function getOfflineFilePath(dataDir: string): string {
  return join(dataDir, OFFLINE_FILENAME);
}

/**
 * Check if offline mode is currently enabled for this project.
 *
 * @param dataDir - The .lazy data directory (e.g., `${projectRoot}/.lazy`)
 */
export async function isOfflineMode(dataDir: string): Promise<boolean> {
  const filePath = getOfflineFilePath(dataDir);
  try {
    const content = await readFile(filePath, 'utf-8');
    const state: OfflineState = JSON.parse(content);
    return state.enabled === true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Enable or disable offline mode for a project.
 *
 * @param dataDir - The .lazy data directory
 * @param enabled - Whether to enable offline mode
 * @param configuredDriver - The currently configured remote driver (for display when going online)
 */
export async function setOfflineMode(
  dataDir: string,
  enabled: boolean,
  configuredDriver?: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filePath = getOfflineFilePath(dataDir);

  if (enabled) {
    const state: OfflineState = {
      enabled: true,
      enabled_at: new Date().toISOString(),
      ...(configuredDriver ? { configured_driver: configuredDriver } : {}),
    };
    await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } else {
    // Remove the file entirely when going online
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to remove ${filePath}: ${err instanceof Error ? err.message : err}`);
      }
      // File doesn't exist — already online, nothing to do
    }
  }
}

/**
 * Get the full offline status for display purposes.
 *
 * @param dataDir - The .lazy data directory
 */
export async function getOfflineStatus(dataDir: string): Promise<OfflineState> {
  const filePath = getOfflineFilePath(dataDir);
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false };
    throw new Error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`);
  }
}
