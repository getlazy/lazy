/**
 * Managed mode — the lazy.toml trust boundary on a shared host.
 *
 * WHY THIS EXISTS. On a single-user machine `lazy.toml` is the user's own file
 * and lazy respects all of it. On a fleet host running many tenants' daemons,
 * `lazy.toml` is a file that arrived from a git clone: it is UNTRUSTED INPUT.
 * A committed `[[mounts]]` entry bind-mounts an arbitrary host path into the
 * agent container; `[runner] type = "host"` leaves containerization entirely;
 * `[proxy] upstream` redirects the real model credential to a URL of the
 * repository's choosing. None of those may be honoured just because a file in
 * a repository asked.
 *
 * WHAT MANAGED MODE IS NOT. It is not a sandbox and it does not distrust the
 * repository's CODE — the agent container already exists to run untrusted code,
 * and that is the design working as intended. Managed mode stops the repository
 * changing the SHAPE of that container or reaching around it.
 *
 * WHY IT IS AN ENVIRONMENT VARIABLE AND NOT A CONFIG KEY. `lazy.toml` is the
 * untrusted input; a `managed = false` key in it would be self-certification.
 * The fleet supervisor arms managed mode out of band, in the daemon's
 * environment, where the repository cannot reach.
 *
 * THE CLASSIFICATION. Every key lazy resolves is RESPECTED, OVERRIDDEN or
 * REFUSED — see {@link MANAGED_POLICY} below and public-docs/managed-config.md for the
 * user-facing table and the reasoning behind each non-respected key.
 * `test/unit/managed-config-policy.test.ts` fails when a key has no entry, so
 * the next key added to lazy.toml has to classify itself.
 *
 * UNMANAGED IS UNTOUCHED. Everything here is inert unless {@link isManagedMode}
 * is true. That is asserted, not assumed — the same test loads a hostile
 * lazy.toml with managed mode off and requires it to be honoured verbatim.
 */

import { isAbsolute, resolve, relative } from 'path';
import { writeFile } from 'fs/promises';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_BIND } from './constants';
import { docsSuffix } from '../docs/links';
import { PROVIDERS } from '../credentials/providers';
import { NO_CREDENTIAL } from './agent-profiles';
import type { ResolvedConfig } from './types';

// ── Arming ────────────────────────────────────────────────────────────────

/** Build-time flag, defined only in a compiled `lazy` / `lazy-agent` binary. */
declare const LAZY_RELEASE_BUILD: boolean;

// `MANAGED_ENV` and `isManagedMode` live in the leaf `./managed-mode` so that
// modules this one depends on can still ask whether the host is managed. They
// are re-exported here because this is where every existing caller imports them
// from, and because "arming" belongs with the policy it arms. The
// LAZY_TEST_FORCE_MANAGED seam moved with `isManagedMode` into that leaf.
import { MANAGED_ENV, isManagedMode } from './managed-mode';
export { MANAGED_ENV, isManagedMode };

/** The fleet-assigned store. REQUIRED when managed mode is armed. */
export const MANAGED_STORAGE_ENV = 'LAZY_MANAGED_STORAGE_PATH';
/** The fleet's container runner. Optional; defaults to `docker`. */
export const MANAGED_RUNNER_ENV = 'LAZY_MANAGED_RUNNER';

/** Runners a managed host will run agents under. `host` is never one of them. */
const MANAGED_RUNNERS = ['docker', 'podman'] as const;

/**
 * The fleet's own values — the substitutes an OVERRIDDEN key resolves to.
 *
 * Read from the environment ONCE per evaluation rather than cached, because the
 * daemon and the CLI are separate processes and tests flip the variables
 * between loads.
 */
export interface FleetValues {
  storagePath: string;
  runner: 'docker' | 'podman';
}

/**
 * Read the fleet's values, or throw.
 *
 * FAILS CLOSED. Managed mode with no store assigned is a fleet misconfiguration,
 * and the failure mode if we shrugged and carried on is the exact thing this
 * module exists to prevent: the repository's own `external_path` would win and
 * the daemon would open a store that is not this project's. Refusing to start is
 * the only safe answer, and it is the fleet operator who sees it, not a tenant.
 */
export function readFleetValues(env: NodeJS.ProcessEnv = process.env): FleetValues {
  const storagePath = (env[MANAGED_STORAGE_ENV] ?? '').trim();
  if (!storagePath) {
    throw new ManagedModeMisconfiguredError(
      `${MANAGED_ENV} is set but ${MANAGED_STORAGE_ENV} is empty.\n` +
      `Managed mode overrides the repository's [storage] section with the fleet-assigned store, ` +
      `so it must be told which store this project owns.\n` +
      `Set ${MANAGED_STORAGE_ENV} to an absolute path in the daemon's environment, ` +
      `or unset ${MANAGED_ENV} to run unmanaged.`,
    );
  }
  if (!isAbsolute(storagePath)) {
    throw new ManagedModeMisconfiguredError(
      `${MANAGED_STORAGE_ENV} must be an absolute path (got "${storagePath}").`,
    );
  }

  const rawRunner = (env[MANAGED_RUNNER_ENV] ?? 'docker').trim();
  if (!(MANAGED_RUNNERS as readonly string[]).includes(rawRunner)) {
    throw new ManagedModeMisconfiguredError(
      `${MANAGED_RUNNER_ENV} = "${rawRunner}" is not a container runner. ` +
      `Managed mode runs agents under ${MANAGED_RUNNERS.join(' or ')}; ` +
      `a host runner would run agent code outside a container as the fleet user.`,
    );
  }

  return { storagePath, runner: rawRunner as 'docker' | 'podman' };
}

