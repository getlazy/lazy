import { describe, test, expect } from 'bun:test';
import { containerRuntimeUnavailable } from '../../src/agent/binary-identity';

describe('container selfcheck: runtime unavailable', () => {
  // INVARIANT: a container selfcheck that could not run says nothing about the
  // binary, whether the runtime's client is missing or installed with no engine
  // behind it. A docker client with no socket (an agent container, Docker
  // Desktop stopped) used to fail `lazy upgrade` on a binary whose bytes passed.
  test('a missing client is unavailable', () => {
    expect(containerRuntimeUnavailable("spawn failed: binary 'docker' not found")).toBe(true);
    expect(containerRuntimeUnavailable("spawn failed: binary 'podman' not found")).toBe(true);
  });

  test('a client whose engine does not answer is unavailable', () => {
    expect(containerRuntimeUnavailable(
      'container selfcheck in lazy-runner:0.93 via docker, binding /x to /usr/local/bin/lazy-agent: selfcheck failed ' +
      '(exit 1, stdout: <empty>, stderr: failed to connect to the docker API at unix:///var/run/docker.sock; ' +
      'check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory)',
    )).toBe(true);
    expect(containerRuntimeUnavailable(
      'stderr: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    )).toBe(true);
  });

  test('a probe that ran and rejected the binary is not', () => {
    expect(containerRuntimeUnavailable(
      'container selfcheck in lazy-runner:0.93 via docker: selfcheck failed (exit 127, stderr: Script not found "builder")',
    )).toBe(false);
  });
});
