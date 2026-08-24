import type { ProxyPolicyConfig } from '../proxy/policy';

/** Ollama configuration for local model inference. */
export type OllamaConfig = ResolvedConfig['ollama'];

/**
 * Fully-resolved mechanistic proxy policy (§6.3 layer 1). Alias of the engine's
 * config shape (src/proxy/policy.ts) — the loader produces this and the proxy
 * server consumes it directly.
 */
export type ResolvedProxyPolicy = ProxyPolicyConfig;

/**
 * Model backend for a per-role target.
 * - `anthropic`: real Anthropic API (or whatever CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY point at).
 * - `ollama`: local Ollama serving the Anthropic Messages API (no credential needed).
 * - `proxy`: another Anthropic-compatible endpoint, forwarded with the real credential.
 *
 * All three are Anthropic-native targets — lazy never translates between API shapes.
 *
 * The backend chooses the UPSTREAM and the credential it gets; it never chooses
 * whether the role is proxied. Every role's traffic goes through lazy's proxy,
 * which then forwards it to that upstream.
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
  /**
   * The upstream lazy's PROXY forwards this role's traffic to. Empty means "the
   * proxy's primary upstream" (`[proxy] upstream`, i.e. api.anthropic.com).
   *
   * NEVER an address the launched agent dials itself, and never turned into an
   * env var — see src/proxy/role-upstreams.ts for the routing and
   * src/utils/role-target.ts for the env it does (not) produce. Host-perspective
   * by definition, because the daemon makes the upstream call.
   */
  endpoint: string;
  /**
   * Live lazy-proxy base URL to route this role's traffic through, filled in at
   * launch when the (always-on) proxy is running.
   *
   * The ONLY base URL a launch ever receives, for every backend — an ollama role
   * and a role pinned at an explicit `endpoint` get this address too, and the
   * proxy forwards them onward. There is no backend for which this is skipped.
   *
   * Undefined does NOT mean "connect direct" — the proxy is always on and has
   * no off switch. It means either that the launching process inherits an
   * already-proxied `ANTHROPIC_BASE_URL` from its parent (the supervisor's own
   * runner carries no role targets — see ANTHROPIC_DEFAULT_TARGET), or that the
   * daemon RPC is bypassed by design (test harness / daemon-self). Every launch
   * path that OWNS the proxy decision resolves the address through
   * `daemon/auth-env.ts` and FAILS (ProxyUnavailableError) when it cannot,
   * rather than leaving this undefined and connecting direct.
   */
  proxyUrl?: string;
}

/** Storage backend types — duplicated here to avoid circular dependency with storage module */
export type StorageBackendConfig = 'external' | 'postgres';

/** Runner types for task execution */
export type RunnerType = 'docker' | 'podman' | 'dangerously-host-process-without-any-isolation';

/** All canonical runner type values. */
export const VALID_RUNNER_TYPES: readonly RunnerType[] = ['docker', 'podman', 'dangerously-host-process-without-any-isolation'] as const;

/**
 * Friendly CLI/MCP aliases mapped to canonical {@link RunnerType} values.
 * Accepts the short, human-typeable names (`host`, `docker`, `container`,
 * `podman`) as well as the canonical values themselves. The full
 * `dangerously-host-process-without-any-isolation` string is intentionally
 * verbose in lazy.toml, so `host` is the friendly alias for it.
 */
export const RUNNER_ALIASES: Readonly<Record<string, RunnerType>> = {
  host: 'dangerously-host-process-without-any-isolation',
  'dangerously-host-process-without-any-isolation': 'dangerously-host-process-without-any-isolation',
  docker: 'docker',
  container: 'docker',
  podman: 'podman',
};

/**
 * Resolve a friendly runner alias (or canonical value) to a {@link RunnerType}.
 * Case-insensitive and whitespace-tolerant. Returns null for unknown values so
 * callers can produce an actionable error listing the accepted aliases.
 */
export function resolveRunnerType(input: string): RunnerType | null {
  return RUNNER_ALIASES[input.trim().toLowerCase()] ?? null;
}

/** Human-readable list of accepted runner aliases, for error messages. */
export const RUNNER_ALIAS_HINT = 'host, docker, container, podman';

