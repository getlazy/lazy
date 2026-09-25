/**
 * Unit tests for review presentation validation and residual groups.
 *
 * INVARIANT: agent cannot hide files — residual "Other changes" is appended at
 * render time for any diff path not referenced in the presentation.
 */

import { describe, test, expect } from 'bun:test';
import {
  normalizeReviewPresentation,
  appendResidualGroup,
  assertScreenshotsResolvable,
  fileClaimsFromGroups,
  tierExpandedByDefault,
  slugifyGroupTitle,
  groupIdOf,
  assignPresentationGroupIds,
  assertNoWholeFileClaimTwice,
  expandPresentationPatterns,
  fileItemPaths,
  isPathPattern,
  matchPattern,
  residualSummary,
  PresentationCapError,
  PRESENTATION_CAPS,
} from '../../src/storage/presentation';
import type { PresentationGroup } from '../../src/types';
import { filterFileToSnippet, screenshotsCardHtml, consecutiveFileRuns, mergeDiffFiles, renderPresentedChanges } from '../../src/server/review-presentation';
import {
  parseUnifiedDiff,
  fileSectionId,
  annotateSnippetAgainstFull,
  collectNewSideAdds,
  renderReviewDiff,
} from '../../src/server/review-diff';

describe('presentation validation', () => {
  // An empty presentation is still rejected; since review-screenshots the
  // requirement is "groups OR screenshots", not "groups" — a screenshots-only
  // presentation is a complete one.
  test('normalizeReviewPresentation rejects an empty presentation', () => {
    expect(() => normalizeReviewPresentation({ groups: [] })).toThrow(
      /must declare groups, screenshots, or both/,
    );
    expect(() => normalizeReviewPresentation({})).toThrow(
      /must declare groups, screenshots, or both/,
    );
  });

  test('normalizeReviewPresentation accepts valid payload', () => {
    const p = normalizeReviewPresentation({
      groups: [
        {
          title: 'Core change',
          tier: 'core',
          items: [{ kind: 'file', file: 'src/foo.ts' }],
        },
      ],
    });
    expect(p?.groups).toHaveLength(1);
    expect(p?.groups[0]!.tier).toBe('core');
  });

  test('normalizeReviewPresentation rejects bad snippet range', () => {
    expect(() =>
      normalizeReviewPresentation({
        groups: [
          {
            title: 'Bad',
            tier: 'core',
            items: [{ kind: 'snippet', file: 'a.ts', start: 10, end: 5 }],
          },
        ],
      }),
    ).toThrow(/start must be <= end/);
  });
});

