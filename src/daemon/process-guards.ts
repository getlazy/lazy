/**
 * Process-level guards for the daemon.
 *
 * WHY THE DAEMON NEEDS A NET AT ALL
 *
 * The audit proxy runs IN-PROCESS with the daemon: `startDaemonServer` creates
 * it with `createProxyServer` and holds it as `proxyServer`, a sibling of
 * `webServer` on the same event loop. There is therefore no isolation by
 * construction — anything that kills the process kills the daemon's RPC
 * listener with it, and every CLI, MCP and builder call in flight dies as
 * "the daemon dropped the connection".
 *
 * Under Bun an unhandled promise rejection TERMINATES the process (verified on
 * Bun 1.4.2: a bare `Promise.reject` in a timer exits the process with code 1),
 * and so does an uncaught exception raised outside a request promise. Until
 * this module existed the daemon installed only SIGTERM/SIGINT handlers, so a
 * single stray rejection anywhere in the process — proxy stream teardown, an
 * audit write, a background timer — was a whole-daemon outage.
 *
 * That risk was already known and written down: `docs/bun-1.4-fallout.md` notes
 * that an escaping throw from the heartbeat envelope "in production would take
 * the daemon with it", and the proxy startup path in `server.ts` guards its own
 * failure precisely so it is "never an unhandled rejection that silently kills
 * reconcile/sync/web (that was the ~6s-after-boot daemon death)". Both are
 * point fixes for specific call sites. This is the backstop for every site
 * nobody has thought of yet.
 *
 * WHY SURVIVING IS THE RIGHT CALL HERE
 *
 * The usual argument against catching `uncaughtException` is that the process
 * may be in an undefined state. That argument assumes the alternative is a
 * clean restart. Here it is not: the daemon is a long-lived multi-tenant server
 * whose death interrupts every running task's turn, drops every RPC mid-call,
 * and requires a human to notice and run `lazy daemon restart`. A stray
 * rejection from one proxy request is not a reason to do that to every other
 * task. This is the same reasoning as `src/mcp/process-guards.ts`, and stronger
 * — an MCP server serves one agent, the daemon serves all of them.
 *
 * Nothing is swallowed. Every event is logged at ERROR level with its full
 * stack, so the daemon log names the failure exactly as a crash would have,
 * minus the outage. CLAUDE.md's "never swallow, always surface" is satisfied by
 * surfacing; the deviation is only that the process keeps serving.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER
 *
 * Install it only AFTER startup has succeeded. A daemon that cannot bind its
 * port, open its store or start its proxy must still fail hard and exit — that
 * is `failStartup`'s job, and a half-running daemon is the outcome the proxy
 * startup path explicitly refuses. The guard is about staying up once up, never
 * about limping into service.
 *
 * The supervisor and builder deliberately get no such net (see the same note in
 * `src/mcp/process-guards.ts`): there a crash is visible to a human and the
 * work is recoverable, so failing loudly is better.
 */

import { logger } from '../utils/logger';

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Keep the daemon alive through an unexpected throw or rejection anywhere in
 * the process, logging it loudly.
 *
 * Returns an uninstall function. Call it from the daemon's `stop()` — same
 * discipline as the SIGTERM/SIGINT listeners, which are removed there too. An
 * in-process test daemon that did not remove these would leave a listener on
 * the `bun test` process, and the mere PRESENCE of a listener is what stops Bun
 * from exiting on a rejection — so a leaked guard would silently mask genuine
 * failures in every later test file.
 */
export function installDaemonProcessGuards(): () => void {
  const onUncaughtException = (err: unknown) => {
    logger.error(
      `Uncaught exception in the daemon process (daemon staying up): ${describe(err)}`,
    );
  };
  const onUnhandledRejection = (reason: unknown) => {
    logger.error(
      `Unhandled promise rejection in the daemon process (daemon staying up): ${describe(reason)}`,
    );
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return () => {
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  };
}
