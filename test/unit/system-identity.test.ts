/**
 * THE IDENTITY BEHIND WORK NOBODY ASKED FOR.
 *
 * Two sources, one rule: in Teams it is the owner of the project's service
 * credential (pushed beside the secret), on a laptop it is the git identity
 * (§3.4), and where neither answers, the answer is NOBODY — never a name
 * assembled out of a label or an id
 * (docs/design/actor-identity-and-remote-clients.md §3.3 case 3).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  putUserCredential,
  getServiceCredential,
  clearUserCredentialCache,
  SERVICE_CREDENTIAL_USER_ID,
} from '../../src/daemon/user-credentials';
import { resolveSystemIdentity, systemActor } from '../../src/identity/system-identity';
import { clearGitIdentityCache } from '../../src/identity/git-identity';
import { MANAGED_ENV, MANAGED_STORAGE_ENV } from '../../src/config/managed';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

describe('the configured system identity', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-sysid-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-sysid-base-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearGitIdentityCache();
  });

  afterEach(async () => {
    unpin();
    clearUserCredentialCache();
    clearGitIdentityCache();
    delete process.env[MANAGED_ENV];
    delete process.env[MANAGED_STORAGE_ENV];
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  function armManaged(): void {
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = join(base, 'store');
  }

  function gitRepoWithIdentity(email: string | null, name?: string): void {
    spawnSyncUnsupervised(['git', 'init', '-q'], { cwd: root });
    if (email !== null) {
      spawnSyncUnsupervised(['git', 'config', 'user.email', email], { cwd: root });
      if (name) spawnSyncUnsupervised(['git', 'config', 'user.name', name], { cwd: root });
    } else {
      // An EMPTY repo-local value, not an unset one: the machine running this
      // suite has a ~/.gitconfig of its own that an unset key falls through to.
      spawnSyncUnsupervised(['git', 'config', 'user.email', ''], { cwd: root });
      spawnSyncUnsupervised(['git', 'config', 'user.name', ''], { cwd: root });
    }
  }

  test('in Teams it is the service credential owner the control plane pushed', async () => {
    armManaged();
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'oat-service',
      label: 'service (ops@example.com)',
      ownerEmail: 'Ops@Example.com',
      ownerName: 'Ops',
    });

    // Canonicalised the same way every other address in the store is, so the
    // rows it stamps and the credential it pays with are one spelling.
    expect(await resolveSystemIdentity(root)).toEqual({ email: 'ops@example.com', name: 'Ops' });
    expect(await systemActor(root)).toEqual({ role: 'system', email: 'ops@example.com', name: 'Ops' });
  });

  // INVARIANT: nothing is derived from the label. It is free text an operator
  // may set to anything, and a person on an append-only row may not be a guess.
  test('a service credential with no owner names nobody, however its label reads', async () => {
    armManaged();
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'oat-service',
      label: 'service (ops@example.com)',
    });

    expect(await resolveSystemIdentity(root)).toBeNull();
    // And the row gets exactly the bare role it carried before this existed.
    expect(await systemActor(root)).toBe('system');
  });

  // The state a project that configured no automation is in. Its system turns
  // are disabled for their own stated reason; this half must not invent a
  // person for the rows that therefore never get written.
  test('no service credential at all names nobody', async () => {
    armManaged();
    expect(await getServiceCredential(root)).toBeNull();
    expect(await resolveSystemIdentity(root)).toBeNull();
  });

  // INVARIANT: in single-person mode all three identity cases collapse to the
  // one configured identity (§3.4) — the git config the daemon resolves for
  // every other write. The role is what keeps them apart, not the person.
  test('on a laptop it is the git identity', async () => {
    gitRepoWithIdentity('ada@example.com', 'Ada');

    expect(await resolveSystemIdentity(root)).toEqual({ email: 'ada@example.com', name: 'Ada' });
    expect(await systemActor(root)).toEqual({ role: 'system', email: 'ada@example.com', name: 'Ada' });
  });

  test('an unconfigured laptop names nobody', async () => {
    gitRepoWithIdentity(null);

    expect(await resolveSystemIdentity(root)).toBeNull();
    expect(await systemActor(root)).toBe('system');
  });

  // The supervisor channel keeps its own role — a sync merge was performed by
  // lazy, and the idempotency check that dedupes those rows reads that role
  // back. Only the PERSON is added.
  test('a channel of its own keeps that role and takes the person', async () => {
    gitRepoWithIdentity('ada@example.com', 'Ada');

    expect(await systemActor(root, 'supervisor'))
      .toEqual({ role: 'supervisor', email: 'ada@example.com', name: 'Ada' });
  });

  // A call site with no project root records nobody rather than resolving
  // against whatever directory the process happens to be in.
  test('with no project root it is the bare role', async () => {
    expect(await systemActor(undefined)).toBe('system');
  });
});
