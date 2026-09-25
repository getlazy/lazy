import type { AgentProfileConfig, AgentWire } from './agent-profiles';
import type { BackendSelection } from '../credentials/backends';
import type { ProxyPolicyConfig } from '../proxy/policy';
import type { ReviewGate, ReviewMode } from '../review/mode';
import type { ServicePort } from '../serve/ports';
import type { TaskType } from '../types';

/**
 * Fully-resolved mechanistic proxy policy (§6.3 layer 1). Alias of the engine's
 * config shape (src/proxy/policy.ts) — the loader produces this and the proxy
 * server consumes it directly.
 */
export type ResolvedProxyPolicy = ProxyPolicyConfig;

/** The two model roles lazy distinguishes: the interactive builder vs. task agents. */
export type RoleName = 'builder' | 'agent';

/**
 * Which credential the proxy injects when it reroutes to a `[[proxy.fallback]]`
 * target. Default "none": a fallback is by definition a DIFFERENT backend, and
 * handing it a credential it was not explicitly granted is a leak. Every value
 * except "none"/"anthropic" names a provider in the `lazy auth` store.
 *
 * NOTE: the fallback chain is Anthropic-WIRE — the proxy re-sends the same
 * `/v1/messages` body. `openrouter` is a valid fallback credential because
 * OpenRouter serves an Anthropic-compatible Messages endpoint
 * (https://openrouter.ai/api); `openai` is accepted for symmetry but only
 * useful against a gateway that speaks the Anthropic wire with an OpenAI key.
 */
export type ProxyFallbackCredential = 'anthropic' | 'ollama' | 'openai' | 'openrouter' | 'none';

export const VALID_PROXY_FALLBACK_CREDENTIALS: readonly ProxyFallbackCredential[] =
  ['anthropic', 'ollama', 'openai', 'openrouter', 'none'] as const;

/**
 * A per-role model target as written in lazy.toml `[models.roles.*]`.
 *
 * One key: which agent PROFILE the role runs by default. The role no longer
 * carries a backend, a model or an endpoint — those are properties of the
 * profile (`[agents.<name>]`), because they have to differ between two tasks in
 * the SAME role. `[models.roles.agent] backend = …` is refused at load with the
 * replacement config printed; see `resolveRole` in ./loader.ts.
 */
export interface RoleTargetConfig {
  agent?: string;
}

/**
 * A fully-resolved per-role model target (produced by the config loader).
 * Always present for both roles after `loadConfig`.
 *
 * This is a PROFILE, flattened: every field except `proxyUrl` is copied from the
 * {@link AgentProfileConfig}-derived profile the role defaults to. It stays a
 * separate shape because a role target also carries the launch-time proxy
 * address, which is not a property of any profile.
 *
 * A role target answers "what does this role run when a task names no agent of
 * its own" — the builder's profile, and the project default for task agents. A
 * TASK's own profile overrides it, which is the whole point of profiles.
 */
