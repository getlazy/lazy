/**
 * Regression suite for content-less ANNOTATION records (comments, journal
 * entries, follow-ups).
 *
 * A live crash (2026-08-14): `lazy review release-v021` — a release hub with 86
 * children — died with "undefined is not an object (evaluating
 * 'entry.content.split')" while building the journal nav node. One stored
 * journal entry had no `content` key at all, even though `JournalEntry.content`
 * is typed as a required string. Such records were writable before the MCP and
 * `/rpc` boundaries validated their arguments (fix-mcp-arg-validation): a call
 * that lost its argument envelope reached `appendJournalEntry(taskId,
 * undefined)`, and `JSON.stringify` drops an undefined value, so the key never
 * made it to disk. The same shape crashed nothing else only by luck — the
 * remote-comment sync scans `note.content.match(...)` on every stored comment.
 *
 * This is the annotation-record half of test/unit/turn-content-guard.test.ts,
 * and the same two-part INVARIANT applies:
 *  - the WRITE path can never persist a non-string content (normalizeRecordContent);
 *  - READ paths must degrade VISIBLY and forever — defective records already
 *    exist in users' stores and are never rewritten, so every reader must render
 *    a placeholder rather than crash OR silently show a blank entry.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';
import {
  MISSING_RECORD_CONTENT,
  normalizeRecordContent,
  repairRecordContents,
} from '../../src/utils/turn-content';
import { buildNavItemsForTask, type ReviewData } from '../../src/cli/tui/review';
import type { Task, Comment, JournalEntry, FollowUp } from '../../src/types';

describe('annotation content helpers', () => {
  test('repairRecordContents substitutes a visible placeholder for a missing content', () => {
    const good = { id: 'a', content: 'real text' };
    const missing = { id: 'b' } as { id: string; content?: unknown };
    const nulled = { id: 'c', content: null };
    // '' can only come from the write guard below, i.e. from the same defect —
    // a blank pane would make the record vanish, so it gets the placeholder too.
    const empty = { id: 'd', content: '' };

    const out = repairRecordContents([good, missing, nulled, empty], 'journal', 'test');

    expect(out[0].content).toBe('real text');
    expect(out[1].content).toBe(MISSING_RECORD_CONTENT);
    expect(out[2].content).toBe(MISSING_RECORD_CONTENT);
    expect(out[3].content).toBe(MISSING_RECORD_CONTENT);
    // Copies only — the stored record is never mutated and never rewritten.
    expect(missing.content).toBeUndefined();
    expect(out[0]).toBe(good);
  });

  // INVARIANT: the write path keeps the record (a comment is human feedback, a
  // journal entry is a rationale nobody will retype) and coerces to '' — it does
  // NOT store the placeholder, which would fabricate content into the store.
  test('normalizeRecordContent coerces non-strings to an empty string', () => {
    expect(normalizeRecordContent(undefined, 'test', 'appendJournalEntry', 'JournalEntry.content')).toBe('');
    expect(normalizeRecordContent(null, 'test', 'createComment', 'Comment.content')).toBe('');
    expect(normalizeRecordContent({}, 'test', 'createFollowUp', 'FollowUp.content')).toBe('');
    expect(normalizeRecordContent('kept', 'test', 'createComment', 'Comment.content')).toBe('kept');
  });
});

describe('storage reads over content-less annotation records', () => {
  let testDir: string;
  let storage: Storage;
  let task: Task;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-annotation-content-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    task = await storage.createTask('Test task', undefined, undefined, 'test-task');
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  /** Write a record file exactly as the defect left it: no `content` key. */
  async function seedDefective(file: string, key: string, record: Record<string, unknown>) {
    const dir = await storage.getTaskDir(task.id);
    writeFileSync(join(dir, file), JSON.stringify({ [key]: [record] }, null, 2));
  }

  test('getTaskJournal renders a placeholder instead of returning undefined content', async () => {
    await seedDefective('journal.json', 'journal', {
      id: 'j1', task_id: task.id, created_at: Date.now(), actor: 'agent',
    });

    const journal = await storage.getTaskJournal(task.id);
    expect(journal).toHaveLength(1);
    expect(journal[0].content).toBe(MISSING_RECORD_CONTENT);
    // The crash was `.split` on this value — it must be a string now.
    expect(() => journal[0].content.split('\n')).not.toThrow();
  });

  test('getTaskComments renders a placeholder instead of returning undefined content', async () => {
    await seedDefective('comments.json', 'comments', {
      id: 'c1', task_id: task.id, created_at: Date.now(),
    });

    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe(MISSING_RECORD_CONTENT);
    // `lazy sync`'s remote-comment dedup runs .match() over every stored comment.
    expect(() => comments[0].content.match(/\{(?:remote|gh):(\w+)\}/)).not.toThrow();
  });

  test('getTaskFollowUps renders a placeholder instead of returning undefined content', async () => {
    await seedDefective('follow-ups.json', 'follow_ups', {
      id: 'f1', task_id: task.id, created_at: Date.now(),
    });

    const followUps = await storage.getTaskFollowUps(task.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].content).toBe(MISSING_RECORD_CONTENT);
  });

  // INVARIANT: the read-side repair is presentation, not a migration. A
  // defective record stays defective on disk — nothing rewrites a user's store
  // behind their back, and the placeholder never becomes real stored content.
  test('the repair is not written back to the store', async () => {
    await seedDefective('journal.json', 'journal', {
      id: 'j1', task_id: task.id, created_at: Date.now(),
    });

    await storage.getTaskJournal(task.id);

    const dir = await storage.getTaskDir(task.id);
    const raw = await Bun.file(join(dir, 'journal.json')).json();
    expect(raw.journal[0].content).toBeUndefined();
  });

  // INVARIANT: the write path can never add a NEW content-less record, whatever
  // a caller (or an unvalidated RPC body) hands it.
  test('a non-string content is coerced at the write boundary, never persisted raw', async () => {
    await storage.appendJournalEntry(task.id, undefined as unknown as string, 'agent');

    const dir = await storage.getTaskDir(task.id);
    const raw = await Bun.file(join(dir, 'journal.json')).json();
    expect(raw.journal[0].content).toBe('');

    // …and it still reads back visibly rather than as a blank entry.
    const journal = await storage.getTaskJournal(task.id);
    expect(journal[0].content).toBe(MISSING_RECORD_CONTENT);
  });
});

