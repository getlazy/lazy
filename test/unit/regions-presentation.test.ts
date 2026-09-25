/**
 * Unit tests for reading a task's presentation AS its regions.
 *
 * INVARIANT: the presented regions are a PARTITION — every diff path belongs
 * to exactly one region (an agent-claimed group, or the residual), because
 * the reviewer navigates by them and a file in two rows is a diff scoped
 * twice, while a file in none is work nobody can scope to.
 *
 * The synthesis is a pure function of the presentation and the diff facts,
 * so these tests fabricate both — no git repo, no daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import {
  presentedRegions,
  latestPresentation,
  latestCapRefusal,
  capRefusalFor,
  capRefusedWithoutWalkthroughNote,
  staleWalkthroughNote,
} from '../../src/daemon/regions-presentation';
import { regionNoteLine } from '../../src/regions';
import { residualSummary } from '../../src/storage/presentation';
import type { PresentationGroup, ReviewPresentation, TurnReport } from '../../src/types';
import type { RegionOverlay } from '../../src/regions/types';

function group(
  title: string,
  items: PresentationGroup['items'],
  extra: Partial<PresentationGroup> = {},
): PresentationGroup {
  return { title, tier: 'core', items, ...extra };
}

const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function inputs(
  over: Partial<Parameters<typeof presentedRegions>[2]> = {},
): Parameters<typeof presentedRegions>[2] {
  return {
    baseRef: 'main',
    baseSha: BASE,
    headSha: HEAD,
    diffPaths: [],
    pairs: new Map<string, string>(),
    overlays: [],
    ...over,
  };
}

describe('presentedRegions', () => {
  test('projects groups to rows in the agent\'s narrative order, claims as files', () => {
    // INVARIANT: the partition — every diff path lands in exactly one row.
    const presentation: ReviewPresentation = {
      groups: [
        group('Migration', [{ kind: 'file', file: 'src/migrate.ts' }]),
        group('API', [
          { kind: 'file', file: 'src/api.ts' },
          // A snippet into a file ANOTHER group owns whole: a story beat,
          // never membership (§6.1) — a.ts must stay only in Migration.
          { kind: 'snippet', file: 'src/migrate.ts', start: 10, end: 20 },
        ]),
      ],
    };
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['src/migrate.ts', 'src/api.ts', 'src/other.ts'] }),
    );

    expect(cover.regions.map((r) => r.id)).toEqual([
      'migration',
      'api',
      'other-changes',
    ]);
    expect(cover.regions[0]!.files).toEqual(['src/migrate.ts']);
    expect(cover.regions[1]!.files).toEqual(['src/api.ts']);
    // A file only quoted stays UNASSIGNED — the residual owns it, where
    // "the agent did not place these" is the honest row for it.
    expect(cover.regions[2]!.files).toEqual(['src/other.ts']);
    for (const row of cover.regions) {
      expect(row.unit).toBe('presentation');
      expect(row.provenance).toBe('presentation');
      expect(row.parent_id).toBeNull();
      expect(row.depth).toBe(0);
      expect(row.from).toBe(BASE);
      expect(row.to).toBe(HEAD);
    }
  });

  test('residual is LAST and owns everything no group claimed whole', () => {
    const presentation: ReviewPresentation = {
      groups: [group('All', [{ kind: 'prose', body: 'Walkthrough prose only' }])],
    };
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['a.ts', 'b.ts'] }),
    );
    // A prose-only group claims nothing, so the residual owns the universe.
    expect(cover.regions).toHaveLength(2);
    expect(cover.regions[0]!.files).toEqual([]);
    expect(cover.regions[1]!.id).toBe('other-changes');
    expect(cover.regions[1]!.files).toEqual(['a.ts', 'b.ts']);
  });

  test('a snippets-only presentation still partitions via the residual', () => {
    const { cover } = presentedRegions(
      'task1',
      // Groups may be empty when screenshots carry the walkthrough; the
      // partition must still cover the diff.
      { groups: [] },
      inputs({ diffPaths: ['a.ts'] }),
    );
    expect(cover.regions.map((r) => r.id)).toEqual(['other-changes']);
    expect(cover.regions[0]!.files).toEqual(['a.ts']);
  });

  test('an agent-authored residual-titled group keeps its id; the residual yields', () => {
    const presentation: ReviewPresentation = {
      groups: [
        group('Other changes', [{ kind: 'file', file: 'claimed.ts' }]),
      ],
    };
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['claimed.ts', 'unclaimed.ts'] }),
    );
    const ids = cover.regions.map((r) => r.id);
    // The agent's id WINS and the read-time residual yields with the same
    // mint-rule suffix the save boundary uses — shadowing it would hide the
    // content an overlay is keyed on.
    expect(ids).toEqual(['other-changes', 'other-changes-2']);
    expect(cover.regions[0]!.files).toEqual(['claimed.ts']);
    expect(cover.regions[1]!.files).toEqual(['unclaimed.ts']);
  });

  // INVARIANT: region ids are unique HERE, not merely assumed to have been
  // made unique at the save boundary. `assignPresentationGroupIds` only
  // reaches reports saved since it existed; a presentation stored before ids
  // were minted carries none, so every id is the title-slug fallback and two
  // titles that slugify alike arrive colliding. Two rows under one id lose a
  // group's files from the partition silently.
  test('a pre-mint walkthrough whose titles slugify alike still gets distinct ids', () => {
    const presentation: ReviewPresentation = {
      groups: [
        group('Retry path', [{ kind: 'file', file: 'src/retry.ts' }]),
        group('Retry/path', [{ kind: 'file', file: 'src/backoff.ts' }]),
      ],
    };
    const { cover, hashes } = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['src/retry.ts', 'src/backoff.ts'] }),
    );
    expect(cover.regions.map((r) => r.id)).toEqual(['retry-path', 'retry-path-2']);
    expect(cover.regions[0]!.files).toEqual(['src/retry.ts']);
    expect(cover.regions[1]!.files).toEqual(['src/backoff.ts']);
    // The per-region sign-off hashes are keyed by id too — a collision there
    // silently kept only the last row's.
    expect(hashes.size).toBe(2);
  });

  test('an overlay merges onto the group id, with per-field attribution', () => {
    const presentation: ReviewPresentation = {
      groups: [group('Migration', [{ kind: 'file', file: 'src/migrate.ts' }])],
    };
    const overlays: RegionOverlay[] = [
      {
        unit_id: 'migration',
        name: 'The migration',
        owner: 'peer',
        signed_off_sha: 'cccccccccccccccccccccccccccccccccccccccc',
        updated_at: 1,
      },
    ];
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['src/migrate.ts'], overlays }),
    );
    const row = cover.regions[0]!;
    expect(row.name).toBe('The migration');
    expect(row.owner).toBe('peer');
    expect(row.signed_off_sha).toBe('cccccccccccccccccccccccccccccccccccccccc');
  });

  test('a sign-off stales on the REGION\'s own content, not on the head', () => {
    // INVARIANT: a commit touching region B's files must not stale region A's
    // sign-off, and touching A's must — the whole point of keying the
    // approval to what was actually approved (§6.1). The carve's head
    // comparison staled every region on every commit; the hash does not.
    const presentation: ReviewPresentation = {
      groups: [
        group('A', [{ kind: 'file', file: 'a.ts' }]),
        group('B', [{ kind: 'file', file: 'b.ts' }]),
      ],
    };
    const pairsAtSignOff = new Map([
      ['a.ts', '1111:2222'],
      ['b.ts', '3333:4444'],
    ]);
    const before = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['a.ts', 'b.ts'], pairs: pairsAtSignOff }),
    );

    // A later commit changes ONLY b.ts: B's hash moves, A's does not.
    const pairsAfter = new Map([
      ['a.ts', '1111:2222'],
      ['b.ts', '3333:9999'],
    ]);
    const after = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['a.ts', 'b.ts'], pairs: pairsAfter }),
    );

    expect(after.hashes.get('a')).toBe(before.hashes.get('a'));
    expect(after.hashes.get('b')).not.toBe(before.hashes.get('b'));
  });

  test('a deleted file changes its region\'s hash through the null blob', () => {
    const presentation: ReviewPresentation = {
      groups: [group('A', [{ kind: 'file', file: 'gone.ts' }])],
    };
    const alive = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['gone.ts'], pairs: new Map([['gone.ts', '1111:2222']]) }),
    );
    const deleted = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['gone.ts'], pairs: new Map([['gone.ts', '1111:0000000000']]) }),
    );
    expect(deleted.hashes.get('a')).not.toBe(alive.hashes.get('a'));
  });

  test('a claimed path outside the diff range contributes nothing to the hash', () => {
    // A group may claim a file the range never changed (the agent pointing at
    // context). Hashing a placeholder would stale the sign-off on the very
    // commit the presentation was written against; the content is unchanged
    // by definition, so it contributes nothing.
    const presentation: ReviewPresentation = {
      groups: [group('A', [{ kind: 'file', file: 'a.ts' }, { kind: 'file', file: 'context.ts' }])],
    };
    const withOutside = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['a.ts'], pairs: new Map([['a.ts', '1111:2222']]) }),
    );
    const onlyOwned = presentedRegions(
      'task1',
      presentation,
      inputs({ diffPaths: ['a.ts'], pairs: new Map([['a.ts', '1111:2222']]) }),
    );
    expect(withOutside.hashes.get('a')).toBe(onlyOwned.hashes.get('a'));
  });

  test('the hash is stable under path-report order', () => {
    // INVARIANT: the hash is a function of the content set, not of the order
    // git reported the paths in — a reorder must not stale an approval.
    const presentation: ReviewPresentation = {
      groups: [group('A', [{ kind: 'file', file: 'a.ts' }, { kind: 'file', file: 'b.ts' }])],
    };
    const first = presentedRegions(
      'task1',
      presentation,
      inputs({
        diffPaths: ['a.ts', 'b.ts'],
        pairs: new Map([
          ['a.ts', '1111:2222'],
          ['b.ts', '3333:4444'],
        ]),
      }),
    );
    const second = presentedRegions(
      'task1',
      presentation,
      inputs({
        diffPaths: ['b.ts', 'a.ts'],
        pairs: new Map([
          ['b.ts', '3333:4444'],
          ['a.ts', '1111:2222'],
        ]),
      }),
    );
    expect(second.hashes.get('a')).toBe(first.hashes.get('a'));
  });
});

describe('latestPresentation', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let taskId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-pres-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-pres-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Presentation regions test');
    taskId = task.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  const reportInput = (presentation: ReviewPresentation) => ({
    session_id: 'sess-1',
    sections: [{ kind: 'commentary' as const, body: 'Walkthrough' }],
    presentation,
  });

  // INVARIANT (the engineer's rule this work exists for): a cap that refused
  // a walkthrough is visible to the reviewer EVEN IF no fitting walkthrough
  // was ever filed — the agent gave up, wrote prose instead, or the turn was
  // killed. Reading the refusal only off the report that carries a
  // presentation would have made the cap visible exactly when it had already
  // been worked around, and invisible in the case that matters most.
  test('the newest cap refusal is found without any presentation to hang it on', async () => {
    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-capped',
      sections: [{ kind: 'commentary', body: 'I could not fit a walkthrough' }],
      presentation_cap_refusal: { cap: 'file_items', limit: 512, actual: 604, created_at: 1 },
    });
    const refusal = await latestCapRefusal(storage, taskId);
    expect(refusal?.cap).toBe('file_items');
    expect(refusal?.actual).toBe(604);
    // And there is no walkthrough — the two reads are independent.
    expect(await latestPresentation(storage, taskId)).toBeNull();
    // What the reviewer is told in that case is its own sentence: there is no
    // partition at all here, so the residual wording ("some of these files
    // may be unassigned") would describe a block that does not exist.
    const note = capRefusedWithoutWalkthroughNote(refusal!);
    expect(note).toContain('the 512-file-item cap');
    expect(note).toContain('no walkthrough because of the cap');
  });

  test('returns null when no turn report declared a presentation', async () => {
    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-1',
      sections: [{ kind: 'commentary', body: 'No walkthrough here' }],
    });
    expect(await latestPresentation(storage, taskId)).toBeNull();
  });

  test('the newest presentation wins across sessions', async () => {
    // INVARIANT: same recency rule the save boundary applies when it needs a
    // predecessor's group ids — a restarted session's final turn supersedes
    // whatever an earlier session walked, by (updated_at ?? created_at).
    const first = await storage.upsertTurnReport(taskId, reportInput({
      groups: [group('First', [{ kind: 'file', file: 'a.ts' }])],
    }));
    // The recency key is wall-clock ms; two real sessions are seconds apart,
    // but two back-to-back upserts can land in the same millisecond and tie
    // the sort. Sleep so this encodes "the restarted session is LATER", not
    // "two reports are unorderable".
    await Bun.sleep(2);
    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-2',
      sections: [{ kind: 'commentary', body: 'Re-walked' }],
      presentation: {
        groups: [group('Second', [{ kind: 'file', file: 'b.ts' }])],
      },
    });

    const latest = await latestPresentation(storage, taskId);
    expect(latest?.groups.map((g) => g.title)).toEqual(['Second']);
    expect(first.presentation?.groups[0]!.title).toBe('First');
  });

  test('an orthogonal later report does not shadow the walkthrough', async () => {
    await storage.upsertTurnReport(taskId, reportInput({
      groups: [group('Kept', [{ kind: 'file', file: 'a.ts' }])],
    }));
    // A DIFFERENT session's presentation-less report (an auto-fix turn's
    // plain report, say) must not hide the last walkthrough: the loader
    // reads the newest report that DECLARED a presentation, not the newest
    // report. A same-session report is the opposite case — upsert replaces
    // that session's report wholesale, so a session re-filing without a
    // presentation has deliberately revoked it (covered by the test above:
    // latest-wins per session is the save boundary's own invariant).
    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-2',
      sections: [{ kind: 'commentary', body: 'A plain report' }],
    });
    const latest = await latestPresentation(storage, taskId);
    expect(latest?.groups.map((g) => g.title)).toEqual(['Kept']);
  });
});
/**
 * A group whose claim is a DIRECTORY or GLOB is one region owning every file
 * the pattern resolved to.
 *
 * INVARIANT: the partition reads through the expansion. A pattern is one
 * ITEM — that is what makes a release-sized branch presentable — and many
 * MEMBERS, so the residual holds only what no pattern and no path claimed.
 */
