/**
 * Known config schema — the set of valid top-level sections and their keys.
 *
 * Derived from ResolvedConfig. Used by doctor to detect unknown keys
 * (typos, stale options from older versions, etc.).
 *
 * The 'features' section is excluded because it accepts arbitrary keys.
 * The 'remote' section's valid keys are extended at runtime by the driver.
 *
 * When you add, rename, or remove a key here, also update
 * docs/lazy-toml.md so the user-facing reference stays in sync.
 */

/**
 * Known top-level scalar keys (not sections).
 * 'runner' appears here for backward compat (top-level `runner = "docker"` string)
 * AND in KNOWN_CONFIG_SCHEMA for the new `[runner]\ntype = "docker"` section format.
 * The validation logic handles both: strings are skipped, objects are validated as sections.
 */
export const KNOWN_TOP_LEVEL_KEYS: readonly string[] = ['runner'];

/** Known top-level sections and their known keys. */
export const KNOWN_CONFIG_SCHEMA: Record<string, readonly string[]> = {
  // 'roles' is a nested table ([models.roles.builder] / [models.roles.agent]);
  // its inner keys are validated by the config loader, not the one-level scan here.
  models: ['default', 'roles'],
  session: ['verbose', 'debug', 'auto_commit_instructions'],
  data: ['path'],
  storage: ['backend', 'external_path', 'postgres_ssl'],
  git: ['default_branch_prefix'],
  output: ['shortid_length'],
  agent: ['agent_id', 'watchdog_output_timeout_ms', 'graceful_exit_timeout_ms', 'effort'],
  builder: ['effort'],
  chattiness: ['default', 'builder', 'agent'],
  server: ['port', 'sync_interval', 'bind'],
  remote: [
    'driver', 'git_remote', 'auto_approve',
    // Driver-specific keys are also valid at the schema level — a user may
    // configure GitHub keys while temporarily using the local driver, and we
    // should not warn about them. Drivers extend this list at runtime too.
    'github_auto_push', 'github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection',
    'gitlab_auto_push', 'gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection',
  ],
  docker: ['dockerfile'],
  runner: ['type', 'docker_agent_no_network'],
  ollama: ['enabled', 'model', 'endpoint'],
  documents: ['path'],
  worktree: ['include'],
  permissions: ['protected'],
  automation: ['maintain'],
  checks: ['post_turn', 'post_turn_timeout'],
  daemon: ['auto_react_ci', 'auto_react_comments', 'auto_react_max_retries', 'auto_react_backoff', 'auto_react_daily_budget', 'max_auto_turns'],
  features: [], // accepts arbitrary keys — checked separately by feature flags system
};

/** Sections that accept arbitrary keys (not checked for unknown keys). */
const FREEFORM_SECTIONS = new Set(['features']);

/**
 * Compare a raw TOML config object against the known schema.
 * `extraRemoteKeys` extends the valid keys for [remote] (from driver).
 * `deprecatedRemoteKeys` are keys the driver knows are obsolete —
 * they won't trigger "unknown" warnings (they get their own specific warning).
 * Returns a list of warning messages for unknown sections or keys.
 */
export function findUnknownConfigKeys(
  raw: Record<string, unknown>,
  extraRemoteKeys?: string[],
  deprecatedRemoteKeys?: string[],
): string[] {
  const warnings: string[] = [];

  // Build the full set of known remote keys (base + driver-provided + deprecated)
  const remoteAllKnown = [
    ...KNOWN_CONFIG_SCHEMA.remote,
    ...(extraRemoteKeys ?? []),
    ...(deprecatedRemoteKeys ?? []),
  ];

  for (const section of Object.keys(raw)) {
    // Skip known top-level scalar keys when they are scalars (backward compat).
    // If the value is an object, fall through to section validation.
    if (KNOWN_TOP_LEVEL_KEYS.includes(section) && typeof raw[section] !== 'object') continue;

    if (!(section in KNOWN_CONFIG_SCHEMA)) {
      warnings.push(`Unknown config section '[${section}]' in lazy.toml`);
      continue;
    }

    if (FREEFORM_SECTIONS.has(section)) continue;

    const sectionValue = raw[section];
    if (typeof sectionValue !== 'object' || sectionValue === null) continue;

    const knownKeys = section === 'remote' ? remoteAllKnown : KNOWN_CONFIG_SCHEMA[section];
    for (const key of Object.keys(sectionValue)) {
      if (!knownKeys.includes(key)) {
        warnings.push(`Unknown config option '${section}.${key}' in lazy.toml`);
      }
    }
  }

  return warnings;
}
