import { join, resolve, isAbsolute, dirname, basename } from 'path';
import type { LazyConfig, ResolvedConfig, StorageBackendConfig, RoleName, RoleTarget, RoleTargetConfig } from './types';
import { VALID_EFFORT_LEVELS, VALID_CHATTINESS_LEVELS, VALID_ROLE_BACKENDS } from './types';
import { listAgents } from '../agent/registry';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_BIND } from './constants';
import { pathExists, readFile } from '../utils/fs';
import { expandTilde } from '../utils/home';
import { validateMounts } from '../capture/mounts';

const CONFIG_FILENAME = process.env.LAZY_CONFIG || 'lazy.toml';

let _configOverrideWarned = false;

/**
 * Find the nearest lazy.toml by walking up from startDir, stopping at lazyRoot.
 * Returns the directory containing the config, or lazyRoot if none found closer.
 * This lets worktrees carry their own config without being shadowed by the repo root.
 *
 * @param startDir - Directory to start searching from. Defaults to process.cwd().
 *   The daemon passes projectRoot here because its own cwd is meaningless.
 */
async function findConfigDir(lazyRoot: string, startDir?: string): Promise<string> {
  const root = resolve(lazyRoot);
  let dir = resolve(startDir ?? process.cwd());

  while (true) {
    if (await pathExists(join(dir, CONFIG_FILENAME))) {
      if (dir !== root && !_configOverrideWarned) {
        _configOverrideWarned = true;
        console.warn(`Warning: Using ${CONFIG_FILENAME} from ${dir} (not the git root ${root})`);
      }
      return dir;
    }
    if (dir === root) break;
    const parent = resolve(join(dir, '..'));
    if (parent === dir) break;
    dir = parent;
  }

  return root;
}

// Default configuration values
export const DEFAULT_CONFIG: ResolvedConfig = {
  models: {
    default: 'claude-opus-4-8',
    roles: {
      // Both roles default to the anthropic backend with an empty model, which
      // means "use the normal model chain / models.default". The legacy [ollama]
      // block and explicit [models.roles.*] override this in loadConfig.
      builder: { backend: 'anthropic', model: '', endpoint: '' },
      agent: { backend: 'anthropic', model: '', endpoint: '' },
    },
  },
  session: {
    verbose: false,
    debug: false,
    auto_commit_instructions: true,
  },
  data: {
    path: '.lazy',
  },
  storage: {
    backend: 'external',
    external_path: '',
    postgres_ssl: false,
  },
  git: {
    default_branch_prefix: 'lazy',
  },
  output: {
    shortid_length: 8,
  },
  agent: {
    agent_id: 'claude-code',
    watchdog_output_timeout_ms: 7200000,
    graceful_exit_timeout_ms: 60000,
    effort: 'medium',
  },
  builder: {
    effort: 'high',
  },
  chattiness: {
    default: '',
    builder: '',
    agent: '',
  },
  server: {
    port: DEFAULT_WEB_PORT,
    sync_interval: 60,
    bind: DEFAULT_SERVER_BIND,
  },
  remote: {
    driver: 'local',
    git_remote: 'origin',
    auto_approve: false,
    offline: false,
    github_auto_push: true,
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    gitlab_auto_push: true,
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
  },
  docker: {
    dockerfile: '',
  },
  runner: {
    type: 'docker',

  },
  documents: {
    path: '',
  },
  features: {},
  worktree: {
    include: [],
  },
  permissions: {
    protected: [],
  },
  automation: {
    maintain: [],
  },
  mounts: [],
  checks: {
    post_turn: '',
    post_turn_timeout: 300,
  },
  ollama: {
    enabled: false,
    model: '',
    endpoint: 'http://host.docker.internal:11434',
  },
  daemon: {
    auto_react_ci: true,
    auto_react_comments: true,
    auto_react_max_retries: 3,
    auto_react_backoff: 'exponential',
    auto_react_daily_budget: 50,
    max_auto_turns: 3,
  },
};

/**
 * Deep partial type - all properties and nested properties are optional
 */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Deep merge two objects, with source overriding target
 */
