/**
 * The hostname the web dashboard lives on, and the URL printed for it.
 *
 * WHY THE DASHBOARD HAS ITS OWN HOSTNAME
 *
 * Browser cookies are scoped by HOST, not by port. The dashboard's session
 * cookie (src/daemon/dashboard-auth.ts) is therefore sent to EVERY origin on
 * the same hostname, whatever port it is on. And `[serve]` publishes every
 * task's app ports on `127.0.0.1:<hostPort>` (SERVE_BIND_HOST in
 * src/serve/ports.ts) — code an agent wrote, running in a container. If the
 * dashboard also lived on `127.0.0.1`, then the moment the engineer opened a
 * task's app at `http://127.0.0.1:3000` to look at it, the browser would hand
 * that app the dashboard session, and the container could replay it against
 * the daemon over host.docker.internal — everything the sign-in gate exists to
 * deny.
 *
 * So the dashboard is addressed as `lazy.localhost`, a name no published task
 * port ever uses. `*.localhost` resolves to loopback inside Chromium and
 * Firefox per RFC 6761 with no /etc/hosts entry. Safari and the OS resolver are
 * less consistent — glibc, measured, does not resolve it at all — so
 * `lazy dashboard` probes resolution and prints the one-line /etc/hosts remedy
 * rather than asserting it always works.
 *
 * The older hazard this replaced is still respected: plain `localhost` is NOT
 * used, because it can resolve to IPv6 `::1` and miss an IPv4-only `127.0.0.1`
 * bind, giving "can't connect" against a perfectly healthy daemon.
 * `lazy.localhost` is resolved by the browser (or by an /etc/hosts line we
 * print) to 127.0.0.1 specifically.
 *
 * Display rule, deliberately simple and predictable:
 *   - loopback (`127.0.0.1`, `::1`) and all-interfaces (`0.0.0.0`, `::`) binds
 *     → `lazy.localhost`. It reaches the daemon and is scoped away from task
 *     ports.
 *   - any other host (a specific interface IP the user chose in
 *     `[server] bind`) → shown as-is. It is already a distinct host from the
 *     `127.0.0.1` task ports live on, and rewriting the user's explicit choice
 *     would be the misleading thing.
 *
 * `bindHost` is optional so callers consuming a daemon status payload that
 * predates that field (older daemon binary still running) fall back to the
 * loopback default rather than printing `undefined`.
 */

/** The hostname the dashboard is addressed by on a loopback bind. */
export const DASHBOARD_HOSTNAME = 'lazy.localhost';

/** The hostname the dashboard is served on, for a given `[server] bind`. */
export function dashboardHostFor(bindHost: string | undefined): string {
  const host = bindHost ?? '127.0.0.1';
  if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::') {
    return DASHBOARD_HOSTNAME;
  }
  return host;
}

/** The dashboard's user-facing base URL. */
export function formatDashboardUrl(bindHost: string | undefined, port: number): string {
  return `http://${dashboardHostFor(bindHost)}:${port}`;
}

/** Configured public origin when present, otherwise the directly-bound URL. */
export function resolveDashboardUrl(
  bindHost: string | undefined,
  port: number,
  configuredUrl?: string,
): string {
  return configuredUrl || formatDashboardUrl(bindHost, port);
}
