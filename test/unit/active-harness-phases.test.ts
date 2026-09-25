/**
 * Unit invariant: stranded-completion recovery must treat reactive, maintained
 * and wrap-up follow-ups as active harness work — the same shield
 * permission_pushback already had.
 */

import { describe, test, expect } from 'bun:test';
import { ACTIVE_HARNESS_PHASES } from '../../src/utils/reconcile';

describe('ACTIVE_HARNESS_PHASES covers long post-work agent nudges', () => {
  // INVARIANT: a multi-minute react/maintain/wrap-up follow-up — and the
  // wrap-up's own presentation step — must block stranded recovery. Without
  // these phases, status stays at work_done and a false-dead liveness probe
  // can finalize the turn while a follow-up is still running.
  test('includes react, maintain, wrap_up and its steps (and permission_pushback)', () => {
    expect(ACTIVE_HARNESS_PHASES.has('permission_pushback')).toBe(true);
    expect(ACTIVE_HARNESS_PHASES.has('maintain')).toBe(true);
    expect(ACTIVE_HARNESS_PHASES.has('react')).toBe(true);
    expect(ACTIVE_HARNESS_PHASES.has('wrap_up')).toBe(true);
    expect(ACTIVE_HARNESS_PHASES.has('present')).toBe(true);
    // Done phases are short-lived checkpoints; recovery keys on the active ones.
    expect(ACTIVE_HARNESS_PHASES.has('work_done')).toBe(false);
  });
});
