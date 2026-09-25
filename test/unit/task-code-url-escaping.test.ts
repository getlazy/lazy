/**
 * Task-code URLs: the escaped segment is escaped EXACTLY ONCE.
 *
 * `taskPathSegment()` (src/server/task-urls.ts) returns an already
 * URL-escaped segment — `my task` becomes `my%20task`. Every helper that
 * builds a link receives that ESCAPED value and must interpolate it raw;
 * applying `encodeURIComponent` a second time turns `%20` into `%2520`,
 * which is a different address and 404s.
 *
 * The pin uses a code containing a space for exactly that reason: with a
 * plain kebab code every escaping strategy is byte-identical, so nothing
 * here could ever fail — the bug was invisible to every existing suite.
 */
import { describe, test, expect } from 'bun:test';
import { taskPathSegment } from '../../src/server/task-urls';
import { statsScopeHref } from '../../src/server/stats-tab';
import { agentReportHtml } from '../../src/server/review';
import { reviewActivityCardHtml } from '../../src/server/review-activity';
import { screenshotUrl } from '../../src/server/review-presentation';
import { changesHref, regionsTabHref, regionsTabHtml } from '../../src/server/review-regions';
import { taskPageHtml } from '../../src/server/task-page';
import { reviewDraftScript } from '../../src/server/review-draft-script';
import { shellClientScript } from '../../src/server/shell-ui';
import { watchClientScript } from '../../src/server/watch-ui';
import { containerEnsureClientScript } from '../../src/server/container-ensure-client';
import { taskLiveStatusScript } from '../../src/server/task-live-status';
import { emptyToolStatsRecord, foldAuditRecord } from '../../src/proxy/tool-stats';
import { buildTaskStats } from '../../src/task/stats';
import type { Task, Turn, TurnReport } from '../../src/types';
import type { RegionSummary } from '../../src/regions';
import type { ReviewActivity } from '../../src/server/review-activity';
import type { TaskToolStatsRecord } from '../../src/storage/types';

const T0 = new Date('2026-09-01T00:00:00Z').getTime();

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'my task',
    goal: 'Ship it',
    prompt: 'Do the work',
    type: 'task',
    status: 'blocked',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...over,
  } as Task;
}

/** The escaped segment a code with a space produces. */
const SEG = taskPathSegment(task(), new Set<string>());
expect(SEG).toBe('my%20task');

/** The segment an id-spelled URL produces (identity encoding). */
const ID_SEG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function workTurn(sequence: number): Turn {
  return {
    id: `turn-${sequence}`,
    session_id: 's-1',
    sequence,
    role: 'agent',
    turn_type: 'work',
    content: 'work done',
    timestamp: T0,
  } as unknown as Turn;
}

function implReport(): TurnReport {
  return {
    id: 'r1',
    task_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    session_id: 's-1',
    created_at: T0,
    sections: [
      { kind: 'behavior_change', body: 'Links are no longer escaped twice.' },
      { kind: 'implementation', body: 'Interpolate the escaped segment raw.' },
    ],
  } as unknown as TurnReport;
}

function regionRow(id: string): RegionSummary {
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
  } as unknown as RegionSummary;
}

function emptyActivity(): ReviewActivity {
  return {
    since: null,
    anchorLabel: null,
    turns: [],
    commits: [],
    comments: [],
    journal: [],
    raisedItems: [],
    empty: true,
  };
}

function activity(turns: Turn[], commits: Array<{ id: string; sha: string; message: string; timestamp: number }>): ReviewActivity {
  return {
    since: null,
    anchorLabel: null,
    turns,
    commits,
    comments: [],
    journal: [],
    raisedItems: [],
    empty: false,
  } as unknown as ReviewActivity;
}

/** The double-escape signature: what re-escaping the escaped segment yields. */
const DOUBLE = 'my%2520task';

/** The segment must appear exactly as it was handed in — never re-escaped. */
function assertNoDoubleEscape(html: string, where: string): void {
  expect(html, where).not.toContain(DOUBLE);
}

