/**
 * Parser and type-shape tests for the agent-review record.
 *
 * Two failure modes these exist to prevent, and the second is new:
 *   - a silent "pass" when the agent omitted the security/data-integrity
 *     statements;
 *   - a FINDING that the parser quietly dropped. Findings are the issue store
 *     now — each one is delivered to the implementer as its next turn's brief —
 *     so dropping a malformed one loses the fix, not just a forge comment.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseReviewReport,
  parseReviewReply,
  formatReviewReport,
  formatUnparsedReviewSuffix,
  reviewReportIsUnparsed,
  REVIEW_UNPARSED,
  UNPARSED_REVIEW_LABEL,
} from '../../src/review/parse-report';
import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  type ReviewReport,
} from '../../src/types/review-report';
import {
  REVIEW_CRASH_VERDICT_PREFIX,
  REVIEW_UNDISPATCHED_VERDICT_PREFIX,
  chooseReviewReport,
  describeFailedReview,
  describeReviewFailureShort,
  parseVerdictText,
  resolveReviewVerdict,
  reviewIsClean,
  reviewNotRunHeadline,
  undispatchedReviewVerdict,
} from '../../src/review/verdict';
import { reviewIssuesAwaitingWork } from '../../src/review/success';
import reaskPrompt from '../../src/prompts/review-verdict-reask.md' with { type: 'text' };

describe('parseReviewReport', () => {
  test('parses a fenced JSON report with both required statements', () => {
    const report = parseReviewReport(`
Here you go:

\`\`\`json
{
  "verdict": "needs_work",
  "security": "none found",
  "data_integrity": "writes to tasks.json are not atomic",
  "findings": [
    {
      "file": "src/storage/file-storage.ts",
      "line": 42,
      "severity": "high",
      "category": "data-integrity",
      "summary": "tasks.json is written without a temp-file rename"
    }
  ]
}
\`\`\`
`);
    expect(report.verdict).toBe('needs_work');
    expect(report.security).toBe('none found');
    expect(report.data_integrity).toBe('writes to tasks.json are not atomic');
    expect(report.findings).toEqual([
      {
        file: 'src/storage/file-storage.ts',
        line: 42,
        severity: 'high',
        category: 'data-integrity',
        summary: 'tasks.json is written without a temp-file rename',
      },
    ]);
  });

  test('accepts camelCase dataIntegrity', () => {
    const report = parseReviewReport('{"verdict":"clean","security":"none found","dataIntegrity":"none found","findings":[]}');
    expect(report.data_integrity).toBe('none found');
  });

  test('missing security/data-integrity statements become unparsed, not a silent pass', () => {
    const report = parseReviewReport('{"verdict":"clean","findings":[]}');
    expect(report.verdict).toBe('clean');
    expect(report.security).toBe(REVIEW_UNPARSED);
    expect(report.data_integrity).toBe(REVIEW_UNPARSED);
  });

  test('prose with no JSON is unparsed on both required statements', () => {
    const report = parseReviewReport('Seems fine to me.');
    expect(report.verdict).toBe('Seems fine to me.');
    expect(report.security).toBe(REVIEW_UNPARSED);
    expect(report.data_integrity).toBe(REVIEW_UNPARSED);
    expect(report.findings).toEqual([]);
  });

  // INVARIANT: a malformed finding is REPAIRED, never dropped. Findings are the
  // issue store — each one is handed to the implementer as its next turn's
  // brief — so a parser that silently discards one loses the fix itself. Under
  // the previous contract findings were forge-comment leftovers and dropping
  // them cost nothing, which is why this used to assert the opposite.
  test('repairs findings with unknown or missing category/severity instead of dropping them', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [
        { severity: 'high', category: 'security', summary: 'keep me' },
        { severity: 'nuclear', category: 'security', summary: 'bad severity' },
        { severity: 'high', category: 'vibes', summary: 'bad category' },
        { summary: 'no severity or category at all' },
        { title: 'summary spelled title' },
      ],
    }));
    expect(report.findings).toEqual([
      { severity: 'high', category: 'security', summary: 'keep me' },
      // An UNREADABLE severity now resolves to a gating one. It used to be
      // `medium`, which was harmless while every finding held the merge; once
      // the gate narrowed to critical/high, "repaired to medium" meant
      // "silently cannot hold a merge" — the gate failing open on a spelling.
      // A MISSING severity is still `medium` (below): no severity expressed is
      // not the same as one we could not read.
      { severity: 'high', category: 'security', summary: 'bad severity' },
      { severity: 'high', category: 'correctness', summary: 'bad category' },
      { severity: 'medium', category: 'correctness', summary: 'no severity or category at all' },
      { severity: 'medium', category: 'correctness', summary: 'summary spelled title' },
    ]);
  });

  /*
   * INVARIANT: the severity lookup normalises case and whitespace, and an
   * unreadable severity resolves to a GATING one.
   *
   * `REVIEW_GATING_SEVERITIES` limits the accept gate to critical/high, so a
   * reviewer writing "Critical" or " high" was producing a finding that could
   * not hold a merge — the gate failing OPEN on nothing but a spelling, which
   * is the one direction a gate may not fail in.
   */
  test('severity is matched case- and whitespace-insensitively', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [
        { severity: 'Critical', category: 'security', summary: 'shouted' },
        { severity: ' high ', category: 'security', summary: 'padded' },
        { severity: 'MEDIUM', category: 'style', summary: 'shouted nit' },
      ],
    }));
    expect(report.findings.map((f) => f.severity)).toEqual(['critical', 'high', 'medium']);
  });

  test('a severity we cannot read fails closed, not open', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [{ severity: 'blocker', category: 'correctness', summary: 'a word we do not know' }],
    }));
    expect(report.findings[0]!.severity).toBe('high');
  });

  test('a finding written as a bare string still becomes a finding', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: ['the retry path swallows errors', '  ', 3],
    }));
    expect(report.findings).toEqual([
      { severity: 'medium', category: 'correctness', summary: 'the retry path swallows errors' },
    ]);
  });

  test('a finding with no summary anywhere is skipped — nothing left to deliver', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [{ severity: 'low', category: 'style' }],
    }));
    expect(report.findings).toEqual([]);
  });

  test('empty findings and a clean sweep stay empty', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'clean',
      security: 'none found',
      data_integrity: 'none found',
      findings: [],
    }));
    expect(report.findings).toEqual([]);
  });
});

