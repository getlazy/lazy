/**
 * Rendering tests for raised-item state badges and the ids that used to sit
 * beside them.
 *
 * INVARIANT (ui-raised-rendering): a raised item's gate and its decision are
 * rendered as BADGES from one vocabulary (src/raised/vocabulary.ts), on every
 * surface that shows a raised item. Each badge pairs an emoji with a word, and
 * carries a `tag-*` tone class the stylesheet actually defines — the review
 * summary used to emit `tag-blocking`, which no stylesheet has ever defined, so
 * "gates accept" rendered as unstyled grey text and read as debug output.
 *
 * INVARIANT (ui-raised-rendering): no surface prints a raised item's id, or a
 * truncation of one, as reader-facing text. The id rides `data-raised-id` for
 * scripts and appears ONCE as a labelled full-length `<code>` in the item
 * panel's provenance, for whoever passes it to `lazy accept
 * --respond-raised`. Short hex beside a link that already goes to the right
 * place is noise, and it took a reader two days to work out those rows were a
 * UI at all.
 */

import { describe, test, expect } from 'bun:test';
import { agentReportHtml, raisedItemsSummary } from '../../src/server/review';
import { raisedInboxHtml, raisedPanelHtml } from '../../src/server/raised';
import { taskRaisedSectionHtml } from '../../src/server/templates';
import { raisedDecisionBadgeHtml, raisedGateBadgeHtml, raisedIdLineHtml } from '../../src/server/raised-badges';
import { RAISED_RESOLUTION_FLAGS } from '../../src/cli/raised-resolutions';
import { raisedDecisionVocabulary, raisedGateVocabulary } from '../../src/raised/vocabulary';
import { bundledStylesheet } from '../../src/server/styles';
import type { RaisedItem, RaisedItemStatus } from '../../src/types';
import type { ListedRaisedItem } from '../../src/raised';
import type { TaskCodeTables } from '../../src/server/task-urls';

/** Every tone the vocabulary can ask for must exist in the shipped stylesheet. */
const TONE_CLASSES = ['tag-danger', 'tag-warning', 'tag-success', 'tag-accent', 'tag-neutral'];

const ITEM_ID = 'a124979118aa4f0e9c1b2233445566aa';
/**
 * The panel fixture carries a session id and a promoted task with NO code on
 * purpose. The first version of this file omitted `session_id`, so the
 * no-stray-hex assertion passed on a panel that never rendered the provenance
 * `Session 3bc4fb1e` line — the exact string the report named. A fixture that
 * omits the field its assertion polices is worse than no test: it is a standing
 * claim the bug is absent.
 */
const SESSION_ID = '3bc4fb1e77cc4d2a8e0f1122334455bb';
const UNCODED_TASK_ID = 'deadbeefcafe1234';

function raised(overrides: Partial<RaisedItem> = {}): RaisedItem {
  return {
    id: ITEM_ID,
    task_id: 'task-1',
    content: 'Should the new flag default on?',
    created_at: 1,
    status: 'open',
    blocking: true,
    ...overrides,
  } as RaisedItem;
}

function listed(overrides: Partial<ListedRaisedItem> = {}): ListedRaisedItem {
  return {
    id: ITEM_ID,
    task_id: 'task-1',
    task_code: 'demo-task',
    task_goal: 'Do the thing',
    task_status: 'blocked',
    content: 'Should the new flag default on?',
    blocking: true,
    title: 'Should the new flag default on?',
    status: 'open',
    resolution: null,
    resolved_at: null,
    created_at: 1,
    session_id: SESSION_ID,
    recurrence_id: ITEM_ID,
    recurrence_size: 1,
    possibly_promoted: false,
    promoted_to_task_ids: [],
    promoted_task_id: null,
    promoted_task_code: null,
    age_days: 1,
    duplicate_count: 1,
    duplicate_ids: [ITEM_ID],
    ...overrides,
  } as ListedRaisedItem;
}

/** Any 8+ run of hex that a reader would see — ids, not words. */
function strayHex(html: string): string[] {
  // Attribute values are machine-readable (data-raised-id, href) and fine; what
  // is being hunted is hex in TEXT nodes.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]*>/g, ' ');
  return text.match(/\b[0-9a-f]{8,}\b/g) ?? [];
}

