/**
 * The derived answers `show` serves, so no client re-derives them.
 *
 * Three rules each live in exactly one function (CLAUDE.md): the notes cutoff,
 * the review-chunk boundary, and which reviews count. These tests pin the
 * PROJECTIONS that carry those answers over the wire — the point of the module
 * is that a remote surface never has to hold a second copy of the rule, so each
 * case here is a case a client would otherwise have had to get right itself.
 */

import { describe, test, expect } from 'bun:test';
import {
  SHOW_SECTION_NAMES,
  parseShowSections,
  wantsSection,
  buildNotesState,
  buildShowChunks,
  buildShowReviews,
} from '../../src/task/show-sections';
import type { Comment, Session, Turn } from '../../src/types';
import type { ReviewReport } from '../../src/types/review-report';

function turn(
  sequence: number,
  role: 'human' | 'agent',
  opts: Partial<Turn> = {},
): Turn {
  return {
    id: `t${sequence}`,
    session_id: 's1',
    sequence,
    role,
    content: `turn ${sequence}`,
    timestamp: 1000 * sequence,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...opts,
  } as Turn;
}

function comment(id: string, createdAt: number): Comment {
  return {
    id,
    task_id: 'task-1',
    content: `comment ${id}`,
    created_at: createdAt,
  } as Comment;
}

function session(deliveredThrough: number | null | undefined): Session {
  return { notes_delivered_through: deliveredThrough } as Session;
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    verdict: 'clean',
    security: 'none found',
    data_integrity: 'none found',
    findings: [],
    ...overrides,
  };
}

describe('parseShowSections', () => {
  // INVARIANT: an omitted `sections` serves everything. `lazy show` and every
  // RPC caller written before sections was honoured pass nothing and must keep
  // getting the whole record — narrowing by default would silently empty them.
  test('omitted means every section, and an empty array means none', () => {
    expect(parseShowSections(undefined).sections).toBeNull();
    expect(parseShowSections(null).sections).toBeNull();
    expect(parseShowSections([]).sections).toEqual([]);
    expect(wantsSection(null, 'turns')).toBe(true);
    expect(wantsSection([], 'turns')).toBe(false);
    expect(wantsSection(['chunks'], 'chunks')).toBe(true);
    expect(wantsSection(['chunks'], 'turns')).toBe(false);
  });

  // INVARIANT: an unknown section is REPORTED, never dropped. Silently ignoring
  // one is what made a caller unable to tell a section that is empty from a
  // section that was never implemented — the defect this work started from.
  test('unknown section names come back as invalid', () => {
    const { sections, invalid } = parseShowSections(['turns', 'nonsense', 'raised_items']);
    expect(sections).toEqual(['turns']);
    expect(invalid).toEqual(['nonsense', 'raised_items']);
  });

  test('duplicates collapse', () => {
    expect(parseShowSections(['turns', 'turns']).sections).toEqual(['turns']);
  });

  test('the derived answers are nameable sections', () => {
    expect(SHOW_SECTION_NAMES).toContain('notes');
    expect(SHOW_SECTION_NAMES).toContain('chunks');
    expect(SHOW_SECTION_NAMES).toContain('reviews');
  });
});

describe('buildNotesState', () => {
  // INVARIANT: the delivery mark BEATS a later agent turn. `lazy ask` and
  // `lazy sync` record agent turns without ever rendering the notes block, so
  // a last-agent-turn cutoff marks an undelivered comment as seen and the next
  // unblock skips it — human feedback lost. This precedence is the entire
  // reason resolveNotesCutoff's fallback is a fallback.
  test('an ask turn after the mark does not mark a queued comment as delivered', () => {
    const turns = [
      turn(1, 'human'),
      turn(2, 'agent', { timestamp: 1_000 }),
      // The ask's agent turn, recorded AFTER the comment below was written.
      turn(3, 'agent', { timestamp: 5_000, turn_type: 'ask' } as Partial<Turn>),
    ];
    const comments = [comment('c1', 500), comment('c2', 3_000)];
    const state = buildNotesState(session(1_000), turns, comments);

    expect(state.cutoff).toBe(1_000);
    expect(state.queued_ids).toEqual(['c2']);
    expect(state.delivered_count).toBe(1);
    expect(state.queued_count).toBe(1);
  });

  test('no mark and no agent turn means everything is queued', () => {
    const comments = [comment('c1', 10), comment('c2', 20)];
    const state = buildNotesState(session(undefined), [turn(1, 'human')], comments);
    expect(state.cutoff).toBeNull();
    expect(state.queued_ids).toEqual(['c1', 'c2']);
  });

  // A session predating notes_delivered_through falls back to the last agent
  // turn — the documented legacy path, kept working here.
  test('a session with no mark falls back to the last agent turn', () => {
    const turns = [turn(1, 'human'), turn(2, 'agent', { timestamp: 2_000 })];
    const comments = [comment('c1', 1_500), comment('c2', 2_500)];
    const state = buildNotesState(session(undefined), turns, comments);
    expect(state.cutoff).toBe(2_000);
    expect(state.queued_ids).toEqual(['c2']);
  });

  // A comment written at exactly the mark WAS delivered: markNotesDelivered
  // records "every comment created at or before this timestamp".
  test('a comment at exactly the cutoff counts as delivered', () => {
    const state = buildNotesState(session(2_000), [], [comment('c1', 2_000)]);
    expect(state.queued_ids).toEqual([]);
    expect(state.delivered_count).toBe(1);
  });
});