describe('ReviewReport vocabulary', () => {
  test('categories are the six the prompt names', () => {
    expect([...REVIEW_FINDING_CATEGORIES]).toEqual([
      'security',
      'data-integrity',
      'correctness',
      'tests',
      'incomplete',
      'style',
    ]);
  });

  test('severities are the four the prompt names', () => {
    expect([...REVIEW_FINDING_SEVERITIES]).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
  });

  test('verdicts are the three the daemon acts on', () => {
    expect([...REVIEW_VERDICTS]).toEqual(['clean', 'needs_work', 'needs_human']);
  });
});

describe('resolveReviewVerdict', () => {
  const parsed = (verdict: string, findings: unknown[] = []) => parseReviewReport(JSON.stringify({
    verdict,
    security: 'none found',
    data_integrity: 'none found',
    findings,
  }));

  test('normalises case, punctuation and space/hyphen/underscore spellings', () => {
    expect(parseVerdictText('clean')).toBe('clean');
    expect(parseVerdictText('  CLEAN.  ')).toBe('clean');
    expect(parseVerdictText('needs work')).toBe('needs_work');
    expect(parseVerdictText('Needs-Work')).toBe('needs_work');
    expect(parseVerdictText('needs_human')).toBe('needs_human');
  });

  // INVARIANT: synonyms are NOT accepted. The prompts name three words and the
  // parser accepts exactly those three, so the two can never drift apart
  // silently. A reviewer that says something else is re-asked once, and a
  // review that still will not say one of them is FAILED — which gates accept.
  // The run this contract came from produced six spellings of three ideas
  // across nine reviews; a synonym table would have hidden that.
  test('a synonym is unparsed, not guessed at', () => {
    for (const synonym of ['approve', 'approved', 'pass', 'LGTM', 'request changes', 'needs_decision', 'looks good to me']) {
      expect(parseVerdictText(synonym)).toBe('unparsed');
    }
  });

  test('prose in the verdict field is unparsed', () => {
    expect(resolveReviewVerdict(parseReviewReport('Seems fine to me.'))).toBe('unparsed');
  });

  // INVARIANT: an unreadable sweep statement makes the whole report unparsed,
  // whatever the verdict claims. The two statements are part of the contract,
  // so "clean" over a missing security sweep is not a clean bill of health.
  test('a missing sweep statement outranks a well-formed verdict', () => {
    const report = parseReviewReport('{"verdict":"clean","findings":[]}');
    expect(resolveReviewVerdict(report)).toBe('unparsed');
    expect(reviewReportIsUnparsed(report)).toBe(true);
  });

  // INVARIANT: findings win over a contradicting verdict. A gate may only ever
  // fail in the restrictive direction, so "clean" plus three findings is not
  // clean.
  test('clean plus findings is not clean', () => {
    const report = parsed('clean', [
      { severity: 'low', category: 'style', summary: 'nit' },
    ]);
    expect(resolveReviewVerdict(report)).toBe('clean');
    expect(reviewIsClean(report)).toBe(false);
  });

  test('clean with nothing filed is clean', () => {
    expect(reviewIsClean(parsed('clean'))).toBe(true);
  });

  test('a legacy report carrying raises is not clean', () => {
    const report = parsed('clean');
    report.raised_item_ids = ['abc'];
    expect(reviewIsClean(report)).toBe(false);
  });
});

