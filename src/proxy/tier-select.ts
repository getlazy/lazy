/**
 * Per-request tier choice for a TIERED agent profile.
 *
 * A tiered profile (`[agents.<name>] tiers = [...]`, src/config/agent-profiles.ts)
 * is an ordered list of (named endpoint, model). For every request the proxy
 * takes the FIRST tier that is available. A tier is used until it SAYS NO
 * (engineer, 2026-10-06: "just let it rip until the 429 is in"):
 *
 *  - a tier the provider REFUSED for capacity (`isCapacityRefusal`) is
 *    unavailable until its refusal's `retryAt` (`TierRefusals`, `refusalFor`):
 *    the provider's `retry-after` or stated reset, else `[proxy]
 *    tier_retry_interval`; a WINDOWED tier is tried again no later than that
 *    interval either, because a window can be reset or a plan upgraded before
 *    the reset it reported. Coming back means routing the next real request
 *    there — no probe — and a tier that refuses again falls through at once;
 *  - a CONDITIONAL tier (Anthropic `unified-*`, ChatGPT `codex-*`) WITH a
 *    threshold is also unavailable while its latest reading has a window at or
 *    over that threshold that has not reset yet — the usage pause's own
 *    question (`evaluateUsagePause`). The threshold is an optional EARLY switch;
 *  - everything else is available.
 *
 * When no tier is available (`allFull`) NO tier serves: the proxy answers the
 * request itself with a 429 whose `retry-after` is the earliest time any tier
 * may serve again (`earliestReset`, `allTiersFullMessage`), and never forwards
 * it upstream. `tier` is then the last tier, kept only so the usage pause can
 * read its verdict. Engineer decisions 2026-10-01 and 2026-10-06
 * (docs/design/tiered-agent-profiles.md).
 *
 * Pure apart from the injected lookups, so the switching rule is testable
 * without a proxy.
 */

import { usageSourceFor, evaluateUsagePause, thresholdFor, windowLabel, type UsagePauseVerdict } from '../usage-pause/policy';
import { usageWindows, type UsageLimitReading } from './usage-limits';
import type { TierRoute } from './agent-upstreams';

export interface TierChoice {
  tier: TierRoute;
  /** Plain-language reason, recorded with a switch. */
  reason: string;
  /** Every tier above `tier` that was skipped as refusing or full, with why. */
  skipped: Array<{ tier: TierRoute; why: string; credential: string | null; verdict: UsagePauseVerdict }>;
  /** True when every tier was unavailable: no tier serves, the proxy answers 429. */
  allFull: boolean;
}

export interface TierLookups {
  /** The usage-reading key a tier's traffic is filed under, or null when none. */
  keyFor(tier: TierRoute): Promise<string | null>;
  readingFor(key: string): UsageLimitReading | null;
  /** The tier's latest capacity refusal under that key, if any (`TierRefusals.lookupFor`). */
  refusalFor?(tier: TierRoute, key: string | null): TierRefusal | null;
}

const HARNESS_FOR_SOURCE = { claude: 'claude-code', codex: 'codex' } as const;

export async function chooseTier(
  tiers: TierRoute[],
  lookups: TierLookups,
  now: number = Date.now(),
): Promise<TierChoice> {
  const skipped: TierChoice['skipped'] = [];
  for (const tier of tiers) {
    const key = await lookups.keyFor(tier);
    const refusal = lookups.refusalFor?.(tier, key) ?? null;
    if (refusal && now < refusal.retryAt) {
      skipped.push({ tier, why: describeRefusal(refusal), credential: key, verdict: refusalVerdict(refusal, key ?? tier.endpoint) });
      continue;
    }
    // A refusal whose time is up: this request is the tier's come-back.
    const back = refusal ? ` (${describeRefusal(refusal)}; trying it again)` : '';
    if (tier.usage === null) {
      return { tier, skipped, allFull: false, reason: describe(tier, skipped, `is used until it refuses${back}`) };
    }
    // A LAST conditional tier with no threshold of its own is judged by
    // [usage_pause], the same number that pauses an ordinary profile on it.
    const threshold = tier.threshold ?? (tier.pause && key ? thresholdFor(tier.pause, key) : 0);
    if (threshold <= 0) {
      return { tier, skipped, allFull: false, reason: describe(tier, skipped, `is used until it refuses${back}`) };
    }
    // On a come-back, the reading the refusal itself carried (rejected, 100%)
    // must not hold the tier until its reported reset: the come-back request
    // is what takes a fresh one.
    const latest = key ? lookups.readingFor(key) : null;
    const reading = refusal && latest && latest.ts <= refusal.refusedAt ? null : latest;
    const source = usageSourceFor(HARNESS_FOR_SOURCE[tier.usage]);
    const verdict = source ? evaluateUsagePause(reading, source.pauseWindows, threshold, now) : null;
    if (!verdict) {
      return {
        tier, skipped, allFull: false,
        reason: describe(tier, skipped, `${reading ? `is under ${threshold}%` : 'has no usage reading yet'}${back}`),
      };
    }
    skipped.push({ tier, why: describeFull(verdict), credential: key, verdict });
  }
  const last = tiers[tiers.length - 1]!;
  return {
    tier: last,
    skipped,
    allFull: true,
    reason: describe(last, skipped, 'is the last tier; every tier is refusing or over its threshold, so no tier serves'),
  };
}

