import { describe, test, expect } from 'bun:test';
import type { Turn, Actor, TurnRole, Task, Session } from '../../src/types';
import { buildTaskShowLines, type TaskShowData } from '../../src/cli/commands/show';
import { taskDetailHtml } from '../../src/server/templates';
import { buildNavItemsForTask, getChunkOverview, type ReviewData } from '../../src/cli/tui/review';
import type { NavItem } from '../../src/cli/tui/renderer';

/**
 * Tests that every presentation surface groups turns by the SAME review-chunk
 * boundary (one human/builder turn plus its following agent/supervisor/system
 * turns), reusing the single source of truth `groupTurnsIntoChunks`. The boundary
 * rule itself is covered in turn-chunks.test.ts; these tests assert each surface
 * actually renders the grouping and exposes actor/auto provenance.
 *
 * Scenario shared across surfaces: human turn → agent → system auto-resume →
 * agent → supervisor nudge → agent → human turn → agent. That is exactly two
 * chunks; the auto-resume and nudge must be absorbed into the first chunk, never
 * promoted to their own boundary.
 */

let seq = 0;
function turn(role: TurnRole, opts: { actor?: Actor; auto?: boolean; content?: string } = {}): Turn {
  return {
    id: `t${seq}`,
    session_id: 's',
    sequence: seq++,
    role,
    content: opts.content ?? `turn ${seq} body`,
    timestamp: 1_700_000_000_000 + seq * 1000,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.auto !== undefined ? { auto_triggered: opts.auto } : {}),
  };
}

/** The shared two-chunk scenario. */
function scenarioTurns(): Turn[] {
  seq = 0;
  return [
    turn('human', { actor: 'human', content: 'first human ask' }), // 0: chunk A boundary
    turn('agent', { content: 'agent work A1' }),                    // 1: A
    turn('human', { actor: 'system', auto: true, content: '[system] auto-resumed' }), // 2: A
    turn('agent', { content: 'agent work A2' }),                    // 3: A
    turn('human', { actor: 'supervisor', auto: true, content: 'supervisor nudge' }),  // 4: A
    turn('agent', { content: 'agent work A3' }),                    // 5: A
    turn('human', { actor: 'human', content: 'second human ask' }), // 6: chunk B boundary
    turn('agent', { content: 'agent work B1' }),                    // 7: B
  ];
}

function mockTask(): Task {
  return {
    id: 'abc12345',
    code: 'demo-task',
    goal: 'demo goal',
    prompt: 'demo prompt',
    type: 'task',
    status: 'blocked',
    created_at: 1_700_000_000_000,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: 'claude-opus-4-8',
    agent_id: 'claude',
    metadata: null,
    pending_sync: 0,
  };
}

function mockSession(): Session {
  return {
    id: 'sess1',
    task_id: 'abc12345',
    agent_id: 'claude',
    started_at: 1_700_000_000_000,
    ended_at: null,
    outcome: null,
    git_branch: 'lazy/demo',
    git_start_sha: 'deadbeefcafef00d',
    agent_session_id: null,
    last_interaction_at: null,
    total_duration_ms: 0,
    total_usage: null,
    container_name: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
    user_stopped: false,
    upstream_merge_sha: null,
  };
}

// ── CLI: lazy show --chunks ────────────────────────────────────────────────
describe('CLI buildTaskShowLines --chunks', () => {
  function showData(turns: Turn[]): TaskShowData {
    return {
      task: mockTask(),
      session: mockSession(),
      turns,
      commits: [],
      comments: [],
      journal: [],
      followUps: [],
      statusHistory: [],
      children: [],
      childSessions: new Map(),
      proposals: [],
      parent: null,
      retryStatus: null,
      orphanStatus: null,
      autoReactStatus: null,
      supervisorStatus: null,
      workingSubstate: null,
    } as unknown as TaskShowData;
  }

  test('flat mode (default) does not emit chunk headers', () => {
    const out = buildTaskShowLines(showData(scenarioTurns()), false).join('\n');
    expect(out).not.toContain('Chunk 1');
    expect(out).toContain('Turns:');
  });

  test('chunked mode emits exactly two chunk headers for the scenario', () => {
    const out = buildTaskShowLines(showData(scenarioTurns()), false, true).join('\n');
    expect(out).toContain('Turns (chunked):');
    expect(out).toContain('Chunk 1');
    expect(out).toContain('Chunk 2');
    expect(out).not.toContain('Chunk 3'); // auto-resume + nudge absorbed, not new chunks
    expect(out).toContain('2 chunks');
  });

  test('chunked mode still renders every turn and flags auto provenance', () => {
    const out = buildTaskShowLines(showData(scenarioTurns()), false, true).join('\n');
    for (let i = 0; i < 8; i++) expect(out).toContain(`#${i} `);
    // supervisor/system human-role turns are labelled by actor, not "human"
    expect(out).toContain('[supervisor]');
    expect(out).toContain('[system]');
    expect(out).toContain('auto');
  });
});

