/**
 * The Turns tab reviews CHUNK by chunk, and every card says WHEN.
 *
 * Two pieces of engineer feedback, one surface:
 *
 *  - Turns were reviewed turn by turn. Each turn was its own viewable card, so
 *    the tick, the collapse and every j/k/n/p stop split apart the turns we
 *    group for a reason — a supervisor nudge, the auto-resume it caused and the
 *    agent work that followed read as three unrelated items. The CHUNK is the
 *    unit of review now; the turns inside are plain <details>.
 *  - "What changed for you" said what changed and not when, so the time cost a
 *    click through to the turn.
 *
 * The chunk BOUNDARY rule itself is not retested here — it lives in
 * turn-chunks.test.ts and this surface reuses `groupTurnsIntoChunks` through
 * `foldRecordIntoChunks`. What is tested here is the presentation contract.
 */

import { describe, test, expect } from 'bun:test';
import type { Turn, Task, Session, Actor, TurnReport } from '../../src/types';
import { taskTurnsSectionHtml, chunkIntentLine, commentCardHtml } from '../../src/server/templates';
import { agentReportHtml } from '../../src/server/review';
import { relativeTime, absoluteTime, timestampHtml } from '../../src/server/timestamps';
import { NO_LAUNCH_LABEL } from '../../src/utils/turn-labels';

const T0 = 1_700_000_000_000;

function turn(
  seq: number,
  role: Turn['role'],
  opts: { actor?: Actor; auto?: boolean; content?: string; id?: string } = {},
): Turn {
  return {
    id: opts.id ?? `t${seq}-${role}`,
    session_id: 's',
    sequence: seq,
    role,
    content: opts.content ?? `body of turn ${seq}`,
    timestamp: T0 + seq * 60_000,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.auto !== undefined ? { auto_triggered: opts.auto } : {}),
  };
}

/** human ask → agent → supervisor nudge → agent → human ask → agent. Two chunks. */
function scenario(): Turn[] {
  return [
    turn(1, 'human', { actor: 'human', content: 'Please add the retry path' }),
    turn(2, 'agent', { content: 'agent work A1' }),
    turn(3, 'human', { actor: 'supervisor', auto: true, content: 'supervisor nudge' }),
    turn(4, 'agent', { content: 'agent work A2' }),
    turn(5, 'human', { actor: 'human', content: 'Now handle the empty input' }),
    turn(6, 'agent', { content: 'agent work B1' }),
  ];
}

