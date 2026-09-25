/**
 * Subprocess driver for A/B timing of pre-fix vs post-fix SIGINT handling.
 *
 * Usage: bun daemon-registry-benchmark.ts <root> <old|new>
 *
 * `old` — pre-fix: unbounded reapAllTestDaemons in SIGINT, process.exit(130),
 *         exit handler runs unbounded reap again (double sweep).
 * `new` — post-fix: bounded sweep in SIGINT handler, then re-raise (no exit handler).
 *
 * Set LAZY_TEST_REGISTRY_SWEEP_DELAY_MS to simulate a busy /proc tree.
 */
process.env.LAZY_TEST_REGISTRY_SKIP_AUTO_INSTALL = '1';

const [root, mode] = process.argv.slice(2);
if (!root || (mode !== 'old' && mode !== 'new')) {
  console.error('usage: daemon-registry-benchmark.ts <root> <old|new>');
  process.exit(2);
}

async function main(): Promise<void> {
  const {
    registerTestDaemonRoot,
    installOldHandlersForBenchmark,
  } = await import('./daemon-registry');

  registerTestDaemonRoot(root);

  if (mode === 'old') {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('exit');
    installOldHandlersForBenchmark();
  }

  console.log('ready');
  setInterval(() => {}, 1000);
}

void main();

export {};