/**
 * Permission posture for HOST execution (host-process runner only; ignored for
 * docker/podman, where the container is the boundary).
 *   - 'sandbox' (default): Claude Code's OS sandbox (Seatbelt/bubblewrap) is the
 *     hard boundary. Agents run sandbox + bypass (never hang); the interactive
 *     builder runs sandbox + prompts on escape.
 *   - 'bypass': full `--dangerously-skip-permissions`, no sandbox. Opt-in only.
 * See src/runner/host-sandbox.ts.
 */
export type HostPermissionMode = 'sandbox' | 'bypass';

export const VALID_HOST_PERMISSION_MODES: readonly HostPermissionMode[] = ['sandbox', 'bypass'] as const;

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
 * Strictness of the start-time git LFS environment check.
 *
 * `"refuse"` is the default because the failure it prevents is silent: git
 * commits raw file content instead of an LFS pointer without erroring, and the
 * damage is only discovered when a push is rejected. `"warn"` and `"off"` exist
 * for repositories that carry `filter=lfs` attributes but deliberately do not
 * run LFS locally — never as a way to make a real breakage quieter.
 */
export type LfsCheckMode = 'refuse' | 'warn' | 'off';

export const VALID_LFS_CHECK_MODES: readonly LfsCheckMode[] = ['refuse', 'warn', 'off'] as const;

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

/**
 * A single custom mount ([[mounts]]) injected into task agent containers.
 *
 * Either a bind mount (a host `source` path) or a container-local `volume`
 * (named or anonymous). Both `source` and `target` accept the `{worktree}` and
 * `{repo}` placeholders, expanded at launch time. See `src/capture/mounts.ts`
 * for validation and `docker run -v` argument construction.
 */
/**
 * Accept-time validation ([automation.pre_accept]). OPT-IN: `enabled` defaults
 * to false, because the step costs a full agent turn on every accept and the
 * accept path blocks on it.
 *
 * A single agent turn that
 * runs when a task is being accepted, BEFORE the merge — the home for expensive
 * one-time validation (full test suite, build) and for maintained-files
 * completeness (the CHANGELOG entry, written once against the final diff). The
 * turn always includes a built-in post-mortem (recorded to the task journal);
 * that is not configurable.
 *
 * `commands` are the merge GATE: the supervisor re-runs them after the agent's
 * turn, and a non-zero exit aborts the accept and returns the task to blocked.
 */
export interface PreAcceptConfig {
  /** Run the pre-accept turn at all. Default false — opt in to pay a turn per accept. */
  enabled?: boolean;
  /** Gate commands run (in order) after the agent turn; first non-zero exit aborts the merge. */
  commands?: string[];
  /** Timeout in seconds for EACH gate command (default: 600). */
  timeout?: number;
}

