import { replaceWithProfileAdvice } from './agent-profile-advice';

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
  storage: ['backend', 'external_path'],
  git: ['default_branch_prefix', 'lfs_check'],
  output: ['shortid_length'],
  // `graceful_exit_timeout_ms` is the pre-rename spelling of
  // `wind_down_timeout_ms`. Kept known (not unknown) so an existing lazy.toml
  // doesn't trip `lazy doctor` — the loader maps it onto the new key.
  agent: [
    'agent_id', 'by_type', 'watchdog_output_timeout_ms', 'wind_down_timeout_ms', 'graceful_exit_timeout_ms', 'effort',
    // DEPRECATED: folded into [review] when the low-high loop became the
    // default review MODE. Same rule as [checks] and [loop] below — still
    // KNOWN, and honoured, so the unknown-key scan does not double-report it;
    // the deprecation itself is `lazy doctor`'s to report (see
    // HONOURED_DEPRECATED_KEYS).
    'low_high_loop', 'low_high_loop_draft_effort', 'low_high_loop_review_effort',
  ],
  // How a task gets reviewed once it declares final (see src/review/mode.ts).
  review: ['mode', 'auto_fix', 'gate', 'draft_effort', 'review_effort'],
  // `[agents.<name>]` — profile names are the user's own, so the section is
  // freeform (see FREEFORM_SECTIONS) and this scan never reports an unknown key
  // in it: the keys INSIDE each profile block are validated by
  // resolveAgentProfiles at config load, which is a better place for it because
  // it can say what to write instead.
  //
  // They are still LISTED, because this table is also the inventory every key
  // must be classified against for managed mode (src/config/managed.ts): a
  // profile key nobody classified is a key a shared host would honour from an
  // untrusted repository, and `endpoint` is where the real model credential
  // goes.
  agents: ['harness', 'model', 'endpoint', 'credential'],
  builder: ['effort'],
  chattiness: ['default', 'builder', 'agent'],
  server: ['port', 'sync_interval', 'bind', 'dashboard_url'],
  remote: [
    'driver', 'git_remote', 'auto_approve', 'offline',
    // Driver-specific keys are also valid at the schema level — a user may
    // configure GitHub keys while temporarily using the local driver, and we
    // should not warn about them. Drivers extend this list at runtime too.
    'github_auto_push', 'github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection',
    'gitlab_auto_push', 'gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection',
  ],
  docker: ['dockerfile', 'build_inputs', 'run_args'],
  runner: ['type', 'permission_mode', 'sandbox_allowed_domains', 'sandbox_deny_read', 'sandbox_deny_write', 'sandbox_allow_weaker_nested', 'verify_sandbox_boundary'],
  // `[ollama]` is REMOVED, not renamed — see DEPRECATED_SECTIONS below. It is
  // deliberately absent here: listing its keys as valid made this scan report
  // "no unknown config options" for a file the loader refuses outright.
  credentials: ['backend'],
  // 'fallback' is an array of tables ([[proxy.fallback]]); its inner keys
  // (upstream, model) are validated by the config loader, not this scan.
  // 'policy' is a nested table ([proxy.policy]); its inner keys (enforce,
  // connector_allowlist, deny_secret_path_reads, deny_path_globs,
  // egress_allowlist) are validated by the config loader (resolveProxyPolicy),
  // not this scan.
  // 'enabled' was REMOVED — the proxy is always on. 'openai_upstream' was
  // REMOVED — an upstream is a property of an agent profile now. Both are
  // deliberately absent here so a stale key is reported rather than tolerated;
  // the config loader rejects each outright with its migration message.
  proxy: ['port', 'bind', 'upstream', 'cursor_upstream', 'fallback', 'retry_after_threshold', 'upstream_timeout', 'policy'],
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
  automation: [
    'maintain',
    'react',
    'pre_accept',
    'pre_turn',
    'pre_turn_timeout',
    'pre_turn_required',
    'post_turn',
    'post_turn_timeout',
    'accept_check',
    'accept_check_timeout',
  ],
  // 'mounts' is an array of tables ([[mounts]]); its inner keys (type, source,
  // name, target, readonly) are validated by the config loader, not this scan.
  mounts: ['type', 'source', 'name', 'target', 'readonly'],
  // 'services' is a nested table ([serve.services]); its inner keys are service
  // NAMES chosen by the user, so they are validated by the config loader (name
  // shape + port range), not by this one-level scan.
  serve: ['ports', 'services', 'start_services_cmd'],
  // DEPRECATED: folded into [automation]. Kept known so the unknown-key scan
  // does not double-report it — `lazy doctor` reports the deprecation itself.
  checks: ['post_turn', 'post_turn_timeout'],
  // DEPRECATED: renamed to [cluster] when the `loop` task type became `cluster`.
  // Same rule as [checks] — known so the unknown-key scan does not double-report
  // it; the deprecation itself is `lazy doctor`'s to report.
  loop: ['max_child_fix_rounds'],
  memory: ['warn_bytes'],
  limits: ['max_concurrent_builders', 'max_turns_without_human'],
  cluster: ['max_child_fix_rounds'],
  usage_pause: ['threshold_percent', 'credentials'],
  daemon: ['auto_react_ci', 'auto_react_comments', 'auto_react_max_retries', 'auto_react_backoff', 'auto_react_daily_budget', 'max_auto_turns', 'auto_resume', 'auto_resume_interval_minutes', 'auto_resume_gap_minutes', 'auto_resume_max_attempts'],
  features: [], // accepts arbitrary keys — checked separately by feature flags system
};