describe('formatReviewReport', () => {
  test('an unparsed report renders as a failed review, never Findings: none', () => {
    const report = parseReviewReport('Seems fine to me.');
    expect(reviewReportIsUnparsed(report)).toBe(true);
    const rendered = formatReviewReport(report);
    expect(rendered).toContain(UNPARSED_REVIEW_LABEL);
    expect(rendered).toContain('not a clean review');
    expect(rendered).toContain('Security: unparsed');
    expect(rendered).toContain('Data integrity: unparsed');
    expect(rendered).toContain('Findings: not parsed');
    expect(rendered).not.toMatch(/Findings: none/);
  });

  test('a verdict outside the closed set renders as a failed review too', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'approve',
      security: 'none found',
      data_integrity: 'none found',
      findings: [],
    }));
    expect(reviewReportIsUnparsed(report)).toBe(true);
    expect(formatReviewReport(report)).toContain(UNPARSED_REVIEW_LABEL);
  });

  test('a clean parsed report may say Findings: none', () => {
    const report = parseReviewReport(JSON.stringify({
      verdict: 'clean',
      security: 'none found',
      data_integrity: 'none found',
      findings: [],
    }));
    expect(reviewReportIsUnparsed(report)).toBe(false);
    const rendered = formatReviewReport(report);
    expect(rendered).not.toContain(UNPARSED_REVIEW_LABEL);
    expect(rendered).toContain('Findings: none');
  });

  test('listing suffix marks only an unparsed stored turn', () => {
    expect(formatUnparsedReviewSuffix({ review: parseReviewReport('prose') }))
      .toBe(` ${UNPARSED_REVIEW_LABEL}`);
    expect(formatUnparsedReviewSuffix({
      review: parseReviewReport(JSON.stringify({
        verdict: 'clean',
        security: 'none found',
        data_integrity: 'none found',
        findings: [],
      })),
    })).toBe('');
    expect(formatUnparsedReviewSuffix({})).toBe('');
  });
});

