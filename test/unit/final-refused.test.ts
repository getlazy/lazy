/**
 * A REFUSED `lazy_final` is a declaration, not silence.
 *
 * Turn-end state is DERIVED and nothing asks the agent about it, so what the
 * refusal must do is make the ending it names READABLE: it marks the turn
 * needs-input through the same marker half a blocking `lazy_raise` already
 * sets (`makeTurnEndingCapture` in src/supervisor/index.ts), which is how the
 * supervisor — which cannot read lazy state — learns this invocation reached
 * the daemon at all. What is pinned here is that the refusal REACHES that
 * marker, and that the human gets told which items parked the task.
 *
 * Covered here: the open BLOCKING raise; a call from inside the wrap-up's
 * presentation step on a turn that did NOT declare (review 0fc553f4); and the
 * same call on a turn that DID, which is ANSWERED rather than refused (review
 * c6b6cdde) — its claim stands, and telling it otherwise would be the same
 * disagreeing-records failure pointing the other way.
 *
 * The journal is the human-facing channel deliberately. There is no structured
 * "parked reason" field, and inventing a status or a UI surface for one is
 * explicitly out of scope for this pass — a real reviewable / needs-input status
 * belongs to `task-statechart-refactor`. A journal entry never enters a prompt
 * and never starts a turn, so it informs without steering the agent.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// --- Scenario state, reset per test ---

const metadata = new Map<string, string>();
const journalEntries: Array<{ taskId: string; content: string; actor: string }> = [];
const needsInputMarks: string[] = [];
const finalClaims: Array<{ taskId: string; sha: string }> = [];
let raisedItems: Array<{ id: string; content: string; blocking: boolean; status: string }> = [];
/** The phase the supervisor has checkpointed, or null for "no status file". */
let supervisorPhase: string | null = null;
/** The claim the supervisor recorded for THIS turn's work invocation, if any. */
let declaredFinalOnStatus: { sha: string; declared_at: string } | null = null;

await mockModule(resolve(import.meta.dir, '../../src/daemon/turn-ending-registry.ts'), () => ({
  recordFinalClaim: async (taskId: string, claim: { sha: string }) => {
    finalClaims.push({ taskId, sha: claim.sha });
  },
  recordNeedsInput: async (taskId: string) => {
    needsInputMarks.push(taskId);
  },
}));

await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  getCurrentSha: async () => 'abcdef1234567890',
}));

// The supervisor's own status checkpoint is the seam the presentation-step
// refusal reads. Mocked rather than written to a real protocol dir because
// which PHASE is current is the whole variable under test.
await mockModule(resolve(import.meta.dir, '../../src/utils/working-substate.ts'), () => ({
  readSupervisorStatusAsync: async () => (supervisorPhase
    ? { phase: supervisorPhase, ...(declaredFinalOnStatus ? { declared_final: declaredFinalOnStatus } : {}) }
    : null),
}));

const { declareFinal, FinalRefusedError } = await import('../../src/daemon/final-claim-service');

afterAll(() => restoreMockedModules());

function storage(): any {
  return {
    getTaskRaisedItems: async () => raisedItems,
    getTaskMetadata: async (taskId: string, key: string) => metadata.get(`${taskId}:${key}`) ?? null,
    updateTaskMetadata: async (taskId: string, key: string, value: string) => {
      metadata.set(`${taskId}:${key}`, value);
    },
    appendJournalEntry: async (taskId: string, content: string, actor: string) => {
      journalEntries.push({ taskId, content, actor });
    },
  };
}

function blocking(id: string, content: string) {
  return { id, content, blocking: true, status: 'open' };
}

beforeEach(() => {
  metadata.clear();
  journalEntries.length = 0;
  needsInputMarks.length = 0;
  finalClaims.length = 0;
  raisedItems = [];
  supervisorPhase = null;
  declaredFinalOnStatus = null;
});

const params = () => ({ storage: storage(), taskId: 'task-1', worktreePath: '/tmp/wt' });

