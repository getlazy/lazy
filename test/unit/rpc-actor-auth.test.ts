/**
 * Unit tests for `/rpc/*` actor resolution (src/daemon/rpc-auth.ts) and the two
 * actor kinds the token registry gained (src/daemon/actor-tokens.ts).
 *
 * The e2e counterpart (test/e2e/daemon-actor-tokens.test.ts) proves the daemon
 * ROUTE behaves; this file pins the decision that route rests on — above all
 * that the legacy shared token resolves to `control` (single-user installs are
 * unaffected) and that the two token populations stay disjoint in BOTH
 * directions: an agent's MCP token is refused here, an actor token is refused
 * on the MCP surface.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mintDaemonToken,
  lookupDaemonIdentity,
  revokeDaemonTokens,
  clearDaemonTokenCache,
} from '../../src/daemon/actor-tokens';
import { mintMcpToken, lookupMcpIdentity } from '../../src/daemon/mcp-tokens';
import { resolveRpcActor, bearerToken, rpcAuthErrorMessage, describeActor } from '../../src/daemon/rpc-auth';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

const SHARED = 'shared-daemon-token';

describe('rpc actor authentication', () => {
  let root: string;
  let baseDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-actor-tokens-'));
    baseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearDaemonTokenCache();
  });

  afterEach(async () => {
    clearDaemonTokenCache();
    delete process.env.LAZY_DAEMON_BASE_DIR;
    await removeDaemonBaseDir(baseDir);
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT — THE BACK-COMPAT REQUIREMENT. The legacy shared token is the
  // control plane on a single-user install. Every existing CLI, supervisor and
  // script presents it and must keep the reach it has always had.
  test('the legacy shared token resolves to the control actor', async () => {
    const result = await resolveRpcActor(root, SHARED, `Bearer ${SHARED}`);

    expect(result).toEqual({ ok: true, actor: { kind: 'control' }, legacyShared: true });
  });

  // A user token is a MANAGED-MODE credential. It used to resolve on any
  // install; git-identity-single-person narrowed that deliberately (see the
  // refusal test below and
  // docs/design/actor-identity-and-remote-clients.md §3.4), so this case now
  // arms managed mode to reach the behaviour it has always asserted.
  test('a minted user token resolves to that user (managed mode)', async () => {
    process.env.LAZY_MANAGED = '1';
    try {
      const token = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada');

      const result = await resolveRpcActor(root, SHARED, `Bearer ${token}`);

      expect(result).toEqual({
        ok: true,
        actor: { kind: 'user', email: 'ada@example.com', name: 'Ada' },
        legacyShared: false,
      });
    } finally {
      delete process.env.LAZY_MANAGED;
    }
  });

  // INVARIANT: outside managed mode, identity is the daemon's environment and a
  // request never carries one. A user token is the OTHER way identity could
  // arrive, and on a laptop nothing mints one and nothing presents one — so the
  // path is closed rather than left open and never exercised. The refusal is
  // its own reason (not "unknown"): the token is real, and the caller needs to
  // hear that this install does not take per-user tokens at all.
  test('a user token is refused outside managed mode', async () => {
    process.env.LAZY_MANAGED = '1';
    let token: string;
    try {
      token = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada');
    } finally {
      delete process.env.LAZY_MANAGED;
    }

    const result = await resolveRpcActor(root, SHARED, `Bearer ${token}`);

    expect(result).toEqual({ ok: false, failure: { reason: 'user-token-unmanaged' } });
    expect(rpcAuthErrorMessage({ reason: 'user-token-unmanaged' })).toContain('managed-mode');
  });

  test('a minted control token resolves to control without being the shared one', async () => {
    const token = await mintDaemonToken(root, { kind: 'control' }, 'rails');
    expect(token).not.toBe(SHARED);

    const result = await resolveRpcActor(root, SHARED, `Bearer ${token}`);

    expect(result).toEqual({ ok: true, actor: { kind: 'control' }, legacyShared: false });
  });

  // INVARIANT: an agent's MCP token authenticates POST /mcp/* and nothing else.
  // Distinguished from "unknown" because the caller holds a VALID credential and
  // is using the wrong endpoint — the fix is completely different, and a bare
  // "Unauthorized" would send them looking for a revoked token.
  test('an MCP session token is refused, and told why', async () => {
    const taskToken = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');
    const builderToken = await mintMcpToken(root, { kind: 'builder' }, 'builder-1');

    for (const token of [taskToken, builderToken]) {
      const result = await resolveRpcActor(root, SHARED, `Bearer ${token}`);
      expect(result).toEqual({ ok: false, failure: { reason: 'mcp-token' } });
      expect(rpcAuthErrorMessage({ reason: 'mcp-token' })).toContain('MCP session token');
    }
  });

  // The mirror of the rule above: an actor token must never authenticate as an
  // agent, or a human's credential could act as some task's agent — the exact
  // impersonation per-identity MCP tokens exist to prevent, from the other side.
  test('an actor token is refused on the MCP surface', async () => {
    const userToken = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada');
    const controlToken = await mintDaemonToken(root, { kind: 'control' }, 'rails');

    expect(await lookupMcpIdentity(root, userToken)).toBeNull();
    expect(await lookupMcpIdentity(root, controlToken)).toBeNull();
  });

  test('a missing, malformed, or unknown token is refused as unauthorized', async () => {
    expect(await resolveRpcActor(root, SHARED, null)).toEqual({ ok: false, failure: { reason: 'missing' } });
    expect(await resolveRpcActor(root, SHARED, '')).toEqual({ ok: false, failure: { reason: 'missing' } });
    expect(await resolveRpcActor(root, SHARED, SHARED)).toEqual({ ok: false, failure: { reason: 'missing' } });
    expect(await resolveRpcActor(root, SHARED, 'Bearer nope')).toEqual({ ok: false, failure: { reason: 'unknown' } });

    // Both keep the pre-existing wording: a caller with no valid credential
    // learns nothing about which tokens exist.
    expect(rpcAuthErrorMessage({ reason: 'missing' })).toBe('Unauthorized');
    expect(rpcAuthErrorMessage({ reason: 'unknown' })).toBe('Unauthorized');
  });

  test('bearerToken parses only the Bearer form', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  // INVARIANT: revocation is per identity here too — revoking one user must not
  // disturb another user, the control plane, or a running agent.
  test('revoking a user leaves every other identity alone', async () => {
    const ada = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada');
    const grace = await mintDaemonToken(root, { kind: 'user', email: 'grace@example.com', name: 'Grace' }, 'Grace');
    const control = await mintDaemonToken(root, { kind: 'control' }, 'rails');
    const agent = await mintMcpToken(root, { kind: 'task', taskId: 'task-a' }, 'lazy-a');

    expect(await revokeDaemonTokens(root, { kind: 'user', email: 'ada@example.com' })).toBe(1);

    expect(await lookupDaemonIdentity(root, ada)).toBeNull();
    expect(await lookupDaemonIdentity(root, grace)).toEqual({ kind: 'user', email: 'grace@example.com', name: 'Grace' });
    expect(await lookupDaemonIdentity(root, control)).toEqual({ kind: 'control' });
    expect(await lookupDaemonIdentity(root, agent)).toEqual({ kind: 'task', taskId: 'task-a' });
  });

  // A user's token rotates (session expiry, a leak) without re-minting their
  // identity. The old secret must stop working the moment the new one exists.
  test('rotating a user token replaces the secret', async () => {
    const first = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada');
    const same = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada');
    expect(same).toBe(first);

    const rotated = await mintDaemonToken(root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }, 'Ada', { rotate: true });

    expect(rotated).not.toBe(first);
    expect(await lookupDaemonIdentity(root, first)).toBeNull();
    expect(await lookupDaemonIdentity(root, rotated)).toEqual({ kind: 'user', email: 'ada@example.com', name: 'Ada' });
  });

  // Control tokens have no id of their own, so the LABEL is the identity: two
  // control clients sharing a label would share a token, and revoking one would
  // silently revoke the other.
  test('control tokens are keyed by label', async () => {
    const rails = await mintDaemonToken(root, { kind: 'control' }, 'rails');
    const ops = await mintDaemonToken(root, { kind: 'control' }, 'ops-script');
    expect(rails).not.toBe(ops);

    expect(await revokeDaemonTokens(root, { kind: 'control', label: 'rails' })).toBe(1);

    expect(await lookupDaemonIdentity(root, rails)).toBeNull();
    expect(await lookupDaemonIdentity(root, ops)).toEqual({ kind: 'control' });
  });

  // Log lines and error messages describe actors; a token in either would be a
  // credential leak into files the user pastes into bug reports.
  test('describeActor never echoes a token', () => {
    expect(describeActor({ kind: 'control' })).toBe('control');
    expect(describeActor({ kind: 'user', email: 'ada@example.com', name: 'Ada' }))
      .toBe('user Ada <ada@example.com>');
    // A token minted with no display name describes by address alone, rather
    // than rendering an empty pair of angle brackets.
    expect(describeActor({ kind: 'user', email: 'ada@example.com' })).toBe('user ada@example.com');
  });
});