describe('chooseReviewReport — the ONE re-ask (§8.0)', () => {
  const parsed = (verdict: string, findings: unknown[] = []) => parseReviewReport(JSON.stringify({
    verdict,
    security: 'none found',
    data_integrity: 'none found',
    findings,
  }));

  test('a first reply that resolves is kept, and the re-ask is not consulted', () => {
    const first = parsed('needs_work', [
      { severity: 'low', category: 'style', summary: 'nit' },
    ]);
    const { report, usedReask } = chooseReviewReport(first, parsed('clean'));
    expect(usedReask).toBe(false);
    expect(report).toBe(first);
  });

  // INVARIANT: the re-ask's answer replaces the first one ONLY when it actually
  // resolves to a verdict. The re-ask asks a narrow question ("send the JSON
  // block alone"), so a reply that still will not say one of the three words
  // must not overwrite whatever the reviewer did manage to record.
  test('an unresolvable first reply is replaced by a re-ask that resolves', () => {
    const first = parseReviewReport('I think this is fine, honestly.');
    const second = parsed('needs_work', [
      { severity: 'high', category: 'correctness', summary: 'the retry path swallows errors' },
    ]);
    const { report, usedReask } = chooseReviewReport(first, second);
    expect(usedReask).toBe(true);
    expect(report).toBe(second);
    expect(report.findings).toHaveLength(1);
  });

  test('a re-ask that also fails leaves the first report standing — a FAILED review', () => {
    const first = parseReviewReport('Looks good to me.');
    const { report, usedReask } = chooseReviewReport(first, parseReviewReport('Still looks good!'));
    expect(usedReask).toBe(false);
    expect(report).toBe(first);
    expect(resolveReviewVerdict(report)).toBe('unparsed');
  });

  test('no re-ask at all leaves the first report standing', () => {
    const first = parseReviewReport('Prose only.');
    expect(chooseReviewReport(first, undefined)).toEqual({ report: first, usedReask: false });
  });

  // A re-ask cannot launder a MISSING sweep statement into a pass either: the
  // sweeps are part of the contract, so a "clean" with no security line still
  // resolves unparsed and the first report stands.
  test('a re-ask missing the required sweeps does not resolve', () => {
    const first = parseReviewReport('Prose only.');
    const second = parseReviewReport('{"verdict":"clean","findings":[]}');
    expect(chooseReviewReport(first, second).usedReask).toBe(false);
  });
});

describe('the re-ask TRIGGER (§8.0)', () => {
  // INVARIANT: the supervisor decides whether to re-ask with the SAME predicate
  // the daemon fails a review by — `resolveReviewVerdict` — never with the
  // verdict word alone (`parseVerdictText(report.verdict)`).
  //
  // The two disagree on exactly one shape, and it is the cheapest failure there
  // is to recover from: a reviewer that emits a well-formed verdict but forgets
  // a required sweep statement. Gating on the word let that case skip the
  // recovery entirely — no re-ask ran, the review was recorded FAILED, accept
  // was gated with findings nobody could resolve, and the park reason claimed
  // "even after the one re-ask" about a re-ask that never happened.
  //
  // `src/supervisor/index.ts` (handleReviewCommand) must keep using the
  // resolver. If it is reverted to the verdict word, the first case below is
  // what stops being re-asked.
  const triggersReask = (text: string) => resolveReviewVerdict(parseReviewReport(text)) === 'unparsed';

  test('a well-formed verdict with a MISSING sweep still triggers the re-ask', () => {
    const missingSecurity = '{"verdict":"clean","data_integrity":"none found","findings":[]}';
    // The verdict WORD parses — which is precisely why the narrow predicate
    // missed it — but the report as a whole does not.
    expect(parseVerdictText(parseReviewReport(missingSecurity).verdict)).toBe('clean');
    expect(triggersReask(missingSecurity)).toBe(true);

    const missingBoth = '{"verdict":"needs_work","findings":[]}';
    expect(parseVerdictText(parseReviewReport(missingBoth).verdict)).toBe('needs_work');
    expect(triggersReask(missingBoth)).toBe(true);
  });

  test('an unreadable verdict word triggers it too', () => {
    expect(triggersReask('{"verdict":"approve","security":"none found","data_integrity":"none found","findings":[]}')).toBe(true);
    expect(triggersReask('Seems fine to me.')).toBe(true);
  });

  test('a complete, well-formed report triggers nothing', () => {
    expect(triggersReask('{"verdict":"clean","security":"none found","data_integrity":"none found","findings":[]}')).toBe(false);
    expect(triggersReask('{"verdict":"needs_work","security":"none found","data_integrity":"none found","findings":[{"summary":"x"}]}')).toBe(false);
  });
});