/**
 * Sections that accept arbitrary keys (not checked for unknown keys).
 *
 * `agents` is here because its keys are PROFILE NAMES the user invents. Its
 * inner keys are still a closed set — `resolveAgentProfiles` rejects an unknown
 * one at config load with a hint, which is stricter than this scan's warning.
 */
export const FREEFORM_SECTIONS = new Set(['features', 'agents']);

/**
 * Whole SECTIONS lazy has removed, with the migration each one needs — the
 * section-level twin of {@link DEPRECATED_SECTION_KEYS}.
 *
 * A section listed here is not reported as unknown. "Unknown config section
 * '[ollama]'" reads as a typo and sends the human looking for one, when the
 * answer is "that concept moved, here is where" — and the section is not
 * unknown at all: the config loader knows it well enough to refuse the load
 * over it. This is the surface that carries the remedy (`lazy doctor`); the
 * loader prints one short line at the point of occurrence.
 *
 * Keyed by section name; the value is the full remedy sentence.
 */
export const DEPRECATED_SECTIONS: Record<string, () => string> = {
  ollama: () =>
    'It pointed BOTH roles at one Ollama server, which is the role-wide choice agent profiles ' +
    'replace: an upstream is a property of a named profile now, and a task selects one. ' +
    replaceWithProfileAdvice(
      '  [agents.<name>]\n' +
      '  harness = "<the agent you run>"\n' +
      '  model = "<the model that server serves>"\n' +
      '  endpoint = "<the value that was here>"',
      'Then point `[agent] agent_id` (or one task, with `lazy create --agent <name>`) at it. ' +
      '`lazy doctor --fix agents` rewrites this for you.',
    ),
};

