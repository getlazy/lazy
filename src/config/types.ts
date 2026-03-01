import type { ModelName } from '../types';

/** Storage backend types — duplicated here to avoid circular dependency with storage module */
export type StorageBackendConfig = 'in-repo' | 'orphan-branch' | 'external';

/** Runner types for task execution */
export type RunnerType = 'docker' | 'dangerously-host-process-without-any-isolation';

export interface LazyConfig {
  models?: {
    default?: ModelName;
  };
  session?: {
    verbose?: boolean;
    debug?: boolean;
    auto_commit_instructions?: boolean;
  };
  data?: {
    path?: string;
  };
  storage?: {
    backend?: StorageBackendConfig;
    orphan_branch_name?: string;
    external_path?: string;
  };
  git?: {
    default_branch_prefix?: string;
  };
  output?: {
    shortid_length?: number;
  };
  agent?: {
    agent_id?: string;
  };
  server?: {
    port?: number;
    sync_interval?: number;
  };
  remote?: {
    driver?: string;
    git_remote?: string;
    github_auto_push?: boolean;
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection?: boolean;
    gitlab_auto_push?: boolean;
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection?: boolean;
  };
  docker?: {
    dockerfile?: string;
    toolchain?: string;
  };
  runner?: RunnerType;
  documents?: {
    path?: string;
  };
  features?: Record<string, boolean>;
}

export interface ResolvedConfig {
  models: {
    default: ModelName;
  };
  session: {
    verbose: boolean;
    debug: boolean;
    auto_commit_instructions: boolean;
  };
  data: {
    path: string;
  };
  storage: {
    backend: StorageBackendConfig;
    orphan_branch_name: string;
    external_path: string;
  };
  git: {
    default_branch_prefix: string;
  };
  output: {
    shortid_length: number;
  };
  agent: {
    agent_id: string;
  };
  server: {
    port: number;
    sync_interval: number;
  };
  remote: {
    driver: string;
    git_remote: string;
    github_auto_push: boolean;
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: boolean;
    gitlab_auto_push: boolean;
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: boolean;
  };
  docker: {
    dockerfile: string;
    toolchain: string;
  };
  runner: RunnerType;
  documents: {
    path: string;
  };
  features: Record<string, boolean>;
}