describe('describeFailedReview — why a FAILED review failed', () => {
  const failed = (verdict: string): ReviewReport => ({
    verdict,
    security: 'unparsed',
    data_integrity: 'unparsed',
    findings: [],
  });

  // INVARIANT: two failures wear the same `unparsed` verdict and call for
  // OPPOSITE decisions, so the explanation must tell them apart. A loop reads
  // this sentence and acts on it under step 5 of its contract: a reviewer that
  // CRASHED never read the work, so it should be retried; one that replied but
  // would not produce a usable verdict HAS read the work, so the loop should
  // decide on the child's own report and diff instead.
  //
  // Saying "even after the one re-ask" about a crash is also a guessed cause
  // inside a message whose only job is the cause — no re-ask can run when there
  // was no reply to re-ask about.
  test('a crashed reviewer is reported as not having finished, with the error', () => {
    const reason = describeFailedReview(
      failed('FAILED: the reviewer did not finish — API Error: 500 upstream unavailable'),
    );
    expect(reason).toContain('the reviewer did not finish');
    expect(reason).toContain('API Error: 500 upstream unavailable');
    expect(reason).toContain('No re-ask was possible');
    // The wrong story must not appear.
    expect(reason).not.toContain('even after the one re-ask');
    expect(reason).not.toContain('FAILED to parse');
  });

  test('a reviewer that replied unusably is reported as a parse failure after the re-ask', () => {
    const reason = describeFailedReview(failed('approve with minor nits'));
    expect(reason).toContain('FAILED to parse');
    expect(reason).toContain('even after the one re-ask');
    expect(reason).not.toContain('did not finish');
  });

  // The two producers of that prefix must agree: `recordReviewErrorTurn` stamps
  // it, this function reads it. One constant, so a reword cannot split them.
  test('reads the same prefix the crash path stamps', () => {
    expect(REVIEW_CRASH_VERDICT_PREFIX).toBe('FAILED:');
    expect(describeFailedReview(failed(`${REVIEW_CRASH_VERDICT_PREFIX} boom`)))
      .toContain('the reviewer did not finish — boom');
  });

  test('a report with no verdict at all degrades to the parse wording', () => {
    expect(describeFailedReview(undefined)).toContain('FAILED to parse');
  });
});