// ── Web: task detail view ──────────────────────────────────────────────────
describe('Web taskDetailHtml chunk grouping', () => {
  test('renders turns grouped into two chunks with provenance', () => {
    // args after turns: commits, comments, journal, followUps, children, promptVersions
    const html = taskDetailHtml(mockTask(), mockSession(), scenarioTurns(), [], [], [], [], [], []);
    // Two chunk containers, no third.
    const chunkHeaders = html.match(/class="turn-chunk-header"/g) ?? [];
    expect(chunkHeaders.length).toBe(2);
    expect(html).toContain('Chunk 1');
    expect(html).toContain('Chunk 2');
    expect(html).not.toContain('Chunk 3');
    expect(html).toContain('2 chunks');
    // auto badge + actor labels surface provenance
    expect(html).toContain('turn-auto');
    expect(html).toContain('[supervisor]');
    expect(html).toContain('[system]');
  });

  test('a single human turn yields a single chunk', () => {
    seq = 0;
    const html = taskDetailHtml(mockTask(), mockSession(), [turn('human', { actor: 'human' })], [], [], [], [], [], []);
    const chunkHeaders = html.match(/class="turn-chunk-header"/g) ?? [];
    expect(chunkHeaders.length).toBe(1);
    expect(html).toContain('1 chunk)'); // singular, no trailing 's'
  });
});

// ── Review TUI: nav grouping + chunk overview ──────────────────────────────
describe('Review TUI chunk grouping', () => {
  function reviewData(turns: Turn[]): ReviewData {
    return {
      task: mockTask(),
      session: mockSession(),
      turns,
      commits: [],
      comments: [],
      unseenComments: [],
      journal: [],
      followUps: [],
      proposals: [],
      diffStat: '',
      diffFull: '',
      worktreePath: '/tmp/wt',
      targetBranch: 'main',
      lastAgentTurn: null,
      turnInfoMap: new Map(),
      taskTree: null,
      childTasks: [],
      parentTask: null,
    } as unknown as ReviewData;
  }

  function findByKey(items: NavItem[], pred: (k: string) => boolean): NavItem[] {
    const out: NavItem[] = [];
    const walk = (list: NavItem[]) => {
      for (const it of list) {
        if (pred(it.key)) out.push(it);
        if (it.children) walk(it.children);
      }
    };
    walk(items);
    return out;
  }

  test('Turns nav node has chunk children, each holding turn nodes', () => {
    const items = buildNavItemsForTask(reviewData(scenarioTurns()), new Map());
    const turnsNode = findByKey(items, k => k === 'turns')[0];
    expect(turnsNode).toBeDefined();
    const chunkNodes = (turnsNode.children ?? []).filter(c => c.key.startsWith('chunk:'));
    expect(chunkNodes.length).toBe(2); // two chunks, newest first
    // Every chunk node's children are turn-node items.
    for (const c of chunkNodes) {
      expect((c.children ?? []).length).toBeGreaterThan(0);
      for (const t of c.children ?? []) {
        expect(t.key.startsWith('turn-node:')).toBe(true);
      }
    }
    // All eight turn nodes survive the grouping.
    const turnNodes = findByKey(items, k => k.startsWith('turn-node:'));
    expect(turnNodes.length).toBe(8);
  });

  test('turn node labels expose actor/auto provenance', () => {
    const items = buildNavItemsForTask(reviewData(scenarioTurns()), new Map());
    const labels = findByKey(items, k => k.startsWith('turn-node:')).map(n => n.label);
    expect(labels.some(l => l.includes('[supervisor]'))).toBe(true);
    expect(labels.some(l => l.includes('[system]'))).toBe(true);
    expect(labels.some(l => l.includes('(auto)'))).toBe(true);
  });

  test('getChunkOverview lists the chunk boundary and all member turns', () => {
    const data = reviewData(scenarioTurns());
    const overview = getChunkOverview(data, 0).join('\n');
    expect(overview).toContain('Chunk 1');
    // First chunk absorbs turns 0..5 (boundary + auto-resume + nudge + agents).
    for (let i = 0; i <= 5; i++) expect(overview).toContain(`#${i} `);
    expect(overview).not.toContain('#6 '); // belongs to chunk 2
  });
});
