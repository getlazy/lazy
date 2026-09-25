/**
 * Review findings rendered on the Turns tab link into Changes — and the links
 * must be ABSOLUTE (`/tasks/<segment>/changes#…`).
 *
 * `reviewReportHtml` composes `/tasks/${taskId}/…` itself, so it takes the
 * BARE task segment. The Turns-tab caller once passed the FULL `taskPath(...)`
 * instead, doubling every stored review's finding links into
 * `/tasks//tasks/<segment>/…` — dead links on every review the task had ever
 * produced, invisible from the Current review tab where the same renderer is
 * called correctly. This suite pins the bare-segment contract at the call
 * site, not just inside the renderer.
 */

import { describe, test, expect } from 'bun:test';
import type { Task, Session, Turn, ReviewReport } from '../../src/types';
import { taskTurnsSectionHtml } from '../../src/server/templates';
import { anchorDomId } from '../../src/server/review-diff';

const task: Task = {
  id: 'task-review-links',
  code: 'review-links-demo',
  goal: 'review links',
  prompt: 'review links',
  type: 'task',
  status: 'blocked',
  created_at: 1000,
  completed_at: null,
  target: { kind: 'branch', branch: 'main' },
  branched_from_sha: null,
  close_reason: null,
  model: null,
  agent_id: 'claude-code',
  runner_type: null,
  metadata: null,
  tags: [],
  pending_sync: 0,
};

const session: Session = {
  id: 's',
  task_id: task.id,
  agent_id: 'claude',
  runner_type: null,
  started_at: 1000,
  ended_at: null,
  outcome: null,
  git_branch: 'lazy/review-links',
  git_start_sha: 'aaa',
  agent_session_id: null,
  last_interaction_at: null,
  total_duration_ms: 0,
  total_usage: null,
  container_name: null,
  container_agent_id: null,
  interrupt_reason: null,
  interrupt_exit_code: null,
  interrupt_at: null,
  interrupt_logs: null,
  consecutive_interruptions: 0,
  auto_resumed: false,
  user_stopped: false,
  upstream_merge_sha: null,
};

function reviewTurn(seq: number, report: ReviewReport): Turn {
  return {
    id: `tr${seq}`,
    session_id: 's',
    sequence: seq,
    role: 'agent',
    turn_type: 'review',
    content: '[agent review] verdict',
    timestamp: 1000 + seq,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    review: report,
  };
}

const report: ReviewReport = {
  verdict: 'approve',
  security: 'none found',
  data_integrity: 'none found',
  findings: [
    { file: 'src/store.ts', line: 40, severity: 'high', category: 'data-integrity', summary: 'Partial write on crash.' },
    { file: 'src/ui.ts', severity: 'low', category: 'style', summary: 'Unused import.' },
  ],
};

describe('review findings on the Turns tab link absolutely', () => {
  test('finding links carry /tasks/<code>/changes#… — never /tasks//tasks/…', () => {
    const html = taskTurnsSectionHtml(task, session, [reviewTurn(1, report)], 'newest');
    // The file+line anchor is the composed href the finding row emits.
    expect(html).toContain(`/tasks/review-links-demo/changes#${anchorDomId({ file: 'src/store.ts', side: 'new', line: 40 })}`);
    // The file-only finding lands on the file's section anchor.
    expect(html).toContain('/tasks/review-links-demo/changes#');
    // The doubling shape the caller bug produced — one bad call site deadened
    // EVERY stored review's finding links.
    expect(html).not.toContain('//tasks/');
    expect(html).not.toContain('href="/tasks//');
  });

  test('with the task\'s code duplicated, finding and commit links fall back to the id', () => {
    // Two tasks sharing one code make the code ambiguous — a finding link
    // built from it would land on whichever task the resolver names the
    // winner. The turns renderer knows the dup set, so its links fall back
    // to the id exactly like the other dup-aware surfaces.
    const html = taskTurnsSectionHtml(task, session, [reviewTurn(1, report)], 'newest', {
      duplicatedCodes: new Set(['review-links-demo']),
    });
    expect(html).toContain(`/tasks/${task.id}/changes#${anchorDomId({ file: 'src/store.ts', side: 'new', line: 40 })}`);
    // The chunk-order toggle falls back with the rest.
    expect(html).toContain(`/tasks/${task.id}/turns?chunks=oldest`);
    expect(html).not.toContain('/tasks/review-links-demo/');
    expect(html).not.toContain('//tasks/');
  });
});