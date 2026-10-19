/**
 * Leaf-module home for proxy upstream default constants.
 *
 * WHY A SEPARATE FILE: src/config/loader.ts needs DEFAULT_CURSOR_UPSTREAM at
 * MODULE-INIT time (it sits in a module-level defaults object), and
 * src/proxy/cursor-route.ts sits on an import cycle back to the loader
 * (cursor-route → role-target → credentials/store → loader). Entering that
 * cycle through cursor-route — which is exactly what happens when a test file
 * imports src/agent/cursor.ts first — left the loader evaluating before
 * cursor-route's bindings existed: `ReferenceError: Cannot access
 * 'DEFAULT_CURSOR_UPSTREAM' before initialization`. A constants-only leaf
 * module has no imports, so it initializes first from any direction and the
 * cycle stops mattering for these values.
 */

/** Cursor's production API origin — the default upstream for the cursor route. */
export const DEFAULT_CURSOR_UPSTREAM = 'https://api2.cursor.sh';

/**
 * Default ceiling, in seconds, for one upstream request (0 = no ceiling).
 *
 * Matched to the supervisor's default no-progress watchdog
 * (`watchdog_output_timeout_ms`, 30 minutes): the guard that gives up on a
 * wedged turn should be the turn's own watchdog — which reports a legible
 * "killed after no output" — never the proxy, which can only report a network
 * failure the operator then has to diagnose. See src/proxy/upstream-timeout.ts
 * for why lazy sets this at all rather than leaving it to Bun.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 1800;

/**
 * Default `[proxy] tier_retry_interval`, in seconds: how long a tier that
 * refused for capacity without a retry time is skipped (src/proxy/tier-select.ts).
 */
export const DEFAULT_TIER_RETRY_INTERVAL_SECONDS = 300;

/**
 * Defaults of `[proxy] audit_retention_days` / `audit_retention_mib`: the proxy
 * audit log keeps 7 days or 128 MiB, whichever comes first (engineer's
 * decision, 2026-10-06; src/proxy/audit-log.ts).
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 7;
export const DEFAULT_AUDIT_RETENTION_MIB = 128;
/** The smallest size budget: the live segment plus one rotated 4 MiB segment. */
export const MIN_AUDIT_RETENTION_MIB = 8;
