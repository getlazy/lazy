/**
 * Unit tests for the supervisor protocol-version gate.
 *
 * INVARIANT: The supervisor must reject commands whose wire-protocol version
 * does not match its own. Lazy versions (the package version) are NOT part of
 * the gate — different projects on one machine may run different lazy versions
 * concurrently, as long as the protocol matches.
 */

import { describe, test, expect } from 'bun:test';
import { checkProtocolVersion } from '../../src/supervisor/index';

describe('checkProtocolVersion', () => {
  // INVARIANT: Matching protocol versions always pass.
  test('returns null when protocol versions match', () => {
    expect(checkProtocolVersion(1, 1)).toBeNull();
  });

  // INVARIANT: Missing protocol_version in the command must be rejected.
  // v0.11 hosts that predate this gate don't send the field — they get the
  // same "rebuild containers" outcome as a real mismatch, which is correct.
  test('returns error when command has no protocol_version', () => {
    const result = checkProtocolVersion(undefined, 1);
    expect(result).not.toBeNull();
    expect(result).toContain('Protocol version mismatch');
    expect(result).toContain('expected 1');
    expect(result).toContain('lazy upgrade');
  });

  // INVARIANT: Older protocol versions must be rejected.
  test('returns error when host protocol is older than supervisor', () => {
    const result = checkProtocolVersion(0, 1);
    expect(result).not.toBeNull();
    expect(result).toContain('Protocol version mismatch');
    expect(result).toContain('got 0');
    expect(result).toContain('expected 1');
  });

  // INVARIANT: Newer protocol versions must be rejected (supervisor too old).
  test('returns error when host protocol is newer than supervisor', () => {
    const result = checkProtocolVersion(2, 1);
    expect(result).not.toBeNull();
    expect(result).toContain('Protocol version mismatch');
    expect(result).toContain('got 2');
    expect(result).toContain('expected 1');
  });

  // INVARIANT: lazy version is NOT part of the gate. The function signature
  // takes only protocol versions, so a host running a different lazy version
  // than the supervisor passes the gate as long as the protocol matches.
  // This is the whole point of switching from a lazy_version gate.
  test('matching protocol passes regardless of lazy version drift', () => {
    // Two parties at protocol v1 — the gate has no opinion about the lazy
    // version either side is running. (If it did, this signature would have
    // to accept lazy versions; it doesn't.)
    expect(checkProtocolVersion(1, 1)).toBeNull();
  });

  test('error message is actionable', () => {
    const result = checkProtocolVersion(0, 1);
    expect(result).toContain('lazy upgrade');
    expect(result).toContain('rebuild containers');
  });
});
