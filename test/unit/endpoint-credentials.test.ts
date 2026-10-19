import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as filesystem from 'fs/promises';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { getUserCredentialsPath } from '../../src/daemon/paths';
import { loadConfig } from '../../src/config/loader';
import { agentProfilesFor } from '../../src/config/agent-profiles';
import { endpointRequirements, endpointRequirementsForProfile, normalizeEndpointOrigin, credentialConsentedToEndpoint } from '../../src/credentials/endpoint-requirements';
import { clearUserCredentialCache, getEndpointCredential, putEndpointCredential, revokeEndpointCredential, storeRenewedEndpointCredential, endpointCredentialState, listEndpointCredentials, teamModeEnabled, setCredentialBillingMode, getServiceHolder, putUserCredential, getUserCredential } from '../../src/daemon/user-credentials';

const configText = `
[endpoints.work]
url = "https://api.anthropic.com/v1"
credential = "anthropic"
[endpoints.reserve]
url = "https://api.anthropic.com"
credential = "anthropic"
[endpoints.free]
url = "http://localhost:11434"
credential = "none"
[agents.a]
harness = "claude-code"
model = "claude-sonnet-4-6"
named_endpoint = "work"
[agents.b]
harness = "claude-code"
model = "claude-sonnet-4-6"
named_endpoint = "work"
[agents.inline]
harness = "claude-code"
model = "claude-sonnet-4-6"
endpoint = "https://gateway.example/v1"
credential = "gateway"
[agents.custom-default]
harness = "claude-code"
credential = "work-account"
[agents.other-default]
harness = "claude-code"
credential = "work-account"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "work", model = "claude-sonnet-4-6", threshold_percent = 90 }, { endpoint = "reserve", model = "claude-sonnet-4-6", threshold_percent = 95 }, { endpoint = "free", model = "local" }]
`;

