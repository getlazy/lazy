import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { LazyConfig, ResolvedConfig, StorageBackendConfig } from './types';
import { listAgents } from '../agent/registry';

const CONFIG_FILENAME = process.env.LAZY_CONFIG || 'lazy.toml';

let _configOverrideWarned = false;

/**
 * Find the nearest lazy.toml by walking up from cwd, stopping at lazyRoot.
 * Returns the directory containing the config, or lazyRoot if none found closer.
 * This lets worktrees carry their own config without being shadowed by the repo root.
 */
function findConfigDir(lazyRoot: string): string {
  const root = resolve(lazyRoot);
  let dir = resolve(process.cwd());

  while (true) {
    if (existsSync(join(dir, CONFIG_FILENAME))) {
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
    default: 'journeyman',
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
    watchdog_output_timeout_ms: 0,
  },
  server: {
    port: 26024,
    sync_interval: 60,
  },
  remote: {
    driver: 'local',
    git_remote: 'origin',
    github_auto_push: true,
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    gitlab_auto_push: true,
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
  },
  docker: {
    dockerfile: '',
    toolchain: '',
  },
  runner: {
    type: 'docker',
    docker_agent_root: false,
    docker_agent_no_network: false,
  },
  documents: {
    path: '',
  },
  features: {},
  worktree: {
    include: [],
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
 * Load and parse lazy.toml, returning the raw (un-merged) TOML object.
 * Returns null if no config file exists or parsing fails.
 * Used by doctor to detect unknown/deprecated keys.
 */
export function loadRawConfig(lazyRoot: string): Record<string, unknown> | null {
  const configDir = findConfigDir(lazyRoot);
  const configPath = join(configDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) return null;

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    return Bun.TOML.parse(configContent) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Load and parse lazy.toml configuration file
 */
export function loadConfig(lazyRoot: string): ResolvedConfig {
  const configDir = findConfigDir(lazyRoot);
  const configPath = join(configDir, CONFIG_FILENAME);

  // If LAZY_CONFIG is explicitly set but the file doesn't exist, fail hard
  if (process.env.LAZY_CONFIG && !existsSync(configPath)) {
    throw new Error(
      `LAZY_CONFIG is set to '${process.env.LAZY_CONFIG}' but the file does not exist.\n` +
      `Searched from ${process.cwd()} up to ${lazyRoot}.\n` +
      `Unset it with LAZY_CONFIG= or fix the path.`,
    );
  }

  // If no config file exists (and LAZY_CONFIG was not set), return defaults
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  let parsed: LazyConfig;
  try {
    const configContent = readFileSync(configPath, 'utf-8');
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

  // Validate agent_id against registry
  const validAgents = listAgents();
  if (!validAgents.includes(config.agent.agent_id)) {
    throw new Error(
      `Unknown agent "${config.agent.agent_id}" in lazy.toml [agent] section. ` +
      `Valid agents: ${validAgents.join(', ')}`
    );
  }

  return config;
}

/**
 * Check if the user has explicitly configured a default model in lazy.toml.
 * Returns true if lazy.toml exists and has models.default set.
 * Used to decide whether to inject model guidance into the builder prompt.
 */
export function hasExplicitModelConfig(lazyRoot: string): boolean {
  const configDir = findConfigDir(lazyRoot);
  const configPath = join(configDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) return false;

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    const parsed = Bun.TOML.parse(configContent) as LazyConfig;
    return parsed.models?.default !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get a default lazy.toml template content
 */
export function getDefaultConfigTemplate(storageBackend?: StorageBackendConfig, storagePath?: string, toolchain?: string, gitRemote?: string): string {
  const backend = storageBackend || 'external';
  const pathLine = storagePath ? `external_path = "${storagePath}"` : 'external_path = ""';
  const toolchainValue = toolchain || '';
  const remoteName = gitRemote || 'origin';

  return `# lazy.toml - Configuration for lazy
# Override the config filename with the LAZY_CONFIG environment variable
# (e.g., LAZY_CONFIG=lazy.lima.toml lazy list)

[models]
# Default model for sessions
# Universal monikers: "apprentice" (fast), "journeyman" (balanced), "master" (most capable)
# Legacy aliases: "sonnet", "opus", "haiku" (still supported)
default = "journeyman"

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

[server]
# Default port for the web dashboard server
port = 26024
# Interval in seconds for background sync when running lazy server (0 to disable)
# sync_interval = 60

[runner]
# Runner type: "docker" (default), "podman", or "dangerously-host-process-without-any-isolation"
# Docker/Podman modes run agents in isolated containers. Host-process mode runs agents
# directly on the host — use only in VMs or other already-isolated environments.
type = "docker"
# Run containers as root (passes --user root to docker run).
# Lets agents install packages at runtime (apt-get install, etc.).
# docker_agent_root = false
# Disable network access inside containers (passes --network none to docker run).
# docker_agent_no_network = false

[remote]
# Remote driver: "local" (default), "github", or "gitlab"
driver = "local"
# Git remote name (default: "origin"). Change if your remote is named differently.
${remoteName !== 'origin' ? `git_remote = "${remoteName}"` : '# git_remote = "origin"'}
# When using the GitHub driver, these options are also available:
# github_auto_push = true   # Automatically push after each agent turn
# Authentication is handled by gh CLI (run: gh auth login)
# When using the GitLab driver, these options are also available:
# gitlab_auto_push = true   # Automatically push after each agent turn
# Authentication is handled by glab CLI (run: glab auth login)

[docker]
# Auto-detected or manually set toolchain (e.g., "node", "rust", "ruby-rails")
# Determines which built-in Dockerfile to use for agent containers.
# See available toolchains: base, bun, node, deno, rust, go, cpp, ruby-rails,
# ruby-rails-rust, dotnet, python, python-ml, java, kotlin, swift
toolchain = "${toolchainValue}"
# Path to custom Dockerfile (relative to project root, empty = use built-in default)
# When set, overrides the toolchain Dockerfile.
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
`;
}
