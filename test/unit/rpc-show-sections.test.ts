/**
 * The show RPC honours `sections`, and serves the answers clients used to
 * re-derive.
 *
 * `handleShow` took a `sections` parameter and read only `taskId`, so a remote
 * client could not tell a section that is EMPTY from one that was never
 * implemented — which is what sent a Lazy Teams port re-implementing the notes
 * cutoff and the chunk grouping in Ruby, and listing every review turn because
 * the predicate that decides which ones count also gates accept.
 *
 * INVARIANT: omitting `sections` serves everything. `lazy show` passes no
 * sections and must keep receiving the whole record — a narrowing default would
 * silently empty every pre-existing caller.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleShow,
} from '../../src/daemon/rpc-handlers';
import { RpcError } from '../../src/daemon/rpc-error';
import { incrementNonHumanTurnCount } from '../../src/daemon/turn-budget';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('show RPC: sections and derived answers', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-show-sections-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);

    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Show sections');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude', 'lazy/t', 'HEAD');

    // A human turn, its agent reply, then automation turns that must NOT open
    // chunks of their own, then a review.
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'human', content: 'go', actor: 'human' });
    await storage.createTurn({ sessionId: session.id, sequence: 2, role: 'agent', content: 'done' });
    await storage.createTurn({ sessionId: session.id, sequence: 3, role: 'human', content: 'nudge', actor: 'supervisor' });
    await storage.createTurn({ sessionId: session.id, sequence: 4, role: 'agent', content: 'answered' });
    await storage.createTurn({
      sessionId: session.id,
      sequence: 5,
      role: 'human',
      content: 'auto-resume',
      actor: 'system',
      autoTriggered: true,
    });
    await storage.createTurn({
      sessionId: session.id,
      sequence: 6,
      role: 'agent',
      content: 'review',
      turnType: 'review',
      review: {
        verdict: 'needs_human',
        security: 'none found',
        data_integrity: 'none found',
        findings: [],
        raised_item_ids: ['raise-1'],
      },
    });
    // A FAILED review: no parseable sweeps and a verdict nobody can act on. It
    // is LISTED and it GATES — hiding it was how a task with one broken review
    // looked un-reviewed to every surface and got accepted anyway.
    await storage.createTurn({
      sessionId: session.id,
      sequence: 7,
      role: 'agent',
      content: 'garbage',
      turnType: 'review',
      review: { verdict: 'prose', security: 'unparsed', data_integrity: 'unparsed', findings: [] },
    });

    await storage.createComment(task.id, 'seen already');
    const comments = await storage.getTaskComments(task.id);
    await storage.markNotesDelivered(session.id, comments[0].created_at);
    // The cutoff IS a comment's own `created_at`, and delivery is `<=` it — so
    // two comments written inside the same millisecond are genuinely
    // indistinguishable to it, and the second came back DELIVERED on a fast or
    // loaded machine. That flake is in this setup, not in the rule: wait until
    // the clock has actually moved before writing the one that must stay
    // queued.
    const wroteAt = comments[0].created_at;
    while (Date.now() <= wroteAt) await new Promise((r) => setTimeout(r, 1));
    await storage.createComment(task.id, 'still queued');
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('omitting sections serves the whole record, and says so', async () => {
    const payload = (await handleShow(root, { taskId })) as Record<string, any>;

    expect(payload.turns).toHaveLength(7);
    expect(payload.comments).toHaveLength(2);
    expect(payload.sectionsServed).toContain('turns');
    expect(payload.sectionsServed).toContain('reviews');
    expect(payload.counts.turns).toBe(7);
    expect(payload.counts.comments).toBe(2);
  });

  test('naming sections narrows the payload and reports what was served', async () => {
    const payload = (await handleShow(root, {
      taskId,
      sections: ['commits'],
    })) as Record<string, any>;

    expect(payload.sectionsServed).toEqual(['commits']);
    expect(payload.turns).toEqual([]);
    expect(payload.comments).toEqual([]);
    expect(payload.chunks).toEqual([]);
    expect(payload.notes).toBeNull();
    // The counts still say how big the unasked-for sections are, so a narrowed
    // caller can tell "nothing there" from "I did not ask".
    expect(payload.counts.turns).toBe(7);
  });

  test('an unknown section is a 400 naming it, never a silent drop', async () => {
    let caught: unknown;
    try {
      await handleShow(root, { taskId, sections: ['turns', 'nonsense'] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).status).toBe(400);
    expect((caught as RpcError).message).toContain('nonsense');
  });

  test('offset and limit page within a requested section', async () => {
    const payload = (await handleShow(root, {
      taskId,
      sections: ['turns'],
      offset: 2,
      limit: 2,
    })) as Record<string, any>;

    expect(payload.turns.map((t: any) => t.sequence)).toEqual([3, 4]);
    expect(payload.counts.turns).toBe(7);
  });

  test('every comment carries whether the agent has seen it', async () => {
    const payload = (await handleShow(root, { taskId })) as Record<string, any>;

    expect(payload.comments.map((c: any) => [c.content, c.delivered])).toEqual([
      ['seen already', true],
      ['still queued', false],
    ]);
    expect(payload.notes.queued_count).toBe(1);
    expect(payload.notes.delivered_count).toBe(1);
    expect(payload.notes.cutoff).toBeGreaterThan(0);
  });

  test('chunks absorb the supervisor nudge and the auto-resume', async () => {
    const payload = (await handleShow(root, { taskId, sections: ['chunks'] })) as Record<string, any>;

    expect(payload.chunks).toEqual([
      { index: 0, boundary_sequence: 1, turn_sequences: [1, 2, 3, 4, 5, 6, 7] },
    ]);
    expect(payload.counts.chunks).toBe(1);
  });

  // INVARIANT: `show` sends the ANSWER, including what a verdict RESOLVES to.
  // The raw text is the reviewer's own; `verdict_kind` is the closed set the
  // daemon acts on, resolved server-side so no client re-derives a merge gate.
  // A FAILED review is listed too — it gates accept exactly like `needs_work`,
  // and a gate nobody can see is worse than one that refuses.
  test('reviews carry the verdict, what it resolves to, and the failed one too', async () => {
    const payload = (await handleShow(root, { taskId, sections: ['reviews'] })) as Record<string, any>;

    expect(payload.reviews).toHaveLength(2);
    expect(payload.counts.reviews).toBe(2);

    // Newest first: the failed one.
    expect(payload.reviews[0].sequence).toBe(7);
    expect(payload.reviews[0].verdict).toBe('prose');
    expect(payload.reviews[0].verdict_kind).toBe('unparsed');
    expect(payload.reviews[0].unparsed).toBe(true);

    expect(payload.reviews[1].sequence).toBe(6);
    expect(payload.reviews[1].verdict).toBe('needs_human');
    expect(payload.reviews[1].verdict_kind).toBe('needs_human');
    expect(payload.reviews[1].raised_item_ids).toEqual(['raise-1']);
    expect(payload.reviews[1].findings).toEqual([]);
    expect(payload.reviews[1].unparsed).toBe(false);
  });

  // INVARIANT: a served review says WHEN it ran. A stored Turn spells its clock
  // `timestamp` and `ReviewTurnLike` spells it `created_at`, so handing raw
  // turns to the projection type-checked and sent null on every review — the
  // daemon's own Reviews tab renamed the field inline and the two remote
  // surfaces did not. A remote Reviews list with no timestamps is the symptom.
  test('a review carries the time of the turn that produced it', async () => {
    const payload = (await handleShow(root, { taskId, sections: ['turns', 'reviews'] })) as Record<string, any>;

    const reviewTurn = payload.turns.find((t: any) => t.sequence === 6);
    expect(reviewTurn.timestamp).toBeGreaterThan(0);
    const served = payload.reviews.find((r: any) => r.sequence === 6);
    expect(served.created_at).toBe(reviewTurn.timestamp);
  });

  // INVARIANT: `show` serves the "Before you can accept" rows the daemon's own
  // Current review tab renders, built by the same function and never
  // section-gated. Lazy Teams renders them as served — a checklist it
  // re-derived would be a second copy of the review gate accept refuses on.
  test('serves the accept gate, whatever sections were asked for', async () => {
    const payload = (await handleShow(root, { taskId, sections: [] })) as Record<string, any>;

    // The fixture also holds comments no prompt has carried, which gate too.
    expect(payload.acceptGate.rows.map((r: { kind: string }) => r.kind)).toEqual(['review', 'comments']);
    // Exactly one: 'seen already' was delivered, 'still queued' was not.
    expect(payload.acceptGate.rows[1].count).toBe(1);
    const row = payload.acceptGate.rows[0];
    expect(row.kind).toBe('review');
    expect(row.sequence).toBe(7);
    expect(row.label).toContain('Formal review (turn #7)');
    expect(row.unblockable).toBe(true);
  });

  // INVARIANT: `show` answers whether the cap on consecutive turns without a
  // human (limits.max_turns_without_human) is SPENT, through the same check
  // the unblock/resume/start refusal uses, never section-gated. A Teams member
  // looking at a blocked task has no other way to learn that automation will
  // be refused and only a person's unblock lets it go on; a client re-deriving
  // it from metadata would be a second copy of the gate.
  test('serves the turns-without-a-human budget, whatever sections were asked for', async () => {
    const storage = await getOrCreateStorage();
    const fresh = (await handleShow(root, { taskId, sections: [] })) as Record<string, any>;
    expect(fresh.turnBudget).toEqual({ count: 0, max: 10, exhausted: false });

    for (let i = 0; i < 10; i++) await incrementNonHumanTurnCount(storage, taskId);
    const spent = (await handleShow(root, { taskId, sections: [] })) as Record<string, any>;
    expect(spent.turnBudget).toEqual({ count: 10, max: 10, exhausted: true });
  });
});
