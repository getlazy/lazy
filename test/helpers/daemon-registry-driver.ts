/**
 * Subprocess driver for daemon-registry.test.ts.
 *
 * The registry's safety net calls `process.exit()`, so it cannot be exercised
 * in the test runner's own process. This tiny program registers a root and then
 * dies in a chosen way, letting the parent assert the registered daemon was
 * reaped even though no `afterEach` ran.
 *
 * Usage: bun daemon-registry-driver.ts <root> <exit|hang>
 *   exit — register, then fall off the end (normal process exit)
 *   hang — register, then stay alive forever (parent sends SIGINT)
 */
import { registerTestDaemonRoot } from './daemon-registry';

const [root, mode] = process.argv.slice(2);
if (!root || !mode) {
  console.error('usage: daemon-registry-driver.ts <root> <exit|hang>');
  process.exit(2);
}

registerTestDaemonRoot(root);

if (mode === 'hang') {
  // Signal readiness, then keep the event loop alive until SIGINT arrives.
  console.log('ready');
  setInterval(() => {}, 1000);
} else {
  // mode === 'exit': fall through to normal exit; the 'exit' handler reaps.
  console.log('ready');
}
