/**
 * Unit tests for review-finding recovery.
 *
 * THE MECHANISM THIS PINS REPLACED AN EARLIER ONE, and the replacement is the
 * point. Under the raise-era contract every finding became a Raise — filed by
 * `lazy_raise`, or ingested here from the verdict when MCP was down — and the
 * invariant was "findings must become Raises or the review must fail loudly".
 * That cost two dead turns per review round (the fixer's next `lazy_final` was
 * refused by the reviewer's own blocking raise) and left a human triaging items
 * for defects that had already been fixed.
 *
 * NOW: `report.findings` IS the issue store, and the daemon delivers it to the
 * implementer as its next turn's brief. Nothing here creates a Raise from a
 * finding. What it still guarantees:
 *   - handoff entries (journal, and the ONE `needs_human` raise) are persisted
 *     with this review turn's attribution when MCP was unreachable;
 *   - a required SWEEP that names an issue no finding covers becomes a
 *     FINDING — so "I found a SQL injection" in the security statement cannot
 *     evaporate because the reviewer forgot the array;
 *   - `raised_item_ids` is stamped from the Raises attributed to this turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import {
  ensureSweepsAreCovered,
  recoverAndAttachReviewFindings,
  reviewSweepClaimsIssue,
} from '../../src/review/recover-findings';
import { reviewIsClean, reviewSweepsClaimUncoveredIssue } from '../../src/review/verdict';
import { reviewFailed, reviewIssueCount, reviewIssuesAwaitingWork } from '../../src/review/success';
import type { ReviewReport } from '../../src/types/review-report';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    verdict: 'needs_work',
    security: 'none found',
    data_integrity: 'none found',
    findings: [],
    ...overrides,
  };
}

describe('reviewSweepClaimsIssue', () => {
  test('none found and unparsed do not claim issues', () => {
    expect(reviewSweepClaimsIssue('none found')).toBe(false);
    expect(reviewSweepClaimsIssue('unparsed')).toBe(false);
    expect(reviewSweepClaimsIssue('parent notify lost')).toBe(true);
  });
});

describe('ensureSweepsAreCovered', () => {
  // INVARIANT: a sweep that names an issue reaches the fixer. Under the old
  // contract this became a BLOCKING Raise, which parked the task on a defect
  // anyone could fix; it is a finding now, because "we never let those through,
  // so there is nothing to decide" — a fixable security defect is work, not a
  // decision.
  test('an uncovered security sweep becomes a critical security finding', () => {
    const r = report({ security: 'argv is interpolated into a shell string' });
    ensureSweepsAreCovered(r);
    expect(r.findings).toEqual([
      {
        severity: 'critical',
        category: 'security',
        summary: 'Security sweep: argv is interpolated into a shell string',
      },
    ]);
  });

  test('an uncovered data-integrity sweep becomes a critical data-integrity finding', () => {
    const r = report({ data_integrity: 'tasks.json is written without a temp-file rename' });
    ensureSweepsAreCovered(r);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('data-integrity');
    expect(r.findings[0]!.summary).toContain('temp-file rename');
  });

  // INVARIANT: coverage is category-level, never text-matching. A reviewer that
  // summarises its own findings in the sweep statement must not have every
  // summary duplicated back as a second finding.
  test('a sweep already covered by a finding of that category adds nothing', () => {
    const r = report({
      security: 'argv is interpolated into a shell string',
      findings: [{
        severity: 'high',
        category: 'security',
        file: 'src/foo.ts',
        summary: 'argv interpolation',
      }],
    });
    ensureSweepsAreCovered(r);
    expect(r.findings).toHaveLength(1);
  });

  test('clean sweeps add nothing', () => {
    const r = report();
    ensureSweepsAreCovered(r);
    expect(r.findings).toEqual([]);
  });
});

describe('recoverAndAttachReviewFindings', () => {
  let lazyRoot: string;
  let storage: FileStorage;
  let taskId: string;
  let sessionId: string;
  let baseSha: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-review-recover-'));
    const basePath = await mkdtemp(join(tmpdir(), 'lazy-review-recover-store-'));

    git(lazyRoot, 'init');
    git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
    git(lazyRoot, 'config', 'user.name', 'Lazy Test');
    git(lazyRoot, 'checkout', '-b', 'main');
    await writeFile(join(lazyRoot, 'README.md'), '# base\n');
    git(lazyRoot, 'add', '.');
    git(lazyRoot, 'commit', '-m', 'base');
    baseSha = git(lazyRoot, 'rev-parse', 'HEAD');

    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('review recover', undefined, baseSha);
    taskId = task.id;
    const session = await storage.createSession(taskId, 'claude-code', `lazy/${task.code}`, baseSha);
    sessionId = session.id;
  });

  afterEach(async () => {
    await storage.close();
    await rm(lazyRoot, { recursive: true, force: true });
  });

  // INVARIANT: handoff raised entries land attributed to the review turn so
  // raised_item_ids attaches — the same provenance as lazy_raise. This is the
  // MCP-down path for the ONE raise a reviewer may still file, the
  // `needs_human` decision.
  test('persists handoff Raises with session + turn attribution', async () => {
    const r = report({ verdict: 'needs_human' });
    await recoverAndAttachReviewFindings({
      storage,
      taskId,
      sessionId,
      turnSequence: 4,
      report: r,
      agentHandoff: [
        { kind: 'raised', blocking: true, content: 'The goal contradicts itself: X and not-X' },
      ],
    });

    expect(r.raised_item_ids?.length).toBe(1);
    const items = await storage.getTaskRaisedItems(taskId);
    expect(items).toHaveLength(1);
    expect(items[0]!.session_id).toBe(sessionId);
    expect(items[0]!.turn_sequence).toBe(4);
    expect(items[0]!.blocking).toBe(true);
  });

  // INVARIANT: a FINDING never becomes a Raise. This is the whole change from
  // the previous contract — a Raise outlives the fix and lands a human with an
  // item to triage about something corrected two turns later.
  test('findings create no Raises at all', async () => {
    const r = report({
      findings: [
        { severity: 'critical', category: 'security', summary: 'command injection in argv' },
        { severity: 'medium', category: 'tests', summary: 'no coverage for the retry path' },
      ],
    });
    await recoverAndAttachReviewFindings({
      storage,
      taskId,
      sessionId,
      turnSequence: 6,
      report: r,
    });

    expect(await storage.getTaskRaisedItems(taskId)).toHaveLength(0);
    expect(r.raised_item_ids).toBeUndefined();
    expect(r.findings).toHaveLength(2);
  });

  // INVARIANT: a non-clean sweep with no matching finding is recovered as a
  // FINDING, not as a blocking Raise. The incident behind the old rule
  // (findings left only in `data_integrity`) is still covered — the fixer
  // receives it — without parking the task for a human decision.
  test('recovers an uncovered sweep as a finding, creating no Raise', async () => {
    const r = report({
      data_integrity:
        'parent accept comment can be permanently lost: notify only in acceptTask finalize',
    });
    await recoverAndAttachReviewFindings({
      storage,
      taskId,
      sessionId,
      turnSequence: 4,
      report: r,
    });

    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('data-integrity');
    expect(r.findings[0]!.summary).toContain('permanently lost');
    expect(await storage.getTaskRaisedItems(taskId)).toHaveLength(0);
  });

  // INVARIANT: only BLOCKING raises are stamped onto the report. A reviewer's
  // non-blocking FYI about something orthogonal is the NORMAL output of a good
  // reviewer — the tool instructions invite it — and it must not make a `clean`
  // review read as unclean.
  //
  // Without the filter, a review returning `clean` with zero findings and one
  // FYI produced: a fix turn whose brief said "found 0 issues, fix each one
  // below", a spent round from the loop's budget, and an accept refused for "1
  // unaddressed issue" on a review that had just said the work was clean. Every
  // consumer of `raised_item_ids` reads it as "what this review left to act on",
  // so the filter belongs at the stamp rather than at each of them.
  test('a non-blocking FYI is not stamped, so a clean review stays clean', async () => {
    await storage.createRaisedItem(taskId, {
      content: 'Noticed the retry path swallows errors — unrelated to this task.',
      blocking: false,
      session_id: sessionId,
      turn_sequence: 4,
    });
    const r = report({ verdict: 'clean' });
    await recoverAndAttachReviewFindings({
      storage, taskId, sessionId, turnSequence: 4, report: r,
    });

    expect(r.raised_item_ids).toBeUndefined();
    expect(reviewIsClean(r)).toBe(true);
    expect(reviewIssueCount(r)).toBe(0);
    expect(reviewIssuesAwaitingWork([
      { sequence: 4, role: 'agent', turn_type: 'review', review: r },
    ])).toBeNull();

    // The FYI itself is NOT lost — it is a Raise on the task with its own
    // provenance back to this review turn.
    const items = await storage.getTaskRaisedItems(taskId);
    expect(items).toHaveLength(1);
    expect(items[0]!.blocking).toBe(false);
    expect(items[0]!.turn_sequence).toBe(4);
  });

  // The other half of the same rule: the `needs_human` decision IS stamped, so
  // it still gates. A filter that dropped everything would pass the test above
  // and break the one thing a reviewer may still raise.
  test('a blocking decision is stamped alongside an FYI filed on the same turn', async () => {
    await storage.createRaisedItem(taskId, {
      content: 'An orthogonal FYI.',
      blocking: false,
      session_id: sessionId,
      turn_sequence: 4,
    });
    const decision = await storage.createRaisedItem(taskId, {
      content: 'The goal contradicts itself: X and not-X.',
      blocking: true,
      session_id: sessionId,
      turn_sequence: 4,
    });

    const r = report({ verdict: 'needs_human' });
    await recoverAndAttachReviewFindings({
      storage, taskId, sessionId, turnSequence: 4, report: r,
    });

    expect(r.raised_item_ids).toEqual([decision.id]);
    expect(reviewIsClean(r)).toBe(false);
    expect(reviewIssueCount(r)).toBe(1);
  });

  test('stamps raised_item_ids from Raises lazy_raise filed on this turn', async () => {
    await storage.createRaisedItem(taskId, {
      content: 'Already filed via MCP',
      blocking: true,
      session_id: sessionId,
      turn_sequence: 4,
    });
    const r = report({ verdict: 'needs_human' });
    await recoverAndAttachReviewFindings({
      storage,
      taskId,
      sessionId,
      turnSequence: 4,
      report: r,
    });
    expect(r.raised_item_ids).toHaveLength(1);
    const items = await storage.getTaskRaisedItems(taskId);
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('Already filed via MCP');
  });

  // INVARIANT: repeating a review no longer risks the round accounting. Under
  // the old mechanism a re-raised identical finding deduped to an existing row
  // attributed to the ORIGINAL turn, so a turn-scoped re-query missed it, the
  // round read as clean and the cap became unreachable — the reason the old
  // suite pinned "re-raising an identical finding stamps the deduped row id".
  // The accounting reads FINDINGS now, which have no identity and no dedupe, so
  // two identical reviews each count their own round.
  test('an identical second review leaves its findings intact and files nothing', async () => {
    const mk = () => report({
      findings: [
        { severity: 'medium', category: 'tests', summary: 'Missing coverage for the retry path' },
      ],
    });

    const first = mk();
    await recoverAndAttachReviewFindings({
      storage, taskId, sessionId, turnSequence: 8, report: first,
    });
    const second = mk();
    await recoverAndAttachReviewFindings({
      storage, taskId, sessionId, turnSequence: 16, report: second,
    });

    expect(first.findings).toHaveLength(1);
    expect(second.findings).toHaveLength(1);
    expect(await storage.getTaskRaisedItems(taskId)).toHaveLength(0);
  });
});

describe('reviewSweepClaimsIssue — a clean sweep must not invent a defect', () => {
  // INVARIANT: cleanliness is matched on a normalised PREFIX, never by exact
  // equality against `'none found'`.
  //
  // Exact equality meant a single trailing period — which models add
  // constantly — read as a claim, and `ensureSweepsAreCovered` then synthesised
  // a `critical` / `security` finding whose entire content was the words
  // "None found.". On a `clean` verdict that gated accept, spent an auto-fix
  // round, and on a loop's child spent one of its `max_child_fix_rounds` too:
  // a cap reachable on nothing at all.
  //
  // The review that caught this demonstrated it — its own sweep opened
  // "none found — the diff adds no new untrusted-input boundary; …", so a clean
  // review of this very branch would have manufactured a critical security
  // finding and refused its own accept.
  test('punctuation and an explanation do not turn a clean sweep into a claim', () => {
    for (const clean of [
      'none found',
      'None found.',
      'NONE FOUND!',
      '  none found  ',
      'none found — the diff adds no new untrusted-input boundary; argv is unchanged',
      'none found: every write goes through the atomic helper',
      'None found - nothing here touches persistent state.',
      'no issues found',
      'No issues found.',
      'no issues',
      'No issues',
      'nothing found',
      'none identified',
      'none',
      'None.',
      'n/a',
      'N/A',
      'nothing',
    ]) {
      expect(reviewSweepClaimsIssue(clean)).toBe(false);
    }
  });

  // The other direction, which is what the predicate is FOR. A false negative
  // here would let a named security defect through with no finding.
  test('a sweep that names something still claims an issue', () => {
    for (const dirty of [
      'argv is interpolated into a shell string',
      'SQL injection in the search handler',
      // Opens with a clean-ish WORD but is not one of the clean forms — the
      // reason bare `none` is only accepted as the WHOLE statement.
      'none of the writes are atomic — the migration can half-apply',
      'nothing guards the upload path',
      'no issues in the new code, but the existing retry swallows a failed write',
      'found one: the token is logged at info',
    ]) {
      expect(reviewSweepClaimsIssue(dirty)).toBe(true);
    }
  });

  test('the unparsed sentinel and an empty statement claim nothing', () => {
    expect(reviewSweepClaimsIssue('unparsed')).toBe(false);
    expect(reviewSweepClaimsIssue('')).toBe(false);
    expect(reviewSweepClaimsIssue('   ')).toBe(false);
    expect(reviewSweepClaimsIssue(null)).toBe(false);
    expect(reviewSweepClaimsIssue(undefined)).toBe(false);
  });

  // End to end through the backstop: the shape that used to manufacture a
  // critical finding on a clean review now adds nothing.
  test('a clean-with-reason sweep synthesises no finding', () => {
    const r = report({
      verdict: 'clean',
      security: 'none found — the diff adds no new untrusted-input boundary.',
      data_integrity: 'None found.',
    });
    ensureSweepsAreCovered(r);
    expect(r.findings).toEqual([]);
    expect(reviewIsClean(r)).toBe(true);
  });
});

/**
 * A report whose SWEEP names an issue is not a clean bill of health, however it
 * reached storage.
 *
 * Successor to the deleted `reviewSweepsClaimIssuesWithoutRaises` coverage,
 * which the raise-era contract took with it. The shape it guarded is still
 * reachable: `verdict: clean`, a security or data-integrity statement
 * describing a real defect, and `findings: []`.
 *
 * Normally `ensureSweepsAreCovered` turns such a statement into a finding as
 * the review turn is recorded, and the finding is what makes the report
 * unclean. But the synthesis runs on ONE path and the clean predicate is read
 * by four — the accept gate, the round accounting, the Reviews list, the web
 * review page. A report that arrived another way (recorded before the
 * synthesis existed, or by a path that never called it) read as CLEAN to every
 * one of them while saying in its own words that it had found a SQL injection.
 * That is a silent acceptance of a named security defect, which is the one
 * direction these predicates may not fail in.
 */
