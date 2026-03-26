/**
 * Driver factory — creates the appropriate RepositoryDriver based on config.
 */

import type { ResolvedConfig } from '../config/types';
import type { RepositoryDriver, DriverContext } from './driver';
import type { DriverDetection, DetectRemoteFn } from './driver';
import { LocalDriver } from './local-driver';
import { GitHubDriver, detectGitHub } from './github-driver';
import { GitLabDriver, detectGitLab } from './gitlab-driver';

/**
 * Create the appropriate RepositoryDriver based on the resolved config.
 * Defaults to LocalDriver when remote.driver is 'local' or unrecognized.
 *
 * @param context Optional context providing storage access. When provided,
 *   the driver can check task state (e.g., skip fast-forwarding worktrees
 *   that belong to working tasks).
 */
export function createDriver(config: ResolvedConfig, context?: DriverContext): RepositoryDriver {
  switch (config.remote.driver) {
    case 'local':
      return new LocalDriver(context);
    case 'github':
      return new GitHubDriver(config, undefined, context);
    case 'gitlab':
      return new GitLabDriver(config, undefined, context);
    default:
      throw new Error(`Unknown remote driver: "${config.remote.driver}". Supported drivers: local, github, gitlab`);
  }
}

/**
 * Ordered list of remote detection functions.
 * Each function inspects the repo and claims it if the remote matches.
 * First match wins. Local driver is the implicit fallback (no detection needed).
 */
const remoteDetectors: DetectRemoteFn[] = [
  detectGitHub,
  detectGitLab,
  // Future: detectBitbucket, etc.
];

/**
 * Detect the appropriate remote driver for a repository.
 * Iterates through registered drivers; each one inspects the repo and
 * claims it if the remote matches. Returns null if no driver claims the repo
 * (caller should fall back to local driver).
 * @param remoteName - the git remote name to check (default: 'origin')
 */
export function detectRemote(repoDir: string, remoteName?: string): DriverDetection | null {
  for (const detect of remoteDetectors) {
    const result = detect(repoDir, remoteName);
    if (result) return result;
  }
  return null;
}

export type { RepositoryDriver, DriverContext } from './driver';
export type {
  MergeOptions,
  MergeResult,
  PublishResult,
  RemoteComment,
  PRState,
  HealthCheck,
  DriverDetection,
  DetectRemoteFn,
  DriverConfigOptions,
  DeprecatedConfigOption,
  ImportOptions,
  ImportResult,
  CIJobFailure,
} from './driver';
export { LocalDriver } from './local-driver';
export { GitHubDriver, detectGitHub } from './github-driver';
export type { GhResult, DriverDeps } from './github-driver';
export { GitLabDriver, detectGitLab } from './gitlab-driver';
export type { GlResult, GitLabDriverDeps } from './gitlab-driver';
