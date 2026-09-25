/**
 * `[serve]` at the argv seam: the declared ports have to reach the container's
 * CREATE command, because that is the only moment a published port can be set —
 * neither docker nor podman can add a mapping to a running container.
 */

import { describe, test, expect } from 'bun:test';
import { buildSupervisorDockerArgs } from '../../src/capture/claude';
import { buildPublishArgs } from '../../src/serve/ports';

function argsWith(publishArgs: string[]): string[] {
  return buildSupervisorDockerArgs({
    binary: 'docker',
    containerName: 'lazy-task-1',
    imageName: 'lazy-runner:test',
    repoRoot: '/repo',
    sandbox: { permission_mode: 'bypass' } as never,
    protocolDir: '/protocol',
    agentBinaryPath: '/usr/local/bin/lazy-agent',
    authEnvVars: [],
    customMountArgs: [],
    gitMountArgs: [],
    publishArgs,
    runArgs: [],
    taskEnvArgs: [],
    wrapperScript: 'echo hi',
  });
}

describe('[serve] publish args in the container create argv', () => {
  test('declared ports are published to ephemeral loopback host ports', () => {
    const args = argsWith(buildPublishArgs([{ name: 'web', port: 3000 }, { name: 'vite', port: 5173 }]));
    const joined = args.join(' ');
    expect(joined).toContain('-p 127.0.0.1:0:3000');
    expect(joined).toContain('-p 127.0.0.1:0:5173');
  });

  // INVARIANT: loopback only. A task's dev server is for the person driving the
  // task, not for the network the machine happens to be on — the same bind
  // posture the daemon itself uses. Port 0 (OS-assigned) is what makes parallel
  // tasks declaring the same container port unable to collide.
  test('never publishes off-loopback or on a fixed host port', () => {
    const args = argsWith(buildPublishArgs([{ name: 'web', port: 3000 }]));
    expect(args.join(' ')).not.toContain('0.0.0.0');
    expect(args.join(' ')).not.toContain('3000:3000');
  });

  test('publish args come before the image name — docker flags must precede it', () => {
    const args = argsWith(buildPublishArgs([{ name: 'web', port: 3000 }]));
    expect(args.indexOf('127.0.0.1:0:3000')).toBeLessThan(args.indexOf('lazy-runner:test'));
  });

  // INVARIANT: a project with no [serve] section launches exactly as it did
  // before this feature existed. Publishing is opt-in, and opting out must cost
  // nothing — not even an extra argument.
  test('no [serve] leaves the argv byte-identical', () => {
    expect(argsWith(buildPublishArgs([]))).toEqual(argsWith([]));
    expect(argsWith([]).join(' ')).not.toContain('-p ');
  });
});
