/**
 * Integration tests for PostgresStorage against a real PostgreSQL database.
 *
 * Requires PostgreSQL running locally. Set LAZY_POSTGRES_URL env var, e.g.:
 *   LAZY_POSTGRES_URL=postgres://postgres@localhost:15432/lazy_test
 *
 * If LAZY_POSTGRES_URL is not set, all tests are skipped gracefully.
 */

import { describe, test, beforeEach, afterEach, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresStorage } from '../../src/storage/postgres-storage';
import { parentTaskIdOf } from '../../src/task-target';

const TEST_URL = process.env.LAZY_POSTGRES_URL;

// Skip entire suite if no PostgreSQL connection is configured
const describeWithPg = TEST_URL ? describe : describe.skip;

/** Drop all tables between tests for a clean slate */
async function resetDatabase(url: string) {
  const sql = postgres(url, { max: 1 });
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql.end();
}

describeWithPg('PostgresStorage', () => {
  let storage: PostgresStorage;

  beforeEach(async () => {
    await resetDatabase(TEST_URL!);
    storage = new PostgresStorage('/tmp/test-lazy', {
      url: TEST_URL!,
    });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // ── Task CRUD ─────────────────────────────────────────────────────

  test('create and retrieve a task', async () => {
    const task = await storage.createTask('Build the widget');

    expect(task.id).toBeString();
    expect(task.goal).toBe('Build the widget');
    expect(task.status).toBe('backlog');
    expect(typeof task.created_at).toBe('number');

    const fetched = await storage.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.goal).toBe('Build the widget');
  });

  test('create task with code and type', async () => {
    const task = await storage.createTask('Fix login', undefined, undefined, 'fix-login', 'fix');

    expect(task.code).toBe('fix-login');
    expect(task.type).toBe('fix');
  });

  test('create child task', async () => {
    const parent = await storage.createTask('Parent task');
    const child = await storage.createTask('Child task', parent.id, 'abc123');

    expect(parentTaskIdOf(child)).toBe(parent.id);
    expect(child.branched_from_sha).toBe('abc123');

    const children = await storage.getChildTasks(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(child.id);
  });

  // ── Task resolution ────────────────────────────────────────────────

  test('resolve task by full ID', async () => {
    const task = await storage.createTask('Test task');
    const { task: resolved } = await storage.resolveTask(task.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(task.id);
  });

  test('resolve task by code', async () => {
    const task = await storage.createTask('Test task', undefined, undefined, 'my-task');
    const { task: resolved } = await storage.resolveTask('my-task');
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(task.id);
  });

  test('resolve task by ID prefix', async () => {
    const task = await storage.createTask('Test task');
    const prefix = task.id.slice(0, 8);
    const { task: resolved } = await storage.resolveTask(prefix);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(task.id);
  });

  test('resolve ambiguous code returns ambiguousMatches', async () => {
    // Two non-terminal tasks sharing a code — createTask rejects that outright, so the
    // collision has to arrive the way it does in practice: updateTaskCode enforces no
    // uniqueness, so re-coding an existing task can still produce a duplicate.
    const t1 = await storage.createTask('Task 1', undefined, undefined, 'dup-code');
    const t2 = await storage.createTask('Task 2');
    await storage.updateTaskCode(t2.id, 'dup-code');

    const { task, ambiguousMatches } = await storage.resolveTask('dup-code');
    expect(task).toBeNull();
    expect(ambiguousMatches).toHaveLength(2);
  });

  // ── Task listing ──────────────────────────────────────────────────

  test('listTasks returns all tasks', async () => {
    await storage.createTask('Task 1');
    await storage.createTask('Task 2');
    await storage.createTask('Task 3');

    const tasks = await storage.listTasks();
    expect(tasks).toHaveLength(3);
  });

  test('listTasksWithOptions filters by status', async () => {
    const t1 = await storage.createTask('Backlog task');
    const t2 = await storage.createTask('Blocked task');
    await storage.updateTaskStatus(t2.id, 'blocked');

    const blocked = await storage.listTasksWithOptions({ blockedOnly: true });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].id).toBe(t2.id);

    const backlog = await storage.listTasksWithOptions({ backlogOnly: true });
    expect(backlog).toHaveLength(1);
    expect(backlog[0].id).toBe(t1.id);
  });

  test('listTasksWithOptions nonTerminalOnly excludes closed tasks', async () => {
    const t1 = await storage.createTask('Open task');
    const t2 = await storage.createTask('Closed task');
    await storage.abandonTask(t2.id, 'done');

    const nonTerminal = await storage.listTasksWithOptions({ nonTerminalOnly: true });
    expect(nonTerminal).toHaveLength(1);
    expect(nonTerminal[0].id).toBe(t1.id);
  });

  // ── Task updates ──────────────────────────────────────────────────

  test('updateTaskStatus changes status and records history', async () => {
    const task = await storage.createTask('Test task');
    await storage.updateTaskStatus(task.id, 'working', 'system');

    const fetched = await storage.getTask(task.id);
    expect(fetched!.status).toBe('working');

    const history = await storage.getStatusHistory(task.id);
    // backlog (from createTask) + working
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe('backlog');
    expect(history[1].status).toBe('working');
    expect(history[1].actor).toBe('system');
  });

  test('abandonTask sets status, reason, and completed_at', async () => {
    const task = await storage.createTask('Test task');
    await storage.abandonTask(task.id, 'no longer needed', 'human');

    const fetched = await storage.getTask(task.id);
    expect(fetched!.status).toBe('abandoned');
    expect(fetched!.close_reason).toBe('no longer needed');
    expect(typeof fetched!.completed_at).toBe('number');
  });

  // Reopen target depends on whether the task was ever started, matching FileStorage:
  // a task with a session goes back to 'blocked' (waiting for review), one that never
  // started goes back to 'backlog'. Both branches are covered so the two backends
  // cannot drift apart.
  test('reopenTask resets an unstarted task to backlog', async () => {
    const task = await storage.createTask('Test task');
    await storage.abandonTask(task.id, 'mistake');
    await storage.reopenTask(task.id, 'human');

    const fetched = await storage.getTask(task.id);
    expect(fetched!.status).toBe('backlog');
    expect(fetched!.completed_at).toBeNull();
  });

  test('reopenTask resets a started task to blocked', async () => {
    const task = await storage.createTask('Test task');
    await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');
    await storage.abandonTask(task.id, 'mistake');
    await storage.reopenTask(task.id, 'human');

    const fetched = await storage.getTask(task.id);
    expect(fetched!.status).toBe('blocked');
    expect(fetched!.completed_at).toBeNull();
  });

  // ── Metadata (atomic updates) ─────────────────────────────────────

  // INVARIANT: Metadata updates must be atomic — concurrent calls must not
  // overwrite each other. The implementation uses JSONB || operator for this.
  test('updateTaskMetadata is atomic — multiple keys preserved', async () => {
    const task = await storage.createTask('Test task');

    await storage.updateTaskMetadata(task.id, 'key1', 'value1');
    await storage.updateTaskMetadata(task.id, 'key2', 'value2');

    const v1 = await storage.getTaskMetadata(task.id, 'key1');
    const v2 = await storage.getTaskMetadata(task.id, 'key2');
    expect(v1).toBe('value1');
    expect(v2).toBe('value2');
  });

  test('updateTaskMetadata overwrites same key', async () => {
    const task = await storage.createTask('Test task');

    await storage.updateTaskMetadata(task.id, 'key', 'old');
    await storage.updateTaskMetadata(task.id, 'key', 'new');

    const v = await storage.getTaskMetadata(task.id, 'key');
    expect(v).toBe('new');
  });

  // ── Sessions ──────────────────────────────────────────────────────

  test('create and retrieve session', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc123');

    expect(session.task_id).toBe(task.id);
    expect(session.agent_id).toBe('claude-code');
    expect(session.git_branch).toBe('lazy/test');
    expect(typeof session.started_at).toBe('number');

    const fetched = await storage.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(session.id);

    const byTask = await storage.getSessionByTaskId(task.id);
    expect(byTask).not.toBeNull();
    expect(byTask!.id).toBe(session.id);
  });

  test('endSession sets outcome and ended_at', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');
    await storage.endSession(session.id, 'accepted');

    const fetched = await storage.getSession(session.id);
    expect(fetched!.outcome).toBe('accepted');
    expect(typeof fetched!.ended_at).toBe('number');
  });

  // ── Usage accumulation (atomic) ───────────────────────────────────

  // INVARIANT: Usage accumulation must be atomic — concurrent updates
  // must not overwrite each other. Uses JSONB arithmetic in SQL.
  test('updateSessionUsage accumulates tokens atomically', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');

    await storage.updateSessionUsage(session.id, {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
    });
    await storage.updateSessionUsage(session.id, {
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationTokens: 20,
      cacheReadTokens: 10,
    });

    const fetched = await storage.getSession(session.id);
    expect(fetched!.total_usage).not.toBeNull();
    // BIGINT in JSONB is parsed as number by our type handler
    expect(Number(fetched!.total_usage!.inputTokens)).toBe(300);
    expect(Number(fetched!.total_usage!.outputTokens)).toBe(150);
    expect(Number(fetched!.total_usage!.cacheCreationTokens)).toBe(30);
    expect(Number(fetched!.total_usage!.cacheReadTokens)).toBe(15);
  });

  // ── Turns ─────────────────────────────────────────────────────────

  test('create and retrieve turns', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');

    const turn1 = await storage.createTurn({
      sessionId: session.id,
      sequence: 0,
      role: 'human',
      content: 'Please fix the bug',
    });
    const turn2 = await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'I fixed the bug',
      model: 'claude-sonnet-4-5-20250929',
    });

    const turns = await storage.getSessionTurns(session.id);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('human');
    expect(turns[1].role).toBe('agent');
    expect(turns[1].model).toBe('claude-sonnet-4-5-20250929');
    expect(typeof turns[0].timestamp).toBe('number');
  });

  test('getTurnCountByTaskId returns correct count', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');

    await storage.createTurn({ sessionId: session.id, sequence: 0, role: 'human', content: 'msg1' });
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'msg2' });

    const count = await storage.getTurnCountByTaskId(task.id);
    expect(count).toBe(2);
    // INVARIANT: COUNT(*) returns number, not string (BIGINT parser)
    expect(typeof count).toBe('number');
  });

  // INVARIANT: updateTurnViolations must persist violation status transitions
  // (pending → approved/rejected) as JSONB. The round-trip must preserve the
  // full FileViolation structure including the updated status field.
  test('updateTurnViolations persists violation statuses as JSONB', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');

    const violations = [
      { file: 'test.spec.ts', base_sha: 'abc123', status: 'pending' as const },
      { file: 'other.spec.ts', base_sha: 'def456', status: 'pending' as const },
    ];

    const turn = await storage.createTurn({
      sessionId: session.id,
      sequence: 0,
      role: 'agent',
      content: 'Modified files',
      violations,
    });

    // Verify initial violations are stored
    const turnsBefore = await storage.getSessionTurns(session.id);
    expect(turnsBefore[0].violations).toHaveLength(2);
    expect(turnsBefore[0].violations![0].status).toBe('pending');

    // Update: approve one, reject the other
    const updatedViolations = [
      { ...violations[0], status: 'approved' as const },
      { ...violations[1], status: 'rejected' as const },
    ];
    await storage.updateTurnViolations(task.id, turn.id, updatedViolations);

    // Verify round-trip preserves full structure
    const turnsAfter = await storage.getSessionTurns(session.id);
    expect(turnsAfter[0].violations).toHaveLength(2);
    const v0 = turnsAfter[0].violations![0];
    const v1 = turnsAfter[0].violations![1];
    expect(v0.file).toBe('test.spec.ts');
    expect(v0.status).toBe('approved');
    expect(v0.base_sha).toBe('abc123');
    expect(v1.file).toBe('other.spec.ts');
    expect(v1.status).toBe('rejected');
    expect(v1.base_sha).toBe('def456');
  });

  // ── Commits ───────────────────────────────────────────────────────

  test('create and retrieve commits', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');

    const commit = await storage.createCommit(session.id, 'deadbeef', 'Fix the bug');
    expect(commit.sha).toBe('deadbeef');
    expect(commit.status).toBe('pending_review');
    expect(typeof commit.timestamp).toBe('number');

    const commits = await storage.getSessionCommits(session.id);
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('deadbeef');
  });

  // ── Comments with actor ───────────────────────────────────────────

  test('createComment stores and returns actor', async () => {
    const task = await storage.createTask('Test task');

    const comment = await storage.createComment(task.id, 'Looks good', 'human');
    expect(comment.actor).toBe('human');

    const comments = await storage.getTaskComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('Looks good');
    expect(comments[0].actor).toBe('human');
  });

  test('createComment without actor stores null', async () => {
    const task = await storage.createTask('Test task');
    const comment = await storage.createComment(task.id, 'No actor');

    expect(comment.actor).toBeUndefined();
  });

  // ── Conversations (camelCase mapping) ─────────────────────────────

  // INVARIANT: Conversation reads must return camelCase property names
  // matching the StoredConversation interface, not snake_case column names.
  test('save and load conversation with camelCase properties', async () => {
    const conversation = {
      sessionId: 'sess-123',
      projectPath: '/home/user/project',
      cwd: '/home/user/project',
      version: '1.0.0',
      gitBranch: 'main',
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: '2024-01-01T01:00:00Z',
      importedAt: Date.now(),
      summary: 'Test conversation',
      stats: { turns: 5, duration_ms: 3600000 },
      totalUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 },
      messages: [{ role: 'human', content: 'Hello' }],
      subagents: [],
    };

    await storage.saveConversation(conversation as any);

    const loaded = await storage.loadConversation('sess-123');
    expect(loaded).not.toBeNull();
    // Verify camelCase property names are correct
    expect(loaded!.sessionId).toBe('sess-123');
    expect(loaded!.projectPath).toBe('/home/user/project');
    expect(loaded!.gitBranch).toBe('main');
    expect(loaded!.startedAt).toBe('2024-01-01T00:00:00Z');
    expect(loaded!.endedAt).toBe('2024-01-01T01:00:00Z');
    expect(typeof loaded!.importedAt).toBe('number');
    expect(loaded!.totalUsage).toBeDefined();
    expect(loaded!.messages).toHaveLength(1);

    // Verify snake_case properties do NOT exist (regression guard)
    const raw = loaded as any;
    expect(raw.session_id).toBeUndefined();
    expect(raw.project_path).toBeUndefined();
    expect(raw.git_branch).toBeUndefined();
    expect(raw.total_usage).toBeUndefined();
  });

  test('listConversations returns camelCase properties', async () => {
    const conversation = {
      sessionId: 'sess-456',
      projectPath: '/home/user/project',
      cwd: null,
      version: null,
      gitBranch: null,
      startedAt: null,
      endedAt: null,
      importedAt: Date.now(),
      summary: 'Another conversation',
      stats: {},
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      messages: [],
      subagents: [],
    };

    await storage.saveConversation(conversation as any);
    const list = await storage.listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe('sess-456');
    expect((list[0] as any).session_id).toBeUndefined();
  });

  test('isConversationImported returns boolean', async () => {
    expect(await storage.isConversationImported('nonexistent')).toBe(false);

    await storage.saveConversation({
      sessionId: 'sess-789',
      projectPath: '/tmp',
      cwd: null,
      version: null,
      gitBranch: null,
      startedAt: null,
      endedAt: null,
      importedAt: Date.now(),
      summary: 'Test',
      stats: {},
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      messages: [],
      subagents: [],
    } as any);

    expect(await storage.isConversationImported('sess-789')).toBe(true);
  });

  // ── Search ────────────────────────────────────────────────────────

  test('search finds tasks by goal', async () => {
    await storage.createTask('Build the widget');
    await storage.createTask('Fix the login page');

    const results = await storage.search('widget');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entity_type).toBe('task');
    expect(results[0].content).toContain('widget');
  });

  test('search finds comments by content', async () => {
    const task = await storage.createTask('Test task');
    await storage.createComment(task.id, 'The implementation looks correct');

    const results = await storage.search('implementation');
    const commentResults = results.filter(r => r.entity_type === 'comment');
    expect(commentResults.length).toBeGreaterThanOrEqual(1);
  });

  test('search finds conversations by summary', async () => {
    await storage.saveConversation({
      sessionId: 'search-sess',
      projectPath: '/tmp',
      cwd: null,
      version: null,
      gitBranch: null,
      startedAt: null,
      endedAt: null,
      importedAt: Date.now(),
      summary: 'Refactored the authentication module',
      stats: {},
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      messages: [],
      subagents: [],
    } as any);

    const results = await storage.search('authentication');
    const convResults = results.filter(r => r.entity_type === 'conversation');
    expect(convResults.length).toBeGreaterThanOrEqual(1);
    expect(convResults[0].entity_id).toBe('search-sess');
  });

  // ── Status history ────────────────────────────────────────────────

  test('status history tracks transitions with actor', async () => {
    const task = await storage.createTask('Test task');
    await storage.updateTaskStatus(task.id, 'working', 'system');
    await storage.updateTaskStatus(task.id, 'blocked', 'builder');
    await storage.abandonTask(task.id, 'done', 'human');

    const history = await storage.getStatusHistory(task.id);
    expect(history).toHaveLength(4); // backlog + working + blocked + abandoned
    expect(history[0].status).toBe('backlog');
    expect(history[1].status).toBe('working');
    expect(history[1].actor).toBe('system');
    expect(history[2].status).toBe('blocked');
    expect(history[2].actor).toBe('builder');
    expect(history[3].status).toBe('abandoned');
    expect(history[3].actor).toBe('human');

    // Timestamps must be numbers (BIGINT parser)
    for (const entry of history) {
      expect(typeof entry.timestamp).toBe('number');
    }
  });

  // ── Tags ──────────────────────────────────────────────────────────

  test('tags round-trip with normalized values and append-only, actor-attributed history', async () => {
    const task = await storage.createTask('Tag test');
    // New tasks start with an empty tags array (backward-compatible default).
    expect(task.tags).toEqual([]);

    // Add normalizes the input and returns the updated task.
    const tagged = await storage.addTaskTag(task.id, '[Onboarding]', 'human');
    expect(tagged.tags).toEqual(['onboarding']);
    const two = await storage.addTaskTag(task.id, 'launch', 'builder');
    expect(two.tags.sort()).toEqual(['launch', 'onboarding']);

    // Idempotent: re-adding an existing tag is a no-op (no duplicate, no event).
    const again = await storage.addTaskTag(task.id, 'onboarding', 'human');
    expect(again.tags.sort()).toEqual(['launch', 'onboarding']);

    // Remove drops the tag but the history keeps the earlier 'tag' event.
    const removed = await storage.removeTaskTag(task.id, 'onboarding', 'human');
    expect(removed.tags).toEqual(['launch']);

    const history = await storage.getTagHistory(task.id);
    expect(history).toHaveLength(3); // tag onboarding, tag launch, untag onboarding
    expect(history[0]).toMatchObject({ tag: 'onboarding', action: 'tag', actor: 'human' });
    expect(history[1]).toMatchObject({ tag: 'launch', action: 'tag', actor: 'builder' });
    expect(history[2]).toMatchObject({ tag: 'onboarding', action: 'untag', actor: 'human' });

    // Timestamps must be numbers (BIGINT parser)
    for (const entry of history) {
      expect(typeof entry.timestamp).toBe('number');
    }

    // The current tags persist on the reloaded task.
    const reloaded = await storage.getTask(task.id);
    expect(reloaded!.tags).toEqual(['launch']);
  });

  // ── Task tree ─────────────────────────────────────────────────────

  test('getTaskTree returns correct depth', async () => {
    const root = await storage.createTask('Root');
    const child = await storage.createTask('Child', root.id);
    const grandchild = await storage.createTask('Grandchild', child.id);

    const tree = await storage.getTaskTree(root.id);
    expect(tree).not.toBeNull();
    expect(tree!.depth).toBe(0);
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].depth).toBe(1);
    expect(tree!.children[0].children).toHaveLength(1);
    expect(tree!.children[0].children[0].depth).toBe(2);
    expect(tree!.children[0].children[0].task.id).toBe(grandchild.id);
  });

  // ── Foreign key cascading ─────────────────────────────────────────

  // INVARIANT: Deleting a task cascades to sessions, turns, commits,
  // comments, prompt_history, status_changelog. Matches file-based
  // storage semantics where deleting a task directory removes everything.
  test('deleting a task cascades to child records', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');
    await storage.createTurn({ sessionId: session.id, sequence: 0, role: 'human', content: 'msg' });
    const commit = await storage.createCommit(session.id, 'deadbeef', 'Fix');
    await storage.createReview(commit.id, 'approve', 'LGTM', 'human');
    await storage.createComment(task.id, 'Test comment');
    await storage.updateTaskPrompt(task.id, 'Do the thing');

    // Verify records exist
    expect(await storage.getSession(session.id)).not.toBeNull();
    expect((await storage.getSessionTurns(session.id)).length).toBe(1);
    expect((await storage.getSessionCommits(session.id)).length).toBe(1);
    expect((await storage.getTaskComments(task.id)).length).toBe(1);

    // Delete the task directly via SQL (Storage interface doesn't expose DELETE)
    const sql = postgres(TEST_URL!, { max: 1 });
    await sql`DELETE FROM tasks WHERE id = ${task.id}`;
    await sql.end();

    // Verify all child records are gone
    expect(await storage.getSession(session.id)).toBeNull();
    expect(await storage.getSessionTurns(session.id)).toHaveLength(0);
    expect(await storage.getSessionCommits(session.id)).toHaveLength(0);
    expect(await storage.getTaskComments(task.id)).toHaveLength(0);
    expect((await storage.getPromptHistory(task.id))).toHaveLength(0);
    expect((await storage.getStatusHistory(task.id))).toHaveLength(0);
  });

  // ── BIGINT type handling ──────────────────────────────────────────

  // INVARIANT: All BIGINT columns must return JavaScript numbers, not strings
  // or BigInt values. This ensures JSON.stringify works and types match.
  test('timestamps are numbers not strings', async () => {
    const task = await storage.createTask('Test task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/test', 'abc');
    const turn = await storage.createTurn({
      sessionId: session.id,
      sequence: 0,
      role: 'human',
      content: 'msg',
    });

    // Task timestamps
    expect(typeof task.created_at).toBe('number');
    expect(task.created_at).toBeGreaterThan(1700000000000); // sanity check: after 2023

    // Session timestamps
    const fetchedSession = await storage.getSession(session.id);
    expect(typeof fetchedSession!.started_at).toBe('number');

    // Turn timestamps
    const turns = await storage.getSessionTurns(session.id);
    expect(typeof turns[0].timestamp).toBe('number');

    // Verify JSON.stringify doesn't throw (BigInt would throw)
    expect(() => JSON.stringify(task)).not.toThrow();
    expect(() => JSON.stringify(fetchedSession)).not.toThrow();
    expect(() => JSON.stringify(turns[0])).not.toThrow();
  });

  // ── Prompt history ────────────────────────────────────────────────

  test('prompt history tracks versions', async () => {
    const task = await storage.createTask('Test task');

    const v1 = await storage.updateTaskPrompt(task.id, 'First prompt');
    const v2 = await storage.updateTaskPrompt(task.id, 'Updated prompt');

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    const history = await storage.getPromptHistory(task.id);
    expect(history).toHaveLength(2);

    const specific = await storage.getPromptVersion(task.id, 1);
    expect(specific!.content).toBe('First prompt');

    // Task.prompt should be the latest
    const fetched = await storage.getTask(task.id);
    expect(fetched!.prompt).toBe('Updated prompt');
  });

  // ── Schema migration idempotency ─────────────────────────────────

  test('initialize is idempotent — calling twice does not error', async () => {
    // First call already happened in beforeEach.
    // Second call should be a no-op.
    await storage.initialize();

    // Verify storage still works
    const task = await storage.createTask('Test after re-init');
    expect(task.goal).toBe('Test after re-init');
  });
});