describe('buildShowChunks', () => {
  // INVARIANT: a supervisor nudge and a system auto-resume are NOT review
  // boundaries — they are absorbed into the human turn's chunk. A surface that
  // opened a chunk on either would disagree with every other surface about
  // what "since you last acted" covers.
  test('a supervisor nudge and a system auto-resume stay inside the human chunk', () => {
    const turns = [
      turn(1, 'human', { actor: 'human' } as Partial<Turn>),
      turn(2, 'agent'),
      turn(3, 'human', { actor: 'supervisor' } as Partial<Turn>),
      turn(4, 'agent'),
      turn(5, 'human', { actor: 'system', auto_triggered: true } as Partial<Turn>),
      turn(6, 'agent'),
      turn(7, 'human', { actor: 'builder' } as Partial<Turn>),
      turn(8, 'agent'),
    ];

    expect(buildShowChunks(turns)).toEqual([
      { index: 0, boundary_sequence: 1, turn_sequences: [1, 2, 3, 4, 5, 6] },
      { index: 1, boundary_sequence: 7, turn_sequences: [7, 8] },
    ]);
  });

  test('leading automation turns form a boundary-less chunk', () => {
    const turns = [
      turn(1, 'human', { actor: 'system', auto_triggered: true } as Partial<Turn>),
      turn(2, 'agent'),
      turn(3, 'human', { actor: 'human' } as Partial<Turn>),
    ];
    expect(buildShowChunks(turns)).toEqual([
      { index: 0, boundary_sequence: null, turn_sequences: [1, 2] },
      { index: 1, boundary_sequence: 3, turn_sequences: [3] },
    ]);
  });

  test('no turns, no chunks', () => {
    expect(buildShowChunks([])).toEqual([]);
  });
});

describe('buildShowReviews', () => {
  // INVARIANT: the wire carries the ANSWER — the raw verdict text AND what it
  // resolves to — because the same rules gate accept, and a client
  // re-implementing them holds a second copy of a merge gate in another
  // language.
  //
  // A FAILED review is LISTED. The raise-era rule dropped one with no raises as
  // "never happened", which is how a task whose only review was broken looked
  // un-reviewed on every surface while the gate said otherwise.
  test('a failed review is listed alongside the ones that parsed', () => {
    const turns = [
      turn(1, 'agent', {
        turn_type: 'review',
        review: report({ security: 'unparsed', data_integrity: 'unparsed' }),
      } as Partial<Turn>),
      turn(2, 'agent', {
        turn_type: 'review',
        review: report({
          security: 'unparsed',
          data_integrity: 'unparsed',
          raised_item_ids: ['r1', 'r2'],
        }),
      } as Partial<Turn>),
      turn(3, 'agent', {
        turn_type: 'review',
        review_dispatch: 'self',
        review_addressed: true,
        review: report(),
      } as Partial<Turn>),
      // Not a review at all.
      turn(4, 'agent'),
    ];

    const reviews = buildShowReviews(turns);
    // Newest first, and EVERY review turn is there — the failed one included.
    expect(reviews.map((r) => r.sequence)).toEqual([3, 2, 1]);

    expect(reviews[0].unparsed).toBe(false);
    expect(reviews[0].verdict).toBe('clean');
    expect(reviews[0].verdict_kind).toBe('clean');
    expect(reviews[0].security).toBe('none found');
    expect(reviews[0].data_integrity).toBe('none found');
    expect(reviews[0].findings).toEqual([]);
    expect(reviews[0]).toMatchObject({ dispatch: 'self', addressed: true, gates: true });

    const defaultFastReview = buildShowReviews(turns, { mode: 'low_high', gate: 'auto' });
    expect(defaultFastReview[0].gates).toBe(false);

    expect(reviews[1].raised_item_ids).toEqual(['r1', 'r2']);
    expect(reviews[1].unparsed).toBe(true);
    expect(reviews[1].verdict_kind).toBe('unparsed');

    // The one that would have been dropped: no raises, nothing parseable.
    expect(reviews[2].unparsed).toBe(true);
    expect(reviews[2].verdict_kind).toBe('unparsed');
  });

  test('no reviews, empty list', () => {
    expect(buildShowReviews([turn(1, 'agent'), turn(2, 'human')])).toEqual([]);
  });
});
