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
 * public-docs/lazy-toml.md so the user-facing reference stays in sync.
 *
 * A key missing from this schema is reported to the user as an unknown option
 * even though it works, so test/unit/config-schema-drift.test.ts cross-checks
 * this table against everything lazy.toml.example documents (commented-out
 * examples included) and fails on drift in either direction.
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
  git: ['default_branch_prefix', 'lfs_check'],
  output: ['shortid_length'],
  // `graceful_exit_timeout_ms` is the pre-rename spelling of
  // `wind_down_timeout_ms`. Kept known (not unknown) so an existing lazy.toml
  // doesn't trip `lazy doctor` — the loader maps it onto the new key.
  agent: ['agent_id', 'watchdog_output_timeout_ms', 'wind_down_timeout_ms', 'graceful_exit_timeout_ms', 'effort'],
  builder: ['effort'],
  chattiness: ['default', 'builder', 'agent'],
  server: ['port', 'sync_interval', 'bind'],
  remote: [
    'driver', 'git_remote', 'auto_approve', 'offline',
    // Driver-specific keys are also valid at the schema level — a user may
    // configure GitHub keys while temporarily using the local driver, and we
    // should not warn about them. Drivers extend this list at runtime too.
    'github_auto_push', 'github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection',
    'gitlab_auto_push', 'gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection',
  ],
  docker: ['dockerfile'],
  runner: ['type', 'permission_mode', 'sandbox_allowed_domains', 'sandbox_deny_read', 'sandbox_deny_write', 'sandbox_allow_weaker_nested'],
  ollama: ['enabled', 'model', 'endpoint'],
  // 'fallback' is an array of tables ([[proxy.fallback]]); its inner keys
  // (upstream, model) are validated by the config loader, not this scan.
  // 'policy' is a nested table ([proxy.policy]); its inner keys (enforce,
  // connector_allowlist, deny_secret_path_reads, deny_path_globs,
  // egress_allowlist) are likewise resolved by the config loader.
  // 'enabled' was REMOVED — the proxy is always on. It is deliberately absent
  // here so a stale key is reported rather than tolerated; the config loader
  // rejects it outright with the migration message.
  proxy: ['port', 'bind', 'upstream', 'cursor_upstream', 'fallback', 'retry_after_threshold', 'policy'],
  memory: ['warn_bytes'],
  documents: ['path'],
  docs: ['url'],
  worktree: ['include'],
  permissions: ['protected'],
  // `passphrase_file` is REMOVED, not renamed: the approval passphrase now
  // lives hashed in a machine-global store outside every repo, so there is no
  // path left for the repo to point at. It is deliberately absent here and
  // listed in DEPRECATED_SECTION_KEYS below, so a stale key gets the migration
  // message instead of a generic "unknown option".
  protection: ['enabled', 'protected_branches', 'protected_tasks', 'gate_default_branch'],
  // 'pre_accept' is a nested table ([automation.pre_accept]); its inner keys
  // (enabled, commands, timeout) are validated by the config loader/defaults,
  // not this one-level scan.
  automation: ['maintain', 'pre_accept'],
  // 'mounts' is an array of tables ([[mounts]]); its inner keys (type, source,
  // name, target, readonly) are validated by the config loader, not this scan.
  mounts: ['type', 'source', 'name', 'target', 'readonly'],
  checks: ['post_turn', 'post_turn_timeout'],
  limits: ['max_concurrent_agents', 'max_concurrent_builders', 'idle_grace_minutes', 'max_turns_without_human'],
  daemon: ['auto_react_ci', 'auto_react_comments', 'auto_react_max_retries', 'auto_react_backoff', 'auto_react_daily_budget', 'max_auto_turns', 'auto_resume', 'auto_resume_interval_minutes', 'auto_resume_gap_minutes', 'auto_resume_max_attempts'],
  features: [], // accepts arbitrary keys — checked separately by feature flags system
};

/** Sections that accept arbitrary keys (not checked for unknown keys). */
const FREEFORM_SECTIONS = new Set(['features']);

/**
 * Keys that USED to be valid and now are not, with the migration each one
 * needs. `[remote]` has had a driver-provided version of this forever
 * (`getConfigOptions().deprecated`); this is the same idea for the sections
 * lazy owns itself.
 *
 * A key listed here is NOT reported as unknown — a generic "Unknown config
 * option" sends the human hunting for a typo when the real answer is "that
 * moved, here is where". `lazy doctor` renders these as their own findings
 * (checkConfigKeys), and the config loader prints one short line at load time
 * pointing there (single-warning-surface convention).
 *
 * Keyed `section.key`; the value is the full remedy sentence.
 */
export const DEPRECATED_SECTION_KEYS: Record<string, string> = {
  'protection.passphrase_file':
    'The approval passphrase is no longer a file inside the repository. It lives hashed in a ' +
    'machine-global store (~/.lazy/passphrase.json), because an in-repo plaintext file was ' +
    'readable by every task agent, and a repo-controlled path let an agent point the gate at a ' +
    'file it had just written. Enroll once with `lazy system passphrase set`, delete any ' +
    'leftover `.lazy/approve-passphrase`, then remove this key from [protection].',
};

/** Every `section.key` in a raw config that is deprecated, in file order. */
export function findDeprecatedConfigKeys(raw: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const dotted of Object.keys(DEPRECATED_SECTION_KEYS)) {
    const [section, key] = dotted.split('.');
    const sectionValue = raw[section];
    if (typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue)) continue;
    if (key in (sectionValue as Record<string, unknown>)) found.push(dotted);
  }
  return found;
}

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

    // Array-of-tables sections (e.g. [[mounts]]) surface as arrays. Their
    // section name is known; the inner table keys are validated by the config
    // loader, not this one-level scan. Iterating an array here would mistake
    // its numeric indices for unknown keys.
    if (Array.isArray(sectionValue)) continue;

    const knownKeys = section === 'remote' ? remoteAllKnown : KNOWN_CONFIG_SCHEMA[section];
    for (const key of Object.keys(sectionValue)) {
      // A deprecated key is known-but-obsolete: it gets its own migration
      // message (see DEPRECATED_SECTION_KEYS), never "unknown option".
      if (`${section}.${key}` in DEPRECATED_SECTION_KEYS) continue;
      if (!knownKeys.includes(key)) {
        warnings.push(`Unknown config option '${section}.${key}' in lazy.toml`);
      }
    }
  }

  return warnings;
}
