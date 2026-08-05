/**
 * Unit tests for the per-identity MCP token registry (src/daemon/mcp-tokens.ts).
 *
 * The e2e counterpart (test/e2e/mcp-token-identity.test.ts) proves the daemon
 * ROUTE refuses an impersonating caller. This file pins the registry the route's
 * decision rests on: one live token per identity, tokens that resolve back to
 * exactly that identity, revocation that is per task and not a global reset, and
 * survival across a daemon restart (the on-disk registry is what makes a running
 * container keep working when the daemon bounces).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import {
  mintMcpToken,
  lookupMcpIdentity,
  revokeTaskMcpTokens,
  revokeBuilderMcpToken,
  peekMcpToken,
  clearMcpTokenCache,
} from '../../src/daemon/mcp-tokens';
import { getMcpTokensPath } from '../../src/daemon/paths';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('daemon MCP token registry', () => {
  let root: string;
  let baseDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-mcp-tokens-'));
    // The registry lives in the daemon state dir — never touch the developer's.
    baseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearMcpTokenCache();
  });

  afterEach(async () => {
    clearMcpTokenCache();
    delete process.env.LAZY_DAEMON_BASE_DIR;
    await removeDaemonBaseDir(baseDir);
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: distinct identities never share a token. A shared token is
  // exactly the state this feature exists to end.
  test('mints a distinct token per identity and resolves each back', async () => {
    const a = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');
    const b = await mintMcpToken(root, { kind: 'task', taskId: 'task-b' }, 'lazy-b');
    const builder = await mintMcpToken(root, { kind: 'builder' }, 'builder-1');

    expect(new Set([a, b, builder]).size).toBe(3);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    expect(await lookupMcpIdentity(root, a)).toEqual({ kind: 'task', taskId: 'task-a' });
    expect(await lookupMcpIdentity(root, b)).toEqual({ kind: 'task', taskId: 'task-b' });
    expect(await lookupMcpIdentity(root, builder)).toEqual({ kind: 'builder' });
  });

  // INVARIANT: one LIVE token per identity. A task is unblocked many times and
  // its container is often reused; minting per turn would either invalidate a
  // live session mid-flight or leave a pile of equally-valid tokens per task.
  test('reuses the existing token for the same identity', async () => {
    const first = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');
    const second = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a-restarted');

    expect(second).toBe(first);
  });

  test('an unknown token resolves to nobody', async () => {
    await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');

    expect(await lookupMcpIdentity(root, 'f'.repeat(64))).toBeNull();
    expect(await lookupMcpIdentity(root, '')).toBeNull();
    expect(await lookupMcpIdentity(root, null)).toBeNull();
  });

  // INVARIANT: revocation is per identity. accept/reject/close end ONE session;
  // taking every other agent's credential with it would break live siblings.
  test('revoking a task leaves other identities alone', async () => {
    const a = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');
    const b = await mintMcpToken(root, { kind: 'task', taskId: 'task-b' }, 'lazy-b');
    const builder = await mintMcpToken(root, { kind: 'builder' }, 'builder-1');

    expect(await revokeTaskMcpTokens(root, 'task-a')).toBe(1);

    expect(await lookupMcpIdentity(root, a)).toBeNull();
    expect(await lookupMcpIdentity(root, b)).toEqual({ kind: 'task', taskId: 'task-b' });
    expect(await lookupMcpIdentity(root, builder)).toEqual({ kind: 'builder' });
  });

  // Revocation runs on every accept/reject/close, including for tasks that never
  // launched a container; it must not throw when there is nothing to revoke.
  test('revoking is idempotent and safe for a task that never had a token', async () => {
    await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');

    expect(await revokeTaskMcpTokens(root, 'task-a')).toBe(1);
    expect(await revokeTaskMcpTokens(root, 'task-a')).toBe(0);
    expect(await revokeTaskMcpTokens(root, 'never-launched')).toBe(0);
  });

  // INVARIANT: a builder token dies with its builder session. The human closing
  // the terminal is the only signal a builder session ended, so `lazy builder`
  // revokes by the label it minted with when the supervisor exits. Without this
  // the credential outlived the session entirely.
  test('revoking a builder session drops that builder and nothing else', async () => {
    const one = await mintMcpToken(root, { kind: 'builder' }, 'builder-1');
    const two = await mintMcpToken(root, { kind: 'builder' }, 'builder-2');
    const task = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');

    expect(await revokeBuilderMcpToken(root, 'builder-1')).toBe(1);

    expect(await lookupMcpIdentity(root, one)).toBeNull();
    // A concurrent builder in another terminal keeps working.
    expect(await lookupMcpIdentity(root, two)).toEqual({ kind: 'builder' });
    expect(await lookupMcpIdentity(root, task)).toEqual({ kind: 'task', taskId: 'task-a' });
  });

  // The exit hook is best-effort and can run twice (a relaunch-loop iteration
  // that already revoked, a retried exit path); it must never throw.
  test('revoking a builder is idempotent and safe for an unknown label', async () => {
    await mintMcpToken(root, { kind: 'builder' }, 'builder-1');

    expect(await revokeBuilderMcpToken(root, 'builder-1')).toBe(1);
    expect(await revokeBuilderMcpToken(root, 'builder-1')).toBe(0);
    expect(await revokeBuilderMcpToken(root, 'builder-never-launched')).toBe(0);
  });

  // A builder label must not be able to revoke a TASK — the two namespaces are
  // separate, and a crashing builder must never disarm a running agent.
  test('a builder revoke never touches a task token that shares its label', async () => {
    const task = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'shared-label');
    const builder = await mintMcpToken(root, { kind: 'builder' }, 'shared-label');

    expect(await revokeBuilderMcpToken(root, 'shared-label')).toBe(1);

    expect(await lookupMcpIdentity(root, builder)).toBeNull();
    expect(await lookupMcpIdentity(root, task)).toEqual({ kind: 'task', taskId: 'task-a' });
  });

  // INVARIANT: tokens survive a daemon restart. The shared token was deliberately
  // reused across restarts so running containers stay valid; per-identity tokens
  // must keep that property, which is why the registry is on disk and re-read.
  test('a token minted before a restart still resolves after one', async () => {
    const a = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');

    clearMcpTokenCache(); // a fresh daemon process has an empty cache

    expect(await lookupMcpIdentity(root, a)).toEqual({ kind: 'task', taskId: 'task-a' });
    expect(await peekMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a')).toBe(a);
  });

  // A token minted by ANOTHER process (the CLI falling back to in-process
  // handlers, a test harness) must not be reported as forged just because this
  // process's cache predates it — hence the re-read on a cache miss.
  test('a cache miss re-reads the registry before answering "unknown"', async () => {
    const a = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');
    // Populate the cache, then append a record behind its back.
    expect(await lookupMcpIdentity(root, a)).not.toBeNull();

    const path = getMcpTokensPath(root);
    const registry = JSON.parse(await readFile(path, 'utf-8'));
    registry.tokens.push({
      token: 'e'.repeat(64), kind: 'task', taskId: 'task-z', label: 'lazy-z',
      createdAt: new Date().toISOString(),
    });
    await writeFile(path, JSON.stringify(registry));

    expect(await lookupMcpIdentity(root, 'e'.repeat(64))).toEqual({ kind: 'task', taskId: 'task-z' });
  });

  // These are bearer credentials, and the daemon state dir is the ONLY place
  // they may live: task containers mount the repo read-only, so an in-repo token
  // would be readable by every other agent.
  test('the registry is written 0600 inside the daemon state dir', async () => {
    await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');

    const path = getMcpTokensPath(root);
    expect(path.startsWith(baseDir)).toBe(true);
    expect(path.startsWith(root)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  // INVARIANT: a corrupt registry must NOT be silently treated as empty —
  // that would revoke every running agent with no explanation. Fail loud, and
  // say how to recover.
  test('a corrupt registry fails loudly with a recovery instruction', async () => {
    const path = getMcpTokensPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not json{');
    clearMcpTokenCache();

    await expect(lookupMcpIdentity(root, 'a'.repeat(64))).rejects.toThrow(/not valid JSON/);
    await expect(lookupMcpIdentity(root, 'a'.repeat(64))).rejects.toThrow(/Delete the file/);
  });
});