describe('a refused final', () => {
  // INVARIANT: the refusal marks the turn needs-input, so the supervisor —
  // which cannot read lazy state — ends the turn knowing which of the three
  // endings this was. Losing the mark makes a turn the daemon has already
  // classified look like one that just stopped and said nothing.
  test('marks the turn needs-input before it throws', async () => {
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];

    await expect(declareFinal(params())).rejects.toBeInstanceOf(FinalRefusedError);
    expect(needsInputMarks).toEqual(['task-1']);
    expect(finalClaims).toEqual([]);
  });

  test('names every open blocking item in the refusal the agent receives', async () => {
    raisedItems = [
      blocking('raise-1', 'Should the flag default on?'),
      blocking('raise-2', 'Keep or revert the alias?'),
    ];

    let message = '';
    try {
      await declareFinal(params());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('needs-input, not final');
    expect(message).toContain('raise-1');
    expect(message).toContain('raise-2');
  });

  test('journals the ids that parked the task, as a system entry', async () => {
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];

    await expect(declareFinal(params())).rejects.toThrow();
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0]!.actor).toBe('system');
    expect(journalEntries[0]!.content).toContain('Final refused');
    expect(journalEntries[0]!.content).toContain('raise-1');
  });

  // An agent that resolves nothing and calls again should leave ONE note, not
  // one per attempt — the journal is what a human reads afterwards.
  test('is journalled once per open-raise set, not once per attempt', async () => {
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];
    const p = params();

    await expect(declareFinal(p)).rejects.toThrow();
    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(1);
    // But the marker is written EVERY time: it is per-turn state the supervisor
    // clears before each invocation, so deduping it would lose the suppression
    // on the second turn.
    expect(needsInputMarks).toEqual(['task-1', 'task-1']);

    // A DIFFERENT open set is a different fact and gets its own note.
    raisedItems = [blocking('raise-2', 'A new decision')];
    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(2);
    expect(journalEntries[1]!.content).toContain('raise-2');
  });

  // Best-effort by construction: the refusal is what the agent must receive, and
  // a journal or marker failure may not turn it into some other error.
  test('a failing journal still produces the refusal', async () => {
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];
    const broken = {
      ...storage(),
      appendJournalEntry: async () => { throw new Error('store down'); },
    };
    await expect(declareFinal({ storage: broken as any, taskId: 'task-1', worktreePath: '/tmp/wt' }))
      .rejects.toBeInstanceOf(FinalRefusedError);
  });

  // INVARIANT: the dedupe marker is written AFTER the entry it suppresses, so a
  // failed write is retried rather than silenced. Marker-first, one storage
  // hiccup made the note unreachable for that id set forever, and the human was
  // left with a task parked for no visible reason — a mechanism that disarms
  // itself on its first bad day is indistinguishable from not having it.
  test('a journal write that fails is retried on the next refusal, not suppressed', async () => {
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];

    let failNext = true;
    const flaky = {
      ...storage(),
      appendJournalEntry: async (taskId: string, content: string, actor: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('store down');
        }
        journalEntries.push({ taskId, content, actor });
      },
    };
    const p = { storage: flaky as any, taskId: 'task-1', worktreePath: '/tmp/wt' };

    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(0);

    // The second refusal, same open set, must try again and succeed.
    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0]!.content).toContain('raise-1');

    // And once it HAS landed, the dedupe holds as before.
    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(1);
  });
});

