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
export { OrphanBranchStorage } from './orphan-branch-storage';
export { PostgresStorage } from './postgres-storage';
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
import { OrphanBranchStorage } from './orphan-branch-storage';
import { PostgresStorage } from './postgres-storage';
import type { Storage } from './interface';
import { loadConfig } from '../config/loader';
import { join } from 'path';
import { homedir } from 'os';
import { basename } from 'path';

/**
 * Extract project name from git remote URL or directory name.
 * @param remoteName - the git remote name to check (default: 'origin')
 */
export function getProjectName(lazyRoot: string, remoteName: string = 'origin'): string {
  try {
    // Try to get remote URL
    const result = Bun.spawnSync(['git', 'remote', 'get-url', remoteName], {
      cwd: lazyRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (result.exitCode === 0) {
      const url = result.stdout.toString().trim();
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
 * - 'in-repo': FileStorage with root at <repo>/.lazy/ (default, current behavior)
 * - 'orphan-branch': OrphanBranchStorage backed by a git orphan branch
 * - 'external': FileStorage with root at the configured external path
 * - 'postgres': PostgresStorage backed by PostgreSQL database
 */
export type StorageBackend = 'in-repo' | 'orphan-branch' | 'external' | 'postgres';

export interface CreateStorageOptions {
  /** Storage backend type (default: 'in-repo') */
  backend?: StorageBackend;
  /** Orphan branch name (only used with 'orphan-branch' backend, default: 'lazy-state') */
  branchName?: string;
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
  let branchName = options?.branchName;
  let externalPath = options?.externalPath;

  let gitRemote = 'origin';
  if (!backend) {
    const config = loadConfig(lazyRoot);
    backend = config.storage.backend;
    branchName = config.storage.orphan_branch_name;
    externalPath = config.storage.external_path;
    gitRemote = config.remote.git_remote;
  }

  let storage: Storage;

  switch (backend) {
    case 'orphan-branch':
      storage = new OrphanBranchStorage(lazyRoot, {
        branchName: branchName || 'lazy-state',
      });
      break;

    case 'external':
      if (!externalPath || externalPath === '') {
        // Default external path
        const projectName = getProjectName(lazyRoot, gitRemote);
        externalPath = join(homedir(), '.lazy', projectName);
      }
      storage = new FileStorage(lazyRoot, { basePath: externalPath });
      break;

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

    case 'in-repo':
    default:
      storage = new FileStorage(lazyRoot);
      break;
  }

  await storage.initialize();
  return storage;
}
