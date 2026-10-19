/**
 * A Lazy Teams project that runs with no service credential and no Claude
 * credential anywhere — the Codex-only shape — and the launches BESIDE a task
 * (one-shots, a member's builder) that must bill the person who asked for them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  putUserCredential,
  clearUserCredentialCache,
  getServiceHolder,
  teamModeEnabled,
  SERVICE_CREDENTIAL_USER_ID,
} from '../../src/daemon/user-credentials';
import { clearSessionCredentialCache, bindTurnCredential } from '../../src/daemon/session-credentials';
import { TurnCredentialUnavailableError } from '../../src/daemon/turn-credentials';
import { withOneshotCredential, oneshotCredentialProblem } from '../../src/daemon/oneshot-credential';
import { mintCredentialGrant, lookupCredentialGrant, revokeGrantsByBindingKey } from '../../src/proxy/credential-broker';
import { resolveMemberCredential } from '../../src/proxy/credential-deps';
import { resolveSystemIdentity } from '../../src/identity/system-identity';
import { runAsOneshotPayer, withOneshotPayment } from '../../src/oneshot';
import { lookupSessionBinding } from '../../src/daemon/session-credentials';
import { loadConfig } from '../../src/config/loader';

const ALICE = 'alice@example.com';

describe('Teams with no service credential', () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let savedManaged: string | undefined;
  let savedStorage: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-no-service-cred-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-no-service-cred-base-'));
    unpin = pinDaemonBaseDir(base);
    savedManaged = process.env.LAZY_TEST_FORCE_MANAGED;
    savedStorage = process.env.LAZY_MANAGED_STORAGE_PATH;
    delete process.env.LAZY_TEST_FORCE_MANAGED;
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    unpin();
    if (savedManaged === undefined) delete process.env.LAZY_TEST_FORCE_MANAGED;
    else process.env.LAZY_TEST_FORCE_MANAGED = savedManaged;
    if (savedStorage === undefined) delete process.env.LAZY_MANAGED_STORAGE_PATH;
    else process.env.LAZY_MANAGED_STORAGE_PATH = savedStorage;
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: a managed (Lazy Teams) daemon bills per person from its first
  // moment. Deriving team mode from the store alone left a fresh project — no
  // member credential pushed yet — spending whatever credential the daemon was
  // seeded with, which on a Teams host is the registrant's or the host's.
  test('a managed daemon is in team mode before any credential is pushed', async () => {
    expect(await teamModeEnabled(root)).toBe(false);
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    expect(await teamModeEnabled(root)).toBe(true);
  });

  // INVARIANT: a one-shot a member asks for is paid by THAT member — never the
  // service holder, never the daemon's own credential.
  test('a one-shot is bound to the member who asked, not the service holder', async () => {
    await putUserCredential(root, { userId: ALICE, kind: 'api-key', token: 'sk-ant-alice' });
    await putUserCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'api-key', token: 'sk-ant-service' });
    const { lookupSessionBinding } = await import('../../src/daemon/session-credentials');
    await withOneshotCredential(root, 'test', ALICE, async (env) => {
      const binding = await lookupSessionBinding(root, env![0]!.value);
      expect(binding?.ownerUserId).toBe(ALICE);
    });
  });

  // INVARIANT: with nobody able to pay, a one-shot is REFUSED naming what is
  // missing — it never falls back to another person's or the daemon's account.
  test('a member with only a non-Claude credential is refused a Claude-only one-shot, by name', async () => {
    await putUserCredential(root, {
      userId: ALICE, profile: 'codex', kind: 'api-key', token: 'sk-openai-alice', endpoint: 'https://api.openai.com',
    });
    const problem = await oneshotCredentialProblem(root, ALICE);
    expect(problem).toContain(ALICE);
    expect(problem).toContain('"claude-code"');
    let ran = false;
    await expect(withOneshotCredential(root, 'test', ALICE, async () => { ran = true; }))
      .rejects.toBeInstanceOf(TurnCredentialUnavailableError);
    expect(ran).toBe(false);
  });

  test('a one-shot nobody asked for, with no service credential, is refused rather than run', async () => {
    // A teammate's credential puts the daemon in team mode; it must not pay.
    await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'sk-ant-bob' });
    const problem = await oneshotCredentialProblem(root, null);
    expect(problem).toContain('No service credential for automated turns');
    await expect(withOneshotCredential(root, 'test', null, async () => undefined))
      .rejects.toBeInstanceOf(TurnCredentialUnavailableError);
  });

  // INVARIANT: a launch BESIDE a task (a member's builder, a one-shot) whose
  // grant names a session binding is paid through that binding's owner with
  // their own credential for the grant's profile — the proxy never falls
  // through to the project's credentials for it.
  test('a side-launch grant bills the owner of the binding it names', async () => {
    await writeFile(join(root, 'lazy.toml'), '[agent]\nagent_id = "codex"\n');
    await putUserCredential(root, {
      userId: ALICE, profile: 'codex', kind: 'api-key', token: 'sk-openai-alice', endpoint: 'https://api.openai.com',
    });
    await bindTurnCredential(root, { taskId: 'oneshot:test:1', sessionId: 'oneshot:test:1', ownerUserId: ALICE, kind: 'api-key' });
    const token = await mintCredentialGrant(root, {
      role: 'builder', taskId: null, label: 'oneshot:test', envKey: 'OPENAI_API_KEY', profile: 'codex',
      bindingKey: 'oneshot:test:1',
    });
    const grant = await lookupCredentialGrant(root, token);
    const resolved = await resolveMemberCredential(root, grant!);
    expect(resolved?.userId).toBe(ALICE);
    expect(resolved?.outcome.kind).toBe('credential');
    expect(JSON.stringify(resolved)).toContain('sk-openai-alice');

    // The same grant with no binding named is not a member-paid caller.
    const plain = await mintCredentialGrant(root, {
      role: 'builder', taskId: null, label: 'other', envKey: 'OPENAI_API_KEY', profile: 'codex',
    });
    // Approved endpoint design: docs/design/teams-endpoint-credentials.md.
    const unbound = await resolveMemberCredential(root, (await lookupCredentialGrant(root, plain))!);
    expect(unbound?.userId).toBeNull();
    expect(unbound?.outcome).toMatchObject({ kind: 'missing', reason: expect.stringContaining('no active member credential binding') });
    expect(JSON.stringify(unbound)).not.toContain('sk-openai-alice');
  });

  // INVARIANT: a service holder who connected only a non-Claude credential is
  // still the system identity — automated commits get an author, and their
  // turns are attributed to them, with no Claude record anywhere.
  test('the system identity is read off a per-profile service push', async () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
    // Approved endpoint design: legacy profile migration resolves fleet config.
    expect((await loadConfig(root)).storage.external_path).toBe(join(root, 'store'));
    expect(await getServiceHolder(root)).toBeNull();
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID, profile: 'codex', kind: 'api-key', token: 'sk-openai-holder',
      ownerEmail: ALICE, endpoint: 'https://api.openai.com',
    });
    expect(await getServiceHolder(root)).toEqual({ email: ALICE });
    expect((await resolveSystemIdentity(root))?.email).toBe(ALICE);
  });

  // INVARIANT: a ChatGPT-session service record names its holder by `sameAs`
  // and carries no ownerEmail; the holder is still the system identity.
  test('the system identity is read off a sameAs (session-profile) service record', async () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
    // Approved endpoint design: docs/design/teams-endpoint-credentials.md.
    expect((await loadConfig(root)).storage.external_path).toBe(join(root, 'store'));
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID, profile: 'codex-subscription', kind: 'oauth', token: '',
      sameAs: ALICE,
    });
    expect(await getServiceHolder(root)).toEqual({ email: ALICE });
    expect((await resolveSystemIdentity(root))?.email).toBe(ALICE);
  });

  // INVARIANT: in team mode no one-shot reaches its runner unpaid. A request
  // with no credential env is planned on the payer in scope — or, with none,
  // the service holder — and refused when they cannot pay; it never runs on
  // the daemon's own credential.
  test('an unpaid one-shot request is planned on the payer in scope', async () => {
    await putUserCredential(root, { userId: ALICE, kind: 'api-key', token: 'sk-ant-alice' });
    const req = { prompt: 'p', effort: 'low' as const };
    const owner = await runAsOneshotPayer(ALICE, () => withOneshotPayment(root, req, async (paid) =>
      (await lookupSessionBinding(root, paid.ownerCredentialEnv![0]!.value))?.ownerUserId));
    expect(owner).toBe(ALICE);

    let ran = false;
    await expect(withOneshotPayment(root, req, async () => { ran = true; }))
      .rejects.toBeInstanceOf(TurnCredentialUnavailableError);
    expect(ran).toBe(false);
  });

  test('outside team mode an unpaid one-shot runs as before, with no env', async () => {
    const seen = await withOneshotPayment(root, { prompt: 'p', effort: 'low' }, async (paid) => paid.ownerCredentialEnv);
    expect(seen).toBeUndefined();
  });

  // INVARIANT: two side launches paid by different people never share a
  // grant, even under one shared label — each bills its own payer.
  test('grants of two launches paid by different people are distinct', async () => {
    await writeFile(join(root, 'lazy.toml'), '[agent]\nagent_id = "codex"\n');
    for (const who of [ALICE, 'bob@example.com']) {
      await putUserCredential(root, {
        userId: who, profile: 'codex', kind: 'api-key', token: `sk-openai-${who}`, endpoint: 'https://api.openai.com',
      });
    }
    await bindTurnCredential(root, { taskId: 'k1', sessionId: 'k1', ownerUserId: ALICE, kind: 'api-key' });
    await bindTurnCredential(root, { taskId: 'k2', sessionId: 'k2', ownerUserId: 'bob@example.com', kind: 'api-key' });
    const base = { role: 'builder' as const, taskId: null, label: 'oneshot:shared', envKey: 'OPENAI_API_KEY', profile: 'codex' };
    const a = await mintCredentialGrant(root, { ...base, bindingKey: 'k1' });
    const b = await mintCredentialGrant(root, { ...base, bindingKey: 'k2' });
    expect(a).not.toBe(b);
    expect((await resolveMemberCredential(root, (await lookupCredentialGrant(root, a))!))?.userId).toBe(ALICE);
    expect((await resolveMemberCredential(root, (await lookupCredentialGrant(root, b))!))?.userId).toBe('bob@example.com');

    expect(await revokeGrantsByBindingKey(root, 'k1')).toBe(1);
    expect(await lookupCredentialGrant(root, a)).toBeNull();
    expect(await lookupCredentialGrant(root, b)).not.toBeNull();
  });
});
