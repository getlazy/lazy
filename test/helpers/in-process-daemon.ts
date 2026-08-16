/**
 * Contain the process-wide side effects of a daemon started IN-PROCESS.
 *
 * WHY THIS EXISTS: `startDaemonServer()` sets `process.env.LAZY_IS_DAEMON = '1'`
 * on the process that calls it (src/daemon/server.ts) — correct for a real
 * daemon, which owns its process and exits with it, but a dozen e2e suites call
 * that function directly inside `bun test` to drive a REAL daemon over a unix
 * socket. `stop()` does not unset the flag, so the FIRST such suite in a run
 * leaves `LAZY_IS_DAEMON=1` in an environment every later test file shares.
 *
 * What that does downstream is silent and total: `LAZY_IS_DAEMON=1` means "I am
 * the daemon, never RPC myself", so `tryRemoteStorage`/`tryRpc` return null
 * without even looking for a socket (src/cli/helpers.ts, src/daemon/client.ts).
 * Every CLI child of a later `withDaemon: true` suite therefore refuses to talk
 * to the daemon that suite just started, and dies with
 * "Error: Daemon is not running. Start it with: lazy daemon start" — while
 * `lazy daemon status`, which only reads the pidfile, cheerfully reports the
 * daemon running.
 *
 * Measured shape: `bun test --timeout 30000 test/e2e/builder-token-revoke.test.ts
 * test/e2e/mcp.test.ts` was 24 pass / 45 fail, essentially every failure that
 * message from `createTask`; each file alone was 4/0 and 65/0. Nothing crashed
 * and nothing was slow — one env var set in a `beforeEach` and never cleared.
 *
 * So: call this at describe (or module) scope in ANY suite that starts a daemon
 * in-process. It snapshots the variable before the suite's first test and
 * restores it after the last, exactly like `enableInProcessTestMode()` does for
 * `LAZY_TEST` — the flag cannot outlive the file that caused it.
 *
 * Belt-and-braces: `setupTestLazy` also pins `LAZY_IS_DAEMON: ''` on every
 * process it spawns, so a daemon-backed context is immune even to a leak from a
 * suite that forgets to call this. Both exist for the same reason the `LAZY_TEST`
 * pair does: this helper keeps IN-PROCESS readers in later files clean, the pin
 * keeps SUBPROCESSES clean.
 */

import { beforeAll, afterAll } from 'bun:test';

/**
 * Env vars an in-process daemon suite mutates process-wide.
 *
 * `LAZY_IS_DAEMON` is set by `startDaemonServer()` itself. `LAZY_TEST` is set by
 * the suites — every one of them assigns `process.env.LAZY_TEST = '1'` in a
 * `beforeEach` and never restores it, because a daemonless project plus an
 * in-process daemon needs `tryRpc` to stay out of the way. Both are correct
 * INSIDE the file and wrong the moment it ends, so both are snapshotted here.
 */
const IN_PROCESS_DAEMON_ENV = ['LAZY_IS_DAEMON', 'LAZY_TEST'] as const;

export function isolateInProcessDaemonEnv(): void {
  const previous = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of IN_PROCESS_DAEMON_ENV) previous.set(key, process.env[key]);
  });

  afterAll(() => {
    for (const key of IN_PROCESS_DAEMON_ENV) {
      const prior = previous.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });
}
