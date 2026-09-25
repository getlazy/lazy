/**
 * Unit tests for the auto-review prompt selection (final-turn design §8).
 *
 * INVARIANT: the auto-review prompt is chosen by AUDIENCE, here and nowhere
 * else. An agent-audience task's reviewer gets review-turn-scope.md (scope
 * and correctness only — the reader is the parent agent) and a
 * human-audience task's reviewer gets review-turn-feature.md (the
 * region-by-region walk for the person deciding to accept). A wiring error
 * that handed both audiences the same prompt would ship with a green suite
 * — the audience split is half of what slice 5 exists for — so both
 * assertions are pinned on text UNIQUE to each prompt file, and each test
 * also asserts the OTHER file's text is absent. Swapping the two branches
 * makes every test here fail.
 */

import { describe, test, expect } from 'bun:test';
import type { Task } from '../../src/types';
import { renderReviewTurnPrompt } from '../../src/daemon/task-lifecycle';

function taskFixture(): Task {
  return {
    id: 'task-prompt-1',
    code: 'prompt-task',
    goal: 'Ship the tidy-up',
    prompt: 'Do the work, all of it, and nothing else.',
  } as unknown as Task;
}

describe('auto-review prompt selection by audience (final-turn §8)', () => {
  test('agent audience → the review-turn-scope prompt, not the feature walk', () => {
    const prompt = renderReviewTurnPrompt(taskFixture(), 'agent');
    // Unique to review-turn-scope.md: the scope-and-correctness heading.
    expect(prompt).toContain('scope and correctness only');
    // Unique to review-turn-feature.md — must NOT reach an agent-audience
    // reviewer: it is the region-by-region walk owed only to a person.
    expect(prompt).not.toContain('region by region');
  });

  test('human audience → the review-turn-feature prompt, not the scope brief', () => {
    const prompt = renderReviewTurnPrompt(taskFixture(), 'human');
    // Unique to review-turn-feature.md: the region-by-region walk heading.
    expect(prompt).toContain('region by region');
    // Unique to review-turn-scope.md — a person deciding to accept gets the
    // fuller review, never the agent-facing scope brief.
    expect(prompt).not.toContain('scope and correctness only');
  });

  test('defaults to the human prompt (the safe direction — more, never less)', () => {
    const prompt = renderReviewTurnPrompt(taskFixture());
    expect(prompt).toContain('region by region');
    expect(prompt).not.toContain('scope and correctness only');
  });

  test('placeholders are substituted with this task\u2019s identity, goal and prompt', () => {
    const prompt = renderReviewTurnPrompt(taskFixture(), 'agent');
    expect(prompt).toContain('prompt-task');
    expect(prompt).toContain('Ship the tidy-up');
    expect(prompt).toContain('Do the work, all of it, and nothing else.');
    // No raw template placeholder survives rendering.
    expect(prompt).not.toContain('{{');
  });
});