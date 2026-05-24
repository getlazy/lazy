import { describe, test, expect } from 'bun:test';
import { shouldSkipAutoResumeForUserStop } from '../../src/utils/reconcile';

/**
 * INVARIANT: `lazy stop` must NOT be undone by the reconciler.
 *
 * The reconciler auto-resumes interrupted sessions when the supervisor crashes
 * (container died, exit code != 0). It MUST NOT auto-resume sessions that the
 * user explicitly stopped via `lazy stop` / `lazy_stop`, because the whole
 * point of stop is to halt the agent so the human (or builder) can redirect
 * the work. Auto-resuming would race the human's redirection and waste tokens.
 *
 * The gate is a stored boolean (`session.user_stopped`), not a derived state,
 * so the reconciler decision is unambiguous and survives daemon restarts.
 * Manual `lazy resume` / `lazy unblock` clears the flag (via
 * `resetConsecutiveInterruptions`), re-arming auto-resume.
 */
describe('shouldSkipAutoResumeForUserStop', () => {
  test('user_stopped=true → skip auto-resume', () => {
    expect(shouldSkipAutoResumeForUserStop({ user_stopped: true })).toBe(true);
  });

  test('user_stopped=false → allow auto-resume (crash recovery path)', () => {
    expect(shouldSkipAutoResumeForUserStop({ user_stopped: false })).toBe(false);
  });

  test('user_stopped missing/undefined → allow auto-resume (legacy session)', () => {
    expect(shouldSkipAutoResumeForUserStop({})).toBe(false);
    expect(shouldSkipAutoResumeForUserStop({ user_stopped: undefined })).toBe(false);
  });
});
