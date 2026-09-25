/**
 * Commit → turn attribution by timestamp window (Commit has no turn_id).
 *
 * INVARIANT: a commit belongs to the latest agent/work turn whose
 * timestamp is <= the commit's. Same-ms commits belong to that turn.
 * Nudge/ask/review turns never nest commits. Agent/work turns are the
 * only cards that nest them.
 */

import { describe, test, expect } from 'bun:test';
import type { Turn, Commit, Task, Session } from '../../src/types';
import {
  attributeCommitsToTurns,
  commitsForTurn,
  isAgentWorkTurn,
} from '../../src/server/turn-commits';
import { taskTurnsSectionHtml, taskCommitsSectionHtml } from '../../src/server/templates';

function turn(
  seq: number,
  ts: number,
  role: Turn['role'] = 'agent',
  turnType?: Turn['turn_type'],
): Turn {
  return {
    id: `t${seq}`,
    session_id: 's',
    sequence: seq,
    role,
    content: `turn ${seq}`,
    timestamp: ts,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...(turnType ? { turn_type: turnType } : {}),
    ...(role === 'human' ? { actor: 'human' as const } : {}),
  };
}

function commit(id: string, ts: number, message = `commit ${id}`): Commit {
  return {
    id,
    session_id: 's',
    sha: `${id}abcdef01`,
    message,
    status: 'approved',
    timestamp: ts,
  };
}

const task: Task = {
  id: 'task-commits',
  code: 'commits-demo',
  goal: 'commits',
  prompt: 'commits',
  type: 'task',
  status: 'blocked',
  created_at: 1000,
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
  task_id: 'task-commits',
  agent_id: 'claude',
  runner_type: null,
  started_at: 1000,
  ended_at: null,
  outcome: null,
  git_branch: 'lazy/commits',
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

describe('isAgentWorkTurn', () => {
  test('agent work (and missing turn_type) are work; ask/nudge/review are not', () => {
    expect(isAgentWorkTurn(turn(1, 100, 'agent'))).toBe(true);
    expect(isAgentWorkTurn(turn(1, 100, 'agent', 'work'))).toBe(true);
    expect(isAgentWorkTurn(turn(1, 100, 'agent', 'ask'))).toBe(false);
    expect(isAgentWorkTurn(turn(1, 100, 'agent', 'nudge'))).toBe(false);
    expect(isAgentWorkTurn(turn(1, 100, 'human'))).toBe(false);
  });
});

describe('commitsForTurn', () => {
  test('each commit belongs to the latest work turn at or before it', () => {
    // Recording order: work turn → optional nudge → createCommit (later ts).
    const turns = [
      turn(1, 100, 'human'),
      turn(2, 200, 'agent'),
      turn(3, 210, 'agent', 'nudge'),
      turn(4, 400, 'agent'),
    ];
    const commits = [
      commit('before', 50),
      commit('after-work1', 250),
      commit('after-work2', 450),
    ];
    expect(commitsForTurn(turns[1]!, turns, commits).map((c) => c.id)).toEqual(['after-work1']);
    expect(commitsForTurn(turns[2]!, turns, commits).map((c) => c.id)).toEqual([]);
    expect(commitsForTurn(turns[3]!, turns, commits).map((c) => c.id)).toEqual(['after-work2']);
    expect(commitsForTurn(turns[0]!, turns, commits).map((c) => c.id)).toEqual([]);
  });

  test('same-ms commit belongs to that work turn', () => {
    const turns = [turn(1, 200, 'agent')];
    expect(commitsForTurn(turns[0]!, turns, [commit('same', 200)]).map((c) => c.id)).toEqual(['same']);
  });
});

describe('attributeCommitsToTurns', () => {
  test('maps only work turns; early commits are unattributed', () => {
    const turns = [turn(1, 100, 'human'), turn(2, 200, 'agent')];
    const map = attributeCommitsToTurns(turns, [
      commit('early', 50),
      commit('a', 250),
    ]);
    expect([...map.keys()]).toEqual(['t2']);
    expect(map.get('t2')!.map((c) => c.id)).toEqual(['a']);
  });
});

describe('taskTurnsSectionHtml per-turn commits', () => {
  test('nests commits under the agent work turn, not as a chunk sibling', () => {
    const turns = [turn(1, 100, 'human'), turn(2, 200, 'agent')];
    const html = taskTurnsSectionHtml(task, session, turns, 'newest', {
      commits: [commit('c1', 220, 'Landed the fix')],
    });
    // The agent turn card appears, then its nested commits block.
    const agentAt = html.indexOf('>Turn #2</a>');
    const commitsAt = html.indexOf('turn-commits');
    const shaAt = html.indexOf('commit-sha');
    expect(agentAt).toBeGreaterThan(-1);
    expect(commitsAt).toBeGreaterThan(agentAt);
    expect(shaAt).toBeGreaterThan(commitsAt);
    expect(html).toContain('Landed the fix');
    // Task URLs carry the task's code.
    expect(html).toContain('/tasks/commits-demo/commits/c1');
    // No bare commit-row as a folded sibling before the turn.
    const beforeAgent = html.slice(0, agentAt);
    expect(beforeAgent).not.toContain('commit-sha');
  });

  test('empty attribution adds no chrome under the turn', () => {
    const html = taskTurnsSectionHtml(task, session, [turn(1, 100, 'agent')], 'newest', {
      commits: [],
    });
    expect(html).not.toContain('turn-commits');
  });

  test('ask turns do not nest commits even if a commit follows them', () => {
    const turns = [turn(1, 100, 'human'), turn(2, 200, 'agent', 'ask')];
    const html = taskTurnsSectionHtml(task, session, turns, 'newest', {
      commits: [commit('c1', 250)],
    });
    expect(html).not.toContain('turn-commits');
  });
});

describe('taskCommitsSectionHtml', () => {
  test('lists newest-first with sha links', () => {
    const html = taskCommitsSectionHtml(task, [
      commit('old', 100, 'first'),
      commit('new', 200, 'second'),
    ]);
    expect(html).toContain('<h2>Commits (2)</h2>');
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('first'));
    expect(html).toContain('/tasks/commits-demo/commits/new');
  });

  test('empty list is empty string', () => {
    expect(taskCommitsSectionHtml(task, [])).toBe('');
  });
});
