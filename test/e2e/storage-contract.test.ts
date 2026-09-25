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
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import type { Storage } from '../../src/storage/interface';

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

  const bareRaised = await storage.createRaisedItem(bare.id, { blocking: false, content: 'plain raised item' });
  shapes['raised.created.bare'] = presentKeys(bareRaised as unknown as Record<string, unknown>);

  const bareApproval = await storage.createHunkApproval(bare.id, 'hash-bare');
  shapes['approval.created.bare'] = presentKeys(bareApproval as unknown as Record<string, unknown>);

  // An artifact attached by a human has no publishing session, so `session_id`
  // must be ABSENT — not a SQL NULL that survives `'session_id' in artifact`.
  const bareArtifact = await storage.createTaskArtifact(bare.id, {
    name: 'bare.txt',
    content_base64: Buffer.from('bare').toString('base64'),
  });
  shapes['artifact.created.bare'] = presentKeys(bareArtifact as unknown as Record<string, unknown>);

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
    // An ActorRef rather than a bare role: `actor` says WHAT KIND of actor
    // wrote the turn, `actor_email` / `actor_name` say WHICH person — git's own
    // pair — and all three must be present keys on every backend.
    actor: { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' },
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

  await storage.createComment(rich.id, 'rich comment', { role: 'builder', email: 'ada@example.com', name: 'Ada Lovelace' }, 'remote');
  shapes['comment.read.rich'] = presentKeys(
    (await storage.getTaskComments(rich.id))[0]! as unknown as Record<string, unknown>
  );
  await storage.appendJournalEntry(rich.id, 'rich entry', 'agent');
  shapes['journal.read.rich'] = presentKeys(
    (await storage.getTaskJournal(rich.id))[0]! as unknown as Record<string, unknown>
  );
  await storage.createRaisedItem(rich.id, {
    blocking: true,
    content: 'rich raised item',
    title: 'Rich raised item',
    explanation: 'why it matters',
    proposed_code: 'rich-followup',
    proposed_prompt: 'do the thing',
    options: ['a', 'b'],
    session_id: richSession.id,
  });
  shapes['raised.read.rich'] = presentKeys(
    (await storage.getTaskRaisedItems(rich.id))[0]! as unknown as Record<string, unknown>
  );
  // Published by an agent run: every optional key present, including the
  // session that produced it.
  await storage.createTaskArtifact(rich.id, {
    name: 'rich.png',
    content_base64: Buffer.from([0x89, 0x50, 0x00, 0xff]).toString('base64'),
    mime_type: 'image/png',
    origin: 'output',
    session_id: richSession.id,
  }, 'agent');
  shapes['artifact.read.rich'] = presentKeys(
    (await storage.listTaskArtifacts(rich.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['artifact.get.rich'] = presentKeys(
    (await storage.getTaskArtifact(rich.id, 'rich.png'))! as unknown as Record<string, unknown>
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
  shapes['raised.read.bare'] = presentKeys(
    (await storage.getTaskRaisedItems(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['approval.read.bare'] = presentKeys(
    (await storage.listHunkApprovals(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['artifact.read.bare'] = presentKeys(
    (await storage.listTaskArtifacts(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['artifact.get.bare'] = presentKeys(
    (await storage.getTaskArtifact(bare.id, 'bare.txt'))! as unknown as Record<string, unknown>
  );

  // ── Actor-attributed audit trails ───────────────────────────────────
  await storage.updateTaskStatus(bare.id, 'working');            // no actor
  await storage.updateTaskStatus(rich.id, 'working', { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' }); // actor + person
  shapes['statuschange.bare'] = presentKeys(
    (await storage.getStatusHistory(bare.id)).at(-1)! as unknown as Record<string, unknown>
  );
  shapes['statuschange.rich'] = presentKeys(
    (await storage.getStatusHistory(rich.id)).at(-1)! as unknown as Record<string, unknown>
  );

  await storage.addTaskTag(bare.id, 'plain');
  await storage.addTaskTag(rich.id, 'attributed', { role: 'builder', email: 'ada@example.com', name: 'Ada Lovelace' });
  shapes['tagevent.bare'] = presentKeys(
    (await storage.getTagHistory(bare.id))[0]! as unknown as Record<string, unknown>
  );
  shapes['tagevent.rich'] = presentKeys(
    (await storage.getTagHistory(rich.id))[0]! as unknown as Record<string, unknown>
  );

  // ── System messages: bare = just created, rich = read + dismissed ──
  const bareMessage = await storage.createSystemMessage({
    source: 'daemon', title: 'Bare message', body: 'b', kind: 'notice',
  });
  shapes['sysmsg.created.bare'] = presentKeys(bareMessage as unknown as Record<string, unknown>);
  shapes['sysmsg.read.bare'] = presentKeys(
    (await storage.getSystemMessage(bareMessage.id))! as unknown as Record<string, unknown>
  );

  const richMessage = await storage.createSystemMessage({
    source: 'weekly-report', title: 'Rich message', body: 'b', kind: 'report',
  });
  await storage.markSystemMessageRead(richMessage.id);
  await storage.dismissSystemMessage(richMessage.id, 'human');
  shapes['sysmsg.read.rich'] = presentKeys(
    (await storage.getSystemMessage(richMessage.id))! as unknown as Record<string, unknown>
  );
  // The list reader must produce the same shapes as the by-id reader.
  const listedMessages = await storage.listSystemMessages({ includeDismissed: true });
  shapes['sysmsg.listed.rich'] = presentKeys(
    listedMessages.find(m => m.id === richMessage.id)! as unknown as Record<string, unknown>
  );

  // ── Builder scratch: bare = an ordinary captured file, rich = one the
  // sync recorded by name only, stamped with the builder session ──────
  const bareScratch = await storage.saveScratchFile(
    { path: 'notes/bare.md', content: 'plain\n', size: 6 },
    'builder'
  );
  shapes['scratch.created.bare'] = presentKeys(bareScratch as unknown as Record<string, unknown>);
  shapes['scratch.read.bare'] = presentKeys(
    (await storage.getScratchFile('notes/bare.md'))! as unknown as Record<string, unknown>
  );

  await storage.saveScratchFile(
    { path: 'huge.log', content: '', size: 99_000_000, skipped: 'too_large', session_id: 'sess-1' },
    'human'
  );
  shapes['scratch.read.rich'] = presentKeys(
    (await storage.getScratchFile('huge.log'))! as unknown as Record<string, unknown>
  );
  shapes['scratch.listed.rich'] = presentKeys(
    (await storage.listScratchFiles()).find(f => f.path === 'huge.log')! as unknown as Record<string, unknown>
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
    actor: { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' },
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

  // Artifact bytes take completely different routes per backend — a BYTEA
  // column on Postgres, base64 in JSON on FileStorage — so "it round-trips" has
  // to be asserted on both rather than inferred from either. The payload is
  // deliberately not valid UTF-8: a text-coercing path passes an ASCII test and
  // corrupts this one.
  const rawBytes = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50]);
  const artifact = await storage.createTaskArtifact(task.id, {
    name: 'round-trip.bin',
    content_base64: rawBytes.toString('base64'),
  });
  const readArtifact = await storage.getTaskArtifact(task.id, 'round-trip.bin');

  return {
    usage: read!.usage,
    mergeConflicts: read!.merge_conflicts,
    violations: read!.violations,
    actor: read!.actor,
    actorEmail: read!.actor_email,
    actorName: read!.actor_name,
    pendingSyncAfterIncrement: afterIncrement!.pending_sync,
    pendingSyncAfterClear: afterClear!.pending_sync,
    agentSessionId: readSession!.agent_session_id,
    artifactBytesEqual: Buffer.compare(Buffer.from(readArtifact!.content_base64, 'base64'), rawBytes) === 0,
    artifactBinary: readArtifact!.binary,
    artifactSize: readArtifact!.size,
    artifactSizeType: typeof artifact.size,
    artifactReadSizeType: typeof readArtifact!.size,
  };
}

/**
 * The expected shapes, written out rather than derived, so a change to BOTH
 * backends at once still trips the test. Sorted, like presentKeys().
 */
const EXPECTED: Shapes = {
  'turn.created.bare': ['content', 'end_sha', 'end_sha_work', 'id', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'usage'],
  'turn.read.bare': ['content', 'end_sha', 'end_sha_work', 'id', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'usage'],
  'turn.created.rich': ['actor', 'actor_email', 'actor_name', 'auto_triggered', 'check_exit_code', 'check_output', 'content', 'end_sha', 'end_sha_work', 'feedback_delivery', 'id', 'merge_conflicts', 'model', 'prompt', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'turn_type', 'usage', 'violations'],
  'turn.read.rich': ['actor', 'actor_email', 'actor_name', 'auto_triggered', 'check_exit_code', 'check_output', 'content', 'end_sha', 'end_sha_work', 'feedback_delivery', 'id', 'merge_conflicts', 'model', 'prompt', 'role', 'sequence', 'session_id', 'start_sha', 'start_sha_work', 'timestamp', 'turn_type', 'usage', 'violations'],
  'comment.created.bare': ['content', 'created_at', 'id', 'task_id'],
  'comment.read.bare': ['content', 'created_at', 'id', 'task_id'],
  'comment.read.rich': ['actor', 'actor_email', 'actor_name', 'content', 'created_at', 'id', 'source', 'task_id'],
  'journal.created.bare': ['content', 'created_at', 'id', 'task_id'],
  'journal.read.bare': ['content', 'created_at', 'id', 'task_id'],
  'journal.read.rich': ['actor', 'content', 'created_at', 'id', 'task_id'],
  // `blocking` and `status` are REQUIRED on a raised item — never optional and
  // never absent. A backend that omits `blocking` would make an item's gating
  // behavior depend on which store it came out of.
  'raised.created.bare': ['blocking', 'content', 'created_at', 'id', 'status', 'task_id'],
  'raised.read.bare': ['blocking', 'content', 'created_at', 'id', 'status', 'task_id'],
  'raised.read.rich': [
    'blocking', 'content', 'created_at', 'explanation', 'id', 'options',
    'proposed_code', 'proposed_prompt', 'session_id', 'status', 'task_id', 'title',
  ],
  'approval.created.bare': ['approved_at', 'hunk_hash', 'id', 'task_id'],
  'approval.read.bare': ['approved_at', 'hunk_hash', 'id', 'task_id'],
  'approval.read.rich': ['approved_at', 'approved_by', 'hunk_hash', 'id', 'parent_file', 'parent_lines', 'split_path', 'task_id'],
  // `session_id` is the only optional key: absent for a human attach, present
  // when an agent run published the artifact. The get* readers add
  // `content_base64` and nothing else — list stays metadata-only.
  'artifact.created.bare': ['binary', 'created_at', 'created_by', 'id', 'mime_type', 'name', 'origin', 'sha256', 'size', 'task_id'],
  'artifact.read.bare': ['binary', 'created_at', 'created_by', 'id', 'mime_type', 'name', 'origin', 'sha256', 'size', 'task_id'],
  'artifact.get.bare': ['binary', 'content_base64', 'created_at', 'created_by', 'id', 'mime_type', 'name', 'origin', 'sha256', 'size', 'task_id'],
  'artifact.read.rich': ['binary', 'created_at', 'created_by', 'id', 'mime_type', 'name', 'origin', 'session_id', 'sha256', 'size', 'task_id'],
  'artifact.get.rich': ['binary', 'content_base64', 'created_at', 'created_by', 'id', 'mime_type', 'name', 'origin', 'session_id', 'sha256', 'size', 'task_id'],
  'statuschange.bare': ['status', 'timestamp'],
  'statuschange.rich': ['actor', 'actor_email', 'actor_name', 'status', 'timestamp'],
  'tagevent.bare': ['action', 'tag', 'timestamp'],
  'tagevent.rich': ['action', 'actor', 'actor_email', 'actor_name', 'tag', 'timestamp'],
  'sysmsg.created.bare': ['body', 'created_at', 'id', 'kind', 'source', 'title'],
  'sysmsg.read.bare': ['body', 'created_at', 'id', 'kind', 'source', 'title'],
  'sysmsg.read.rich': ['body', 'created_at', 'dismissed_at', 'dismissed_by', 'id', 'kind', 'read_at', 'source', 'title'],
  'sysmsg.listed.rich': ['body', 'created_at', 'dismissed_at', 'dismissed_by', 'id', 'kind', 'read_at', 'source', 'title'],
  // `skipped` and `session_id` are the optional keys: absent for a file whose
  // body was stored, present when the sync recorded it by name only and knew
  // which builder session wrote it.
  'scratch.created.bare': ['content', 'created_at', 'path', 'size', 'updated_at', 'updated_by'],
  'scratch.read.bare': ['content', 'created_at', 'path', 'size', 'updated_at', 'updated_by'],
  'scratch.read.rich': ['content', 'created_at', 'path', 'session_id', 'size', 'skipped', 'updated_at', 'updated_by'],
  'scratch.listed.rich': ['content', 'created_at', 'path', 'session_id', 'size', 'skipped', 'updated_at', 'updated_by'],
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

      // INVARIANT: wait intervals read back the same shape on every backend,
      // including the OPEN interval (`ended_at`/`outcome` explicitly null) that
      // a turn dying mid-wait leaves behind. Consumers subtracting waited time
      // from an agent's wall-clock branch on exactly those nulls.
      test('wait intervals round-trip, open ones keeping explicit nulls', async () => {
        const task = await storage.createTask('waits');
        const session = await storage.createSession(task.id, 'claude-code', 'lazy/w', 'sha');

        await storage.recordWaitStart({
          id: `${task.id}-open`,
          task_id: task.id,
          session_id: session.id,
          turn_sequence: 0,
          tool: 'lazy_wait',
          waited_on: ['child-1'],
          waited_on_labels: ['fix-foo'],
          started_at: '2026-08-04T10:00:00.000Z',
        });
        await storage.recordWaitStart({
          id: `${task.id}-closed`,
          task_id: task.id,
          session_id: null,
          turn_sequence: null,
          tool: 'lazy_ask',
          waited_on: ['child-2'],
          waited_on_labels: ['fix-bar'],
          started_at: '2026-08-04T10:01:00.000Z',
        });
        await storage.recordWaitEnd(`${task.id}-closed`, '2026-08-04T10:02:00.000Z', 'completed');

        const intervals = await storage.readWaitIntervals({ taskId: task.id });
        expect(intervals.map(i => i.id)).toEqual([`${task.id}-open`, `${task.id}-closed`]);
        expect(intervals[0]).toEqual({
          id: `${task.id}-open`,
          task_id: task.id,
          session_id: session.id,
          turn_sequence: 0,
          tool: 'lazy_wait',
          waited_on: ['child-1'],
          waited_on_labels: ['fix-foo'],
          started_at: '2026-08-04T10:00:00.000Z',
          ended_at: null,
          outcome: null,
        });
        expect(intervals[1]).toMatchObject({
          session_id: null,
          turn_sequence: null,
          ended_at: '2026-08-04T10:02:00.000Z',
          outcome: 'completed',
        });

        // Session filter narrows to the attributed one.
        const bySession = await storage.readWaitIntervals({ sessionId: session.id });
        expect(bySession.map(i => i.id)).toContain(`${task.id}-open`);
        expect(bySession.map(i => i.id)).not.toContain(`${task.id}-closed`);
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
        // The person behind the role survives the round trip too — a role-only
        // assertion passed for months while the person was dropped on the
        // floor. BOTH halves: a name-less row names somebody you can reach, and
        // an email-less one is what a display-name-only write would leave.
        expect(rt.actorEmail).toBe('ada@example.com');
        expect(rt.actorName).toBe('Ada Lovelace');
        expect(rt.pendingSyncAfterIncrement).toBe(1);
        expect(rt.pendingSyncAfterClear).toBe(0);
        expect(rt.agentSessionId).toBe('agent-sess-xyz');

        // Artifact bytes survive whichever encoding the backend chose, and
        // `size` is a number on both — BIGINT hands back a string without the
        // parser, which would turn every bounds check into string arithmetic.
        expect(rt.artifactBytesEqual).toBe(true);
        expect(rt.artifactBinary).toBe(true);
        expect(rt.artifactSize).toBe(5);
        expect(rt.artifactSizeType).toBe('number');
        expect(rt.artifactReadSizeType).toBe('number');
      });

      // INVARIANT: scratch round-trips and is reachable from search on every
      // backend. On Postgres both hang off one table whose migration number
      // once collided with an upstream one — the table was then never created,
      // and because search() selects from it unconditionally, EVERY Postgres
      // search threw, not just scratch search. Exercising scratch here is what
      // makes that class of failure visible on the Postgres half.
      test('scratch files round-trip and are reachable from search', async () => {
        await storage.saveScratchFile(
          { path: 'review/accept-foo.md', content: 'the numbers hold up\n', size: 20 },
          'builder'
        );

        const read = (await storage.getScratchFile('review/accept-foo.md'))!;
        expect(read.content).toBe('the numbers hold up\n');
        // BIGINT hands back a string without the parser, which would turn every
        // cap check into string arithmetic — same footgun as artifact size.
        expect(read.size).toBe(20);
        expect(typeof read.size).toBe('number');

        const byContent = await storage.search('numbers hold up');
        expect(byContent.find(h => h.entity_type === 'scratch')?.entity_id).toBe('review/accept-foo.md');

        // Path is searched alongside content, so a file stored by name only
        // (over the cap, or binary) is still findable.
        expect((await storage.search('accept-foo')).some(h => h.entity_type === 'scratch')).toBe(true);

        expect(await storage.deleteScratchFile('review/accept-foo.md')).toBe(true);
        expect(await storage.getScratchFile('review/accept-foo.md')).toBeNull();
      });
    });
  }
});
