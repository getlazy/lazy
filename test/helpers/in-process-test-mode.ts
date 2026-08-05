/**
 * Declare test mode for e2e suites that call `src/` code IN-PROCESS.
 *
 * WHY THIS EXISTS: `setupTestLazy()` sets `LAZY_TEST=1` on every SUBPROCESS a
 * daemonless suite spawns (see `test/helpers/setup.ts`) and the subprocess
 * reconcile driver sets it too (`test/helpers/reconcile.ts`) — but the `bun test`
 * process itself never had it. A suite that imports `reconcileTasks` and awaits
 * it directly therefore ran production code in NON-test mode, inside a project
 * that has no daemon by design.
 *
 * That was invisible until the audit/policy proxy became on-by-default:
 * `createRunner` now resolves the daemon's live proxy address up front and fails
 * loud when it can't (`ProxyUnavailableError`), so every in-process reconcile
 * pass aborted before doing any work. `LAZY_TEST=1` is the documented bypass for
 * exactly this situation — "the harness runs the whole CLI without a daemon by
 * design" (`proxyGateBypassed` in `src/daemon/auth-env.ts`) — and it is what the
 * subprocess drivers have always used. This makes the in-process driver
 * symmetric with them rather than inventing a second seam.
 *
 * Call it at module scope, before any test runs. It is process-wide and not
 * undone: every subprocess these daemonless suites spawn already runs with
 * `LAZY_TEST=1`, so the parent matching them changes nothing else.
 *
 * Do NOT call this from a `withDaemon: true` suite — there `LAZY_TEST=1` must
 * stay unset so the CLI actually talks to the real test daemon.
 */
export function enableInProcessTestMode(): void {
  process.env.LAZY_TEST = '1';
}