function describeFull(v: UsagePauseVerdict): string {
  const used = v.usedPercent === null ? (v.status ?? 'over its limit') : `${v.usedPercent}% used`;
  const reset = v.resetsAt === null ? 'no reset time given' : `resets ${new Date(v.resetsAt).toISOString()}`;
  return `${windowLabel(v.window)} ${used}, threshold ${v.threshold}% (${reset})`;
}

function describe(tier: TierRoute, skipped: TierChoice['skipped'], why: string): string {
  const head = `tier ${tier.index + 1} (${tier.endpoint}, ${tier.model}) ${why}`;
  if (skipped.length === 0) return head;
  return `${head}; skipped ${skipped.map((s) => `tier ${s.tier.index + 1} (${s.tier.endpoint}): ${s.why}`).join('; ')}`;
}

/**
 * The earliest time any skipped tier may serve again — a full window's reset
 * or a refusal's retry time — or null when none of them states one.
 */
export function earliestReset(choice: TierChoice): number | null {
  let best: number | null = null;
  for (const s of choice.skipped) {
    const at = s.verdict.resetsAt;
    if (at !== null && (best === null || at < best)) best = at;
  }
  return best;
}

/** `retry-after` when no full window states its reset. */
export const ALL_FULL_UNKNOWN_RESET_RETRY_SECONDS = 60;

/** Seconds for `retry-after` when every tier is full: to the earliest reset, at least 1. */
export function allFullRetryAfterSeconds(resetAt: number | null, now: number = Date.now()): number {
  if (resetAt === null) return ALL_FULL_UNKNOWN_RESET_RETRY_SECONDS;
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * What the harness shows when every tier is full: the profile, that every tier
 * is full, and when one may serve again. Worded as the rate limit it is — no
 * auth or billing words — so lazy retries the turn instead of blocking it
 * (src/agent/failure-taxonomy.ts).
 */
export function allTiersFullMessage(profile: string, choice: TierChoice, resetAt: number | null): string {
  const when = resetAt === null
    ? 'no full tier states when it may serve again'
    : `the earliest tier resets at ${new Date(resetAt).toISOString()}`;
  const tiers = choice.skipped.map((s) => `tier ${s.tier.index + 1} (${s.tier.endpoint}): ${s.why}`).join('; ');
  return `lazy proxy: every tier of agent profile "${profile}" is full (refused for its rate limit, or over its threshold), ` +
    `so no tier can serve this request; ${when}. ${tiers}`;
}

/** The 429 body, in the wire format the harness speaks. */
export function allTiersFullBody(wire: 'anthropic' | 'openai'): (message: string) => string {
  return wire === 'openai'
    ? (message) => JSON.stringify({ error: { message, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } })
    : (message) => JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } });
}

/** One tier switch, as the proxy reports it to whoever records it. */
export interface TierSwitchEvent {
  taskId: string | null;
  /** The launch grant's label — names a BUILDER launch (`taskId` null), e.g. `builder-<id>`. */
  label?: string;
  /** Host-minted credential binding for a builder launch, distinct from its display label. */
  bindingKey?: string;
  /** The TIERED profile the grant names. */
  profile: string;
  /** Null when the proxy has no earlier request on record (e.g. after a daemon restart). */
  from: { index: number; endpoint: string; model: string } | null;
  /** Null when every tier is full and the proxy answered 429 instead (`allFull`). */
  to: { index: number; endpoint: string; model: string } | null;
  /** With `to: null`: the earliest time a tier may serve again, when one is known. */
  retryAt?: number | null;
  /** Why — the reading or refusal behind it, in plain words. */
  reason: string;
  allFull: boolean;
  /** True once the session has been served by more than one provider origin. */
  crossed: boolean;
  /** True when the switching request went out with `thinking` turned off (src/proxy/tier-history.ts). */
  thinkingDisabled: boolean;
  ts: number;
}

// --- Capacity refusals: "use it until it says no" ---

/**
 * Is this upstream response a refusal for CAPACITY — the tier's rate limit or
 * quota — rather than a fault in the request? A 429, from every provider lazy
 * routes to: Anthropic answers its API rate limits and an exhausted
 * subscription window alike with `429 rate_limit_error` (the unified status
 * then reads `rejected`, docs/spikes/usage-limit-signals.md); ChatGPT/Codex's
 * `usage_limit_reached` is a 429 (`codexRefusalHeaders`); OpenAI-compatible
 * providers (Fireworks, gateways) answer their rate and quota limits with 429.
 * Deliberately NOT 529/503: Anthropic's `overloaded_error` is the provider's
 * own load rather than this account's limit, and the harness retries it itself.
 */
