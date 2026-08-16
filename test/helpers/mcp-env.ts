/**
 * The environment an e2e-spawned `lazy-agent mcp` server must run with.
 *
 * WHY THIS EXISTS: every MCP e2e suite spawns the server itself — `spawn([...,
 * 'mcp', ...], { env: { ...process.env } })` — rather than going through
 * `ctx.lazy`, so it inherits whatever the `bun test` process happens to carry.
 * That environment is shared by every test FILE in the run, and two flags in it
 * silently reroute the server's storage:
 *
 * - `LAZY_TEST=1` → `requireStorage` takes the local-storage bypass. The same
 *   suite's `ctx.lazy()` children talk to the test daemon, so the two halves of
 *   one test write to DIFFERENT stores. Measured: `LAZY_TEST=1 bun test
 *   test/e2e/mcp.test.ts` is 26 pass / 39 fail against 65/0 clean.
 * - `LAZY_IS_DAEMON=1` → "I am the daemon, never RPC myself": the server skips
 *   the socket and exits "Daemon is not running". Leaked by any suite that ran
 *   `startDaemonServer()` in-process earlier in the run (see
 *   test/helpers/in-process-daemon.ts).
 *
 * Neither is ever right for these suites: their MCP server must reach the real
 * test daemon over RPC, exactly like the pairing/builder MCP server does in
 * production. `''` is this repo's established spelling for "off" and is
 * equivalent to unset for every production reader (they test `=== '1'` or plain
 * truthiness).
 *
 * Spread this AFTER `...process.env` and after any per-test overrides.
 */
export const MCP_SERVER_ENV_PINS = { LAZY_TEST: '', LAZY_IS_DAEMON: '' } as const;
