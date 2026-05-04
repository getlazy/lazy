/** Ollama configuration for local model inference. */
export type OllamaConfig = ResolvedConfig['ollama'];

/** Storage backend types — duplicated here to avoid circular dependency with storage module */
export type StorageBackendConfig = 'external' | 'postgres';

/** Runner types for task execution */
export type RunnerType = 'docker' | 'podman' | 'dangerously-host-process-without-any-isolation';

/**
 * Claude Code `--effort` levels. Controls how hard the model thinks before responding.
 * Higher levels spend more tokens on internal reasoning before emitting output.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const VALID_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface LazyConfig {
  models?: {
    default?: string;
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
    /** Default reasoning effort level passed to Claude Code via --effort for task agents. */
    effort?: EffortLevel;
  };
  builder?: {
    /** Default reasoning effort level passed to Claude Code via --effort for builder sessions. */
    effort?: EffortLevel;
  };
  server?: {
    port?: number;
    sync_interval?: number;
  };
  remote?: {
    driver?: string;
    git_remote?: string;
    auto_approve?: boolean;
    github_auto_push?: boolean;
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection?: boolean;
    gitlab_auto_push?: boolean;
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection?: boolean;
  };
  docker?: {
    dockerfile?: string;
  };
  runner?: RunnerType | {
    type?: RunnerType;
  };
  documents?: {
    path?: string;
  };
  features?: Record<string, boolean>;
  worktree?: {
    include?: string[];
  };
  permissions?: {
    protected?: string[];
  };
  checks?: {
    /** Command to run after each agent turn. Output is captured and attached to the turn. */
    post_turn?: string;
    /** Timeout in seconds for post_turn check command (default: 300). */
    post_turn_timeout?: number;
  };
  ollama?: {
    enabled?: boolean;
    /** Model name to pass to Claude Code via --model (e.g., "qwen3.5:35b-a3b-coding-nvfp4") */
    model?: string;
    /** Ollama API endpoint (e.g., "http://host.docker.internal:11434") */
    endpoint?: string;
  };
  daemon?: {
    /** React to CI failures (default: true). */
    auto_react_ci?: boolean;
    /** React to PR comments (default: true). */
    auto_react_comments?: boolean;
    /** Maximum auto-unblocks per task per trigger type before escalating to human (default: 3). */
    auto_react_max_retries?: number;
    /** Backoff strategy for repeated auto-unblocks: "none", "linear", or "exponential" (default: "exponential"). */
    auto_react_backoff?: 'none' | 'linear' | 'exponential';
    /** Maximum auto-triggered turns per day across all tasks in the project (default: 50). */
    auto_react_daily_budget?: number;
    /** Maximum consecutive auto-triggered turns per task before pausing for human review (default: 3). */
    max_auto_turns?: number;
  };
}

export interface ResolvedConfig {
  models: {
    default: string;
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
    /** Default reasoning effort level passed to Claude Code via --effort for task agents. */
    effort: EffortLevel;
  };
  builder: {
    /** Default reasoning effort level passed to Claude Code via --effort for builder sessions. */
    effort: EffortLevel;
  };
  server: {
    port: number;
    sync_interval: number;
  };
  remote: {
    driver: string;
    git_remote: string;
    auto_approve: boolean;
    github_auto_push: boolean;
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: boolean;
    gitlab_auto_push: boolean;
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: boolean;
  };
  docker: {
    dockerfile: string;
  };
  runner: {
    type: RunnerType;

  };
  documents: {
    path: string;
  };
  features: Record<string, boolean>;
  worktree: {
    include: string[];
  };
  permissions: {
    protected: string[];
  };
  checks: {
    /** Command to run after each agent turn. Output is captured and attached to the turn. */
    post_turn: string;
    /** Timeout in seconds for post_turn check command (default: 300). */
    post_turn_timeout: number;
  };
  ollama: {
    enabled: boolean;
    /** Model name to pass to Claude Code via --model (e.g., "qwen3.5:35b-a3b-coding-nvfp4") */
    model: string;
    /** Ollama API endpoint (e.g., "http://host.docker.internal:11434") */
    endpoint: string;
  };
  daemon: {
    /** React to CI failures (default: true). */
    auto_react_ci: boolean;
    /** React to PR comments (default: true). */
    auto_react_comments: boolean;
    /** Maximum auto-unblocks per task per trigger type before escalating to human (default: 3). */
    auto_react_max_retries: number;
    /** Backoff strategy for repeated auto-unblocks: "none", "linear", or "exponential" (default: "exponential"). */
    auto_react_backoff: 'none' | 'linear' | 'exponential';
    /** Maximum auto-triggered turns per day across all tasks in the project (default: 50). */
    auto_react_daily_budget: number;
    /** Maximum consecutive auto-triggered turns per task before pausing for human review (default: 3). */
    max_auto_turns: number;
  };
}
