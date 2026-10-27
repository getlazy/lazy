import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// INVARIANT: each probe identifier selects its own criterion after all modules
// are sourced. Duplicate function names silently hid the share-lag and DNS probes.
test('the combined harness keeps upstream and Apps probes independently registered', () => {
  const result = Bun.spawnSync(['bash', resolve(import.meta.dir, '../../scripts/smolvm-probes/run.sh'), '--list'], {
    timeout: 5000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe('');
  const sections = result.stdout.toString().split('\n==> ');
  for (const [id, criterion] of [
    ['S21', 'shape (b) — project dir shared'],
    ['S22', 'Boot with VPN ON'],
    ['S23', 'an unfenced restore of a network-enabled checkpoint'],
    ['S24', 'the Docker-isolated stateful fixture'],
    ['S25', 'cold pack AND live checkpoint restore'],
    ['S26', 'a checkpoint with --host-mounts refuses restore'],
  ]) {
    const matches = sections.filter(section => section.startsWith(`${id}:`));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain(`PASS IFF: ${criterion}`);
  }
});
