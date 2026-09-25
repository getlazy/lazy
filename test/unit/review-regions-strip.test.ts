/**
 * The regions strip on the Changes tab — the `?region=` filter's UI.
 *
 * The rules worth pinning are the ones a future change could quietly break:
 * a task with nothing to filter must look exactly as it did before regions
 * existed, and an unselected region must never vanish.
 */

import { describe, test, expect } from 'bun:test';
import {
  regionsStripHtml,
  regionsCardHtml,
  regionsTabHtml,
  changesHref,
  collapseNotes,
} from '../../src/server/review-regions';
import { parseUnifiedDiff, renderReviewDiff, blameRunRows } from '../../src/server/review-diff';
import type { RegionSummary } from '../../src/regions';

function row(id: string, over: Partial<RegionSummary> = {}): RegionSummary {
  return {
    id,
    unit: 'task',
    parent_id: null,
    depth: 0,
    label: `label for ${id}`,
    files: 3,
    shared: 1,
    provenance: 'branch-ref',
    expanded: false,
    expansion_reasons: [],
    children: 0,
    descendants: 0,
    authors: ['Ada Lovelace'],
    ...over,
  };
}

describe('regions strip', () => {
  test('renders nothing below two regions', () => {
    // INVARIANT: a filter offering the reviewer their only choice is noise.
    // A one-commit task's Changes tab must be byte-identical to what it was
    // before regions existed, which is what this guards.
    expect(regionsStripHtml({ taskId: 't1', regions: [], active: null, notes: [] })).toBe('');
    expect(regionsStripHtml({ taskId: 't1', regions: [row('task:a')], active: null, notes: [] })).toBe('');
  });

  test('lists regions with size, ownership and unit kind', () => {
    const html = regionsStripHtml({
      taskId: 't1',
      regions: [row('task:a'), row('task:b', { files: 9, shared: 0 })],
      active: null,
      notes: [],
    });
    expect(html).toContain('2 review regions');
    expect(html).toContain('task:a');
    expect(html).toContain('9 files · task');
    expect(html).toContain('3 files · 1 also touched by others');
  });

  test('the selected region is marked, and offers a way back to all changes', () => {
    const html = regionsStripHtml({
      taskId: 't1',
      regions: [row('task:a'), row('task:b')],
      active: 'task:a',
      notes: [],
    });
    expect(html).toContain('rv-region-active');
    expect(html).toContain('show all');
    expect(html).toContain(changesHref('t1', null));
  });

  test('regions past the twelfth fold into "Other regions" rather than disappearing', () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`task:r${i}`, { files: 20 - i }));
    const html = regionsStripHtml({ taskId: 't1', regions: many, active: null, notes: [] });

    // INVARIANT (review-ux-signal-over-noise): raw detail stays one click
    // away. Every region must be reachable from the strip — collapsed, never
    // dropped — or the reviewer has no way to know it exists.
    expect(html).toContain('Other regions (8)');
    for (const r of many) expect(html).toContain(r.id);
  });

  test('the selected region is never the one folded away', () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`task:r${i}`, { files: 20 - i }));
    const html = regionsStripHtml({ taskId: 't1', regions: many, active: 'task:r14', notes: [] });
    const summaryAt = html.indexOf('<summary>');
    expect(summaryAt).toBeGreaterThan(-1);
    // The fold widened past the default twelve to reach it.
    expect(html).toContain('Other regions (5)');
    expect(html.indexOf('task:r14')).toBeLessThan(summaryAt);
  });

  const nested = () => [
    row('task:hub', { files: 40, children: 2, descendants: 2 }),
    row('commit:c1', { unit: 'commit', depth: 1, parent_id: 'task:hub', files: 2 }),
    row('commit:c2', { unit: 'commit', depth: 1, parent_id: 'task:hub', files: 38 }),
    row('task:later', { files: 5 }),
  ];

  test('nested regions stay closed until their parent is selected', () => {
    // INVARIANT: one level at a time. The cover of a release branch is a tree
    // of several hundred units, and rendering all of them at once is not a
    // carved review — it is the commit log with extra steps. The top level is
    // what a reviewer sees first; the rest is one click away and SAID to be
    // there, never silently dropped.
    const html = regionsStripHtml({ taskId: 't1', regions: nested(), active: null, notes: [] });
    expect(html).toContain('task:hub');
    expect(html).toContain('task:later');
    expect(html).not.toContain('commit:c1');
    expect(html).toContain('2 nested inside them');
    // The row says what opening it would give you.
    expect(html).toContain('2 inside');
  });

  test('selecting a region opens the level below it, in cover order', () => {
    // The strip must not re-sort within a level: the cover is depth-first — a
    // region immediately followed by the regions it expands into — and any
    // other order (by size, say) scatters every child away from its parent.
    const html = regionsStripHtml({ taskId: 't1', regions: nested(), active: 'task:hub', notes: [] });
    const at = (id: string) => html.indexOf(`>${id}<`);
    expect(at('task:hub')).toBeGreaterThan(-1);
    expect(at('task:hub')).toBeLessThan(at('commit:c1'));
    expect(at('commit:c1')).toBeLessThan(at('commit:c2'));
    expect(at('commit:c2')).toBeLessThan(at('task:later'));
  });

  test('a selected child keeps its ancestors visible', () => {
    // A selected region must never be an orphan row with no context: without
    // its parent on screen the reviewer cannot tell what they are inside.
    const html = regionsStripHtml({ taskId: 't1', regions: nested(), active: 'commit:c2', notes: [] });
    expect(html).toContain('task:hub');
    expect(html).toContain('commit:c2');
  });

  test('labels and ids are escaped', () => {
    const html = regionsStripHtml({
      taskId: 't1',
      regions: [row('task:a', { label: '<script>x</script>' }), row('task:b')],
      active: null,
      notes: [],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('regions strip notes', () => {
  test('repeated unrecoverable-branch notes collapse to a count', () => {
    const notes = Array.from({ length: 7 }, (_, i) => `No surviving branch for task-${i} — kept as a single commit-level region.`);
    const collapsed = collapseNotes([...notes, 'Something else entirely.']);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.join(' ')).toContain('7 units had no surviving branch');
    expect(collapsed).toContain('Something else entirely.');
  });

  test('a couple of them are shown verbatim', () => {
    const notes = ['No surviving branch for a — kept as a single commit-level region.'];
    expect(collapseNotes(notes)).toEqual(notes);
  });
});

describe('regions card on the Changes tab', () => {
  test('states the count and the largest few, and points at the Regions tab', () => {
    const rows = [
      row('task:big', { label: 'The big one', files: 409 }),
      row('task:mid', { label: 'The middle one', files: 218 }),
      row('task:small', { label: 'The small one', files: 12 }),
      row('task:tiny', { label: 'The tiny one', files: 2 }),
    ];
    const html = regionsCardHtml({ taskId: 't1', regions: rows, active: null, notes: [] });

    expect(html).toContain('4 review regions');
    expect(html).toContain('The big one');
    expect(html).toContain('The middle one');
    expect(html).toContain('The small one');
    // INVARIANT: the card is a POINTER, not a second copy of the list. The
    // full list has its own tab; repeating it above every diff is the same
    // information twice and pushes the actual changes further down.
    expect(html).not.toContain('The tiny one');
    expect(html).not.toContain('rv-regions-list');
    expect(html).toContain('/tasks/t1/regions');
  });

  test('the largest few are a slice, not a second opinion about impact', () => {
    // The daemon already ordered the cover most-impactful first, so the card
    // takes the top of the list rather than re-sorting. Re-sorting here would
    // be a second definition of "impact" that could drift from the tab's.
    const rows = [
      row('task:a', { label: 'first', files: 9 }),
      row('task:b', { label: 'second', files: 8 }),
      row('task:c', { label: 'third', files: 7 }),
      row('task:d', { label: 'fourth', files: 6 }),
    ];
    const html = regionsCardHtml({ taskId: 't1', regions: rows, active: null, notes: [] });
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'));
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('third'));
    expect(html).not.toContain('fourth');
  });

  test('only top-level regions are named, so a nested one never looks like a peer', () => {
    const rows = [
      row('task:hub', { label: 'the hub', files: 40 }),
      row('commit:inner', { label: 'inside the hub', depth: 1, parent_id: 'task:hub', files: 39 }),
      row('task:other', { label: 'another top-level', files: 5 }),
    ];
    const html = regionsCardHtml({ taskId: 't1', regions: rows, active: null, notes: [] });
    expect(html).toContain('the hub');
    expect(html).toContain('another top-level');
    expect(html).not.toContain('inside the hub');
  });

  test('with a region selected it names the filter and offers the way out', () => {
    const rows = [row('task:a', { label: 'Selected thing', files: 7, shared: 2 }), row('task:b')];
    const html = regionsCardHtml({ taskId: 't1', regions: rows, active: 'task:a', notes: [] });

    // INVARIANT: a scoped diff must say it is scoped. A filtered diff that
    // looks unfiltered lies about how big the change is.
    expect(html).toContain('rv-regions-card-active');
    expect(html).toContain('Showing one region');
    expect(html).toContain('Selected thing');
    expect(html).toContain('7 files');
    expect(html).toContain(changesHref('t1', null));
  });

  test('no regions renders nothing at all', () => {
    expect(regionsCardHtml({ taskId: 't1', regions: [], active: null, notes: [] })).toBe('');
  });
});

describe('regions tab body', () => {
  test('renders even a single region, unlike the Changes-tab strip', () => {
    // A reader who clicked "Regions" asked to see them; an empty page in
    // answer to a direct question is worse than a list of one. The Changes
    // tab suppresses a one-region strip because a filter offering the only
    // choice is noise — different surface, different call.
    const one = [row('task:only')];
    expect(regionsStripHtml({ taskId: 't1', regions: one, active: null, notes: [] })).toBe('');
    const tab = regionsTabHtml({ taskId: 't1', regions: one, active: null, notes: [] });
    expect(tab).toContain('Review regions');
    expect(tab).toContain('task:only');
  });

  test('is empty only when there are no regions', () => {
    expect(regionsTabHtml({ taskId: 't1', regions: [], active: null, notes: [] })).toBe('');
  });

  test('a sign-off and an owner name the people behind them', () => {
    // A row reading "signed off" with nobody on it is an approval by nobody:
    // on a review several people share, the reader cannot tell who to ask.
    const tab = regionsTabHtml({
      taskId: 't1',
      regions: [
        row('task:a', {
          owner: 'ierceg',
          owner_set_by: { email: 'kim@example.com', name: 'Kim' },
          signed_off_sha: 'abc12345deadbeef',
          signed_off_current: true,
          signed_off_by: { email: 'ada@example.com', name: 'Ada' },
        }),
        row('task:b'),
      ],
      active: null,
      notes: [],
    });
    expect(tab).toContain('owner ierceg (set by Kim)');
    expect(tab).toContain('signed off @abc12345 by Ada');
  });

  test('a stale sign-off still reads as stale, named or not', () => {
    // INVARIANT: naming the person does not make an approval current. The head
    // comparison is the only thing that decides it — a row still reading
    // "signed off" over code nobody has looked at is the failure the whole
    // mechanism exists to prevent.
    const tab = regionsTabHtml({
      taskId: 't1',
      regions: [row('task:a', {
        signed_off_sha: 'abc12345deadbeef',
        signed_off_current: false,
        signed_off_by: { email: 'ada@example.com', name: 'Ada' },
      })],
      active: null,
      notes: [],
    });
    // The tab escapes the sentence, as it escapes every user-facing text:
    // an apostrophe reaches the wire as &#39;.
    expect(tab).toContain("signed off @abc12345 by Ada — STALE, the region&#39;s content has changed");
  });

  test('an overlay with no person named renders exactly as it always did', () => {
    // INVARIANT: an overlay written before attribution existed — and every
    // single-machine one, which has no person behind it — renders with no name
    // and none invented.
    const tab = regionsTabHtml({
      taskId: 't1',
      regions: [row('task:a', {
        owner: 'ierceg',
        signed_off_sha: 'abc12345deadbeef',
        signed_off_current: true,
      })],
      active: null,
      notes: [],
    });
    expect(tab).toContain('owner ierceg');
    expect(tab).toContain('signed off @abc12345');
    expect(tab).not.toContain('set by');
    expect(tab).not.toContain('signed off @abc12345 by');
  });

  test('the tab says regions are a partition, because the counts now add up', () => {
    const tab = regionsTabHtml({
      taskId: 't1', regions: [row('task:a'), row('task:b')], active: null, notes: [],
    });
    expect(tab).toContain('partition');
    // The rows are what the task DECLARED, not a git carve — the whole
    // inversion this tab was rewritten for. Asserted case-insensitively: the
    // word carries the meaning, the capitalisation is only emphasis.
    expect(tab.toLowerCase()).toContain('declared');
    // And WHEN it declared: the walkthrough is filed on every park that faces
    // a human, not only on a task declared done (review 048577eb). The copy
    // said "final turn" until every park started producing one.
    expect(tab).toContain('parked for you');
    expect(tab).not.toContain('final turn');
    expect(tab).not.toContain('cover, not a partition');
    expect(tab).not.toContain('unit of provenance');
  });
});

describe('regions — a scoped diff says what it actually contains', () => {
  test('INVARIANT: the card names the shared files when a region is selected. Scoping is by FILE against the task\'s whole range, so on a file two units both touched the diff shown includes the other unit\'s edits — a reviewer attributing everything in a region to that region would be wrong, and nothing else on the page says so.', () => {
    const rows = [row('task:a', { label: 'Selected', files: 7, shared: 2 }), row('task:b')];
    const html = regionsCardHtml({ taskId: 't1', regions: rows, active: 'task:a', notes: [] });
    expect(html).toContain('2 of these files');
    expect(html).toContain("includes those units' edits too");
  });

  test('a region that owns every file it touches gets no such warning', () => {
    const rows = [row('task:a', { label: 'Selected', files: 5, shared: 0 }), row('task:b')];
    const html = regionsCardHtml({ taskId: 't1', regions: rows, active: 'task:a', notes: [] });
    expect(html).toContain('Showing one region');
    expect(html).not.toContain('also touched by other units');
  });
});

describe('regions — an empty cover is three different statements', () => {
  test('INVARIANT: a carve that FAILED renders its reason, not "no work to carve". `computeRegionCover` puts the reason in `notes` when the review range does not resolve; both renderers used to drop it and the tab substituted a positive, wrong sentence. A reviewer told there is nothing there stops looking, where "could not resolve the review range" would have them check the worktree.', () => {
    const notes = ['Could not resolve the review range main..HEAD in this worktree — no regions.'];

    const card = regionsCardHtml({ taskId: 't1', regions: [], active: null, notes });
    expect(card).toContain('Could not resolve the review range');

    const tab = regionsTabHtml({ taskId: 't1', regions: [], active: null, notes });
    expect(tab).toContain('Review regions');
    expect(tab).toContain('Could not resolve the review range');
    expect(tab).not.toContain('no committed work');
  });

  test('a genuinely empty cover with nothing to say still renders nothing', () => {
    // The rule the whole surface is built on: a task with no committed work
    // looks exactly as it did before regions existed.
    expect(regionsCardHtml({ taskId: 't1', regions: [], active: null, notes: [] })).toBe('');
    expect(regionsTabHtml({ taskId: 't1', regions: [], active: null, notes: [] })).toBe('');
  });
});

describe('subtask-blame gutter', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,6 @@',
    ' ctx',
    '+one',
    '+two',
    '-gone',
    '+three',
    ' tail',
    '',
  ].join('\n');

  const attribution = (multi: boolean) => new Map([['a.ts', {
    path: 'a.ts',
    multi,
    runs: multi
      ? [
        { start: 2, end: 3, region: 'task:alpha', code: 'alpha', title: 'Alpha goal' },
        { start: 4, end: 4, region: 'task:beta', code: 'beta', title: 'Beta goal' },
      ]
      : [],
    ...(multi ? {} : { owner: { region: 'task:alpha', code: 'alpha', title: 'Alpha goal' } }),
  }]]);

  test('consecutive same-owner lines are ONE run with one centred label', () => {
    // INVARIANT: a run is labelled once, at its vertical middle, with a spine
    // spanning it — never a link repeated on every line. A column of three
    // hundred identical links is noise, and the label is what a reviewer reads.
    const files = parseUnifiedDiff(diff);
    const runs = blameRunRows(files[0]!.hunks[0]!.lines, attribution(true).get('a.ts')!.runs);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ region: 'task:alpha', first: 1, last: 2 });
    expect(runs[1]).toMatchObject({ region: 'task:beta' });
    // The label sits inside its own run, not at an edge of the file.
    for (const run of runs) {
      expect(run.label).toBeGreaterThanOrEqual(run.first);
      expect(run.label).toBeLessThanOrEqual(run.last);
    }
  });

  test('a removed line does not break a run', () => {
    // A deleted line is not in the final version, so blame has nothing to say
    // about it. Treating that silence as a boundary would split one unit's
    // work into two stretches with a hole, which is not what happened.
    const files = parseUnifiedDiff(diff);
    const lines = files[0]!.hunks[0]!.lines;
    const del = lines.findIndex((l) => l.kind === 'del');
    const runs = blameRunRows(lines, [
      { start: 2, end: 4, region: 'task:alpha', code: 'alpha', title: 'Alpha goal' },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.first).toBeLessThan(del);
    expect(runs[0]!.last).toBeGreaterThan(del);
  });

  test('the gutter is ON for a multi-claimant file and links each run to its task', () => {
    const html = renderReviewDiff(parseUnifiedDiff(diff), new Map(), {
      lineAttribution: attribution(true),
    });
    expect(html).toContain('rv-blame-on');
    expect(html).toContain('href="/tasks/alpha"');
    expect(html).toContain('href="/tasks/beta"');
    expect(html).toContain('title="Alpha goal"');
    // One label per run, not one per line: three added lines, two runs.
    expect(html.match(/rv-blame-label/g)).toHaveLength(2);
    // And the toggle says how many units are in the file.
    expect(html).toContain('2 units');
  });

  test('a single-claimant file gets a header chip and no gutter', () => {
    // INVARIANT: off by default where it would say the same thing on every
    // line. One unit wrote every changed line by construction — the partition
    // established that — so the column would be one label repeated down the
    // page, and the header says it once instead.
    const html = renderReviewDiff(parseUnifiedDiff(diff), new Map(), {
      lineAttribution: attribution(false),
    });
    expect(html).not.toContain('rv-blame-on');
    expect(html).toContain('rv-blame-chip');
    expect(html).toContain('href="/tasks/alpha"');
  });

  test('with no attribution the diff is byte-identical to before the gutter', () => {
    // The reading aid must cost nothing on a page that has none — a task with
    // no carved cover, or the commit-detail page.
    const plain = renderReviewDiff(parseUnifiedDiff(diff), new Map(), {});
    expect(plain).not.toContain('rv-blame');
  });
});

