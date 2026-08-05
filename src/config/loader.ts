import { join, resolve, isAbsolute, dirname, basename } from 'path';
import type { LazyConfig, ResolvedConfig, StorageBackendConfig, RoleName, RoleTarget, RoleTargetConfig } from './types';
import { VALID_EFFORT_LEVELS, VALID_HOST_PERMISSION_MODES, VALID_CHATTINESS_LEVELS, VALID_ROLE_BACKENDS } from './types';
import { listAgents } from '../agent/registry';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_BIND, DEFAULT_MEMORY_WARN_BYTES } from './constants';
import { pathExists, readFile } from '../utils/fs';
import { expandTilde } from '../utils/home';
import { validateMounts } from '../capture/mounts';
import { defaultPolicyConfig, type ProxyPolicyConfig } from '../proxy/policy';

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
    // 30 minutes. Sized from a live incident: during a provider outage a task
    // sat 45 minutes in `working` with its first model call hung — no turn, no
    // commits, no output — and the supervisor correctly did nothing, because the
    // guard was 2 hours. Half an hour without a single forward-progress event
    // from the agent is already pathological, and the timer resets on every
    // completed step, so a long-but-healthy turn is never affected.
    watchdog_output_timeout_ms: 1800000,
    wind_down_timeout_ms: 60000,
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
    permission_mode: 'sandbox',
    sandbox_allowed_domains: ['*.anthropic.com'],
    // Empty by default — the built-in sensitive denylist lives in
    // src/runner/host-sandbox.ts; these are user EXTRAS merged on top.
    sandbox_deny_read: [],
    sandbox_deny_write: [],
    sandbox_allow_weaker_nested: false,
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
  protection: {
    // Branch protection is OPT-IN — OFF by default (engineer decision,
    // 2026-08-01, reversing the on-by-default default it briefly carried in
    // v0.20). On-by-default made a new user's very first `lazy accept` fail
    // with "requires human approval" for a feature they had never heard of;
    // zero surprise beats zero config here. Discovery is handled instead:
    // a successful accept into the repo default branch prints a one-line hint
    // pointing at `lazy protect` (see src/protection/discovery.ts).
    // `enabled` remains the single master switch; while false nothing else in
    // [protection] has any effect.
    enabled: false,
    protected_branches: [],
    protected_tasks: [],
    gate_default_branch: true,
    passphrase_file: '.lazy/approve-passphrase',
  },
  automation: {
    maintain: [],
    pre_accept: {
      // OPT-IN. The pre-accept turn is a full agent turn (session resume, gate
      // commands, maintained-files review, post-mortem) that the accept path
      // blocks on — multi-minute, on every accept including agent-driven
      // subtask accepts. Accept is fast by default; projects that want the
      // validation set `[automation.pre_accept] enabled = true` explicitly.
      enabled: false,
      commands: [],
      timeout: 600,
    },
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
  proxy: null,
  memory: {
    warn_bytes: DEFAULT_MEMORY_WARN_BYTES,
  },
  limits: {
    max_concurrent_agents: 8,
    max_concurrent_builders: 8,
    idle_grace_minutes: 10,
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
/**
 * Resolve the `[proxy.policy]` section into the engine's concrete config. Absent
 * = the decided default posture (enforce on, connectors deny-by-default). An
 * absent/empty `egress_allowlist` means egress is NOT filtered (a present,
 * non-empty list restricts egress to those hosts).
 */
function resolveProxyPolicy(
  policy: NonNullable<LazyConfig['proxy']>['policy'],
): ProxyPolicyConfig {
  const defaults = defaultPolicyConfig();
  if (!policy) return defaults;
  const egress = Array.isArray(policy.egress_allowlist) ? policy.egress_allowlist : [];
  return {
    enforce: policy.enforce ?? defaults.enforce,
    connectorAllowlist: Array.isArray(policy.connector_allowlist) ? policy.connector_allowlist : [],
    denySecretPathReads: policy.deny_secret_path_reads ?? defaults.denySecretPathReads,
    denyPathGlobs: Array.isArray(policy.deny_path_globs) ? policy.deny_path_globs : [],
    egressAllowlist: egress.length > 0 ? egress : null,
  };
}

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
      let endpoint = merged.endpoint ?? '';
      if (!endpoint && backend === 'ollama') {
        endpoint = DEFAULT_CONFIG.ollama.endpoint;
      }
      // proxy: an empty endpoint is allowed and is the recommended default — the
      // daemon injects its own live proxy base URL (with the OS-assigned port) at
      // launch. An explicit endpoint still works as an override. The cross-check
      // that a `[proxy]` section actually exists happens after proxy resolution.
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
 * Render a `Bun.TOML.parse` failure as one line a human can act on.
 *
 * Bun throws a `BuildMessage` whose `.message` is only the bare reason
 * ("Cannot redefine key 'type'") — the line number and the offending source
 * line live on a non-enumerable `.position`. Without them the user is told
 * *what* is wrong but not *where*, which for a 300-line lazy.toml is close to
 * useless. `position.file` is Bun's internal name ("input.toml") and is
 * deliberately NOT used; the caller names the real path.
 */
function describeTomlError(error: unknown): string {
  // NOT `error instanceof Error`: Bun's BuildMessage is not an Error subclass,
  // so that test falls through to String(error) and yields a "BuildMessage: "
  // prefix the user has no use for. Read `.message` when it is a string.
  const raw = (error as { message?: unknown } | null)?.message;
  const reason = typeof raw === 'string' && raw ? raw : String(error);
  const position = (error as { position?: { line?: number; lineText?: string } } | null)?.position;
  if (!position?.line) return reason;
  const source = position.lineText ? `: ${position.lineText.trim()}` : '';
  return `line ${position.line}${source} — ${reason}`;
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
    // Deliberately null, not a throw: this exists only to feed doctor's
    // unknown/deprecated-key scan, which is meaningless on a file that does not
    // parse. The parse failure itself is never lost — loadConfig() throws on it
    // with the actionable message, and doctor reports that as its own failed
    // check before ever reaching the key scan.
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
    // A config file that EXISTS but does not parse is a bug in the user's
    // config, not a "no config" condition — so it fails hard, exactly like the
    // rejected-section checks immediately below.
    //
    // This used to warn and return DEFAULT_CONFIG. That silent fallback is the
    // worst possible behaviour: every setting the user wrote is discarded at
    // once and lazy runs with defaults that look deliberate. A duplicate
    // `[runner]` table meant agents ran in Docker while the file plainly said
    // host-process; `[proxy] enabled = false` would be ignored and traffic
    // would be proxied anyway; `[storage] external_path` would be ignored and
    // the store would split. Each one surfaces far from its cause.
    throw new Error(
      `Failed to parse ${configPath}: ${describeTomlError(error)}\n` +
      `\n` +
      `lazy will not fall back to defaults for a config file that exists but is broken — ` +
      `every setting in it would be silently discarded, and lazy would run with defaults ` +
      `that look deliberate.\n` +
      `\n` +
      `To fix:\n` +
      `  • Check the line named above. The most common cause is a DUPLICATE table: the\n` +
      `    \`lazy init\` template already writes [runner], [server], [storage] and others, so\n` +
      `    appending a second copy of one is a TOML redefinition error — edit the table that\n` +
      `    is already there instead of adding another one.\n` +
      `  • Restore a known-good file: \`git diff ${CONFIG_FILENAME}\` (if it is tracked), or see\n` +
      `    lazy.toml.example for the full reference.`,
    );
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

  // `graceful_exit_timeout_ms` was renamed to `wind_down_timeout_ms` when
  // end-of-turn stopped being inferred from lazy_commit. Honour the old name so
  // an existing lazy.toml keeps its configured value instead of silently
  // reverting to the default; the new name wins if both are present.
  const legacyWindDown = parsed.agent?.graceful_exit_timeout_ms;
  if (legacyWindDown !== undefined && parsed.agent?.wind_down_timeout_ms === undefined) {
    config.agent.wind_down_timeout_ms = legacyWindDown;
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

  // Validate host permission posture
  if (!VALID_HOST_PERMISSION_MODES.includes(config.runner.permission_mode)) {
    throw new Error(
      `Invalid permission_mode "${config.runner.permission_mode}" in lazy.toml [runner] section. ` +
      `Valid values: ${VALID_HOST_PERMISSION_MODES.join(', ')}.`
    );
  }

  // Validate the sandbox deny lists: arrays of non-empty strings (paths).
  for (const key of ['sandbox_deny_read', 'sandbox_deny_write'] as const) {
    const value = config.runner[key];
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || p.trim() === '')) {
      throw new Error(
        `Invalid ${key} in lazy.toml [runner] section. ` +
        `Expected an array of non-empty path strings (e.g. ${key} = ["~/.kube", "/etc/secrets"]).`
      );
    }
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

  // Validate concurrency limits — positive integers (a cap < 1 would wedge every
  // launch). Fail loud at load time rather than silently clamping.
  for (const key of ['max_concurrent_agents', 'max_concurrent_builders'] as const) {
    const value = config.limits[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `Invalid ${key} = ${value} in lazy.toml [limits] section: must be a positive integer.`,
      );
    }
  }
  // idle_grace_minutes may be 0 (reap idle containers immediately) but not negative.
  if (!Number.isInteger(config.limits.idle_grace_minutes) || config.limits.idle_grace_minutes < 0) {
    throw new Error(
      `Invalid idle_grace_minutes = ${config.limits.idle_grace_minutes} in lazy.toml [limits] section: must be a non-negative integer.`,
    );
  }

  // The memory size threshold is ADVISORY (it only decides when a launch warns
  // and suggests `lazy memory compact`), but a nonsense value would make the
  // warning meaningless — 0 warns always, negative never. Fail loud at load.
  if (!Number.isInteger(config.memory.warn_bytes) || config.memory.warn_bytes < 1) {
    throw new Error(
      `Invalid warn_bytes = ${config.memory.warn_bytes} in lazy.toml [memory] section: must be a positive integer (bytes).`,
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

  // Resolve proxy config. The proxy is ON BY DEFAULT — it is how lazy runs, the
  // same way the daemon is — so a project with NO [proxy] section still gets a
  // fully-defaulted proxy. `null` means exactly one thing: `enabled = false`,
  // the explicit escape hatch back to direct connections.
  if (parsed.proxy?.enabled === false) {
    config.proxy = null;
  } else {
    const parsedProxy = parsed.proxy ?? {};
    // Port is OPTIONAL. Omitted → 0, meaning "let the OS assign a free port at
    // bind time" (the daemon reads the actual port back and advertises it). A
    // hardcoded port conflicts across per-project daemons, so auto-assign is the
    // default; an explicit port still works as an override.
    const rawPort = parsedProxy.port;
    let port: number;
    if (rawPort === undefined || rawPort === null) {
      port = 0;
    } else if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error(
        'lazy.toml [proxy] port, when set, must be an integer 1–65535 (e.g. port = 8766). ' +
        'Omit it to let the daemon pick a free port automatically.',
      );
    } else {
      port = rawPort;
    }
    // Failover chain (`[[proxy.fallback]]`). Optional; empty = fail hard.
    // Each entry MUST carry a non-empty upstream — a missing one is a config bug
    // the user must see immediately, never a silently-dropped fallback.
    const rawFallbacks = parsedProxy.fallback ?? [];
    const fallbacks = rawFallbacks.map((f, i) => {
      if (typeof f?.upstream !== 'string' || f.upstream.trim() === '') {
        throw new Error(
          `lazy.toml [[proxy.fallback]] entry #${i + 1} is missing a non-empty "upstream". ` +
          'Each fallback target needs an Anthropic-native base URL, e.g. ' +
          'upstream = "https://api.anthropic.com".',
        );
      }
      if (f.model !== undefined && (typeof f.model !== 'string' || f.model.trim() === '')) {
        throw new Error(
          `lazy.toml [[proxy.fallback]] entry #${i + 1} has an invalid "model" — ` +
          'omit it to keep the original model, or set a non-empty model name.',
        );
      }
      return {
        upstream: f.upstream.replace(/\/$/, ''),
        ...(f.model !== undefined ? { model: f.model } : {}),
      };
    });

    // Retry-After threshold (seconds). Default 5; must be a non-negative number.
    const threshold = parsedProxy.retry_after_threshold;
    if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0)) {
      throw new Error(
        'lazy.toml [proxy] retry_after_threshold must be a non-negative number of seconds. ' +
        'E.g., retry_after_threshold = 5.',
      );
    }

    config.proxy = {
      port,
      bind: parsedProxy.bind ?? '127.0.0.1',
      upstream: (parsedProxy.upstream ?? 'https://api.anthropic.com').replace(/\/$/, ''),
      fallbacks,
      retryAfterThreshold: threshold ?? 5,
      policy: resolveProxyPolicy(parsedProxy.policy),
    };
  }

  // Cross-check: a role that routes through the proxy with no explicit endpoint
  // relies on the daemon injecting its live proxy base URL — which does not exist
  // when the proxy was explicitly turned off. Fail hard at load (never silently at
  // launch with an empty ANTHROPIC_BASE_URL). Since the proxy is on by default,
  // this can now only trip on `[proxy] enabled = false`.
  if (!config.proxy) {
    for (const role of ['builder', 'agent'] as const) {
      const t = config.models.roles[role];
      if (t.backend === 'proxy' && !t.endpoint) {
        throw new Error(
          `[models.roles.${role}] uses backend = "proxy" but the proxy is disabled ` +
          `([proxy] enabled = false in lazy.toml). Remove \`enabled = false\` to run the proxy, ` +
          `set an explicit endpoint on the role to point at an external one, ` +
          `or switch the role to backend = "anthropic".`,
        );
      }
    }
  }

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
# Kill the agent process after this many ms with no forward progress. This is a
# hang backstop, not a turn deadline: the timer resets on every step the agent
# completes, so a turn of many long steps is never killed — but a single tool
# call that runs longer than this without finishing is.
# A kill that captured no work (no result, no new commits) is retried
# automatically with backoff; a kill after the agent had committed something is
# not — that one stops for a human.
# 0 = use the agent's own default. (default: 1800000 — 30 minutes)
# watchdog_output_timeout_ms = 1800000
# Max time (ms) to wait for the agent process to exit AFTER it has emitted its
# final result. The summary is already captured by then, so this kill loses
# nothing but the CLI's own teardown. 0 disables.
# wind_down_timeout_ms = 60000

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
# directly on the host so they can use your local toolchain (LSPs, project scripts).
type = "docker"

# Permission posture for HOST execution (host-process runner only; ignored for docker/podman).
#   "sandbox" (default) — Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on
#                         Linux/WSL2) is the hard boundary. Agents run sandboxed and never
#                         prompt; the interactive builder prompts on a sandbox escape.
#   "bypass"            — full --dangerously-skip-permissions, NO sandbox. Opt-in only.
# permission_mode = "sandbox"

# Network "allowlist" for the host sandbox (permission_mode = "sandbox").
# IMPORTANT: under the headless-agent posture (sandbox + bypass) this is NOT a hard
# network boundary — it only PRE-APPROVES these domains so sandboxed Bash does not
# prompt. Non-listed domains are still reachable (a non-listed domain prompts, and
# bypass auto-approves). Hard network confinement would need Claude Code managed
# settings, which lazy does not use here. Treat this as "reduce prompts", not "deny
# everything else". Defaults to Anthropic's API only.
# sandbox_allowed_domains = ["*.anthropic.com"]

# Extra paths to deny the Read / Write / Edit FILE TOOLS, on top of the built-in
# sensitive defaults (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, ~/.config/glab, shell
# rc files, ~/.claude*). The OS sandbox only confines Bash; these permissions.deny
# rules are what confine the file tools (verified honored even under bypass). User
# entries MERGE with the defaults — they never replace them. Paths accept ~ and
# absolute paths.
# sandbox_deny_read = ["~/.kube", "~/.docker/config.json"]
# sandbox_deny_write = ["~/.kube", "~/.docker/config.json"]

# Allow Claude Code's weaker nested sandbox so bubblewrap can run inside an unprivileged
# container (no user namespaces). Considerably weakens isolation — only enable when an outer
# container already provides the boundary. No effect on macOS (Seatbelt). Default: false.
# sandbox_allow_weaker_nested = false


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

[protection]
# Protected branches (OPT-IN, off by default): accepting a task into a
# protected branch requires a one-time human approval via 'lazy approve
# <task>'. While disabled, nothing below has any effect.
# Turn it on — this alone protects the repo's DEFAULT branch (e.g. main),
# no branch listing needed:
# enabled = true
# Same thing from the CLI: lazy protect main on
# When enabled, protection of the default branch itself can be switched off:
# gate_default_branch = false
# On GitHub/GitLab, approving the task's PR/MR satisfies this same gate — no
# separate "lazy approve" needed.
# Additional protected branches (exact names) — merges INTO them need approval:
# protected_branches = ["release"]
# Protected tasks (task code or short id) — merging that task's work OUT,
# into any target, needs approval:
# protected_tasks = ["add-auth"]
# Manage both lists with: lazy protect <branch|task> on|off
# File holding the approval passphrase (create it out-of-band; gitignored):
# passphrase_file = ".lazy/approve-passphrase"

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

# Pre-accept — OPT-IN (enabled = false by default). A single agent turn that
# runs when a task is being accepted, BEFORE the merge. The home for expensive
# one-time validation (full test suite, build) and for maintained-files
# completeness (the CHANGELOG entry written once against the final diff). Every
# pre-accept turn also records a short built-in post-mortem to the task journal
# (not configurable).
#
# It costs a full agent turn on EVERY accept, so accept is fast by default and
# you opt in with enabled = true.
#
# commands = the merge GATE: after the agent's turn the supervisor re-runs
# them, and if any exits non-zero the accept is ABORTED and the task returns to
# blocked with the failure surfaced. Empty by default (a lightweight
# post-mortem + maintained-files turn).
#
# [automation.pre_accept]
# enabled = true
# commands = ["bun test", "bun run build"]
# timeout = 600

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

# [proxy]
# Built-in Anthropic-native passthrough proxy — enables request-level audit
# logging (tool_use / tool_result contents, token usage, routing hints).
# When set, the daemon starts the proxy on 'port'. Point a role target at it
# with backend = "proxy" and endpoint = "http://127.0.0.1:<port>".
# port = 8766
# bind = "127.0.0.1"
# upstream = "https://api.anthropic.com"
#
# Smart routing (opt-in): on a primary 429/529 or an unreachable primary, the
# proxy reroutes to the fallback targets below, in order — re-sending the same
# request. Failover is EXPLICIT: with no [[proxy.fallback]] entries the proxy
# fails hard as before. Every reroute is logged and recorded in the audit trail
# so you can see which turns ran on a fallback. Anthropic-native targets only.
# On a 429 with Retry-After ≤ retry_after_threshold seconds, the proxy waits and
# retries the primary once before failing over (default 5).
# retry_after_threshold = 5
#
# [[proxy.fallback]]
# upstream = "http://host.docker.internal:11434"   # e.g. local Ollama
# model = "qwen3.5:35b-a3b-coding-nvfp4"           # optional model override

# Mechanistic policy plane (§6.3 layer 1) — deterministic, injection-proof
# deny-rules applied to each tool_use BEFORE it executes. When [proxy] is set
# these are ON by default with a closed posture: inherited claude.ai account
# connectors (mcp__claude_ai_*) are DENIED by default (they are injected
# server-side and bypass the OS sandbox and lazy's permission model), and reads
# of secret/credential paths (~/.ssh, .env, credentials) are denied. On a
# violation the proxy rewrites the response so the call never runs and the agent
# is told why. Set enforce = false for pure passthrough/audit with no enforcement.
# [proxy.policy]
# enforce = true
# Re-allow specific inherited connectors by exact tool name:
# connector_allowlist = ["mcp__claude_ai_gmail_search"]
# deny_secret_path_reads = true
# Extra absolute-path globs to deny for read/write tools:
# deny_path_globs = ["/etc/**", "**/*.key"]
# Restrict WebFetch egress to these hosts (empty/unset = unrestricted):
# egress_allowlist = ["api.github.com"]

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

[limits]
# Concurrency caps for containers. When many tasks launch at once Docker
# struggles (slow launches, probe timeouts), so lazy caps how many run at once.
# Max live agent task containers (a blocked task awaiting review keeps its
# container alive, so it counts too). New starts beyond this queue; the daemon
# launches them automatically as slots free (highest priority first, then FIFO).
# Set a task's priority with: lazy prioritize <task> <low|normal|high|urgent>
# max_concurrent_agents = 8
# Max concurrent interactive builder containers. New builders beyond this fail
# fast (an interactive session a human is waiting on is never queued).
# max_concurrent_builders = 8
# Minutes an idle blocked container may linger (kept warm for a likely next turn)
# before the reaper frees its slot. Same-or-higher-priority queued work overrides
# this grace immediately. 0 = reap as soon as idle. Docker/podman only; an idle
# host-process supervisor is a cheap process and is exempt from grace-based reaping.
# idle_grace_minutes = 10
# Override either cap for the running daemon only (ephemeral, no lazy.toml edit):
#   lazy daemon config set max_concurrent_agents 12
`;
}
