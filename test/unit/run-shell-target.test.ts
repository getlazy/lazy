import { describe, test, expect } from 'bun:test';
import { resolveRunShellTarget } from '../../src/server/shell-ws';
import { runContainerName } from '../../src/run/identity';

/**
 * INVARIANT: a commit run's web shell (`/runs/:id/shell/ws`) can only exec into
 * THAT RUN'S OWN container — the name `runContainerName` derives from the run's
 * slug, the same rule its Start services and the attach route's `run:<id>`
 * use. Nothing the browser sends reaches the name: the resolver takes the run
 * record and the runner, and nothing else.
 */
describe('resolveRunShellTarget (a run\'s web-shell exec target)', () => {
  const root = '/projects/demo';
  const runner = (type: string, running: Set<string>, sandbox = true) => async () => ({
    type: type as 'docker',
    usesSandbox: () => sandbox,
    isRunning: async (name: string) => running.has(name),
  });

  test('targets the run\'s own container, named from its slug', async () => {
    const name = runContainerName(root, 'main');
    const target = await resolveRunShellTarget(root, { slug: 'main' }, runner('docker', new Set([name])));
    expect(target).toEqual({ available: true, container: name, binary: 'docker' });
  });

  test('two runs never share a target', async () => {
    const a = runContainerName(root, 'main');
    const b = runContainerName(root, 'feature-x');
    const both = new Set([a, b]);
    const ta = await resolveRunShellTarget(root, { slug: 'main' }, runner('docker', both));
    const tb = await resolveRunShellTarget(root, { slug: 'feature-x' }, runner('docker', both));
    expect(ta.available && tb.available && ta.container !== tb.container).toBe(true);
  });

  test('podman execs with podman', async () => {
    const name = runContainerName(root, 'main');
    expect(await resolveRunShellTarget(root, { slug: 'main' }, runner('podman', new Set([name]))))
      .toMatchObject({ available: true, binary: 'podman' });
  });

  test('a stopped environment is refused, not started', async () => {
    expect(await resolveRunShellTarget(root, { slug: 'main' }, runner('docker', new Set())))
      .toMatchObject({ available: false, code: 'not-running' });
  });

  test('a runner with no container is refused', async () => {
    expect(await resolveRunShellTarget(root, { slug: 'main' }, runner('host-process', new Set(), false)))
      .toMatchObject({ available: false, code: 'no-container-runner' });
  });
});
