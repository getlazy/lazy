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
export { PostgresStorage } from './postgres-storage';
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
  FollowUp,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnRole,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  StorageVersion,
  SearchResult,
  StoredConversation,
  StoredMessage,
  StoredSubagent,
  ConversationStats,
  StatusChange,
} from './types';

import { FileStorage } from './file-storage';
import { PostgresStorage } from './postgres-storage';
import type { Storage } from './interface';
import { loadConfig } from '../config/loader';
import { join } from 'path';
import { basename } from 'path';
import { getHome } from '../utils/home';
import { existsSync, mkdirSync } from 'fs';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';

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
 * - 'postgres': PostgresStorage backed by PostgreSQL database
 */
export type StorageBackend = 'external' | 'postgres';

export interface CreateStorageOptions {
  /** Storage backend type (default: 'external') */
  backend?: StorageBackend;
  /** External storage path (only used with 'external' backend) */
  externalPath?: string;
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
      storage = new FileStorage(lazyRoot, { basePath: externalPath });
      break;
    }

    case 'postgres': {
      // Credentials come from environment variables, never from lazy.toml.
      // LAZY_POSTGRES_URL takes priority; falls back to standard PG* env vars.
      const config = await loadConfig(lazyRoot);
      storage = new PostgresStorage(lazyRoot, {
        url: process.env.LAZY_POSTGRES_URL,
        host: process.env.PGHOST,
        port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl: config.storage.postgres_ssl,
      });
      break;
    }

    default:
      throw new Error(`Unknown storage backend: "${backend}". Valid backends are "external" and "postgres".`);
  }

  await storage.initialize();
  return storage;
}
