/**
 * Format a user-facing web dashboard URL from the daemon's ACTUAL bind host
 * and bound port.
 *
 * Why this exists: the daemon binds its TCP web server to `[server] bind`
 * (default 127.0.0.1 — see DEFAULT_SERVER_BIND). Printing a hardcoded
 * `http://localhost:<port>` is wrong in two ways:
 *   1. `localhost` can resolve to IPv6 `::1`, which does NOT reach an
 *      IPv4-only `127.0.0.1` bind — the user opens the printed URL and gets
 *      "can't connect" / an empty dashboard even though the daemon is healthy.
 *   2. It is outright misleading when the user binds to a specific interface.
 *
 * Display rule (kept deliberately simple + predictable per CLAUDE.md
 * "principle of least surprise"):
 *   - `0.0.0.0` / `::` (all interfaces) → `127.0.0.1`. The dashboard is
 *     reachable locally via loopback, so loopback is the convenient URL to
 *     click. (This mirrors the framing of the `[server] bind` exposure warn.)
 *   - any other host (loopback `127.0.0.1` or a specific interface IP) →
 *     shown as-is.
 *
 * `bindHost` is optional so callers consuming a daemon status payload that
 * predates this field (older daemon binary still running) fall back to the
 * loopback default rather than printing `undefined`.
 */
export function formatDashboardUrl(bindHost: string | undefined, port: number): string {
  const host = bindHost ?? '127.0.0.1';
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${displayHost}:${port}`;
}