/** The fleet's environment is wrong. Not a tenant's fault, and not their problem. */
export class ManagedModeMisconfiguredError extends Error {
  constructor(message: string) {
    super(`managed mode misconfigured: ${message}`);
    this.name = 'ManagedModeMisconfiguredError';
  }
}

/**
 * The repository asked for something a managed host does not offer.
 *
 * The message leads with the marker `managed config refused:` on its own line.
 * That marker is a CONTRACT: Lazy Teams matches on it to classify a provisioning
 * failure as `managed_config_refused` rather than a generic command failure
 * (lazy-teams/app/models/provisioning_diagnosis.rb). Do not reword it.
 */
export class ManagedConfigRefusedError extends Error {
  readonly refusals: readonly ManagedRefusal[];

  constructor(refusals: readonly ManagedRefusal[], configPath: string) {
    const lines = refusals.map((r) => `  ${r.key} — ${r.why}`);
    super(
      `managed config refused:\n${lines.join('\n')}\n\n` +
      `${configPath} asks for ${refusals.length === 1 ? 'a setting' : 'settings'} this installation does not ` +
      `allow a repository to choose. Remove ${refusals.length === 1 ? 'that key' : 'those keys'} from the ` +
      `repository's lazy.toml — every other setting in the file is still honoured.` +
      docsSuffix('managed-config', '\n\n'),
    );
    this.name = 'ManagedConfigRefusedError';
    this.refusals = refusals;
  }
}

// ── The classification ────────────────────────────────────────────────────

export type ManagedDisposition = 'respected' | 'overridden' | 'refused';

export interface ManagedRule {
  disposition: ManagedDisposition;
  /**
   * One sentence, user-facing, on why the repository does not get this. Required
   * for everything that is not `respected` — a key that is taken away without a
   * reason is how a config file becomes folklore.
   */
  why?: string;
  /**
   * Narrows a RESPECTED key. Returns a refusal reason for values that are not
   * safe on a shared host, or null to honour the value.
   *
   * This is how "a project Dockerfile is fine, a path escaping the project is
   * not" is expressed without inventing a fourth disposition.
   */
  guard?: (value: unknown) => string | null;
  /**
   * Replaces an OVERRIDDEN key's value in the RESOLVED config. Explicit rather
   * than a dotted-path setter because the resolved shape is not the raw shape
   * ([proxy] resolves to camelCase fields, [serve] to a flat array), and a
   * path-mapper that silently missed would fail open.
   */
  apply?: (config: ResolvedConfig, fleet: FleetValues) => void;
  /**
   * What the fleet uses instead, for the "asks for X; uses Y" report.
   *
   * Takes only the fleet values, never the config: `lazy doctor` reports the
   * classification from a raw parsed file without resolving one.
   */
  effective?: (fleet: FleetValues) => unknown;
}

/** Rejects a project-relative path that escapes the project. */
function containedPath(label: string): (value: unknown) => string | null {
  return (value) => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    if (isAbsolute(value)) {
      return `${label} must be a path inside the project on a managed host; "${value}" is absolute`;
    }
    const rel = relative('.', resolve('.', value));
    if (rel.startsWith('..')) {
      return `${label} must stay inside the project on a managed host; "${value}" escapes it`;
    }
    return null;
  };
}

/** Rejects any glob that could reach outside the project checkout. */
function containedGlobs(label: string): (value: unknown) => string | null {
  return (value) => {
    if (!Array.isArray(value)) return null;
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
        return `${label} may only match files inside the project on a managed host; "${entry}" can reach outside it`;
      }
    }
    return null;
  };
}

/**
 * Every key lazy resolves, and what a managed host does with it.
 *
 * Keys are dotted paths against the RAW lazy.toml shape. `*` stands for a
 * user-chosen name (a role); `[]` for an array-of-tables element. A section
 * name on its own (`mounts`) classifies the whole section.
 *
 * WHY REFUSED VS OVERRIDDEN. Both are equally safe — neither honours the
 * repository — so the choice is made on DIAGNOSABILITY, not on severity:
 *
 *   OVERRIDDEN when the fleet has a working substitute and the project still
 *   runs. Silently swapping the store path costs the tenant nothing; being told
 *   about it in `lazy doctor` is enough.
 *
 *   REFUSED when the fleet does not offer the capability AT ALL, so quietly
 *   dropping the ask would leave the project running with something materially
 *   different from what it asked for. A project that configured a local Ollama
 *   model and silently got Anthropic instead has no way to discover that from
 *   its own behaviour; failing loudly at provisioning is kinder than a mystery.
 */
