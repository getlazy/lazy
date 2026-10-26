import { expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { requireDockerRelayRuntime } from '../../src/vm/docker-relay';

// INVARIANT: builds and relay startup must refuse runtimes known to close the
// response side on Docker's stdin EOF. Exit zero with no output is not success.
test('a broken Unix half-close runtime is refused with the upgrade remedy', () => {
  expect(() => requireDockerRelayRuntime('1.3.11')).toThrow('cannot preserve attached Docker output');
  expect(() => requireDockerRelayRuntime('1.3.11')).toThrow('mise install');
  expect(() => requireDockerRelayRuntime('1.4.3')).not.toThrow();
});

test('the pinned runtime and the build entry point enforce the relay requirement', async () => {
  const root = join(import.meta.dir, '../..');
  requireDockerRelayRuntime((await readFile(join(root, '.bun-version'), 'utf8')).trim());
  const build = await readFile(join(root, 'scripts/build.ts'), 'utf8');
  expect(build.indexOf('requireDockerRelayRuntime();')).toBeLessThan(build.indexOf('captureBuildProvenance(projectRoot)'));
  expect(build).toContain('requireDockerRelayRuntime();');
});
