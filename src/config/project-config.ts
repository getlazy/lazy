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
import { evaluateManagedConfig, flattenConfigAsks, MANAGED_POLICY } from './managed';
import { findUnknownConfigKeys } from './schema';

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
 * its own tunables, the per-agent-profile routes and the upstream → credential
 * map. The exact comparison is src/daemon/proxy-fingerprint.ts; this is the
 * description of it.
 */
export const RESTART_REQUIRED_SUMMARY: readonly string[] = [
  'proxy.retry_after_threshold',
  'proxy.upstream_timeout',
  'proxy.policy.deny_path_globs',
  'agent profiles ([agents.*]) that route to their own endpoint',
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
export function validateProjectConfigText(toml: string): ProjectConfigVerdict {
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
  // project owner chose it (src/config/managed.ts, `controlPlaneMay`).
  const evaluation = evaluateManagedConfig(raw, process.env, 'control-plane');
  for (const refusal of evaluation.refusals) {
    issues.push({ key: refusal.key, severity: 'error', message: refusal.why });
  }
  for (const override of evaluation.overrides) {
    issues.push({
      key: override.key,
      severity: 'note',
      message: `this installation decides this setting, so the value here is not used: ${override.why}`,
    });
  }

  // Only when the classification passed: a refused key makes the resolver throw
  // the same refusal again as one combined message, which says nothing new.
  if (evaluation.refusals.length === 0) {
    const message = resolverMessage(toml);
    if (message) issues.push({ key: keyNamedIn(message, raw), severity: 'error', message });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** The resolver's error for this text, or '' when it resolves. */
function resolverMessage(toml: string): string {
  try {
    resolveConfigText(toml, 'lazy.toml', { install: false, origin: 'control-plane' });
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
