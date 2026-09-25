import { join, resolve, isAbsolute, dirname, basename } from 'path';
import type { LazyConfig, ProxyFallbackCredential, ResolvedConfig, StorageBackendConfig, RoleName, RoleTarget, RoleTargetConfig } from './types';
import { VALID_EFFORT_LEVELS, VALID_HOST_PERMISSION_MODES, VALID_SANDBOX_BOUNDARY_VERIFICATIONS, VALID_CHATTINESS_LEVELS, VALID_LFS_CHECK_MODES, VALID_PROXY_FALLBACK_CREDENTIALS } from './types';
import { BACKEND_SELECTIONS, isBackendSelection } from '../credentials/backends';
import { VALID_TASK_TYPES, LEGACY_CLUSTER_TASK_TYPE } from '../types';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_BIND, DEFAULT_PROXY_BIND, DEFAULT_MEMORY_WARN_BYTES } from './constants';
import { pathExists, readFile } from '../utils/fs';
import { expandTilde } from '../utils/home';
import { validateMounts } from '../capture/mounts';
import { DEFAULT_OPENAI_UPSTREAM } from '../utils/openai-compat';
import { resolveServicePorts, resolveStartServicesCmd, type ServeConfigInput } from '../serve/ports';
import { DEFAULT_CURSOR_UPSTREAM, DEFAULT_UPSTREAM_TIMEOUT_SECONDS } from '../proxy/upstream-defaults';
import { defaultPolicyConfig, type ProxyPolicyConfig } from '../proxy/policy';
import { DEFAULT_DOCS_URL, normalizeDocsUrl, setDocsBaseUrl } from '../docs/links';
import { ANTHROPIC_DEFAULT_TARGET, roleTargetForProfile } from './default-target';
import { applyManagedPolicy, isManagedMode } from './managed';
import { generatedConfigProfileExamples, replaceWithProfileAdvice } from './agent-profile-advice';
import { findRemovedConfigKeys, DEPRECATED_KEY_HINTS } from './schema';
import {
  DEFAULT_REVIEW_AUTO_FIX,
  DEFAULT_REVIEW_GATE,
  DEFAULT_REVIEW_MODE,
  REVIEW_GATES,
  REVIEW_MODES,
  isReviewGate,
  isReviewMode,
  type ReviewMode,
} from '../review/mode';
// The endpoint the removed `[ollama]` block and `backend = "ollama"` defaulted
// to. Nothing resolves through it any more — it lives with the migration it
// serves, so the refusals below and `lazy doctor --fix agents` cannot drift.
import { LEGACY_OLLAMA_ENDPOINT, agentHarness } from './agent-migration';
import {
  agentProfileOrThrow,
  BUILDER_PROFILE_NAME,
  cacheAgentProfiles,
  DEFAULT_AGENT_PROFILE_NAME,
  resolveAgentProfiles,
  type AgentProfile,
} from './agent-profiles';
import {
  assertHostRunnerConfigAllowed,
  hostRunnerRemovedError,
  isHostRunnerType,
  isRemovedHostRunnerInput,
} from '../runner/host-runner-gate';
import { VALID_RUNNER_TYPES } from './types';
import { setBranchPrefix, getBranchPrefix, branchPrefixError } from '../git/branch-prefix';

const CONFIG_FILENAME = process.env.LAZY_CONFIG || 'lazy.toml';

/**
 * The directory whose lazy.toml governs a project: ALWAYS the project root.
 *
 * INVARIANT: a lazy.toml inside a task worktree has no authority. This used to
 * walk UP from a caller's cwd (or an explicit `cwd` option) and take the
 * nearest lazy.toml, which for a task worktree at `<root>/.lazy/worktrees/<x>`
 * meant the worktree's own copy shadowed the repository's. That file is on an
 * agent-writable branch, so a turn could choose the config its NEXT turn ran
 * under: blank `[permissions] protected` so no violation is ever recorded,
 * blank `[checks] post_turn`, zero the watchdog, drop `[[maintain]]` groups, or
 * pick its own model and effort. It also wedged operationally — a worktree
 * carrying a config shape the daemon rejects made `unblock` and `sync` fail,
 * and sync is the very command that would have brought the fix in.
 *
 * Anchoring here rather than at each call site is deliberate: a per-caller rule
 * is one new launch path away from being wrong again. There are no per-key
 * carve-outs. If a per-task setting is ever wanted it follows the container
 * image pattern — explicit human TTY consent, pinned on the task — never a file
 * on the branch (see "Task worktrees never auto-govern container images" and
 * "A task worktree's lazy.toml has no authority" in CLAUDE.md).
 *
 * Nothing is lost for humans: `findLazyRoot()` already maps a worktree back to
 * the main repository, and a `lazy` run from any ordinary subdirectory found
 * the root's config anyway — no subdirectory but a worktree carries a lazy.toml.
 */
function findConfigDir(lazyRoot: string): string {
  return resolve(lazyRoot);
}