describe('describeReviewFailureShort — the one clause a refusal has room for', () => {
  const report = (verdict: string, over: Partial<ReviewReport> = {}): ReviewReport => ({
    verdict,
    security: 'unparsed',
    data_integrity: 'unparsed',
    findings: [],
    ...over,
  });

  // INVARIANT: it names the obstacle the RECORD names, never a guessed one.
  //
  // It used to return the fixed string "never started — its reviewer could not
  // be launched" for every `FAILED TO START:` report, which was true while a
  // failed dispatch was the only way to get one. There are now five: a pause
  // (task or project), a spent daily budget and a missing system credential
  // attempt no launch at all, so that sentence asserted a cause that had not
  // happened — in an accept refusal and on the web gate row, the two places a
  // person decides what to do next from. The remedy differs per obstacle, which
  // is the whole reason the gate says anything.
  test('a never-started review names its own obstacle', () => {
    const paused = report(undispatchedReviewVerdict(
      'auto-react is paused for this task',
      'Auto-turn budget exhausted (3/3)',
    ));
    expect(describeReviewFailureShort(paused)).toBe(
      'never started — auto-react is paused for this task',
    );
    // The wrong story, specifically: no launch was attempted.
    expect(describeReviewFailureShort(paused)).not.toContain('could not be launched');

    const budget = report(undispatchedReviewVerdict(
      'the daily auto-react budget is spent',
      'Daily auto-react budget exhausted (50/50)',
    ));
    expect(describeReviewFailureShort(budget)).toBe(
      'never started — the daily auto-react budget is spent',
    );

    // …and a dispatch that really was attempted still says so.
    const threw = report(undispatchedReviewVerdict(
      'the reviewer could not be launched',
      'docker daemon not running',
    ));
    expect(describeReviewFailureShort(threw)).toBe(
      'never started — the reviewer could not be launched',
    );
  });

  // The HEADLINE only: the detail is a budget count, a provider error or a
  // pause reason somebody typed, and this string goes into a one-line refusal.
  test('it carries the headline, not the detail', () => {
    const what = describeReviewFailureShort(report(undispatchedReviewVerdict(
      'auto-react is paused for this project',
      'Paused via lazy daemon auto-budget pause',
    )));
    expect(what).not.toContain('lazy daemon auto-budget pause');
  });

  // A record written before the two-part format existed has no separator. The
  // whole remainder is then the headline — degraded, never wrong.
  test('a record with no separator still reads as never started', () => {
    expect(describeReviewFailureShort(report(`${REVIEW_UNDISPATCHED_VERDICT_PREFIX} something`)))
      .toBe('never started — something');
    expect(describeReviewFailureShort(report(REVIEW_UNDISPATCHED_VERDICT_PREFIX)))
      .toBe('never started');
  });

  test('the other three failures keep their own sentences', () => {
    expect(describeReviewFailureShort(report(`${REVIEW_CRASH_VERDICT_PREFIX} boom`)))
      .toBe('did not complete — its reviewer never finished');
    expect(describeReviewFailureShort(report('approve')))
      .toContain('produced no readable security / data-integrity statement');
    expect(describeReviewFailureShort(report('approve', {
      security: 'none found',
      data_integrity: 'none found',
    }))).toBe('ended with the verdict "approve", which is not one of clean / needs_work / needs_human');
  });

  // The writer and the readers share one format, so a reword cannot split them.
  test('the headline round-trips through the composed verdict', () => {
    const verdict = undispatchedReviewVerdict('the wall', 'the specifics — with a dash in them');
    expect(verdict).toBe('FAILED TO START: the wall — the specifics — with a dash in them');
    expect(reviewNotRunHeadline(report(verdict))).toBe('the wall');
    // A report that is not one of these records has no headline at all.
    expect(reviewNotRunHeadline(report('clean'))).toBeNull();
  });
});