const task: Task = {
  id: 'task-chunks',
  code: 'chunk-demo',
  goal: 'chunks',
  prompt: 'chunks',
  type: 'task',
  status: 'blocked',
  created_at: T0,
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
  task_id: 'task-chunks',
  agent_id: 'claude',
  runner_type: null,
  started_at: T0,
  ended_at: null,
  outcome: null,
  git_branch: 'lazy/chunks',
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

describe('the chunk is the unit of review', () => {
  // INVARIANT: one rv-viewable section per CHUNK, never per turn. Navigation,
  // the Viewed tick and collapse all run off `.rv-viewable[data-viewed-key]`
  // (review-navigation.ts, viewed-cards.ts), so making the chunk the section
  // is what makes every one of them move a chunk at a time. A turn that is
  // its own section puts a stop between a nudge and the work it caused.
  test('each chunk is one viewable card and no turn is a section', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    const chunkKeys = html.match(/data-viewed-key="card:chunk:\d+"/g) ?? [];
    expect(chunkKeys.length).toBe(2);
    expect(html).not.toContain('data-viewed-key="card:turn:');
    // Every turn is still rendered, inside a chunk.
    for (let seq = 1; seq <= 6; seq++) {
      expect(html).toContain(`>Turn #${seq}</a>`);
    }
  });

  // INVARIANT: ONE numbering for a chunk. The `#chunk-N` anchor, the
  // `card:chunk:N` viewed key and the "Chunk N" a human reads are the same N.
  // They were 1-based, 0-based and 1-based respectively — a one-off waiting
  // for the next surface that links a chunk to pick the wrong one.
  test('the chunk anchor, viewed key and label share one number', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    for (const n of [1, 2]) {
      expect(html).toContain(`id="chunk-${n}"`);
      expect(html).toContain(`data-viewed-key="card:chunk:${n}"`);
      expect(html).toContain(`Chunk ${n} ·`);
    }
    // No 0-based leftovers on either route.
    expect(html).not.toContain('id="chunk-0"');
    expect(html).not.toContain('data-viewed-key="card:chunk:0"');
  });

  test('the chunk heading carries the opening turn and its intent', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    expect(html).toContain('Chunk 1 · #1 [human]');
    expect(html).toContain('Chunk 2 · #5 [human]');
    expect(html).toContain('<span class="turn-chunk-intent">Please add the retry path</span>');
    expect(html).toContain('<span class="turn-chunk-intent">Now handle the empty input</span>');
  });

  test('the chunk heading counts what is in it, notes included', () => {
    const html = taskTurnsSectionHtml(task, session, scenario(), 'newest', {
      comments: [{ id: 'c1', task_id: 'task-chunks', content: 'a note', created_at: T0 + 90_000, actor: 'human' }],
    });
    // Chunk 1 holds turns 1–4 plus the comment stamped between them.
    expect(html).toContain('4 turns · 1 note');
    expect(html).toContain('2 turns');
    // The note keeps its anchor so "Since you last looked" can link to it.
    expect(html).toContain('id="comment-c1"');
  });

  // The forge badge is part of a comment's head line, so it has to come from
  // the one function that builds that line — both surfaces read it from there.
  // Composed per call site, the next change to how a forge comment is labelled
  // would badge it on the Comments tab and not inside its chunk.
  test('a forge comment is badged the same inside a chunk as on the Comments tab', () => {
    const remote = {
      id: 'c-remote',
      task_id: 'task-chunks',
      content: 'a review note from the PR',
      created_at: T0 + 90_000,
      actor: 'human' as const,
      source: 'remote' as const,
    };
    const inChunk = taskTurnsSectionHtml(task, session, scenario(), 'newest', {
      comments: [remote],
    });
    expect(inChunk).toContain('from the pull request');
    // Same head text as the standalone card the Comments tab renders.
    expect(commentCardHtml(remote)).toContain('from the pull request');
    // …and a local comment is not badged on either.
    const local = { ...remote, id: 'c-local', source: undefined };
    expect(commentCardHtml(local)).not.toContain('from the pull request');
  });

  // INVARIANT: when a sequence has both halves, the AGENT turn owns
  // `#turn-<seq>`. Every inbound "Turn #N" link is built from a report or an
  // agent turn, so the reader is going to the ANSWER; chunks render
  // newest-first, so anchoring the human half landed them on the ask with the
  // thing they clicked off-screen above it. Still exactly one id per sequence
  // — two would make the browser pick.
  test('the agent half owns the anchor when a sequence has both', () => {
    const shared = [
      turn(1, 'human', { actor: 'human', id: 'h1' }),
      turn(1, 'agent', { id: 'a1' }),
      turn(2, 'agent', { id: 'a2' }),
    ];
    const html = taskTurnsSectionHtml(task, session, shared);
    expect((html.match(/id="turn-1"/g) ?? []).length).toBe(1);
    expect((html.match(/id="turn-2"/g) ?? []).length).toBe(1);
    // WHICH half: the anchor sits on the agent turn's <details>, and the human
    // half carries the non-anchor id instead.
    expect(html).toContain('id="turn-1"');
    const anchored = html.slice(html.indexOf('id="turn-1"'));
    expect(anchored.slice(0, anchored.indexOf('</details>'))).toContain('[agent]');
    expect(html).toContain('id="turn-x-h1"');
  });

  test('a sequence with only a human ask still anchors it', () => {
    const html = taskTurnsSectionHtml(task, session, [
      turn(1, 'human', { actor: 'human', id: 'h1' }),
    ]);
    expect((html.match(/id="turn-1"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('id="turn-x-h1"');
  });

  // INVARIANT (unchanged by chunk cards): the tab reads in ONE direction —
  // newest chunk first AND newest turn first inside it. The mixed order was
  // two timelines on one page.
  test('newest-first still applies to chunks and to the turns inside them', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    expect(html.indexOf('Chunk 2 ·')).toBeLessThan(html.indexOf('Chunk 1 ·'));
    const chunk2 = html.slice(html.indexOf('Chunk 2 ·'), html.indexOf('Chunk 1 ·'));
    expect(chunk2.indexOf('>Turn #6</a>')).toBeLessThan(chunk2.indexOf('>Turn #5</a>'));
  });

  test('the tab says the review unit out loud', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    expect(html).toContain('Review one chunk at a time');
  });

  // INVARIANT: a turn link on the Turns tab is an IN-PAGE anchor. The absolute
  // `/tasks/:id/turns/:n` 302s back to this same tab — a full navigation to
  // reach an element already in the document — and a full navigation fires
  // `beforeunload`, which closes every open web shell. That is the documented
  // reason the tab-switch island exists; a self-link must not undo it.
  test('a turn links to its own anchor, not back through the redirect', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    for (let seq = 1; seq <= 6; seq++) {
      expect(html).toContain(`<a href="#turn-${seq}"`);
    }
    expect(html).not.toContain(`href="/tasks/${task.id}/turns/1"`);
  });
});

