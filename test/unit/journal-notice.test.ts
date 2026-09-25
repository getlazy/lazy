/**
 * The journal NOTICE — the one thing prompt assembly may derive from the journal.
 *
 * The contract these tests pin (see docs/surface-asymmetries.md, "The journal
 * contract, precisely"): a journal entry never triggers a turn, its body is never
 * injected into a prompt, and the only journal-derived thing a prompt carries is
 * a mechanistic COUNT of entries new since the agent's last turn. Comments push
 * their full text; the journal is pulled.
 */
import { describe, test, expect } from 'bun:test';
import { getNewJournalSince, buildJournalNotice, buildPromptWithInstructions, buildNotesContext } from '../../src/task/turn-context';
import type { JournalEntry, Comment } from '../../src/types';

const makeEntry = (id: string, content: string, created_at: number): JournalEntry => ({
  id,
  task_id: 'task-1',
  content,
  created_at,
});

describe('getNewJournalSince', () => {
  const entries = [
    makeEntry('j1', 'old entry', 1000),
    makeEntry('j2', 'boundary entry', 2000),
    makeEntry('j3', 'new entry', 3000),
  ];

  test('returns only entries strictly after the cutoff', () => {
    const result = getNewJournalSince(entries, 2000);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('j3');
  });

  test('returns all entries when the cutoff predates them', () => {
    expect(getNewJournalSince(entries, 0)).toHaveLength(3);
  });

  test('returns nothing when the cutoff is after every entry', () => {
    expect(getNewJournalSince(entries, 9999)).toHaveLength(0);
  });

  test('handles an empty journal', () => {
    expect(getNewJournalSince([], 1000)).toHaveLength(0);
  });
});

describe('buildJournalNotice', () => {
  test('reports the count of new entries', () => {
    const notice = buildJournalNotice(3, 3, 'my-task');
    expect(notice).toContain('3 new journal entries since your last turn');
  });

  test('uses singular wording for a single entry', () => {
    const notice = buildJournalNotice(1, 1, 'my-task');
    expect(notice).toContain('1 new journal entry since your last turn');
    expect(notice).not.toContain('entries since your last turn');
  });

  test('returns empty string when nothing is new', () => {
    expect(buildJournalNotice(0, 7, 'my-task')).toBe('');
  });

  // The journal is append-only, so an entry's index never shifts: offset
  // (total - new) is a stable cursor to the first new entry even if more land
  // while the agent works. That is what lets the notice carry an exact read
  // call with no stored per-agent cursor state anywhere.
  test('points at the first new entry via a total-minus-new offset', () => {
    const notice = buildJournalNotice(2, 12, 'my-task');
    expect(notice).toContain('offset=10');
    expect(notice).toContain('sections=["journal"]');
    expect(notice).toContain('task_id="my-task"');
  });

  test('never emits a negative offset if the counts disagree', () => {
    // Defensive: a count larger than the total would otherwise produce
    // offset=-1, which lazy_show would reject.
    expect(buildJournalNotice(5, 2, 'my-task')).toContain('offset=0');
  });

  // INVARIANT: this is a COUNT notice. If someone ever threads entry objects in
  // and renders their text, this test is the tripwire.
  test('carries no entry content — only a count and a pointer', () => {
    const notice = buildJournalNotice(2, 2, 'my-task');
    expect(notice).toContain('COUNT ONLY');
    expect(notice).toContain('informs, it does not instruct');
    expect(notice).toContain('no journal entry ever starts a turn');
  });

  // Requirement: journal and comments must be visibly different things.
  test('is labelled distinctly from the notes/comments block', () => {
    const notice = buildJournalNotice(1, 1, 'my-task');
    const notes = buildNotesContext([
      { id: 'c1', task_id: 'task-1', content: 'do the thing', created_at: 1000 } as Comment,
    ]);
    expect(notice).toContain('JOURNAL NOTICE (information, not guidance)');
    expect(notes).toContain('NOTES ADDED SINCE YOUR LAST TURN');
    // Neither block's header appears in the other — they cannot be confused.
    expect(notice).not.toContain('NOTES ADDED SINCE YOUR LAST TURN');
    expect(notes).not.toContain('JOURNAL NOTICE');
  });
});

describe('buildPromptWithInstructions — journal notice layering', () => {
  const goal = 'Some goal';

  test('includes the notice when one is supplied', () => {
    const notice = buildJournalNotice(2, 2, 'my-task');
    const prompt = buildPromptWithInstructions('USER_PROMPT', goal, '/root', undefined, undefined, undefined, notice);
    expect(prompt).toContain('JOURNAL NOTICE');
    expect(prompt).toContain('USER_PROMPT');
  });

  test('omits the notice entirely when there is nothing new', () => {
    const prompt = buildPromptWithInstructions('USER_PROMPT', goal, '/root', undefined, undefined, undefined, undefined);
    expect(prompt).not.toContain('JOURNAL NOTICE');
    expect(prompt).not.toContain('journal');
  });

  test('keeps notes and notice as separate blocks, notice last', () => {
    const notes = buildNotesContext([
      { id: 'c1', task_id: 'task-1', content: 'COMMENT_BODY', created_at: 1000 } as Comment,
    ]);
    const notice = buildJournalNotice(1, 1, 'my-task');
    const prompt = buildPromptWithInstructions('USER_PROMPT', goal, '/root', undefined, notes, undefined, notice);

    // The comment's full body is pushed; the notice follows it, then the prompt.
    expect(prompt).toContain('COMMENT_BODY');
    expect(prompt.indexOf('NOTES ADDED SINCE YOUR LAST TURN')).toBeLessThan(prompt.indexOf('JOURNAL NOTICE'));
    expect(prompt.indexOf('JOURNAL NOTICE')).toBeLessThan(prompt.indexOf('USER_PROMPT'));
  });
});