export interface RoleTarget {
  /** Profile name this role defaults to (`[agent] agent_id` for the agent role). */
  profile: string;
  /** Registered agent implementation behind {@link RoleTarget.profile}. */
  harness: string;
  /**
   * Model passed to the agent via `--model`. Empty means "use the normal model
   * chain / models.default". On a profile with a PINNED endpoint it is the
   * authoritative model name (never substituted) — see
   * {@link RoleTarget.pinned}.
   */
  model: string;
  /**
   * The upstream lazy's PROXY forwards this role's traffic to. Empty means "the
   * proxy's primary upstream" (`[proxy] upstream`, i.e. api.anthropic.com).
   *
   * NEVER an address the launched agent dials itself, and never turned into an
   * env var — see src/proxy/agent-upstreams.ts for the routing and
   * src/utils/role-target.ts for the env it does (not) produce. Host-perspective
   * by definition, because the daemon makes the upstream call.
   */
  endpoint: string;
  /**
   * True when the profile's own `[agents.<name>]` block named the endpoint.
   *
   * The successor to the old `backend !== 'anthropic'` test, and NOT the same as
   * `endpoint !== ''`: the built-in `codex` profile carries a default OpenAI
   * upstream with no model, so "has an endpoint" would wrongly claim the model
   * is authoritative. Pinned means a human chose this service, so its model name
   * is its own and lazy never substitutes one.
   */
  pinned: boolean;
  /** Protocol spoken to {@link RoleTarget.endpoint}. Derived, never configured. */
  wire: AgentWire;
  /**
   * Stored credential the upstream is paid with — a provider name, or `"none"`
   * for an upstream that authenticates nobody (a local model server).
   */
  credential: string;
  /**
   * Live lazy-proxy base URL to route this role's traffic through, filled in at
   * launch when the (always-on) proxy is running.
   *
   * The ONLY base URL a launch ever receives, for every profile — a local-Ollama
   * profile and one pinned at an explicit `endpoint` get this address too, and
   * the proxy forwards them onward. There is no profile for which this is
   * skipped.
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
  /**
   * The proxy's primary upstream (`[proxy] upstream`), filled in beside
   * {@link RoleTarget.proxyUrl} by the same launch paths.
   *
   * It answers the one question `endpoint` alone cannot: WHERE an unpinned
   * profile's traffic actually lands. `endpoint` is empty for such a profile,
   * meaning "wherever the proxy's primary upstream is", and that is a config
   * value — `https://api.anthropic.com` by default but freely overridable — so a
   * launch reading only `endpoint` cannot tell Anthropic's own API from a
   * self-hosted Anthropic-compatible gateway.
   *
   * Undefined means "not resolved here", never "Anthropic". Every consumer must
   * treat it as unknown and take the conservative branch: the paths that leave
   * it undefined are exactly the ones that also leave `proxyUrl` undefined
   * (in-container relaunches, RPC-bypass modes), which stamp no base URL at all.
   */
  primaryUpstream?: string;
}

/** Storage backend types — duplicated here to avoid circular dependency with storage module */
export type StorageBackendConfig = 'external';

/** Runner types for task execution */
export type RunnerType = 'docker' | 'podman' | 'dangerously-host-process-without-any-isolation';

/** All canonical runner type values. */
export const VALID_RUNNER_TYPES: readonly RunnerType[] = ['docker', 'podman', 'dangerously-host-process-without-any-isolation'] as const;

/**
 * Friendly CLI/MCP aliases mapped to canonical {@link RunnerType} values.
 * Host-process runner aliases are deliberately absent — that runner is
 * test-harness-only (see src/runner/host-runner-gate.ts).
 */
export const RUNNER_ALIASES: Readonly<Record<string, RunnerType>> = {
  docker: 'docker',
  container: 'docker',
  podman: 'podman',
};

/**
 * Resolve a friendly runner alias (or canonical value) to a {@link RunnerType}.
 * Case-insensitive and whitespace-tolerant. Returns null for unknown values so
 * callers can produce an actionable error listing the accepted aliases.
 *
 * Does NOT accept host-process names — use {@link isRemovedHostRunnerInput}
 * first so callers can surface the docker requirement instead of "invalid runner".
 */
export function resolveRunnerType(input: string): RunnerType | null {
  return RUNNER_ALIASES[input.trim().toLowerCase()] ?? null;
}

/** Human-readable list of accepted runner aliases, for error messages. */
export const RUNNER_ALIAS_HINT = 'docker, container, podman';

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
 * Whether lazy verifies the host FILE-TOOL boundary before launching host agents
 * under `permission_mode = "sandbox"`.
 *
 * The OS sandbox covers Bash; the Read/Edit/Write tools are held back only by
 * the `permissions.deny` rules lazy passes to Claude Code — an upstream behavior
 * lazy depends on but does not control.
 *   - 'off' (default): no runtime check. The standing signal is the CI guard
 *     workflow plus `lazy system verify-host-boundary` on demand. Default because
 *     the guard costs three real headless sessions and needs a logged-in
 *     `claude`, which a daemon host may not have.
 *   - 'once-per-version': verify on the first host launch for each Claude Code
 *     version + platform + deny posture, cache the verdict, and REFUSE to launch
 *     if a deny rule was violated.
 * See src/runner/host-boundary-guard.ts and public-docs/host-boundary-guard.md.
 */
export type SandboxBoundaryVerification = 'off' | 'once-per-version';