export const MANAGED_POLICY: Record<string, ManagedRule> = {
  // ── Models ──────────────────────────────────────────────────────────────
  'models.default': { disposition: 'respected' },
  'models.roles.*.model': { disposition: 'respected' },
  'models.roles.*.backend': {
    disposition: 'refused',
    why:
      'a non-Anthropic role backend sends the model credential somewhere the fleet did not choose; ' +
      'team-level backends are configured by the team, not by a repository',
    guard: (v) => (typeof v === 'string' && v !== '' && v !== 'anthropic'
      ? `backend = "${v}" routes this role away from the fleet's model endpoint`
      : null),
  },
  'models.roles.*.endpoint': {
    disposition: 'refused',
    why: 'an arbitrary endpoint URL from a repository receives the real model credential',
    guard: (v) => (typeof v === 'string' && v.trim() !== ''
      ? `endpoint = "${v}" would receive this project's model credential`
      : null),
  },
  // The role's one remaining knob: which agent PROFILE tasks in this role
  // default to. Naming a profile is the same class of ask as `[agent] agent_id`
  // (respected), and every profile it can name is itself classified below — so
  // the selection is safe exactly because the things it selects are.
  'models.roles.*.agent': { disposition: 'respected' },
  // Resolved-only fields of a role, not lazy.toml keys.
  //
  // A resolved role is a FLATTENED agent profile, so the config lazy hands the
  // daemon carries a harness, credential slot, wire and endpoint per role. No
  // TOML key spells any of them — the repository's asks are
  // `[models.roles.<role>] agent` above and `[agents.<name>]` below — but the
  // classification is inventoried against the resolved config too, and a field
  // with no entry there is indistinguishable from one nobody thought about.
  // They are respected because their values are lazy's own resolution of asks
  // that were themselves classified, never a string the repository placed here.
  'models.roles.*.harness': { disposition: 'respected' },
  'models.roles.*.credential': { disposition: 'respected' },
  'models.roles.*.wire': { disposition: 'respected' },
  'models.roles.*.pinned': { disposition: 'respected' },
  'models.roles.*.profile': { disposition: 'respected' },

  // ── Agent profiles: `[agents.<name>]` ───────────────────────────────────
  //
  // A profile is harness + model + endpoint + credential, and the proxy routes
  // a task's traffic by the profile its grant names. `endpoint` is therefore
  // the same credential-redirection primitive `models.roles.*.endpoint` was,
  // moved to a per-profile block: on a shared host a committed profile pointed
  // at a URL of the repository's choosing would receive the fleet's model
  // credential. Which harness runs, and which model it asks for, stay the
  // repository's business — they are the container's contents, not its shape.
  'agents.*.harness': { disposition: 'respected' },
  'agents.*.model': { disposition: 'respected' },
  'agents.*.endpoint': {
    disposition: 'refused',
    why: 'an arbitrary upstream URL from a repository receives the real model credential',
    guard: (v) => (typeof v === 'string' && v.trim() !== ''
      ? `endpoint = "${v}" would receive this project's model credential`
      : null),
  },
  // A credential NAME is a selection out of the host's store, and a name the
  // fleet did not choose also resolves a `LAZY_CREDENTIAL_<NAME>` variable out
  // of the daemon's own environment. Naming a provider lazy already knows is
  // just saying which of the fleet's credentials this profile bills, which is
  // harmless; inventing a name is the repository reaching for a secret slot
  // nobody assigned it.
  'agents.*.credential': {
    disposition: 'refused',
    why: 'a repository-invented credential name selects a secret the fleet did not assign to it',
    guard: (v) => {
      if (typeof v !== 'string' || v.trim() === '') return null;
      const name = v.trim();
      return name === NO_CREDENTIAL || (PROVIDERS as readonly string[]).includes(name)
        ? null
        : `credential = "${name}" names a secret slot outside the fleet's providers (${PROVIDERS.join(', ')})`;
    },
  },

  // ── Credentials: where the daemon keeps the model credential ────────────
  //
  // Which secret store the daemon writes to is a property of the HOST it runs
  // on, not of the repository: a fleet host has one secret service, or none,
  // and a repository asking for `file` would put a plaintext credential on a
  // machine it does not own. Overridden rather than refused because `auto`
  // always resolves to something that works, so the project keeps running and
  // `lazy doctor` names the backend actually in use.
  'credentials.backend': {
    disposition: 'overridden',
    why: 'the credential backend belongs to the host the daemon runs on, not to a repository',
    apply: (c) => { c.credentials.backend = 'auto'; },
    effective: () => 'auto',
  },

  // No `ollama.*` rules: the `[ollama]` section was REMOVED with role backends
  // (the loader refuses a lazy.toml that still states it), so there is nothing
  // for a repository to point at the shared host and nothing to classify. A
  // local model server is an `[agents.<name>] endpoint` now, refused above.

  // ── The proxy: the credential-bearing egress path ───────────────────────
  // No `proxy.enabled` rule: the key no longer exists. The proxy is always on
  // (the loader rejects a lazy.toml that still states it), so there is nothing
  // for a repository to turn off and nothing for the fleet to override.
  'proxy.upstream': {
    disposition: 'refused',
    why: 'the daemon fetches this URL from the host carrying the real model credential — a repository choosing it is credential redirection',
    guard: (v) => {
      if (typeof v !== 'string' || v.trim() === '') return null;
      // TEST SEAM: the credential-swap E2E suite (test/e2e/credential-swap-proof.test.ts)
      // must point the daemon's proxy at a stub upstream to observe the swapped
      // credential on the wire. Without this branch the suite cannot start its
      // daemon at all — it fails with:
      //   managed config refused:
      //     proxy.upstream — upstream = "http://127.0.0.1:<port>" would receive this
      //     project's model credential from the fleet host
      // There is no fleet-env substitute for the upstream (readFleetValues carries
      // only the store and the runner), so the stub cannot be reached any other way.
      // Safe because stripped from released binaries via LAZY_RELEASE_BUILD.
      if (typeof LAZY_RELEASE_BUILD === 'undefined' && process.env['LAZY_TEST_FORCE_MANAGED'] === '1') {
        return null;
      }
      return `upstream = "${v}" would receive this project's model credential from the fleet host`;
    },
  },
  'proxy.cursor_upstream': {
    disposition: 'refused',
    why: 'the daemon fetches this URL from the host carrying the real cursor credential — a repository choosing it is credential redirection, exactly as for the Anthropic upstream',
    guard: (v) => (typeof v === 'string' && v.trim() !== ''
      ? `cursor_upstream = "${v}" would receive this project's cursor credential from the fleet host`
      : null),
  },
  'proxy.fallback[].upstream': {
    disposition: 'refused',
    why: 'a failover target receives the same credential as the primary upstream',
  },
  'proxy.fallback[].model': {
    disposition: 'refused',
    why: 'a failover entry cannot exist without the upstream it belongs to, which is refused',
  },
  'proxy.port': {
    disposition: 'overridden',
    why: 'a fixed port collides across the projects sharing this host',
    apply: (c) => { if (c.proxy) c.proxy.port = 0; },
    effective: () => 0,
  },
  'proxy.bind': {
    disposition: 'overridden',
    why: 'the bind address decides who else on the host can reach this project\'s proxy',
    apply: (c) => { if (c.proxy) c.proxy.bind = '127.0.0.1'; },
    effective: () => '127.0.0.1',
  },
  'proxy.retry_after_threshold': { disposition: 'respected' },
  'proxy.upstream_timeout': { disposition: 'respected' },
  'proxy.policy.enforce': {
    disposition: 'overridden',
    why: 'enforcement is the fleet\'s posture; a repository turning it off would disable its own tool-call policy',
    apply: (c) => { if (c.proxy) c.proxy.policy.enforce = true; },
    effective: () => true,
  },
  'proxy.policy.deny_secret_path_reads': {
    disposition: 'overridden',
    why: 'the secret-path denylist is the fleet\'s floor, not a project preference',
    apply: (c) => { if (c.proxy) c.proxy.policy.denySecretPathReads = true; },
    effective: () => true,
  },
  'proxy.policy.connector_allowlist': {
    disposition: 'overridden',
    why: 're-allowing a denied connector widens what agents on this host can reach',
    apply: (c) => { if (c.proxy) c.proxy.policy.connectorAllowlist = []; },
    effective: () => [],
  },
  'proxy.policy.egress_allowlist': {
    disposition: 'overridden',
    why: 'the egress posture belongs to the host every project shares',
    apply: (c) => { if (c.proxy) c.proxy.policy.egressAllowlist = null; },
    effective: () => null,
  },
  // Only ever ADDS denials, so a repository can tighten its own agents but never
  // loosen the fleet's floor.
  'proxy.policy.deny_path_globs': { disposition: 'respected' },

  // ── The runner: the linchpin of the whole classification ────────────────
  //
  // Every "this is safe because it runs in the container" judgement below is
  // true only while the runner IS a container. That makes runner.type the one
  // key whose override the rest of the table rests on.
  'runner.type': {
    disposition: 'overridden',
    why: 'a host runner would run agent code outside any container, as the fleet user, on a machine shared with other projects',
    apply: (c, fleet) => {
      if (typeof LAZY_RELEASE_BUILD === 'undefined' && process.env['LAZY_TEST_FORCE_MANAGED'] === '1') {
        // Safe because stripped from releases; the fleet host can never take this branch.
        return;
      }
      c.runner.type = fleet.runner;
    },
    effective: (fleet) => fleet.runner,
  },
  'runner.permission_mode': {
    disposition: 'overridden',
    why: 'the permission posture is the fleet\'s, and "bypass" removes the sandbox the host relies on',
    apply: (c) => { c.runner.permission_mode = 'sandbox'; },
    effective: () => 'sandbox',
  },
  'runner.sandbox_allowed_domains': {
    disposition: 'overridden',
    why: 'the reachable-domain list is host policy; a repository widening it widens the host',
    apply: (c) => { c.runner.sandbox_allowed_domains = ['*.anthropic.com']; },
    effective: () => ['*.anthropic.com'],
  },
  'runner.sandbox_deny_read': {
    disposition: 'overridden',
    why: 'sandbox denials are the fleet\'s floor and are not negotiated per repository',
    apply: (c) => { c.runner.sandbox_deny_read = []; },
    effective: () => [],
  },
  'runner.sandbox_deny_write': {
    disposition: 'overridden',
    why: 'sandbox denials are the fleet\'s floor and are not negotiated per repository',
    apply: (c) => { c.runner.sandbox_deny_write = []; },
    effective: () => [],
  },
  'runner.sandbox_allow_weaker_nested': {
    disposition: 'overridden',
    why: 'permitting a weaker nested sandbox is exactly the escalation a shared host must not accept from a repository',
    apply: (c) => { c.runner.sandbox_allow_weaker_nested = false; },
    effective: () => false,
  },
  'runner.verify_sandbox_boundary': {
    disposition: 'overridden',
    why: 'the boundary self-check spends real agent sessions on the host, so the fleet decides when it runs',
    apply: (c) => { c.runner.verify_sandbox_boundary = 'off'; },
    effective: () => 'off',
  },

  // ── Mounts: the worst case ──────────────────────────────────────────────
  //
  // buildMountArgs() has two blocklists and no allowlist, mounts read-write by
  // default, and expands `~`. `[[mounts]] source = "/" target = "/host"` is a
  // complete host filesystem handover to a repository's agent. There is no
  // substitute a fleet could offer, so this refuses rather than overrides.
  'mounts': {
    disposition: 'refused',
    why: 'a repository cannot mount host paths into its agent container on a shared machine',
  },
  'mounts[].type': { disposition: 'refused', why: 'part of a refused [[mounts]] entry' },
  'mounts[].source': { disposition: 'refused', why: 'part of a refused [[mounts]] entry' },
  'mounts[].name': { disposition: 'refused', why: 'part of a refused [[mounts]] entry' },
  'mounts[].target': { disposition: 'refused', why: 'part of a refused [[mounts]] entry' },
  'mounts[].readonly': { disposition: 'refused', why: 'part of a refused [[mounts]] entry' },

  // ── Storage: the fleet's, always ────────────────────────────────────────
  'storage.backend': {
    disposition: 'overridden',
    why: 'the project\'s store is assigned by the fleet, not stated by the repository',
    apply: (c) => { c.storage.backend = 'external'; },
    effective: () => 'external',
  },
  'storage.external_path': {
    disposition: 'overridden',
    why: 'a repository naming a store path could point the daemon at another project\'s state',
    apply: (c, fleet) => { c.storage.external_path = fleet.storagePath; },
    effective: (fleet) => fleet.storagePath,
  },
  'data.path': {
    disposition: 'overridden',
    why: 'the daemon\'s state directory is placed by the fleet, and a repository-chosen path writes wherever it points',
    apply: (c) => { c.data.path = '.lazy'; },
    effective: () => '.lazy',
  },

  // ── Listening sockets on a shared host ──────────────────────────────────
  'server.port': {
    disposition: 'overridden',
    why: 'a fixed port collides across the projects sharing this host',
    apply: (c) => { c.server.port = DEFAULT_WEB_PORT; },
    effective: () => DEFAULT_WEB_PORT,
  },
  'server.bind': {
    disposition: 'overridden',
    why: 'the bind address decides who else on the host can reach this project',
    apply: (c) => { c.server.bind = DEFAULT_SERVER_BIND; },
    effective: () => DEFAULT_SERVER_BIND,
  },
  'server.dashboard_url': {
    disposition: 'overridden',
    why: 'the dashboard is disabled on a managed host',
    apply: (c) => { c.server.dashboard_url = ''; },
    effective: () => '',
  },
  'server.sync_interval': {
    disposition: 'overridden',
    why: 'the poll interval is load on a machine shared with every other project',
    apply: (c) => { c.server.sync_interval = 60; },
    effective: () => 60,
  },
  'limits.max_concurrent_builders': {
    disposition: 'overridden',
    why: 'concurrency is host capacity, and one repository must not be able to claim it all',
    apply: (c) => { c.limits.max_concurrent_builders = 8; },
    effective: () => 8,
  },

  // ── Feature flags: freeform, therefore unclassifiable, therefore closed ──
  //
  // [features] accepts arbitrary keys by design, so no table can classify them
  // and the fail-closed rule applies to the section as a whole.
  'features': {
    disposition: 'overridden',
    why: 'feature flags are freeform, so none of them can be classified in advance; a managed host runs the fleet\'s set',
    apply: (c) => { c.features = {}; },
    effective: () => ({}),
  },

  // ── Host-executed paths, contained rather than removed ──────────────────
  'docker.dockerfile': {
    disposition: 'respected',
    // A project Dockerfile builds the image its own agent runs in — roughly the
    // power the agent already has, which the fleet accepts by design. What it
    // must not do is name a file OUTSIDE the project, because `docker build`
    // runs on the host.
    guard: containedPath('[docker] dockerfile'),
  },
  'docker.build_inputs': { disposition: 'respected' },
  // Extra `docker run` args shape the container itself: `--privileged` or a
  // `-v /:/host` from a cloned lazy.toml would be a host handover, exactly the
  // class of ask [[mounts]] refuses. There is no substitute a fleet could
  // offer, so this refuses rather than overrides. The guard lets an EMPTY
  // array be stated harmlessly.
  'docker.run_args': {
    disposition: 'refused',
    why: 'a repository cannot add its own `docker run` arguments to agent containers on a shared machine',
    guard: (v) => (Array.isArray(v) && v.length === 0
      ? null
      : 'a repository cannot add its own `docker run` arguments to agent containers on a shared machine'),
  },
  'worktree.include': {
    disposition: 'respected',
    // Copied on the HOST from the main checkout into the worktree, which the
    // agent then reads. A pattern that escapes the checkout is a host file-read
    // primitive; one that stays inside only moves the project's own files.
    guard: containedGlobs('[worktree] include'),
  },
  'documents.path': {
    disposition: 'respected',
    guard: containedPath('[documents] path'),
  },

  // ── Remote / forge ──────────────────────────────────────────────────────
  'remote.driver': { disposition: 'respected' },
  'remote.git_remote': { disposition: 'respected' },
  'remote.auto_approve': { disposition: 'respected' },
  'remote.offline': { disposition: 'respected' },
  'remote.github_auto_push': { disposition: 'respected' },
  'remote.gitlab_auto_push': { disposition: 'respected' },
  'remote.github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection': {
    disposition: 'refused',
    why:
      'this setting feeds public comment text to the agent as instructions; on a shared host a prompt-injected ' +
      'agent is a foothold, and the key\'s own name is the argument',
    guard: (v) => (v === true ? 'public comment sync is not available on a managed host' : null),
  },
  'remote.gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection': {
    disposition: 'refused',
    why:
      'this setting feeds public comment text to the agent as instructions; on a shared host a prompt-injected ' +
      'agent is a foothold, and the key\'s own name is the argument',
    guard: (v) => (v === true ? 'public comment sync is not available on a managed host' : null),
  },

  // ── Everything that only shapes the project's own turns ─────────────────
  //
  // These are RESPECTED because they act inside the agent container — which is
  // true only because `runner.type` above is overridden to a container runner.
  'automation.maintain': { disposition: 'respected' },
  'automation.react': { disposition: 'respected' },
  'automation.pre_accept': { disposition: 'respected' },
  'automation.pre_accept.enabled': { disposition: 'respected' },
  'automation.pre_accept.commands': { disposition: 'respected' },
  'automation.pre_accept.timeout': { disposition: 'respected' },
  'automation.pre_turn': { disposition: 'respected' },
  'automation.pre_turn_timeout': { disposition: 'respected' },
  'automation.pre_turn_required': { disposition: 'respected' },
  'automation.post_turn': { disposition: 'respected' },
  'automation.post_turn_timeout': { disposition: 'respected' },
  'automation.accept_check': { disposition: 'respected' },
  'automation.accept_check_timeout': { disposition: 'respected' },
  'checks.post_turn': { disposition: 'respected' },
  'checks.post_turn_timeout': { disposition: 'respected' },

  'session.verbose': { disposition: 'respected' },
  'session.debug': { disposition: 'respected' },
  'session.auto_commit_instructions': { disposition: 'respected' },
  'git.default_branch_prefix': { disposition: 'respected' },
  'git.lfs_check': { disposition: 'respected' },
  'output.shortid_length': { disposition: 'respected' },
  'agent.agent_id': { disposition: 'respected' },
  'agent.by_type': { disposition: 'respected' },
  'agent.watchdog_output_timeout_ms': { disposition: 'respected' },
  'agent.wind_down_timeout_ms': { disposition: 'respected' },
  'agent.graceful_exit_timeout_ms': { disposition: 'respected' },
  'agent.effort': { disposition: 'respected' },
  // How a project reviews its own tasks: it decides how much of the PROJECT's
  // own agent budget a task spends on being read, and claims nothing from the
  // host — the same shape as the auto-react family below.
  'review.mode': { disposition: 'respected' },
  'review.auto_fix': { disposition: 'respected' },
  'review.gate': { disposition: 'respected' },
  'review.draft_effort': { disposition: 'respected' },
  'review.review_effort': { disposition: 'respected' },
  // DEPRECATED spellings of the three keys above, from before the low-high loop
  // became a review mode. The loader still honours them, so managed mode has to
  // classify them the same way — exactly as `loop.*` is classified alongside
  // `cluster.*`.
  'agent.low_high_loop': { disposition: 'respected' },
  'agent.low_high_loop_draft_effort': { disposition: 'respected' },
  'agent.low_high_loop_review_effort': { disposition: 'respected' },
  'builder.effort': { disposition: 'respected' },
  'chattiness.default': { disposition: 'respected' },
  'chattiness.builder': { disposition: 'respected' },
  'chattiness.agent': { disposition: 'respected' },
  'permissions.protected': { disposition: 'respected' },
  'protection.enabled': { disposition: 'respected' },
  'protection.protected_branches': { disposition: 'respected' },
  'protection.protected_tasks': { disposition: 'respected' },
  'protection.gate_default_branch': { disposition: 'respected' },
  'serve.ports': { disposition: 'respected' },
  'serve.services': { disposition: 'respected' },
  'serve.start_services_cmd': { disposition: 'respected' },
  'memory.warn_bytes': { disposition: 'respected' },
  'docs.url': { disposition: 'respected' },
  'daemon.auto_react_ci': { disposition: 'respected' },
  'daemon.auto_react_comments': { disposition: 'respected' },
  'daemon.auto_react_max_retries': { disposition: 'respected' },
  'daemon.auto_react_backoff': { disposition: 'respected' },
  'daemon.auto_react_daily_budget': { disposition: 'respected' },
  'daemon.max_auto_turns': { disposition: 'respected' },
  'limits.max_turns_without_human': { disposition: 'respected' },
  // How many rounds a cluster may spend on one child before it must decide. Like
  // the auto-react family above, it paces how much of the PROJECT's own agent
  // budget one task may consume — it claims nothing from the host — so a
  // project setting its own number is respected.
  'cluster.max_child_fix_rounds': { disposition: 'respected' },
  // DEPRECATED spelling of the key above, from before the `loop` task type was
  // renamed `cluster`. The loader still honours it, so managed mode has to
  // classify it the same way — exactly as `checks.*` is classified alongside
  // `automation.*`.
  'loop.max_child_fix_rounds': { disposition: 'respected' },
  // Usage pausing only ever RESTRAINS spending: a project can make its turns
  // wait earlier, never claim more of the host or of anyone's credential.
  'usage_pause.threshold_percent': { disposition: 'respected' },
  'usage_pause.credentials': { disposition: 'respected' },
  // The auto-resume family paces retries of the project's OWN interrupted tasks,
  // the same shape as the auto-react keys above: it decides how often this
  // project's agent runs, not how much of the host it may claim. The gap key is
  // a floor between two resumes project-wide, so lowering it cannot exceed what
  // the fleet already allows a project to launch by hand.
  'daemon.auto_resume': { disposition: 'respected' },
  'daemon.auto_resume_interval_minutes': { disposition: 'respected' },
  'daemon.auto_resume_gap_minutes': { disposition: 'respected' },
  'daemon.auto_resume_max_attempts': { disposition: 'respected' },
};

