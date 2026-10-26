import { describe, test, expect } from 'bun:test';
import { failingFollowThrough, type AcceptFollowThrough } from '../../src/daemon/accept-intent';

function record(over: Partial<AcceptFollowThrough>): AcceptFollowThrough {
  return { targetBranch: 'main', viaForge: false, pushParent: true, done: [], attempts: 1, ...over };
}

describe('failing post-accept follow-through', () => {
  test('a failed parent push is a pending push, with the forge message', () => {
    const f = failingFollowThrough(record({ lastError: 'push-parent: remote: Permission to a/b.git denied; with: a semicolon' }));
    expect(f).toMatchObject({ pushPending: true, steps: [{ step: 'push-parent' }] });
    expect(f!.steps[0].error).toContain('denied; with: a semicolon');
  });

  test('a non-push step failing is not reported as an unpushed accept', () => {
    const f = failingFollowThrough(record({ done: ['reparent', 'fast-forward', 'push-parent'], lastError: 'parent-fidelity: model refused' }));
    expect(f).toMatchObject({ pushPending: false, steps: [{ step: 'parent-fidelity', error: 'model refused' }] });
  });

  // INVARIANT: a step that has since completed is not shown as failing — the
  // record keeps its old lastError while a later pass only waits for a member.
  test('a stale error for a step that has completed is dropped', () => {
    expect(failingFollowThrough(record({ done: ['push-parent'], lastError: 'push-parent: 403' }))).toBeNull();
    expect(failingFollowThrough(null)).toBeNull();
  });
});

describe('failing follow-through never carries credentials', () => {
  // INVARIANT: a git error naming a remote URL with credentials in it is
  // masked before it reaches the task page (show.acceptFollowThrough) — also
  // for a record written before the write side masked it.
  test('URL userinfo in lastError is masked', () => {
    const f = failingFollowThrough(record({
      lastError: "push-parent: fatal: unable to access 'https://x-access-token:ghp_SECRET9@github.com/a/b.git/': The requested URL returned error: 403",
    }));
    expect(f!.steps[0].error).not.toContain('ghp_SECRET9');
    expect(f!.steps[0].error).toContain('https://***@github.com/a/b.git/');
  });
});