describe('a final refused because it came from the walkthrough step', () => {
  // INVARIANT (review 0fc553f4): `lazy_final` called from inside the wrap-up's
  // presentation step is REFUSED, not answered "recorded" and then dropped.
  //
  // The supervisor drops such a claim (`carriedFinal`, src/supervisor/wrap-up.ts)
  // because the walkthrough step does not decide how a turn ended. Until this
  // refusal existed the daemon still said yes: it recorded the claim, cleared
  // the refused-final marker, logged that the agent had declared, and the
  // supervisor then threw the claim away with only a warning. An agent that
  // believed it had handed the work over said so in its own summary, next to a
  // task showing "Not declared done" — two records of the same moment that
  // disagree, with nothing anywhere saying which is right. The tool already
  // knew how to say no; this is the second thing it says no to.
  test('is refused, and records nothing at all', async () => {
    supervisorPhase = 'present';

    let message = '';
    try {
      await declareFinal(params());
    } catch (err) {
      expect(err).toBeInstanceOf(FinalRefusedError);
      message = (err as Error).message;
    }
    expect(message).toContain('walkthrough step');
    expect(message).toContain('does not decide how the turn ended');

    // Nothing was written: no claim, and — unlike the blocking-raise refusal —
    // no needs-input mark and no journal entry. This refusal is not a statement
    // about how the turn ended; the work invocation already made that.
    expect(finalClaims).toEqual([]);
    expect(needsInputMarks).toEqual([]);
    expect(journalEntries).toEqual([]);
  });

  // INVARIANT (review c6b6cdde): the refusal fires only on a turn that did NOT
  // declare. On a turn that DID, the claim stands — it was made by the work
  // invocation, it is recorded, and a review will dispatch on it — so refusing
  // with "declare it in your next WORK turn" would tell that agent its
  // declaration did not land. That is the same disagreeing-records failure the
  // refusal was added to end, pointing the other way: the agent writes a
  // summary saying it could not hand the work over, next to a task showing a
  // standing final, and nothing says which record is right.
  test('a turn that ALREADY declared is answered, not refused', async () => {
    supervisorPhase = 'present';
    declaredFinalOnStatus = { sha: 'workshaworkshaworksha', declared_at: '2026-09-20T10:00:00.000Z' };

    const result = await declareFinal(params());

    // Answered with the STANDING claim, not a fresh one at this step's head.
    expect(result.sha).toBe('workshaworkshaworksha');
    expect(result.alreadyDeclared).toBe(true);
    expect(result.at).toBe(Date.parse('2026-09-20T10:00:00.000Z'));
    // Idempotent: nothing was written, because nothing needed to be.
    expect(finalClaims).toEqual([]);
    expect(needsInputMarks).toEqual([]);
    expect(journalEntries).toEqual([]);
  });

  // The wording is part of the fix, not decoration: what an UNDECLARED turn is
  // told must not describe a declaration that does exist.
  test('the refusal an undeclared turn gets says THIS turn ended without a final', async () => {
    supervisorPhase = 'present';
    declaredFinalOnStatus = null;

    let message = '';
    try {
      await declareFinal(params());
    } catch (err) {
      expect(err).toBeInstanceOf(FinalRefusedError);
      message = (err as Error).message;
    }
    expect(message).toContain('walkthrough step');
    expect(message).toContain('ended WITHOUT a final');
  });

  // It is about the INVOCATION, not the task: the same task declaring from its
  // work turn is the ordinary happy path, and must not be caught by this.
  test('the same task declares fine from its work invocation', async () => {
    supervisorPhase = 'work';
    const result = await declareFinal(params());
    expect(result.sha).toBe('abcdef1234567890');
    expect(finalClaims).toEqual([{ taskId: 'task-1', sha: 'abcdef1234567890' }]);
  });

  // The other wrap-up steps run ONLY on a turn that already declared, so a
  // claim made in one is redundant and true — and is carried home, not dropped.
  // Refusing there would refuse a declaration the turn had already made.
  test('the other wrap-up steps are not refused', async () => {
    for (const phase of ['permission_pushback', 'maintain', 'react', 'present_done']) {
      supervisorPhase = phase;
      finalClaims.length = 0;
      await expect(declareFinal(params())).resolves.toMatchObject({ sha: 'abcdef1234567890' });
      expect(finalClaims).toHaveLength(1);
    }
  });

  // Fails OPEN by construction: an unreadable status must never cost an agent a
  // declaration it is entitled to make. The supervisor-side drop is the
  // backstop, so a missed refusal degrades to exactly the old behaviour.
  test('an unreadable supervisor status does not refuse', async () => {
    supervisorPhase = null;
    await expect(declareFinal(params())).resolves.toMatchObject({ sha: 'abcdef1234567890' });
  });

  // Checked BEFORE the blocking-raise refusal, and the message says which one
  // it is: from the walkthrough step there is no declaration to make whatever
  // else is open, and answering with the raise list would send the agent off to
  // resolve items it cannot act on from there.
  test('takes precedence over an open blocking raise', async () => {
    supervisorPhase = 'present';
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];

    let message = '';
    try {
      await declareFinal(params());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('walkthrough step');
    expect(message).not.toContain('raise-1');
    // And none of the blocking-raise refusal's side effects fired.
    expect(needsInputMarks).toEqual([]);
    expect(journalEntries).toEqual([]);
  });
});

describe('a final that succeeds', () => {
  test('records the claim at HEAD and marks nothing needs-input', async () => {
    const result = await declareFinal({ ...params(), note: 'Pencils down.' });

    expect(result.sha).toBe('abcdef1234567890');
    expect(result.note).toBe('Pencils down.');
    expect(finalClaims).toEqual([{ taskId: 'task-1', sha: 'abcdef1234567890' }]);
    expect(needsInputMarks).toEqual([]);
    expect(journalEntries).toEqual([]);
  });

  // A non-blocking raise is not an ENDING — it never gated accept and must not
  // refuse a final either.
  test('an open NON-blocking raise does not refuse it', async () => {
    raisedItems = [{ id: 'fyi-1', content: 'unrelated', blocking: false, status: 'open' }];
    await expect(declareFinal(params())).resolves.toBeTruthy();
  });

  test('ends the refusal episode, so a reopened item is journalled again', async () => {
    const p = params();
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];
    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(1);

    // Answered — the final goes through and clears the dedupe marker.
    raisedItems = [];
    await declareFinal(p);

    // Reopened later: a fresh episode, journalled again rather than deduped away.
    raisedItems = [blocking('raise-1', 'Should the flag default on?')];
    await expect(declareFinal(p)).rejects.toThrow();
    expect(journalEntries).toHaveLength(2);
  });
});