// ── Evaluation ────────────────────────────────────────────────────────────

export interface ManagedRefusal {
  /** The policy key, e.g. `runner.type` or `mounts`. */
  key: string;
  /** What the repository asked for — quoted back so the user can find it. */
  asked: unknown;
  /** One sentence a human can act on. */
  why: string;
}

export interface ManagedOverride {
  key: string;
  /** What the repository's lazy.toml asked for. */
  asked: unknown;
  /** What the managed host uses instead. */
  effective: unknown;
  why: string;
}

export interface ManagedEvaluation {
  managed: boolean;
  refusals: ManagedRefusal[];
  overrides: ManagedOverride[];
  /** Keys the repository set that have no classification at all. */
  unclassified: string[];
}

/**
 * Flatten a raw parsed lazy.toml into the dotted policy keys it actually asks
 * for, with the value asked for.
 *
 * Only keys the file MENTIONS are produced. A refusal that fired on a merged
 * default would refuse every project on the fleet for settings nobody wrote.
 */
export function flattenConfigAsks(raw: Record<string, unknown>): Map<string, unknown> {
  const asks = new Map<string, unknown>();

  const walk = (value: unknown, path: string): void => {
    // A section that is classified as a whole (`mounts`, `features`) stops the
    // walk: its inner keys are covered by the section's own rule.
    if (path && SECTION_TERMINAL.has(path)) {
      asks.set(path, value);
      return;
    }
    if (Array.isArray(value)) {
      // Array of tables: `[[proxy.fallback]]` → `proxy.fallback[].upstream`.
      for (const entry of value) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          walk(entry, `${path}[]`);
        }
      }
      if (value.length === 0 || value.some((e) => !e || typeof e !== 'object')) {
        // A plain array value (`worktree.include = [...]`) is a leaf.
        asks.set(path, value);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // A role name and an agent-profile name are both user-chosen; the
        // policy classifies the SHAPE. Without the `agents` case here, every
        // `[agents.<name>]` block would flatten under the name the repository
        // invented, match no rule, and be honoured — including its `endpoint`.
        const segment = path === 'models.roles' || path === 'agents' ? '*' : k;
        walk(v, path ? `${path}.${segment}` : segment);
      }
      return;
    }
    asks.set(path, value);
  };

  for (const [section, value] of Object.entries(raw)) {
    // Backward-compat top-level `runner = "docker"` is the same ask as
    // `[runner] type =`, and must be classified as such rather than slipping
    // through as an unknown scalar.
    if (section === 'runner' && typeof value === 'string') {
      asks.set('runner.type', value);
      continue;
    }
    walk(value, section);
  }

  return asks;
}