describe('chooseReviewReport — the re-ask must not eat the findings', () => {
  const findingsFor = (summaries: string[]) =>
    summaries.map((summary) => ({ severity: 'high', category: 'correctness', summary }));

  /** A reply that STATES its findings list — the key is present. */
  const full = (verdict: string, summaries: string[]) => parseReviewReply(JSON.stringify({
    verdict,
    security: 'none found',
    data_integrity: 'none found',
    findings: findingsFor(summaries),
  }));

  /** A reply that says nothing about findings — the key is absent. */
  const silent = (verdict: string) => parseReviewReply(JSON.stringify({
    verdict,
    security: 'none found',
    data_integrity: 'none found',
  }));

  const choose = (
    primary: ReturnType<typeof full>,
    reasked: ReturnType<typeof full>,
  ) => chooseReviewReport(primary.report, reasked.report, reasked.statesFindings);

  // INVARIANT: the re-ask corrects the VERDICT WORD. Findings the first reply
  // already parsed survive a re-ask that says nothing about them.
  //
  // This is the commonest shape the re-ask exists for — a complete, well-formed
  // report whose only defect is a verdict outside the closed set (six of the
  // nine spellings in the run this contract came from). The re-ask prompt asks
  // for the verdict and the sweeps, so a reviewer with nothing to add omits the
  // findings key. Taking the re-asked report wholesale then threw five parsed
  // findings away: the task parked on "needs_work but recorded no findings",
  // the fix turn got an empty brief, and a loop parent was handed a decision
  // with no evidence.
  test('carries the primary findings across when the re-ask says nothing about them', () => {
    const primary = full('request changes', ['retry swallows errors', 'no test for the empty case']);
    const reasked = silent('needs_work');

    const { report, usedReask } = choose(primary, reasked);
    expect(usedReask).toBe(true);
    // The verdict is the re-asked one — that is what was asked for…
    expect(resolveReviewVerdict(report)).toBe('needs_work');
    // …and the evidence is the primary's, intact and in order.
    expect(report.findings.map((f) => f.summary)).toEqual([
      'retry swallows errors',
      'no test for the empty case',
    ]);
  });

  // The re-ask wins when it DOES restate them: the reviewer did that
  // deliberately, and merging both would duplicate the ordinary case.
  test('a re-ask that restates findings replaces the primary set', () => {
    const primary = full('LGTM', ['stale one']);
    const reasked = full('needs_work', ['the one that matters']);

    const { report } = choose(primary, reasked);
    expect(report.findings.map((f) => f.summary)).toEqual(['the one that matters']);
  });

  // INVARIANT (engineer decision via raised item `b8b1d61a`): what decides is
  // the `findings` KEY, not the array's length. An EXPLICIT `"findings": []`
  // REPLACES the primary's list — that is how a reviewer withdraws findings it
  // no longer stands behind, and it is the only route there is.
  //
  // It replaced the opposite rule, which conflated an omitted array with an
  // empty one and so kept the findings either way. Under that rule the re-ask
  // prompt's invitation to say none of them stand named an action with no
  // effect: the implementer's next turn was briefed on a retracted finding, one
  // of the two auto-fix rounds went on work that did not exist, and accept
  // stayed gated on it.
  //
  // The permissive direction is preserved where it matters: silence still keeps
  // the findings (test above), and a `clean` verdict over findings that DID
  // carry over is still not clean (test below).
  test('an explicit empty findings array in the re-ask withdraws the primary findings', () => {
    const primary = full('request changes', ['the retry path swallows errors']);
    const reasked = full('clean', []);

    const { report, usedReask } = choose(primary, reasked);
    expect(usedReask).toBe(true);
    expect(report.findings).toEqual([]);
    expect(reviewIsClean(report)).toBe(true);
  });

  // INVARIANT: the safe default survives the withdrawal route. A reviewer that
  // says `clean` but does NOT state a list has retracted nothing — the findings
  // carry over, and a clean verdict over them is a self-contradiction the gate
  // must not read as a pass.
  test('a clean verdict with findings carried over is still not clean', () => {
    const primary = full('request changes', ['the retry path swallows errors']);
    const reasked = silent('clean');

    const { report } = choose(primary, reasked);
    expect(report.findings.map((f) => f.summary)).toEqual(['the retry path swallows errors']);
    expect(reviewIsClean(report)).toBe(false);
  });

  // The default is SILENCE, so a caller that has not been taught about the key
  // keeps findings rather than dropping them.
  test('the two-argument call keeps the primary findings', () => {
    const primary = full('request changes', ['keep me']);
    const { report } = chooseReviewReport(primary.report, full('needs_work', []).report);
    expect(report.findings.map((f) => f.summary)).toEqual(['keep me']);
  });

  // A `findings` key that is not a list is not a statement of one: the reviewer
  // meant something by it but produced nothing readable, and reading that as
  // "withdraw everything" is the direction this must not fail in.
  test('a non-array findings value does not withdraw anything', () => {
    const reasked = parseReviewReply(
      '{"verdict":"clean","security":"none found","data_integrity":"none found","findings":"none"}',
    );
    expect(reasked.statesFindings).toBe(false);

    const primary = full('request changes', ['still stands']);
    const { report } = choose(primary, reasked);
    expect(report.findings.map((f) => f.summary)).toEqual(['still stands']);
  });

  // INVARIANT: what counts is what SURVIVED the parse, not what was typed. An
  // array whose every entry was dropped is silence, not a withdrawal.
  //
  // This is the shape that would have re-opened the hole the rest of this
  // branch closes. `parseFindings` keeps an object entry only if it has a
  // non-empty `summary` or `title`, so a reviewer writing `description` /
  // `issue` / `message` — which models emit routinely — sends a non-empty array
  // that parses to nothing. Read as a deliberate list, the re-asked report is
  // taken wholesale and the turn records `needs_work` with zero findings; and
  // `reviewIssuesAwaitingWork` returns null for exactly that shape, because a
  // verdict that parsed with nothing outstanding is not a gate. Accept would
  // then pass work whose review HAD filed findings, with nothing anywhere
  // saying they existed.
  test('an array that parsed to nothing is silence, not a withdrawal', () => {
    const reasked = parseReviewReply(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [{ description: 'the retry path swallows errors', severity: 'high' }],
    }));
    expect(reasked.report.findings).toEqual([]);
    expect(reasked.statesFindings).toBe(false);

    const primary = full('request changes', ['the retry path swallows errors']);
    const { report } = choose(primary, reasked);
    expect(report.findings.map((f) => f.summary)).toEqual(['the retry path swallows errors']);
    // The gate the accept pre-flight reads, on the turn this would record.
    expect(reviewIssuesAwaitingWork([
      { sequence: 1, role: 'agent', turn_type: 'work' },
      { sequence: 2, role: 'agent', turn_type: 'review', review: report },
    ], [])).not.toBeNull();
  });

  // One readable entry is a list the reviewer can be held to: it replaces, and
  // the unreadable siblings are dropped by the ordinary parse policy.
  test('an array with one readable entry still replaces the list', () => {
    const reasked = parseReviewReply(JSON.stringify({
      verdict: 'needs_work',
      security: 'none found',
      data_integrity: 'none found',
      findings: [
        { description: 'dropped by the parser' },
        { summary: 'the one that still stands' },
      ],
    }));
    expect(reasked.statesFindings).toBe(true);

    const { report } = choose(full('request changes', ['stale one']), reasked);
    expect(report.findings.map((f) => f.summary)).toEqual(['the one that still stands']);
  });

  // The prompt is the reviewer's half of this contract; the parser is lazy's.
  // A prose copy that disagrees with the code is not a documentation bug, it is
  // a reviewer being told to do something that will not work.
  test('the re-ask prompt describes the rule the code performs', () => {
    // Omitting the key keeps the list…
    expect(reaskPrompt).toContain('omitting the key means "nothing to add"');
    // …stating one replaces it, and `[]` is how you withdraw.
    expect(reaskPrompt).toContain('The array you send REPLACES what');
    expect(reaskPrompt).toContain('"findings": []');
    // The wording that was wrong before this rule existed: it told the reviewer
    // an empty array could not retract anything, which is no longer true.
    expect(reaskPrompt).not.toContain('does NOT\nretract them');
    expect(reaskPrompt).not.toContain('an empty array cannot erase');
  });

  test('both empty stays empty — a clean re-ask is clean', () => {
    const { report } = choose(full('approve', []), full('clean', []));
    expect(resolveReviewVerdict(report)).toBe('clean');
    expect(report.findings).toEqual([]);
    expect(reviewIsClean(report)).toBe(true);
  });

  // Neither report is mutated — the turn records the primary as its CONTENT,
  // and a merge that wrote through would change what the reader is shown.
  test('merging does not mutate either input', () => {
    const primary = full('request changes', ['keep me']);
    const reasked = silent('needs_work');

    choose(primary, reasked);
    expect(reasked.report.findings).toEqual([]);
    expect(primary.report.findings).toHaveLength(1);
  });
});