function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue !== undefined) {
      if (
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(targetValue, sourceValue as Partial<typeof targetValue>);
      } else {
        result[key] = sourceValue as typeof targetValue;
      }
    }
  }

  return result;
}

/**
 * Resolve a single per-role model target from (in precedence order):
 *   1. an explicit [models.roles.<role>] table,
 *   2. the legacy [ollama] block (maps every role to the ollama backend),
 *   3. the anthropic default ("use models.default / the normal model chain").
 *
 * Fails hard on an invalid backend, or an ollama/proxy target missing its model
 * or (for proxy) endpoint — these are config bugs the user must see immediately,
 * not silently degrade. `merged` is the deep-merged value (default ⊕ explicit).
 */
function resolveRole(
  role: RoleName,
  explicit: RoleTargetConfig | undefined,
  config: ResolvedConfig,
): RoleTarget {
  if (explicit) {
    const merged = config.models.roles[role];
    const backend = merged.backend;
    if (!VALID_ROLE_BACKENDS.includes(backend)) {
      throw new Error(
        `Invalid backend "${backend}" in lazy.toml [models.roles.${role}]. ` +
        `Valid backends: ${VALID_ROLE_BACKENDS.join(', ')}.`
      );
    }
    if (backend === 'ollama' || backend === 'proxy') {
      if (!merged.model) {
        throw new Error(
          `[models.roles.${role}] uses backend = "${backend}" but no model is set. ` +
          `Set model (e.g., model = "qwen3.5:35b-a3b-coding-nvfp4").`
        );
      }
      let endpoint = merged.endpoint;
      if (!endpoint) {
        if (backend === 'ollama') {
          endpoint = DEFAULT_CONFIG.ollama.endpoint;
        } else {
          throw new Error(
            `[models.roles.${role}] uses backend = "proxy" but no endpoint is set. ` +
            `Set endpoint (e.g., endpoint = "http://host.docker.internal:8080").`
          );
        }
      }
      return { backend, model: merged.model, endpoint };
    }
    // anthropic: model may be empty (means "use models.default / the chain").
    return { backend: 'anthropic', model: merged.model ?? '', endpoint: '' };
  }

  // No explicit per-role config — legacy [ollama] maps every role to ollama.
  if (config.ollama.enabled && config.ollama.model) {
    return { backend: 'ollama', model: config.ollama.model, endpoint: config.ollama.endpoint };
  }

  return { backend: 'anthropic', model: '', endpoint: '' };
}

/**
 * Resolve the path to the lazy.toml that would be loaded for the given root.
 * Honors LAZY_CONFIG (absolute path or filename) and the search-upwards
 * convention used by loadConfig. Does NOT check whether the file exists.
 */
export async function resolveConfigPath(lazyRoot: string, startDir?: string): Promise<string> {
  if (process.env.LAZY_CONFIG && isAbsolute(process.env.LAZY_CONFIG)) {
    return process.env.LAZY_CONFIG;
  }
  const configDir = await findConfigDir(lazyRoot, startDir);
  return join(configDir, CONFIG_FILENAME);
}

/**
 * Load and parse lazy.toml, returning the raw (un-merged) TOML object.
 * Returns null if no config file exists or parsing fails.
 * Used by doctor to detect unknown/deprecated keys.
 */