describe('endpoint credential foundation', () => {
  let root: string, base: string, undo: () => void, unpin: () => void;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'endpoint-registry-'));
    base = await mkdtemp(join(tmpdir(), 'endpoint-secrets-'));
    undo = pinDaemonBaseDir(base); unpin = pinConfig(root);
    await writeFile(join(root, 'lazy.toml'), configText);
    clearUserCredentialCache();
  });
  afterEach(async () => {
    clearUserCredentialCache(); undo(); unpin();
    await rm(root, { recursive: true, force: true }); await rm(base, { recursive: true, force: true });
  });
  async function seed(data: unknown) {
    const path = getUserCredentialsPath(root);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data));
    clearUserCredentialCache(); return path;
  }
  function legacy(extra: Record<string, unknown> = {}) {
    return { userId: 'Ada@Example.com', kind: 'api-key', token: 'legacy-secret', label: 'Ada', updatedAt: '2026-10-01T00:00:00Z', ...extra };
  }
  const input = { userId: 'ada@example.com', endpointId: 'work', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key' as const, token: 'work-secret' };

  // INVARIANT: account identity is configured name, implicit profile or builtin provider; every tier is described.
  test('shared, inline, builtin and all tier descriptors', async () => {
    const config = await loadConfig(root);
    const all = endpointRequirements(config);
    expect(all.find(r => r.endpointId === 'work')?.consumers.map(c => [c.profile, c.tier])).toEqual([['a', null], ['b', null], ['chain', 0]]);
    expect(all.find(r => r.endpointId === 'profile:inline')?.origin).toBe('https://gateway.example');
    expect(all.find(r => r.endpointId === 'builtin:anthropic')?.origin).toBe('https://api.anthropic.com');
    expect(all.find(r => r.endpointId === 'builtin:cursor')?.origin).toBe('https://api2.cursor.sh');
    expect(all.find(r => r.endpointId === 'builtin:anthropic')?.howToGet).toContain('claude setup-token');
    expect(all.find(r => r.endpointId === 'builtin:chatgpt')?.howToGet).toContain('~/.codex/auth.json');
    expect(all.find(r => r.endpointId === 'work')?.credentialLabel).toBe('Anthropic');
    expect(all.find(r => r.endpointId === 'profile:custom-default')?.provider).toBe('work-account');
    expect(all.find(r => r.endpointId === 'profile:other-default')?.provider).toBe('work-account');
    expect(all.find(r => r.endpointId === 'builtin:work-account')).toBeUndefined();
    const chain = endpointRequirementsForProfile(agentProfilesFor(config).get('chain')!, config);
    expect(chain.map(r => r.endpointId)).toEqual(['work', 'reserve', 'free']);
    expect(chain[2]!.kinds).toEqual([]);
    expect(chain[2]!.howToGet).toBeNull();
    expect(() => normalizeEndpointOrigin('https://secret@host.example')).toThrow('embedded credentials');
    expect(normalizeEndpointOrigin('https://HOST.example:443/new/path')).toBe('https://host.example');
  });

  // INVARIANT: independent Anthropic slots cannot borrow accounts, and origin/auth changes never manufacture consent.
  // INVARIANT: on a built-in provider's own origin consent is origin-level —
  // a path there must not turn the default Anthropic connection into a
  // different, unrecognised one.
  test('first-party consent with a path is stored as the origin', async () => {
    await putEndpointCredential(root, { ...input, endpointId: 'builtin:anthropic', origin: 'https://api.anthropic.com/base' });
    expect((await getEndpointCredential(root, input.userId, 'builtin:anthropic'))?.endpoint).toBe('https://api.anthropic.com');
    expect(await getUserCredential(root, input.userId)).not.toBeNull();
  });

  test('named accounts stay separate and stale consent remains stale', async () => {
    await putEndpointCredential(root, input);
    expect(await getEndpointCredential(root, input.userId, 'reserve')).toBeNull();
    expect(await getEndpointCredential(root, input.userId, 'builtin:anthropic')).toBeNull();
    const r = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === 'work')!;
    expect(await endpointCredentialState(root, input.userId, r)).toEqual({ state: 'connected' });
    expect((await endpointCredentialState(root, input.userId, { ...r, origin: 'https://other.example' })).state).toBe('stale');
    expect((await endpointCredentialState(root, input.userId, { ...r, provider: 'openai' })).state).toBe('stale');
    await putEndpointCredential(root, { ...input, origin: 'https://unrelated.example' });
    expect((await endpointCredentialState(root, input.userId, { ...r, origin: 'https://unrelated.example' })).state).toBe('stale');
    await putEndpointCredential(root, { ...input, origin: 'https://old.example/path' });
    // Consent keeps its PATH: on a path-routed gateway the path names whose account receives the secret.
    expect((await getEndpointCredential(root, input.userId, 'work'))?.endpoint).toBe('https://old.example/path');
    expect((await endpointCredentialState(root, input.userId, r)).state).toBe('stale');
    expect(JSON.stringify(await listEndpointCredentials(root))).not.toContain('work-secret');
  });

  // INVARIANT: migration preserves consent, renewal metadata and service references, with private recovery evidence.
  test('atomic v1 migration and restart preserve original consent and renewal chain', async () => {
    const digest = createHash('sha256').update('original').digest('hex');
    const raw = { version: 1, credentials: [legacy(), legacy({ profile: 'a', endpoint: 'https://old.example', token: 'renewed', pushedDigest: digest }), legacy({ profile: 'removed', endpoint: '', token: 'orphan' }), legacy({ userId: '__service__', profile: 'a', sameAs: 'Ada@Example.com', token: '', ownerEmail: 'ada@example.com' })] };
    const path = await seed(raw);
    expect((await getEndpointCredential(root, input.userId, 'builtin:anthropic'))?.endpoint).toBe('https://api.anthropic.com');
    expect(await getEndpointCredential(root, input.userId, 'work')).toMatchObject({ token: 'renewed', endpoint: 'https://old.example', pushedDigest: digest });
    expect((await getEndpointCredential(root, input.userId, 'profile:removed'))?.endpoint).toBe('');
    expect(await getServiceHolder(root)).toEqual({ email: input.userId });
    expect(await readFile(`${path}.v1-backup`, 'utf8')).toBe(JSON.stringify(raw));
    expect((await stat(`${path}.v1-backup`)).mode & 0o777).toBe(0o600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(path.startsWith(root)).toBe(false);
    const migrated = await readFile(path, 'utf8'); clearUserCredentialCache();
    await getEndpointCredential(root, input.userId, 'work'); expect(await readFile(path, 'utf8')).toBe(migrated);
  });

  // INVARIANT: legacy Cursor default consent names the historical provider origin, never a configured replacement.
  test('Cursor migration and old-client re-push preserve only historical default consent', async () => {
    await seed({ version: 1, credentials: [legacy({ profile: 'cursor', endpoint: '' })] });
    const requirement = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === 'builtin:cursor')!;
    expect((await getEndpointCredential(root, input.userId, requirement.endpointId))?.endpoint).toBe('https://api2.cursor.sh');
    expect((await endpointCredentialState(root, input.userId, requirement)).state).toBe('connected');
    expect((await getUserCredential(root, input.userId, 'cursor'))?.endpoint).toBe('');
    await putUserCredential(root, { userId: input.userId, profile: 'cursor', endpoint: '', kind: 'api-key', token: 're-pushed' });
    clearUserCredentialCache();
    expect((await endpointCredentialState(root, input.userId, requirement)).state).toBe('connected');
    expect((await getUserCredential(root, input.userId, 'cursor'))?.endpoint).toBe('');
    for (const endpoint of [null, undefined, 'https://old.example']) {
      await putUserCredential(root, { userId: input.userId, profile: 'cursor', endpoint, kind: 'api-key', token: 'no-consent' });
      expect((await endpointCredentialState(root, input.userId, requirement)).state).toBe('stale');
      expect(await getUserCredential(root, input.userId, 'cursor')).toBeNull();
    }
    await writeFile(join(root, 'lazy.toml'), configText + '\n[proxy]\ncursor_upstream = "https://changed.example"\n');
    await putUserCredential(root, { userId: input.userId, profile: 'cursor', endpoint: '', kind: 'api-key', token: 'default-only' });
    const changed = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === 'builtin:cursor')!;
    expect((await getEndpointCredential(root, input.userId, changed.endpointId))?.endpoint).toBe('https://api2.cursor.sh');
    expect((await endpointCredentialState(root, input.userId, changed)).state).toBe('stale');
    expect(await getUserCredential(root, input.userId, 'cursor')).toBeNull();
    expect(credentialConsentedToEndpoint({ endpoint: '' }, requirement)).toBe(true);
    expect(credentialConsentedToEndpoint({ endpoint: null }, requirement)).toBe(false);
    expect(credentialConsentedToEndpoint({ endpoint: '' }, { ...requirement, endpointId: 'named' })).toBe(false);
    expect(credentialConsentedToEndpoint({ endpoint: '' }, { ...requirement, endpointId: 'profile:cursor' })).toBe(false);
    expect(credentialConsentedToEndpoint({ endpoint: '' }, changed)).toBe(false);
  });

  // INVARIANT: missing or changed Cursor consent cannot gain the current origin during migration.
  test('Cursor migration retains missing and explicit nondefault consent', async () => {
    await seed({ version: 1, credentials: [legacy({ profile: 'cursor', endpoint: null }), legacy({ userId: 'bob@example.com', profile: 'cursor', endpoint: 'https://old.example' }), legacy({ profile: 'removed', endpoint: '' })] });
    const requirement = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === 'builtin:cursor')!;
    expect((await endpointCredentialState(root, input.userId, requirement)).state).toBe('stale');
    expect((await endpointCredentialState(root, 'bob@example.com', requirement)).state).toBe('stale');
    expect((await getEndpointCredential(root, input.userId, 'profile:removed'))?.endpoint).toBe('');
  });

  // INVARIANT: differing accounts or ambiguous consent survive migration as unusable collisions, never a silent winner.
  test('collisions require replacement; identical account metadata may coalesce', async () => {
    await seed({ version: 1, credentials: [legacy({ profile: 'a', endpoint: 'https://api.anthropic.com' }), legacy({ profile: 'b', endpoint: 'https://api.anthropic.com' }), legacy({ profile: 'a', endpoint: 'https://other.example', token: 'different' })] });
    expect(await getEndpointCredential(root, input.userId, 'work')).toBeNull();
    const r = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === 'work')!;
    expect((await endpointCredentialState(root, input.userId, r)).state).toBe('conflicted');
    expect((await listEndpointCredentials(root)).filter(c => c.endpointId === 'work')).toHaveLength(2);
    await putEndpointCredential(root, input);
    expect((await getEndpointCredential(root, input.userId, 'work'))?.token).toBe(input.token);
  });

  // INVARIANT: malformed secret-bearing JSON never exposes parser input in a rejection.
  test('malformed registry errors keep path context without leaking secret bytes', async () => {
    const secret = 'synthetic_registry_secret_never_echo';
    const path = await seed({ version: 1, credentials: [] });
    const malformed = `{"version":1,"credentials":[{"token":${secret}}]}`;
    await writeFile(path, malformed);
    const error = await getEndpointCredential(root, input.userId, 'work').then(() => null, err => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(path);
    expect(error!.message).toContain('Malformed registry JSON');
    expect(error!.message).not.toContain(secret);
    expect(error!.stack).not.toContain(secret);
    expect(await readFile(path, 'utf8')).toBe(malformed);
    await expect(stat(`${path}.v1-backup`)).rejects.toThrow();
  });

  // INVARIANT: malformed source refuses before backup/write; recovery never automatically resurrects revoked accounts.
  test('malformed and restored registries refuse without changing source', async () => {
    const path = await seed({ version: 1, credentials: [legacy(), { token: 'bad' }] });
    const original = await readFile(path, 'utf8');
    await expect(getEndpointCredential(root, input.userId, 'work')).rejects.toThrow('invalid');
    expect(await readFile(path, 'utf8')).toBe(original);
    await expect(stat(`${path}.v1-backup`)).rejects.toThrow();
    await seed({ version: 1, credentials: [legacy()] });
    const legacyBytes = await readFile(path, 'utf8');
    await getEndpointCredential(root, input.userId, 'builtin:anthropic');
    await revokeEndpointCredential(root, input.userId, 'builtin:anthropic');
    await writeFile(path, legacyBytes); clearUserCredentialCache();
    await expect(teamModeEnabled(root)).rejects.toThrow('Reconcile explicitly');
    expect(await readFile(path, 'utf8')).toBe(legacyBytes);
  });

  // INVARIANT: billing mode survives empty/service-only state and restart; missing mode is never solo.
  test('durable mode survives last revocation and missing mode refuses', async () => {
    await setCredentialBillingMode(root);
    await putEndpointCredential(root, input); await revokeEndpointCredential(root, input.userId, 'work');
    clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(true);
    await seed({ version: 2, credentials: [] });
    await expect(teamModeEnabled(root)).rejects.toThrow('billing mode');
  });

  // INVARIANT: new endpoint mutations preserve the declared billing mode, including last revoke and restart.
  for (const mode of ['solo', 'member'] as const) {
    test(`new puts and last revoke preserve durable ${mode} mode`, async () => {
      const path = await seed({ version: 2, billingMode: mode, credentials: [] });
      const expected = mode === 'member';
      await putEndpointCredential(root, input);
      clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(expected);
      expect(JSON.parse(await readFile(path, 'utf8')).billingMode).toBe(mode);
      await putEndpointCredential(root, { ...input, token: 'replacement' });
      clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(expected);
      await revokeEndpointCredential(root, input.userId, 'work');
      clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(expected);
      expect(JSON.parse(await readFile(path, 'utf8')).billingMode).toBe(mode);
      expect(await listEndpointCredentials(root)).toHaveLength(0);
    });
  }

  // INVARIANT: compatibility puts explicitly retain first-member opt-in; service-only and invalid puts do not enable it.
  test('legacy adapter opts in only after a successful member put and never disables it', async () => {
    expect(await teamModeEnabled(root)).toBe(false);
    await expect(putUserCredential(root, { userId: input.userId, kind: 'api-key', token: '' })).rejects.toThrow('Empty credential secret');
    clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(false);
    await putUserCredential(root, { userId: '__service__', ownerEmail: input.userId, kind: 'api-key', token: 'service' });
    clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(false);
    await putUserCredential(root, { userId: input.userId, kind: 'api-key', token: input.token });
    clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(true);
    await revokeEndpointCredential(root, input.userId, 'builtin:anthropic');
    clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(true);
  });

  // INVARIANT: legacy opt-in publishes the credential and member mode together. Queued launch reads must not see solo billing for that account.
  test('legacy member publication is atomic for disk snapshots and queued mode reads', async () => {
    const path = await seed({ version: 2, billingMode: 'solo', credentials: [] });
    const originalRename = filesystem.rename;
    const snapshots: Array<{ billingMode: string; credentials: unknown[] }> = [];
    let queuedMode: Promise<boolean> | undefined;
    const hook = spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      if (destination === path) {
        const snapshot = JSON.parse(await readFile(source, 'utf8'));
        snapshots.push(snapshot);
        // Queue while publication still owns serialization, before its caller can continue.
        if (snapshot.credentials.length && !queuedMode) queuedMode = teamModeEnabled(root);
      }
      await originalRename(source, destination);
    });
    try {
      await putUserCredential(root, { userId: input.userId, kind: 'api-key', token: input.token });
      expect(queuedMode).toBeDefined();
      expect(await queuedMode).toBe(true);
      expect(snapshots.filter(s => s.credentials.length)).toEqual([
        expect.objectContaining({ billingMode: 'member' }),
      ]);
      expect((await getUserCredential(root, input.userId))?.token).toBe(input.token);
    } finally { hook.mockRestore(); }
    clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(true);
  });

  // INVARIANT: a failed legacy mode publication cannot leave a spendable member slot in solo mode, in memory or after restart.
  test('failed legacy member-mode write never activates its credential', async () => {
    const path = await seed({ version: 2, billingMode: 'solo', credentials: [] });
    const originalRename = filesystem.rename;
    let failed = false;
    const hook = spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      if (destination === path && JSON.parse(await readFile(source, 'utf8')).billingMode === 'member') {
        failed = true;
        throw new Error('member mode publication unavailable');
      }
      await originalRename(source, destination);
    });
    try {
      await expect(putUserCredential(root, { userId: input.userId, kind: 'api-key', token: input.token })).rejects.toThrow('member mode publication unavailable');
      expect(failed).toBe(true);
      expect(await teamModeEnabled(root)).toBe(false);
      expect(await getUserCredential(root, input.userId)).toBeNull();
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ billingMode: 'solo', credentials: [] });
    } finally { hook.mockRestore(); }
    clearUserCredentialCache();
    expect(await teamModeEnabled(root)).toBe(false);
    expect(await getUserCredential(root, input.userId)).toBeNull();
  });

  // INVARIANT: v1 solo installs keep their original member-presence rule; managed installs always declare member billing.
  for (const managed of [false, true]) {
    for (const registry of ['empty', 'service-only', 'member-only', 'mixed'] as const) {
      test(`v1 ${managed ? 'managed' : 'solo'} ${registry} migration preserves billing mode`, async () => {
        const saved = process.env.LAZY_MANAGED;
        try {
          if (managed) process.env.LAZY_MANAGED = '1';
          else delete process.env.LAZY_MANAGED;
          const service = legacy({ userId: '__service__', ownerEmail: input.userId });
          const credentials = registry === 'empty' ? [] : registry === 'service-only' ? [service] : registry === 'member-only' ? [legacy()] : [service, legacy()];
          const path = await seed({ version: 1, credentials });
          const expected = managed || registry === 'member-only' || registry === 'mixed';
          expect(await teamModeEnabled(root)).toBe(expected);
          expect(JSON.parse(await readFile(path, 'utf8')).billingMode).toBe(expected ? 'member' : 'solo');
          clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(expected);
          expect(await listEndpointCredentials(root)).toHaveLength(credentials.length);
        } finally {
          if (saved === undefined) delete process.env.LAZY_MANAGED;
          else process.env.LAZY_MANAGED = saved;
        }
      });
    }
  }

  // INVARIANT: an old renewal cannot overwrite a replacement; re-pushing an original session cannot retire the renewal.
  test('endpoint renewal CAS and original push digest survive restarts', async () => {
    await putEndpointCredential(root, { ...input, session: true, provider: 'chatgpt', renewable: true, kind: 'oauth', token: 'original' });
    expect(await storeRenewedEndpointCredential(root, input.userId, 'work', 'rotated', 'original')).toBe(true);
    clearUserCredentialCache();
    await putEndpointCredential(root, { ...input, session: true, provider: 'chatgpt', renewable: true, kind: 'oauth', token: 'original' });
    expect((await getEndpointCredential(root, input.userId, 'work'))?.token).toBe('rotated');
    await putEndpointCredential(root, { ...input, token: 'replacement' });
    expect(await storeRenewedEndpointCredential(root, input.userId, 'work', 'too-late', 'rotated')).toBe(false);
    expect((await getEndpointCredential(root, input.userId, 'work'))?.token).toBe('replacement');
  });
  // INVARIANT: managed billing is declared durably before any member credentials exist, including service-only installs.
  test('managed empty and service-only registries stay member billed after restart', async () => {
    const managed = process.env.LAZY_MANAGED;
    try {
      process.env.LAZY_MANAGED = '1';
      expect(await teamModeEnabled(root)).toBe(true);
      await putEndpointCredential(root, { ...input, userId: '__service__', ownerEmail: input.userId });
      clearUserCredentialCache(); expect(await teamModeEnabled(root)).toBe(true);
      await revokeEndpointCredential(root, '__service__', 'work');
      clearUserCredentialCache();
      delete process.env.LAZY_MANAGED;
      expect(await teamModeEnabled(root)).toBe(true);
    } finally {
      if (managed === undefined) delete process.env.LAZY_MANAGED;
      else process.env.LAZY_MANAGED = managed;
    }
  });

  // INVARIANT: unattended readiness checks the designated holder's own accounts, never copied service secrets.
  test('service readiness follows holder slots across endpoints and detects conflicting holders', async () => {
    const requirement = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === 'work')!;
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('missing');
    await putEndpointCredential(root, { ...input, userId: '__service__', ownerEmail: input.userId });
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('missing');
    await putEndpointCredential(root, { ...input, origin: 'https://old.example' });
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('stale');
    await putEndpointCredential(root, input);
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('connected');
    await revokeEndpointCredential(root, '__service__', 'work');
    await putEndpointCredential(root, { ...input, userId: '__service__', endpointId: 'reserve', ownerEmail: input.userId });
    // No matching service endpoint row is needed: the one global holder pays every endpoint.
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('connected');
    await putEndpointCredential(root, { ...input, userId: '__service__', ownerEmail: 'bob@example.com' });
    expect(await getServiceHolder(root)).toBeNull();
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('conflicted');
    await revokeEndpointCredential(root, '__service__', 'work');
    await revokeEndpointCredential(root, input.userId, 'work');
    expect((await endpointCredentialState(root, '__service__', requirement)).state).toBe('missing');
  });

  // INVARIANT: concurrent read-modify-writes cannot lose another endpoint's credential.
  test('concurrent mutations retain all independent slots', async () => {
    await Promise.all(['work', 'reserve', 'profile:inline'].map(endpointId => putEndpointCredential(root, { ...input, endpointId })));
    clearUserCredentialCache(); expect(await listEndpointCredentials(root)).toHaveLength(3);
  });

});
