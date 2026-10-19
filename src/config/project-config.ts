/**
 * Judging a CANDIDATE project config — lazy.toml text somebody wants to run on
 * but has not saved yet.
 *
 * A control plane (Lazy Teams) edits a managed project's config in a browser
 * and must show the daemon's OWN verdict on it, per key, before anything is
 * written. So the verdict is assembled here from the same three sources a load
 * uses — the unknown-key scan, the managed-mode classification and the resolver
 * itself ({@link resolveConfigText}) — and no rule is restated.
 *
 * Pure: no filesystem, no process-wide side effects (the resolver runs with
 * `install: false`).
 */

import { resolveConfigText } from './loader';
import { evaluateManagedConfig, flattenConfigAsks, MANAGED_POLICY, type ManagedConfigOrigin } from './managed';
import { findUnknownConfigKeys } from './schema';
import { withholdRefused, type WithheldSetting } from './managed-withhold';

/** One finding about a candidate config. */
export interface ProjectConfigIssue {
  /**
   * The dotted key it is about (`runner.type`, `serve.services`), or null for a
   * finding about the file as a whole (a TOML syntax error, a validation the
   * resolver reports without naming one key).
   */
  key: string | null;
  /**
   * `error` blocks a save. `note` does not: it says a key is present but the
   * installation decides it, so the value written is not the value in force.
   */
  severity: 'error' | 'note';
  message: string;
}

export interface ProjectConfigVerdict {
  /** True when nothing in `issues` is an error. */
  ok: boolean;
  issues: ProjectConfigIssue[];
}

/**
 * What a change needs a daemon restart for, in words a page can show.
 *
 * Everything a project may set is read per operation — next turn, next
 * reconciler tick — EXCEPT what the daemon's proxy is built from at startup:
 * its own tunables. Profile routes and credential targets are live. The exact
 * comparison is src/daemon/proxy-fingerprint.ts.
 */
export const RESTART_REQUIRED_SUMMARY: readonly string[] = [
  'proxy.retry_after_threshold',
  'proxy.tier_retry_interval',
  'proxy.upstream_timeout',
  'proxy.audit_retention_days',
  'proxy.audit_retention_mib',
  'proxy.policy.deny_path_globs',
];

/**
 * Every key a managed project may set: the ones managed mode RESPECTS. This is
 * the editable set a control plane offers, taken from the policy table itself
 * so there is never a second list.
 */
export function editableConfigKeys(): string[] {
  return Object.entries(MANAGED_POLICY)
    .filter(([, rule]) => rule.disposition === 'respected' || (rule.disposition === 'refused' && rule.controlPlaneMay))
    .map(([key]) => key)
    .sort();
}

/** "Unknown config option 'a.b' in lazy.toml" → "a.b"; a section → its name. */
function unknownKeyOf(message: string): string | null {
  const match = /'\[?([^'\]]+)\]?'/.exec(message);
  return match ? match[1]! : null;
}

/**
 * The daemon's verdict on `toml`, as it would be judged under the current
 * environment (managed or not).
 */
export interface ValidateProjectConfigOptions {
  /**
   * Text whose withheld settings are already accepted as kept — the saved
   * version an edit starts from, or for an import the imported text itself.
   */
  kept?: string | null;
  /**
   * Whose rules `toml` is judged by. `repository` for text a control plane
   * IMPORTED from a repository and nobody has edited since: its endpoint and
   * credential names stay refused (./managed). Default `control-plane`.
   */
  origin?: ManagedConfigOrigin;
  /** Whose rules `kept` was judged by — to say what an edit newly makes active. */
  keptOrigin?: ManagedConfigOrigin;
}

/** The settings the managed rules would withhold from `toml` (none when it does not parse). */
export function withheldOf(toml: string | null | undefined, origin: ManagedConfigOrigin = 'control-plane'): WithheldSetting[] {
  if (!toml) return [];
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(toml) as Record<string, unknown>;
  } catch {
    // Unparseable text withholds nothing; its syntax error is reported on its own.
    return [];
  }
  return withholdRefused(raw, process.env, origin).withheld;
}

function issueKeyOf(item: WithheldSetting): string {
  return item.kind === 'profile' ? `agents.${item.name}` : item.kind === 'endpoint' ? `endpoints.${item.name}` : item.name;
}