export interface MountConfigEntry {
  /** "bind" (default) mounts a host path; "volume" uses a container-local Docker volume. */
  type?: 'bind' | 'volume';
  /** Host path for bind mounts (absolute or project-relative). Required for bind; invalid for volume. */
  source?: string;
  /** Volume name for a named volume. Omit for an anonymous volume. Only valid for type = "volume". */
  name?: string;
  /** Absolute container path to mount at. Supports {worktree} and {repo}. Required. */
  target: string;
  /** Mount read-only (default false). */
  readonly?: boolean;
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
    /**
     * What to do when a task starts in a repository that uses git LFS but
     * whose LFS filter would not actually run. `"refuse"` (default) blocks the
     * start, `"warn"` records a warning and starts anyway, `"off"` disables the
     * check. The accept-time pointer guard is NOT affected by this key — a raw
     * blob on an LFS path is refused at merge regardless.
     */
    lfs_check?: LfsCheckMode;
  };
  output?: {
    shortid_length?: number;
  };
  agent?: {
    agent_id?: string;
    /**
     * Kill the agent process after this many ms without progress. For agents
     * with an activity stream (Claude Code) "progress" means a forward-progress
     * event, not merely bytes; for others it means any output.
     * 0 = use agent default.
     */
    watchdog_output_timeout_ms?: number;
    /**
     * Max time to wait for the agent process to exit AFTER it emitted its final
     * result. The summary is already captured at that point, so this kill loses
     * nothing. 0 = disabled. Default 60000 (60s).
     */
    wind_down_timeout_ms?: number;
    /**
     * @deprecated Renamed to `wind_down_timeout_ms`. Still read (and mapped) so
     * existing lazy.toml files keep working — the old name described a timer
     * armed by `lazy_commit`, which no longer signals end-of-turn.
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
    /**
     * Permanent offline mode. When true, all remote operations (push, fetch,
     * sync, PR creation) are skipped indefinitely — NOT subject to the
     * local-midnight auto-expiry that the `lazy system offline` command uses.
     * For users who genuinely want to stay offline. Default false.
     */
    offline?: boolean;
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
    /** Host execution permission posture: "sandbox" (default) or "bypass". */
    permission_mode?: HostPermissionMode;
    /** Network allowlist for the host sandbox (default ["*.anthropic.com"]). */
    sandbox_allowed_domains?: string[];
    /**
     * EXTRA paths to deny the Read tool, merged with the built-in sensitive
     * defaults (~/.ssh, ~/.aws, …). Confines the file tools, which bypass the
     * OS sandbox. See src/runner/host-sandbox.ts.
     */
    sandbox_deny_read?: string[];
    /**
     * EXTRA paths to deny the Write/Edit tools, merged with the built-in
     * sensitive defaults. See src/runner/host-sandbox.ts.
     */
    sandbox_deny_write?: string[];
    /**
     * Allow Claude Code's weaker nested sandbox so bubblewrap runs inside an
     * unprivileged container (no user namespaces). Weakens isolation — opt-in.
     */
    sandbox_allow_weaker_nested?: boolean;
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
  /**
   * Protected branches: merges into a protected branch require a
   * human-recorded approval (`lazy approve <task>`) before `lazy accept`
   * will complete. This is friction against an over-eager builder, not a
   * security boundary — see public-docs/protected-branches.md.
   */
  protection?: {
    /**
     * Master switch for branch protection. OPT-IN: defaults to false, and
     * while false nothing in [protection] has any effect — accepts behave
     * exactly as before the feature existed. Set true to engage protection
     * (`lazy protect <branch> on` does it for you).
     */
    enabled?: boolean;
    /** Additional protected branch names (merges into them require approval, on top of the default branch). */
    protected_branches?: string[];
    /**
     * Protected TASKS, by task code or short id. Merging a listed task's own
     * branch upward requires human approval regardless of the target branch —
     * the outgoing counterpart to `protected_branches`. Managed with
     * `lazy protect <task> on|off`.
     */
    protected_tasks?: string[];
    /** When protection is enabled, protect the repo's default branch (e.g. `main`). Default: true — flipping `enabled` on protects the default branch without further config. */
    gate_default_branch?: boolean;
  };
  automation?: {
    /** Files agents are nudged to keep up to date (docs, CHANGELOG, etc.). Opt-in; empty by default. */
    maintain?: MaintainEntry[];
    /** Accept-time validation step: heavy checks + maintained-files completeness + built-in post-mortem. */
    pre_accept?: PreAcceptConfig;
  };
  /** Custom mounts injected into task agent containers. Opt-in; empty by default. */
  mounts?: MountConfigEntry[];
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
    /** Ollama API endpoint the PROXY dials, host-perspective (e.g., "http://localhost:11434") */
    endpoint?: string;
  };
  /**
   * Built-in Anthropic-native passthrough proxy (Tier-1 audit plane).
   * When set, the daemon starts the proxy server on `port` and forwards
   * all traffic to `upstream`. Set `backend = "proxy"` on role targets
   * to route that role's traffic through this proxy.
   */
  proxy?: {
    /*
     * There is deliberately NO `enabled` key. The proxy is always on — it is how
     * lazy runs, the same way the daemon is — so this whole section is optional
     * tuning, never an on/off switch. A lazy.toml that still carries the removed
     * `enabled` key is REJECTED at load with an actionable error rather than
     * silently ignored (see resolveProxy in src/config/loader.ts).
     */
    /**
     * TCP port the proxy server listens on. OPTIONAL — omit it to let the daemon
     * pick a free OS-assigned port at start (avoids conflicts across per-project
     * daemons). Set it only to pin a specific port.
     */
    port?: number;
    /** Bind address (default: "127.0.0.1"). */
    bind?: string;
    /** Upstream Anthropic-compatible base URL (default: "https://api.anthropic.com"). */
    upstream?: string;
    /**
     * Cursor API base URL the `/_lazy/cursor/*` passthrough route forwards to
     * (default: "https://api2.cursor.sh"). Cursor traffic is a VERBATIM
     * passthrough — no policy enforcement, no failover chain, coarse audit only.
     */
    cursor_upstream?: string;
    /**
* Smart-routing failover chain, as `[[proxy.fallback]]` array-of-tables.
     * On a primary 429/529 or unreachable primary, the proxy reroutes to these
     * targets in order. Empty/absent = fail hard (no failover). Each Anthropic-
     * native target may override the model for a different tier/backend.
     */
    fallback?: Array<{
      upstream?: string;
      model?: string;
      /**
       * Which credential the proxy injects when it reroutes here:
       * "anthropic" (this target really is Anthropic) or "none" (default — the
       * target authenticates some other way, or not at all).
       */
      credential?: string;
    }>;
    /**
     * On a primary 429 whose `Retry-After` is ≤ this many seconds, wait and
     * retry the primary once before failing over (default 5).
     */
    retry_after_threshold?: number;
    /**
     * Mechanistic policy plane (§6.3 layer 1). Deterministic, injection-proof
     * deny-rules applied to each `tool_use` before it executes. Absent =
     * the decided default posture (enforce on, connectors deny-by-default).
     */
    policy?: {
      /** Master switch (default: true). false = pure passthrough/audit, no enforcement. */
      enforce?: boolean;
      /** `mcp__claude_ai_*` tool names to re-allow despite the default-deny posture. */
      connector_allowlist?: string[];
      /** Deny reads of well-known secret paths (~/.ssh, .env, credentials). Default: true. */
      deny_secret_path_reads?: boolean;
      /** Extra absolute-path glob patterns to deny for read/write tools. */
      deny_path_globs?: string[];
      /** Allowlisted egress hosts for WebFetch. Empty/absent = egress unrestricted. */
      egress_allowlist?: string[];
    };
  };
  memory?: {
    /**
     * Advisory size (bytes) for the injected memory context. Over this, launches
     * WARN and suggest `lazy memory compact` (default: 4096). Never an error and
     * never a truncation — memory over the threshold is still knowledge.
     */
    warn_bytes?: number;
  };
  /**
   * Hosted documentation lazy points at from errors, warnings and help text
   * ("Check documentation at <url>"). Unrelated to [documents], which is where
   * a PROJECT's own reference documents live.
   */
  docs?: {
    /**
     * Base URL of the documentation site (default: https://docs.getlazy.dev).
     * Point it at a fork's or an enterprise mirror's docs; set it to "" (or
     * false) to suppress documentation pointers entirely.
     */
    url?: string | false;
  };
  limits?: {
    /** Max live agent task containers before new starts queue (default: 8). */
    max_concurrent_agents?: number;
    /** Max concurrent interactive builder containers before new builders fail fast (default: 8). */
    max_concurrent_builders?: number;
    /** Minutes an idle blocked container may linger before the reaper frees its slot (default: 10). */
    idle_grace_minutes?: number;
    /**
     * Max consecutive work turns a task may run without a human in the loop.
     * Builder (MCP) and agent-driven turns count; a human turn resets the count to 0.
     * 0 = unlimited (default: 10).
     */
    max_turns_without_human?: number;
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
    /** Master switch for auto-resuming interrupted tasks, fast lane and slow lane alike (default: true). */
    auto_resume?: boolean;
    /** Minutes between slow-lane retries of a given task once its fast-lane retries are spent (default: 30). */
    auto_resume_interval_minutes?: number;
    /** Minimum minutes between any two auto-resumes project-wide (default: 5). */
    auto_resume_gap_minutes?: number;
    /** Slow-lane attempts before giving up for good — 24 x 30min = ~12 hours by default (default: 24). */
    auto_resume_max_attempts?: number;
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
    lfs_check: LfsCheckMode;
  };
  output: {
    shortid_length: number;
  };
  agent: {
    agent_id: string;
    /**
     * Kill the agent process after this many ms without progress.
     * 0 = use agent default.
     */
    watchdog_output_timeout_ms: number;
    /**
     * Max time to wait for the agent process to exit AFTER it emitted its final
     * result. 0 = disabled.
     */
    wind_down_timeout_ms: number;
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
    /**
     * Permanent offline mode. When true, remote operations are skipped
     * indefinitely and are NOT subject to the local-midnight auto-expiry used
     * by the `lazy system offline` command. Default false.
     */
    offline: boolean;
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
    /** Host execution permission posture: "sandbox" (default) or "bypass". */
    permission_mode: HostPermissionMode;
    /** Network allowlist for the host sandbox (default ["*.anthropic.com"]). */
    sandbox_allowed_domains: string[];
    /**
     * EXTRA paths to deny the Read tool, merged with the built-in sensitive
     * defaults. Confines the file tools, which bypass the OS sandbox.
     */
    sandbox_deny_read: string[];
    /** EXTRA paths to deny the Write/Edit tools, merged with the defaults. */
    sandbox_deny_write: string[];
    /**
     * Allow Claude Code's weaker nested sandbox so bubblewrap runs inside an
     * unprivileged container (no user namespaces). Weakens isolation — opt-in.
     */
    sandbox_allow_weaker_nested: boolean;
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
  /** Protected-branches config (see LazyConfig.protection). */
  protection: {
    enabled: boolean;
    protected_branches: string[];
    protected_tasks: string[];
    gate_default_branch: boolean;
  };
  automation: {
    /** Files agents are nudged to keep up to date (docs, CHANGELOG, etc.). Opt-in; empty by default. */
    maintain: MaintainEntry[];
    /** Accept-time validation step. Always present after loadConfig; opt-in (enabled defaults false). */
    pre_accept: {
      enabled: boolean;
      commands: string[];
      timeout: number;
    };
  };
  /** Custom mounts injected into task agent containers. Opt-in; empty by default. */
  mounts: MountConfigEntry[];
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
    /** Ollama API endpoint the PROXY dials, host-perspective (e.g., "http://localhost:11434") */
    endpoint: string;
  };
  /**
   * Resolved proxy config. ALWAYS present — the proxy has no off switch, so
   * every config (including one with no `[proxy]` section at all) resolves to a
   * live object. Never re-introduce a nullable "no proxy" branch here: the
   * audit/policy plane not running is a failure to surface, not a mode.
   */
  proxy: {
    /**
     * Requested TCP port. `0` means "OS-assigned at bind time" (the default when
     * no port is configured); the actual bound port is read back from the running
     * server and advertised in daemon status/startup output.
     */
    port: number;
    /** Bind address. */
    bind: string;
    /** Upstream Anthropic-compatible base URL. */
    upstream: string;
    /** Cursor API base URL for the `/_lazy/cursor/*` passthrough route. */
    cursorUpstream: string;
    /**
     * Ordered failover targets (empty = fail hard, no failover).
     *
     * `credential` says which credential the proxy injects when it reroutes
     * here. Default "none": a fallback is by definition a DIFFERENT backend,
     * and handing it the user's Anthropic key because it speaks the Anthropic
     * wire format is a credential leak, not a convenience. Set
     * `credential = "anthropic"` on a fallback that really is Anthropic
     * (a second tier, a gateway that proxies to Anthropic).
     */
    fallbacks: { upstream: string; model?: string; credential: 'anthropic' | 'none' }[];
    /** Retry-After threshold (seconds) below which the primary is waited-out and retried before failover. */
    retryAfterThreshold: number;
    /** Fully-resolved mechanistic policy (§6.3 layer 1). Always present. */
    policy: ResolvedProxyPolicy;
  };
  memory: {
    /**
     * Advisory size (bytes) for the injected memory context. Over this, launches
     * WARN and suggest `lazy memory compact` (default: 4096). Never an error and
     * never a truncation.
     */
    warn_bytes: number;
  };
  /** Hosted documentation lazy links to (see LazyConfig.docs). */
  docs: {
    /**
     * Validated base URL with any trailing slash removed, or null when
     * documentation pointers are disabled.
     */
    url: string | null;
  };
  limits: {
    /** Max live agent task containers before new starts queue (default: 8). */
    max_concurrent_agents: number;
    /** Max concurrent interactive builder containers before new builders fail fast (default: 8). */
    max_concurrent_builders: number;
    /** Minutes an idle blocked container may linger before the reaper frees its slot (default: 10). */
    idle_grace_minutes: number;
    /**
     * Max consecutive work turns a task may run without a human in the loop.
     * Builder (MCP) and agent-driven turns count; a human turn resets the count to 0.
     * 0 = unlimited (default: 10).
     */
    max_turns_without_human: number;
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
    /** Master switch for auto-resuming interrupted tasks, fast lane and slow lane alike (default: true). */
    auto_resume: boolean;
    /** Minutes between slow-lane retries of a given task once its fast-lane retries are spent (default: 30). */
    auto_resume_interval_minutes: number;
    /** Minimum minutes between any two auto-resumes project-wide (default: 5). */
    auto_resume_gap_minutes: number;
    /** Slow-lane attempts before giving up for good — 24 x 30min = ~12 hours by default (default: 24). */
    auto_resume_max_attempts: number;
  };
}
