/**
 * Cross-backend row-shape contract.
 *
 * INVARIANT (cross-backend row contract): an OPTIONAL (`?`) field on a domain
 * type means "the key is ABSENT when unset"; a `| null` field means "the key is
 * PRESENT and null when unset". Consumers rely on both halves — `'model' in
 * turn`, `turn.check_exit_code === undefined`, `Object.keys(...)` diffing — so a
 * backend that hands back SQL NULL where another omits the key changes behavior
 * without changing any calling code.
 *
 * This is not hypothetical: PostgresStorage.getSessionTurns was a bare
 * `SELECT *` returned raw, so every unset nullable turn column came back as
 * null while FileStorage omitted it. This suite pins the shape for every entity
 * that has optional fields, on every backend, so the next `SELECT *` reader
 * cannot quietly reintroduce the divergence.
 *
 * FileStorage is the reference implementation (its JSON simply omits unset
 * keys). RemoteStorage is deliberately not exercised here: it is a JSON-RPC
 * pass-through that forwards whatever the daemon's backend produced, so it
 * inherits the shape of whichever backend below is in play.
 *
 * The Postgres half requires a real database. Set LAZY_POSTGRES_URL, e.g.
 *   LAZY_POSTGRES_URL=postgres://postgres@localhost:5432/lazy_test
 * Without it, only the FileStorage half runs.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import { FileStorage } from '../../src/storage/file-storage';
import { PostgresStorage } from '../../src/storage/postgres-storage';
import type { Storage } from '../../src/storage/interface';

const TEST_URL = process.env.LAZY_POSTGRES_URL;

/** Keys present on an object — the thing that must not differ across backends. */
function presentKeys(obj: Record<string, unknown>): string[] {
  // A key explicitly set to `undefined` is as bad as a missing one being null:
  // it survives Object.keys but fails `x.k === undefined` checks differently
  // from JSON round-tripping. Treat it as absent and pin it on both backends.
  return Object.keys(obj).filter(k => obj[k] !== undefined).sort();
}

