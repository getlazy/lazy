import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { getUserCredentialsPath } from '../../src/daemon/paths';
import { FileStorage } from '../../src/storage/file-storage';
import { clearUserCredentialCache, putEndpointCredential, getEndpointCredential, revokeEndpointCredential, teamModeEnabled, setCredentialBillingMode, storeRenewedEndpointCredential, type EndpointUsageInvalidator } from '../../src/daemon/user-credentials';

const input = { userId: 'ada@example.com', endpointId: 'work', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key' as const, token: 'old-secret' };
const key = `credential:member-endpoint:${JSON.stringify([input.userId, input.endpointId])}`;

describe('credential mutation and durable usage failures', () => {
  let root: string, base: string, undo: () => void, unpin: () => void, store: FileStorage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'endpoint-mutation-'));
    base = await mkdtemp(join(tmpdir(), 'endpoint-mutation-secrets-'));
    undo = pinDaemonBaseDir(base); unpin = pinConfig(root);
    await mkdir(join(root, '.lazy'));
    await writeFile(join(root, 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    store = new FileStorage(root); clearUserCredentialCache();
    await setCredentialBillingMode(root);
    await putEndpointCredential(root, input);
    await store.saveUsageLimitReading({ credential: key, ts: Date.now(), upstream: input.origin, backend: 'anthropic', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.97' } });
  });
  afterEach(async () => {
    clearUserCredentialCache(); undo(); unpin();
    await rm(root, { recursive: true, force: true }); await rm(base, { recursive: true, force: true });
  });
  const change = (token = 'replacement') => ({ ...input, token });
  async function blockRegistryWrite() {
    const path = getUserCredentialsPath(root);
    await rename(path, `${path}.saved`); await mkdir(path);
    return async () => { await rm(path, { recursive: true }); await rename(`${path}.saved`, path); };
  }
  const clear: EndpointUsageInvalidator = async (_root, member, endpointId) => {
    expect([member, endpointId]).toEqual([input.userId, input.endpointId]);
    await store.deleteUsageLimitReading(key);
  };

  // INVARIANT: registry failures cannot erase usage while the original account remains spendable.
  for (const mutation of ['replace', 'revoke'] as const) {
    test(`${mutation}: failed detach preserves original credential and reading`, async () => {
      const restore = await blockRegistryWrite(); let calls = 0;
      const invalidate: EndpointUsageInvalidator = async (...args) => { calls++; await clear(...args); };
      try {
        const operation = mutation === 'replace' ? putEndpointCredential(root, change(), invalidate) : revokeEndpointCredential(root, input.userId, input.endpointId, invalidate);
        await expect(operation).rejects.toThrow('Failed to replace credential registry');
        expect(calls).toBe(0);
        expect((await getEndpointCredential(root, input.userId, input.endpointId))?.token).toBe(input.token);
        expect(await store.getUsageLimitReadings()).toHaveLength(1);
      } finally { await restore(); }
      clearUserCredentialCache();
      expect((await getEndpointCredential(root, input.userId, input.endpointId))?.token).toBe(input.token);
    });

    // INVARIANT: failed usage invalidation leaves the old slot durably disconnected; reconnect retries the deletion.
    test(`${mutation}: failed clear refuses spending across restart and reconnect recovers`, async () => {
      const unavailable: EndpointUsageInvalidator = async () => { throw new Error('usage backend unavailable'); };
      const operation = mutation === 'replace' ? putEndpointCredential(root, change(), unavailable) : revokeEndpointCredential(root, input.userId, input.endpointId, unavailable);
      await expect(operation).rejects.toThrow('Reconnect to retry');
      expect(await getEndpointCredential(root, input.userId, input.endpointId)).toBeNull();
      clearUserCredentialCache();
      expect(await getEndpointCredential(root, input.userId, input.endpointId)).toBeNull();
      expect(await teamModeEnabled(root)).toBe(true);
      expect(await store.getUsageLimitReadings()).toHaveLength(1);
      await putEndpointCredential(root, change(), clear);
      expect(await store.getUsageLimitReadings()).toHaveLength(0);
      expect((await getEndpointCredential(root, input.userId, input.endpointId))?.token).toBe('replacement');
    });
  }

  // INVARIANT: a replacement cannot be used before clearing succeeds; a failed installation leaves no old account to spend.
  test('failed final registry write remains disconnected after readings were deleted', async () => {
    let restore: (() => Promise<void>) | undefined;
    const invalidate: EndpointUsageInvalidator = async (...args) => {
      const detached = JSON.parse(await readFile(getUserCredentialsPath(root), 'utf8'));
      expect(detached.credentials).toHaveLength(0);
      await clear(...args); restore = await blockRegistryWrite();
    };
    try {
      await expect(putEndpointCredential(root, change(), invalidate)).rejects.toThrow('Failed to replace credential registry');
      expect(await getEndpointCredential(root, input.userId, input.endpointId)).toBeNull();
      expect(await store.getUsageLimitReadings()).toHaveLength(0);
    } finally { await restore?.(); }
    clearUserCredentialCache(); expect(await getEndpointCredential(root, input.userId, input.endpointId)).toBeNull();
    await putEndpointCredential(root, change(), clear);
    expect((await getEndpointCredential(root, input.userId, input.endpointId))?.token).toBe('replacement');
  });

  // INVARIANT: origin/auth/account changes clear usage; renewal and identical re-push preserve it.
  test('material changes clear; re-push and renewal preserve', async () => {
    let calls = 0;
    const invalidate: EndpointUsageInvalidator = async (...args) => { calls++; await clear(...args); };
    await putEndpointCredential(root, { ...input, label: 'new label' }, invalidate);
    expect(calls).toBe(0); expect(await store.getUsageLimitReadings()).toHaveLength(1);
    await putEndpointCredential(root, { ...input, renewable: true }, invalidate);
    expect(await storeRenewedEndpointCredential(root, input.userId, input.endpointId, 'renewed', input.token)).toBe(true);
    await putEndpointCredential(root, { ...input, renewable: true }, invalidate);
    expect(calls).toBe(0); expect(await store.getUsageLimitReadings()).toHaveLength(1);
    await putEndpointCredential(root, { ...input, origin: 'https://other.example', renewable: true }, invalidate);
    expect(calls).toBe(1); expect(await store.getUsageLimitReadings()).toHaveLength(0);
  });

  // INVARIANT: service designation does not replace the holder's account or reset their active budget.
  test('service reference replacement and revocation preserve holder usage', async () => {
    const service = { ...input, userId: '__service__', ownerEmail: input.userId };
    const refuse: EndpointUsageInvalidator = async () => { throw new Error('must not erase holder reading'); };
    await putEndpointCredential(root, service, refuse);
    await putEndpointCredential(root, { ...service, token: 'service-replacement' }, refuse);
    await revokeEndpointCredential(root, '__service__', input.endpointId, refuse);
    expect((await getEndpointCredential(root, input.userId, input.endpointId))?.token).toBe(input.token);
    expect(await store.getUsageLimitReadings()).toHaveLength(1);
  });
});