// Default configuration values
export const DEFAULT_CONFIG: ResolvedConfig = {
  models: {
    default: 'claude-opus-5',
    roles: {
      // Both roles default to the built-in `claude-code` profile: no pinned
      // endpoint, and an empty model meaning "use the normal model chain /
      // models.default". `[models.roles.*] agent` and `[agent] agent_id` name a
      // different profile in loadConfig; a per-task `--agent` overrides both.
      builder: ANTHROPIC_DEFAULT_TARGET,
      agent: ANTHROPIC_DEFAULT_TARGET,
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
  },
  git: {
    default_branch_prefix: 'lazy',
    lfs_check: 'refuse',
  },
  output: {
    shortid_length: 8,
  },
  // No `[agents.<name>]` blocks by default: the built-in profiles (one per
  // harness, defined in ./agent-profiles.ts) are what a project without this
  // section gets, and they reproduce each harness's existing defaults exactly.
  agents: {},
  agent: {
    agent_id: 'claude-code',
    by_type: {},
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
  review: {
    // FAST FIRST. The writer reviews its own work in its own session, at high
    // effort, with the diff already in context — see src/review/mode.ts for the
    // decision and the cluster run that produced it.
    mode: DEFAULT_REVIEW_MODE,
    // A `separate` review that finds something hands back rather than starting
    // a fix round by itself: whether another ~30-minute round is worth it is a
    // judgement the driver or the human makes, not the daemon.
    auto_fix: DEFAULT_REVIEW_AUTO_FIX,
    // The MODE decides which reviews gate, and a review somebody asked for
    // gates whatever the mode says. `always` and `never` are the two explicit
    // ways to overrule that.
    gate: DEFAULT_REVIEW_GATE,
    draft_effort: 'low',
    review_effort: 'xhigh',
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
    dashboard_url: '',
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
    build_inputs: [],
    run_args: [],
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
    // Off by default: the guard costs three real headless sessions and needs an
    // interactively logged-in `claude`, which a daemon host may not have. CI
    // (.github/workflows/host-sandbox-guard.yml) is the standing signal.
    verify_sandbox_boundary: 'off',
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
  },
  automation: {
    maintain: [],
    react: [],
    pre_accept: {
      // OPT-IN. The MECHANICAL acceptance gate — the configured commands run in
      // an ephemeral container on the task's worktree at accept, and a non-zero
      // exit aborts the merge. No agent runs here, so it costs commands-time
      // only; it stays opt-in because an accept blocks on it and some projects
      // gate elsewhere (CI). Enabled = false by default.
      enabled: false,
      commands: [],
      timeout: 600,
    },
    // OPT-IN. Empty command = no hook. The pre-turn hook runs in the worktree
    // before every agent turn; because agent-started processes now survive turn
    // boundaries, its job is "ensure services are up" (first turn, crashed
    // service, fresh container) — so hook scripts must be idempotent.
    pre_turn: '',
    pre_turn_timeout: 120,
    pre_turn_required: false,
    post_turn: '',
    post_turn_timeout: 300,
    // OPT-IN. Empty command = no accept gate, and accept says so rather than
    // guessing a build command for the project.
    accept_check: '',
    accept_check_timeout: 300,
  },
  mounts: [],
  serve: { services: [], start_services_cmd: '' },
  // "auto": OS secret storage where the host has it, a 0600 file where it does
  // not. Whichever is chosen is reported by `lazy auth list` and `lazy doctor`
  // rather than left implicit.
  credentials: {
    backend: 'auto',
  },
  // The proxy is always on: a project with no lazy.toml at all still gets a
  // fully-defaulted, live proxy config. There is no "no proxy" resolved state.
  proxy: {
    port: 0,
    bind: DEFAULT_PROXY_BIND,
    upstream: 'https://api.anthropic.com',
    cursorUpstream: DEFAULT_CURSOR_UPSTREAM,
    fallbacks: [],
    retryAfterThreshold: 5,
    upstreamTimeoutSeconds: DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
    policy: defaultPolicyConfig(),
  },
  memory: {
    warn_bytes: DEFAULT_MEMORY_WARN_BYTES,
  },
  docs: {
    url: DEFAULT_DOCS_URL,
  },
  limits: {
    max_concurrent_builders: 8,
    max_turns_without_human: 10,
  },
  cluster: {
    // Three rounds of "fix what the review found" per child. A cluster runs
    // unattended, so this is the mechanical bound on how many agent turns one
    // stubborn child can absorb before the driver has to decide instead.
    max_child_fix_rounds: 3,
  },
  // OFF by default: pausing only earns its keep where a subscription would
  // spill into paid overage. Without overage the provider stops at 100% anyway.
  usage_pause: {
    threshold_percent: 0,
    credentials: {},
  },
  daemon: {
    auto_react_ci: true,
    auto_react_comments: true,
    auto_react_max_retries: 3,
    auto_react_backoff: 'exponential',
    auto_react_daily_budget: 50,
    max_auto_turns: 3,
    auto_resume: true,
    auto_resume_interval_minutes: 30,
    auto_resume_gap_minutes: 5,
    auto_resume_max_attempts: 24,
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

/**
 * Resolve a role's DEFAULT agent profile — what a task in this role runs when it
 * names none.
 *
 * A role has exactly one knob now: `[models.roles.<role>] agent = "<profile>"`.
 * Everything the role used to carry itself (backend, model, endpoint) is a
 * property of the profile, because it has to be able to differ between two tasks
 * in the SAME role — the whole reason profiles exist. Old spellings are refused
 * at load with the replacement config printed; see {@link refuseRoleBackendKeys}.
 *
 * Falling back: the agent role defaults to `[agent] agent_id`, which IS the
 * project's default profile name; the builder is Claude Code and only Claude
 * Code, so its fallback is fixed.
 */
function resolveRole(
  role: RoleName,
  explicit: RoleTargetConfig | undefined,
  profiles: Map<string, AgentProfile>,
  defaultProfileName: string,
): RoleTarget {
  const named = explicit?.agent?.trim();
  const where = named ? `lazy.toml [models.roles.${role}] agent` : undefined;
  const profile = agentProfileOrThrow(profiles, named || defaultProfileName, where);
  return roleTargetForProfile(profile);
}

/**
 * Refuse the pre-profile spellings of a role target, naming the replacement.
 *
 * A few real users have `[models.roles.agent] backend = "ollama"` in a working
 * lazy.toml. Reinterpreting it silently is the one thing lazy must not do here:
 * the keys still parse, so a tolerant reader would keep launching — against a
 * different upstream than the file says. So this throws, and prints the exact
 * profile block to paste in.
 *
 * The replacement is a NAMED profile plus a role pointer, never an override of
 * the built-in profile of the same name. `[agents.claude-code]` would also
 * capture every claude-code TASK, and a user migrating their BUILDER role has
 * not asked for that.
 */
function refuseRoleBackendKeys(role: RoleName, raw: unknown, harnessName: string): void {
  if (raw === undefined || raw === null) return;
  refuseMalformedLegacySection(`models.roles.${role}`, raw);
  const table = raw as Record<string, unknown>;
  const legacy = ['backend', 'model', 'endpoint'].filter(k => k in table);
  if (legacy.length === 0) return;

  const backend = typeof table.backend === 'string' ? table.backend.trim() : 'anthropic';
  const model = typeof table.model === 'string' ? table.model.trim() : '';
  const endpointRaw = typeof table.endpoint === 'string' ? table.endpoint.trim() : '';
  const endpoint = endpointRaw
    || (backend === 'ollama' ? LEGACY_OLLAMA_ENDPOINT : '')
    || (backend === 'openai' ? DEFAULT_OPENAI_UPSTREAM : '');
  // The harness stays whatever the project already runs: a backend never chose
  // one. Resolved through the SAME helper `lazy doctor --fix agents` uses, so
  // the block this error tells the user to paste is the block the fix writes —
  // a project with `agent_id = "pi"` used to be shown `harness = "claude-code"`
  // here while the fix wrote `harness = "pi"`.
  const harness = role === 'builder' ? BUILDER_PROFILE_NAME : harnessName;
  const profileName = `${role}-${backend}`;

  const block = [
    `  [agents.${profileName}]`,
    `  harness = ${JSON.stringify(harness)}`,
    `  model = ${JSON.stringify(model || '<the model this server serves>')}`,
    ...(endpoint ? [`  endpoint = ${JSON.stringify(endpoint)}`] : []),
    '',
    `  [models.roles.${role}]`,
    `  agent = ${JSON.stringify(profileName)}`,
  ].join('\n');

  throw new Error(
    `lazy.toml [models.roles.${role}] sets ${legacy.map(k => `\`${k}\``).join(', ')} — a role no ` +
    'longer carries a backend, a model or an endpoint. Those are properties of an AGENT PROFILE, ' +
    'so that two tasks in the same role can run different agents against different upstreams. ' +
    'A role now only names the profile it DEFAULTS to.\n\n' +
    replaceWithProfileAdvice(
      block,
      `Then delete ${legacy.map(k => `\`${k}\``).join(', ')} from [models.roles.${role}]. ` +
      `Individual tasks can override it with \`lazy create --agent <profile>\`. ` +
      'Run `lazy doctor --fix agents` to have lazy rewrite this for you.',
    ),
  );
}

/**
 * Refuse a legacy section that is PRESENT but is not a plain table.
 *
 * `[[ollama]]` (an array of tables) and `ollama = "..."` (a scalar) both parse
 * fine, and both used to fall into the "configured nothing" branch of the guards
 * below — because those asked "is this an empty table?" by first coercing
 * anything that was not a plain table to `{}`. So a real `[[ollama]]` carrying a
 * model and an endpoint was warned about and IGNORED at load, and then had its
 * keys DELETED by `lazy doctor --fix agents` (the section-header regex in
 * toml-edit matches `[[ollama]]` too). The same hole on the role path let
 * `[[models.roles.agent]] backend = "ollama"` load clean and fall back to the
 * default profile — the silent reinterpretation this whole migration exists to
 * prevent.
 *
 * A shape lazy cannot read is therefore a refusal, not a shrug: it may be
 * carrying real configuration, and lazy has no way to tell.
 */
function refuseMalformedLegacySection(section: string, raw: unknown): void {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return;
  const shape = Array.isArray(raw) ? 'an array of tables' : `a ${typeof raw} value`;
  throw new Error(
    `lazy.toml has a [${section}] entry written as ${shape}, which lazy cannot read. ` +
    'This section has been replaced by agent profiles, and lazy will not guess what a ' +
    'malformed one was meant to configure — ignoring it could silently point your agents ' +
    'at a different upstream than the file names.\n\n' +
    `Write [${section}] as a normal table (a single \`[${section}]\` header, not ` +
    `\`[[${section}]]\`), or delete it, then re-run. See \`lazy doctor\` for the profile ` +
    'form that replaces it.',
  );
}

/**
 * Refuse the legacy `[ollama]` block, naming the replacement.
 *
 * It was a role-wide alias for `[models.roles.*] backend = "ollama"` — it set
 * BOTH roles at once — so it has the same problem profiles exist to fix, twice
 * over. Same posture as {@link refuseRoleBackendKeys}: refuse loudly, print the
 * paste-in replacement, never reinterpret.
 *
 * A section with NO keys is the one exception, and it is not a softening of the
 * rule: an `[ollama]` header whose every line is a comment configured nothing
 * before profiles either, so there is nothing to reinterpret and nothing the
 * user asked for that lazy would now do differently. Refusing it would print a
 * migration for an Ollama server they never had — an error that is loud but not
 * true, which is worse than the dead section it complains about. It is reported
 * as a removed key instead (one line here, remedy in `lazy doctor`).
 */
function refuseOllamaBlock(raw: unknown, harnessName: string): void {
  if (raw === undefined) return;
  refuseMalformedLegacySection('ollama', raw);
  const table = raw as Record<string, unknown>;
  if (Object.keys(table).length === 0) {
    warnRemovedSection('ollama', 'Agent upstreams are now `[agents.<name>] endpoint`.');
    return;
  }
  const model = typeof table.model === 'string' ? table.model.trim() : '';
  const endpoint = (typeof table.endpoint === 'string' && table.endpoint.trim())
    || LEGACY_OLLAMA_ENDPOINT;

  throw new Error(
    'lazy.toml has an [ollama] section — it has been removed. It pointed BOTH roles at one ' +
    'Ollama server, which is the role-wide choice agent profiles replace: an upstream is now a ' +
    'property of a named profile, and a task selects one.\n\n' +
    replaceWithProfileAdvice(
      '  [agents.local-ollama]\n' +
      `  harness = ${JSON.stringify(harnessName)}\n` +
      `  model = ${JSON.stringify(model || '<the model this server serves>')}\n` +
      `  endpoint = ${JSON.stringify(endpoint)}\n\n` +
      '  [agent]\n' +
      '  agent_id = "local-ollama"',
      'Then delete the [ollama] section. `agent_id` makes it the default for new tasks; point one ' +
      'task elsewhere with `lazy create --agent claude-code`. ' +
      'Run `lazy doctor --fix agents` to have lazy rewrite this for you.',
    ),
  );
}

/**
 * Resolve the path to the lazy.toml that would be loaded for the given root.
 * Honors LAZY_CONFIG (absolute path or filename). Always the project root's
 * copy — see findConfigDir. Does NOT check whether the file exists.
 */
export function resolveConfigPath(lazyRoot: string): string {
  if (process.env.LAZY_CONFIG && isAbsolute(process.env.LAZY_CONFIG)) {
    return process.env.LAZY_CONFIG;
  }
  return join(findConfigDir(lazyRoot), CONFIG_FILENAME);
}

/**
 * Most lines of a config file we are willing to re-parse when locating a TOML
 * failure. A lazy.toml is a few hundred lines; the cap only exists so that a
 * `LAZY_CONFIG` pointed at something pathological cannot turn one error message
 * into a quadratic parse.
 */
const TOML_LOCATE_MAX_LINES = 2000;

/**
 * Find the line at which a TOML failure first appears, by re-parsing growing
 * prefixes of the source until one reproduces the SAME reason the whole file
 * did. Returns null when no prefix reproduces it.
 *
 * This is deliberately self-validating rather than heuristic: a prefix that cuts
 * through a multi-line array or string fails for its own truncation reason
 * ("Expected ]"), which does not match, so the scan simply keeps going until it
 * reaches the line that really is at fault. If nothing matches — a reason that
 * only the complete document can produce — the caller reports the reason alone
 * rather than naming a line it cannot stand behind (CLAUDE.md: never present a
 * guess as the explanation).
 */
function locateTomlFailure(source: string, reason: string): { line: number; text: string } | null {
  const lines = source.split('\n');
  if (lines.length > TOML_LOCATE_MAX_LINES) return null;

  for (let i = 1; i <= lines.length; i++) {
    try {
      Bun.TOML.parse(lines.slice(0, i).join('\n'));
    } catch (err) {
      const raw = (err as { message?: unknown } | null)?.message;
      if (typeof raw === 'string' && raw === reason) return { line: i, text: lines[i - 1] };
    }
  }
  return null;
}

/**
 * Render a `Bun.TOML.parse` failure as one line a human can act on.
 *
 * The reason alone ("Cannot redefine table 'runner'") tells the user *what* is
 * wrong but not *where*, which for a 300-line lazy.toml is close to useless. So
 * the line is always named when it can be established, from whichever of two
 * sources has it:
 *
 *  - Bun ≤1.3 threw a `BuildMessage` carrying the line number and the offending
 *    source text on a non-enumerable `.position`. Still read first, since it is
 *    authoritative when present. (`position.file` is Bun's internal name,
 *    "input.toml", and is deliberately NOT used; the caller names the real path.)
 *  - Bun 1.4 throws a plain `SyntaxError` with no TOML position at all — its
 *    `line`/`column` are the JS call site of `Bun.TOML.parse`, not a place in the
 *    document, and using them would point every user at a file in lazy's own
 *    source. There {@link locateTomlFailure} recovers the line by re-parsing.
 */
function describeTomlError(error: unknown, source?: string): string {
  // NOT `error instanceof Error`: Bun's BuildMessage is not an Error subclass,
  // so that test falls through to String(error) and yields a "BuildMessage: "
  // prefix the user has no use for. Read `.message` when it is a string.
  const raw = (error as { message?: unknown } | null)?.message;
  const reason = typeof raw === 'string' && raw ? raw : String(error);

  const position = (error as { position?: { line?: number; lineText?: string } } | null)?.position;
  if (position?.line) {
    const text = position.lineText ? `: ${position.lineText.trim()}` : '';
    return `line ${position.line}${text} — ${reason}`;
  }

  const located = source === undefined ? null : locateTomlFailure(source, reason);
  if (!located) return reason;
  const text = located.text.trim() ? `: ${located.text.trim()}` : '';
  return `line ${located.line}${text} — ${reason}`;
}

/** The `[checks]` keys that were folded into `[automation]`, old name → new name. */
export const CHECKS_DEPRECATED_KEYS = ['post_turn', 'post_turn_timeout'] as const;

/** True when the raw config declares any deprecated `[checks]` key. */
export function usesDeprecatedChecksSection(raw: Record<string, unknown> | null | undefined): boolean {
  const checks = raw?.checks as Record<string, unknown> | undefined;
  if (!checks || typeof checks !== 'object') return false;
  return CHECKS_DEPRECATED_KEYS.some(key => checks[key] !== undefined);
}

/** Emitted once per process so a deprecated config does not spam every load. */
let checksDeprecationWarned = false;

/** Test seam: reset the one-shot deprecation warning. */
export function resetChecksDeprecationWarning(): void {
  checksDeprecationWarned = false;
}

/**
 * Fold the deprecated `[checks]` table into `[automation]` on the resolved
 * config, with three rules:
 *
 *   1. `[checks]` is NEVER silently ignored — an unmatched `[automation]` key
 *      inherits the `[checks]` value, so an existing project keeps its gate.
 *   2. Both spellings set to DIFFERENT values is a hard error. Picking a winner
 *      would silently disable one of two things the author explicitly wrote.
 *   3. Otherwise: one short generic line at the point of occurrence, with the
 *      full diagnosis and remedy living in `lazy doctor` (single warning surface).
 */
function applyChecksDeprecation(
  parsed: LazyConfig,
  config: ResolvedConfig,
  configPath: string,
): void {
  const legacy = parsed.checks;
  // deepMerge copies keys it does not know about, so the deprecated table would
  // otherwise ride along on the resolved config as a stray second source of
  // truth. `[automation]` is the only one after this point.
  delete (config as unknown as Record<string, unknown>).checks;
  if (!legacy) return;

  const conflicts: string[] = [];
  for (const key of CHECKS_DEPRECATED_KEYS) {
    const oldValue = legacy[key];
    if (oldValue === undefined) continue;
    const newValue = parsed.automation?.[key];
    if (newValue === undefined) {
      // Only the deprecated spelling is set — honour it.
      (config.automation[key] as string | number) = oldValue;
      continue;
    }
    if (newValue !== oldValue) {
      conflicts.push(
        `  ${key}: [checks] ${JSON.stringify(oldValue)} vs [automation] ${JSON.stringify(newValue)}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Conflicting configuration in ${configPath}: [checks] and [automation] set the same ` +
      `key to different values.\n\n${conflicts.join('\n')}\n\n` +
      `[checks] is deprecated and was folded into [automation]. lazy will not guess which ` +
      `value you meant — delete the [checks] entry and keep the [automation] one.`,
    );
  }

  if (!usesDeprecatedChecksSection(parsed as Record<string, unknown>)) return;
  if (checksDeprecationWarned) return;
  checksDeprecationWarned = true;
  // Convention: one generic line here, full remedy in `lazy doctor`.
  console.warn('Warning: [checks] in lazy.toml is deprecated. Run `lazy doctor` for details.');
}

/** The one key `[loop]` ever had, now spelled `[cluster]`. */
export const LOOP_DEPRECATED_KEYS = ['max_child_fix_rounds'] as const;

/** Does this raw config still use the pre-rename `[loop]` section? */
export function usesDeprecatedLoopSection(raw: Record<string, unknown> | null | undefined): boolean {
  const loop = raw?.loop as Record<string, unknown> | undefined;
  if (!loop || typeof loop !== 'object') return false;
  return LOOP_DEPRECATED_KEYS.some(key => loop[key] !== undefined);
}

let loopDeprecationWarned = false;

/** Test seam: reset the one-shot `[loop]` warning. */
export function resetLoopDeprecationWarning(): void {
  loopDeprecationWarned = false;
}

/**
 * `[loop]` → `[cluster]`: a RENAME, honoured exactly like `[checks]` above.
 *
 * The task type `loop` became `cluster` on 2026-09-20, and its config section
 * moved with it. This is a rename and not a removal, so the old spelling is
 * still HONOURED — a project that set `max_child_fix_rounds = 5` asked for 5,
 * and silently giving it the default 3 because the header changed would be
 * lazy overruling a number the human chose. Same three rules the `[checks]`
 * fold uses: honour the old spelling when only it is set, refuse outright when
 * the two disagree (lazy will not guess), and warn once with the remedy in
 * `lazy doctor`.
 */
function applyLoopSectionDeprecation(
  parsed: LazyConfig,
  config: ResolvedConfig,
  configPath: string,
): void {
  const legacy = (parsed as unknown as Record<string, unknown>).loop as
    | Record<string, number | undefined>
    | undefined;
  // deepMerge copies keys it does not know about, so the deprecated table would
  // otherwise ride along on the resolved config as a stray second source of
  // truth. `[cluster]` is the only one after this point.
  delete (config as unknown as Record<string, unknown>).loop;
  if (!legacy) return;

  const conflicts: string[] = [];
  for (const key of LOOP_DEPRECATED_KEYS) {
    const oldValue = legacy[key];
    if (oldValue === undefined) continue;
    const newValue = parsed.cluster?.[key];
    if (newValue === undefined) {
      config.cluster[key] = oldValue;
      continue;
    }
    if (newValue !== oldValue) {
      conflicts.push(
        `  ${key}: [loop] ${JSON.stringify(oldValue)} vs [cluster] ${JSON.stringify(newValue)}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Conflicting configuration in ${configPath}: [loop] and [cluster] set the same ` +
      `key to different values.\n\n${conflicts.join('\n')}\n\n` +
      `The task type \`loop\` was renamed \`cluster\`, and [loop] was renamed with it. ` +
      `lazy will not guess which value you meant — delete the [loop] entry and keep ` +
      `the [cluster] one.`,
    );
  }

  if (!usesDeprecatedLoopSection(parsed as unknown as Record<string, unknown>)) return;
  if (loopDeprecationWarned) return;
  loopDeprecationWarned = true;
  // Convention: one generic line here, full remedy in `lazy doctor`.
  console.warn('Warning: [loop] in lazy.toml is deprecated — it is now [cluster]. Run `lazy doctor` for details.');
}

/** The three `[agent]` keys the `[review]` section absorbed, old name → new name. */
export const LOW_HIGH_DEPRECATED_KEYS = {
  low_high_loop: 'mode',
  low_high_loop_draft_effort: 'draft_effort',
  low_high_loop_review_effort: 'review_effort',
} as const;

/** Does this raw config still configure the low-high loop under `[agent]`? */
export function usesDeprecatedLowHighKeys(
  raw: Record<string, unknown> | null | undefined,
): boolean {
  const agent = raw?.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== 'object') return false;
  return Object.keys(LOW_HIGH_DEPRECATED_KEYS).some(key => agent[key] !== undefined);
}

let lowHighDeprecationWarned = false;

/** Test seam: reset the one-shot `[agent] low_high_loop*` warning. */
export function resetLowHighDeprecationWarning(): void {
  lowHighDeprecationWarned = false;
}

/**
 * `[agent] low_high_loop*` → `[review]`: the low-high loop stopped being an
 * experiment bolted onto the agent section and became one of the three review
 * MODES, so its keys moved into the section that owns that choice.
 *
 * Honoured, not dropped — same three rules as `[loop]` → `[cluster]` above: the
 * old spelling still decides when only it is set, the two disagreeing is a hard
 * error rather than a guess, and one warning points at `lazy doctor` for the
 * remedy.
 *
 * INVARIANT: `low_high_loop = false` maps to `mode = "separate"`, NEVER to the
 * new `low_high` default. False meant "no in-session loop, the daemon
 * dispatches its own reviewer", and that is `separate` — reading it as the new
 * default would silently switch every existing project into a different review
 * arm on upgrade, which is the opposite of honouring what they configured.
 */
function applyLowHighKeyDeprecation(
  parsed: LazyConfig,
  config: ResolvedConfig,
  configPath: string,
): void {
  const legacy = parsed.agent;
  // deepMerge copies unknown keys through, so the deprecated spellings would
  // otherwise ride along on the resolved config as a second source of truth.
  // `[review]` is the only one after this point.
  for (const key of Object.keys(LOW_HIGH_DEPRECATED_KEYS)) {
    delete (config.agent as unknown as Record<string, unknown>)[key];
  }
  if (!legacy) return;

  const conflicts: string[] = [];

  if (legacy.low_high_loop !== undefined) {
    const implied: ReviewMode = legacy.low_high_loop ? 'low_high' : 'separate';
    const explicit = parsed.review?.mode;
    if (explicit === undefined) {
      config.review.mode = implied;
    } else if (explicit !== implied) {
      conflicts.push(
        `  [agent] low_high_loop = ${JSON.stringify(legacy.low_high_loop)} means ` +
        `[review] mode = "${implied}", but [review] mode = ${JSON.stringify(explicit)}`,
      );
    }
  }

  for (const key of ['low_high_loop_draft_effort', 'low_high_loop_review_effort'] as const) {
    const oldValue = legacy[key];
    if (oldValue === undefined) continue;
    const newKey = LOW_HIGH_DEPRECATED_KEYS[key];
    const newValue = parsed.review?.[newKey];
    if (newValue === undefined) {
      config.review[newKey] = oldValue;
      continue;
    }
    if (newValue !== oldValue) {
      conflicts.push(
        `  [agent] ${key} ${JSON.stringify(oldValue)} vs [review] ${newKey} ${JSON.stringify(newValue)}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Conflicting configuration in ${configPath}: the deprecated [agent] low-high keys and ` +
      `[review] set the same thing to different values.\n\n${conflicts.join('\n')}\n\n` +
      `The low-high loop is now one of the review modes, so its settings moved to [review]. ` +
      `lazy will not guess which value you meant — delete the [agent] key and keep the ` +
      `[review] one.`,
    );
  }

  if (!usesDeprecatedLowHighKeys(parsed as unknown as Record<string, unknown>)) return;
  if (lowHighDeprecationWarned) return;
  lowHighDeprecationWarned = true;
  // Convention: one generic line here, full remedy in `lazy doctor`.
  console.warn(
    'Warning: the [agent] low_high_loop* keys in lazy.toml are deprecated — they are now ' +
    '[review]. Run `lazy doctor` for details.',
  );
}

/** Does this raw config still route the driving type by its pre-rename name? */
export function usesDeprecatedByTypeLoop(raw: Record<string, unknown> | null | undefined): boolean {
  const agent = raw?.agent as Record<string, unknown> | undefined;
  const byType = agent?.by_type as Record<string, unknown> | undefined;
  return Boolean(
    byType && typeof byType === 'object' && byType[LEGACY_CLUSTER_TASK_TYPE] !== undefined,
  );
}

let byTypeLoopDeprecationWarned = false;

/** Test seam: reset the one-shot `[agent.by_type] loop` warning. */
export function resetByTypeLoopDeprecationWarning(): void {
  byTypeLoopDeprecationWarned = false;
}

/**
 * `[agent.by_type] loop` → `cluster`, the THIRD surface of the same rename.
 *
 * `[agent.by_type]` keys are task type names, validated by THROWING on an
 * unknown one — so dropping `loop` from `VALID_TASK_TYPES` turned a routing
 * line that worked yesterday into a config `loadConfig` refuses. That does not
 * break one feature: every command goes through `loadConfig`, so the project
 * stops working entirely, including the commands that would diagnose it.
 *
 * Routing the driving type to a named profile is a natural thing to have done —
 * it runs unattended and burns turns — so this must not be the one surface of
 * the rename that hard-fails. It is folded here, before the validation loop,
 * with the same three rules as the `[loop]` section: honour the old spelling,
 * refuse only on a genuine conflict, and warn once with the remedy in
 * `lazy doctor`.
 */
function applyByTypeLoopDeprecation(config: ResolvedConfig, configPath: string): void {
  // `loop` is no longer a TaskType, so the typed view of this table cannot
  // express the key being folded away. The cast is confined to this function.
  const byType = config.agent.by_type as Record<string, string | undefined> | undefined;
  if (!byType || byType[LEGACY_CLUSTER_TASK_TYPE] === undefined) return;

  const legacy = byType[LEGACY_CLUSTER_TASK_TYPE];
  const current = byType.cluster;
  if (current !== undefined && current !== legacy) {
    throw new Error(
      `Conflicting configuration in ${configPath}: [agent.by_type] routes the same task type ` +
      `twice under both names — loop = ${JSON.stringify(legacy)} vs ` +
      `cluster = ${JSON.stringify(current)}.\n\n` +
      `The task type \`loop\` was renamed \`cluster\`. lazy will not guess which profile you ` +
      `meant — delete the \`loop\` entry and keep the \`cluster\` one.`,
    );
  }
  if (current === undefined) byType.cluster = legacy;
  // The alias is the only reader of the old key; leaving it on the resolved
  // config would be a stray second source of truth, exactly as the `[loop]`
  // table would have been.
  delete byType[LEGACY_CLUSTER_TASK_TYPE];

  if (byTypeLoopDeprecationWarned) return;
  byTypeLoopDeprecationWarned = true;
  console.warn(
    'Warning: [agent.by_type] loop in lazy.toml is deprecated — the type is now `cluster`. ' +
    'Run `lazy doctor` for details.',
  );
}

/** Emitted once per process, same one-shot rule as the `[checks]` warning. */
const removedKeysWarned = new Set<string>();

/** Test seam: reset the one-shot removed-key warnings. */
export function resetRemovedKeyDeprecationWarnings(): void {
  removedKeysWarned.clear();
}

/**
 * One line about a whole SECTION lazy has removed, same one-shot rule and same
 * single-warning-surface convention as {@link applyRemovedKeyDeprecations}.
 * Used for a section that carries no keys, where there is nothing to migrate
 * but the dead header should still not sit there unremarked.
 */
function warnRemovedSection(section: string, hint: string): void {
  if (removedKeysWarned.has(section)) return;
  removedKeysWarned.add(section);
  console.warn(
    `Warning: the [${section}] section in lazy.toml has been removed and is ignored. ` +
    `${hint} Delete the section. Run \`lazy doctor\` for details.`,
  );
}

/**
 * Handle config keys lazy has REMOVED outright (DEPRECATED_SECTION_KEYS).
 *
 * Two jobs. First, strip the key off the resolved config: deepMerge copies keys
 * it does not know about, so a removed key would otherwise ride along as a
 * stray second source of truth. Second, say something — a removed key the human
 * still believes is in force is exactly the "gate believed armed but isn't"
 * failure protection must never have. One short line here per the
 * single-warning-surface convention, naming the replacement command; the full
 * diagnosis and remedy live in `lazy doctor`.
 */
function applyRemovedKeyDeprecations(
  raw: Record<string, unknown>,
  config: ResolvedConfig,
): void {
  for (const dotted of findRemovedConfigKeys(raw)) {
    const [section, key] = dotted.split('.');
    const resolvedSection = (config as unknown as Record<string, unknown>)[section];
    if (resolvedSection && typeof resolvedSection === 'object') {
      delete (resolvedSection as Record<string, unknown>)[key];
    }
    if (removedKeysWarned.has(dotted)) continue;
    removedKeysWarned.add(dotted);
    const hint = DEPRECATED_KEY_HINTS[dotted];
    console.warn(
      `Warning: [${section}] ${key} in lazy.toml is obsolete and is ignored. ` +
      `${hint ? `${hint} ` : ''}` +
      `Run \`lazy doctor\` for details.`,
    );
  }
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
 * Fail loud when an [[automation.react]] / [[automation.maintain]] entry is
 * missing title, pattern, or instructions (or has a non-string). deepMerge
 * alone leaves malformed tables as-is; Bun.Glob then throws mid-supervisor
 * AFTER the work phase already committed — a config typo becoming a failed turn.
 */
function validateAutomationEntries(
  entries: Array<{ title?: unknown; pattern?: unknown; instructions?: unknown }>,
  kind: 'react' | 'maintain',
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const label = `lazy.toml [[automation.${kind}]] entry #${i + 1}`;
    for (const field of ['title', 'pattern', 'instructions'] as const) {
      const value = entry[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(
          `${label}: ${field} must be a non-empty string ` +
          `(got ${value === undefined ? 'missing' : JSON.stringify(value)}). ` +
          `Each entry needs title, pattern, and instructions.`,
        );
      }
    }
  }
}

/**
 * Load and parse the project's lazy.toml.
 *
 * There is no starting-directory parameter, deliberately: the config is ALWAYS
 * the project root's, whatever the caller's cwd is. See findConfigDir.
 */
export async function loadConfig(lazyRoot: string): Promise<ResolvedConfig> {
  const configPath = resolveConfigPath(lazyRoot);

  // If LAZY_CONFIG is explicitly set but the file doesn't exist, fail hard
  if (process.env.LAZY_CONFIG && !(await pathExists(configPath))) {
    throw new Error(
      `LAZY_CONFIG is set to '${process.env.LAZY_CONFIG}' but the file does not exist.\n` +
      (isAbsolute(process.env.LAZY_CONFIG)
        ? `The absolute path does not exist.`
        : `Looked for '${process.env.LAZY_CONFIG}' in the project root ${lazyRoot}.`) + '\n' +
      `Unset it with LAZY_CONFIG= or fix the path.`,
    );
  }

  // If no config file exists (and LAZY_CONFIG was not set), return defaults
  if (!(await pathExists(configPath))) {
    setDocsBaseUrl(DEFAULT_CONFIG.docs.url);
    setBranchPrefix(DEFAULT_CONFIG.git.default_branch_prefix);
    // A project with no lazy.toml still has to run on the FLEET's store and
    // runner, not on lazy's built-in defaults — so managed mode applies to the
    // empty config too. Deep-cloned first because DEFAULT_CONFIG is shared
    // module state and the policy writes in place.
    if (isManagedMode()) {
      const defaults = structuredClone(DEFAULT_CONFIG);
      applyManagedPolicy(defaults, null, configPath);
      return defaults;
    }
    // A copy, never the shared object: a caller that writes into the config
    // it was handed must not change what every later load returns.
    return structuredClone(DEFAULT_CONFIG);
  }

  let parsed: LazyConfig;
  // Read outside the parse try so the error path can quote the offending line —
  // and so an unreadable file is not reported as a syntax error, which it is not.
  let configContent: string;
  try {
    configContent = await readFile(configPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
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
    // host-process; `[proxy] upstream` would be ignored and traffic
    // would go to the stock upstream anyway; `[storage] external_path` would be ignored and
    // the store would split. Each one surfaces far from its cause.
    throw new Error(
      `Failed to parse ${configPath}: ${describeTomlError(error, configContent)}\n` +
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
  if (storageSection?.backend === 'postgres') {
    throw new Error(
      'Storage backend "postgres" was removed in v0.22. Export your store with the last release that has it, ' +
      'or switch to backend = "external" (file storage). SQLite storage is the go-forward second backend.',
    );
  }

  // Backward compat: top-level `runner = "docker"` (string) → `runner.type = "docker"`
  if (typeof raw.runner === 'string') {
    if (isRemovedHostRunnerInput(raw.runner)) {
      throw hostRunnerRemovedError('lazy.toml runner');
    }
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
  // Cloned first: deepMerge copies only the sections the file names, so every
  // section it omits would otherwise BE DEFAULT_CONFIG's object — and the
  // managed policy below writes into the config in place, which once turned
  // lazy's built-in default store into a fleet path for the rest of the process.
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), parsed as DeepPartial<ResolvedConfig>);

  // A public dashboard address is a security boundary, not a display hint: it
  // decides which Host and Origin may redeem/use a browser session. Accept one
  // exact HTTP(S) origin and reject paths, credentials and other URL shapes.
  if (parsed.server?.dashboard_url !== undefined) {
    const rawDashboardUrl = parsed.server.dashboard_url;
    // Every refusal names the file, the key, the value and a valid example:
    // the daemon will not start on a config that fails here, so this message
    // is the whole of what the person who edited it gets to go on.
    const where = `[server] dashboard_url in ${configPath}`;
    const example = 'Use one exact origin, for example "https://lazy.example.com".';
    if (typeof rawDashboardUrl !== 'string' || rawDashboardUrl.trim() === '') {
      throw new Error(`${where} must be a non-empty http:// or https:// origin. ${example}`);
    }
    let dashboardUrl: URL;
    try {
      dashboardUrl = new URL(rawDashboardUrl);
    } catch (err) {
      throw new Error(
        `${where} is not a valid URL: "${rawDashboardUrl}" ` +
        `(${err instanceof Error ? err.message : String(err)}). ${example}`,
      );
    }
    if (
      !['http:', 'https:'].includes(dashboardUrl.protocol)
      || dashboardUrl.username !== ''
      || dashboardUrl.password !== ''
      || dashboardUrl.pathname !== '/'
      || dashboardUrl.search !== ''
      || dashboardUrl.hash !== ''
    ) {
      throw new Error(
        `${where} must be an exact http:// or https:// origin (no path, query, fragment, or ` +
        `credentials), but is "${rawDashboardUrl}". ${example}`,
      );
    }
    config.server.dashboard_url = dashboardUrl.origin;
  }

  // Expand leading `~/` in user-configured paths. Lazy accepts `~/...` as a
  // valid value in lazy.toml, but downstream consumers pass the string to
  // mkdir/writeFile/join, which do not expand tildes. Without this step, a
  // configured `external_path = "~/.lazy/foo"` creates a literal `~` directory
  // under the process cwd.
  if (config.storage.external_path) {
    config.storage.external_path = expandTilde(config.storage.external_path);
  }

  // `[credentials] backend` is a closed set. A typo here would otherwise be
  // discovered as "the daemon cannot find my credential" long after the edit.
  if (parsed.credentials?.backend !== undefined) {
    const requested = String(parsed.credentials.backend);
    if (!isBackendSelection(requested)) {
      throw new Error(
        `Invalid [credentials] backend "${requested}" in ${configPath}. ` +
        `Expected one of: ${BACKEND_SELECTIONS.join(', ')}.`,
      );
    }
    config.credentials.backend = requested;
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

  // `[checks]` was folded into `[automation]` so every declarative hook lives in
  // one table. The old spelling still WORKS — silently dropping a configured
  // post-turn check would remove a project's only gate without a word — but it
  // is deprecated, reported by `lazy doctor`, and a hard error when the two
  // spellings disagree (we cannot guess which one the author meant).
  applyChecksDeprecation(parsed, config, configPath);

  // `[loop]` → `[cluster]`, the same shape as the fold above: the task type was
  // renamed, the section with it, and the old spelling is still honoured.
  applyLoopSectionDeprecation(parsed, config, configPath);

  // `[agent] low_high_loop*` → `[review]`, the same shape again: the low-high
  // loop became a review MODE, so its keys moved to the section that owns that
  // choice, and the old spellings still decide.
  applyLowHighKeyDeprecation(parsed, config, configPath);

  // Keys lazy has REMOVED (as opposed to renamed). Unlike `[checks]` these have
  // no honoured old spelling — `[protection].passphrase_file` cannot be honoured
  // because the file it pointed at is exactly the hazard the move removed.
  applyRemovedKeyDeprecations(parsed as unknown as Record<string, unknown>, config);

  // Resolve `[agents.<name>]` here so a malformed profile fails at config load
  // rather than at launch, and so the endpoint rewrite warning is emitted once
  // per loaded config. The result is cached against the raw table; every later
  // consumer reaches it through `agentProfilesFor(config)`.
  //
  // Resolution has to happen BEFORE the two checks below: `[agent] agent_id`
  // and `[agent.by_type]` name PROFILES, so a project that defines
  // `[agents.local-ollama-pi]` and defaults to it must not be rejected for
  // naming something that is not a registered agent.
  const profiles = resolveAgentProfiles(config.agents);
  cacheAgentProfiles(config.agents, profiles);

  // Validate the default agent — a profile name, not a harness.
  agentProfileOrThrow(profiles, config.agent.agent_id, 'lazy.toml [agent] agent_id');

  // `[agent.by_type] loop` → `cluster`. BEFORE the validation below, which
  // throws on an unknown type name and would otherwise take the whole project
  // down over a renamed key. See applyByTypeLoopDeprecation.
  applyByTypeLoopDeprecation(config, configPath);

  // Validate [agent.by_type] keys and values at load time — unknown types or
  // profiles must fail loudly, never silently fall back.
  if (config.agent.by_type) {
    for (const [typeName, agentId] of Object.entries(config.agent.by_type)) {
      if (!VALID_TASK_TYPES.includes(typeName as (typeof VALID_TASK_TYPES)[number])) {
        throw new Error(
          `Unknown task type "${typeName}" in lazy.toml [agent.by_type]. ` +
          `Valid types: ${VALID_TASK_TYPES.join(', ')}`
        );
      }
      agentProfileOrThrow(profiles, agentId, `lazy.toml [agent.by_type] "${typeName}"`);
    }
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
  for (const key of ['draft_effort', 'review_effort'] as const) {
    if (!VALID_EFFORT_LEVELS.includes(config.review[key])) {
      throw new Error(
        `Invalid effort level "${config.review[key]}" for ${key} in lazy.toml [review] section. ` +
        `Valid levels: ${VALID_EFFORT_LEVELS.join(', ')}`
      );
    }
  }
  // The mode decides whether a reviewer container is ever launched, so an
  // unrecognised value must fail at load rather than resolve to a default the
  // project did not choose.
  if (!isReviewMode(config.review.mode)) {
    throw new Error(
      `Invalid review mode "${config.review.mode}" in lazy.toml [review] section. ` +
      `Valid modes: ${REVIEW_MODES.join(', ')}`
    );
  }
  // Same reasoning as the mode: the gate decides whether a review can refuse a
  // merge at all, so an unrecognised value must fail the load rather than
  // resolve to a posture the project did not choose.
  if (!isReviewGate(config.review.gate)) {
    throw new Error(
      `Invalid review gate "${config.review.gate}" in lazy.toml [review] section. ` +
      `Valid gates: ${REVIEW_GATES.join(', ')}`
    );
  }

  // User-facing host-runner spellings must fail with docker guidance, not the
  // generic invalid-type message. The canonical internal type is gated below.
  if (isRemovedHostRunnerInput(config.runner.type) && !isHostRunnerType(config.runner.type)) {
    throw hostRunnerRemovedError('lazy.toml [runner] type');
  }

  if (!VALID_RUNNER_TYPES.includes(config.runner.type)) {
    throw new Error(
      `Invalid runner type "${config.runner.type}" in lazy.toml [runner] section. ` +
      `Valid values: ${VALID_RUNNER_TYPES.filter(t => t !== 'dangerously-host-process-without-any-isolation').join(', ')}.`,
    );
  }

  if (!VALID_HOST_PERMISSION_MODES.includes(config.runner.permission_mode)) {
    throw new Error(
      `Invalid permission_mode "${config.runner.permission_mode}" in lazy.toml [runner] section. ` +
      `Valid values: ${VALID_HOST_PERMISSION_MODES.join(', ')}.`
    );
  }

  // Validate the runtime boundary-verification mode.
  if (!VALID_SANDBOX_BOUNDARY_VERIFICATIONS.includes(config.runner.verify_sandbox_boundary)) {
    throw new Error(
      `Invalid verify_sandbox_boundary "${config.runner.verify_sandbox_boundary}" in lazy.toml [runner] section. ` +
      `Valid values: ${VALID_SANDBOX_BOUNDARY_VERIFICATIONS.join(', ')}.`
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

  // Validate [docker] build_inputs: project-relative paths that get folded into
  // the image identity hash. Shape only — EXISTENCE is checked when the hash is
  // computed (src/capture/claude.ts), the same place a missing `dockerfile`
  // fails, because that is where the path is actually resolved against a root.
  // An absolute path or one escaping the root would hash a file outside the
  // project, so both are rejected rather than normalized.
  {
    const inputs = config.docker.build_inputs;
    if (!Array.isArray(inputs) || inputs.some((p) => typeof p !== 'string' || p.trim() === '')) {
      throw new Error(
        'Invalid build_inputs in lazy.toml [docker] section. ' +
        'Expected an array of non-empty path strings (e.g. build_inputs = ["Gemfile.lock", "yarn.lock"]).'
      );
    }
    for (const input of inputs) {
      if (isAbsolute(input) || input.split(/[\\/]/).includes('..')) {
        throw new Error(
          `Invalid build_inputs entry "${input}" in lazy.toml [docker] section: ` +
          'entries must be paths relative to the project root, and may not escape it with "..".'
        );
      }
    }
  }

  // Validate [docker] run_args: extra `docker run` arguments applied verbatim
  // when a task container is created. Shape only — an array of non-empty
  // strings; docker itself is the judge of whether each flag is valid. The
  // args widen the container deliberately (that is their point), so a value of
  // the wrong shape is rejected loudly rather than coerced or dropped.
  {
    const runArgs = config.docker.run_args;
    if (!Array.isArray(runArgs)) {
      throw new Error(
        'Invalid run_args in lazy.toml [docker] section. ' +
        'Expected an array of non-empty strings (e.g. run_args = ["--cap-add=SYS_PTRACE"]), ' +
        `got ${JSON.stringify(runArgs)}.`
      );
    }
    for (const arg of runArgs) {
      if (typeof arg !== 'string' || arg.trim() === '') {
        throw new Error(
          `Invalid run_args entry ${JSON.stringify(arg)} in lazy.toml [docker] section: ` +
          'each entry must be a non-empty string (e.g. "--cap-add=SYS_PTRACE").'
        );
      }
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

  // Validate the git LFS check mode. External input at a boundary: an
  // unrecognised value must not silently degrade a safety check to "off".
  if (!VALID_LFS_CHECK_MODES.includes(config.git.lfs_check as never)) {
    throw new Error(
      `Invalid lfs_check value "${config.git.lfs_check}" in lazy.toml [git] section. ` +
      `Valid values: ${VALID_LFS_CHECK_MODES.join(', ')}`
    );
  }

  // Validate the builder concurrency limit — a positive integer (a cap < 1
  // would wedge every launch). Fail loud at load time rather than silently
  // clamping.
  {
    const value = config.limits.max_concurrent_builders;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `Invalid max_concurrent_builders = ${value} in lazy.toml [limits] section: must be a positive integer.`,
      );
    }
  }
  // max_turns_without_human: 0 means unlimited, so it's the one [limits] key
  // allowed to be 0 without meaning "disabled".
  if (!Number.isInteger(config.limits.max_turns_without_human) || config.limits.max_turns_without_human < 0) {
    throw new Error(
      `Invalid max_turns_without_human = ${config.limits.max_turns_without_human} in lazy.toml [limits] section: must be a non-negative integer (0 = unlimited).`,
    );
  }

  // [usage_pause]: percents in 0–100. A value outside that range is refused
  // rather than clamped — a typo'd 950 must not quietly mean "never pause".
  {
    const up = config.usage_pause;
    const checkPercent = (value: unknown, where: string): void => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(
          `Invalid ${where} = ${JSON.stringify(value)} in lazy.toml [usage_pause] section: ` +
          `must be a number from 0 to 100 (0 = off).`,
        );
      }
    };
    checkPercent(up.threshold_percent, 'threshold_percent');
    if (typeof up.credentials !== 'object' || up.credentials === null || Array.isArray(up.credentials)) {
      throw new Error(
        `Invalid credentials in lazy.toml [usage_pause] section: must be a table of ` +
        `"<credential>" = <percent>, e.g. credentials = { "credential:CLAUDE_CODE_OAUTH_TOKEN" = 95 }.`,
      );
    }
    for (const [key, value] of Object.entries(up.credentials)) {
      checkPercent(value, `credentials."${key}"`);
    }
  }

  // Auto-resume knobs — all must be positive; auto_resume itself is the switch
  // that disables the whole mechanism, so a "0 = unlimited" escape hatch here
  // would be ambiguous with that switch.
  for (const key of ['auto_resume_interval_minutes', 'auto_resume_gap_minutes', 'auto_resume_max_attempts'] as const) {
    const value = config.daemon[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `Invalid ${key} = ${value} in lazy.toml [daemon] section: must be a positive integer.`,
      );
    }
  }

  // The memory size threshold is ADVISORY (it only decides when a launch warns
  // and suggests `lazy memory compact`), but a nonsense value would make the
  // warning meaningless — 0 warns always, negative never. Fail loud at load.
  if (!Number.isInteger(config.memory.warn_bytes) || config.memory.warn_bytes < 1) {
    throw new Error(
      `Invalid warn_bytes = ${config.memory.warn_bytes} in lazy.toml [memory] section: must be a positive integer (bytes).`,
    );
  }

  // Documentation base URL. Validated (and normalized: trailing slash dropped,
  // "" / false → disabled) rather than passed through, because a typo here is
  // silent otherwise — every doc pointer would render an unreachable link and
  // nothing would ever say why.
  config.docs.url = normalizeDocsUrl(parsed.docs?.url);

  // Validate custom mounts. Fail loud on structurally invalid entries (missing
  // target, unknown type, bind without source, etc.) so the user sees an
  // actionable error at load time rather than an opaque `docker run` failure.
  validateMounts(config.mounts);

  // Fail loud on malformed [[automation.react]] / [[automation.maintain]]
  // entries before any turn runs — a missing title/pattern/instructions (or a
  // non-string) otherwise throws inside Bun.Glob mid-supervisor after the work
  // phase already committed.
  validateAutomationEntries(config.automation.react, 'react');
  validateAutomationEntries(config.automation.maintain, 'maintain');

  // Resolve [serve] into the flat, validated service list plus the optional
  // start command. The raw section spells services two ways while the resolved
  // value is one list, so this REPLACES what deepMerge left behind. Fail loud:
  // a malformed [serve] otherwise means a task that quietly starts with nothing
  // published and no explanation for why `lazy url` is empty.
  const rawServe = (parsed as { serve?: ServeConfigInput }).serve;
  config.serve = {
    services: resolveServicePorts(rawServe),
    start_services_cmd: resolveStartServicesCmd(rawServe),
  };

  // Resolve each role's DEFAULT profile. A role names a profile and nothing
  // else; the pre-profile spellings are refused first, with the replacement
  // config printed, so an existing lazy.toml is never reinterpreted in silence.
  // The harness these refusals name is the project's own `[agent] agent_id`,
  // resolved by the helper `lazy doctor --fix agents` uses, so the error and the
  // fix cannot print different blocks.
  const legacyHarness = agentHarness(parsed as Record<string, unknown>);
  refuseOllamaBlock((parsed as { ollama?: unknown }).ollama, legacyHarness);
  // deepMerge copies keys it does not know about, so an inert `[ollama]` header
  // would otherwise ride along on the resolved config as a stray second source
  // of truth for something that no longer exists.
  delete (config as unknown as Record<string, unknown>).ollama;
  refuseRoleBackendKeys('builder', parsed.models?.roles?.builder, legacyHarness);
  refuseRoleBackendKeys('agent', parsed.models?.roles?.agent, legacyHarness);
  config.models.roles = {
    builder: resolveRole('builder', parsed.models?.roles?.builder, profiles, BUILDER_PROFILE_NAME),
    // The agent role's fallback IS `[agent] agent_id` — the project's default
    // profile — so `agent_id` keeps meaning what it says without a second knob.
    agent: resolveRole('agent', parsed.models?.roles?.agent, profiles, config.agent.agent_id),
  };

  // Resolve proxy config. The proxy is ALWAYS ON — it is how lazy runs, the same
  // way the daemon is — so a project with NO [proxy] section still gets a fully
  // defaulted proxy, and there is no resolved state in which it is absent.
  {
    const parsedProxy = parsed.proxy ?? {};
    // `[proxy] enabled` was REMOVED. A config that still carries it is a config
    // the user believes is doing something, so it must never be silently
    // ignored — but the right response depends on the VALUE. `enabled = true`
    // asks for exactly what lazy already does, so the line is merely dead: warn,
    // name the removed option, and continue. `enabled = false` asks for
    // something lazy no longer does, so it stays a hard reject.
    if ('enabled' in parsedProxy) {
      const value = (parsedProxy as { enabled?: unknown }).enabled;
      if (value === true) {
        console.warn(
          'Warning: lazy.toml [proxy] enabled = true — the `enabled` option has been removed. ' +
          'The audit/policy proxy is always on, so this line does nothing. ' +
          'Delete the `enabled` line from [proxy] in lazy.toml.',
        );
      } else {
        throw new Error(
          `lazy.toml [proxy] enabled = ${JSON.stringify(value)} — the \`enabled\` option has been removed. ` +
          'The audit/policy proxy is always on: all agent model traffic routes through it, ' +
          'and a launch that cannot reach it fails rather than connecting direct.\n' +
          'Delete the `enabled` line from [proxy] in lazy.toml. ' +
          '(There is no per-agent opt-out either: an `endpoint` under [agents.<name>] chooses ' +
          'where the PROXY forwards that profile, not whether it is proxied.)',
        );
      }
    }
    // `[proxy] openai_upstream` was REMOVED with the routing it served: it was
    // the single upstream every OPENAI_API_KEY-granted caller went to, because
    // the env var name was the only per-caller evidence the proxy had before
    // agent profiles existed. An agent profile names its own endpoint, so the
    // key now expresses less than the config it replaced — always a hard reject,
    // with the replacement printed, never a silent reinterpretation.
    if ('openai_upstream' in parsedProxy) {
      const value = (parsedProxy as { openai_upstream?: unknown }).openai_upstream;
      const endpoint = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OPENAI_UPSTREAM;
      throw new Error(
        `lazy.toml [proxy] openai_upstream = ${JSON.stringify(value)} — the \`openai_upstream\` ` +
        'option has been removed. An upstream is now a property of an AGENT PROFILE, so each ' +
        'codex profile can have its own instead of every one sharing this single value.\n\n' +
        replaceWithProfileAdvice(
          '  [agents.codex]\n' +
          '  harness = "codex"\n' +
          // The upstream may be OpenAI, OpenRouter, a local vLLM — anything that
          // speaks the openai wire. Naming a specific OpenAI model here would be
          // wrong for most of them, so this is a placeholder like the other two
          // refusals print. `[agents.<name>] endpoint` requires a model anyway, so
          // the user cannot paste this in without answering the question.
          '  model = "<the model this server serves>"\n' +
          `  endpoint = ${JSON.stringify(endpoint)}`,
          'Then delete the `openai_upstream` line from [proxy]. ' +
          '(Tasks select a profile with `lazy create --agent <name>`; overriding the built-in ' +
          '`codex` profile as above applies to every codex task, which is what this key did.) ' +
          'Run `lazy doctor --fix agents` to have lazy rewrite this for you.',
        ),
      );
    }
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
      // Which credential the proxy injects on a reroute here. Defaults to
      // "none" deliberately — see LazyConfig.proxy.fallbacks.
      const credential = (f.credential ?? 'none') as ProxyFallbackCredential;
      if (!VALID_PROXY_FALLBACK_CREDENTIALS.includes(credential)) {
        throw new Error(
          `lazy.toml [[proxy.fallback]] entry #${i + 1} has an invalid "credential" — ` +
          `use one of ${VALID_PROXY_FALLBACK_CREDENTIALS.filter((c) => c !== 'none').map((c) => `"${c}"`).join(', ')} ` +
          'to name the provider whose stored key the target should receive, or omit it ' +
          '(equivalent to credential = "none") for a target that needs no credential.',
        );
      }
      return {
        upstream: f.upstream.replace(/\/$/, ''),
        ...(f.model !== undefined ? { model: f.model } : {}),
        credential,
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

    // Upstream ceiling (seconds). Default 1800; 0 means no ceiling. Rejected
    // rather than clamped when negative: a negative ceiling is a typo, and
    // silently reading it as "no ceiling" is the opposite of what was meant.
    const upstreamTimeout = parsedProxy.upstream_timeout;
    if (
      upstreamTimeout !== undefined &&
      (typeof upstreamTimeout !== 'number' || !Number.isFinite(upstreamTimeout) || upstreamTimeout < 0)
    ) {
      throw new Error(
        'lazy.toml [proxy] upstream_timeout must be a non-negative number of seconds ' +
        `(0 = no ceiling). E.g., upstream_timeout = ${DEFAULT_UPSTREAM_TIMEOUT_SECONDS}.`,
      );
    }

    config.proxy = {
      port,
      bind: parsedProxy.bind ?? DEFAULT_PROXY_BIND,
      upstream: (parsedProxy.upstream ?? 'https://api.anthropic.com').replace(/\/$/, ''),
      cursorUpstream: (parsedProxy.cursor_upstream ?? DEFAULT_CURSOR_UPSTREAM).replace(/\/$/, ''),
      fallbacks,
      retryAfterThreshold: threshold ?? 5,
      upstreamTimeoutSeconds: upstreamTimeout ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
      policy: resolveProxyPolicy(parsedProxy.policy),
    };
  }

  // NOTE: there used to be a cross-check here for `backend = "proxy"` roles with
  // no endpoint under a disabled proxy. With the proxy always on, the daemon
  // always has a live address to inject, so that state is unreachable.

  // MANAGED MODE: the repository's lazy.toml is untrusted input on a shared
  // host. Overridden keys take the fleet's value, refused keys stop the load
  // with an actionable diagnosis. A strict no-op when managed mode is off —
  // applyManagedPolicy returns on its first line. See src/config/managed.ts.
  //
  // Applied AFTER validation on purpose: a project whose config is malformed
  // should hear about the malformation, not about a policy it also trips.
  applyManagedPolicy(config, parsed as Record<string, unknown>, configPath);

  // Reject the removed host-process runner after managed policy so a fleet host
  // can override a repository's hostile host-runner ask to docker first.
  if (isHostRunnerType(config.runner.type)) {
    assertHostRunnerConfigAllowed('lazy.toml [runner] type');
  }

  // Install the docs base for this process. Doc pointers are built deep inside
  // guards and thrown errors that never see a ResolvedConfig; this is the one
  // place the configured value reaches them. See src/docs/links.ts.
  setDocsBaseUrl(config.docs.url);

  // Same reason, same shape: task branch names are built by synchronous helpers
  // all over the CLI, daemon and drivers that never see a ResolvedConfig. This
  // is the one place `[git] default_branch_prefix` reaches them.
  // See src/git/branch-prefix.ts.
  //
  // `configPath` is always the PROJECT ROOT's lazy.toml (findConfigDir does not
  // walk up — see "A task worktree's lazy.toml has no authority" above), so the
  // project-wide fact a branch namespace is comes from the project-wide file by
  // construction. Upstream re-read the root config here for this one key because
  // its loader still resolved a worktree's copy for the others; root-anchoring
  // every key subsumes that, and the protection it bought — one task's committed
  // lazy.toml cannot re-point branch naming, or `looksLikeTaskBranch`, for every
  // other task in the same daemon — holds for the whole config rather than one
  // carve-out.
  const branchPrefix = config.git.default_branch_prefix;

  // The prefix becomes the leading segment of a real git branch name, so an
  // unusable value is rejected here, at the boundary — not by `git branch`
  // partway through starting a task, with a worktree already on disk.
  const prefixError = branchPrefixError(branchPrefix);
  if (prefixError) {
    throw new Error(
      `Invalid default_branch_prefix "${branchPrefix}" in ${configPath} ` +
      `[git] section: it ${prefixError}.\n` +
      `The prefix names the branch namespace lazy creates task branches in — ` +
      `default_branch_prefix = "wip" gives branches called "wip/<task>".`
    );
  }

  setBranchPrefix(branchPrefix);
  config.git.default_branch_prefix = getBranchPrefix();

  return config;
}

/**
 * Check if the user has explicitly configured a default model in lazy.toml.
 * Returns true if lazy.toml exists and has models.default set.
 * Used to decide whether to inject model guidance into the builder prompt.
 */
export async function hasExplicitModelConfig(lazyRoot: string): Promise<boolean> {
  const configPath = resolveConfigPath(lazyRoot);
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
# Documentation: https://gitlab.com/getlazy/lazy/-/blob/main/public-docs/lazy-toml.md
#
# Override the config filename with the LAZY_CONFIG environment variable
# (e.g., LAZY_CONFIG=lazy.lima.toml lazy list)

[models]
# Default model for sessions — use raw model IDs (e.g., "claude-opus-5",
# "claude-sonnet-5", "qwen3.5:35b-a3b-coding-nvfp4")
default = "claude-opus-5"

# Named agent profiles (optional). A profile is an agent harness plus the model,
# upstream and credential it runs with; a task selects one with
# "lazy create --agent <name>". Profiles named after a built-in harness
# (claude-code, codex, cursor, pi) override that built-in.
#
# 'endpoint' is the upstream lazy's PROXY forwards to, so it is host-perspective:
# every launch dials the proxy, whatever the profile. Lazy preflights a pinned
# endpoint before launch and fails (never silently falls back) if it is
# unreachable. 'credential' defaults to the provider inferred from the endpoint
# hostname, and is "none" for a local server that authenticates nobody.
#
${generatedConfigProfileExamples()}

# Per-role default profile (optional). Which profile the builder and task agents
# run when a task names none — e.g. keep the builder on real Anthropic while new
# tasks default to a local model. The agent role defaults to [agent] agent_id.
#
# [models.roles.builder]
# agent = "claude-code"
#
# [models.roles.agent]
# agent = "local-ollama"

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
# Storage backend (default: "external" — file storage outside the repo)
backend = "${backend}"
# Path for external storage
# Defaults to ~/.lazy/<project-name> if empty
${pathLine}

[git]
# Default prefix for lazy task branches (e.g., "lazy/abc123"); changing it renames nothing
default_branch_prefix = "lazy"
# Git LFS environment check at task start, for repos that use LFS.
# "refuse" (default) blocks the start when the LFS filter would not run,
# "warn" starts anyway and records a warning, "off" disables the check.
# The accept-time guard against raw blobs on LFS paths always runs.
# lfs_check = "refuse"

[output]
# Length of shortened IDs displayed in output
shortid_length = 8

[docs]
# Where "Check documentation at <url>" pointers in errors, warnings and command
# help point. Defaults to the docs for THIS version of lazy —
# https://docs.getlazy.dev/v<major.minor> — so a pointer keeps resolving after
# the docs move on. A value set here is used exactly as written and never gains
# a version segment; set "" to turn documentation pointers off entirely.
# url = "https://docs.internal.example.com/lazy"

[agent]
# Default agent for task execution. Available: "claude-code", "cursor".
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

[review]
# How a task is reviewed once it declares its work final.
#   "low_high"  (default) — the writer reviews its own work in its own session:
#                a low-effort draft, a hostile self-review at review_effort, one
#                revise pass. One container, one warm context, no second read of
#                a diff that is already in memory. Fast, and the cheap default.
#   "separate"  — a reviewer runs afterwards in its own session and its verdict
#                gates accept. Three to four times the wall-clock and the tokens;
#                worth it when the stakes justify a second, colder pair of eyes.
#   "off"       — no review of any kind, and nothing gates accept.
# Per task: lazy create/start/edit --review off|low-high|separate.
# mode = "low_high"
# In "separate" mode, does a review that found something start a fix turn by
# itself? Default false: the task parks with its findings attached and whoever
# is driving decides whether another round is worth it.
# auto_fix = false
# WHEN a recorded review holds the merge.
#   "auto"   (default) the mode decides — "separate" gates, the others do not —
#            and a review you asked for with lazy review always gates.
#   "always" any recorded review gates, the low-high self-review included.
#   "never"  no review ever gates.
# gate = "auto"
# Efforts for the two low-high phases.
# draft_effort = "low"
# review_effort = "xhigh"

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
# Interval in seconds for the daemon's background sync (0 to disable)
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

# [serve]
# Ports your dev servers listen on INSIDE a task's environment. Each is published
# to an OS-assigned port on 127.0.0.1 when a task's container is created, so
# parallel tasks serving the same port never collide and nothing is exposed off
# this machine. "lazy url <task>" prints the mapping. Nothing is published
# without this section. A change takes effect on the next container
# ("lazy shell <task> --restart").
# ports = [3000, 5173]              # addressed by number: lazy url my-task 3000
# [serve.services]                  # ...or name them: lazy url my-task web
# web = 3000

[runner]
# Runner type: "docker" (default) or "podman". Agents run in isolated containers.
type = "docker"

# Legacy host-process permission keys remain in the schema (still validated if
# present) but the host runner itself is no longer supported.

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

# Verify the FILE-TOOL deny boundary before launching host agents under
# permission_mode = "sandbox". Those deny rules are a Claude Code behavior lazy
# depends on but does not control, so an upgrade could silently regress it.
#   "off" (default)    — no runtime check. CI + "lazy system verify-host-boundary" cover it.
#   "once-per-version" — on the first host launch for each Claude Code version, run the
#                        real boundary probe (3 headless sessions, ~1-2 min, needs a
#                        logged-in claude), cache the verdict, and REFUSE to launch if a
#                        deny rule was violated. An inconclusive run warns loudly and is
#                        never cached — it is not a pass.
# verify_sandbox_boundary = "off"


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
# github_auto_push = true   # Push task branches automatically; false keeps them local
#                           # (lazy submit / lazy accept still push when a merge needs it)
# Authentication is handled by gh CLI (run: gh auth login)
# When using the GitLab driver, these options are also available:
# gitlab_auto_push = true   # Push task branches automatically; false keeps them local
#                           # (lazy submit / lazy accept still push when a merge needs it)
# Authentication is handled by glab CLI (run: glab auth login)

[docker]
# Path to custom Dockerfile (relative to the project root)
# If empty, uses the base image (Ubuntu with Claude Code + passwordless sudo).
# Agents install what they need via apt-get.
dockerfile = ""

# Files whose CONTENTS are part of this image's identity, relative to the
# project root. Changing any of them rebuilds the image on the next container
# start, exactly as editing the Dockerfile does — no more silent drift between
# the image and your lockfiles.
#
# ONLY MEANINGFUL FOR FILES THE DOCKERFILE ACTUALLY COPYs. Docker keys a
# "RUN bundle install" layer on the Dockerfile text alone, so if the file is
# never COPYed the rebuild this triggers is a guaranteed no-op.
#
# A declared file that does not exist is a hard error at container start (the
# same way a missing dockerfile is), so a typo can't become a silent no-op.
# build_inputs = ["Gemfile.lock", "yarn.lock", "Cargo.lock", "rust-toolchain.toml"]

# Extra 'docker run' arguments applied verbatim, in order, before the image
# name when a task container is created — e.g. a seccomp-notify based sandbox
# (deno_sandbox and similar) needs CAP_SYS_PTRACE for pidfd_getfd.
# WARNING: these args widen the container's privileges and apply to EVERY task.
# Read from the project root's lazy.toml only — a task worktree's copy is ignored.
# run_args = ["--cap-add=SYS_PTRACE"]

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
# protected branch prompts for the approval passphrase at 'lazy accept'
# itself — approve and merge in one step. While disabled, nothing below has
# any effect.
# Turn it on — this alone protects the repo's DEFAULT branch (e.g. main),
# no branch listing needed:
# enabled = true
# Same thing from the CLI: lazy protect main on
# When enabled, protection of the default branch itself can be switched off:
# gate_default_branch = false
# On GitHub/GitLab, approving the task's PR/MR satisfies this same gate — no
# passphrase needed then.
# Additional protected branches (exact names) — merges INTO them need approval:
# protected_branches = ["release"]
# Protected tasks (task code or short id) — merging that task's work OUT,
# into any target, needs approval:
# protected_tasks = ["add-auth"]
# Manage both lists with: lazy protect <branch|task> on|off
# The approval passphrase itself is NOT configured here. It lives hashed
# outside every repository, one per machine — enroll it once with:
#   lazy system passphrase set

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

# Reactive automations — when a turn's commits TOUCH a pattern, the supervisor
# prompts the agent once with that entry's instructions (e.g. take UI
# screenshots). Generalized protected-file push-back: custom instructions, a
# nudge not a gate. Opt-in: empty by default. Each entry needs title, pattern,
# and instructions.
#
# [[automation.react]]
# title = "take-UI-snapshots"
# pattern = "src/ui/**/*"
# instructions = "You updated UI — start the app in demo mode and take Playwright screenshots of the screens you changed."

# Pre-accept — OPT-IN (enabled = false by default). The MECHANICAL acceptance
# gate: when a task is accepted, the configured commands run in an ephemeral
# container on the task's worktree BEFORE the merge, and if any exits non-zero
# the accept is ABORTED and the task returns to blocked with the failure
# surfaced. The home for expensive one-time validation (full test suite,
# build). No agent turn runs here.
#
# It costs commands-time on EVERY accept, so accept is fast by default and you
# opt in with enabled = true.
#
# commands = the merge GATE itself: if any command exits non-zero the accept
# is aborted. Empty by default (the gate passes trivially when nothing is
# configured).
#
# [automation.pre_accept]
# enabled = true
# commands = ["bun test", "bun run build"]
# timeout = 600

# --- Per-turn hooks (still under [automation]) ---
#
# pre_turn runs in the worktree BEFORE each agent turn, after the upstream
# merge. Its job is "make sure the environment is ready" — start a database,
# a dev server, a docker compose stack. Processes an agent starts SURVIVE the
# turn boundary, so on most turns there is nothing to do: the hook must be
# IDEMPOTENT and cheap when everything is already up. It exists for the first
# turn, a fresh container, and a service that died.
#
# A failing hook is loud but non-fatal by default: the failure is recorded on
# the turn and prepended to the agent's prompt so it knows the environment is
# degraded. Set pre_turn_required = true to fail the turn instead.
# pre_turn = "bin/lazy-services"
# pre_turn_timeout = 120
# pre_turn_required = false
#
# post_turn runs after each agent turn. stdout and stderr are captured and
# attached to the turn for reviewers. Does NOT block the agent or trigger
# retries. It runs on CLEAN turns only — a turn that failed or was stopped is
# hard-killed, so do not rely on post_turn for teardown.
# post_turn = "bun test --bail"
# post_turn_timeout = 300
#
# (These were [checks] post_turn / post_turn_timeout. That spelling still
# works but is deprecated — run "lazy doctor" for the migration.)
#
# accept_check runs in the TASK WORKTREE when the task is accepted, before the
# merge. A non-zero exit REFUSES the accept: the task's own tree does not
# build, so merging it would break the target branch. Unset = no gate.
# Keep it cheap — every accept pays for it — and prefer your own script over a
# bare binary path ("bun run typecheck", not "node_modules/.bin/tsc").
# Override a refusal knowingly with: lazy accept <task> --allow-broken
# accept_check = "bun run typecheck"
# accept_check_timeout = 300

# [proxy]
# Built-in Anthropic-native passthrough proxy — ALWAYS ON, and there is no
# option to turn it off. It gives you request-level audit logging (tool_use /
# tool_result contents, token usage, routing hints) plus the policy plane below.
# This whole section is optional tuning: with no [proxy] block the daemon starts
# the proxy on an OS-assigned port and routes all agent model traffic through it.
# 'port' is optional — set it only to pin a specific port.
# port = 8766
# bind = "127.0.0.1"
# upstream = "https://api.anthropic.com"
#
# Cursor API traffic (the cursor-agent) routes through the SAME proxy port via a
# /_lazy/cursor/<placeholder> path prefix, so cursor turns are audited and
# attributed like Anthropic turns. Cursor requests are forwarded verbatim: no
# policy enforcement and no failover chain apply to them, and the audit record is
# coarse (role, task, method, path, status, duration) because the wire format is
# not Anthropic's. Point this elsewhere only for a Cursor-compatible endpoint.
# cursor_upstream = "https://api2.cursor.sh"
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
# How long the proxy waits for an upstream to answer ONE request, in seconds
# (default 1800; 0 = wait forever). A local model that is loading, queued behind
# other requests, or prefilling a very large prompt can take minutes to produce
# its first byte — raise this if yours legitimately does. The proxy says which
# upstream and which ceiling in the error when it gives up.
# upstream_timeout = 1800
#
# [[proxy.fallback]]
# upstream = "http://host.docker.internal:11434"   # e.g. local Ollama
# model = "qwen3.5:35b-a3b-coding-nvfp4"           # optional model override

# Mechanistic policy plane (§6.3 layer 1) — deterministic, injection-proof
# deny-rules applied to each tool_use BEFORE it executes. These are ON by
# default with a closed posture: inherited claude.ai account
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

# Auto-resume: when a task's turn crashes, lazy resumes it automatically.
# Master switch for auto-resuming interrupted tasks (fast lane and slow lane).
# auto_resume = true
# A fresh crash resumes immediately, up to 3 consecutive interruptions (fixed).
# Past that, the task enters a slow-lane retry queue instead of giving up.
# Minutes between slow-lane retries of a given task.
# auto_resume_interval_minutes = 30
# Minimum minutes between any two auto-resumes project-wide, so one flapping
# task can't starve every other queued task (round-robin, oldest attempt first).
# auto_resume_gap_minutes = 5
# Slow-lane attempts before giving up for good and requiring a manual resume.
# 24 x 30min = ~12 hours by default: if it hasn't recovered by then it never will.
# auto_resume_max_attempts = 24

[limits]
# Max concurrent interactive builder containers. New builders beyond this fail
# fast (an interactive session a human is waiting on is never queued). Agent
# tasks are uncapped: every start launches immediately, and a blocked task's
# container stays warm until the task reaches a terminal state.
# max_concurrent_builders = 8
# Override the cap for the running daemon only (ephemeral, no lazy.toml edit):
#   lazy daemon config set builders 4
# Max consecutive work turns a task may run without a human in the loop.
# Builder (MCP) and agent-driven turns count; a human turn resets the count to 0.
# 0 = unlimited.
# max_turns_without_human = 10
`;
}
