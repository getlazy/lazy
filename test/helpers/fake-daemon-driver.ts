/**
 * Stand-in for a running lazy daemon, for tests that fabricate daemon state
 * dirs (`lazy daemon list` / `kill-stray` / the registry).
 *
 * A bare `sleep` is no longer an adequate stand-in: the registry verifies that
 * a recorded pid really IS a lazy daemon before calling it alive. This driver
 * reproduces the signal a real daemon leaves behind — it holds an exclusive
 * flock on the dir's `daemon.lock` for its whole lifetime, exactly as
 * acquireDaemonLock does — so identity verification passes for the right
 * reason instead of being worked around.
 *
 * Usage: bun run test/helpers/fake-daemon-driver.ts <daemon-dir>
 * Prints "READY" once the lock is held, then sleeps until killed.
 */

import { openSync, mkdirSync, constants } from 'fs';
import { join } from 'path';
import { tryFlockNonBlocking } from '../../src/daemon/lifecycle';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: fake-daemon-driver.ts <daemon-dir>');
  process.exit(2);
}

mkdirSync(dir, { recursive: true });
const fd = openSync(join(dir, 'daemon.lock'), constants.O_CREAT | constants.O_RDWR, 0o644);
if (!tryFlockNonBlocking(fd)) {
  console.error(`another process already holds the daemon lock in ${dir}`);
  process.exit(1);
}

console.log('READY');

// Hold the lock (and the process) open until the test kills us. The interval
// keeps the event loop alive; closing the fd is the OS's job on exit.
setInterval(() => { /* keep alive */ }, 1000);
