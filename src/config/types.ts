import type { ModelName } from '../types';

/** Storage backend types — duplicated here to avoid circular dependency with storage module */
export type StorageBackendConfig = 'in-repo' | 'orphan-branch' | 'external' | 'postgres';

/** Runner types for task execution */
export type RunnerType = 'docker' | 'podman' | 'dangerously-host-process-without-any-isolation';

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
    /** Enable SSL/TLS for PostgreSQL (required for cloud databases like Neon, Supabase) */
    postgres_ssl?: boolean;
  };
  git?: {
    default_branch_prefix?: string;
  };
  output?: {
    shortid_length?: number;
  };
  agent?: {
    agent_id?: string;
    /** Kill agent process if no output for this many ms. 0 = use agent default. */
    watchdog_output_timeout_ms?: number;
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
  runner?: RunnerType | {
    type?: RunnerType;
    docker_agent_root?: boolean;
    docker_agent_no_network?: boolean;
  };
  documents?: {
    path?: string;
  };
  features?: Record<string, boolean>;
  worktree?: {
    include?: string[];
  };
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
    /** Enable SSL/TLS for PostgreSQL (required for cloud databases like Neon, Supabase) */
    postgres_ssl: boolean;
  };
  git: {
    default_branch_prefix: string;
  };
  output: {
    shortid_length: number;
  };
  agent: {
    agent_id: string;
    /** Kill agent process if no output for this many ms. 0 = use agent default. */
    watchdog_output_timeout_ms: number;
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
  runner: {
    type: RunnerType;
    docker_agent_root: boolean;
    docker_agent_no_network: boolean;
  };
  documents: {
    path: string;
  };
  features: Record<string, boolean>;
  worktree: {
    include: string[];
  };
}
