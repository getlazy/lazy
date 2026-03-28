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
import { homedir } from 'os';
import { basename } from 'path';
import { runGit } from '../utils/git';

/**
 * Extract project name from git remote URL or directory name.
 * @param remoteName - the git remote name to check (default: 'origin')
 */
export function getProjectName(lazyRoot: string, remoteName: string = 'origin'): string {
  try {
    // Try to get remote URL
    const result = runGit(['remote', 'get-url', remoteName], { cwd: lazyRoot });

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
    const config = loadConfig(lazyRoot);
    backend = config.storage.backend;
    externalPath = config.storage.external_path;
    gitRemote = config.remote.git_remote;
  }

  let storage: Storage;

  switch (backend) {
    case 'external': {
      if (!externalPath || externalPath === '') {
        // Default external path
        const projectName = getProjectName(lazyRoot, gitRemote);
        externalPath = join(homedir(), '.lazy', projectName);
      }
      storage = new FileStorage(lazyRoot, { basePath: externalPath });
      break;
    }

    case 'postgres': {
      // Credentials come from environment variables, never from lazy.toml.
      // LAZY_POSTGRES_URL takes priority; falls back to standard PG* env vars.
      const config = loadConfig(lazyRoot);
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
