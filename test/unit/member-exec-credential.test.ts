/**
 * The credential a member's own terminal container runs on
 * (src/server/member-exec-credential.ts), on a team-mode daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import {
  clearSessionCredentialCache,
  getTaskSessionBinding,
  lookupSessionBinding,
} from '../../src/daemon/session-credentials';
import { NO_OWNER_CREDENTIAL_MARKER, sessionCredentialEnvFor } from '../../src/daemon/turn-credentials';
import {
  planMemberContainerCredential,
  memberExecBindingKey,
  MEMBER_EXEC_CREDENTIAL_KEYS,
  revokeLeftoverMemberTerminalCredentials,
} from '../../src/server/member-exec-credential';
import { bindTurnCredential } from '../../src/daemon/session-credentials';
import { mintCredentialGrant, lookupCredentialGrant, clearCredentialGrantCache } from '../../src/proxy/credential-broker';

const TASK = '11111111-2222-3333-4444-555555555555';

describe('member terminal credential', () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let prevLazyTest: string | undefined;

  beforeEach(async () => {
    // The daemon-self RPC bypass: no live daemon (and so no proxy address) here.
    prevLazyTest = process.env.LAZY_TEST;
    process.env.LAZY_TEST = '1';
    root = await mkdtemp(join(tmpdir(), 'member-exec-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-member-exec-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();
    // Team mode: some member has a credential stored.
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' } as never);
  });

  afterEach(async () => {
    if (prevLazyTest === undefined) delete process.env.LAZY_TEST;
    else process.env.LAZY_TEST = prevLazyTest;
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: a member container's binding is keyed per container, never by
  // the task id — sharing the task's key would re-point (or, on release,
  // revoke) the placeholder of the task's own turns.
  test('the binding key is never the task id', () => {
    const key = memberExecBindingKey(TASK);
    expect(key).not.toBe(TASK);
    expect(key.startsWith(`member-exec:${TASK}:`)).toBe(true);
    expect(memberExecBindingKey(TASK)).not.toBe(key);
  });

  // INVARIANT: the member's container carries a placeholder bound to THEM and
  // nothing else — every other credential variable is set empty, so an image
  // that bakes one in cannot put it beside theirs — the task's own turn
  // binding is untouched (a turn container never reads a member's), and
  // removing the container revokes it.
  test("carries only the member's own placeholder, and revokes on release", async () => {
    const planned = await planMemberContainerCredential({
      root, taskId: TASK, sessionId: 's1', memberEmail: 'alice@example.com', container: 'lazymember-t-1',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok || !planned.credential) throw new Error('expected a credential overlay in team mode');
    const env = planned.credential.env;
    const apiKey = env.find((e) => e.key === 'ANTHROPIC_API_KEY')!.value;
    expect(env).toContainEqual({ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' });
    for (const key of MEMBER_EXEC_CREDENTIAL_KEYS) expect(env.some((e) => e.key === key)).toBe(true);
    // The session placeholder itself — not a JIT grant over some other value.
    expect(apiKey.startsWith('lazy-sess-')).toBe(true);

    const bound = await lookupSessionBinding(root, apiKey);
    expect(bound?.ownerUserId).toBe('alice@example.com');
    // The task's own binding is untouched.
    expect(await getTaskSessionBinding(root, TASK)).toBeNull();

    await planned.credential.release();
    expect(await lookupSessionBinding(root, apiKey)).toBeNull();
  });

  // INVARIANT: a member's terminal spends the MEMBER's credential whatever the
  // project's profiles say. A profile that names its own credential is
  // resolved ahead of the member's placeholder by the launch-env builder, so
  // resolving any configured profile here once let a member's `claude` spend
  // the project's key under their name.
  test("a configured profile naming its own credential never replaces the member's", async () => {
    await writeFile(join(root, 'lazy.toml'), [
      '[agents.claude-code]',
      'harness = "claude-code"',
      'credential = "project-anthropic-key"',
      '',
    ].join('\n'));
    const planned = await planMemberContainerCredential({
      root, taskId: TASK, sessionId: 's1', memberEmail: 'alice@example.com', container: 'lazymember-t-1',
    });
    if (!planned.ok) throw new Error(`expected the member's credential, got: ${planned.message}`);
    const apiKey = planned.credential.env.find((e) => e.key === 'ANTHROPIC_API_KEY')!.value;
    expect((await lookupSessionBinding(root, apiKey))?.ownerUserId).toBe('alice@example.com');
    expect(planned.credential.env.find((e) => e.key === 'ANTHROPIC_AUTH_TOKEN')?.value).toBe('');
    await planned.credential.release();
  });

  // INVARIANT: a member's placeholder never reaches a turn's container. A
  // task container is launched with exactly what `sessionCredentialEnvFor`
  // answers for the TASK — the member's binding lives under a key of its own
  // and is never that answer, before or after the task's own turn binds.
  test("no turn container is ever launched with the member's placeholder", async () => {
    const planned = await planMemberContainerCredential({
      root, taskId: TASK, sessionId: 's1', memberEmail: 'alice@example.com', container: 'lazymember-t-1',
    });
    if (!planned.ok) throw new Error(planned.message);
    const memberValue = planned.credential.env.find((e) => e.key === 'ANTHROPIC_API_KEY')!.value;

    const beforeTurn = await sessionCredentialEnvFor(root, TASK);
    expect(beforeTurn?.map((v) => v.value)).not.toContain(memberValue);

    const turn = await bindTurnCredential(root, { taskId: TASK, sessionId: 's1', ownerUserId: 'alice@example.com', kind: 'api-key' });
    const forTurn = await sessionCredentialEnvFor(root, TASK);
    expect(forTurn).toEqual([{ key: 'ANTHROPIC_API_KEY', value: turn.token }]);
    expect(turn.token).not.toBe(memberValue);
    await planned.credential.release();
  });

  test('a member with no stored credential is refused in the shape Teams recognises', async () => {
    const planned = await planMemberContainerCredential({
      root, taskId: TASK, sessionId: 's1', memberEmail: 'bob@example.com', container: 'lazymember-t-1',
    });
    expect(planned).toMatchObject({ ok: false, status: 400 });
    if (!planned.ok) expect(planned.message).toContain(NO_OWNER_CREDENTIAL_MARKER);
  });
});

// INVARIANT: per-user billing never falls back silently. On a shared daemon
// outside team mode — a managed project where no member has stored a
// credential, so the only one is the daemon's own — a member's terminal is
// REFUSED with the marker Teams turns into "connect your Claude account",
// never handed the daemon's (service) credential.
// INVARIANT: no member's placeholder keeps spending after their session —
// including across a daemon restart, which cuts short the removal that
// normally revokes a member container's credential (every Teams fleet roll
// restarts every daemon). The startup sweep revokes every member container's
// binding and grant, and nothing else.
describe('member terminal credentials across a daemon restart', () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let prevLazyTest: string | undefined;

  beforeEach(async () => {
    prevLazyTest = process.env.LAZY_TEST;
    process.env.LAZY_TEST = '1';
    root = await mkdtemp(join(tmpdir(), 'member-exec-restart-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-member-exec-restart-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();
    clearCredentialGrantCache();
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' } as never);
  });

  afterEach(async () => {
    if (prevLazyTest === undefined) delete process.env.LAZY_TEST;
    else process.env.LAZY_TEST = prevLazyTest;
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    clearCredentialGrantCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test("a terminal's binding and grant left live by a dead daemon stop resolving at the next startup", async () => {
    const planned = await planMemberContainerCredential({
      root, taskId: TASK, sessionId: 's1', memberEmail: 'alice@example.com', container: 'lazymember-t-1',
    });
    if (!planned.ok || !planned.credential) throw new Error('expected a member credential');
    const placeholder = planned.credential.env.find((e) => e.key === 'ANTHROPIC_API_KEY')!.value;
    const memberGrant = await mintCredentialGrant(root, {
      role: 'builder', taskId: TASK, label: 'member-terminal:alice@example.com:lazymember-t-1', envKey: 'CURSOR_API_KEY',
    });
    // Unrelated credentials the sweep must leave alone: the task's own turn
    // binding and a builder session's grant.
    const turn = await bindTurnCredential(root, { taskId: TASK, sessionId: 's1', ownerUserId: 'alice@example.com', kind: 'api-key' });
    const builderGrant = await mintCredentialGrant(root, {
      role: 'builder', taskId: null, label: 'member-builder:alice@example.com:b1', envKey: 'CURSOR_API_KEY',
    });

    // The daemon dies: the terminal's close handler never runs. A new one starts.
    clearSessionCredentialCache();
    clearCredentialGrantCache();
    expect(await lookupSessionBinding(root, placeholder)).not.toBeNull();
    const swept = await revokeLeftoverMemberTerminalCredentials(root);

    expect(swept).toEqual({ bindings: 1, grants: 1 });
    expect(await lookupSessionBinding(root, placeholder)).toBeNull();
    expect(await lookupCredentialGrant(root, memberGrant)).toBeNull();
    expect(await lookupSessionBinding(root, turn.token)).not.toBeNull();
    expect(await lookupCredentialGrant(root, builderGrant)).not.toBeNull();
  });
});

describe('member terminal credential outside team mode', () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let prevLazyTest: string | undefined;

  beforeEach(async () => {
    prevLazyTest = process.env.LAZY_TEST;
    process.env.LAZY_TEST = '1';
    root = await mkdtemp(join(tmpdir(), 'member-exec-noteam-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-member-exec-noteam-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    if (prevLazyTest === undefined) delete process.env.LAZY_TEST;
    else process.env.LAZY_TEST = prevLazyTest;
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test("is refused, naming how to add one, instead of running on the daemon's credential", async () => {
    const planned = await planMemberContainerCredential({
      root, taskId: TASK, sessionId: 's1', memberEmail: 'alice@example.com', container: 'lazymember-t-1',
    });
    expect(planned).toMatchObject({ ok: false, status: 400 });
    if (!planned.ok) {
      expect(planned.message.startsWith(NO_OWNER_CREDENTIAL_MARKER)).toBe(true);
      expect(planned.message).toContain('Connect your Claude account');
    }
  });
});

// INVARIANT: the sweep runs at daemon startup, before the reconcile loop — a
// function nobody calls protects nothing.
test('the daemon runs the member-terminal sweep at startup', async () => {
  const { readFile } = await import('fs/promises');
  const src = await readFile(join(import.meta.dir, '../../src/daemon/server.ts'), 'utf-8');
  const sweep = src.indexOf('await revokeLeftoverMemberTerminalCredentials(projectRoot)');
  const loop = src.indexOf('startDaemonReconcileLoop(projectRoot');
  expect(sweep).toBeGreaterThan(-1);
  expect(sweep).toBeLessThan(loop);
});