/** Every deprecated SECTION present in a raw config, in listed order. */
export function findDeprecatedConfigSections(raw: Record<string, unknown>): string[] {
  return Object.keys(DEPRECATED_SECTIONS).filter((section) => raw[section] !== undefined);
}

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
export const DEPRECATED_SECTION_KEYS: Record<string, () => string> = {
  'proxy.openai_upstream': () =>
    'An upstream is a property of an AGENT PROFILE now, not a single global value every ' +
    'OpenAI-key-granted caller shared. ' +
    replaceWithProfileAdvice(
      '  [agents.codex]\n' +
      '  harness = "codex"\n' +
      '  model = "<the model that server serves>"\n' +
      '  endpoint = "<the value that was here>"',
      'Then delete this key from [proxy]. Tasks pick a profile with `lazy create --agent <name>`.',
    ),
  'protection.passphrase_file': () =>
    'The approval passphrase is no longer a file inside the repository. It lives hashed in a ' +
    'machine-global store (~/.lazy/passphrase.json), because an in-repo plaintext file was ' +
    'readable by every task agent, and a repo-controlled path let an agent point the gate at a ' +
    'file it had just written. Enroll once with `lazy system passphrase set`, delete any ' +
    'leftover `.lazy/approve-passphrase`, then remove this key from [protection].',
  'agent.ivan_loop': () =>
    'The experimental two-phase turn is now called the low-high loop (draft at low effort, ' +
    'self-review at high effort, one revise pass). Rename this key to `low_high_loop`; the ' +
    'per-task flag is `lazy start --low-high-loop on|off`.',
  'agent.ivan_loop_draft_effort': () =>
    'The experimental two-phase turn is now called the low-high loop. Rename this key to ' +
    '`low_high_loop_draft_effort`.',
  'agent.ivan_loop_review_effort': () =>
    'The experimental two-phase turn is now called the low-high loop. Rename this key to ' +
    '`low_high_loop_review_effort`.',
  'agent.low_high_loop': () =>
    'The low-high loop is no longer an experiment bolted onto [agent] — it is the DEFAULT ' +
    'review mode, and its settings live in [review]. This key is still honoured: `true` means ' +
    '`[review] mode = "low_high"`, `false` means `[review] mode = "separate"` (the daemon ' +
    'dispatching a reviewer of its own, which is what `false` did before). Write the mode you ' +
    'want in [review] and delete this key; setting both to different things is an error.',
  'agent.low_high_loop_draft_effort': () =>
    'The low-high loop settings moved to [review]. Rename this key to `draft_effort` under ' +
    '[review]; it is still honoured meanwhile.',
  'agent.low_high_loop_review_effort': () =>
    'The low-high loop settings moved to [review]. Rename this key to `review_effort` under ' +
    '[review]; it is still honoured meanwhile.',
};

/**
 * The one short clause the config loader adds to its generic load-time warning
 * for a removed key — enough to name the replacement without restating the full
 * remedy, which lives in `lazy doctor` alone.
 */
export const DEPRECATED_KEY_HINTS: Record<string, string> = {
  'protection.passphrase_file': 'Enroll the approval passphrase with `lazy system passphrase set` instead.',
  'agent.ivan_loop': 'Use `low_high_loop` instead.',
  'agent.ivan_loop_draft_effort': 'Use `low_high_loop_draft_effort` instead.',
  'agent.ivan_loop_review_effort': 'Use `low_high_loop_review_effort` instead.',
  'agent.low_high_loop': 'Use `[review] mode` instead ("low_high" or "separate").',
  'agent.low_high_loop_draft_effort': 'Use `[review] draft_effort` instead.',
  'agent.low_high_loop_review_effort': 'Use `[review] review_effort` instead.',
};

/**
 * Deprecated keys that are still HONOURED — renamed, not removed.
 *
 * The rest of `DEPRECATED_SECTION_KEYS` names keys lazy IGNORES, and the two
 * cannot share a message: telling someone their `low_high_loop = true` is
 * "obsolete and is ignored" when the loader is acting on it would be a lie in
 * the one direction a config warning may never fail — a human who believes a
 * setting is dead leaves it in place, and it keeps deciding.
 *
 * A key listed here has its own fold in the loader (which strips it from the
 * resolved config and warns once) and its own `lazy doctor` finding saying the
 * value is still honoured. `findRemovedConfigKeys` is what the ignored-key
 * paths read, so a key added here is excluded from both automatically.
 */
export const HONOURED_DEPRECATED_KEYS: ReadonlySet<string> = new Set([
  'agent.low_high_loop',
  'agent.low_high_loop_draft_effort',
  'agent.low_high_loop_review_effort',
]);

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
 * Deprecated keys in this config that lazy IGNORES — the honoured ones removed.
 *
 * This is what the loader's strip-and-warn and doctor's "obsolete and is
 * IGNORED" finding read; {@link findDeprecatedConfigKeys} stays the full list
 * for anything that wants every deprecated key regardless of fate.
 */
export function findRemovedConfigKeys(raw: Record<string, unknown>): string[] {
  return findDeprecatedConfigKeys(raw).filter(k => !HONOURED_DEPRECATED_KEYS.has(k));
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

    // A removed section is known-but-obsolete: it gets its own migration
    // message (see DEPRECATED_SECTIONS), never "unknown section".
    if (section in DEPRECATED_SECTIONS) continue;

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
