/**
 * Unit tests: task supervisors refresh model/proxy env from the live daemon.
 *
 * INVARIANT: a container's launch env is stamped once at `docker run`. Retries
 * must re-resolve against the daemon now serving — never reuse a stale
 * `ANTHROPIC_BASE_URL` from the pre-restart generation.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import {
  applyAuthEnvToProcess,
  refreshSupervisorLaunchEnv,
  resolveSupervisorProjectRoot,
} from '../../src/supervisor/launch-env';

const CLIENT_PATH = join(import.meta.dir, '../../src/daemon/client.ts');

describe('applyAuthEnvToProcess', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  test('overwrites model env keys on the supervisor process', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1111';
    applyAuthEnvToProcess([{ key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:2222' }]);
    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:2222');
  });
});

describe('refreshSupervisorLaunchEnv', () => {
  let projectRoot: string;
  let daemonConfigPath: string;
  let proxyPort = 48001;
  const savedEnv = { ...process.env };
  const taskId = 'aabbccdd-1111-2222-3333-444455556666';

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-supervisor-launch-env-'));
    await writeFile(join(projectRoot, 'lazy.toml'), '');
    process.env.LAZY_CONFIG = join(projectRoot, 'lazy.toml');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    daemonConfigPath = join(projectRoot, 'daemon-mcp.json');
    await writeFile(
      daemonConfigPath,
      JSON.stringify({ token: 'tok', projectRoot, target: 'http://127.0.0.1:1/' }),
    );
    process.env.LAZY_DAEMON_CONFIG = daemonConfigPath;
    proxyPort = 48001;

    await mockModule(CLIENT_PATH, () => ({
      tryRpc: async (command: string) => {
        if (command !== 'getAuthEnv') return null;
        return {
          authEnvVars: [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'placeholder-tok' }],
          proxyBaseUrl: `http://127.0.0.1:${proxyPort}`,
        };
      },
      isDaemonRpcBypassed: () => false,
      NotALazyProjectError: class NotALazyProjectError extends Error {},
    }));
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await rm(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    restoreMockedModules();
  });

  test('resolveSupervisorProjectRoot reads projectRoot from LAZY_DAEMON_CONFIG', async () => {
    expect(await resolveSupervisorProjectRoot()).toBe(projectRoot);
  });

  test('re-resolves onto the restarted daemon\'s new proxy port', async () => {
    // A supervisor the daemon did NOT launch — daemonless runs and tests. With
    // no mounted config there is nothing to authenticate the route with, so the
    // ordinary RPC client is the transport. (Not "host-process": the daemon
    // mounts a config for those too — see the case below.)
    delete process.env.LAZY_DAEMON_CONFIG;
    await refreshSupervisorLaunchEnv({ taskId });
    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:48001');

    proxyPort = 48002;
    await refreshSupervisorLaunchEnv({ taskId });
    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:48002');
  });

  // INVARIANT: an in-container supervisor refreshes over GET /agent/launch-env
  // with its mounted per-task MCP token, never through the daemon RPC client.
  // That client locates the daemon through host-side port-marker and token
  // FILES, which are never mounted into a task container — so the RPC route
  // reported "Daemon is not running" against a live daemon and turned every
  // in-container retry into a fatal error naming the wrong cause.
  test('in a container, refreshes over the daemon HTTP route rather than the RPC client', async () => {
    const seen: Array<{ auth: string | null; project: string | null; path: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({
          auth: req.headers.get('authorization'),
          project: req.headers.get('x-lazy-project'),
          path: url.pathname,
        });
        return Response.json({
          authEnvVars: [
            { key: 'ANTHROPIC_BASE_URL', value: 'http://host.docker.internal:48009' },
            { key: 'ANTHROPIC_AUTH_TOKEN', value: 'placeholder-from-route' },
          ],
          proxyBaseUrl: 'http://host.docker.internal:48009',
          lazyVersion: 'test',
        });
      },
    });

    try {
      await writeFile(
        daemonConfigPath,
        JSON.stringify({ token: 'task-tok', projectRoot, target: `http://127.0.0.1:${server.port}` }),
      );
      process.env.LAZY_DAEMON_CONFIG = daemonConfigPath;

      await refreshSupervisorLaunchEnv({ taskId });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.path).toBe('/agent/launch-env');
      expect(seen[0]!.auth).toBe('Bearer task-tok');
      expect(seen[0]!.project).toBe(projectRoot);
      expect(process.env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:48009');
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder-from-route');
    } finally {
      server.stop(true);
    }
  });

  // INVARIANT: the branch is "the daemon mounted a config", not "in a
  // container". The host-process runner is handed the same config whenever the
  // daemon provides one, so a host-process supervisor takes the HTTP route too
  // — and the daemon, which knows the configured runner type, answers it with
  // the loopback spelling of the proxy address rather than the Docker alias.
  // Covered because the comments used to claim the opposite, and anyone
  // debugging a host-process turn from that premise would read the wrong code.
  test('a host-process supervisor with a mounted config takes the same HTTP route', async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname);
        return Response.json({
          // What the daemon returns for a HOST launch surface: loopback, not
          // host.docker.internal.
          authEnvVars: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:48010' }],
          proxyBaseUrl: 'http://127.0.0.1:48010',
          lazyVersion: 'test',
        });
      },
    });

    try {
      await writeFile(
        daemonConfigPath,
        JSON.stringify({ token: 'host-tok', projectRoot, target: `http://127.0.0.1:${server.port}` }),
      );
      process.env.LAZY_DAEMON_CONFIG = daemonConfigPath;

      await refreshSupervisorLaunchEnv({ taskId });

      expect(paths).toEqual(['/agent/launch-env']);
      expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:48010');
    } finally {
      server.stop(true);
    }
  });

  test('a refused refresh throws, so the retry never relaunches onto a stale proxy', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: 'task token revoked' }, { status: 401 }),
    });

    try {
      await writeFile(
        daemonConfigPath,
        JSON.stringify({ token: 'task-tok', projectRoot, target: `http://127.0.0.1:${server.port}` }),
      );
      process.env.LAZY_DAEMON_CONFIG = daemonConfigPath;

      await expect(refreshSupervisorLaunchEnv({ taskId })).rejects.toThrow(/401.*task token revoked/s);
    } finally {
      server.stop(true);
    }
  });
});
