/**
 * THE ONE SHAPE of "how much of each credential's limits is used": what
 * `lazy stats limits --json` prints and what the `lazy_usage_limits` MCP tool
 * returns. Both build it here, so the two cannot drift.
 *
 * Pure: the readings come from the proxy's tracker (`usageLimits` RPC), the
 * pause state from `[usage_pause]` (`usagePause` RPC). Narrowing to one
 * credential — what a task agent is allowed to see — is `scopeUsageLimitsView`,
 * applied by the daemon before anything leaves it.
 */
import type { UsageLimitReading } from '../proxy/usage-limits';
import {
  describeReadingsStoreError,
  overageStatusOf,
  type OverageStatus,
  type UsagePauseCoverage,
  type UsagePauseVerdict,
} from './policy';
import type { UsagePauseHold } from './hold';

/** A task whose daemon-started launch the pause is holding. */
export interface UsageLimitHoldView {
  taskId: string;
  task: string;
  hold: UsagePauseHold;
}

export interface UsageLimitsReadingView extends UsageLimitReading {
  /** Paid overage on this credential, from its latest reading, or null when not reported. */
  overage: OverageStatus | null;
  /** The verdict `[usage_pause]` is holding this credential under right now, or null. */
  paused: UsagePauseVerdict | null;
}

/** The pause-state fields of the view — a subset of the daemon's `UsagePauseState`. */
export interface UsageLimitsPauseInput {
  configured: { threshold_percent: number; credentials: Record<string, number> };
  override: number | null;
  paused: UsagePauseVerdict[];
  held: UsageLimitHoldView[];
  /**
   * Every credential the pause is armed for that has spent turns, and whether
   * its reading lets the pause act — `none` is "armed, NO READING". Absent
   * from an older daemon's answer (read as none listed).
   */
  coverage?: UsagePauseCoverage[];
  /**
   * The saved readings cannot be read (path and why). A view is never built
   * over it — see {@link projectUsageLimits}. Absent from an older daemon.
   */
  storeError?: { path: string | null; message: string } | null;
}

/** The pause section of a view: the input minus `storeError`, which never reaches one. */
export interface UsageLimitsPauseView {
  configured: { threshold_percent: number; credentials: Record<string, number> };
  override: number | null;
  paused: UsagePauseVerdict[];
  held: UsageLimitHoldView[];
  /** Armed credentials and whether each has a usable reading (`none` = armed, NO READING). */
  coverage: UsagePauseCoverage[];
}

/**
 * The one refusal every surface that builds a view gives while the saved
 * readings cannot be read — `lazy stats limits --json`, `lazy_usage_limits` on
 * the daemon's MCP route and on a host-side MCP server.
 */
export function usageLimitsUnreadableMessage(e: { path: string | null; message: string }): string {
  return (
    `Could not read the proxy's usage-limit readings: ${describeReadingsStoreError(e)} ` +
    `No numbers are shown rather than numbers that would look like nothing was used.`
  );
}

/** Thrown by {@link projectUsageLimits} over an unreadable store. */
export class UsageLimitsUnreadableError extends Error {
  constructor(readonly storeError: { path: string | null; message: string }) {
    super(usageLimitsUnreadableMessage(storeError));
    this.name = 'UsageLimitsUnreadableError';
  }
}

export interface UsageLimitsView {
  /**
   * `project`: every credential the proxy has seen (the CLI and the builder).
   * `member`: a builder on a Lazy Teams host — the service credential, the
   *   builder session's own credential, and anything not tied to a member.
   * `task`: only the credential the calling task's turn spends.
   */
  scope: 'project' | 'member' | 'task';
  /** With scope `task` or `member`: the caller's own credential, or null when lazy cannot tell. */
  credential?: string | null;
  /** Latest reading per credential, most recent first. */
  readings: UsageLimitsReadingView[];
  pause: UsageLimitsPauseView;
}

/**
 * INVARIANT: an empty reading list never means "the readings could not be
 * read", and "armed, NO READING" never drops out of the machine-readable view.
 * With the saved readings unreadable, the daemon's reading list is empty or
 * partial, so this REFUSES rather than build a view a builder would plan from
 * as untouched headroom. And `coverage` rides along, scoped like the readings,
 * so a credential armed with no reading is listed rather than simply absent.
 */
export function projectUsageLimits(readings: UsageLimitReading[], pause: UsageLimitsPauseInput): UsageLimitsView {
  if (pause.storeError) throw new UsageLimitsUnreadableError(pause.storeError);
  return {
    scope: 'project',
    readings: readings.map((r) => ({
      ...r,
      overage: overageStatusOf(r),
      paused: pause.paused.find((p) => p.credential === r.credential) ?? null,
    })),
    pause: {
      configured: { ...pause.configured, credentials: { ...pause.configured.credentials } },
      override: pause.override,
      paused: pause.paused,
      held: pause.held,
      coverage: (pause.coverage ?? []).map((c) => ({ ...c })),
    },
  };
}

/**
 * Narrow a project view to what one task's agent may see: its own credential's
 * reading, pause verdict, configured threshold and coverage, and its own hold. Other
 * members' credentials (on a Teams host, `user:<email>` keys) never appear.
 * `credential` null → nothing credential-specific survives.
 */
export function scopeUsageLimitsView(
  view: UsageLimitsView,
  credential: string | null,
  taskId: string,
): UsageLimitsView {
  const own = (c: string) => credential !== null && c === credential;
  const credentials: Record<string, number> = {};
  if (credential !== null && credential in view.pause.configured.credentials) {
    credentials[credential] = view.pause.configured.credentials[credential];
  }
  return {
    scope: 'task',
    credential,
    readings: view.readings.filter((r) => own(r.credential)),
    pause: {
      configured: { threshold_percent: view.pause.configured.threshold_percent, credentials },
      override: view.pause.override,
      paused: view.pause.paused.filter((p) => own(p.credential)),
      held: view.pause.held.filter((h) => h.taskId === taskId),
      coverage: view.pause.coverage.filter((c) => own(c.credential)),
    },
  };
}

/**
 * Narrow a project view to what a builder on a Lazy Teams host may see: no
 * other member's `user:<email>` credential — its reading, pause verdict,
 * threshold, or the tasks held on it. What survives is the project's service
 * credential (`serviceCredential`), the builder session's own credential
 * (`credential`, null when the session is bound to none), and every reading not
 * keyed to a member. The same boundary a member's own CLI has: the project-wide
 * readings are control-plane only there.
 */
export function memberUsageLimitsView(
  view: UsageLimitsView,
  credential: string | null,
  serviceCredential: string,
): UsageLimitsView {
  const visible = (c: string) => !c.startsWith('user:') || c === serviceCredential || c === credential;
  const credentials: Record<string, number> = {};
  for (const [c, v] of Object.entries(view.pause.configured.credentials)) {
    if (visible(c)) credentials[c] = v;
  }
  return {
    scope: 'member',
    credential,
    readings: view.readings.filter((r) => visible(r.credential)),
    pause: {
      configured: { threshold_percent: view.pause.configured.threshold_percent, credentials },
      override: view.pause.override,
      paused: view.pause.paused.filter((p) => visible(p.credential)),
      held: view.pause.held.filter((h) => visible(h.hold.credential)),
      coverage: view.pause.coverage.filter((c) => visible(c.credential)),
    },
  };
}