describe('regions strip/card — presented rows read display order', () => {
  // INVARIANT: the whole review page reads docs/maintained above code
  // (`sortPresentationGroupsForDisplay`, `report-policy`) — and the strip and
  // card are parts of that page, rendered BEFORE the presented blocks. Rows
  // carrying a tier (presentation regions) sort by it, ties keeping the
  // walkthrough's declared order; carved rows (no tier) keep the cover's own
  // order, so a depth-first shape — a region followed by the regions it
  // expands into — survives untouched.
  const presented = [
    row('core-first', { label: 'Core first', unit: 'presentation', provenance: 'presentation', tier: 'core' }),
    row('docs-later', { label: 'Docs later', unit: 'presentation', provenance: 'presentation', tier: 'docs' }),
    row('core-second', { label: 'Core second', unit: 'presentation', provenance: 'presentation', tier: 'core' }),
  ];

  test('the strip interleaves by tier, declared order within a tier', () => {
    const html = regionsStripHtml({ taskId: 't1', regions: presented, active: null, notes: [] });
    expect(html.indexOf('Docs later')).toBeLessThan(html.indexOf('Core first'));
    expect(html.indexOf('Core first')).toBeLessThan(html.indexOf('Core second'));
  });

  test('the compact card reads the same order — one page, one reading', () => {
    const html = regionsCardHtml({ taskId: 't1', regions: presented, active: null, notes: [] });
    expect(html.indexOf('Docs later')).toBeLessThan(html.indexOf('Core first'));
    expect(html.indexOf('Core first')).toBeLessThan(html.indexOf('Core second'));
  });

  test('carved rows (no tier) keep the cover order exactly', () => {
    const carved = [
      row('task:a', { label: 'first' }),
      row('task:b', { label: 'second' }),
      row('task:c', { label: 'third' }),
    ];
    const html = regionsStripHtml({ taskId: 't1', regions: carved, active: null, notes: [] });
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'));
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('third'));
  });
});