export async function loadRawConfig(lazyRoot: string): Promise<Record<string, unknown> | null> {
  const configPath = await resolveConfigPath(lazyRoot);
  if (!(await pathExists(configPath))) return null;

  try {
    const configContent = await readFile(configPath, 'utf-8');
    return Bun.TOML.parse(configContent) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Load and parse lazy.toml configuration file.
 *
 * @param options.cwd - Override the starting directory for config file search.
 *   Normally starts from process.cwd(). The daemon passes the project root
 *   because its own cwd may belong to a different project.
 */
export async function loadConfig(lazyRoot: string, options?: { cwd?: string }): Promise<ResolvedConfig> {
  // When LAZY_CONFIG is an absolute path, use it directly instead of walking
  // directories. This supports VMs and CI where the config lives outside the repo.
  let configPath: string;
  if (process.env.LAZY_CONFIG && isAbsolute(process.env.LAZY_CONFIG)) {
    configPath = process.env.LAZY_CONFIG;
  } else {
    const configDir = await findConfigDir(lazyRoot, options?.cwd);
    configPath = join(configDir, CONFIG_FILENAME);
  }

  // If LAZY_CONFIG is explicitly set but the file doesn't exist, fail hard
  if (process.env.LAZY_CONFIG && !(await pathExists(configPath))) {
    throw new Error(
      `LAZY_CONFIG is set to '${process.env.LAZY_CONFIG}' but the file does not exist.\n` +
      (isAbsolute(process.env.LAZY_CONFIG)
        ? `The absolute path does not exist.`
        : `Searched from ${options?.cwd ?? process.cwd()} up to ${lazyRoot}.`) + '\n' +
      `Unset it with LAZY_CONFIG= or fix the path.`,
    );
  }

  // If no config file exists (and LAZY_CONFIG was not set), return defaults
  if (!(await pathExists(configPath))) {
    return DEFAULT_CONFIG;
  }

  let parsed: LazyConfig;
  try {
    const configContent = await readFile(configPath, 'utf-8');
    parsed = Bun.TOML.parse(configContent) as LazyConfig;
  } catch (error) {
    console.error(`Warning: Failed to parse ${CONFIG_FILENAME}:`, error);
    console.error('Using default configuration.');
    return DEFAULT_CONFIG;
  }

  // Reject legacy [remote_github] section — use [remote] with prefixed keys instead
  const raw = parsed as Record<string, unknown>;
  if (raw.remote_github) {
    throw new Error(
      '[remote_github] section is no longer supported. ' +
      'Move its options into [remote] with a \'github_\' prefix ' +
      '(e.g., auto_push → github_auto_push) and remove [remote_github].',
    );
  }

  // Reject removed storage backends with clear migration guidance
  const storageSection = raw.storage as Record<string, unknown> | undefined;
  if (storageSection?.backend === 'in-repo') {
    throw new Error(
      'Storage backend "in-repo" is no longer supported. ' +
      'Switch to backend = "external" and set external_path to a directory outside the repo ' +
      '(e.g., external_path = "~/.lazy/my-project").',
    );
  }
  if (storageSection?.backend === 'orphan-branch') {
    throw new Error(
      'Storage backend "orphan-branch" is no longer supported. ' +
      'Switch to backend = "external" and set external_path to a directory outside the repo ' +
      '(e.g., external_path = "~/.lazy/my-project").',
    );
  }

  // Backward compat: top-level `runner = "docker"` (string) → `runner.type = "docker"`
  if (typeof raw.runner === 'string') {
    console.warn(
      `Warning: Top-level 'runner' in lazy.toml is deprecated. Move it to:\n` +
      `  [runner]\n` +
      `  type = "${raw.runner}"`,
    );
    parsed.runner = { type: raw.runner as import('./types').RunnerType };
  }

  // Merge with defaults
  // After backward-compat normalization above, runner is always object form.
  // Cast to satisfy DeepPartial<ResolvedConfig> which expects { type: RunnerType }.
  const config = deepMerge(DEFAULT_CONFIG, parsed as DeepPartial<ResolvedConfig>);

  // Expand leading `~/` in user-configured paths. Lazy accepts `~/...` as a
  // valid value in lazy.toml, but downstream consumers pass the string to
  // mkdir/writeFile/join, which do not expand tildes. Without this step, a
  // configured `external_path = "~/.lazy/foo"` creates a literal `~` directory
  // under the process cwd.
  if (config.storage.external_path) {
    config.storage.external_path = expandTilde(config.storage.external_path);
  }

  // Merge user-specified protected patterns with built-in defaults (additive)
  if (parsed.permissions?.protected) {
    const userPatterns = parsed.permissions.protected;
    const builtinPatterns = DEFAULT_CONFIG.permissions.protected;
    config.permissions.protected = [...new Set([...builtinPatterns, ...userPatterns])];
  }

  // Validate agent_id against registry
  const validAgents = listAgents();
  if (!validAgents.includes(config.agent.agent_id)) {
    throw new Error(
      `Unknown agent "${config.agent.agent_id}" in lazy.toml [agent] section. ` +
      `Valid agents: ${validAgents.join(', ')}`
    );
  }

  // Validate effort levels
  if (!VALID_EFFORT_LEVELS.includes(config.agent.effort)) {
    throw new Error(
      `Invalid effort level "${config.agent.effort}" in lazy.toml [agent] section. ` +
      `Valid levels: ${VALID_EFFORT_LEVELS.join(', ')}`
    );
  }
  if (!VALID_EFFORT_LEVELS.includes(config.builder.effort)) {
    throw new Error(
      `Invalid effort level "${config.builder.effort}" in lazy.toml [builder] section. ` +
      `Valid levels: ${VALID_EFFORT_LEVELS.join(', ')}`
    );
  }

  // Validate chattiness levels. Empty string means "unset" (no verbosity snippet
  // injected — today's behavior), so only non-empty values are checked.
  for (const key of ['default', 'builder', 'agent'] as const) {
    const value = config.chattiness[key];
    if (value !== '' && !VALID_CHATTINESS_LEVELS.includes(value as never)) {
      throw new Error(
        `Invalid chattiness level "${value}" in lazy.toml [chattiness] section (key "${key}"). ` +
        `Valid levels: ${VALID_CHATTINESS_LEVELS.join(', ')}`
      );
    }
  }

  // Validate Ollama config
  if (config.ollama.enabled && !config.ollama.model) {
    throw new Error(
      'Ollama is enabled but no model is configured. ' +
      'Set model in lazy.toml [ollama] section (e.g., model = "qwen3.5:35b-a3b-coding-nvfp4").'
    );
  }

  // Validate custom mounts. Fail loud on structurally invalid entries (missing
  // target, unknown type, bind without source, etc.) so the user sees an
  // actionable error at load time rather than an opaque `docker run` failure.
  validateMounts(config.mounts);

  // Resolve per-role model targets. Explicit [models.roles.*] wins; otherwise the
  // legacy [ollama] block maps to all roles → ollama; otherwise anthropic default.
  config.models.roles = {
    builder: resolveRole('builder', parsed.models?.roles?.builder, config),
    agent: resolveRole('agent', parsed.models?.roles?.agent, config),
  };

  return config;
}

/**
 * Check if the user has explicitly configured a default model in lazy.toml.
 * Returns true if lazy.toml exists and has models.default set.
 * Used to decide whether to inject model guidance into the builder prompt.
 */
export async function hasExplicitModelConfig(lazyRoot: string): Promise<boolean> {
  let configPath: string;
  if (process.env.LAZY_CONFIG && isAbsolute(process.env.LAZY_CONFIG)) {
    configPath = process.env.LAZY_CONFIG;
  } else {
    const configDir = await findConfigDir(lazyRoot);
    configPath = join(configDir, CONFIG_FILENAME);
  }
  if (!(await pathExists(configPath))) return false;

  try {
    const configContent = await readFile(configPath, 'utf-8');
    const parsed = Bun.TOML.parse(configContent) as LazyConfig;
    return parsed.models?.default !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get a default lazy.toml template content
 */
export function getDefaultConfigTemplate(storageBackend?: StorageBackendConfig, storagePath?: string, gitRemote?: string): string {
  const backend = storageBackend || 'external';
  const pathLine = storagePath ? `external_path = "${storagePath}"` : 'external_path = ""';
  const remoteName = gitRemote || 'origin';

  return `# Lazy configuration
# Documentation: https://gitlab.com/getlazy/lazy/-/blob/main/docs/lazy-toml.md
#
# Override the config filename with the LAZY_CONFIG environment variable
# (e.g., LAZY_CONFIG=lazy.lima.toml lazy list)

[models]
# Default model for sessions — use raw model IDs (e.g., "claude-opus-4-8",
# "claude-sonnet-4-6", "qwen3.5:35b-a3b-coding-nvfp4")
default = "claude-opus-4-8"

# Per-role model targets (optional). Route the builder and task agents to
# different backends — e.g. keep the builder on real Anthropic while agents run
# on a local Ollama model. backend = "anthropic" | "ollama" | "proxy".
# When set, these override the legacy [ollama] block for that role. ollama/proxy
# require a model; proxy requires an endpoint; ollama defaults the endpoint to
# host.docker.internal:11434. Lazy preflights each backend before launch and
# fails (never silently falls back) if it is unreachable.
#
# [models.roles.builder]
# backend = "anthropic"
# model = "claude-opus-4-8"
#
# [models.roles.agent]
# backend = "ollama"
# model = "qwen3.5:35b-a3b-coding-nvfp4"
# endpoint = "http://host.docker.internal:11434"

[session]
# Show Docker output in real-time during session execution
verbose = false

# Extra logging for troubleshooting
debug = false

# Include commit guidelines in prompts sent to the agent
auto_commit_instructions = true

[data]
# Location of the .lazy directory
path = ".lazy"

[storage]
# Storage backend: "external" (default) or "postgres"
backend = "${backend}"
# Path for external storage (only used when backend = "external")
# Defaults to ~/.lazy/<project-name> if empty
${pathLine}

[git]
# Default prefix for lazy branches (e.g., "lazy/abc123")
default_branch_prefix = "lazy"

[output]
# Length of shortened IDs displayed in output
shortid_length = 8

[agent]
# Default agent type to use for sessions
agent_id = "claude-code"
# Reasoning effort level passed to Claude Code via --effort for task agents.
# Higher levels spend more tokens thinking before responding.
# Valid levels: "low", "medium", "high", "xhigh", "max" (default: "medium")
# effort = "medium"
# Max time (ms) to wait for the agent process to exit after it signals
# end-of-turn via lazy_commit. Bounds how long we wait for claude -p's
# plumbing to wind down once the agent considers itself done. 0 disables.
# graceful_exit_timeout_ms = 60000

[builder]
# Reasoning effort level passed to Claude Code via --effort for builder sessions.
# Builder sessions default to "high" because they handle orchestration and planning.
# Valid levels: "low", "medium", "high", "xhigh", "max" (default: "high")
# effort = "high"

[chattiness]
# Baseline conversational verbosity for the builder and agents — how much they
# narrate, explain, and elaborate in their replies (not how hard they think).
# Valid levels: "terse", "normal", "chatty". When unset, no verbosity guidance
# is injected and behavior is unchanged.
# It is elastic: when you ask for more detail, the model steps up ONE notch from
# this baseline for that reply, not straight to maximum verbosity.
# "default" applies to both roles; "builder" and "agent" override it per role.
# default = "normal"
# builder = "chatty"
# agent = "terse"

[server]
# Default port for the web dashboard server
port = 26024
# Interval in seconds for background sync when running lazy server (0 to disable)
# sync_interval = 60
# Network interface the daemon's TCP server binds to. Defaults to loopback
# ("127.0.0.1") so the dashboard, /mcp, and /rpc endpoints are reachable only
# from this machine. The dashboard is UNAUTHENTICATED — only change this if you
# deliberately want LAN/remote access. Use "0.0.0.0" to listen on all
# interfaces, or a specific interface IP.
# On native Linux with a docker/podman runner, the loopback default ALSO binds
# the docker bridge gateway (e.g. 172.17.0.1) on the same port so containers can
# reach the daemon via host.docker.internal — that interface is not routable
# from the LAN, so it does not widen exposure. Setting bind explicitly disables
# this and uses your value as-is.
# bind = "127.0.0.1"

[runner]
# Runner type: "docker" (default), "podman", or "dangerously-host-process-without-any-isolation"
# Docker/Podman modes run agents in isolated containers. Host-process mode runs agents
# directly on the host — use only in VMs or other already-isolated environments.
type = "docker"


[remote]
# Remote driver: "local" (default), "github", or "gitlab"
driver = "local"
# Git remote name (default: "origin"). Change if your remote is named differently.
${remoteName !== 'origin' ? `git_remote = "${remoteName}"` : '# git_remote = "origin"'}
# Auto-approve MRs/PRs on protected branches (default: false).
# When true, lazy accept submits an approving review before merging.
# For sole developers who don't want to manually approve their own MRs.
# auto_approve = false
# Permanent offline mode (default: false). When true, ALL remote operations
# (push, fetch, sync, PR creation) are skipped indefinitely. Unlike the
# 'lazy system offline' command — which is temporary and auto-recovers at the
# next local midnight — this flag stays in effect until you remove it.
# Use it when you genuinely want to stay offline (e.g. an air-gapped or
# Ollama-only project). 'lazy system online' will NOT clear it.
# offline = false
# When using the GitHub driver, these options are also available:
# github_auto_push = true   # Automatically push after each agent turn
# Authentication is handled by gh CLI (run: gh auth login)
# When using the GitLab driver, these options are also available:
# gitlab_auto_push = true   # Automatically push after each agent turn
# Authentication is handled by glab CLI (run: glab auth login)

[docker]
# Path to custom Dockerfile (relative to project root)
# If empty, uses the base image (Ubuntu with Claude Code + passwordless sudo).
# Agents install what they need via apt-get.
dockerfile = ""

[features]
# Enable experimental features. Set individual flags or use all = true.
# Use LAZY_VANILLA=1 env var to disable all flags temporarily.
# auto_sync_after_turn = true  # Sync task branch with upstream after each agent turn
# all = true

[worktree]
# Untracked files to copy into new task worktrees (glob patterns)
# Example: include = [".env", ".env.local", "config/local.yml"]
# include = []

[permissions]
# Glob patterns for files agents should not modify or delete.
# Agents can still ADD new files matching these patterns — only modifications
# and deletions are flagged as violations for human review.
# protected = ["test/**", "tests/**", "spec/**", "*_test.*", "*.test.*", "*.spec.*"]

[automation]
# Maintained files — the inverse of [permissions].protected. Patterns agents are
# *expected* to keep up to date as they work (docs, CHANGELOG, architecture).
# Agents MAY skip them, but when a turn touches none of an entry's files the
# supervisor prompts the agent once: "you didn't update <title> — are you sure?"
# The agent must either make the update or record why it skipped, before the task
# blocks for human review. Opt-in: empty by default. Each entry needs title,
# pattern, and instructions.
#
# [[automation.maintain]]
# title = "docs"
# pattern = "docs/**/*"
# instructions = "Search for docs and update any that have gone out of date due to your work, OR create new docs if needed."
#
# [[automation.maintain]]
# title = "changelog"
# pattern = "CHANGELOG.md"
# instructions = "Add a line that succinctly describes your work; skip if your work is intra-release."
#
# [[automation.maintain]]
# title = "architecture-diagrams"
# pattern = "architecture/**/*"
# instructions = "Update any architectural diagrams affected by your work."

[checks]
# Command to run after each agent turn. Output is captured and attached to
# the turn for reviewers to see. Does NOT block the agent or trigger retries.
# post_turn = "bun test --bail"
# Timeout in seconds for the post_turn command (default: 300 = 5 minutes).
# post_turn_timeout = 300

[ollama]
# Use Ollama for local model inference instead of Anthropic's API.
# Requires Ollama v0.14+ running on the host with the Anthropic Messages API.
# enabled = false
# Model name to pass to Claude Code (e.g., "qwen3.5:35b-a3b-coding-nvfp4")
# model = ""
# Ollama API endpoint (containers use host.docker.internal to reach the host)
# endpoint = "http://host.docker.internal:11434"

[daemon]
# Auto-react: daemon auto-unblocks tasks on CI failures and PR comments.
# React to CI failures (auto-unblock blocked tasks when CI fails).
# auto_react_ci = true
# React to PR comments (auto-unblock blocked tasks when humans comment on PRs).
# auto_react_comments = true
# Auto-react budget controls — prevent runaway costs from auto-triggered turns.
# Max auto-unblocks per task per trigger type before escalating to human.
# auto_react_max_retries = 3
# Backoff strategy between repeated auto-unblocks: "none", "linear", "exponential".
# auto_react_backoff = "exponential"
# Max auto-triggered turns per day across all tasks in this project.
# auto_react_daily_budget = 50
# Max consecutive auto-triggered turns per task before pausing for human review.
# max_auto_turns = 3
`;
}
