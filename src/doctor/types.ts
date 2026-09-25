/**
 * Shared types for the doctor module.
 *
 * Doctor is a report, not a command: the same structured result is printed by
 * `lazy doctor`, served by the daemon RPC, and filed as an inbox alert when
 * anything failed. Presentation (colours, prompts, process.exit) stays in the
 * CLI; this module only decides what is true.
 */

import type { DocsPage } from '../docs/links';
import type { ContextBudgetReport } from '../context-budget';
import type { ResolvedConfig } from '../config/types';
import type { Runner } from '../runner';
import type { Storage } from '../storage/interface';
import type { DoctorCheckFamily, DoctorImpact, DoctorRemedyKind } from './check-families';
import type { DaemonHealthReport } from '../daemon/daemon-health-rows';

/** One check's outcome as the CLI has always printed it. */
export interface CheckResult {
  ok: boolean;
  label: string;
  /** Shown on failure. */
  detail?: string;
  /** Shown as a yellow warning even when ok. */
  warning?: string;
  /**
   * Documentation page for this check, printed under a FAILURE as
   * "Check documentation at <url>". A supplement only: `detail` still carries
   * the whole remedy, and the pointer is omitted entirely when a project has
   * disabled doc links.
   */
  docs?: DocsPage;
  /** Stable id for the structured report. Inferred from the label when omitted. */
  id?: string;
  /** Plain-language remedy line (no ANSI), for the JSON report and the inbox alert. */
  remedy?: string;
  /** `lazy doctor --<flag>` that acts on this finding, when one exists. */
  remedyFlag?: string;
  /**
   * Classification override for checks whose label is not fixed text (the
   * runner's and the remote driver's own diagnostics). Everything else is
   * classified from its label by `./check-families.ts`.
   */
  classification?: DoctorCheckFamily;
}

export type CheckStatus = 'ok' | 'warning' | 'error';

/** One check as the JSON report and the web Settings page consume it. */
export interface DoctorCheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  docs?: string | null;
  remedy?: string;
  remedyFlag?: string;
  /**
   * Stable key for the kind of check, independent of what its label says this
   * run. The three classification fields are absent on a last report stored by
   * a daemon that predates them; a client treats that as unclassified.
   */
  family?: string;
  /** What kind of act fixes this — machine-readable, so no client parses `remedy`. */
  remedyKind?: DoctorRemedyKind;
  /** `work` when the finding stops or degrades task turns; `setup` otherwise. */
  impact?: DoctorImpact;
}

/** A task whose run is gone — listed after the sweep, never auto-resumed. */
export interface MissingRun {
  taskCode: string;
  taskId: string;
  taskStatus: string;
  runName: string;
  exitCode: number;
  finishedAt: string | null;
  explanation: string;
}

/**
 * The full, JSON-able doctor report.
 *
 * `checks` is the sweep. `contextBudget` and `missingRuns` are sections that
 * are not pass/fail checks (a table of numbers, and a listing of dead runs).
 */
export interface DoctorReport {
  ranAt: string;
  root: string | null;
  checks: DoctorCheckResult[];
  contextBudget: ContextBudgetReport | null;
  missingRuns: MissingRun[];
  staleStorageLockPath: string | null;
  configError: string | null;
  notes: string[];
  errorCount: number;
  warningCount: number;
}

/**
 * A named check the runner can execute.
 *
 * `run` may return null to omit the check (gated off), one result, or several
 * (credentials, managed-config keys). A throw becomes an error-status result
 * so one broken check cannot take the rest of the sweep down.
 */
export interface DoctorCheck<C = DoctorContext> {
  id: string;
  title: string;
  run: (ctx: C) => Promise<CheckResult | CheckResult[] | null>;
  remedyFlag?: string;
}

/**
 * What a check is allowed to see.
 *
 * Storage is optional: the daemon passes its long-lived handle so the sweep
 * never opens a second FileStorage against the lock it already holds. The CLI
 * leaves it unset and each storage-backed check opens the doctor handle
 * (daemon first, fail-fast fallback).
 */
export interface DoctorContext {
  root: string | null;
  config: ResolvedConfig | null;
  configError: string | null;
  runner: Runner | null;
  runnerError: string | null;
  storage?: Storage;
  lockBlocks: boolean;
  heldLockSummary: string;
}

/**
 * Inputs to one doctor run.
 *
 * `onStaleStorageLock` is the only interactive seam: the CLI prompts (or
 * honours `--yes` / `--dry-run`); the daemon never removes a lock on its own.
 * Returning `'removed'` lets the rest of the sweep proceed as if the wedge
 * were gone — which is why the CLI has always asked BEFORE the other checks.
 */
export interface DoctorRunOptions {
  root: string | null;
  cwd?: string;
  storage?: Storage;
  /**
   * Called when a lock nobody will ever release is found, BEFORE the rest of
   * the sweep. `detail` is the check's failure text so the CLI can print it
   * next to the prompt. The daemon omits this and never removes a lock.
   */
  onStaleStorageLock?: (path: string, detail?: string) => Promise<'removed' | 'left'>;
  /**
   * Name the command that sets the one-shot usage-pause override. Only
   * `lazy doctor` run by a person at their own terminal passes true
   * (`mayOfferUsagePauseOverride`); the daemon's own run, and the builder or
   * an agent following a refusal's pointer to doctor, are never told it.
   */
  offerUsagePauseOverride?: boolean;
  /**
   * Where the daemon-health summary line gets its report. The daemon's own
   * run passes its in-process collector (it must not RPC itself); left unset,
   * the sweep asks the running daemon over RPC — and says so when none is up.
   */
  daemonHealth?: () => Promise<DaemonHealthReport>;
}

/** How a stored last-report is remembered between `doctor.run` and `doctor.report`. */
export interface StoredDoctorReport {
  report: DoctorReport;
  storedAt: string;
}
