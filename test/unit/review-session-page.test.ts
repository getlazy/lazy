/**
 * Rendering and poll-shape tests for the archived builder review-session page.
 */

import { describe, test, expect } from 'bun:test';
import {
  reviewSessionPageHtml,
  reviewSessionPollJson,
  reviewSessionStartButtonHtml,
  reviewSessionStartFormHtml,
  REVIEW_WITH_BUILDER_GONE_MESSAGE,
} from '../../src/server/review-session';
import { REVIEW_SESSION_FIRST_TURN_CLOSER } from '../../src/server/review-session-actions';
import type { ReviewSession, ReviewSessionMessage } from '../../src/types';
import type { Task } from '../../src/storage';

function task(status: Task['status'] = 'blocked'): Task {
  return {
    id: 'task1234abcd',
    code: 'demo-task',
    goal: 'Ship the feature',
    prompt: '',
    type: 'task',
    status,
    priority: 'normal',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
  } as unknown as Task;
}

function session(status: ReviewSession['status'] = 'idle'): ReviewSession {
  return {
    id: 'rs_test',
    task_id: 'task1234abcd',
    status,
    resume_session_id: 'claude-s1',
    created_at: 1,
    updated_at: 2,
    messages: [],
  };
}

function message(
  overrides: Partial<ReviewSessionMessage> & Pick<ReviewSessionMessage, 'role' | 'content'>,
): ReviewSessionMessage {
  return {
    id: 'm1',
    created_at: 1,
    delivery: overrides.role === 'human' ? 'launched' : 'launched',
    ...overrides,
  };
}

describe('reviewSessionStartButtonHtml', () => {
  test('no longer renders a Review with builder entry', () => {
    expect(reviewSessionStartButtonHtml('task1234abcd', 'blocked')).toBe('');
    expect(reviewSessionStartButtonHtml('task1234abcd', 'conflict')).toBe('');
    expect(reviewSessionStartButtonHtml('task1234abcd', 'working')).toBe('');
  });
});

describe('reviewSessionStartFormHtml', () => {
  test('no longer renders a start form', () => {
    expect(reviewSessionStartFormHtml('task1234abcd')).toBe('');
  });
});

describe('reviewSessionPageHtml', () => {
  test('renders transcript oldest-first with no compose or start', () => {
    const html = reviewSessionPageHtml(
      task(),
      session(),
      [
        message({ id: 'h', role: 'human', content: 'What about edge cases?', created_at: 1 }),
        message({ id: 'a', role: 'assistant', content: 'First read: looks good.', created_at: 2 }),
      ],
    );
    expect(html.indexOf('What about edge cases?')).toBeLessThan(html.indexOf('First read'));
    expect(html).toContain(REVIEW_WITH_BUILDER_GONE_MESSAGE);
    expect(html).toContain('archived');
    expect(html).not.toContain('action="/tasks/task1234abcd/review/session/send"');
    expect(html).not.toContain('action="/tasks/task1234abcd/review/session/start"');
    expect(html).not.toContain('class="rs-compose"');
    expect(html).not.toContain('Start session');
    expect(html).not.toContain("fetch('/api/review/'");
  });

  test('shows last stored status without a poll loop', () => {
    const html = reviewSessionPageHtml(task(), session('turn_in_flight'), []);
    expect(html).toContain('thinking…');
    expect(html).not.toContain('data-turn-in-flight');
    expect(html).not.toContain("fetch('/api/review/'");
  });

  test('shows failed delivery without a retry form', () => {
    const html = reviewSessionPageHtml(
      task(),
      session(),
      [message({ role: 'human', content: 'hello?', delivery: 'failed' })],
    );
    expect(html).toContain('not sent');
    expect(html).not.toContain('Retry send');
    expect(html).not.toContain('/session/send');
  });

  test('does not offer start when no session record is passed', () => {
    const html = reviewSessionPageHtml(task(), null, []);
    expect(html).not.toContain('/session/start');
    expect(html).not.toContain('Start session');
    expect(html).toContain(REVIEW_WITH_BUILDER_GONE_MESSAGE);
  });

  test('renders builder replies as markdown', () => {
    const html = reviewSessionPageHtml(
      task(),
      session(),
      [message({ role: 'assistant', content: '## Summary\n\nLooks good.' })],
    );
    expect(html).toContain('<h2>Summary</h2>');
  });

  test('does not show failed banner for empty human message', () => {
    const html = reviewSessionPageHtml(
      task(),
      session(),
      [message({ role: 'human', content: '   ', delivery: 'failed' })],
    );
    const transcriptMatch = html.match(/<div class="rs-transcript" id="rs-transcript">([\s\S]*?)<\/div>/);
    expect(transcriptMatch).not.toBeNull();
    expect(transcriptMatch![1]).not.toContain('rv-state-failed');
    expect(transcriptMatch![1]).not.toContain('not sent');
  });

  test('shows preamble idle state instead of failed delivery banner', () => {
    const preamble = `Please read task context.\n${REVIEW_SESSION_FIRST_TURN_CLOSER}`;
    const html = reviewSessionPageHtml(
      task(),
      session(),
      [message({ role: 'human', content: preamble, delivery: 'pending' })],
    );
    expect(html).toContain('Builder is reading task context…');
    const transcriptMatch = html.match(/<div class="rs-transcript" id="rs-transcript">([\s\S]*?)<\/div>/);
    expect(transcriptMatch![1]).not.toContain('waiting for the builder');
  });
});

describe('reviewSessionPollJson', () => {
  test('flags turn_in_flight for a stored record', () => {
    const payload = reviewSessionPollJson(session('turn_in_flight'), [
      message({ role: 'assistant', content: 'done' }),
    ]);
    expect(payload.turn_in_flight).toBe(true);
    expect(payload.messages[0].content).toBe('done');
  });

  test('marks auto-injected preamble on human messages', () => {
    const preamble = `Read the task first.\n${REVIEW_SESSION_FIRST_TURN_CLOSER}`;
    const payload = reviewSessionPollJson(session(), [
      message({ role: 'human', content: preamble, delivery: 'pending' }),
      message({ role: 'human', content: 'Real question?', delivery: 'launched' }),
    ]);
    expect(payload.messages[0].is_preamble).toBe(true);
    expect(payload.messages[1].is_preamble).toBe(false);
  });
});
