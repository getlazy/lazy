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
 * The turn-identity pair is a third, subtler case with the same shape. When lazy
 * is developed WITH lazy — the normal way — `bun test` runs inside a task agent's
 * process tree, so `process.env` already carries that agent's
 * `LAZY_MCP_EXPECTED_TASK_ID` / `LAZY_MCP_EXPECTED_WORKTREE`. A test-spawned MCP
 * server inherits them, sees a `--task-id`/`--worktree` naming the temp project
 * instead of the outer task, and correctly refuses to start
 * (`assertMcpServesExpectedTurn`, src/mcp/turn-identity.ts) — killing every MCP
 * and builder-supervisor e2e suite with an error about the AGENT's task that has
 * nothing to do with the code under test. The guard is right; the inheritance is
 * the bug. It stays covered at the function boundary in
 * test/unit/mcp-turn-identity.test.ts, which is where its behavior belongs.
 *
 * Spread this AFTER `...process.env` and after any per-test overrides.
 */

import {
  MCP_EXPECTED_TASK_ID_ENV,
  MCP_EXPECTED_WORKTREE_ENV,
} from '../../src/mcp/turn-identity';

/**
 * Named from the production constants rather than re-spelled here: a rename in
 * turn-identity.ts must not leave this pinning a variable nothing reads any
 * more, which would revive the failure silently.
 */
export const TURN_IDENTITY_ENV_PINS = {
  [MCP_EXPECTED_TASK_ID_ENV]: '',
  [MCP_EXPECTED_WORKTREE_ENV]: '',
} as const;

export const MCP_SERVER_ENV_PINS = {
  LAZY_TEST: '',
  LAZY_IS_DAEMON: '',
  ...TURN_IDENTITY_ENV_PINS,
} as const;
