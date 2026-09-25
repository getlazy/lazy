/**
 * Unit tests for turn-report + file-decision storage.
 *
 * INVARIANT: upsert is latest-wins per session (report) / per scope+target
 * (decision). Validation rejects empty sections, unknown kinds, empty reasons.
 * Passive writes never change task status (asserted by reading status after upsert).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { normalizeTurnReportSections } from '../../src/storage/turn-report';

describe('turn-report storage', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let taskId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-tr-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-tr-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('Turn report storage test');
    taskId = task.id;
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('upsertTurnReport creates and latest-wins per session', async () => {
    const first = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-1',
      sections: [
        { kind: 'what_was_done', body: 'Did the thing' },
        { kind: 'how_to_verify', body: 'Run the tests' },
      ],
    });
    expect(first.sections).toHaveLength(2);
    expect(first.sections[0]!.kind).toBe('what_was_done');

    const second = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-1',
      sections: [{ kind: 'commentary', body: 'Revised' }],
      raised_item_ids: ['aaaaaaaa'],
    });
    expect(second.id).toBe(first.id);
    expect(second.sections).toEqual([{ kind: 'commentary', body: 'Revised' }]);
    expect(second.raised_item_ids).toEqual(['aaaaaaaa']);
    expect(second.updated_at).toBeDefined();

    const all = await storage.getTaskTurnReports(taskId);
    expect(all).toHaveLength(1);

    const bySession = await storage.getTurnReportBySession(taskId, 'sess-1');
    expect(bySession?.sections[0]?.body).toBe('Revised');
  });

  test('stampTurnReportSequence is best-effort and no-op without report', async () => {
    await storage.stampTurnReportSequence(taskId, 'missing-session', 3);

    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-2',
      sections: [{ kind: 'commentary', body: 'hi' }],
    });
    await storage.stampTurnReportSequence(taskId, 'sess-2', 7);
    const report = await storage.getTurnReportBySession(taskId, 'sess-2');
    expect(report?.turn_sequence).toBe(7);
  });

  // INVARIANT: reporting channel never changes task status.
  test('upsertTurnReport does not change task status', async () => {
    const before = await storage.getTask(taskId);
    expect(before?.status).toBe('backlog');
    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-status',
      sections: [{ kind: 'commentary', body: 'no status change' }],
    });
    const after = await storage.getTask(taskId);
    expect(after?.status).toBe('backlog');
  });

  test('validation rejects empty sections and unknown kinds', () => {
    expect(() => normalizeTurnReportSections([])).toThrow(/non-empty/);
    expect(() =>
      normalizeTurnReportSections([{ kind: 'not_a_kind', body: 'x' }]),
    ).toThrow(/unknown kind/);
    expect(() =>
      normalizeTurnReportSections([{ kind: 'commentary', body: '   ' }]),
    ).toThrow(/non-empty string/);
  });

  test('accepts behavior_change and implementation without migrating what_was_done', () => {
    const sections = normalizeTurnReportSections([
      { kind: 'behavior_change', body: 'users see a split report' },
      { kind: 'implementation', body: 'new kinds in the schema' },
      { kind: 'what_was_done', body: 'legacy still stores' },
    ]);
    expect(sections.map((s) => s.kind)).toEqual([
      'behavior_change',
      'implementation',
      'what_was_done',
    ]);
  });

  test('allows duplicate section kinds (array order preserved)', async () => {
    const report = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-dup',
      sections: [
        { kind: 'commentary', body: 'first' },
        { kind: 'what_was_done', body: 'middle' },
        { kind: 'commentary', body: 'second' },
      ],
    });
    expect(report.sections.map((s) => s.body)).toEqual(['first', 'middle', 'second']);
  });

  test('upsertFileDecision latest-wins per session+scope+target', async () => {
    const a = await storage.upsertFileDecision(taskId, {
      scope: 'protected',
      target: 'CHANGELOG.md',
      reason: 'first reason',
      session_id: 'sess-fd',
    });
    const b = await storage.upsertFileDecision(taskId, {
      scope: 'protected',
      target: 'CHANGELOG.md',
      reason: 'revised reason',
      session_id: 'sess-fd',
    });
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('revised reason');
    expect(b.decision).toBe('keep');

    await storage.upsertFileDecision(taskId, {
      scope: 'maintain',
      target: 'changelog',
      reason: 'intra-release skip',
      session_id: 'sess-fd',
    });
    const all = await storage.getTaskFileDecisions(taskId);
    expect(all).toHaveLength(2);
  });

  // INVARIANT: a recorded presentation cap refusal is HISTORY and survives
  // the report being replaced. The agent that hit a cap re-sends a smaller
  // walkthrough, and that smaller walkthrough is exactly what the record
  // explains — clearing it when it stops being re-sent would make the cap
  // invisible again the moment it had done its work.
  test('a presentation cap refusal survives the report being replaced', async () => {
    const refused = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-cap',
      sections: [{ kind: 'commentary', body: 'Report text of the refused call' }],
      presentation_cap_refusal: {
        cap: 'narrative_items',
        limit: 64,
        actual: 71,
        created_at: 1,
      },
    });
    expect(refused.presentation_cap_refusal?.cap).toBe('narrative_items');
    expect(refused.presentation).toBeUndefined();

    // The re-send that fits: a real walkthrough, and no refusal in the input.
    const resent = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-cap',
      sections: [{ kind: 'commentary', body: 'Report text of the refused call' }],
      presentation: {
        groups: [{ title: 'All of it', tier: 'core', items: [{ kind: 'file', file: 'a.ts' }] }],
      },
    });
    expect(resent.presentation?.groups).toHaveLength(1);
    expect(resent.presentation_cap_refusal?.actual).toBe(71);
  });

  // INVARIANT: recording a cap refusal NEVER deletes a stored walkthrough.
  // The refusal write is not the agent re-filing its report — it is lazy
  // recording that the walkthrough the agent sent was refused — so it must
  // not take the revocation path. If it did, a cap-refused call that was the
  // last one of a turn (the agent gave up, wrote prose, or was killed) would
  // leave the review with no partition at all: the very "the branch is
  // unregioned" failure this feature exists to prevent, arriving through the
  // code that reports the cap.
  test('a cap refusal does not delete the walkthrough already stored for the session', async () => {
    const good = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-keep',
      sections: [{ kind: 'commentary', body: 'A report with a good walkthrough' }],
      presentation: {
        groups: [{ title: 'All of it', tier: 'core', items: [{ kind: 'file', file: 'a.ts' }] }],
      },
    });
    expect(good.presentation?.groups).toHaveLength(1);

    // The agent then sends a BIGGER walkthrough that trips a cap: sections
    // and the refusal are recorded, and the call fails — and the walkthrough
    // already on the row stays exactly where it was.
    const refused = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-keep',
      sections: [{ kind: 'commentary', body: 'A report with a good walkthrough' }],
      presentation_cap_refusal: {
        cap: 'file_items',
        limit: 512,
        actual: 604,
        created_at: 2,
      },
    });
    expect(refused.presentation_cap_refusal?.actual).toBe(604);
    expect(refused.presentation?.groups.map((g) => g.title)).toEqual(['All of it']);

    const stored = await storage.getTurnReportBySession(taskId, 'sess-keep');
    expect(stored?.presentation?.groups.map((g) => g.title)).toEqual(['All of it']);
  });

  // The other half of the same rule: an ORDINARY report that omits the
  // walkthrough still revokes it. Latest-wins per session is how an agent
  // withdraws one, and the carry-forward above must not turn every report
  // into one that can never drop a walkthrough.
  test('an ordinary report without a walkthrough still revokes the stored one', async () => {
    await storage.upsertTurnReport(taskId, {
      session_id: 'sess-revoke',
      sections: [{ kind: 'commentary', body: 'With a walkthrough' }],
      presentation: {
        groups: [{ title: 'All of it', tier: 'core', items: [{ kind: 'file', file: 'a.ts' }] }],
      },
    });
    const plain = await storage.upsertTurnReport(taskId, {
      session_id: 'sess-revoke',
      sections: [{ kind: 'commentary', body: 'Without one' }],
    });
    expect(plain.presentation).toBeUndefined();
  });

  test('file decision rejects empty reason', async () => {
    await expect(
      storage.upsertFileDecision(taskId, {
        scope: 'protected',
        target: 'x.ts',
        reason: '  ',
      }),
    ).rejects.toThrow(/non-empty/);
  });
});