describe('server-rendered hrefs carry the escaped segment exactly once', () => {
  test('statsScopeHref — the Stats scope toggle', () => {
    assertNoDoubleEscape(statsScopeHref(SEG, 'task'), 'stats task scope');
    assertNoDoubleEscape(statsScopeHref(SEG, 'subtree'), 'stats subtree scope');
    expect(statsScopeHref(SEG, 'task')).toBe('/tasks/my%20task/stats?scope=task');
    expect(statsScopeHref(SEG, 'subtree')).toBe('/tasks/my%20task/stats?scope=subtree');
  });

  test('agentReportHtml seqLink — the Turn link on the report card', () => {
    const html = agentReportHtml(SEG, workTurn(3), implReport(), { surface: 'landing' });
    expect(html).toContain('/tasks/my%20task/turns/3');
    assertNoDoubleEscape(html, 'agent report');
  });

  test('reviewActivityCardHtml — turn, commit, comment and journal rows', () => {
    const card = reviewActivityCardHtml(
      activity([workTurn(7)], [{ id: 'c1', sha: 'abc123def456', message: 'a change', timestamp: T0 }]),
      SEG,
    );
    expect(card).toContain('/tasks/my%20task/turns/7');
    expect(card).toContain('/tasks/my%20task/commits/c1');
    assertNoDoubleEscape(card, 'activity card');
  });

  test('screenshotUrl — the artifact link on Landing', () => {
    expect(screenshotUrl(SEG, 'shot.png')).toBe('/api/review/my%20task/artifact?name=shot.png');
    assertNoDoubleEscape(screenshotUrl(SEG, 'shot.png'), 'screenshot url');
  });

  test('changesHref / regionsTabHref / regionsTabHtml — Changes and Regions', () => {
    expect(changesHref(SEG, null)).toBe('/tasks/my%20task/changes');
    expect(changesHref(SEG, 'task:a')).toBe('/tasks/my%20task/changes?region=task%3Aa');
    expect(regionsTabHref(SEG)).toBe('/tasks/my%20task/regions');
    const tab = regionsTabHtml({ taskId: SEG, regions: [regionRow('task:a')], active: null, notes: [] });
    expect(tab).toContain('Review regions');
    expect(tab).toContain('/tasks/my%20task/changes');
    assertNoDoubleEscape(tab, 'regions tab');
  });

  test('a uuid segment stays byte-identical — no behavior change for id-spelled URLs', () => {
    expect(statsScopeHref(ID_SEG, 'task')).toBe(`/tasks/${ID_SEG}/stats?scope=task`);
    expect(changesHref(ID_SEG, null)).toBe(`/tasks/${ID_SEG}/changes`);
    expect(regionsTabHref(ID_SEG)).toBe(`/tasks/${ID_SEG}/regions`);
    expect(screenshotUrl(ID_SEG, 'shot.png')).toBe(`/api/review/${ID_SEG}/artifact?name=shot.png`);
    expect(agentReportHtml(ID_SEG, workTurn(3), implReport(), { surface: 'landing' })).toContain(
      `/tasks/${ID_SEG}/turns/3`,
    );
    const card = reviewActivityCardHtml(activity([workTurn(7)], []), ID_SEG);
    expect(card).toContain(`/tasks/${ID_SEG}/turns/7`);
  });
});

