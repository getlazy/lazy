/**
 * Generic doctor runner: a list of named checks in, a structured report out.
 *
 * The production sweep (`runDoctorReport`) is more than "run every check" —
 * it gates on config/runner/lock and keeps the historical order the CLI
 * prints. This runner is the contract the registry promises: each check has
 * an id and a title, `run` is async, a throw becomes an error result, and
 * the report is JSON-able. Unit tests cover this; the sweep reuses
 * `statusOf` / `toStructuredCheck` so the two cannot drift on status mapping.
 */

import { docsUrl } from '../docs/links';
import { stripAnsi } from '../render/theme';
import { classifyDoctorCheck } from './check-families';
import type {
  CheckResult,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorReport,
  MissingRun,
} from './types';

export function statusOf(result: CheckResult): CheckStatus {
  if (!result.ok) return 'error';
  if (result.warning) return 'warning';
  return 'ok';
}

/** Stable id from a label when the check did not name one. */
export function checkIdFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 64) : 'check';
}

/**
 * Lift a CheckResult into the JSON-able shape.
 *
 * Detail prefers the failure text, then the warning. ANSI is stripped so the
 * web and the inbox alert never carry terminal colour codes.
 */
export function toStructuredCheck(
  result: CheckResult,
  fallback?: { id: string; title: string; remedyFlag?: string },
): DoctorCheckResult {
  const status = statusOf(result);
  const raw = status === 'error' ? result.detail : result.warning;
  const detail = raw ? stripAnsi(raw) : undefined;
  const id = result.id ?? fallback?.id ?? checkIdFromLabel(result.label);
  const remedyFlag = result.remedyFlag ?? fallback?.remedyFlag;
  const classification = result.classification
    ? { ...result.classification, remedyKind: remedyFlag ? 'flag' as const : result.classification.remedyKind }
    : classifyDoctorCheck(result.label, id, remedyFlag);
  return {
    id,
    title: result.label,
    status,
    detail,
    docs: result.docs ? docsUrl(result.docs) : undefined,
    remedy: result.remedy ?? (result.remedyFlag
      ? `lazy doctor --${result.remedyFlag}`
      : fallback?.remedyFlag
        ? `lazy doctor --${fallback.remedyFlag}`
        : undefined),
    remedyFlag,
    ...classification,
  };
}

export function buildReport(input: {
  root: string | null;
  checks: DoctorCheckResult[];
  contextBudget?: DoctorReport['contextBudget'];
  missingRuns?: MissingRun[];
  staleStorageLockPath?: string | null;
  configError?: string | null;
  notes?: string[];
  ranAt?: string;
}): DoctorReport {
  return {
    ranAt: input.ranAt ?? new Date().toISOString(),
    root: input.root,
    checks: input.checks,
    contextBudget: input.contextBudget ?? null,
    missingRuns: input.missingRuns ?? [],
    staleStorageLockPath: input.staleStorageLockPath ?? null,
    configError: input.configError ?? null,
    notes: input.notes ?? [],
    errorCount: input.checks.filter(c => c.status === 'error').length,
    warningCount: input.checks.filter(c => c.status === 'warning').length,
  };
}

/**
 * Run a list of named checks in order.
 *
 * A check that returns null is omitted (gated off). A throw becomes an
 * error-status result naming the check, so one broken check cannot cancel
 * the rest. This is the runner unit tests exercise; the production sweep
 * has additional gating but produces the same `DoctorReport` shape.
 */
export async function runChecks<C>(
  checks: DoctorCheck<C>[],
  ctx: C,
  options: { root?: string | null } = {},
): Promise<DoctorReport> {
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    try {
      const raw = await check.run(ctx);
      if (raw === null) continue;
      const list = Array.isArray(raw) ? raw : [raw];
      for (const item of list) {
        results.push(toStructuredCheck(item, check));
      }
    } catch (err) {
      results.push({
        id: check.id,
        title: check.title,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        remedyFlag: check.remedyFlag,
        ...classifyDoctorCheck(check.title, check.id, check.remedyFlag),
      });
    }
  }
  return buildReport({ root: options.root ?? null, checks: results });
}
