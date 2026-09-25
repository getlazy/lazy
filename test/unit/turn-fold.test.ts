/**
 * Folding comments / journal into turn chunks by timestamp.
 *
 * INVARIANT: every folded note has a stable home so *Since you last looked*
 * can link `#journal-<id>` / `#comment-<id>`. Items before the first chunk
 * land in the first chunk; extras with no turns still render. Commits are
 * NOT folded — they nest under the agent/work turn (see turn-commits).
 */

import { describe, test, expect } from 'bun:test';
import type { Turn, Commit, Comment, JournalEntry } from '../../src/types';
import { chunkIndexFor, foldRecordIntoChunks } from '../../src/server/turn-fold';
import { taskTurnsSectionHtml } from '../../src/server/templates';
import type { Task, Session } from '../../src/types';

function turn(seq: number, ts: number, role: Turn['role'] = 'human'): Turn {
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
    ...(role === 'human' ? { actor: 'human' as const } : {}),
  };
}

function commit(id: string, ts: number): Commit {
  return { id, session_id: 's', sha: `${id}sha0000`, message: `commit ${id}`, status: 'approved', timestamp: ts };
}

function comment(id: string, ts: number): Comment {
  return { id, task_id: 'task', content: `comment ${id}`, created_at: ts, actor: 'human' };
}

function journal(id: string, ts: number): JournalEntry {
  return { id, task_id: 'task', content: `journal ${id}`, created_at: ts, actor: 'agent' };
}

const task: Task = {
  id: 'task-fold',
  code: 'fold-demo',
  goal: 'fold',
  prompt: 'fold',
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
  task_id: 'task-fold',
  agent_id: 'claude',
  runner_type: null,
  started_at: 1000,
  ended_at: null,
  outcome: null,
  git_branch: 'lazy/fold',
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

describe('chunkIndexFor', () => {
  test('items before the first start land in chunk 0', () => {
    expect(chunkIndexFor(50, [100, 200])).toBe(0);
  });

  test('a timestamp on a later start belongs to that chunk, not the previous', () => {
    expect(chunkIndexFor(200, [100, 200])).toBe(1);
    expect(chunkIndexFor(199, [100, 200])).toBe(0);
  });

  test('an empty starts list is -1 (synthetic extras-only group)', () => {
    expect(chunkIndexFor(1, [])).toBe(-1);
  });
});

describe('foldRecordIntoChunks', () => {
  test('folds comments and journal into the chunk window they belong to', () => {
    // Chunk 0: human@100 + agent@150. Chunk 1: human@300.
    const turns = [turn(1, 100), turn(2, 150, 'agent'), turn(3, 300)];
    const folded = foldRecordIntoChunks(turns, {
      comments: [comment('n-early', 50)],
      journal: [journal('j-second', 310)],
    });
    expect(folded).toHaveLength(2);
    expect(folded[0]!.items.map((i) => i.kind)).toEqual(['comment', 'turn', 'turn']);
    expect(folded[1]!.items.map((i) => i.kind)).toEqual(['turn', 'journal']);
  });

  test('extras with no turns still produce one group so anchors exist', () => {
    const folded = foldRecordIntoChunks([], {
      journal: [journal('j1', 10)],
      comments: [comment('c1', 20)],
    });
    expect(folded).toHaveLength(1);
    expect(folded[0]!.chunk).toBeNull();
    expect(folded[0]!.items.map((i) => i.kind)).toEqual(['journal', 'comment']);
  });

  test('empty turns and empty extras is empty', () => {
    expect(foldRecordIntoChunks([])).toEqual([]);
  });
});

describe('taskTurnsSectionHtml folding', () => {
  test('a journal entry keeps id="journal-<id>" even with no turns', () => {
    const html = taskTurnsSectionHtml(task, session, [], 'newest', {
      journal: [journal('jid-anchor', 10)],
    });
    expect(html).toContain('id="journal-jid-anchor"');
    expect(html).toContain('journal jid-anchor');
    expect(html).not.toContain('<h2>Journal');
  });

  test('a comment keeps its anchor inside the chunk; commits nest under the turn', () => {
    const html = taskTurnsSectionHtml(task, session, [turn(1, 100), turn(2, 150, 'agent')], 'newest', {
      comments: [comment('cid-1', 110)],
      // Commit stamped after the agent turn (reconcile order).
      commits: [commit('cmid-1', 160)],
    });
    expect(html).toContain('id="comment-cid-1"');
    expect(html).toContain('id="commit-cmid-1"');
    expect(html).toContain('turn-commits');
    expect(html).toContain('Chunk 1');
    expect(html).not.toContain('<h2>Comments');
    expect(html).not.toContain('<h2>Commits');
  });

  test('?chunks=oldest keeps working when extras are folded', () => {
    // Two chunks: human+agent, then a later human. Newest-first reverses
    // chunks AND the items inside each chunk.
    const turns = [turn(1, 100), turn(2, 150, 'agent'), turn(3, 300)];
    const newest = taskTurnsSectionHtml(task, session, turns, 'newest', {
      journal: [journal('j', 160)],
    });
    const oldest = taskTurnsSectionHtml(task, session, turns, 'oldest', {
      journal: [journal('j', 160)],
    });
    expect(newest.indexOf('Chunk 2')).toBeLessThan(newest.indexOf('Chunk 1'));
    expect(oldest.indexOf('Chunk 1')).toBeLessThan(oldest.indexOf('Chunk 2'));
    expect(oldest).toContain('Newest first');
    const newestChunk1 = newest.slice(newest.indexOf('Chunk 1 ·'));
    expect(newestChunk1.indexOf('>Turn #2</a>')).toBeLessThan(newestChunk1.indexOf('>Turn #1</a>'));
    const oldestChunk1 = oldest.slice(oldest.indexOf('Chunk 1 ·'), oldest.indexOf('Chunk 2 ·'));
    expect(oldestChunk1.indexOf('>Turn #1</a>')).toBeLessThan(oldestChunk1.indexOf('>Turn #2</a>'));
  });

  test('the Turns tab states the chunking rule in one line', () => {
    const html = taskTurnsSectionHtml(task, session, [turn(1, 100)], 'newest');
    expect(html).toContain('A chunk is what happened since you last acted');
  });
});
