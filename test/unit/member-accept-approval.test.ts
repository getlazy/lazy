import { describe, test, expect, afterEach } from 'bun:test';
import { memberAcceptApprover } from '../../src/daemon/member-accept-approval';

// INVARIANT: only a managed host, a member (user-kind) token, the human
// channel AND the Teams app's browser-Accept marker together make an accept a
// protection approval. Any one missing — solo laptop, control token, a bound
// clone's CLI (no marker), a non-human channel — leaves the gate to the
// passphrase/forge, which is what keeps agents and the builder out.
describe('memberAcceptApprover', () => {
  const saved = process.env.LAZY_TEST_FORCE_MANAGED;
  afterEach(() => {
    if (saved === undefined) delete process.env.LAZY_TEST_FORCE_MANAGED;
    else process.env.LAZY_TEST_FORCE_MANAGED = saved;
  });
  const member = { kind: 'user' as const, email: 'ada@example.com', name: 'Ada' };
  const browser = { actor: 'human', memberAccept: true };

  test('managed + member + human + marker approves, naming the member', () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    expect(memberAcceptApprover(browser, member)).toEqual({ email: 'ada@example.com', name: 'Ada' });
  });

  test('outside managed mode it never approves (solo keeps the passphrase)', () => {
    delete process.env.LAZY_TEST_FORCE_MANAGED;
    expect(memberAcceptApprover(browser, member)).toBeUndefined();
  });

  test('control token, missing marker, or a non-human channel never approve', () => {
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    expect(memberAcceptApprover(browser, { kind: 'control' })).toBeUndefined();
    expect(memberAcceptApprover({ actor: 'human' }, member)).toBeUndefined();
    expect(memberAcceptApprover({ actor: 'human', memberAccept: 'true' }, member)).toBeUndefined();
    expect(memberAcceptApprover({ actor: 'builder', memberAccept: true }, member)).toBeUndefined();
    expect(memberAcceptApprover({ actor: 'agent', memberAccept: true }, member)).toBeUndefined();
  });
});
