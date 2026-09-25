/**
 * Subprocess probe: writes a marker file from process.on('exit'), then hangs until
 * SIGINT. If re-raise kills by signal without running exit handlers, the marker
 * file must not exist afterward.
 *
 * Usage: bun daemon-registry-exit-probe.ts <markerPath>
 */
process.env.LAZY_TEST_REGISTRY_SKIP_AUTO_INSTALL = '1';

const markerPath = process.argv[2];
if (!markerPath) {
  console.error('usage: daemon-registry-exit-probe.ts <markerPath>');
  process.exit(2);
}

async function main(): Promise<void> {
  const { registerTestDaemonRoot } = await import('./daemon-registry');
  registerTestDaemonRoot('/tmp/lazy-exit-probe-unused-root');

  process.on('exit', () => {
    try {
      require('fs').writeFileSync(markerPath, 'exit ran');
    } catch {
      // Best effort — exit handler must stay sync.
    }
  });

  console.log('ready');
  setInterval(() => {}, 1000);
}

void main();

export {};