/**
 * Sections classified as a whole rather than key by key: `[[mounts]]` because
 * every field of a mount is part of one refused thing, `[features]` because it
 * is freeform and cannot be enumerated in advance, `[serve.services]` because
 * its keys are service NAMES the user chooses.
 */
const SECTION_TERMINAL = new Set(['mounts', 'features', 'serve.services']);

/**
 * Classify what a raw lazy.toml asks for. Pure — no environment reads beyond
 * arming, no throwing. `lazy doctor` uses this to report without re-running the
 * whole load.
 *
 * UNCLASSIFIED KEYS FAIL CLOSED, and they fail as REFUSED rather than
 * overridden-to-default. Overriding to a default asserts the default is safe,
 * which is exactly the judgement nobody made for a key with no entry. Refusal
 * is loud at provisioning, where the fleet operator sees it — and because the
 * coverage test fails on an unclassified key, no such key can reach a release
 * anyway, so refusal's cost is paid by lazy's CI rather than by a tenant.
 *
 * A key that lazy does not KNOW at all (a typo, a stale option from an older
 * version) is not refused: lazy never reads it, so it cannot do anything.
 * `lazy doctor`'s unknown-key scan already reports those.
 */
export function evaluateManagedConfig(
  raw: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): ManagedEvaluation {
  const managed = isManagedMode(env);
  if (!managed || !raw) return { managed, refusals: [], overrides: [], unclassified: [] };

  const fleet = readFleetValues(env);
  const refusals: ManagedRefusal[] = [];
  const overrides: ManagedOverride[] = [];
  const unclassified: string[] = [];

  for (const [key, asked] of flattenConfigAsks(raw)) {
    const rule = MANAGED_POLICY[key];

    if (!rule) {
      // Only keys lazy actually resolves fail closed. An unknown key is inert.
      if (isKnownConfigKey(key)) {
        unclassified.push(key);
        refusals.push({
          key,
          asked,
          why: 'this setting has no managed-mode classification, and an unclassified setting is refused rather than guessed at',
        });
      }
      continue;
    }

    if (rule.disposition === 'refused') {
      // A guard lets a refused key be stated harmlessly (a profile with no
      // endpoint) without failing an otherwise fine project.
      const reason = rule.guard ? rule.guard(asked) : (rule.why ?? 'not available on a managed host');
      if (reason) refusals.push({ key, asked, why: reason });
      continue;
    }

    if (rule.disposition === 'overridden') {
      overrides.push({
        key,
        asked,
        effective: rule.effective ? rule.effective(fleet) : undefined,
        why: rule.why ?? '',
      });
      continue;
    }

    // Respected — unless its guard says this particular value is not safe here.
    const reason = rule.guard?.(asked);
    if (reason) refusals.push({ key, asked, why: reason });
  }

  return { managed, refusals, overrides, unclassified };
}

