/**
 * THE ONE SHAPE of "how much of each credential's limits is used": what
 * `lazy stats limits --json` prints and what the `lazy_usage_limits` MCP tool
 * returns. Both build it here, so the two cannot drift — and both attach the
 * token budget the same way (`attachBudget`, src/usage-pause/budget-view.ts).
 *
 * Pure: the readings come from the proxy's tracker (`usageLimits` RPC), the
 * pause state from `[usage_pause]` (`usagePause` RPC). Narrowing to one
 * credential — what a task agent is allowed to see — is `scopeUsageLimitsView`,
 * applied by the daemon before anything leaves it.
 */
import type { CredentialFailure } from '../proxy/credential-health';
import type { ProviderHealth } from '../proxy/provider-health';
import type { UsageLimitReading, UsageWindow } from '../proxy/usage-limits';
import { isMemberEndpointUsageKey, memberEndpointUsageKey, usageLimitCredentialKey } from '../proxy/usage-limits';
import {
  describeReadingsStoreError,
  overageStatusOf,
  windowResetSince,
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

export interface UsageLimitsWindowView extends UsageWindow {
  /**
   * Set when the window has reset since the reading (its reset time passed, or
   * an untimed reading aged out): Unix ms of that moment. `usedPercent` and
   * `status` are then null — nothing is known about the window until the next
   * request. The stored numbers stay in the reading's `storedWindows`.
   */
  resetSince: number | null;
}

export interface UsageLimitsReadingView extends Omit<UsageLimitReading, 'windows'> {
  /** The reading's windows as of now: one that has reset carries `resetSince` and no percentage. */
  windows: UsageLimitsWindowView[];
  /** The windows exactly as stored when the reading was taken — for forensics, never current usage. */
  storedWindows: UsageWindow[];
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
  /** Tasks whose running turn lazy stopped for spend. Absent from an older daemon. */
  stopped?: RunningStopView[];
}

/**
 * A task whose running turn lazy stopped: `usage` (its credential crossed the
 * threshold — resumes by itself after the reset) or `cap` (its own token cap —
 * waits for a person). `line` is the wording every surface shows.
 */
export interface RunningStopView {
  taskId: string;
  task: string;
  kind: 'usage' | 'cap';
  line: string;
  /** For `usage`: the credential it spent. */
  credential?: string;
  /** For `usage`: when it resumes (unix ms), or null when no reset time is known. */
  resetsAt?: number | null;
}

/** The pause section of a view: the input minus `storeError`, which never reaches one. */
export interface UsageLimitsPauseView {
  configured: { threshold_percent: number; credentials: Record<string, number> };
  override: number | null;
  paused: UsagePauseVerdict[];
  held: UsageLimitHoldView[];
  /** Armed credentials and whether each has a usable reading (`none` = armed, NO READING). */
  coverage: UsagePauseCoverage[];
  /** Tasks whose running turn lazy stopped for spend. */
  stopped: RunningStopView[];
}

/** How every unreadable-readings refusal begins — {@link attachBudget} keeps it loud. */
export const UNREADABLE_PREFIX = "Could not read the proxy's usage-limit readings: ";

/**
 * The one refusal every surface that builds a view gives while the saved
 * readings cannot be read — `lazy stats limits --json`, `lazy_usage_limits` on
 * the daemon's MCP route and on a host-side MCP server.
 */
export function usageLimitsUnreadableMessage(e: { path: string | null; message: string }): string {
  return (
    `${UNREADABLE_PREFIX}${describeReadingsStoreError(e)} ` +
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
   *   Pair/Chat is narrower: only the authenticated member's primary account.
   * `task`: only the credential the calling task's turn spends.
   */
  scope: 'project' | 'member' | 'task';
  /** With scope `task` or `member`: the caller's own credential, or null when lazy cannot tell. */
  credential?: string | null;
  /** Latest reading per credential, most recent first. */
  readings: UsageLimitsReadingView[];
  pause: UsageLimitsPauseView;
  /**
   * Every credential whose latest request FAILED — refused upstream, or one
   * lazy could not use at all (a refused refresh) — with or without a reading,
   * scoped like `readings`. Empty when everything works.
   */
  credentialHealth: CredentialFailure[];
  /**
   * Per provider/endpoint over the last hour: requests, failures by kind, last
   * failure — "is it the provider or is it us?". Not credential-scoped: it
   * names providers and hosts, never whose account. Absent from an older daemon.
   */
  providerHealth?: ProviderHealth[];
}

/**
 * A stored window as it stands at `now`. INVARIANT: a window the pause treats
 * as reset (`windowResetSince`) never carries its old percentage — a builder
 * reading `usedPercent: 100` of a window that is empty would plan around a
 * limit that is not there.
 */
export function currentWindow(w: UsageWindow, readingTs: number, now: number): UsageLimitsWindowView {
  const resetSince = windowResetSince(w, readingTs, now);
  return resetSince === null
    ? { ...w, resetSince: null }
    : { ...w, usedPercent: null, status: null, resetSince };
}

/**
 * INVARIANT: an empty reading list never means "the readings could not be
 * read", and "armed, NO READING" never drops out of the machine-readable view.
 * With the saved readings unreadable, the daemon's reading list is empty or
 * partial, so this REFUSES rather than build a view a builder would plan from
 * as untouched headroom. And `coverage` rides along, scoped like the readings,
 * so a credential armed with no reading is listed rather than simply absent.
 */
export function projectUsageLimits(
  readings: UsageLimitReading[],
  pause: UsageLimitsPauseInput,
  now: number = Date.now(),
  credentialHealth: readonly CredentialFailure[] = [],
  providerHealth: readonly ProviderHealth[] = [],
): UsageLimitsView {
  if (pause.storeError) throw new UsageLimitsUnreadableError(pause.storeError);
  return {
    scope: 'project',
    readings: readings.map((r) => ({
      ...r,
      windows: r.windows.map((w) => currentWindow(w, r.ts, now)),
      storedWindows: r.windows.map((w) => ({ ...w })),
      overage: overageStatusOf(r),
      paused: pause.paused.find((p) => p.credential === r.credential) ?? null,
    })),
    pause: {
      configured: { ...pause.configured, credentials: { ...pause.configured.credentials } },
      override: pause.override,
      paused: pause.paused,
      held: pause.held,
      coverage: (pause.coverage ?? []).map((c) => ({ ...c })),
      stopped: (pause.stopped ?? []).map((x) => ({ ...x })),
    },
    credentialHealth: credentialHealth.map((f) => ({ ...f })),
    providerHealth: providerHealth.map((h) => ({ ...h, failures: { ...h.failures } })),
  };
}

/**
 * Provider health for a narrowed view: counts and times, never the failure
 * TEXT, which can name another member's credential (a member's label is their
 * address) or quote an upstream error from somebody else's request.
 */
function withoutFailureText(health: readonly ProviderHealth[]): ProviderHealth[] {
  return health.map((h) => ({ ...h, failures: { ...h.failures }, lastFailure: null }));
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
  endpointCredentials: readonly string[] = [],
): UsageLimitsView {
  const own = (c: string) => (credential !== null && c === credential) || endpointCredentials.includes(c);
  const credentials: Record<string, number> = {};
  for (const [key, value] of Object.entries(view.pause.configured.credentials)) {
    if (own(key)) credentials[key] = value;
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
      stopped: view.pause.stopped.filter((x) => x.taskId === taskId),
    },
    credentialHealth: view.credentialHealth.filter((f) => own(f.credential)),
    ...(view.providerHealth ? { providerHealth: withoutFailureText(view.providerHealth) } : {}),
  };
}

/** Pair/Chat shows only its member's connections for the task's profile. */
export function memberPairUsageLimitsView(view: UsageLimitsView, email: string, endpointIds: readonly string[] = ['builtin:anthropic']): UsageLimitsView {
  const member = email.trim().toLowerCase();
  if (!member) throw new Error('Member usage limits require the authenticated member identity.');
  return {
    ...scopeUsageLimitsView(view, usageLimitCredentialKey({ userId: member, upstream: '' }), '',
      endpointIds.map(endpoint => memberEndpointUsageKey(member, endpoint))),
    scope: 'member',
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
  endpointCredentials: readonly string[] = [],
): UsageLimitsView {
  const visible = (c: string) => (!c.startsWith('user:') && !isMemberEndpointUsageKey(c)) ||
    c === serviceCredential || c === credential || endpointCredentials.includes(c);
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
      stopped: view.pause.stopped.filter((x) => x.kind === 'cap' || (x.credential !== undefined && visible(x.credential))),
    },
    credentialHealth: view.credentialHealth.filter((f) => visible(f.credential)),
    ...(view.providerHealth ? { providerHealth: withoutFailureText(view.providerHealth) } : {}),
  };
}