describe('raised-item badges', () => {
  // INVARIANT: a badge tone is worthless unless the shipped stylesheet defines
  // it. `tag-blocking` was rendered for months and styled by nothing, which is
  // the whole reason "gates accept" read as stray text rather than as a badge.
  test('every tone the vocabulary can ask for is defined in the shipped stylesheet', () => {
    const css = bundledStylesheet();
    for (const tone of TONE_CLASSES) {
      expect(css).toContain(`.${tone}`);
    }
    expect(css).toContain('.lz-raised-badge');
  });

  test('every gate and decision badge pairs an emoji with a word', () => {
    const entries = [
      raisedGateVocabulary(true),
      raisedGateVocabulary(false),
      ...(['open', 'responded', 'answered', 'acknowledged', 'dismissed', 'promoted_subtask', 'promoted_peer'] as RaisedItemStatus[])
        .map(raisedDecisionVocabulary),
    ];
    for (const entry of entries) {
      expect(entry.emoji.length).toBeGreaterThan(0);
      // The word is what survives a screen reader, a terminal that cannot draw
      // the glyph, and a copy-paste.
      expect(entry.label).toMatch(/[A-Za-z]/);
      expect(entry.phrase).toMatch(/[A-Za-z]/);
      expect(entry.hint).toMatch(/[A-Za-z]/);
      // INVARIANT: the label is what a width-computed column renders, so it
      // carries NO glyph. An emoji is two terminal cells in some emulators and
      // zero in others; one inside a `padEnd` silently misaligns every row
      // after it, which is why PROTECTED_MARKER is ASCII too.
      expect(entry.label).not.toContain(entry.emoji);
    }
  });

  test('a gate badge is toned with a class the stylesheet defines', () => {
    const blocking = raisedGateBadgeHtml(true, 'full');
    expect(blocking).toContain('🛑');
    expect(blocking).toContain('Blocking — gates accept');
    expect(TONE_CLASSES.some((c) => blocking.includes(c))).toBe(true);
    // The class that made this unreadable in the first place.
    expect(blocking).not.toContain('tag-blocking');

    const fyi = raisedGateBadgeHtml(false);
    expect(fyi).toContain('⚠️');
    expect(fyi).toContain('FYI');
    expect(TONE_CLASSES.some((c) => fyi.includes(c))).toBe(true);
  });

  test('decided states stay distinct and never render the raw stored status', () => {
    const seen = new Set<string>();
    for (const status of ['responded', 'acknowledged', 'dismissed', 'promoted_subtask', 'promoted_peer'] as RaisedItemStatus[]) {
      const html = raisedDecisionBadgeHtml(status);
      expect(html).toContain('✅');
      // `promoted_subtask` is an enum spelling, not a sentence for a human.
      expect(html).not.toContain(status);
      seen.add(raisedDecisionVocabulary(status).label);
    }
    // Five statuses, five labels — nothing collapses into a generic "resolved".
    expect(seen.size).toBe(5);
    expect(raisedDecisionBadgeHtml('open')).not.toContain('✅');
  });

  test('a promoted badge links to the task it became, by code', () => {
    const html = raisedDecisionBadgeHtml('promoted_subtask', {
      promotedTaskId: 'task-9',
      promotedTaskCode: 'stream-merge-progress',
    });
    expect(html).toContain('Promoted to subtask');
    // The href carries the promoted task's code, like every task URL.
    expect(html).toContain('href="/tasks/stream-merge-progress"');
    expect(html).toContain('stream-merge-progress');
  });

  // INVARIANT: the route to the promoted task is the point of the badge. A task
  // with no code yet is linked as the word "task" — never dropped, and never
  // labelled with a hex id.
  test('a promoted task with no code is still linked, without showing a hex id', () => {
    const html = raisedDecisionBadgeHtml('promoted_peer', {
      promotedTaskId: 'deadbeefcafe1234',
      promotedTaskCode: null,
    });
    expect(html).toContain('href="/tasks/deadbeefcafe1234"');
    expect(html).toContain('→ task');
    expect(strayHex(html)).toEqual([]);
  });
});

