/**
 * Pins that the web Unblock form asks NOTHING about protected files.
 *
 * WAS: the Unblock dialog carried a Keep/Revert radio per pending file, the
 * POST was refused without one, and the resulting list was sent to the daemon,
 * which reverted everything left out (`unblockBlockedByPendingViolations`,
 * `parseUnblockViolationDecisions`, `approvedFilesForUnblock`,
 * `unblockViolationChoicesHtml`, `UNBLOCK_VIOLATION_FIELD_PREFIX`).
 *
 * IS (move-file-approval-to-accept, engineer decision 2026-09-13): unblock
 * never reverts a file, so every one of those is gone. A decision with no
 * consequence is worse than no question: it made reviewers and loop agents rule
 * on files they had not read, and the "none for now" answer destroyed the
 * agent's committed work. The one gate is accept, and the per-file ✅/⛔
 * controls on Changes are where a human decides.
 *
 * This file keeps the surface honest in the negative — none of that machinery
 * may come back on the unblock path — plus the accept-side wording that took
 * its place.
 */
import { describe, test, expect } from 'bun:test';
import * as reviewActions from '../../src/server/review-actions';
import * as review from '../../src/server/review';
import { acceptBlockedByViolations } from '../../src/server/review-actions';
import { actionsHtml, type ReviewLiveState } from '../../src/server/review';
import type { FileViolation, Task } from '../../src/types';

const pending: FileViolation = { file: 'a.spec.ts', base_sha: 'abc', status: 'pending' };
const rejected: FileViolation = { file: 'gone.ts', base_sha: 'ghi', status: 'rejected' };

function task(): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'conflict-task',
    goal: 'Ship the thing',
    prompt: 'Do the work',
    type: 'task',
    status: 'conflict',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  } as unknown as Task;
}

const live: ReviewLiveState = {
  status: 'conflict',
  turns: 1,
  lastActiveAt: 1,
  askable: true,
  askUnavailable: null,
};

describe('the unblock-time approval machinery is gone', () => {
  // INVARIANT: removed, not merely unused. Re-exporting any of these would let a
  // future surface rebuild the implicit revert one call site at a time.
  test('no unblock decision helpers are exported any more', () => {
    for (const name of [
      'UNBLOCK_REVERT_CONSEQUENCE',
      'UNBLOCK_VIOLATION_FIELD_PREFIX',
      'unblockBlockedByPendingViolations',
      'parseUnblockViolationDecisions',
      'approvedFilesForUnblock',
    ]) {
      expect(reviewActions).not.toHaveProperty(name);
    }
    expect(review).not.toHaveProperty('unblockViolationChoicesHtml');
  });

  test('the Unblock form carries no per-file question, pending or rejected', () => {
    const html = actionsHtml(task(), [], [], live, {}, {
      fileViolations: [pending, rejected],
    });
    expect(html).toContain('review/unblock');
    expect(html).not.toContain('lz_vd:');
    expect(html).not.toContain('data-lz-unblock-pending');
    expect(html).not.toContain('value="revert"');
    expect(html).not.toContain('will be reverted');
  });

  // The accept form is the other half: a stored ✅ still rides it as a hidden
  // field, so a refused-and-retried accept cannot drop it.
  test('the Accept form still carries approved files', () => {
    const html = actionsHtml(task(), [], [], live, {}, {
      approvedFiles: ['kept.ts'],
      fileViolations: [pending],
    });
    expect(html).toContain('name="approved_files" value="kept.ts"');
  });
});

describe('acceptBlockedByViolations wording', () => {
  // The refusal has to name the act that resolves it. It used to point at
  // unblock's Keep/Revert step; that step no longer exists, and telling a
  // reviewer to unblock in order to decide would send them somewhere that
  // cannot decide.
  test('points at the accept-time decision, not at a revert', () => {
    const reason = acceptBlockedByViolations([pending]);
    expect(reason).toContain('a.spec.ts');
    expect(reason).toMatch(/✅/);
    expect(reason).not.toMatch(/Keep or Revert/);
    expect(reason).not.toMatch(/discards the agent/);
  });

  test('is null once every violation is approved', () => {
    expect(acceptBlockedByViolations([{ file: 'k.ts', base_sha: 'a', status: 'approved' }])).toBeNull();
    expect(acceptBlockedByViolations([])).toBeNull();
  });
});
