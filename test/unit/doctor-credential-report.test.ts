/**
 * Unit tests: the line `lazy doctor` prints for each credential the DAEMON
 * reports, driven through the `getCredentialState` wire shape.
 *
 * This is the surface where a degraded credential store becomes visible to a
 * human. Only a running daemon can be degraded — it is the one process holding
 * a hydrated copy — so the wire shape, not the local fallback, is the path that
 * matters, and it is what a Teams client reads too.
 */

import { describe, test, expect } from 'bun:test';
import { reportDaemonCredentials } from '../../src/doctor/sweep';
import type { DaemonCredentialEntry } from '../../src/daemon/auth-env';

/** A present credential the daemon answered for, with the fields doctor reads. */
function entry(overrides: Partial<DaemonCredentialEntry> = {}): DaemonCredentialEntry {
  return {
    name: 'openai',
    label: 'OpenAI',
    requiredBy: ['codex'],
    present: true,
    source: 'store',
    via: 'keychain',
    kind: 'api-key',
    ...overrides,
  };
}

describe('doctor credential lines', () => {
  test('a healthy credential names its source and the profiles that bill it', () => {
    const [result] = reportDaemonCredentials([entry()]);
    expect(result!.ok).toBe(true);
    expect(result!.label).toContain('credential store: keychain');
    expect(result!.label).toContain('api-key');
    expect(result!.label).toContain('needed by codex');
  });

  // INVARIANT: on the degraded path the line says the STORE cannot be read and
  // the daemon is running on its startup copy — it must not print "credential
  // store: keychain" as though requests were being paid for from there. That
  // reading sends someone debugging a rotation that has not taken to look
  // anywhere except at the keychain they actually need to unlock.
  test('a stale credential says the store is unreadable, not where it lives', () => {
    const [result] = reportDaemonCredentials([entry({ stale: true })]);
    expect(result!.label).toContain('store UNREADABLE');
    expect(result!.label).toContain('using the copy loaded at daemon startup');
    expect(result!.label).not.toContain('credential store: keychain');
    // Still present and still billable: the daemon IS serving turns with it.
    expect(result!.ok).toBe(true);
    expect(result!.label).toContain('needed by codex');
  });

  // INVARIANT: `stale` is part of the DECLARED wire shape, not a field that
  // works only because a spread slipped it past the type checker. This test is
  // typed as DaemonCredentialEntry on purpose — remove the declaration and it
  // stops compiling, which is the regression that actually shipped once.
  test('stale rides the declared wire shape', () => {
    const wire: DaemonCredentialEntry = entry({ stale: true });
    expect(wire.stale).toBe(true);
  });

  test('a credential the daemon could not read reports the error, not a source', () => {
    const [result] = reportDaemonCredentials([
      entry({ present: false, source: null, via: null, kind: null, error: 'index unreadable' }),
    ]);
    expect(result!.ok).toBe(false);
    expect(result!.detail).toContain('index unreadable');
  });
});