/** True when the dotted key is one the policy table knows about. */
function isKnownConfigKey(key: string): boolean {
  return key in MANAGED_POLICY;
}

/**
 * Apply the managed policy to a fully-resolved config, in place.
 *
 * Called by `loadConfig` after resolution and validation. Throws
 * {@link ManagedConfigRefusedError} when the repository asked for something the
 * fleet does not offer — the daemon does not start, and Lazy Teams renders the
 * refusal (`managed_config_refused`).
 *
 * A NO-OP WHEN MANAGED MODE IS OFF: the first line returns, and nothing below it
 * can touch an unmanaged config.
 */
export function applyManagedPolicy(
  config: ResolvedConfig,
  raw: Record<string, unknown> | null,
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ManagedEvaluation {
  if (!isManagedMode(env)) return { managed: false, refusals: [], overrides: [], unclassified: [] };

  const fleet = readFleetValues(env);
  const evaluation = evaluateManagedConfig(raw, env);

  if (evaluation.refusals.length > 0) {
    throw new ManagedConfigRefusedError(evaluation.refusals, configPath);
  }

  // Overrides are applied for EVERY overridden key, not only the ones the
  // repository mentioned. A key the file omits still resolves to lazy's default,
  // and the fleet's value — not lazy's — is the one a managed host must run on.
  for (const [key, rule] of Object.entries(MANAGED_POLICY)) {
    if (rule.disposition === 'overridden' && rule.apply) rule.apply(config, fleet);
  }

  // Recompute the effective values now that the config carries them, so the
  // report shows what the run actually uses rather than what the rule predicted.
  for (const override of evaluation.overrides) {
    const rule = MANAGED_POLICY[override.key];
    if (rule?.effective) override.effective = rule.effective(fleet);
  }

  return evaluation;
}

// The proxy used to be switchable off (`[proxy] enabled = false` resolved to a
// null proxy), so managed mode had to rebuild the fleet's proxy in that one
// case. The key is gone and `config.proxy` is always present, so there is
// nothing left to rebuild.