describe('presentedRegions with directory/glob claims', () => {
  const DIFF = [
    'src/review/report.ts',
    'src/review/policy.ts',
    'src/other.ts',
    'test/e2e/regions-web.test.ts',
    'test/e2e/regions-cli.test.ts',
  ];

  test('a glob-claimed group is one region owning all its matched files', () => {
    const presentation: ReviewPresentation = {
      groups: [
        group('The review code', [
          { kind: 'file', file: 'src/review/', matched: ['src/review/report.ts', 'src/review/policy.ts'] },
        ]),
        group('Region tests', [
          {
            kind: 'file',
            file: 'test/e2e/regions*.test.ts',
            matched: ['test/e2e/regions-web.test.ts', 'test/e2e/regions-cli.test.ts'],
          },
        ], { tier: 'tests' }),
      ],
    };
    const { cover } = presentedRegions('task1', presentation, inputs({ diffPaths: DIFF }));

    expect(cover.regions.map((r) => r.id)).toEqual([
      'the-review-code',
      'region-tests',
      'other-changes',
    ]);
    expect(cover.regions[0]!.files).toEqual([
      'src/review/report.ts',
      'src/review/policy.ts',
    ]);
    expect(cover.regions[1]!.files).toEqual([
      'test/e2e/regions-web.test.ts',
      'test/e2e/regions-cli.test.ts',
    ]);
    // Only the file no pattern matched is left over — the counts still add up
    // to the size of the change, which is what a partition is for.
    expect(cover.regions[2]!.files).toEqual(['src/other.ts']);
    const owned = cover.regions.reduce((n, r) => n + r.files.length, 0);
    expect(owned).toBe(DIFF.length);
  });

  test('the residual region says how many files the walkthrough did not name', () => {
    const presentation: ReviewPresentation = {
      groups: [group('Some of it', [{ kind: 'file', file: 'src/other.ts' }])],
    };
    const { cover } = presentedRegions('task1', presentation, inputs({ diffPaths: DIFF }));
    const residual = cover.regions.find((r) => r.id === 'other-changes')!;
    expect(residual.note).toBe('4 of 5 changed files are not named in the walkthrough.');
  });

  // INVARIANT: a cap that refused a walkthrough reaches the REVIEWER. The
  // builder reviewing a hub must be able to see "the walkthrough hit the cap"
  // without reading the agent's turn — otherwise the only signal a cap ever
  // produces is a tool error the agent silently works around.
  test('a recorded cap refusal reaches the residual row and the cover notes', () => {
    const presentation: ReviewPresentation = {
      groups: [group('Some of it', [{ kind: 'file', file: 'src/other.ts' }])],
    };
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({
        diffPaths: DIFF,
        capRefusal: { cap: 'file_items', limit: 512, actual: 604, created_at: 1 },
      }),
    );
    const residual = cover.regions.find((r) => r.id === 'other-changes')!;
    expect(residual.note).toContain('the 512-file-item cap');
    expect(residual.note).toContain('604 declared');
    // Said ONCE: the row that holds the unassigned files is the place for it,
    // so the cover note stays empty rather than repeating the same sentence a
    // few lines further down the same page.
    expect(cover.notes).toEqual([]);
  });

  test('with nothing left over, the cap rides the cover note instead', () => {
    // There is no residual row to carry it, and a cap that refused a
    // walkthrough must not become invisible just because the rewrite managed
    // to cover everything.
    const presentation: ReviewPresentation = {
      groups: [group('All of it', DIFF.map((file) => ({ kind: 'file' as const, file })))],
    };
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({
        diffPaths: DIFF,
        capRefusal: { cap: 'file_items', limit: 512, actual: 604, created_at: 1 },
      }),
    );
    expect(cover.regions.map((r) => r.id)).toEqual(['all-of-it']);
    const note = cover.notes.join(' ');
    expect(note).toContain('the 512-file-item cap');
    // ...and it says the GOOD outcome, not the residual's. There is no
    // unassigned block here, so "some of these files may be unassigned" would
    // have no antecedent and would send the reviewer hunting for something
    // that is not there — a defect report about a complete partition.
    expect(note).toContain('covers every file of the change');
    expect(note).not.toContain('may be unassigned');
  });

  // INVARIANT: the cap follows the TASK, not the session. A session that hits
  // the cap and is then interrupted or watchdogged records the refusal on its
  // own report; the session that resumes files the smaller walkthrough on a
  // row of its own — and the long hub turns that hit caps are exactly the ones
  // that get interrupted. Keying the line to the report row lost the cap in
  // that case, which is the "it reads like the agent chose to leave things
  // out" failure this work exists to end.
  test('a refusal from another report does not claim THIS walkthrough hit the cap', () => {
    const presentation: ReviewPresentation = {
      groups: [group('Some of it', [{ kind: 'file', file: 'src/other.ts' }])],
    };
    const { cover } = presentedRegions(
      'task1',
      presentation,
      inputs({
        diffPaths: DIFF,
        capRefusal: { cap: 'groups', limit: 32, actual: 33, created_at: 1 },
        // A LATER walkthrough was refused; what is on record is the earlier one.
        capRefusalSameReport: false,
      }),
    );
    const note = cover.regions.find((r) => r.id === 'other-changes')!.note!;
    expect(note).toContain('the 32-group cap');
    expect(note).toContain('A later walkthrough on this task was refused');
    expect(note).toContain('the one filed before it');
    expect(note).not.toContain('The walkthrough hit');
  });
});