interface Backend {
  name: string;
  make: () => Promise<{ storage: Storage; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'FileStorage',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'lazy-contract-file-'));
      const storage = new FileStorage(root, { basePath: join(root, 'store') });
      await storage.initialize();
      return {
        storage,
        cleanup: async () => {
          await storage.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

if (TEST_URL) {
  backends.push({
    name: 'PostgresStorage',
    make: async () => {
      // onnotice: DROP SCHEMA CASCADE emits a NOTICE per dependent table,
      // which postgres.js logs to the console and drowns the test output.
      const admin = postgres(TEST_URL, { max: 1, onnotice: () => {} });
      await admin`DROP SCHEMA public CASCADE`;
      await admin`CREATE SCHEMA public`;
      await admin.end();
      const storage = new PostgresStorage('/tmp/lazy-contract-pg', { url: TEST_URL });
      await storage.initialize();
      return { storage, cleanup: () => storage.close() };
    },
  });
} else {
  console.log('storage-contract: Postgres half skipped — set LAZY_POSTGRES_URL to run it');
}

/**
 * Every shape this suite pins, keyed by a stable name. Each backend runs the
 * same scenario and the resulting key sets are compared against these
 * expectations — and, when both backends run, against each other.
 */
type Shapes = Record<string, string[]>;

async function collectShapes(storage: Storage): Promise<Shapes> {
  const shapes: Shapes = {};

  // ── Everything unset: optional keys must be ABSENT ──────────────────
  const bare = await storage.createTask('bare task');
  shapes['task.created'] = presentKeys(bare as unknown as Record<string, unknown>);
  shapes['task.read'] = presentKeys((await storage.getTask(bare.id))! as unknown as Record<string, unknown>);

  const session = await storage.createSession(bare.id, 'claude-code', 'lazy/bare', 'abc1234');
  shapes['session.created'] = presentKeys(session as unknown as Record<string, unknown>);
  shapes['session.read'] = presentKeys((await storage.getSession(session.id))! as unknown as Record<string, unknown>);

  const bareTurn = await storage.createTurn({
    sessionId: session.id,
    sequence: 0,
    role: 'agent',
    content: 'no optional fields set',
  });
  shapes['turn.created.bare'] = presentKeys(bareTurn as unknown as Record<string, unknown>);

  const bareComment = await storage.createComment(bare.id, 'plain comment');
  shapes['comment.created.bare'] = presentKeys(bareComment as unknown as Record<string, unknown>);

  const bareJournal = await storage.appendJournalEntry(bare.id, 'plain entry');
  shapes['journal.created.bare'] = presentKeys(bareJournal as unknown as Record<string, unknown>);

  const bareFollowUp = await storage.createFollowUp(bare.id, 'plain follow-up');
  shapes['followup.created.bare'] = presentKeys(bareFollowUp as unknown as Record<string, unknown>);

  const bareApproval = await storage.createHunkApproval(bare.id, 'hash-bare');
  shapes['approval.created.bare'] = presentKeys(bareApproval as unknown as Record<string, unknown>);

  // ── Everything set: optional keys must be PRESENT ───────────────────
  const rich = await storage.createTask('rich task');
  const richSession = await storage.createSession(rich.id, 'claude-code', 'lazy/rich', 'def5678', 'agent-sess-1');
  const richTurn = await storage.createTurn({
    sessionId: richSession.id,
    sequence: 0,
    role: 'human',
    content: 'all optional fields set',
    model: 'claude-opus-5',
    prompt: 'do the thing',
    actor: 'human',
    usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
    startSha: 'aaa',
    startShaWork: 'bbb',
    endShaWork: 'ccc',
    endSha: 'ddd',
    mergeConflicts: [{ path: 'a.ts', content: '<<<<<<<', merge_source: 'main' }],
    violations: [{ file: 'b.ts', base_sha: 'eee', status: 'pending' }],
    checkExitCode: 1,
    checkOutput: 'boom',
    autoTriggered: true,
    turnType: 'ask',
    carriesFeedback: true,
  });
  shapes['turn.created.rich'] = presentKeys(richTurn as unknown as Record<string, unknown>);

  await storage.createComment(rich.id, 'rich comment', 'builder', 'remote');
  shapes['comment.read.rich'] = presentKeys(
    (await storage.getTaskComments(rich.id))[0]! as unknown as Record<string, unknown>
  );
  await storage.appendJournalEntry(rich.id, 'rich entry', 'agent');
  shapes['journal.read.rich'] = presentKeys(
    (await storage.getTaskJournal(rich.id))[0]! as unknown as Record<string, unknown>
  );
  await storage.createFollowUp(rich.id, 'rich follow-up', richSession.id);
  shapes['followup.read.rich'] = presentKeys(
    (await storage.getTaskFollowUps(rich.id))[0]! as unknown as Record<string, unknown>
  );
  await storage.createHunkApproval(rich.id, 'hash-rich', 'human', {
    parent_file: 'c.ts',
    parent_lines: '10-20',
    split_path: '01',
  });
  shapes['approval.read.rich'] = presentKeys(
    (await storage.listHunkApprovals(rich.id))[0]! as unknown as Record<string, unknown>
  );

  // ── Readers must match their writers ────────────────────────────────
  shapes['turn.read.bare'] = presentKeys(
    (await storage.getSessionTurns(session.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['turn.read.rich'] = presentKeys(
    (await storage.getSessionTurns(richSession.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['comment.read.bare'] = presentKeys(
    (await storage.getTaskComments(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['journal.read.bare'] = presentKeys(
    (await storage.getTaskJournal(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['followup.read.bare'] = presentKeys(
    (await storage.getTaskFollowUps(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['approval.read.bare'] = presentKeys(
    (await storage.listHunkApprovals(bare.id))[0]! as unknown as Record<string, unknown>
  );

  // ── Actor-attributed audit trails ───────────────────────────────────
  await storage.updateTaskStatus(bare.id, 'working');            // no actor
  await storage.updateTaskStatus(rich.id, 'working', 'human');   // with actor
  shapes['statuschange.bare'] = presentKeys(
    (await storage.getStatusHistory(bare.id)).at(-1)! as unknown as Record<string, unknown>
  );
  shapes['statuschange.rich'] = presentKeys(
    (await storage.getStatusHistory(rich.id)).at(-1)! as unknown as Record<string, unknown>
  );

  await storage.addTaskTag(bare.id, 'plain');
  await storage.addTaskTag(rich.id, 'attributed', 'builder');
  shapes['tagevent.bare'] = presentKeys(
    (await storage.getTagHistory(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['tagevent.rich'] = presentKeys(
    (await storage.getTagHistory(rich.id))[0]! as unknown as Record<string, unknown>
  );

  return shapes;
}

/** Values that must survive a write→read round trip with their JS type intact. */
async function collectRoundTrip(storage: Storage) {
  const task = await storage.createTask('round trip');
  const session = await storage.createSession(task.id, 'claude-code', 'lazy/rt', 'sha');
  const created = await storage.createTurn({
    sessionId: session.id,
    sequence: 0,
    role: 'agent',
    content: 'structured columns',
    usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
    mergeConflicts: [{ path: 'a.ts', content: '<<<<<<<', merge_source: 'main' }],
    violations: [{ file: 'b.ts', base_sha: 'eee', status: 'pending' }],
    actor: 'human',
  });
  await storage.updateTurnViolations(task.id, created.id, [
    { file: 'b.ts', base_sha: 'eee', status: 'approved' },
  ]);
  const [read] = await storage.getSessionTurns(session.id);

  await storage.incrementTaskPendingSync(task.id);
  const afterIncrement = await storage.getTask(task.id);
  await storage.resetTaskPendingSync(task.id);
  const afterClear = await storage.getTask(task.id);

  await storage.updateSessionClaudeId(session.id, 'agent-sess-xyz');
  const readSession = await storage.getSession(session.id);

  return {
    usage: read!.usage,
    mergeConflicts: read!.merge_conflicts,
    violations: read!.violations,
    actor: read!.actor,
    pendingSyncAfterIncrement: afterIncrement!.pending_sync,
    pendingSyncAfterClear: afterClear!.pending_sync,
    agentSessionId: readSession!.agent_session_id,
  };
}

/**
 * The expected shapes, written out rather than derived, so a change to BOTH
 * backends at once still trips the test. Sorted, like presentKeys().
 */
const EXPECTED: Shapes = {
  'turn.created.bare': ['content', 'end_sha', 'end_sha_work', 'id', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'usage'],
  'turn.read.bare': ['content', 'end_sha', 'end_sha_work', 'id', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'usage'],
  'turn.created.rich': ['actor', 'auto_triggered', 'check_exit_code', 'check_output', 'content', 'end_sha', 'end_sha_work', 'feedback_delivery', 'id', 'merge_conflicts', 'model', 'prompt', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'turn_type', 'usage', 'violations'],
  'turn.read.rich': ['actor', 'auto_triggered', 'check_exit_code', 'check_output', 'content', 'end_sha', 'end_sha_work', 'feedback_delivery', 'id', 'merge_conflicts', 'model', 'prompt', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'turn_type', 'usage', 'violations'],
  'comment.created.bare': ['content', 'created_at', 'id', 'task_id'],
  'comment.read.bare': ['content', 'created_at', 'id', 'task_id'],
  'comment.read.rich': ['actor', 'content', 'created_at', 'id', 'source', 'task_id'],
  'journal.created.bare': ['content', 'created_at', 'id', 'task_id'],
  'journal.read.bare': ['content', 'created_at', 'id', 'task_id'],
  'journal.read.rich': ['actor', 'content', 'created_at', 'id', 'task_id'],
  'followup.created.bare': ['content', 'created_at', 'id', 'task_id'],
  'followup.read.bare': ['content', 'created_at', 'id', 'task_id'],
  'followup.read.rich': ['content', 'created_at', 'id', 'session_id', 'task_id'],
  'approval.created.bare': ['approved_at', 'hunk_hash', 'id', 'task_id'],
  'approval.read.bare': ['approved_at', 'hunk_hash', 'id', 'task_id'],
  'approval.read.rich': ['approved_at', 'approved_by', 'hunk_hash', 'id', 'parent_file', 'parent_lines', 'split_path', 'task_id'],
  'statuschange.bare': ['status', 'timestamp'],
  'statuschange.rich': ['actor', 'status', 'timestamp'],
  'tagevent.bare': ['action', 'tag', 'timestamp'],
  'tagevent.rich': ['action', 'actor', 'tag', 'timestamp'],
};

describe('cross-backend storage row contract', () => {
  const collected: Record<string, Shapes> = {};

  for (const backend of backends) {
    describe(backend.name, () => {
      let storage: Storage;
      let cleanup: () => Promise<void>;

      beforeEach(async () => {
        ({ storage, cleanup } = await backend.make());
      });

      afterEach(async () => {
        await cleanup();
      });

      // INVARIANT: optional (`?`) domain fields are ABSENT when unset and
      // PRESENT when set — on every backend. A SQL NULL leaking through as a
      // present key (or a present-but-undefined key on a writer) breaks
      // `'model' in turn` / `=== undefined` consumers on that backend only.
      test('optional fields are absent when unset, present when set', async () => {
        const shapes = await collectShapes(storage);
        collected[backend.name] = shapes;
        for (const [name, expected] of Object.entries(EXPECTED)) {
          expect({ [name]: shapes[name] }).toEqual({ [name]: expected });
        }
      });

      // INVARIANT: `| null` fields keep their explicit null — dropping it would
      // be the same divergence in the other direction (Task.pending_sync read
      // as undefined made `pending_sync > 0` silently false on Postgres).
      test('nullable fields keep an explicit null when unset', async () => {
        const task = await storage.createTask('nullable');
        expect(task.code).toBeNull();
        expect(task.model).toBeNull();
        expect(task.completed_at).toBeNull();
        expect(task.pending_sync).toBe(0);

        const session = await storage.createSession(task.id, 'claude-code', 'lazy/n', 'sha');
        const read = (await storage.getSession(session.id))!;
        expect(read.agent_session_id).toBeNull();
        expect(read.ended_at).toBeNull();
        expect(read.outcome).toBeNull();
        expect(read.total_usage).toBeNull();
        expect(read.runner_type).toBeNull();

        const turn = await storage.createTurn({
          sessionId: session.id, sequence: 0, role: 'agent', content: 'x',
        });
        expect(turn.usage).toBeNull();
        expect(turn.start_sha).toBeNull();
        expect((await storage.getSessionTurns(session.id))[0]!.usage).toBeNull();
      });

      // INVARIANT: JSONB columns round-trip as structured values, not JSON
      // text. postgres.js stores a JSON.stringify()'d argument as a JSON
      // *string* inside JSONB, so `turn.violations[0].status` was reading a
      // character. Writes go through sql.json(); reads parse legacy text rows.
      test('structured values round-trip with their JS types', async () => {
        const rt = await collectRoundTrip(storage);
        expect(rt.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 });
        expect(rt.mergeConflicts).toEqual([{ path: 'a.ts', content: '<<<<<<<', merge_source: 'main' }]);
        expect(rt.violations).toEqual([{ file: 'b.ts', base_sha: 'eee', status: 'approved' }]);
        expect(rt.actor).toBe('human');
        expect(rt.pendingSyncAfterIncrement).toBe(1);
        expect(rt.pendingSyncAfterClear).toBe(0);
        expect(rt.agentSessionId).toBe('agent-sess-xyz');
      });
    });
  }

  // INVARIANT: the two backends must agree key-for-key. The absolute
  // expectations above are the primary pin; this catches a shape the table
  // above forgot to list.
  test.skipIf(backends.length < 2)('FileStorage and PostgresStorage agree on every shape', () => {
    const file = collected['FileStorage'];
    const pg = collected['PostgresStorage'];
    expect(file).toBeDefined();
    expect(pg).toBeDefined();
    expect(pg).toEqual(file!);
  });
});