describe('the task page renders space-code links exactly once', () => {
  // INVARIANT: the two sites the review raise pinned — the Landing
  // implementation hint and the Stats scope toggle — are rendered through
  // the real page route with a code containing a URL-significant character.
  // A helper-level pin alone cannot see a call site that re-escapes its
  // already-escaped argument; the page render can.
  test('Landing: the implementation hint links to the real Changes address', () => {
    const turn = workTurn(3);
    const html = taskPageHtml({
      task: task(),
      session: null,
      turns: [turn],
      commits: [],
      comments: [],
      journal: [],
      raisedItems: [],
      children: [],
      promptVersions: [],
      tab: 'landing',
      lastAgentTurn: turn,
      turnReport: implReport(),
    });
    expect(html).toContain('href="/tasks/my%20task/changes"');
    assertNoDoubleEscape(html, 'landing page');
  });

  test('Stats: the scope toggle links to the real task- and subtree-scope addresses', () => {
    const stats = buildTaskStats({
      task: task({ status: 'working' }),
      session: null,
      turns: [],
      commits: [],
      statusHistory: [],
      now: T0 + 3_600_000,
    });
    const html = taskPageHtml({
      task: task(),
      session: null,
      turns: [],
      commits: [],
      comments: [],
      journal: [],
      raisedItems: [],
      children: [],
      promptVersions: [],
      tab: 'stats',
      stats: { stats, scope: 'task', descendantCount: 3 },
    });
    // The ACTIVE scope renders as a span (aria-current), the INACTIVE one as a
    // link — so the subtree render is what puts the ?scope=task href on the
    // wire, and vice versa. Assert both renders so both addresses are pinned.
    expect(html).toContain('href="/tasks/my%20task/stats?scope=subtree"');
    expect(html).toContain(
      '<span class="lz-scope-opt lz-scope-active" aria-current="true">This task only</span>',
    );
    assertNoDoubleEscape(html, 'stats page');

    const subtree = taskPageHtml({
      task: task(),
      session: null,
      turns: [],
      commits: [],
      comments: [],
      journal: [],
      raisedItems: [],
      children: [],
      promptVersions: [],
      tab: 'stats',
      stats: { stats, scope: 'subtree', descendantCount: 3 },
    });
    expect(subtree).toContain('href="/tasks/my%20task/stats?scope=task"');
    assertNoDoubleEscape(subtree, 'stats subtree page');
  });
});

describe('client scripts interpolate the already-escaped task ref raw', () => {
  // INVARIANT: the server stamps `data-lz-task-id` (and the shell/watch panel
  // attributes) with the URL-escaped segment — for code `my task` the value
  // is `my%20task`. A client script that applies `encodeURIComponent` to it
  // builds `my%2520task`, a different address that 404s. These pins assert
  // the emitted scripts build `/tasks/...` URLs by INTERPOLATING the value,
  // and never re-escaping it; the live-status poll additionally has a
  // behavioral pin in task-live-staleness.test.ts (fetch-URL capture).

  test('review draft autosave', () => {
    const script = reviewDraftScript(SEG);
    expect(script).toContain("'/tasks/' + TASK + '/review/draft'");
    assertNoDoubleEscape(script, 'review draft script');
    expect(script).not.toContain("encodeURIComponent(TASK)");
  });

  test('shell client — websocket URL and tab-switch hrefs', () => {
    const script = shellClientScript();
    // The WS URL is built across a wrapped line: '/tasks/' + taskId, then
    // '/shell/ws?cols=' on the next fragment.
    expect(script).toContain("'/tasks/' + taskId +");
    expect(script).toContain("'/shell/ws?cols=' + cols + '&rows=' + rows");
    expect(script).toContain("lzSwitchTaskTab('/tasks/' + id + '/shell', true)");
    expect(script).not.toContain("encodeURIComponent(taskId) + '/shell");
    expect(script).not.toContain("encodeURIComponent(id) + '/shell");
    assertNoDoubleEscape(script, 'shell script');
  });

  test('watch client — websocket URL', () => {
    const script = watchClientScript();
    expect(script).toContain("'/tasks/' + taskId + '/watch/ws'");
    expect(script).not.toContain("encodeURIComponent(taskId) + '/watch");
    assertNoDoubleEscape(script, 'watch script');
  });

  test('container-ensure client — state poll and ensure POST', () => {
    const script = containerEnsureClientScript();
    expect(script).toContain("'/tasks/' + taskId + '/container/state'");
    expect(script).toContain("'/tasks/' + taskId + '/container/ensure'");
    expect(script).not.toContain("encodeURIComponent(taskId) + '/container");
    assertNoDoubleEscape(script, 'container-ensure script');
  });

  test('live-status client — poll URL', () => {
    const script = taskLiveStatusScript();
    expect(script).toContain("'/tasks/' + taskId + '/live-status'");
    expect(script).not.toContain("encodeURIComponent(taskId) + '/live-status");
    assertNoDoubleEscape(script, 'live-status script');
  });
});