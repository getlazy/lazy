import { describe, test, expect } from 'bun:test';
import { findPendingFeedback, buildFeedbackRedeliveryPrompt } from '../../src/utils/feedback-redelivery';
import { buildResumePrompt } from '../../src/daemon/task-lifecycle';
import type { Turn } from '../../src/types';

function turn(partial: Partial<Turn> & { sequence: number }): Turn {
  return {
    id: `turn-${partial.sequence}`,
    session_id: 'sess-1',
    role: 'human',
    content: '',
    timestamp: 1000 + partial.sequence,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...partial,
  };
}

describe('findPendingFeedback', () => {
  // INVARIANT (CLAUDE.md — never lose human feedback): feedback that was
  // persisted but never consumed by an agent turn must be findable so resume
  // can re-deliver it. This is the whole point of the marker.
  test('finds a feedback turn that no agent response consumed', () => {
    const pending = findPendingFeedback([
      turn({ sequence: 0, content: 'do the thing', feedback_delivery: 'pending' }),
    ]);
    expect(pending).not.toBeNull();
    expect(pending!.turn.content).toBe('do the thing');
    expect(pending!.olderPendingCount).toBe(0);
  });

  // INVARIANT: idempotence — feedback a turn DID consume must never be
  // re-delivered. Double-delivering makes the agent redo work it already did.
  test('ignores consumed feedback', () => {
    expect(findPendingFeedback([
      turn({ sequence: 0, content: 'already handled', feedback_delivery: 'consumed' }),
      turn({ sequence: 1, role: 'agent', content: 'done' }),
    ])).toBeNull();
  });

  // INVARIANT: a crash records an agent ERROR turn. That turn consumed nothing,
  // so "is there an agent turn after the feedback?" is NOT a valid consumption
  // proxy — only the explicit marker is. This is the exact case (crash after
  // feedback persisted, before the agent acted) that redelivery exists for.
  test('an agent error turn after the feedback does not mask it', () => {
    const pending = findPendingFeedback([
      turn({ sequence: 0, content: 'fix the NUL bug', feedback_delivery: 'pending' }),
      turn({ sequence: 1, role: 'agent', content: '[Agent crashed]\nError: boom' }),
    ]);
    expect(pending).not.toBeNull();
    expect(pending!.turn.content).toBe('fix the NUL bug');
  });

  // INVARIANT: sync/nudge/system turns are not feedback. They carry no marker
  // and must never trigger a redelivery — resuming into a re-delivered sync
  // announcement would be nonsense.
  test('unmarked system, sync and nudge turns never trigger redelivery', () => {
    expect(findPendingFeedback([
      turn({ sequence: 0, content: '[system] Session interrupted and auto-resumed', actor: 'system' }),
      turn({ sequence: 1, content: 'Merged upstream abc→def', actor: 'supervisor', turn_type: 'sync' }),
      turn({ sequence: 2, content: 'Push-back: protected file', actor: 'supervisor', turn_type: 'nudge' }),
    ])).toBeNull();
  });

  // INVARIANT: ordering is never lost when feedback queues up. The NEWEST
  // unconsumed feedback is the operative instruction, and the older ones are
  // reported rather than silently dropped.
  test('picks the newest pending feedback and counts the older ones', () => {
    const pending = findPendingFeedback([
      turn({ sequence: 0, content: 'first ask', feedback_delivery: 'pending' }),
      turn({ sequence: 1, content: 'second ask', feedback_delivery: 'pending' }),
      turn({ sequence: 2, content: 'third ask', feedback_delivery: 'pending' }),
    ]);
    expect(pending!.turn.content).toBe('third ask');
    expect(pending!.olderPendingCount).toBe(2);
  });

  test('orders by sequence, not by array position', () => {
    const pending = findPendingFeedback([
      turn({ sequence: 5, content: 'newest', feedback_delivery: 'pending' }),
      turn({ sequence: 2, content: 'older', feedback_delivery: 'pending' }),
    ]);
    expect(pending!.turn.content).toBe('newest');
  });

  test('returns null for an empty session', () => {
    expect(findPendingFeedback([])).toBeNull();
  });
});

describe('buildFeedbackRedeliveryPrompt', () => {
  // INVARIANT (CLAUDE.md): the human's words are re-delivered VERBATIM —
  // never summarized, truncated, or rewritten.
  test('reproduces the feedback verbatim', () => {
    const feedback = 'Rename `foo` to `bar`.\n\n- keep the tests green\n- do NOT touch main';
    const prompt = buildFeedbackRedeliveryPrompt({
      turn: turn({ sequence: 0, content: feedback, feedback_delivery: 'pending' }),
      olderPendingCount: 0,
    });
    expect(prompt).toContain(feedback);
  });

  // Regression guard: String.replace with a string pattern expands `$&`, `$'`
  // and friends in the REPLACEMENT. Feedback is arbitrary human text, so the
  // implementation must use function replacements or it silently mangles it.
  test('does not expand $-substitutions in the feedback', () => {
    const feedback = "cost is $& and $' and $` and $1";
    const prompt = buildFeedbackRedeliveryPrompt({
      turn: turn({ sequence: 0, content: feedback, feedback_delivery: 'pending' }),
      olderPendingCount: 0,
    });
    expect(prompt).toContain(feedback);
  });

  test('says it is a redelivery after an interrupted turn', () => {
    const prompt = buildFeedbackRedeliveryPrompt({
      turn: turn({ sequence: 0, content: 'x', feedback_delivery: 'pending' }),
      olderPendingCount: 0,
    });
    expect(prompt).toContain('Re-delivered feedback');
    expect(prompt).toContain('interrupted');
  });

  test('mentions older unanswered feedback when it exists', () => {
    const withOlder = buildFeedbackRedeliveryPrompt({
      turn: turn({ sequence: 2, content: 'x', feedback_delivery: 'pending' }),
      olderPendingCount: 2,
    });
    expect(withOlder).toContain('2 older pieces');

    const withoutOlder = buildFeedbackRedeliveryPrompt({
      turn: turn({ sequence: 0, content: 'x', feedback_delivery: 'pending' }),
      olderPendingCount: 0,
    });
    expect(withoutOlder).not.toContain('older piece');
  });
});

describe('buildResumePrompt', () => {
  // INVARIANT (CLAUDE.md — never lose human feedback): re-delivered feedback
  // REPLACES the generic "you were interrupted, carry on" context. The generic
  // prompt leaves the feedback available only implicitly via turn history, and
  // in the live incident the agent never acted on it.
  test('replaces the generic resume context with the redelivery block', () => {
    const redelivery = buildFeedbackRedeliveryPrompt({
      turn: turn({ sequence: 0, content: 'the thing you must do', feedback_delivery: 'pending' }),
      olderPendingCount: 0,
    });
    const prompt = buildResumePrompt('Some goal', redelivery);

    expect(prompt).toContain('the thing you must do');
    expect(prompt).toContain('Re-delivered feedback');
    expect(prompt).toContain('Some goal');
    expect(prompt).not.toContain('Your previous session was interrupted');
  });

  test('falls back to the generic resume context when nothing is pending', () => {
    const prompt = buildResumePrompt('Some goal');
    expect(prompt).toContain('Your previous session was interrupted');
    expect(prompt).not.toContain('Re-delivered feedback');
  });
});
