/**
 * Per-user Anthropic credentials stored in the daemon.
 *
 * INVARIANT: the store lives in the daemon state dir, mode 0600, and NEVER in
 * the project repo — every task container mounts the repo, and the whole point
 * of the feature is that a container never sees a real credential.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, stat, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getUserCredentialsPath } from '../../src/daemon/paths';
import {
  putUserCredential,
  revokeUserCredential,
  getUserCredential,
  getServiceCredential,
  listUserCredentials,
  teamModeEnabled,
  clearUserCredentialCache,
  SERVICE_CREDENTIAL_USER_ID,
} from '../../src/daemon/user-credentials';

describe('user credentials', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-usercred-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-usercred-base-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
  });

  afterEach(async () => {
    unpin();
    clearUserCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test('stores and reads back a credential', async () => {
    const summary = await putUserCredential(root, {
      userId: 'alice',
      kind: 'oauth',
      token: 'sk-ant-oat-alice',
      label: 'Alice',
    });
    expect(summary.userId).toBe('alice');
    expect(summary.kind).toBe('oauth');
    // The summary is what the control plane gets back — it must not carry the secret.
    expect(JSON.stringify(summary)).not.toContain('sk-ant-oat-alice');

    const record = await getUserCredential(root, 'alice');
    expect(record?.token).toBe('sk-ant-oat-alice');
    expect(record?.kind).toBe('oauth');
  });

  // INVARIANT: never in the repo, and not world-readable.
  test('writes to the daemon state dir with mode 0600', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'api-key', token: 'sk-ant-api-alice' });

    const path = getUserCredentialsPath(root);
    expect(path.startsWith(base)).toBe(true);
    expect(path.startsWith(root)).toBe(false);

    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);

    // And nothing resembling the store landed in the project.
    const repoCopy = await readFile(join(root, '.lazy', 'user-credentials.json'), 'utf-8').catch(
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect(repoCopy).toBe('ENOENT');
  });

  test('rejects an unknown kind and a malformed user id', async () => {
    await expect(
      putUserCredential(root, { userId: 'alice', kind: 'bearer' as never, token: 't' }),
    ).rejects.toThrow();
    await expect(
      putUserCredential(root, { userId: 'not a user id', kind: 'oauth', token: 't' }),
    ).rejects.toThrow();
    await expect(
      putUserCredential(root, { userId: 'alice', kind: 'oauth', token: '' }),
    ).rejects.toThrow();
  });

  // INVARIANT: a credential is keyed by the person's EMAIL, the same spelling
  // the store names people by (docs/design/actor-identity-and-remote-clients.md
  // §3.8). If the key admitted a shape the store does not, a person could exist
  // for attribution and not for billing. Widening is not weakening: junk is
  // still refused, and `__service__` stays the one reserved non-email key.
  test('keys a credential by email, and still refuses junk', async () => {
    const summary = await putUserCredential(root, {
      userId: 'ada@example.com',
      kind: 'oauth',
      token: 'sk-ant-oat-ada',
    });
    expect(summary.userId).toBe('ada@example.com');
    expect((await getUserCredential(root, 'ada@example.com'))?.token).toBe('sk-ant-oat-ada');
    expect(await teamModeEnabled(root)).toBe(true);

    for (const junk of [
      'ada@',            // no domain
      '@example.com',    // no local part
      'ada@example',     // no dot in the domain — a bare host is not an address
      'ada @example.com', // whitespace
      'ada<b>@example.com',
      'ada@exam ple.com',
      '',
      '   ',
      '__reserved__',    // the reserved prefix is not a key anyone else may use
    ]) {
      await expect(
        putUserCredential(root, { userId: junk, kind: 'oauth', token: 't' }),
      ).rejects.toThrow(/Invalid userId|empty credential/);
    }
  });

  test('revoking removes the credential', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 't' });
    expect(await revokeUserCredential(root, 'alice')).toBe(true);
    expect(await getUserCredential(root, 'alice')).toBeNull();
    // Idempotent: revoking again is not an error, just false.
    expect(await revokeUserCredential(root, 'alice')).toBe(false);
  });

  test('listing never exposes secrets', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'secret-alice' });
    await putUserCredential(root, { userId: 'bob', kind: 'api-key', token: 'secret-bob' });

    const list = await listUserCredentials(root);
    expect(list.map((s) => s.userId).sort()).toEqual(['alice', 'bob']);
    expect(JSON.stringify(list)).not.toContain('secret-');
  });

  // INVARIANT: this gate is what keeps every single-user install on the
  // unchanged daemon-env path. Team mode turns on only when a control plane has
  // stored a credential for an actual person.
  test('team mode is off until a per-user credential exists', async () => {
    expect(await teamModeEnabled(root)).toBe(false);

    // A service credential alone is not team mode — it exists to serve turns
    // nobody initiated, and on its own says nothing about per-user billing.
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'api-key',
      token: 'svc',
    });
    expect(await teamModeEnabled(root)).toBe(false);
    expect((await getServiceCredential(root))?.token).toBe('svc');

    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 't' });
    expect(await teamModeEnabled(root)).toBe(true);
  });
// THE SERVICE CREDENTIAL NAMES ITS OWNER, because its key names nobody: that
  // address is the identity the daemon attributes work nobody asked for to
  // (docs/design/actor-identity-and-remote-clients.md §3.3 case 3).
  test('the service credential stores the owner the control plane pushed', async () => {
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'svc',
      label: 'service (ops@example.com)',
      ownerEmail: 'Ops@Example.com',
      ownerName: 'Ops',
    });

    const record = await getServiceCredential(root);
    // Folded to the one spelling the store names people by, like every other
    // address here — the credential that pays and the row that is stamped must
    // not disagree over a capital letter.
    expect(record?.ownerEmail).toBe('ops@example.com');
    expect(record?.ownerName).toBe('Ops');
    // Safe to return and log: it is a person, not a secret.
    expect((await listUserCredentials(root))[0]?.ownerEmail).toBe('ops@example.com');
  });

  // INVARIANT: a credential names its owner exactly ONCE. A per-user credential
  // is keyed BY that address, so a second spelling of it is either redundant or
  // a contradiction — and a contradiction stored here would be a quieter answer
  // to "whose account is this" than the key everything else reads.
  test('a per-user credential refuses a disagreeing owner and accepts its own key', async () => {
    await expect(putUserCredential(root, {
      userId: 'alice@example.com',
      kind: 'oauth',
      token: 't',
      ownerEmail: 'bob@example.com',
    })).rejects.toThrow(/keyed BY its owner/);

    await putUserCredential(root, {
      userId: 'alice@example.com',
      kind: 'oauth',
      token: 't',
      ownerEmail: 'alice@example.com',
    });
    expect((await getUserCredential(root, 'alice@example.com'))?.ownerEmail).toBeUndefined();
  });

  test('an owner must be an address, and a name alone is refused', async () => {
    await expect(putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'svc',
      ownerEmail: 'not-an-address',
    })).rejects.toThrow(/ownerEmail/);

    await expect(putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'svc',
      ownerName: 'Ops',
    })).rejects.toThrow(/names nobody/);
  });
});