describe('a dirty sweep with no findings', () => {
  const dirty = (): ReviewReport => report({
    verdict: 'clean',
    security: 'the task id is interpolated into a shell string',
    findings: [],
  });

  test('is NOT clean, and is NOT reported as a failed review either', () => {
    const r = dirty();
    // Not "failed": the report parsed fine and we know exactly what it said.
    expect(reviewFailed(r)).toBe(false);
    // But it is not clean — the statement is an issue, empty findings or not.
    expect(reviewIsClean(r)).toBe(false);
    expect(reviewSweepsClaimUncoveredIssue(r)).toBe(true);
  });

  test('holds the accept gate, with nothing outstanding to count', () => {
    const awaiting = reviewIssuesAwaitingWork([
      { sequence: 4, role: 'agent', turn_type: 'review', review: dirty() },
    ]);
    expect(awaiting).not.toBeNull();
    expect(awaiting!.raiseCount).toBe(0);
    expect(awaiting!.verdict).toBe('clean');
  });

  // Coverage is CATEGORY-level, the same rule `ensureSweepsAreCovered` uses —
  // a reviewer that filed a security finding has covered its security
  // statement, and nothing is counted twice.
  test('a finding of that category covers the statement', () => {
    const r = report({
      verdict: 'needs_work',
      security: 'the task id is interpolated into a shell string',
      findings: [{ severity: 'high', category: 'security', summary: 'shell interpolation' }],
    });
    expect(reviewSweepsClaimUncoveredIssue(r)).toBe(false);
  });

  // The ordinary path still ends in the same place, by a different route: the
  // statement becomes a finding, and the finding makes the report unclean.
  test('the synthesis reaches the same verdict on the normal path', () => {
    const r = dirty();
    ensureSweepsAreCovered(r);
    expect(r.findings).toHaveLength(1);
    expect(reviewIsClean(r)).toBe(false);
  });
});

