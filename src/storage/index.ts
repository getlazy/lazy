/**
 * Storage module
 *
 * This module provides a clean abstraction over data storage.
 * All storage operations should go through the Storage interface.
 *
 * Usage:
 *   import { createStorage } from './storage';
 *
 *   const storage = await createStorage(lazyRoot);
 *   try {
 *     const task = await storage.createTask('My task');
 *     // ... use storage
 *   } finally {
 *     await storage.close();
 *   }
 */

export { FileStorage } from './file-storage';
export { RemoteStorage } from './remote-storage';
export type { Storage } from './interface';
export type {
  Task,
  Session,
  Turn,
  MergeConflict,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  Note,
  JournalEntry,
  RaisedItem,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnRole,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  TaskCodeEntry,
  StorageVersion,
  SearchResult,
  StoredConversation,
  ConversationSummary,
  StoredMessage,
  StoredSubagent,
  ConversationStats,
  ScratchFile,
  ScratchFileInput,
  ScratchSkipReason,
  StatusChange,
} from './types';

import { FileStorage } from './file-storage';
import type { Storage } from './interface';
import { loadConfig } from '../config/loader';
import { join } from 'path';
import { basename } from 'path';
import { getHome } from '../utils/home';
import { existsSync, mkdirSync } from 'fs';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

/** Actionable error when lazy.toml still names the removed postgres backend. */
export const POSTGRES_BACKEND_REMOVED =
  'Storage backend "postgres" was removed in v0.22. Export your store with the last release that has it, ' +
  'or switch to backend = "external" (file storage). SQLite storage is the go-forward second backend.';

/**
 * Extract project name from git remote URL or directory name.
 * @param remoteName - the git remote name to check (default: 'origin')
 */
export async function getProjectName(lazyRoot: string, remoteName: string = 'origin'): Promise<string> {
  try {
    // Try to get remote URL
    const result = await runGit(['remote', 'get-url', remoteName], { cwd: lazyRoot });

    if (result.exitCode === 0) {
      const url = result.stdout;
      // Extract repo name from various URL formats
      const match = url.match(/\/([^/]+?)(\.git)?$/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Ignore errors, fall back to directory name
  }

  return basename(lazyRoot);
}

/**
 * Storage backend types:
 * - 'external': FileStorage with root at the configured external path (default)
 */
export type StorageBackend = 'external';

export interface CreateStorageOptions {
  /** Storage backend type (default: 'external') */
  backend?: StorageBackend;
  /** External storage path (only used with 'external' backend) */
  externalPath?: string;
  /**
   * Fail after this long waiting for the storage lock instead of running the
   * default retry loop (only used with the 'external' backend, which is the
   * only one with a file lock). Reserved for read-only diagnostics that must
   * not block — `lazy doctor`. Every other caller should queue.
   */
  lockTimeoutMs?: number;
}

/**
 * Create and initialize a storage instance.
 * Can be called with explicit options or will read from config.
 */
export async function createStorage(lazyRoot: string, options?: CreateStorageOptions): Promise<Storage> {
  // If options not provided, read from config
  let backend = options?.backend;
  let externalPath = options?.externalPath;

  let gitRemote = 'origin';
  if (!backend) {
    const config = await loadConfig(lazyRoot);
    backend = config.storage.backend;
    externalPath = config.storage.external_path;
    gitRemote = config.remote.git_remote;
  }

  let storage: Storage;

  // Loader rejects postgres in lazy.toml; this catches explicit callers that bypass it.
  if (String(backend) === 'postgres') {
    throw new Error(POSTGRES_BACKEND_REMOVED);
  }

  switch (backend) {
    case 'external': {
      if (!externalPath || externalPath === '') {
        // Default external path: ~/.lazy/<projectName>
        const home = getHome();
        const lazyDir = join(home, '.lazy');

        // Verify the home directory is accessible. On cross-platform VMs
        // (e.g., Lima on macOS host), getHome() may return the host OS path
        // (e.g., /Users/...) which doesn't exist on the Linux guest.
        if (!existsSync(home)) {
          throw new Error(
            `Cannot create default storage path: home directory "${home}" does not exist.\n` +
            `This typically happens on VMs where the OS-reported home differs from the actual filesystem.\n` +
            `Fix: set external_path in your lazy.toml under [storage], e.g.:\n\n` +
            `  [storage]\n` +
            `  external_path = "${join('/home', basename(home), '.lazy', await getProjectName(lazyRoot, gitRemote))}"\n`,
          );
        }

        // Ensure ~/.lazy/ exists before deriving the project subdir
        try {
          mkdirSync(lazyDir, { recursive: true });
        } catch (err: any) {
          throw new Error(
            `Cannot create storage directory "${lazyDir}": ${err.message}\n` +
            `Fix: set external_path in your lazy.toml under [storage] to a writable path.`,
          );
        }

        const projectName = await getProjectName(lazyRoot, gitRemote);
        externalPath = join(lazyDir, projectName);
      }
      // Detect stray literal-`~` directories left over from the pre-fix bug
      // where unexpanded `~/...` paths were passed to mkdir. The data inside
      // is orphan output — nothing reads from it — but we don't auto-clean,
      // just warn so the user can remove it deliberately.
      const strayTilde = join(lazyRoot, '~');
      if (existsSync(strayTilde)) {
        logger.warn(
          `Detected a literal '~' directory at ${strayTilde}. ` +
          `This is stale orphan output from an earlier tilde-expansion bug ` +
          `and can be safely removed: rm -rf "${strayTilde}"`,
        );
      }
      storage = new FileStorage(lazyRoot, {
        basePath: externalPath,
        lockTimeoutMs: options?.lockTimeoutMs,
      });
      break;
    }

    default:
      throw new Error(`Unknown storage backend: "${backend}". Valid backend is "external".`);
  }

  await storage.initialize();
  return storage;
}
