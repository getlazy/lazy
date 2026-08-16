/**
 * INVARIANT: `enableInProcessTestMode()` is SUITE-scoped, not process-scoped.
 *
 * It used to assign `process.env.LAZY_TEST = '1'` the moment the module was
 * evaluated, and never clear it. `process.env` is shared by every test file in
 * one `bun test` run, so a single daemonless suite left the flag set for every
 * suite that ran after it — and a `withDaemon: true` suite needs it UNSET so
 * its CLI children really talk to the test daemon. The observed damage was six
 * `lazy accept` tests dying on a storage lock, in a file that passed alone.
 *
 * The scoping is what this file pins down: the flag must NOT be set while the
 * module body runs, and must be set once tests are executing.
 */

import { describe, test, expect } from 'bun:test';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';

// Snapshot BEFORE calling the helper, then again immediately after, both at
// module-evaluation time. Neither may show the flag: a helper that sets it here
// is a helper that can outlive this file.
const atModuleScopeBefore = process.env.LAZY_TEST;
enableInProcessTestMode();
const atModuleScopeAfter = process.env.LAZY_TEST;

describe('enableInProcessTestMode', () => {
  test('does not set LAZY_TEST at module-evaluation time', () => {
    // If some earlier file in the run leaked the flag, `before` already shows
    // it and this file is not the one at fault — so the assertion is that the
    // helper CHANGED nothing, not that the value was absent.
    expect(atModuleScopeAfter).toBe(atModuleScopeBefore);
  });

  test('sets LAZY_TEST=1 for tests in the suite that asked for it', () => {
    expect(process.env.LAZY_TEST).toBe('1');
  });
});
