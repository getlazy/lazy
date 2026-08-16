/**
 * Regression tests: the builder supervisor must persist captured conversations
 * through the DAEMON when running in daemon-proxy (container) mode — never via a
 * direct in-container FileStorage.
 *
 * WHY (the bug this guards): the supervisor runs inside the builder container.
 * The configured storage backend's path (e.g. an `external_path` outside the
 * repo) is NOT mounted there, so a direct FileStorage silently writes every
 * captured conversation to the container's ephemeral filesystem and loses it on
 * `--rm`. Builder conversations are the builder's long-term memory — losing them
 * is a context-loss bug. The container CAN reach the daemon over its TCP web
 * server (the daemon MCP config's `target`), which owns the real host store, so
 * capture routes through the daemon exactly like agent tasks do.
 *
 * These are pure/unit checks of the two load-bearing seams (TCP-vs-unix request
 * building, and daemon-vs-local factory selection). The full builder loop needs
 * docker + an authenticated Claude + a running daemon and cannot run here.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildDaemonRpcRequest } from '../../src/daemon/client';
import { buildBuilderStorageFactory } from '../../src/supervisor/builder';
import {
  BUILDER_STORAGE_METHODS,
  STORAGE_METHODS,
  handleBuilderStorageCall,
} from '../../src/daemon/rpc-handlers';
import type { Storage } from '../../src/storage/interface';

describe('buildDaemonRpcRequest — unix vs TCP transport', () => {
  // INVARIANT: a container reaches the daemon over TCP; only the host uses the
  // unix socket. Getting this branch wrong is exactly what stranded builder
  // capture writes in an unreachable/ephemeral place.
  test('TCP target builds an absolute URL and NO unix option', () => {
    const { url, options } = buildDaemonRpcRequest(
      'http://host.docker.internal:26024',
      'tok-123',
      'storage',
      '/repo',
      { method: 'saveConversation', args: {} },
    );
    expect(url).toBe('http://host.docker.internal:26024/rpc/storage');
    expect(options.unix).toBeUndefined();
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['X-Lazy-Project']).toBe('/repo');
    expect(options.body).toBe(JSON.stringify({ method: 'saveConversation', args: {} }));
  });

  test('unix socket target routes through the socket path', () => {
    const { url, options } = buildDaemonRpcRequest(
      '/home/user/.lazy/daemon/lazy.sock',
      'tok-123',
      'storage',
      '/repo',
      {},
    );
    expect(url).toBe('http://localhost/rpc/storage');
    expect(options.unix).toBe('/home/user/.lazy/daemon/lazy.sock');
  });

  // INVARIANT: the route family is a property of the CREDENTIAL, not of the
  // caller's intent. A builder container holds a per-identity MCP token, which
  // /rpc/* refuses by design — so its storage calls must land on /builder/*.
  // Routing them at /rpc/* is the 401-every-30-seconds bug this fixes; the
  // alternative "fixes" (ship the shared token into the container, or teach
  // /rpc/* to accept MCP tokens) both widen a deliberate boundary.
  test('routePrefix "builder" targets /builder/storage over TCP', () => {
    const { url } = buildDaemonRpcRequest(
      'http://host.docker.internal:26024',
      'builder-mcp-token',
      'storage',
      '/repo',
      { method: 'saveConversation', args: {} },
      'builder',
    );
    expect(url).toBe('http://host.docker.internal:26024/builder/storage');
  });

  test('routePrefix "builder" targets /builder/storage over the unix socket too', () => {
    const { url, options } = buildDaemonRpcRequest(
      '/home/user/.lazy/daemon/lazy.sock',
      'builder-mcp-token',
      'storage',
      '/repo',
      {},
      'builder',
    );
    expect(url).toBe('http://localhost/builder/storage');
    expect(options.unix).toBe('/home/user/.lazy/daemon/lazy.sock');
  });

  test('the default prefix stays "rpc" — existing daemon-token callers are unchanged', () => {
    const { url } = buildDaemonRpcRequest('http://127.0.0.1:26024', 't', 'list', '/repo', {});
    expect(url).toBe('http://127.0.0.1:26024/rpc/list');
  });
});

describe('BUILDER_STORAGE_METHODS — the capture allowlist', () => {
  // INVARIANT: a builder container may call FOUR storage methods. The list is
  // the security boundary of the /builder/storage surface: everything on it is
  // something the SUPERVISOR does on the human's behalf (persist this session's
  // conversation, stamp/read its own resume intent). Widening it widens what a
  // compromised builder container can do to the store — give a new caller its
  // own surface instead of adding an entry here.
  test('contains exactly the four capture methods', () => {
    expect([...BUILDER_STORAGE_METHODS].sort()).toEqual([
      'getStoragePath',
      'listBuilderResumeIntents',
      'saveBuilderResumeIntent',
      'saveConversation',
    ]);
  });

  test('every allowlisted method actually exists on the full storage surface', () => {
    for (const method of BUILDER_STORAGE_METHODS) {
      expect(STORAGE_METHODS[method]).toBeDefined();
    }
  });

  test('a non-allowlisted method is refused with 403, before any storage is opened', async () => {
    await expect(
      handleBuilderStorageCall('/repo', { method: 'saveTask', args: {} }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('a missing method is a 400', async () => {
    await expect(
      handleBuilderStorageCall('/repo', { args: {} }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('buildBuilderStorageFactory — daemon vs local selection', () => {
  let daemonConfigPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-builder-storage-'));
    daemonConfigPath = join(dir, 'daemon-mcp.json');
  });

  afterEach(async () => {
    await rm(join(daemonConfigPath, '..'), { recursive: true, force: true });
  });

  test('no daemonConfigPath → falls back to the injected local factory', async () => {
    const sentinel = {} as Storage;
    let called = false;
    const createStorage = async (): Promise<Storage> => {
      called = true;
      return sentinel;
    };

    const factory = buildBuilderStorageFactory(undefined, createStorage);
    const result = await factory('/repo');

    expect(called).toBe(true);
    expect(result).toBe(sentinel);
  });

  test('daemonConfigPath present → routes through the daemon, NOT local FileStorage', async () => {
    // A valid daemon config pointing at a TCP target with no daemon listening.
    await writeFile(
      daemonConfigPath,
      JSON.stringify({
        token: 'tok',
        projectRoot: '/repo',
        taskId: '',
        target: 'http://127.0.0.1:1', // unroutable — connection will fail
      }),
    );

    let localCalled = false;
    const createStorage = async (): Promise<Storage> => {
      localCalled = true;
      return {} as Storage;
    };

    const factory = buildBuilderStorageFactory(daemonConfigPath, createStorage);

    // It must attempt the daemon (getStoragePath probe) and fail on transport —
    // proving it did NOT silently fall back to an in-container FileStorage.
    await expect(factory('/repo')).rejects.toThrow();
    expect(localCalled).toBe(false);
  });
});