/**
 * Which refusal a walkthrough is shown with.
 *
 * INVARIANT: the task-wide fallback RETIRES. A refusal older than the
 * walkthrough on record has been answered by it — the agent hit the cap, then
 * wrote something that fits — so annotating that walkthrough would tell the
 * reviewer files may be unassigned "because of the cap" when they are
 * unassigned by choice. Left to run, a cap from turn 4 decorated a complete
 * walkthrough at turn 40 forever, which teaches a reviewer to ignore the line.
 */
describe('capRefusalFor', () => {
  const refusal = (at: number) => ({
    cap: 'groups' as const, limit: 32, actual: 33, created_at: at,
  });
  const report = (at: number, own?: ReturnType<typeof refusal>) => ({
    id: 'r', task_id: 't', session_id: 's', sections: [], created_at: at,
    ...(own ? { presentation_cap_refusal: own } : {}),
  }) as unknown as Parameters<typeof capRefusalFor>[0];

  test('the walkthrough\'s own refusal wins, and is attributed to it', () => {
    const own = refusal(50);
    expect(capRefusalFor(report(50, own), refusal(10))).toEqual({
      capRefusal: own,
      capRefusalSameReport: true,
    });
  });

  test('a refusal NEWER than the walkthrough is shown, as another report\'s', () => {
    // The agent had this walkthrough on record, tried to file a bigger one,
    // and was refused without replacing it — still true, still worth saying.
    const later = refusal(90);
    expect(capRefusalFor(report(50), later)).toEqual({
      capRefusal: later,
      capRefusalSameReport: false,
    });
  });

  test('a refusal OLDER than the walkthrough is retired', () => {
    // The interrupted-session case: the cap was hit, then a fitting
    // walkthrough was filed after it. That walkthrough answers the cap, so
    // there is nothing left to warn about.
    expect(capRefusalFor(report(50), refusal(10))).toEqual({});
  });

  test('with no walkthrough at all, any recorded refusal still counts', () => {
    const only = refusal(10);
    expect(capRefusalFor(null, only)).toEqual({
      capRefusal: only,
      capRefusalSameReport: false,
    });
  });
});

