/** Ollama configuration for local model inference. */
export type OllamaConfig = ResolvedConfig['ollama'];

/**
 * Model backend for a per-role target.
 * - `anthropic`: real Anthropic API (or whatever CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY point at).
 * - `ollama`: local Ollama serving the Anthropic Messages API (dummy credentials).
 * - `proxy`: an Anthropic-compatible proxy endpoint, forwarded with the real credential.
 *
 * All three are Anthropic-native targets — lazy never translates between API shapes.
 */
export type RoleBackend = 'anthropic' | 'ollama' | 'proxy';

export const VALID_ROLE_BACKENDS: readonly RoleBackend[] = ['anthropic', 'ollama', 'proxy'] as const;

/** The two model roles lazy distinguishes: the interactive builder vs. task agents. */
export type RoleName = 'builder' | 'agent';

/** A per-role model target as written in lazy.toml `[models.roles.*]` (all optional). */
export interface RoleTargetConfig {
  backend?: RoleBackend;
  model?: string;
  endpoint?: string;
}

/**
 * A fully-resolved per-role model target (produced by the config loader).
 * Always present for both roles after `loadConfig`.
 */
export interface RoleTarget {
  backend: RoleBackend;
  /**
   * Model passed to the agent via `--model`. For the `anthropic` backend an
   * empty string means "use the normal model chain / models.default". For
   * `ollama`/`proxy` it is the authoritative model name (never substituted).
   */
  model: string;
  /** ANTHROPIC_BASE_URL for `ollama`/`proxy` backends. Empty for `anthropic`. */
  endpoint: string;
}

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

/**
 * Conversational verbosity ("chattiness") baseline for the builder and agents.
 * Controls how much they narrate, explain, and elaborate in their replies — not
 * how hard they think (that is `effort`). Levels are ordered least→most verbose.
 */
export type ChattinessLevel = 'terse' | 'normal' | 'chatty';

export const VALID_CHATTINESS_LEVELS: readonly ChattinessLevel[] = ['terse', 'normal', 'chatty'] as const;

/**
 * A single maintained-file group. The inverse of a protected pattern: files
 * agents are *expected* to keep up to date as they work (docs, CHANGELOG,
 * architecture diagrams). Agents may skip them, but a turn that touches none of
 * `pattern`'s files earns a one-shot follow-up nudge from the supervisor.
 *
 * `title` and `instructions` are surfaced to the agent (up-front context and in
 * the follow-up prompt) so it understands *what* to maintain and *why*.
 */
export interface MaintainEntry {
  /** Short human label for the group (e.g. "changelog"). */
  title: string;
  /** Glob pattern matched against the turn's changed files (e.g. "CHANGELOG.md"). */
  pattern: string;
  /** Why/how to maintain these files — shown to the agent verbatim. */
  instructions: string;
}

export interface LazyConfig {
  models?: {
    default?: string;
    /** Per-role model targets. When set, they override the legacy [ollama] block for that role. */
    roles?: {
      builder?: RoleTargetConfig;
      agent?: RoleTargetConfig;
    };
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
    /**
     * Max time to wait for the agent process to exit after it signals end-of-turn
     * (lazy_commit). 0 = disabled. Default 60000 (60s).
     */
    graceful_exit_timeout_ms?: number;
    /** Default reasoning effort level passed to Claude Code via --effort for task agents. */
    effort?: EffortLevel;
  };
  builder?: {
    /** Default reasoning effort level passed to Claude Code via --effort for builder sessions. */
    effort?: EffortLevel;
  };
  chattiness?: {
    /** Shared baseline verbosity for both builder and agents, used when a per-role value is absent. */
    default?: ChattinessLevel;
    /** Baseline verbosity for builder sessions. Overrides `default` when set. */
    builder?: ChattinessLevel;
    /** Baseline verbosity for task agents. Overrides `default` when set. */
    agent?: ChattinessLevel;
  };
  server?: {
    port?: number;
    sync_interval?: number;
    bind?: string;
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
  automation?: {
    /** Files agents are nudged to keep up to date (docs, CHANGELOG, etc.). Opt-in; empty by default. */
    maintain?: MaintainEntry[];
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
    /**
     * Fully-resolved per-role model targets. Always present after loadConfig:
     * resolved from explicit [models.roles.*], else the legacy [ollama] block
     * (maps to all roles → ollama), else the anthropic default.
     */
    roles: {
      builder: RoleTarget;
      agent: RoleTarget;
    };
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
    /**
     * Max time to wait for the agent process to exit after it signals end-of-turn
     * (lazy_commit). 0 = disabled.
     */
    graceful_exit_timeout_ms: number;
    /** Default reasoning effort level passed to Claude Code via --effort for task agents. */
    effort: EffortLevel;
  };
  builder: {
    /** Default reasoning effort level passed to Claude Code via --effort for builder sessions. */
    effort: EffortLevel;
  };
  chattiness: {
    /** Shared baseline verbosity. '' means unset — no verbosity snippet is injected (today's behavior). */
    default: ChattinessLevel | '';
    /** Per-role override for builder sessions. '' means inherit `default`. */
    builder: ChattinessLevel | '';
    /** Per-role override for task agents. '' means inherit `default`. */
    agent: ChattinessLevel | '';
  };
  server: {
    port: number;
    sync_interval: number;
    /**
     * Network interface the daemon's TCP web/MCP/RPC server binds to.
     * Defaults to '127.0.0.1' (loopback only) so the unauthenticated
     * dashboard and the /mcp + /rpc endpoints are NOT reachable from other
     * machines. Set to '0.0.0.0' (or a specific interface IP) only to
     * deliberately expose the daemon to the LAN/remote hosts.
     */
    bind: string;
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
  automation: {
    /** Files agents are nudged to keep up to date (docs, CHANGELOG, etc.). Opt-in; empty by default. */
    maintain: MaintainEntry[];
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