export const VALID_SANDBOX_BOUNDARY_VERIFICATIONS: readonly SandboxBoundaryVerification[] = [
  'off',
  'once-per-version',
] as const;

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
 * A single reactive-automation group. The generalized case of protected-file
 * push-back: when a turn's commits *touch* `pattern`, the supervisor prompts
 * the agent once with `instructions` (e.g. "take UI screenshots"). Same shape
 * as {@link MaintainEntry}; the trigger is inverted (matched → nudge, not
 * skipped → nudge). The nudge itself is not a gate and never re-triggers
 * push-back; the supervisor still re-detects protected-file violations after
 * the follow-up so edits made during react can still park the turn in conflict.
 */
export interface ReactEntry {
  /** Short human label for the group (e.g. "take-UI-snapshots"). */
  title: string;
  /** Glob pattern matched against the turn's changed files. */
  pattern: string;
  /** What to do when those files change — shown to the agent verbatim. */
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
 * to false, because the accept path blocks on the gate and some projects gate
 * elsewhere (CI).
 *
 * The MECHANICAL acceptance gate: the configured commands run in an ephemeral
 * container on the task's worktree when the task is accepted, BEFORE the merge
 * — the home for expensive one-time validation (full test suite, build). No
 * agent turn runs here.
 *
 * A non-zero exit aborts the accept and returns the task to blocked with the
 * failure surfaced.
 */
export interface PreAcceptConfig {
  /** Run the acceptance gate at all. Default false — opt in to pay commands-time per accept. */
  enabled?: boolean;
  /** Gate commands run (in order); first non-zero exit aborts the merge. */
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
    /** Per-role default agent profile: what a role runs when a task names none. */
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
  /**
   * Named agent profiles — `[agents.<name>]`. Each is harness + model +
   * endpoint + credential, selectable per task with `--agent <name>`. Built-in
   * profiles named after each harness exist implicitly; a block of the same
   * name overrides one. See ./agent-profiles.ts.
   */
  agents?: Record<string, AgentProfileConfig>;
  agent?: {
    agent_id?: string;
    /**
     * Per-task-type agent overrides. Unmapped types fall back to `agent_id`.
     * An explicit `--agent` at create/start still wins. Subtasks, clones, redo
     * and rework inherit the source task's agent and ignore this table.
     */
    by_type?: Partial<Record<TaskType, string>>;
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
    /**
     * @deprecated Folded into `[review] mode`. `true` is now
     * `mode = "low_high"`, `false` is `mode = "separate"` — which is what it
     * meant before the default flipped: no in-session loop, and the daemon
     * dispatching a reviewer of its own. Still honoured; `lazy doctor` says so.
     */
    low_high_loop?: boolean;
    /** @deprecated Folded into `[review] draft_effort`. Still honoured. */
    low_high_loop_draft_effort?: EffortLevel;
    /** @deprecated Folded into `[review] review_effort`. Still honoured. */
    low_high_loop_review_effort?: EffortLevel;
  };
  review?: {
    /**
     * How a task is reviewed once it declares final: "off", "low_high"
     * (default) or "separate". See `src/review/mode.ts` for the vocabulary and
     * the decision behind the default.
     */
    mode?: ReviewMode;
    /**
     * Whether a `separate` review that comes back `needs_work` starts a fix
     * turn by itself (default: false).
     *
     * False parks the task with its findings attached and hands back to
     * whoever is driving — a person, or a cluster's driver — so the decision
     * "is another round worth it" is made by someone who can see the whole
     * board rather than by the daemon. In `low_high` mode the fix is in-session
     * by definition and this key does not apply.
     */
    auto_fix?: boolean;
    /**
     * WHEN a recorded review holds the merge: "auto" (default, the mode
     * decides and a review you asked for always gates), "always" (any recorded
     * review gates, the low-high self-review included), or "never".
     */
    gate?: ReviewGate;
    /** Effort for the low-high draft and revise phases (default "low"). */
    draft_effort?: EffortLevel;
    /** Effort for the low-high self-review phase (default "xhigh"). */
    review_effort?: EffortLevel;
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
    dashboard_url?: string;
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
    build_inputs?: string[];
    run_args?: string[];
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
    /**
     * Verify the file-tool deny boundary before launching host agents under
     * sandbox mode: "off" (default) or "once-per-version".
     */
    verify_sandbox_boundary?: SandboxBoundaryVerification;
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
   * Protected branches: merges into a protected branch require a human
   * approval — the passphrase typed at `lazy accept`'s own prompt, in the
   * invocation that merges. This is friction against an over-eager builder,
   * not a security boundary — see public-docs/protected-branches.md.
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
    /**
     * Reactive automations: when a turn's commits touch a group's pattern, the
     * supervisor prompts the agent once with that group's instructions. Opt-in;
     * empty by default. Generalized protected-file push-back (custom instructions,
     * nudge not gate).
     */
    react?: ReactEntry[];
    /** Accept-time validation step: heavy checks + maintained-files completeness + built-in post-mortem. */
    pre_accept?: PreAcceptConfig;
    /**
     * Command run in the worktree BEFORE each agent turn (after the upstream
     * merge, before the agent starts). Intended for "ensure services are up"
     * setup — must be idempotent, because agent-started processes survive turn
     * boundaries and the hook runs on every turn regardless.
     */
    pre_turn?: string;
    /** Timeout in seconds for the pre_turn hook (default: 120). */
    pre_turn_timeout?: number;
    /**
     * When true, a failing pre_turn hook fails the whole turn instead of
     * warning. Default false: the failure is loud and prepended to the agent's
     * prompt, but the turn still runs.
     */
    pre_turn_required?: boolean;
    /** Command to run after each agent turn. Output is captured and attached to the turn. */
    post_turn?: string;
    /** Timeout in seconds for post_turn check command (default: 300). */
    post_turn_timeout?: number;
    /**
     * Command run in the TASK WORKTREE at accept time, before the merge. A
     * non-zero exit refuses the accept: the task's own tree does not build, so
     * merging it would break the target branch.
     *
     * Empty by default — a project that configures nothing gets no gate, and
     * accept says so rather than inventing a command. Keep it cheap (a
     * typecheck, not a full test suite): every accept pays for it.
     */
    accept_check?: string;
    /** Timeout in seconds for the accept_check command (default: 300). */
    accept_check_timeout?: number;
  };
  /** Custom mounts injected into task agent containers. Opt-in; empty by default. */
  mounts?: MountConfigEntry[];
  /** Ports the task environment serves, published to ephemeral loopback host ports. */
  serve?: {
    /** Container-side ports; each is identified by its own number. */
    ports?: number[];
    /** Named services: `name = port`. Same list as `ports`, with names. */
    services?: Record<string, number>;
    /**
     * Command that starts the project's services INSIDE a task's environment
     * (`bin/dev`, `npm run dev`, …). Optional. When set, the web review and
     * task pages offer a one-click "Start services" that runs it in the task's
     * container shell.
     */
    start_services_cmd?: string;
  };
  /**
   * DEPRECATED — migrated to `[automation]`. Still honored (never silently
   * ignored), but `lazy doctor` reports it and setting both spellings to
   * DIFFERENT values is a hard config error.
   */
  checks?: {
    /** @deprecated Use `[automation] post_turn`. */
    post_turn?: string;
    /** @deprecated Use `[automation] post_turn_timeout`. */
    post_turn_timeout?: number;
  };
  /**
   * Where `lazy auth` keeps model-provider credentials. Never a credential
   * itself — lazy.toml is a committed file, and secrets must never land in one.
   */
  credentials?: {
    /**
     * "auto" (default) probes macOS Keychain → libsecret → a 0600 file.
     * Naming one pins it, and an unusable pinned backend is an error rather
     * than a silent downgrade to a plaintext file the user did not choose.
     */
    backend?: string;
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
       * "anthropic" (Anthropic-native), "ollama" (Ollama Cloud), "openrouter"
       * (OpenRouter's Anthropic-compatible endpoint), "openai", or "none"
       * (default — no credential). See {@link ProxyFallbackCredential}.
       */
      credential?: string;
    }>;
    /**
     * On a primary 429 whose `Retry-After` is ≤ this many seconds, wait and
     * retry the primary once before failing over (default 5).
     */
    retry_after_threshold?: number;
    /**
     * Seconds the proxy waits for an upstream to answer one request before
     * giving up (default 1800 — the supervisor's own no-progress watchdog).
     * Raise it for a local model that loads slowly or queues requests; 0 means
     * no ceiling at all.
     */
    upstream_timeout?: number;
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
    // NOTE: outbound request plugins are NOT configured here. They are loaded
    // by convention from the project's `.lazy/plugins/` directory — presence is
    // the enable switch. See src/proxy/plugins/loader.ts.
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
    /** Max concurrent interactive builder containers before new builders fail fast (default: 8). */
    max_concurrent_builders?: number;
    /**
     * Max consecutive work turns a task may run without a human in the loop.
     * Builder (MCP) and agent-driven turns count; a human turn resets the count to 0.
     * 0 = unlimited (default: 10).
     */
    max_turns_without_human?: number;
  };
  cluster?: {
    /**
     * How many times a CLUSTER task may unblock the SAME child with review
     * feedback before the daemon refuses and makes it decide (default: 3).
     *
     * A mechanical budget, not advice. A cluster drives its children unattended,
     * and a child that keeps not-quite-passing review can absorb an unbounded
     * number of full agent turns without anybody watching. At the budget the
     * driver's `lazy_unblock` of that child is refused, naming the three things
     * it may do instead: accept it, close it, or defer it with a blocking raise
     * of its own.
     *
     * Counted per child, reset when that child is started or accepted. Only an
     * AGENT-actored unblock counts: a human unblocking the child is never
     * refused (CLAUDE.md, "Never Lose Human Feedback") and starts a fresh
     * budget, and neither are the daemon's own recovery turns.
     *
     * 0 = unlimited.
     */
    max_child_fix_rounds?: number;
  };
  /**
   * Automatic pausing at a share of a SUBSCRIPTION usage window (opt-in).
   *
   * Past the threshold, lazy stops STARTING turns that would spend that
   * credential: human starts/unblocks/resumes are refused with the reading,
   * and the daemon's own launches (auto-resume, auto-delivery, cluster
   * restarts) wait and go ahead by themselves once the window resets. A turn
   * already running is never stopped. Off unless `threshold_percent` is set.
   */
  usage_pause?: {
    /** Percent (1–100) of a usage window past which new turns wait. 0 / absent = off. */
    threshold_percent?: number;
    /**
     * Per-credential thresholds, keyed by the credential name `lazy stats
     * limits` prints (e.g. `credential:CLAUDE_CODE_OAUTH_TOKEN`, `user:<email>`).
     * Wins over `threshold_percent` for that credential; 0 = never pause it.
     */
    credentials?: Record<string, number>;
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
     * the profile named by `[models.roles.<role>] agent`, else the role's own
     * default profile (`[agent] agent_id` for tasks, claude-code for the
     * builder), flattened with its model, endpoint, wire and credential.
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
  };
  git: {
    default_branch_prefix: string;
    lfs_check: LfsCheckMode;
  };
  output: {
    shortid_length: number;
  };
  /**
   * `[agents.<name>]` blocks as written, validated at load. Resolution to full
   * profiles (built-ins merged in, wire and credential inferred) goes through
   * `agentProfilesFor()` in ./agent-profiles.ts — the raw table is kept here so
   * ResolvedConfig stays a plain, cloneable, serialisable object.
   */
  agents: Record<string, AgentProfileConfig>;
  agent: {
    agent_id: string;
    /** Per-task-type agent overrides. Empty when unset. */
    by_type?: Partial<Record<TaskType, string>>;
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
  review: {
    /** How a task is reviewed once it declares final. Default `low_high`. */
    mode: ReviewMode;
    /** Does a `separate` review's `needs_work` start a fix turn by itself? Default false. */
    auto_fix: boolean;
    /** When a recorded review holds the merge. Default `auto`. */
    gate: ReviewGate;
    /** Effort for the low-high draft and revise phases. */
    draft_effort: EffortLevel;
    /** Effort for the low-high self-review phase. */
    review_effort: EffortLevel;
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
    /** Exact public origin used to reach the dashboard through a trusted reverse proxy. */
    dashboard_url: string;
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
    /**
     * Files whose CONTENTS are part of the image's identity, relative to the
     * project root. Changing one rebuilds the image on the next container
     * start, exactly as editing the Dockerfile does.
     *
     * Only meaningful for files the Dockerfile actually COPYs: Docker keys a
     * `RUN bundle install` layer on the Dockerfile text alone, so without a
     * COPY of the lockfile the rebuild it triggers is a guaranteed no-op.
     */
    build_inputs: string[];
    /**
     * Extra `docker run` arguments applied verbatim, in order, before the
     * image name when a TASK container is created (e.g.
     * `["--cap-add=SYS_PTRACE"]` for seccomp-notify based sandboxes). Resolved
     * from the PROJECT ROOT's lazy.toml only — a task worktree's copy is
     * agent-writable and must never govern container privileges.
     */
    run_args: string[];
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
    /** Runtime file-tool boundary verification (see LazyConfig.runner). */
    verify_sandbox_boundary: SandboxBoundaryVerification;
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
    /**
     * Reactive automations: pattern match → one-shot supervisor prompt with
     * instructions. Opt-in; empty by default.
     */
    react: ReactEntry[];
    /** Accept-time validation step. Always present after loadConfig; opt-in (enabled defaults false). */
    pre_accept: {
      enabled: boolean;
      commands: string[];
      timeout: number;
    };
    /** Setup command run in the worktree before each agent turn. Empty = disabled. */
    pre_turn: string;
    /** Timeout in seconds for the pre_turn hook. */
    pre_turn_timeout: number;
    /** When true, a failing pre_turn hook fails the turn instead of warning. */
    pre_turn_required: boolean;
    /**
     * Command to run after each agent turn. Output is captured and attached to
     * the turn. Resolved from `[automation] post_turn`, falling back to the
     * deprecated `[checks] post_turn`.
     */
    post_turn: string;
    /** Timeout in seconds for post_turn check command. */
    post_turn_timeout: number;
    /**
     * Command run in the task worktree at accept time, before the merge. A
     * non-zero exit refuses the accept. Empty = no gate (accept says so).
     */
    accept_check: string;
    /** Timeout in seconds for the accept_check command. */
    accept_check_timeout: number;
  };
  /** Custom mounts injected into task agent containers. Opt-in; empty by default. */
  mounts: MountConfigEntry[];
  /**
   * The resolved `[serve]` section. A TABLE rather than a bare array (which is
   * what `serve` used to resolve to) so that everything the section declares
   * stays under one key: managed-mode policy and the DEFAULT_CONFIG walk are
   * both keyed by resolved path, and a second top-level `serve_*` key would
   * have to invent a policy name that matches no lazy.toml key.
   */
  serve: {
    /**
     * Ports the task environment serves, already resolved to `{ name, port }`
     * and validated at load time. Empty by default — a project with no
     * `[serve]` section publishes nothing and its launch argv is unchanged.
     */
    services: ServicePort[];
    /**
     * Command that starts the project's services inside a task environment.
     * Empty string when unset.
     */
    start_services_cmd: string;
  };
  /** Where `lazy auth` keeps model-provider credentials. */
  credentials: {
    /** Validated at load time against src/credentials/backends.ts. */
    backend: BackendSelection;
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
    fallbacks: { upstream: string; model?: string; credential: ProxyFallbackCredential }[];
    /** Retry-After threshold (seconds) below which the primary is waited-out and retried before failover. */
    retryAfterThreshold: number;
    /**
     * Seconds the proxy waits for one upstream request (0 = no ceiling). Always
     * present: it REPLACES Bun's hidden default fetch timeout, which used to
     * abort slow local-model requests at a number lazy never chose.
     */
    upstreamTimeoutSeconds: number;
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
    /** Max concurrent interactive builder containers before new builders fail fast (default: 8). */
    max_concurrent_builders: number;
    /**
     * Max consecutive work turns a task may run without a human in the loop.
     * Builder (MCP) and agent-driven turns count; a human turn resets the count to 0.
     * 0 = unlimited (default: 10).
     */
    max_turns_without_human: number;
  };
  cluster: {
    /**
     * How many times a CLUSTER task may unblock the SAME child with review
     * feedback before the daemon refuses and makes it decide (default: 3).
     * 0 = unlimited. See the `LazyConfig` twin above for why it exists.
     */
    max_child_fix_rounds: number;
  };
  /** Automatic pausing at a share of a subscription usage window. See the `LazyConfig` twin. */
  usage_pause: {
    /** 0 = off. */
    threshold_percent: number;
    /** Per-credential thresholds; 0 = never pause that credential. */
    credentials: Record<string, number>;
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