/**
 * Two things the standalone turn page carried that are INFORMATION, not the
 * fragmentation it was removed for, so they had to come back on the chunk view.
 */
describe('what the turn page carried, kept on the chunk view', () => {
  // INVARIANT: "Ran as" is ALWAYS rendered. A turn lazy wrote itself has no
  // launch labels, and a blank slot asks the reader to infer "nothing ran"
  // from empty space — which reads as a rendering bug, not a fact. The
  // difference between "an agent ran this" and "lazy wrote this" must be
  // legible in WORDS.
  test('a lazy-authored turn says in words that no agent ran', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    expect(html).toContain(NO_LAUNCH_LABEL);
    expect(html).toContain('not applicable — written by lazy, no agent ran');
    // Exactly the supervisor nudge. `turnRanNoAgent` is narrow on purpose: a
    // human ask is not "written by lazy", and an agent turn that recorded
    // nothing says `unknown` rather than claiming nothing ran.
    expect((html.match(/turn-ran-as-none/g) ?? []).length).toBe(1);
  });

  // INVARIANT: the row appears wherever "did an agent run, and which?" is a
  // real question — agent turns and lazy-authored ones — and NOWHERE else. On
  // a turn the human typed, `agent: unknown · model: unknown · effort:
  // unknown` is worse than the blank it replaced: those fields are not
  // unknown, they are inapplicable, and printing `unknown` asserts something
  // false on every chunk boundary.
  test('the row covers the turns where launch is a real question, and no others', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    // Six turns: two human asks (no row), three agent turns, one supervisor
    // nudge — four rows.
    expect((html.match(/<div class="turn-ran-as/g) ?? []).length).toBe(4);
    // Specifically: neither human turn carries one. `unknown` on an AGENT turn
    // that recorded nothing is right and stays — the field is genuinely
    // unknown there, where on a human turn it is inapplicable.
    for (const seq of [1, 5]) {
      const block = html.slice(html.indexOf(`id="turn-${seq}"`));
      const upToNext = block.slice(0, block.indexOf('</details>'));
      expect(upToNext).not.toContain('turn-ran-as');
    }
  });

  // The predicate is the project's one definition of a genuine human/builder
  // intervention, not a third spelling of it — a builder turn is suppressed
  // for the same reason a human one is, and an auto-triggered "human" turn is
  // automation and keeps its row.
  test('a builder turn is suppressed too; an auto-triggered one is not', () => {
    const builder = taskTurnsSectionHtml(task, session, [
      turn(1, 'human', { actor: 'builder' }),
      turn(2, 'agent'),
    ]);
    expect((builder.match(/<div class="turn-ran-as/g) ?? []).length).toBe(1);

    const auto = taskTurnsSectionHtml(task, session, [
      turn(1, 'human', { actor: 'system', auto: true }),
      turn(2, 'agent'),
    ]);
    expect((auto.match(/<div class="turn-ran-as/g) ?? []).length).toBe(2);
    expect(auto).toContain(NO_LAUNCH_LABEL);
  });

  test('a turn an agent ran names the agent, model and effort instead', () => {
    const turns = [
      turn(1, 'human', { actor: 'human' }),
      {
        ...turn(2, 'agent'),
        agent: 'claude-code',
        model: 'opus',
        model_id: 'claude-opus-5',
        effort: 'high',
      } as Turn,
    ];
    const html = taskTurnsSectionHtml(task, session, turns);
    expect(html).toContain('Ran as');
    expect(html).toContain('agent: claude-code');
    expect(html).toContain('effort: high');
    // Nothing here was written by lazy, so nothing claims to be.
    expect(html).not.toContain(NO_LAUNCH_LABEL);
  });

  // A turn number in a pasted link or a report is only locatable if the page
  // says where it sits. Counted over DISTINCT sequences, so a human and an
  // agent turn sharing one are a single position.
  test('each turn says which turn of how many it is', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    expect(html).toContain('>(1 of 6)<');
    expect(html).toContain('>(6 of 6)<');
    expect(html).not.toContain('of 7)<');
  });

  test('a shared sequence counts once, so the total is positions not rows', () => {
    const shared = [
      turn(1, 'human', { actor: 'human', id: 'h1' }),
      turn(1, 'agent', { id: 'a1' }),
      turn(2, 'agent', { id: 'a2' }),
    ];
    const html = taskTurnsSectionHtml(task, session, shared);
    // Three turns, two sequences → "of 2", never "of 3".
    expect(html).toContain('>(1 of 2)<');
    expect(html).toContain('>(2 of 2)<');
    expect(html).not.toContain('of 3)<');
  });
});

describe('chunkIntentLine', () => {
  test('takes the first meaningful line and strips markdown noise', () => {
    expect(chunkIntentLine(turn(1, 'human', { content: '\n\n## Please fix the retry\n\nmore' })))
      .toBe('Please fix the retry');
  });

  test('truncates with an ellipsis rather than running off the header', () => {
    const long = 'x'.repeat(300);
    const out = chunkIntentLine(turn(1, 'human', { content: long }), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith('…')).toBe(true);
  });

  test('an empty turn contributes no intent line', () => {
    expect(chunkIntentLine(turn(1, 'human', { content: '   \n\n' }))).toBe('');
  });
});

describe('timestamps are visible, not one click away', () => {
  test('relative text with the exact time in the title', () => {
    const ts = Date.now() - 3 * 60_000;
    const html = timestampHtml(ts);
    expect(html).toContain('>3m ago<');
    expect(html).toContain(`title="${absoluteTime(ts)}"`);
    expect(html).toContain('<time class="lz-when"');
    expect(html).toContain(`datetime="${new Date(ts).toISOString()}"`);
  });

  test('absolute mode swaps the two, so neither form is ever missing', () => {
    const ts = Date.now() - 3 * 60_000;
    const html = timestampHtml(ts, { absolute: true });
    expect(html).toContain(`>${absoluteTime(ts)}<`);
    expect(html).toContain(`title="${relativeTime(ts)}"`);
  });

  // INVARIANT: a degraded timestamp DEGRADES — it never takes the page down.
  // `new Date(NaN).toISOString()` throws RangeError, so one unparseable value
  // in one turn record would have 500'd the whole task page: every other turn,
  // the diff, the actions, all of it, over a field that is decoration. The
  // ad-hoc formatters this helper replaced degraded by accident; this one does
  // it on purpose.
  test.each([NaN, Infinity, -Infinity, 8.64e15 + 1])(
    'a non-date value renders as unknown rather than throwing (%p)',
    (bad) => {
      expect(() => timestampHtml(bad)).not.toThrow();
      const html = timestampHtml(bad);
      expect(html).toContain('>unknown<');
      // No `datetime` at all: an attribute a machine would read must not carry
      // a value that is not a date.
      expect(html).not.toContain('datetime=');
    },
  );

  test('a whole page still renders when one turn carries a broken timestamp', () => {
    const turns = scenario();
    turns[2] = { ...turns[2]!, timestamp: NaN };
    let html = '';
    expect(() => { html = taskTurnsSectionHtml(task, session, turns); }).not.toThrow();
    expect(html).toContain('>unknown<');
    // …and every other turn is unaffected.
    for (let seq = 1; seq <= 6; seq++) expect(html).toContain(`>Turn #${seq}</a>`);
  });

  test('a turn in a chunk shows when it happened', () => {
    const html = taskTurnsSectionHtml(task, session, scenario());
    expect((html.match(/<time class="lz-when"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  // The feedback verbatim: "Summary 'What changed for you' has no time when
  // something happened. I have to click on the turn to get that."
  test('"What changed for you" carries the turn time', () => {
    const report: TurnReport = {
      id: 'r1',
      task_id: task.id,
      session_id: 's',
      turn_sequence: 6,
      sections: [{ kind: 'behavior_change', body: 'The retry path now backs off.' }],
      created_at: T0,
    };
    const agentTurn = turn(6, 'agent');
    const html = agentReportHtml(task.id, agentTurn, report, { surface: 'landing' });
    expect(html).toContain('What changed for you');
    expect(html).toContain('<time class="lz-when"');
    expect(html).toContain(`title="${absoluteTime(agentTurn.timestamp)}"`);
  });

  // No turn to hand (the report was stored before the turn was stamped): the
  // report's own created_at is still a true answer to "when".
  test('a report with no turn falls back to its own timestamp', () => {
    const report: TurnReport = {
      id: 'r2',
      task_id: task.id,
      session_id: 's',
      sections: [{ kind: 'behavior_change', body: 'Something changed.' }],
      created_at: T0,
    };
    const html = agentReportHtml(task.id, null, report, { surface: 'landing' });
    expect(html).toContain(`title="${absoluteTime(T0)}"`);
  });
});
