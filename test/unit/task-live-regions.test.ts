/**
 * Unit tests for the per-region freshness keys and the per-tab update policy.
 *
 * INVARIANT: the page notices a change to ANY region, not just the header. The
 * single-token island was blind to subtasks, comments, journal entries, raised
 * items, commits and branch HEAD, so a loop task that stayed `working` while it
 * created and accepted children never refreshed its Subtasks tab at all.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildLiveRegionKeys,
  liveKeysToken,
  changedRegions,
  TASK_LIVE_REGION_IDS,
  TASK_TAB_POLICY,
  TASK_TAB_REGIONS,
  type TaskLiveRegionInput,
} from '../../src/server/task-live-regions';
import { TASK_TAB_ORDER, taskTabStripHtml } from '../../src/server/task-tabs';

function sources(overrides: Partial<TaskLiveRegionInput> = {}): TaskLiveRegionInput {
  return {
    headerKey: 'working|working||1|1000',
    children: [],
    turns: [],
    comments: [],
    journal: [],
    raised: [],
    commits: [],
    headSha: null,
    ...overrides,
  };
}

const token = (o: Partial<TaskLiveRegionInput> = {}) => liveKeysToken(buildLiveRegionKeys(sources(o)));

describe('live region keys', () => {
  test('identical inputs produce identical keys', () => {
    expect(buildLiveRegionKeys(sources())).toEqual(buildLiveRegionKeys(sources()));
  });

  test('a new child moves the subtasks key and the token', () => {
    const before = sources();
    const after = sources({ children: [{ id: 'child-one-aaaa', status: 'backlog' }] });
    expect(buildLiveRegionKeys(after).subtasks).not.toBe(buildLiveRegionKeys(before).subtasks);
    expect(liveKeysToken(buildLiveRegionKeys(after))).not.toBe(liveKeysToken(buildLiveRegionKeys(before)));
  });

  // The exact case the engineer hit: a loop task stays `working` (header key
  // unchanged) while a child moves from working to complete.
  test('a child changing status moves the subtasks key with an unchanged header', () => {
    const working = sources({ children: [{ id: 'child-one-aaaa', status: 'working' }] });
    const done = sources({ children: [{ id: 'child-one-aaaa', status: 'complete' }] });
    const a = buildLiveRegionKeys(working);
    const b = buildLiveRegionKeys(done);
    expect(b.header).toBe(a.header);
    expect(b.subtasks).not.toBe(a.subtasks);
    expect(changedRegions(a, b)).toEqual(['subtasks']);
  });

  // INVARIANT: an in-place edit of an unseen comment keeps the count and the
  // last id, so the comments key must also carry the newest edit time — or an
  // open page keeps showing the old text.
  test('an in-place comment edit moves the comments key', () => {
    const before = buildLiveRegionKeys(sources({ comments: [{ id: 'c1' }] }));
    const after = buildLiveRegionKeys(sources({ comments: [{ id: 'c1', edited_at: 1700000000000 }] }));
    expect(changedRegions(before, after)).toEqual(['comments']);
  });

  test('a new comment, journal entry or raised item each move only their own key', () => {
    const base = buildLiveRegionKeys(sources());
    expect(changedRegions(base, buildLiveRegionKeys(sources({ comments: [{ id: 'c1' }] }))))
      .toEqual(['comments']);
    expect(changedRegions(base, buildLiveRegionKeys(sources({ journal: [{ id: 'j1' }] }))))
      .toEqual(['journal']);
    expect(changedRegions(base, buildLiveRegionKeys(sources({ raised: [{ id: 'r1', status: 'open' }] }))))
      .toEqual(['raised']);
  });

  test('resolving a raised item moves the raised key', () => {
    const open = buildLiveRegionKeys(sources({ raised: [{ id: 'r1', status: 'open' }] }));
    const closed = buildLiveRegionKeys(sources({ raised: [{ id: 'r1', status: 'resolved' }] }));
    expect(closed.raised).not.toBe(open.raised);
  });

  test('a new commit moves the commits key; a new branch HEAD moves changes', () => {
    const base = buildLiveRegionKeys(sources());
    expect(changedRegions(base, buildLiveRegionKeys(sources({ commits: [{ sha: 'abc123def456' }] }))))
      .toEqual(['commits']);
    expect(changedRegions(base, buildLiveRegionKeys(sources({ headSha: 'abc123def456' }))))
      .toEqual(['changes']);
  });

  test('a new turn moves turns; a turn gaining a review also moves reviews', () => {
    const one = buildLiveRegionKeys(sources({ turns: [{ id: 't1', sequence: 1 }] }));
    const two = buildLiveRegionKeys(
      sources({ turns: [{ id: 't1', sequence: 1 }, { id: 't2', sequence: 2 }] }),
    );
    expect(changedRegions(one, two)).toEqual(['turns']);
    const reviewed = buildLiveRegionKeys(
      sources({ turns: [{ id: 't1', sequence: 1, review: { findings: [] } }] }),
    );
    expect(changedRegions(one, reviewed)).toEqual(['reviews']);
  });

  test('the token is the join of every region key', () => {
    const keys = buildLiveRegionKeys(sources({ headSha: 'deadbeefcafe' }));
    for (const id of TASK_LIVE_REGION_IDS) {
      expect(liveKeysToken(keys)).toContain(`${id}=${keys[id]}`);
    }
  });

  test('keys are stable joins, not digests — order of unrelated regions never matters', () => {
    const a = token({ children: [{ id: 'c1', status: 'working' }], comments: [{ id: 'x' }] });
    const b = token({ comments: [{ id: 'x' }], children: [{ id: 'c1', status: 'working' }] });
    expect(a).toBe(b);
  });
});

describe('per-tab update policy', () => {
  // INVARIANT: every tab declares a policy and a region list, or the island
  // (which reads them off the DOM) silently falls back to morphing a tab
  // nobody decided was safe to morph.
  test('every tab has both a policy and a region list', () => {
    for (const tab of TASK_TAB_ORDER) {
      expect(TASK_TAB_POLICY[tab]).toBeDefined();
      expect(TASK_TAB_REGIONS[tab]).toBeDefined();
    }
  });

  // INVARIANT: Shell and Verify host live terminals — a swap kills the
  // session. This was a hardcoded regex in the island; it is data now.
  test('tabs hosting live terminals are never touched', () => {
    expect(TASK_TAB_POLICY.shell).toBe('never');
    expect(TASK_TAB_POLICY.verify).toBe('never');
    expect(TASK_TAB_REGIONS.shell).toEqual([]);
    expect(TASK_TAB_REGIONS.verify).toEqual([]);
  });

  // INVARIANT: a reader working through a diff or typing a review draft is
  // never interrupted by an automatic swap; they get a pill and choose.
  test('Changes and Current review are pill-only', () => {
    expect(TASK_TAB_POLICY.changes).toBe('pill');
    expect(TASK_TAB_POLICY.review).toBe('pill');
  });

  test('every referenced region id is a real region', () => {
    for (const tab of TASK_TAB_ORDER) {
      for (const region of TASK_TAB_REGIONS[tab]) {
        expect(TASK_LIVE_REGION_IDS).toContain(region);
      }
    }
  });

  test('the strip stamps each tab\'s regions and policy so the island needs no tab list', () => {
    const html = taskTabStripHtml({ taskId: 'task-1', current: 'changes' });
    expect(html).toContain('data-lz-tab-regions="subtasks"');
    expect(html).toContain('data-lz-tab-policy="pill"');
    expect(html).toContain('data-lz-tab-policy="never"');
    expect(html).toContain(`data-lz-tab-regions="${TASK_TAB_REGIONS.turns.join(' ')}"`);
  });
});
