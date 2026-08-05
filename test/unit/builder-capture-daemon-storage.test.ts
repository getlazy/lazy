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