export function validateProjectConfigText(toml: string, options: ValidateProjectConfigOptions = {}): ProjectConfigVerdict {
  const issues: ProjectConfigIssue[] = [];

  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(toml) as Record<string, unknown>;
  } catch {
    // The resolver produces the actionable message (with the offending line),
    // so a syntax error is reported through it rather than rephrased here.
    return { ok: false, issues: [{ key: null, severity: 'error', message: resolverMessage(toml) }] };
  }

  // A NOTE, not an error: lazy never reads an unknown key, so it is inert —
  // the same judgement managed mode makes (src/config/managed.ts). Refusing it
  // would also refuse the IMPORT of a repository whose lazy.toml carries a
  // stale option it has always run fine with.
  for (const warning of findUnknownConfigKeys(raw)) {
    issues.push({
      key: unknownKeyOf(warning),
      severity: 'note',
      message: `${warning.replace(/ in lazy\.toml$/, '')} — lazy does not read it (check the spelling against lazy.toml.example)`,
    });
  }

  // Judged as the CONTROL PLANE's config, which is where this text goes: the
  // project owner chose it (src/config/managed.ts, `controlPlaneMay`). What
  // the managed rules refuse is WITHHELD at runtime (./managed-withhold), never
  // honoured: it is an error for a NEW setting somebody is writing, and a note
  // for one `kept` already carries — an imported file is kept verbatim, and an
  // edit elsewhere in it must not be refused for what the import brought in.
  const origin = options.origin ?? 'control-plane';
  const keptWithheld = withheldOf(options.kept, options.keptOrigin ?? origin);
  const keptKeys = new Set(keptWithheld.map(issueKeyOf));
  const nowWithheld = withheldOf(toml, origin);
  // Never silent: a setting the IMPORTED text carried unused that this save
  // (judged as the owner's own) would start using is said, by name.
  const nowKeys = new Set(nowWithheld.map(issueKeyOf));
  for (const item of keptWithheld) {
    const key = issueKeyOf(item);
    if (nowKeys.has(key)) continue;
    if (!toml.includes(item.name)) continue;
    issues.push({
      key,
      severity: 'note',
      message: 'came from the repository and was not used; saving this version makes it take effect',
    });
  }
  for (const item of nowWithheld) {
    const key = issueKeyOf(item);
    const kept = keptKeys.has(key);
    issues.push({
      key,
      severity: kept ? 'note' : 'error',
      message: kept ? `kept as written, but not used on this installation: ${item.reason}` : item.reason,
    });
  }
  const evaluation = evaluateManagedConfig(raw, process.env, 'control-plane');
  for (const override of evaluation.overrides) {
    issues.push({
      key: override.key,
      severity: 'note',
      message: `this installation decides this setting, so the value here is not used: ${override.why}`,
    });
  }

  const message = resolverMessage(toml, origin);
  if (message) issues.push({ key: keyNamedIn(message, raw), severity: 'error', message });

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** The resolver's error for this text, or '' when it resolves. */
function resolverMessage(toml: string, origin: ManagedConfigOrigin = 'control-plane'): string {
  try {
    resolveConfigText(toml, 'lazy.toml', { install: false, origin });
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The key a resolver message is about, when it names exactly one key the file
 * sets. The resolver's messages name sections and keys in prose ("lazy.toml
 * [proxy] retry_after_threshold must be…"); anything ambiguous stays null
 * rather than pinning the error on a guess.
 */
function keyNamedIn(message: string, raw: Record<string, unknown>): string | null {
  const named = [...flattenConfigAsks(raw).keys()].filter((key) => {
    const dot = key.lastIndexOf('.');
    if (dot < 0) return false;
    const section = key.slice(0, dot).replace(/\[\]$/, '');
    const leaf = key.slice(dot + 1);
    return message.includes(`[${section}]`) && new RegExp(`\\b${leaf}\\b`).test(message);
  });
  return named.length === 1 ? named[0]! : null;
}

/** Whether one `[agents.<name>]` profile of a candidate config can be used. */
export interface ProfileSupport {
  name: string;
  /**
   * `usable`: tasks can run on it. `withheld`: the managed rules refuse part of
   * it, so the daemon does not load it.
   */
  status: 'usable' | 'withheld';
  reason: string | null;
}

/**
 * Every profile the text DEFINES, with whether this installation can use it —
 * so a control plane can show an imported profile that is kept but not usable
 * instead of it silently not being there.
 */
export function profileSupport(toml: string, origin: ManagedConfigOrigin = 'control-plane'): ProfileSupport[] {
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(toml) as Record<string, unknown>;
  } catch {
    // A file that does not parse defines no profile anyone could use; its
    // syntax error is reported as an issue of its own.
    return [];
  }
  const agents = raw.agents && typeof raw.agents === 'object' ? raw.agents as Record<string, unknown> : {};
  const withheld = new Map(withholdRefused(raw, process.env, origin).withheld
    .filter((w) => w.kind === 'profile').map((w) => [w.name, w.reason]));
  return Object.entries(agents).map(([name]) => {
    const reason = withheld.get(name);
    if (reason !== undefined) return { name, status: 'withheld' as const, reason };
    return { name, status: 'usable' as const, reason: null };
  });
}