describe('review TUI over content-less annotation records', () => {
  function makeTask(): Task {
    return {
      id: 'task1234',
      code: 'release-v021',
      goal: 'A release hub whose journal contains a content-less entry',
      prompt: 'ship it',
      type: 'task',
      status: 'blocked',
      priority: 'normal',
      created_at: Date.now(),
      completed_at: null,
      target: { kind: 'branch' as const, branch: 'main' },
      branched_from_sha: null,
      close_reason: null,
      model: null,
      agent_id: 'claude-code',
      metadata: {},
      pending_sync: 0,
      runner_type: null,
      tags: [],
    };
  }

  function reviewData(): ReviewData {
    // Records as they exist on disk after the defect: no `content` key at all.
    const journalEntry = { id: 'j1', task_id: 'task1234', created_at: 1 } as unknown as JournalEntry;
    const comment = { id: 'c1', task_id: 'task1234', created_at: 1 } as unknown as Comment;
    const followUp = { id: 'f1', task_id: 'task1234', created_at: 1 } as unknown as FollowUp;

    return {
      task: makeTask(),
      session: null,
      turns: [],
      commits: [],
      comments: [comment],
      unseenComments: [],
      journal: [journalEntry],
      followUps: [followUp],
      diffStat: '',
      diffFull: '',
      worktreePath: '/tmp/nowhere',
      targetBranch: 'main',
      lastAgentTurn: null,
      turnInfoMap: new Map(),
      taskTree: null,
      childTasks: [],
      parentTask: null,
      protection: null,
    };
  }

  // INVARIANT: review is a read-only surface over whatever a store contains.
  // ONE defective record must not take down the review of a whole task tree —
  // that is the reported crash (`entry.content.split`), and the reviewer of an
  // 86-child release hub has no way to route around it.
  test('buildNavItemsForTask does not crash and labels the record visibly', () => {
    const items = buildNavItemsForTask(reviewData(), new Map());

    const labelsUnder = (key: string) =>
      (items.find(i => i.key === key)?.children ?? []).map(c => c.label);

    expect(labelsUnder('journal')).toEqual([MISSING_RECORD_CONTENT]);
    expect(labelsUnder('comments')).toEqual([MISSING_RECORD_CONTENT]);
    expect(labelsUnder('followups')).toEqual([MISSING_RECORD_CONTENT]);
  });
});
