import { describe, test, expect, afterEach } from 'bun:test';
import { resolveDockerSocketPath } from '../../src/runner/docker-exec-stream';

/**
 * resolveDockerSocketPath mirrors the CLI's socket resolution from outside it.
 * The security-relevant branch is the non-unix DOCKER_HOST hard error: silently
 * guessing a local socket for a tcp:// or ssh:// engine would exec into the
 * WRONG host. That must fail loudly, never fall through to /var/run/docker.sock.
 */
describe('resolveDockerSocketPath', () => {
  const savedDockerHost = process.env.DOCKER_HOST;

  afterEach(() => {
    if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = savedDockerHost;
  });

  test('returns the path from a unix:// DOCKER_HOST verbatim', async () => {
    process.env.DOCKER_HOST = 'unix:///tmp/custom-docker.sock';
    expect(await resolveDockerSocketPath()).toBe('/tmp/custom-docker.sock');
  });

  test('accepts a bare absolute path as a unix socket', async () => {
    process.env.DOCKER_HOST = '/tmp/bare-docker.sock';
    expect(await resolveDockerSocketPath()).toBe('/tmp/bare-docker.sock');
  });

  // INVARIANT: a tcp:// DOCKER_HOST is a HARD ERROR — the web shell streams over
  // a local unix socket only, and guessing a socket for a remote engine would
  // exec into the wrong host. Must throw, never fall through to conventional paths.
  test('throws for a tcp:// DOCKER_HOST rather than guessing a local socket', async () => {
    process.env.DOCKER_HOST = 'tcp://192.168.0.10:2375';
    await expect(resolveDockerSocketPath()).rejects.toThrow(/non-unix endpoint/);
  });

  test('throws for an ssh:// DOCKER_HOST', async () => {
    process.env.DOCKER_HOST = 'ssh://user@remote';
    await expect(resolveDockerSocketPath()).rejects.toThrow(/non-unix endpoint/);
  });
});