describe('parseReviewReply — an absent findings key is not an empty one', () => {
  // INVARIANT: only the PARSE can tell "I filed no findings in this reply" from
  // "I am not talking about findings" — `report.findings` is `[]` for both. The
  // fact is carried out of the parser rather than re-derived, because the
  // re-ask's withdrawal route turns on exactly that distinction.
  test('reports whether the reply stated a findings array', () => {
    const stated = parseReviewReply(
      '{"verdict":"clean","security":"none found","data_integrity":"none found","findings":[]}',
    );
    expect(stated.statesFindings).toBe(true);
    expect(stated.report.findings).toEqual([]);

    const absent = parseReviewReply(
      '{"verdict":"clean","security":"none found","data_integrity":"none found"}',
    );
    expect(absent.statesFindings).toBe(false);
    expect(absent.report.findings).toEqual([]);
  });

  test('prose that parses to nothing states nothing', () => {
    expect(parseReviewReply('Looks fine to me.').statesFindings).toBe(false);
  });

  test('parseReviewReport is the same parse, minus the extra fact', () => {
    const text = '{"verdict":"needs_work","security":"none found","data_integrity":"none found","findings":[{"summary":"x"}]}';
    expect(parseReviewReport(text)).toEqual(parseReviewReply(text).report);
  });
});