describe('raised-item surfaces show no stray ids', () => {
  const items: RaisedItem[] = [
    raised({ id: ITEM_ID, blocking: true }),
    raised({ id: '3bc4fb1e77cc4d2a8e0f1122334455bb', blocking: false, content: 'Retry path swallows errors' }),
    raised({
      id: '9f01aa22bb334455cc66dd77ee8899ff',
      blocking: false,
      status: 'dismissed',
      content: 'Split the importer',
      resolution: 'Not now.',
    }),
    raised({
      id: 'cc11dd22ee334455ff66aa778899bb00',
      blocking: false,
      status: 'promoted_subtask',
      content: 'Stream progress during long merges',
      promoted_task_id: 'task-9',
      promoted_task_code: 'stream-merge-progress',
      comment_delivered_at: 2,
      delivered_turn: 7,
    }),
  ];

  test('the review summary badges every row and prints no id', () => {
    const html = raisedItemsSummary('task-1', items);
    expect(html).toContain('Blocking — gates accept');
    expect(html).toContain('FYI');
    expect(html).toContain('Dismissed');
    expect(html).toContain('Promoted to subtask');
    // The id is still there for scripts — as an attribute, not as prose.
    expect(html).toContain(`data-raised-id="${ITEM_ID}"`);
    expect(strayHex(html)).toEqual([]);
  });

  test('the task-page cards badge the gate and the decision, and print no id', () => {
    const html = taskRaisedSectionHtml(items);
    expect(html).toContain('Blocking');
    expect(html).toContain('FYI');
    // A dismissed card used to look exactly like one nobody had touched.
    expect(html).toContain('Dismissed');
    expect(strayHex(html)).toEqual([]);
  });

  // INVARIANT: the command a panel prints beside an id must EXIST. The rule in
  // `raisedIdentifierLineHtml` — no command that takes it, no id on the page —
  // is worthless if the command can be invented, and it was twice: this line
  // said `lazy accept --raised-resolutions` (never a flag) and the session line
  // said `lazy conversation show` (never a verb; it is `conversations`). Pinned
  // against the real flag table, so a rename breaks here rather than in the UI.
  test('the flag the panel tells you to use is a real one', () => {
    const printed = raisedIdLineHtml(ITEM_ID);
    const flagNames = RAISED_RESOLUTION_FLAGS.map((f) => `--${f.name}`);
    const named = flagNames.filter((f) => printed.includes(f));
    expect(named.length).toBeGreaterThan(0);
    // Every flag-looking token in that line is one the CLI actually registers.
    for (const token of printed.match(/--[a-z-]+/g) ?? []) {
      expect(flagNames).toContain(token);
    }
  });

  // INVARIANT: an id on a panel is either a labelled, FULL-LENGTH tool argument
  // in provenance, or it is not on the page. There is no truncated third form:
  // 8 hex is unreadable to a human AND unusable as an argument.
  test('the item panel spells the item id out in full, labelled, in provenance', () => {
    const html = raisedPanelHtml(listed(), []);

    expect(html).toContain('Item id');
    expect(html).toContain(`<code>${ITEM_ID}</code>`);
    expect(html).toContain('lazy accept --respond-raised');
    // Never truncated.
    expect(html).not.toContain(ITEM_ID.slice(0, 8) + '<');
    // …and it is the ONLY hex a reader sees.
    expect(strayHex(html)).toEqual([ITEM_ID]);
  });

  // INVARIANT: the panel shows NO session id, in any form. It rendered
  // `Session 3bc4fb1e`, and the first fix relabelled that value as an argument
  // to `lazy conversation show` — a command that does not exist (the verb is
  // `conversations`), and which spelled correctly resolves a stored
  // conversation by its captured Claude Code session UUID, not by the lazy task
  // session this field holds. No command takes this value, so by the rule in
  // `raisedIdentifierLineHtml` it does not belong on the page.
  //
  // The fixture DELIBERATELY sets `session_id`, and the first assertion guards
  // that it still does: an earlier version of this file omitted the field, so
  // the no-stray-hex check passed on markup that never rendered the line it was
  // meant to police. Deleting the field would make this test vacuous again.
  test('the item panel shows no session id, and the fixture would catch one', () => {
    expect(listed().session_id).toBe(SESSION_ID);

    const html = raisedPanelHtml(listed(), []);
    expect(html).not.toContain(SESSION_ID);
    expect(html).not.toContain(SESSION_ID.slice(0, 8));
    expect(html).not.toContain('Session');
    // And no command that does not exist is printed at a reader.
    expect(html).not.toContain('lazy conversation ');
  });

  // The promoted-task fallback: the row tag, the decision badge and the
  // provenance line all drop to the WORD rather than to a hex prefix of the
  // task's id. The fixture sets `promoted_task_id` WITHOUT a code on purpose —
  // that combination is the only one that reaches the fallback, and a fixture
  // carrying a code would exercise nothing.
  test('a promoted item with no task code shows no hex on the panel or the inbox', () => {
    const item = listed({
      status: 'promoted_subtask',
      promoted_task_id: UNCODED_TASK_ID,
      promoted_task_code: null,
    });
    // Guard the fixture itself: with a code present, none of this is tested.
    expect(item.promoted_task_id).toBe(UNCODED_TASK_ID);
    expect(item.promoted_task_code).toBeNull();

    const panel = raisedPanelHtml(item, []);
    // The route to the promoted task survives — that is the point of the badge.
    expect(panel).toContain(`href="/tasks/${UNCODED_TASK_ID}"`);
    expect(panel).not.toContain(UNCODED_TASK_ID.slice(0, 8) + '<');
    expect(strayHex(panel)).toEqual([ITEM_ID]);

    const inbox = raisedInboxHtml(
      { total: 1, total_open_blocking: 0, total_open_non_blocking: 0, items: [item], recurrences: [] },
      { state: 'all' },
    );
    expect(inbox).toContain(`href="/tasks/${UNCODED_TASK_ID}"`);
    expect(strayHex(inbox)).toEqual([]);
  });

  // The report card's "References raised items: a1249791, 3bc4fb1e" line is the
  // string the report quoted verbatim. The ids are all that report carries
  // about those items, so they are spent on the link rather than printed.
  test('an agent report references raised items as links, not as hex', () => {
    const html = agentReportHtml(
      'task-1',
      null,
      {
        sections: [{ kind: 'behavior_change', body: 'It is different now.' }],
        raised_item_ids: [ITEM_ID, SESSION_ID],
        created_at: 1,
      } as never,
    );
    expect(html).toContain(`href="/raised/${ITEM_ID}"`);
    expect(html).toContain('raised item 1');
    expect(html).toContain('raised item 2');
    expect(strayHex(html)).toEqual([]);
  });

  // The duplicate-count tooltip used to be a list of 8-hex prefixes: unreadable
  // as text and useless as an argument, so it said nothing to anybody.
  test('the duplicate-count tooltip says what the number means, not which hex', () => {
    const dupIds = [ITEM_ID, '11112222333344445555666677778888', '99990000aaaabbbbccccddddeeeeffff'];
    const item = listed({ duplicate_count: 3, duplicate_ids: dupIds });
    // Guard the fixture: the tooltip only renders above a count of 1, so a
    // default fixture (count 1, one id) would assert nothing at all.
    expect(item.duplicate_count).toBeGreaterThan(1);
    expect(item.duplicate_ids).toHaveLength(3);

    const inbox = raisedInboxHtml(
      { total: 1, total_open_blocking: 1, total_open_non_blocking: 0, items: [item], recurrences: [] },
      { state: 'all' },
    );
    expect(inbox).toContain('×3');
    expect(inbox).toContain('3 records on this task share this body');
    // None of the collapsed ids reaches the markup, in full or truncated.
    for (const id of dupIds.slice(1)) {
      expect(inbox).not.toContain(id);
      expect(inbox).not.toContain(id.slice(0, 8));
    }
    // Not even in the tooltip — strayHex strips tags, so check the raw markup.
    expect(inbox).not.toContain('11112222');
    expect(strayHex(inbox)).toEqual([]);
  });

  // INVARIANT: the panel's PROSE is rendered from the same vocabulary as its
  // BADGES. It used to hand-write its own copies, so an item badged "⚠️ FYI"
  // was called "Non-blocking" one paragraph below — the reported complaint,
  // reproduced inside the fix for it.
  test('the panel prose never contradicts the badge above it', () => {
    const fyi = raisedPanelHtml(listed({ blocking: false }), []);
    expect(fyi).toContain(raisedGateVocabulary(false).label);
    expect(fyi).not.toContain('Non-blocking');
    expect(fyi).not.toContain('non-blocking');

    const blocking = raisedPanelHtml(listed({ blocking: true }), []);
    expect(blocking).toContain(raisedGateVocabulary(true).phrase);
  });

  test('a promoted item still says what became of it', () => {
    const html = raisedPanelHtml(
      listed({
        status: 'promoted_subtask',
        promoted_task_id: 'task-9',
        promoted_task_code: 'stream-merge-progress',
      }),
      [],
    );
    expect(html).toContain('Promoted to subtask');
    // The href carries the promoted task's code, like every task URL.
    expect(html).toContain('href="/tasks/stream-merge-progress"');
    expect(html).toContain('stream-merge-progress');
  });
});