/**
 * A decision that DEDUPES to an identical earlier row is still attributed to
 * the review that filed it.
 *
 * `raised_item_ids` is turn-scoped: the stamp lists the blocking raises whose
 * `session_id`/`turn_sequence` match THIS review turn. The handoff path dedupes
 * by content against every raise the task already has, so a reviewer that filed
 * the same `needs_human` decision in the same words on a second round created
 * no new row — and its review then carried no raised item at all, having just
 * said the task cannot be completed as specified. The accept gate, the round
 * accounting and the Reviews tab all read that list.
 *
 * Both halves matter and neither replaces the other: ONE row (two identical
 * open items are two things for a human to resolve, saying one thing) and the
 * attribution on EVERY review that filed it.
 */
describe('a blocking handoff raise that dedupes', () => {
  let lazyRoot: string;
  let storage: FileStorage;
  let taskId: string;
  let sessionId: string;
  const decision = 'The goal contradicts itself: X and not-X.';

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-review-dedupe-'));
    const basePath = await mkdtemp(join(tmpdir(), 'lazy-review-dedupe-store-'));

    git(lazyRoot, 'init');
    git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
    git(lazyRoot, 'config', 'user.name', 'Lazy Test');
    git(lazyRoot, 'checkout', '-b', 'main');
    await writeFile(join(lazyRoot, 'README.md'), '# base\n');
    git(lazyRoot, 'add', '.');
    git(lazyRoot, 'commit', '-m', 'base');
    const baseSha = git(lazyRoot, 'rev-parse', 'HEAD');

    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('dedupe attribution', undefined, baseSha);
    taskId = task.id;
    sessionId = (await storage.createSession(taskId, 'claude-code', `lazy/${task.code}`, baseSha)).id;
  });

  afterEach(async () => {
    await storage.close();
    await rm(lazyRoot, { recursive: true, force: true });
  });

  test('creates no second row but is still stamped on the current review', async () => {
    // Round one: the decision lands with turn #4's provenance.
    const first = report({ verdict: 'needs_human' });
    await recoverAndAttachReviewFindings({
      storage, taskId, sessionId, turnSequence: 4, report: first,
      agentHandoff: [{ kind: 'raised', blocking: true, content: decision }],
    });
    const created = await storage.getTaskRaisedItems(taskId);
    expect(created).toHaveLength(1);
    expect(first.raised_item_ids).toEqual([created[0]!.id]);

    // Round two: same words, a later turn. The row is not duplicated…
    const second = report({ verdict: 'needs_human' });
    await recoverAndAttachReviewFindings({
      storage, taskId, sessionId, turnSequence: 9, report: second,
      agentHandoff: [{ kind: 'raised', blocking: true, content: decision }],
    });
    expect(await storage.getTaskRaisedItems(taskId)).toHaveLength(1);
    // …and the second review is not left claiming it raised nothing.
    expect(second.raised_item_ids).toEqual([created[0]!.id]);
    expect(reviewIsClean(second)).toBe(false);
  });

  // The stamp stays BLOCKING-only. A deduped FYI must not make a clean review
  // read as unclean — that is the bug the stamp filter exists to prevent, and
  // re-attributing deduped rows must not reintroduce it through the back door.
  test('a deduped non-blocking FYI is not stamped', async () => {
    const fyi = 'Noticed the retry path swallows errors — unrelated to this task.';
    for (const turnSequence of [4, 9]) {
      const r = report({ verdict: 'clean' });
      await recoverAndAttachReviewFindings({
        storage, taskId, sessionId, turnSequence, report: r,
        agentHandoff: [{ kind: 'raised', blocking: false, content: fyi }],
      });
      expect(r.raised_item_ids).toBeUndefined();
      expect(reviewIsClean(r)).toBe(true);
    }
    expect(await storage.getTaskRaisedItems(taskId)).toHaveLength(1);
  });
});