/**
 * A region note as a LIST ROW shows it.
 *
 * INVARIANT: the residual row's system sentences — the uncovered count and
 * the cap line — are never clipped. They are the rows that must stay
 * readable, and they sit in the same slot as an agent's group summary, which
 * is a paragraph or two by design.
 */
describe('regionNoteLine', () => {
  test('a group summary paragraph is clipped to one scannable line', () => {
    const wall = `${'A long sentence about this slice of the change. '.repeat(20)}`;
    const line = regionNoteLine(wall)!;
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line.endsWith('…')).toBe(true);
  });

  test('only the first line survives, so markdown bullets do not flood the row', () => {
    expect(regionNoteLine('The retry path.\n\n- one\n- two')).toBe('The retry path.');
    expect(regionNoteLine('   ')).toBeUndefined();
    expect(regionNoteLine(undefined)).toBeUndefined();
  });

  test('the residual row\'s count AND cap line survive whole', () => {
    // The worst case the system generates: the longest cap wording after the
    // longest count sentence. If a future wording pushes past the limit, this
    // fails rather than silently clipping the line a reviewer needs most.
    const note = residualSummary(199, 277, { cap: 'narrative_items', limit: 64, actual: 71, created_at: 1 });
    expect(regionNoteLine(note)).toBe(note);
    expect(note).toContain('the 64-snippet/prose-item cap');
  });
});

describe('the note a hub leaves when it passes over a stale walkthrough', () => {
  // INVARIANT (review 6ac1a2b8): a reader who remembers a walkthrough being
  // filed is owed the reason they are not being shown it. The failure this
  // rule fixes was SILENT — the cover stamps the CURRENT head whatever the
  // walkthrough's age, so a frozen map rendered identically to a fresh one —
  // and a fallback that is equally silent would only move the silence.
  test('names the head the walkthrough was written at, and the head now', () => {
    const note = staleWalkthroughNote('1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222');
    expect(note).toContain('11111111');
    expect(note).toContain('22222222');
    expect(note).toContain('branch has moved since');
    // And says what the reader IS looking at, so the note is actionable
    // rather than just an apology.
    expect(note).toContain('re-derives this map whenever the branch moves');
  });

  // An UNSTAMPED walkthrough is not known to be old — it cannot be shown to be
  // current, which is a different sentence and must read as one. Saying "the
  // branch has moved since" would assert something nobody checked.
  test('an unstamped walkthrough is described as uncheckable, not as old', () => {
    const note = staleWalkthroughNote(undefined, '2222222222222222222222222222222222222222');
    expect(note).toContain('cannot be shown to be current');
    expect(note).not.toContain('branch has moved since');
  });
});