export function isCapacityRefusal(status: number): boolean {
  return status === 429;
}

export { DEFAULT_TIER_RETRY_INTERVAL_SECONDS } from './upstream-defaults';

/** A tier's latest capacity refusal. */
export interface TierRefusal {
  status: number;
  refusedAt: number;
  /** When the next real request may go to this tier again. */
  retryAt: number;
  /** Where `retryAt` came from, in plain words. */
  basis: string;
}

/**
 * When a refused tier may be tried again, from the refusal's own headers:
 * `retry-after`, else the reset of the window the provider says refused
 * (`usageWindows`), else `intervalSeconds`. A WINDOWED tier (`usage` set) is
 * tried again no later than `intervalSeconds` even when its reset is later —
 * "anthropic could reset the window, or the user could reset it or upgrade the
 * plan" (engineer, 2026-10-06). Never sooner than one second, so a request can
 * never loop on the tier that just refused it.
 */
export function refusalFor(
  tier: Pick<TierRoute, 'usage'>,
  status: number,
  headers: Record<string, string> | null,
  intervalSeconds: number,
  now: number = Date.now(),
): TierRefusal {
  const interval = now + Math.max(1, intervalSeconds) * 1000;
  let reported: number | null = null;
  let basis = '';
  const retryAfter = headers?.['retry-after'];
  if (retryAfter !== undefined) {
    const secs = Number(retryAfter);
    const at = retryAfter.trim() !== '' && Number.isFinite(secs) ? now + secs * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      reported = at;
      basis = 'its retry-after';
    }
  }
  if (reported === null && headers) {
    const refused = usageWindows(headers, now, status)
      .filter((w) => w.resetsAt !== null && (w.status === 'rejected' || (w.usedPercent ?? 0) >= 100));
    if (refused.length > 0) {
      reported = Math.max(...refused.map((w) => w.resetsAt!));
      basis = 'its reported reset';
    }
  }
  let retryAt: number;
  if (reported === null) {
    retryAt = interval;
    basis = 'the tier retry interval';
  } else if (tier.usage !== null && interval < reported) {
    retryAt = interval;
    basis = `the tier retry interval, ahead of ${basis} at ${clock(reported)}`;
  } else {
    retryAt = reported;
  }
  return { status, refusedAt: now, retryAt: Math.max(retryAt, now + 1000), basis };
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** e.g. "refused 429 at 01:07:39, retry after 06:00:00 (its reported reset)". */
export function describeRefusal(r: TierRefusal): string {
  return `refused ${r.status} at ${clock(r.refusedAt)}, retry after ${clock(r.retryAt)} (${r.basis})`;
}

/** A refusal as a pause verdict, for the usage pause when every tier is unavailable. */
function refusalVerdict(r: TierRefusal, credential: string): UsagePauseVerdict {
  return {
    credential, window: 'refused', usedPercent: null, status: 'rejected',
    threshold: 0, resetsAt: r.retryAt, readingAt: r.refusedAt,
  };
}

/**
 * Every tier's latest capacity refusal, per PROFILE and CREDENTIAL — the usage
 * key `TierLookups.keyFor` answers, so it becomes per member wherever that key
 * is. In memory and bounded: a daemon restart forgets refusals, which costs at
 * most one more refused (and at once retried) request per tier.
 */
export class TierRefusals {
  private readonly map = new Map<string, TierRefusal>();
  constructor(private readonly max = 1000) {}

  private static key(profile: string, tier: Pick<TierRoute, 'index' | 'endpoint'>, credential: string | null): string {
    return `${profile}\u0000${tier.index}\u0000${tier.endpoint}\u0000${credential ?? ''}`;
  }

  get(profile: string, tier: Pick<TierRoute, 'index' | 'endpoint'>, credential: string | null): TierRefusal | null {
    return this.map.get(TierRefusals.key(profile, tier, credential)) ?? null;
  }

  refuse(profile: string, tier: Pick<TierRoute, 'index' | 'endpoint'>, credential: string | null, refusal: TierRefusal): void {
    const k = TierRefusals.key(profile, tier, credential);
    this.map.delete(k);
    this.map.set(k, refusal);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** The tier served a request: its refusal is over. */
  clear(profile: string, tier: Pick<TierRoute, 'index' | 'endpoint'>, credential: string | null): void {
    this.map.delete(TierRefusals.key(profile, tier, credential));
  }

  /** Forget every refusal (tests). */
  resetForTest(): void {
    this.map.clear();
  }

  /** `TierLookups.refusalFor` for one profile. */
  lookupFor(profile: string): (tier: TierRoute, credential: string | null) => TierRefusal | null {
    return (tier, credential) => this.get(profile, tier, credential);
  }
}

/** The daemon-wide refusal record: the proxy writes it, the usage pause and tier views read it. */
export const daemonTierRefusals = new TierRefusals();