describe('presentation group ids', () => {
  // INVARIANT (final-turn design §6.1): group ids are STABLE across re-sent
  // reports — regions, overlays and sign-offs key on them, so a wrap-up
  // recovery that re-sends the report must not orphan them.
  test('mints slugs from titles, deduping with -2 on collision', () => {
    const groups = assignPresentationGroupIds([
      { title: 'Retry path', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
      { title: 'Retry path?', tier: 'tests', items: [{ kind: 'prose', body: 'b' }] },
      { title: '???', tier: 'other', items: [{ kind: 'prose', body: 'b' }] },
    ]);
    expect(groups.map((g) => g.id)).toEqual(['retry-path', 'retry-path-2', 'group']);
  });

  test('honors agent-declared ids and refuses duplicates between them', () => {
    const groups = assignPresentationGroupIds([
      { id: 'custom', title: 'A', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
      { title: 'B', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
    ]);
    expect(groups[0]!.id).toBe('custom');
    expect(groups[1]!.id).toBe('b');

    expect(() =>
      assignPresentationGroupIds([
        { id: 'x', title: 'A', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
        { id: 'x', title: 'B', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
      ]),
    ).toThrow("already used by another group");
  });

  test('keeps ids across retitled groups by unique-best file overlap', () => {
    const previous = [
      {
        id: 'retry',
        title: 'Retry path',
        tier: 'core' as const,
        items: [{ kind: 'file' as const, file: 'src/retry.ts' }],
      },
    ];
    const renamed = assignPresentationGroupIds(
      [
        {
          title: 'The self-healing retry',
          tier: 'core',
          items: [
            { kind: 'file', file: 'src/retry.ts' },
            { kind: 'snippet', file: 'src/retry.ts', start: 1, end: 5 },
          ],
        },
      ],
      previous,
    );
    expect(renamed[0]!.id).toBe('retry');

    // Two previous groups overlapping equally is ambiguous — fresh slug.
    const tied = assignPresentationGroupIds(
      [
        {
          title: 'New thing',
          tier: 'core',
          items: [{ kind: 'file', file: 'src/shared.ts' }],
        },
      ],
      [
        { id: 'one', title: 'One', tier: 'core', items: [{ kind: 'file', file: 'src/shared.ts' }] },
        { id: 'two', title: 'Two', tier: 'core', items: [{ kind: 'file', file: 'src/shared.ts' }] },
      ],
    );
    expect(tied[0]!.id).toBe('new-thing');
  });

  // INVARIANT (final-turn design §6.1): every minted group id is UNIQUE, on a
  // re-send as much as on the first report. Regions are the human review
  // surface and are keyed by id: two groups answering to one id collapse into
  // a single region, so `lazy diff --region <id>` silently omits one group's
  // files and a sign-off recorded against that id covers files nobody opened.
  // A previous group is therefore consumed by at most ONE new group.
  test('two new groups with the same title cannot share one previous id', () => {
    const previous = [
      { id: 'tests', title: 'Tests', tier: 'tests' as const, items: [{ kind: 'prose' as const, body: 'b' }] },
    ];
    const assigned = assignPresentationGroupIds(
      [
        { title: 'Tests', tier: 'tests', items: [{ kind: 'file', file: 'test/a.test.ts' }] },
        { title: 'Tests', tier: 'tests', items: [{ kind: 'file', file: 'test/b.test.ts' }] },
      ],
      previous,
    );
    expect(assigned.map((g) => g.id)).toEqual(['tests', 'tests-2']);
  });

  test('two new groups overlapping one previous group cannot share its id', () => {
    const previous = [
      {
        id: 'retry',
        title: 'Retry path',
        tier: 'core' as const,
        items: [
          { kind: 'file' as const, file: 'src/retry.ts' },
          { kind: 'file' as const, file: 'src/backoff.ts' },
        ],
      },
    ];
    const assigned = assignPresentationGroupIds(
      [
        { title: 'Retry, split out', tier: 'core', items: [{ kind: 'file', file: 'src/retry.ts' }] },
        { title: 'Backoff, split out', tier: 'core', items: [{ kind: 'file', file: 'src/backoff.ts' }] },
      ],
      previous,
    );
    expect(assigned[0]!.id).toBe('retry');
    expect(assigned[1]!.id).toBe('backoff-split-out');
    expect(new Set(assigned.map((g) => g.id)).size).toBe(2);
  });

  test('a minted slug is never handed out again as a reused previous id', () => {
    // 'Tests' mints `tests` first; the previous group titled 'Old name' also
    // carries `tests`, and reusing it would collide with the slug just minted.
    const assigned = assignPresentationGroupIds(
      [
        { title: 'Tests', tier: 'tests', items: [{ kind: 'prose', body: 'b' }] },
        { title: 'Old name', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
      ],
      [{ id: 'tests', title: 'Old name', tier: 'core' as const, items: [{ kind: 'prose' as const, body: 'b' }] }],
    );
    expect(new Set(assigned.map((g) => g.id)).size).toBe(2);
    expect(assigned[0]!.id).toBe('tests');
    expect(assigned[1]!.id).toBe('old-name');
  });

  test('a snippet referencing another group\'s file does not claim it', () => {
    // INVARIANT (§6.1): snippets are narrative, not membership — this must
    // NOT throw.
    assertNoWholeFileClaimTwice([
      {
        title: 'Owner',
        tier: 'core',
        items: [{ kind: 'file', file: 'src/a.ts' }],
      },
      {
        title: 'Story',
        tier: 'core',
        items: [{ kind: 'snippet', file: 'src/a.ts', start: 1, end: 2 }],
      },
    ]);
  });

  test('a file item claimed by two groups is refused, naming both and the path', () => {
    expect(() =>
      assertNoWholeFileClaimTwice([
        {
          title: 'First',
          tier: 'core',
          items: [{ kind: 'file', file: 'src/a.ts' }],
        },
        {
          title: 'Second',
          tier: 'core',
          items: [
            { kind: 'file', file: 'src/own.ts' },
            { kind: 'file', file: 'src/a.ts' },
          ],
        },
      ]),
    ).toThrow("both claim 'src/a.ts' as a file item");
  });

  test('slug fallback agrees with the mint rule for legacy reports', () => {
    // groupIdOf is the read-side fallback for reports stored before ids were
    // minted; it must agree with slugifyGroupTitle or a legacy report's
    // regions and its re-sent replacement would disagree on ids.
    const minted = assignPresentationGroupIds([
      { title: 'Retry Path!', tier: 'core', items: [{ kind: 'prose', body: 'b' }] },
    ]);
    expect(minted[0]!.id).toBe(groupIdOf({ title: 'Retry Path!' }));
    expect(groupIdOf({ id: 'kept', title: 'Whatever' })).toBe('kept');
  });

  test('slugifyGroupTitle caps length and never comes back empty', () => {
    expect(slugifyGroupTitle('A Very Long Title That Keeps Going And Going And Going')).toBe(
      'a-very-long-title-that-keeps-going-and-g',
    );
    expect(slugifyGroupTitle('???')).toBe('group');
  });
});

describe('residual group', () => {
  test('appendResidualGroup adds omitted paths to Other changes', () => {
    const groups = [
      {
        title: 'Main',
        tier: 'core' as const,
        items: [{ kind: 'file' as const, file: 'a.ts' }],
      },
    ];
    const presented = fileClaimsFromGroups(groups);
    const out = appendResidualGroup(groups, ['a.ts', 'b.ts', 'c.ts'], presented);
    expect(out).toHaveLength(2);
    expect(out[1]!.title).toBe('Other changes');
    expect(out[1]!.items.map((i) => (i.kind === 'file' ? i.file : ''))).toEqual(['b.ts', 'c.ts']);
  });

  test('appendResidualGroup splits maintained paths into docs tier', () => {
    const groups = [
      {
        title: 'Main',
        tier: 'core' as const,
        items: [{ kind: 'file' as const, file: 'src/foo.ts' }],
      },
    ];
    const presented = fileClaimsFromGroups(groups);
    const out = appendResidualGroup(
      groups,
      ['src/foo.ts', 'CHANGELOG.md', 'src/bar.ts'],
      presented,
      { isMaintainedPath: (p) => p === 'CHANGELOG.md' },
    );
    expect(out).toHaveLength(3);
    expect(out[1]!.title).toBe('Maintained files');
    expect(out[1]!.tier).toBe('docs');
    expect(out[2]!.title).toBe('Other changes');
    expect(out[2]!.items.map((i) => (i.kind === 'file' ? i.file : ''))).toEqual(['src/bar.ts']);
  });

  test('the residual states how much of the change the walkthrough did not name', () => {
    const groups = [
      { title: 'Main', tier: 'core' as const, items: [{ kind: 'file' as const, file: 'a.ts' }] },
    ];
    const out = appendResidualGroup(
      groups,
      ['a.ts', 'b.ts', 'c.ts'],
      fileClaimsFromGroups(groups),
    );
    expect(out[1]!.summary).toBe('2 of 3 changed files are not named in the walkthrough.');
  });

  // INVARIANT: a cap that refused a walkthrough is shown to the REVIEWER on
  // the residual block, not only to the agent that hit it. A walkthrough cut
  // down to fit reads exactly like one that chose to leave files out, and the
  // only signal the cap ever produced was a tool error the agent worked
  // around in silence.
  test('a recorded cap refusal is stated on Other changes, naming the cap', () => {
    const groups = [
      { title: 'Main', tier: 'core' as const, items: [{ kind: 'file' as const, file: 'a.ts' }] },
    ];
    const out = appendResidualGroup(
      groups,
      ['a.ts', 'b.ts'],
      fileClaimsFromGroups(groups),
      {
        capRefusal: {
          cap: 'narrative_items',
          limit: 64,
          actual: 71,
          created_at: Date.now(),
        },
      },
    );
    expect(out[1]!.summary).toContain('1 of 2 changed files');
    expect(out[1]!.summary).toContain('the 64-snippet/prose-item cap');
    expect(out[1]!.summary).toContain('71 declared');
  });

  test('residualSummary reads as a sentence for one file', () => {
    expect(residualSummary(1, 1)).toBe('1 of 1 changed file is not named in the walkthrough.');
  });

  // INVARIANT: the count answers the PARTITION's question — how many changed
  // files the walkthrough did not CLAIM — on every surface, even where the
  // block itself draws a different set. The web Changes block does not re-card
  // a file some group quoted as a snippet (the reviewer has seen that diff),
  // but a quote is not a claim, so the file is still unaccounted for. Counting
  // per surface made one page say "5 of 277" on the Changes card and "17 of
  // 277" on the Regions tab about one walkthrough at one head.
  test('a snippet-only file counts as unnamed even where the block does not re-card it', () => {
    const groups = [
      {
        title: 'Story',
        tier: 'core' as const,
        items: [
          { kind: 'file' as const, file: 'src/owned.ts' },
          // Quoted, never claimed: narrative, not membership.
          { kind: 'snippet' as const, file: 'src/quoted.ts', start: 1, end: 5 },
        ],
      },
    ];
    const diffPaths = ['src/owned.ts', 'src/quoted.ts', 'src/loose.ts'];

    // The web block's own membership: `src/quoted.ts` is already on the page.
    const rendered = new Set(['src/owned.ts', 'src/quoted.ts']);
    const web = appendResidualGroup(groups, diffPaths, rendered, {
      claimed: fileClaimsFromGroups(groups),
    });
    const webResidual = web.find((g) => g.title === 'Other changes')!;
    expect(webResidual.items.map((i) => (i.kind === 'file' ? i.file : ''))).toEqual(['src/loose.ts']);

    // The region surfaces, where claims are the membership too.
    const regions = appendResidualGroup(groups, diffPaths, fileClaimsFromGroups(groups));
    const regionResidual = regions.find((g) => g.title === 'Other changes')!;
    expect(regionResidual.items).toHaveLength(2);

    // Two different blocks, ONE number — the partition's.
    expect(webResidual.summary).toBe('2 of 3 changed files are not named in the walkthrough.');
    expect(regionResidual.summary).toBe(webResidual.summary);
  });

  // INVARIANT: the unnamed-file count is ONE sentence about the WHOLE
  // residual, said once. Counting per block made the Changes card (which
  // splits maintained paths out) and the region surfaces (which never split)
  // answer the same question with different numbers on the same page.
  test('splitting maintained files out does not change the count, or say it twice', () => {
    const groups = [
      { title: 'Main', tier: 'core' as const, items: [{ kind: 'file' as const, file: 'src/foo.ts' }] },
    ];
    const diffPaths = ['src/foo.ts', 'CHANGELOG.md', 'public-docs/x.md', 'src/bar.ts'];
    const presented = fileClaimsFromGroups(groups);

    const split = appendResidualGroup(groups, diffPaths, presented, {
      isMaintainedPath: (p) => p === 'CHANGELOG.md' || p.startsWith('public-docs/'),
    });
    const unsplit = appendResidualGroup(groups, diffPaths, presented);

    const other = split.find((g) => g.title === 'Other changes')!;
    const maintained = split.find((g) => g.title === 'Maintained files')!;
    // Same sentence on the split surface as on the unsplit one — 3, not 1.
    expect(other.summary).toBe('3 of 4 changed files are not named in the walkthrough.');
    expect(unsplit.find((g) => g.title === 'Other changes')!.summary).toBe(other.summary);
    // The maintained block explains the SPLIT and states no second count.
    expect(maintained.summary).toBe(
      '2 of the files the walkthrough did not name are maintained files, shown separately.',
    );
    expect(maintained.summary).not.toContain('of 4 changed files');
  });

  test('with every leftover maintained, the count and the cap still reach the reviewer', () => {
    // There is no "Other changes" block to carry them, so the block that does
    // hold the residual carries the sentence — otherwise a cap disappears
    // because the only unnamed file happened to be a CHANGELOG entry.
    const groups = [
      { title: 'Main', tier: 'core' as const, items: [{ kind: 'file' as const, file: 'src/foo.ts' }] },
    ];
    const out = appendResidualGroup(
      groups,
      ['src/foo.ts', 'CHANGELOG.md'],
      fileClaimsFromGroups(groups),
      {
        isMaintainedPath: (p) => p === 'CHANGELOG.md',
        capRefusal: { cap: 'file_items', limit: 512, actual: 604, created_at: 1 },
      },
    );
    expect(out.find((g) => g.title === 'Other changes')).toBeUndefined();
    const maintained = out.find((g) => g.title === 'Maintained files')!;
    expect(maintained.summary).toContain('1 of 2 changed files is not named');
    expect(maintained.summary).toContain('the 512-file-item cap');
  });

  test('tierExpandedByDefault: core and docs expanded', () => {
    expect(tierExpandedByDefault('core')).toBe(true);
    expect(tierExpandedByDefault('docs')).toBe(true);
    expect(tierExpandedByDefault('tests')).toBe(false);
  });
});

describe('snippet extraction', () => {
  test('filterFileToSnippet returns matching lines', () => {
    const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,5 +1,6 @@
 line1
-line2
+line2changed
 line3
+line4
 line5
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const snippet = filterFileToSnippet(files[0]!, 2, 4, 'new');
    expect(snippet).not.toBeNull();
    expect(snippet!.hunks[0]!.lines.length).toBeGreaterThan(0);
  });

  test('filterFileToSnippet returns null when range misses', () => {
    const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
 a
+b
`;
    const files = parseUnifiedDiff(diff);
    const snippet = filterFileToSnippet(files[0]!, 50, 60, 'new');
    expect(snippet).toBeNull();
  });

  // INVARIANT: a presentation snippet that shows only part of a hunk must
  // never make the rest of that hunk's additions look like unchanged code
  // when the reviewer expands context. The card stamps the full-file add
  // index and totals so expand paints omitted lines as adds and the header
  // reads "+N of +X" instead of a naked "+N".
  test('a narrow snippet card stamps full-file adds and partial stats for expand', () => {
    // Mirrors the file-storage.ts failure: one visible add (plus its
    // surrounding context so expand controls have line numbers), several more
    // additions immediately below that expand used to paint as context.
    const diff = [
      'diff --git a/src/storage/file-storage.ts b/src/storage/file-storage.ts',
      '--- a/src/storage/file-storage.ts',
      '+++ b/src/storage/file-storage.ts',
      '@@ -10,4 +10,9 @@',
      '   // prior comment',
      '+  const previousAgent = session.agent_id;',
      '   session.agent_id = agentId;',
      '   if (reset) clear();',
      '+  // Remember which profile the RUNNING container belongs to',
      '+  if (previousAgent !== agentId) {',
      '+    session.container_agent_id = previousAgent;',
      '+  }',
      '',
    ].join('\n');
    const full = parseUnifiedDiff(diff)[0]!;
    // previousAgent + 4 comment/if lines
    expect(full.additions).toBe(5);
    // new-side: 10=comment, 11=previousAgent, 12=session, 13=if reset, 14..17=omitted adds
    expect(collectNewSideAdds(full)).toEqual([11, 14, 15, 16, 17]);

    // Snippet covers the visible add and the two context lines under it —
    // exactly what the misleading card showed — but not the later adds.
    const snippet = filterFileToSnippet(full, 11, 13, 'new');
    expect(snippet).not.toBeNull();
    expect(snippet!.additions).toBe(1);

    annotateSnippetAgainstFull(snippet!, full);
    expect(snippet!.fullAdditions).toBe(5);
    expect(snippet!.fullDeletions).toBe(0);
    expect(snippet!.newSideAdds).toEqual([11, 14, 15, 16, 17]);

    const html = renderReviewDiff([snippet!], new Map(), { allowExpand: true });
    expect(html).toContain('>+1</span>');
    expect(html).toContain('of +5 −0');
    expect(html).toContain('data-rv-new-adds="11,14,15,16,17"');
    // The gap below the snippet contains the omitted adds — name them so
    // "Show N lines below" does not read as pure context.
    expect(html).toMatch(/· 4 changes/);
  });
});

describe('presentation screenshots', () => {
  test('accepts a screenshots-only presentation and trims entries', () => {
    const p = normalizeReviewPresentation({
      screenshots: [{ artifact: '  shots/ui.png  ', caption: '  Settings page  ' }],
    });
    expect(p?.groups).toHaveLength(0);
    expect(p?.screenshots).toEqual([{ artifact: 'shots/ui.png', caption: 'Settings page' }]);
  });

  test('rejects malformed screenshot entries', () => {
    expect(() => normalizeReviewPresentation({ screenshots: 'shots/ui.png' })).toThrow(
      /must be an array/,
    );
    expect(() => normalizeReviewPresentation({ screenshots: [{ caption: 'no artifact' }] })).toThrow(
      /artifact/,
    );
  });

  // A report that names an artifact nobody attached must fail while the agent
  // can still fix it — never degrade into a broken image on the review page.
  test('assertScreenshotsResolvable rejects a missing artifact, naming what is attached', () => {
    expect(() =>
      assertScreenshotsResolvable(
        [{ artifact: 'shots/missing.png' }],
        [{ name: 'shots/ui.png', mime_type: 'image/png' }],
      ),
    ).toThrow(/shots\/missing\.png[\s\S]*shots\/ui\.png/);
  });

  test('assertScreenshotsResolvable rejects a non-image artifact', () => {
    expect(() =>
      assertScreenshotsResolvable(
        [{ artifact: 'report.md' }],
        [{ name: 'report.md', mime_type: 'text/markdown' }],
      ),
    ).toThrow(/not an image/);
  });

  // SVG is an image MIME type the serving route refuses (a scriptable document
  // on the dashboard origin), so the report call must refuse it too.
  test('assertScreenshotsResolvable rejects SVG', () => {
    expect(() =>
      assertScreenshotsResolvable(
        [{ artifact: 'diagram.svg' }],
        [{ name: 'diagram.svg', mime_type: 'image/svg+xml' }],
      ),
    ).toThrow(/SVG/);
  });

  test('assertScreenshotsResolvable accepts an attached raster image', () => {
    expect(() =>
      assertScreenshotsResolvable(
        [{ artifact: 'shots/ui.png', caption: 'Settings' }],
        [{ name: 'shots/ui.png', mime_type: 'image/png' }],
      ),
    ).not.toThrow();
  });

  // INVARIANT: screenshot bytes come from the artifact store through the
  // dashboard's guarded route — never from a path in the task worktree.
  test('screenshotsCardHtml renders artifact-store URLs and captions', () => {
    const html = screenshotsCardHtml('task-1', [
      { artifact: 'shots/ui.png', caption: 'Settings page' },
    ]);
    expect(html).toContain('/api/review/task-1/artifact?name=shots%2Fui.png');
    expect(html).toContain('Settings page');
    expect(html).toContain('<img');
  });

  test('screenshotsCardHtml renders nothing without screenshots', () => {
    expect(screenshotsCardHtml('task-1', undefined)).toBe('');
    expect(screenshotsCardHtml('task-1', [])).toBe('');
  });
});

/**
 * A protected-file decision is one record per PATH. Consecutive snippets of
 * that path must render as one file section with one approve/reject — not
 * one control per hunk card. Interleaved other files keep separate cards,
 * but still only one control for the path.
 */
describe('presented file cards coalesce consecutive hunks', () => {
  const FILE = 'test/e2e/daemon.test.ts';
  const OTHER = 'src/foo.ts';
  const diff = `diff --git a/${FILE} b/${FILE}
--- a/${FILE}
+++ b/${FILE}
@@ -1,3 +1,4 @@
 describe('daemon', () => {
+  test('bind failure logs the tail', () => {});
   test('starts', () => {});
   test('stops', () => {});
@@ -40,3 +41,4 @@
   test('health', () => {});
+  test('also logs the bind host', () => {});
   test('status', () => {});
   test('pidfile', () => {});
@@ -80,3 +82,4 @@
   test('restart', () => {});
+  test('kill-stray', () => {});
   test('list', () => {});
   test('doctor', () => {});
@@ -120,3 +123,4 @@
   test('proxy', () => {});
+  test('audit log path', () => {});
   test('token', () => {});
   test('lock', () => {});
diff --git a/${OTHER} b/${OTHER}
--- a/${OTHER}
+++ b/${OTHER}
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

  const files = parseUnifiedDiff(diff);
  const violations = new Map([
    [FILE, 'pending' as const],
    [OTHER, 'approved' as const],
  ]);

  test('consecutiveFileRuns merges same-path items and breaks on another file or prose', () => {
    const items = [
      { kind: 'snippet' as const, file: FILE, start: 1, end: 5 },
      { kind: 'snippet' as const, file: FILE, start: 40, end: 46 },
      { kind: 'prose' as const, body: 'aside' },
      { kind: 'snippet' as const, file: FILE, start: 80, end: 86 },
      { kind: 'file' as const, file: OTHER },
      { kind: 'snippet' as const, file: FILE, start: 120, end: 126 },
    ];
    const runs = consecutiveFileRuns(items);
    expect(runs).toHaveLength(5);
    expect(runs[0]).toHaveLength(2);
    expect(runs[1]![0]).toEqual({ kind: 'prose', body: 'aside' });
    expect(runs[2]).toHaveLength(1);
    expect(runs[3]![0]).toMatchObject({ kind: 'file', file: OTHER });
    expect(runs[4]![0]).toMatchObject({ kind: 'snippet', file: FILE, start: 120 });
  });

  test('mergeDiffFiles concatenates hunks and sums stats', () => {
    const a = files[0]!;
    const merged = mergeDiffFiles([a, a]);
    expect(merged.path).toBe(FILE);
    expect(merged.hunks.length).toBe(a.hunks.length * 2);
    expect(merged.additions).toBe(a.additions * 2);
  });

  test('consecutive snippets of one protected file are one card with one decision', () => {
    const html = renderPresentedChanges(
      {
        groups: [
          {
            title: 'Daemon tests',
            tier: 'core',
            items: [
              { kind: 'snippet', file: FILE, start: 1, end: 5, note: 'bind-failure' },
              { kind: 'snippet', file: FILE, start: 40, end: 46, note: 'bind host' },
              { kind: 'snippet', file: FILE, start: 80, end: 86 },
              { kind: 'snippet', file: FILE, start: 120, end: 126 },
            ],
          },
        ],
      },
      files,
      new Map(),
      { violations, taskId: 'task-demo' },
    );
    // INVARIANT: a protected-file decision is one control per path, on the
    // file header — never on each hunk card the presentation split the file into.
    expect((html.match(/data-rv-decide="test\/e2e\/daemon\.test\.ts"/g) ?? []).length).toBe(1);
    expect((html.match(/data-viewed-key="test\/e2e\/daemon\.test\.ts"/g) ?? []).length).toBe(1);
    expect(html).toContain(`id="${fileSectionId(FILE)}"`);
    expect(html).toContain(`data-file-section="${fileSectionId(FILE)}"`);
    expect(html).toContain('bind-failure');
    expect(html).toContain('bind host');
    // Standing answer comes from the daemon, not from a per-hunk guess.
    expect(html).toContain('protected — change will be reverted');
    expect(html).toMatch(/value="0"[^>]*rv-decide-on/);
  });

  test('an interleaved other file keeps a second card of the first file, still one decision', () => {
    const html = renderPresentedChanges(
      {
        groups: [
          {
            title: 'Walkthrough',
            tier: 'core',
            items: [
              { kind: 'snippet', file: FILE, start: 1, end: 5 },
              { kind: 'snippet', file: FILE, start: 40, end: 46 },
              { kind: 'file', file: OTHER },
              { kind: 'snippet', file: FILE, start: 80, end: 86 },
            ],
          },
        ],
      },
      files,
      new Map(),
      { violations, taskId: 'task-demo' },
    );
    // Two cards of FILE (consecutive pair, then leftover after OTHER) plus OTHER.
    expect((html.match(/data-viewed-key="test\/e2e\/daemon\.test\.ts"/g) ?? []).length).toBe(2);
    expect((html.match(/data-rv-decide="test\/e2e\/daemon\.test\.ts"/g) ?? []).length).toBe(1);
    expect((html.match(/data-rv-decide="src\/foo\.ts"/g) ?? []).length).toBe(1);
    // Only the first FILE card carries the canonical id.
    expect((html.match(new RegExp(`id="${fileSectionId(FILE)}"`, 'g')) ?? []).length).toBe(1);
    // The leftover card is still addressable for hash navigation.
    expect((html.match(new RegExp(`data-file-section="${fileSectionId(FILE)}"`, 'g')) ?? []).length).toBe(2);
    // Approved state on OTHER is the stored one, not pending.
    const other = (html.split(`data-rv-decide="${OTHER}"`)[1] ?? '').split('</form>')[0];
    expect(other).toMatch(/value="1"[^>]*rv-decide-on/);
  });
});


/**
 * Directory and glob file items.
 *
 * INVARIANT: a `kind: 'file'` item may name a DIRECTORY or a GLOB, and then
 * claims every changed file it matches as one item. The partition rules read
 * THROUGH the expansion — this is what lets a release-sized branch be
 * presented at all, and it may not buy that by weakening "one file, one
 * group".
 */
describe('directory and glob file items', () => {
  const DIFF = [
    'src/review/report.ts',
    'src/review/policy.ts',
    'src/other.ts',
    'test/e2e/regions-web.test.ts',
    'test/e2e/regions-cli.test.ts',
    'test/e2e/accept.test.ts',
  ];

  function claim(file: string, note?: string): PresentationGroup['items'][number] {
    return { kind: 'file', file, ...(note ? { note } : {}) };
  }

  test('a directory needs its trailing slash; a glob is a pattern by its magic', () => {
    expect(isPathPattern('src/review/')).toBe(true);
    expect(isPathPattern('test/e2e/regions*.test.ts')).toBe(true);
    expect(isPathPattern('src/review')).toBe(false);
    expect(isPathPattern('src/review/report.ts')).toBe(false);
  });

  test('a directory claims every changed file under it; a glob what it matches', () => {
    expect(matchPattern('src/review/', DIFF)).toEqual([
      'src/review/report.ts',
      'src/review/policy.ts',
    ]);
    expect(matchPattern('test/e2e/regions*.test.ts', DIFF)).toEqual([
      'test/e2e/regions-web.test.ts',
      'test/e2e/regions-cli.test.ts',
    ]);
  });

  test('expansion resolves patterns and leaves literal paths alone', () => {
    const [group] = expandPresentationPatterns(
      [
        {
          title: 'Review',
          tier: 'core',
          items: [claim('src/review/', 'the walkthrough code'), claim('src/other.ts')],
        },
      ],
      DIFF,
    );
    const [pattern, literal] = group!.items as [
      { kind: 'file'; file: string; matched?: string[] },
      { kind: 'file'; file: string; matched?: string[] },
    ];
    expect(pattern.file).toBe('src/review/');
    expect(pattern.matched).toEqual(['src/review/report.ts', 'src/review/policy.ts']);
    // Claims are read through one helper everywhere, so a pattern is a claim
    // on every surface or on none.
    expect(fileItemPaths(pattern)).toEqual(['src/review/report.ts', 'src/review/policy.ts']);
    expect(literal.matched).toBeUndefined();
    expect(fileItemPaths(literal)).toEqual(['src/other.ts']);
  });

  // INVARIANT: a value that IS one of the task's changed paths is a LITERAL
  // claim, whatever punctuation it contains. `app/blog/[slug]/page.tsx` is how
  // Next.js and SvelteKit spell a dynamic route; read as a glob its `[slug]`
  // is a character class matching one of `s`, `l`, `u`, `g`, so it claimed
  // nothing, the no-match check threw, and the agent's WHOLE report call
  // failed on a file item that is a plain correct path with no other spelling
  // available. There is deliberately no escaping syntax — the literal-first
  // rule removes the need for one.
  test('a changed path containing glob punctuation is claimed verbatim', () => {
    const route = 'app/blog/[slug]/page.tsx';
    const diff = [route, 'app/layout.tsx', 'src/review/report.ts'];
    const [group] = expandPresentationPatterns(
      [{ title: 'Routes', tier: 'core', items: [claim(route), claim('src/review/')] }],
      diff,
    );
    const [literal, pattern] = group!.items as Array<{ file: string; matched?: string[] }>;
    expect(literal.file).toBe(route);
    expect(literal.matched).toBeUndefined();
    expect(fileItemPaths(literal as never)).toEqual([route]);
    // And a real pattern alongside it still expands.
    expect(pattern.matched).toEqual(['src/review/report.ts']);
  });

  test('a glob that is not a changed path is still a glob', () => {
    // The literal rule must not swallow intentional patterns: an agent who
    // means `src/*.ts` does not also happen to have changed a file by that
    // exact name.
    const [group] = expandPresentationPatterns(
      [{ title: 'Globbed', tier: 'core', items: [claim('src/*.ts')] }],
      ['src/a.ts', 'src/b.ts', 'test/c.ts'],
    );
    expect((group!.items[0] as { matched?: string[] }).matched).toEqual(['src/a.ts', 'src/b.ts']);
  });

  // A directory claim that also carries glob characters can only ever match
  // nothing (the trailing slash takes the prefix branch), and lazy will not
  // guess which of the two the agent meant.
  test('a directory claim carrying glob characters is refused, naming both spellings', () => {
    expect(() =>
      expandPresentationPatterns(
        [{ title: 'Ambiguous', tier: 'core', items: [claim('src/*/')] }],
        DIFF,
      ),
    ).toThrow(/mixes a directory claim .the trailing "\/". with glob characters/);
    expect(() =>
      expandPresentationPatterns(
        [{ title: 'Ambiguous', tier: 'core', items: [claim('src/*/')] }],
        DIFF,
      ),
    ).toThrow(/src\/\*\/\*\*/);
  });

  // INVARIANT (external-surfaces-validate-inputs): a pattern that matches
  // nothing the task changed is REFUSED, naming it. Silently claiming no
  // files would put the group's whole worth of real files in "Other changes"
  // with nothing saying why — a typo that reads as an agent's choice.
  test('a pattern matching nothing this task changed is refused, naming it', () => {
    expect(() =>
      expandPresentationPatterns(
        [{ title: 'Review', tier: 'core', items: [claim('src/reivew/')] }],
        DIFF,
      ),
    ).toThrow(/'src\/reivew\/' matches no file this task changed/);
  });

  test('a two-file-claim through overlapping globs is still refused, naming both patterns', () => {
    const groups = expandPresentationPatterns(
      [
        { title: 'Regions', tier: 'tests', items: [claim('test/e2e/regions*.test.ts')] },
        { title: 'Every e2e', tier: 'tests', items: [claim('test/e2e/')] },
      ],
      DIFF,
    );
    expect(() => assertNoWholeFileClaimTwice(groups)).toThrow(
      /both claim 'test\/e2e\/regions-web.test.ts'/,
    );
    expect(() => assertNoWholeFileClaimTwice(groups)).toThrow(/under 'test\/e2e\/'/);
  });

  test('a glob claim is membership: the residual holds only what it did not match', () => {
    const groups = expandPresentationPatterns(
      [{ title: 'Regions', tier: 'tests', items: [claim('test/e2e/regions*.test.ts')] }],
      DIFF,
    );
    const out = appendResidualGroup(groups, DIFF, fileClaimsFromGroups(groups));
    const residual = out.find((g) => g.title === 'Other changes')!;
    expect(residual.items.map((i) => (i.kind === 'file' ? i.file : ''))).toEqual([
      'src/other.ts',
      'src/review/policy.ts',
      'src/review/report.ts',
      'test/e2e/accept.test.ts',
    ]);
  });

  test('a resolved pattern survives re-normalization on save', () => {
    // The SAVE boundary re-normalizes what the expansion boundary resolved,
    // and must not un-resolve it — that is the one caller allowed to trust
    // `matched`.
    const p = normalizeReviewPresentation(
      {
        groups: [
          {
            title: 'Review',
            tier: 'core',
            items: [{ kind: 'file', file: 'src/review/', matched: ['src/review/report.ts'] }],
          },
        ],
      },
      { resolved: true },
    );
    const item = p!.groups[0]!.items[0] as { kind: 'file'; matched?: string[] };
    expect(item.matched).toEqual(['src/review/report.ts']);
  });

  // INVARIANT: `matched` says which files a group OWNS and is OURS to write.
  // A caller-supplied one would claim paths no pattern ever matched — lifting
  // them out of "Other changes" without ever facing the "this pattern matches
  // nothing you changed" refusal — so every external surface drops it and the
  // expansion boundary is the only writer.
  test('a caller-supplied matched is dropped, literal path or pattern alike', () => {
    const p = normalizeReviewPresentation({
      groups: [
        {
          title: 'Fabricated',
          tier: 'core',
          items: [
            // A literal path: the expansion boundary short-circuits on a
            // walkthrough with no pattern in it, so this is the claim that
            // would otherwise never be checked by anything.
            { kind: 'file', file: 'src/other.ts', matched: ['src/secret.ts', 'src/more.ts'] },
            { kind: 'file', file: 'src/review/', matched: ['src/not-matched.ts'] },
          ],
        },
      ],
    });
    const [literal, pattern] = p!.groups[0]!.items as Array<{ matched?: string[] }>;
    expect(literal!.matched).toBeUndefined();
    expect(pattern!.matched).toBeUndefined();
    // And the literal then claims only itself.
    expect(fileItemPaths(p!.groups[0]!.items[0] as never)).toEqual(['src/other.ts']);
  });
});

/**
 * The two item caps.
 *
 * INVARIANT: they are split by what an item COSTS — a file item is a path
 * plus a note, a snippet is context the reader pays for — and every cap
 * refusal is TYPED, so the refusal can be recorded against the task by cap
 * rather than by parsing a message.
 */
describe('presentation caps', () => {
  function fileItems(n: number) {
    return Array.from({ length: n }, (_, i) => ({ kind: 'file', file: `src/f${i}.ts` }));
  }

  test('a release-sized walkthrough of file items is accepted', () => {
    const p = normalizeReviewPresentation({
      groups: [{ title: 'All of it', tier: 'core', items: fileItems(300) }],
    });
    expect(p!.groups[0]!.items).toHaveLength(300);
  });

  test('past the file-item cap it is refused, and the refusal names the cap and the true count', () => {
    const over = PRESENTATION_CAPS.file_items + 7;
    try {
      normalizeReviewPresentation({
        groups: [{ title: 'All of it', tier: 'core', items: fileItems(over) }],
      });
      throw new Error('expected a cap refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(PresentationCapError);
      const refusal = (err as PresentationCapError).refusal;
      expect(refusal.cap).toBe('file_items');
      expect(refusal.limit).toBe(PRESENTATION_CAPS.file_items);
      // The number the agent DECLARED, not the one that crossed the line —
      // the recorded refusal is what tells the engineer how far off the cap is.
      expect(refusal.actual).toBe(over);
    }
  });

  // INVARIANT: only the caps that can force a walkthrough to leave something
  // OUT are recorded as caps. A too-long snippet or a thirteenth screenshot
  // cannot push a file into the residual, so telling a reviewer "the
  // walkthrough was rewritten to fit, files may be unassigned" would be
  // false — and the agent needs the item's label to fix it.
  test('a too-long snippet is a plain validation error naming the item', () => {
    let err: unknown;
    try {
      normalizeReviewPresentation({
        groups: [
          {
            title: 'Quoting too much',
            tier: 'core',
            items: [
              { kind: 'prose', body: 'a' },
              { kind: 'snippet', file: 'src/a.ts', start: 1, end: 500 },
            ],
          },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PresentationCapError);
    expect((err as Error).message).toBe(
      'presentation.groups[0].items[1] snippet span exceeds 200 lines',
    );
  });

  test('too many screenshots is a plain validation error too', () => {
    let err: unknown;
    try {
      normalizeReviewPresentation({
        screenshots: Array.from({ length: 13 }, (_, i) => ({ artifact: `shot-${i}.png` })),
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(PresentationCapError);
    expect((err as Error).message).toContain('exceeds 12 images');
  });

  test('snippets and prose keep the narrower cap', () => {
    const items = Array.from({ length: PRESENTATION_CAPS.narrative_items + 1 }, (_, i) => ({
      kind: 'snippet',
      file: `src/f${i}.ts`,
      start: 1,
      end: 5,
    }));
    try {
      normalizeReviewPresentation({ groups: [{ title: 'Story', tier: 'core', items }] });
      throw new Error('expected a cap refusal');
    } catch (err) {
      expect((err as PresentationCapError).refusal.cap).toBe('narrative_items');
    }
  });

  test('a file item claiming a glob costs one slot, not one per file', () => {
    // The point of the feature: 600 changed test files are one item.
    const groups = expandPresentationPatterns(
      [{ title: 'Tests', tier: 'tests', items: [{ kind: 'file', file: 'test/**' }] }],
      Array.from({ length: 600 }, (_, i) => `test/unit/f${i}.test.ts`),
    );
    const p = normalizeReviewPresentation({ groups }, { resolved: true });
    expect(p!.groups[0]!.items).toHaveLength(1);
    expect(fileItemPaths(p!.groups[0]!.items[0] as never)).toHaveLength(600);
  });
});

/**
 * What a BIG pattern claim looks like on the web Changes block.
 *
 * The point of the feature is that a 40-file test mass costs one line of the
 * walkthrough. On the surface a human reads first it used to cost forty: the
 * group header listed every matched path as a chip, and every claimed file
 * outside the rendered range printed its own "Snippet range not found" hint —
 * wording that is wrong for a whole-file claim, said once per file. Neither
 * path was new, but the 64-item cap made them unreachable.
 */
describe('a pattern-claimed group on the Changes block', () => {
  const claimed = Array.from({ length: 30 }, (_, i) => `test/e2e/suite-${i}.test.ts`);
  const diff = `diff --git a/${claimed[0]} b/${claimed[0]}
--- a/${claimed[0]}
+++ b/${claimed[0]}
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;
  const files = parseUnifiedDiff(diff);
  const presentation = {
    groups: [
      {
        id: 'suites',
        title: 'The suites',
        tier: 'tests' as const,
        items: [
          {
            kind: 'file' as const,
            file: 'test/e2e/',
            note: 'every e2e suite',
            matched: claimed,
          },
        ],
      },
    ],
  };

  const html = renderPresentedChanges(presentation, files, new Map(), {});

  test('the header says the pattern and its size, not every path it matched', () => {
    expect(html).toContain('test/e2e/ — 30 files');
    // The 29 files outside the rendered range are not 29 chips in the header.
    expect(html).not.toContain('test/e2e/suite-17.test.ts</code>,');
    const chips = (html.match(/<code>test\/e2e\/suite-/g) ?? []).length;
    expect(chips).toBe(0);
  });

  test('claimed files outside the rendered range are said ONCE, in file-claim words', () => {
    // On a hub this block renders the task's own direct diff while the
    // walkthrough claims the whole branch, so a child's files are legitimately
    // absent here — one line for the group, not one per file.
    expect(html).toContain('29 files claimed by this group are not in the diff shown here');
    expect(html).not.toContain('Snippet range not found');
    expect((html.match(/not in the diff shown here/g) ?? []).length).toBe(1);
    // And the file that IS in range still renders its diff.
    expect(html).toContain('const a = 2;');
  });
});