describe('raised surfaces fall back to the task id when its code is duplicated', () => {
  // Two tasks carrying `demo-task` — the shared code no longer resolves to a
  // task, so every link built from it would land on the code's WINNER (or
  // worse, an ambiguity refusal). The dup set is what tells the renderers to
  // spell the id instead.
  const dupTables: TaskCodeTables = {
    codeOf: new Map([['task-1', 'demo-task']]),
    duplicated: new Set(['demo-task']),
  };

  test('the inbox row links by id', () => {
    const inbox = raisedInboxHtml(
      { total: 1, total_open_blocking: 1, total_open_non_blocking: 0, items: [listed()], recurrences: [] },
      { state: 'all', taskCodes: dupTables },
    );
    expect(inbox).toContain('href="/tasks/task-1"');
    expect(inbox).not.toContain('href="/tasks/demo-task"');
  });

  test('the item panel links provenance by id — and the promoted task too when ITS code is shared', () => {
    const panel = raisedPanelHtml(
      listed({
        status: 'promoted_subtask',
        promoted_task_id: 'task-9',
        promoted_task_code: 'demo-task',
      }),
      [],
      { taskCodes: dupTables },
    );
    expect(panel).toContain('href="/tasks/task-1"');
    expect(panel).toContain('href="/tasks/task-9"');
    expect(panel).not.toContain('href="/tasks/demo-task"');
  });
});
