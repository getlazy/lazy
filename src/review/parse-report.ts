/**
 * Parse an agent review response into a {@link ReviewReport}.
 *
 * The prompt asks for a JSON object (optionally in a ```json fence). A review
 * that produced only prose still becomes a report: verdict is the raw text,
 * and the two required statements are `"unparsed"` so a missing sweep cannot
 * look like a clean bill of health.
 *
 * FINDINGS ARE NEVER DROPPED. They are the issue store now — a finding is the
 * feedback the fixer's next turn is launched with — so a malformed one is
 * repaired, not discarded: an unknown or missing `severity`/`category` falls
 * back to `medium` / `correctness` rather than deleting the finding. Only a
 * finding with no summary at all is skipped, because there is nothing left of
 * it to deliver. Silently dropping one used to cost only a forge comment; it
 * now costs the fix itself.
 */

import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewFindingSeverity,
  type ReviewReport,
} from '../types/review-report';
import { resolveReviewVerdict, reviewVerdictLabel } from './verdict';

const UNPARSED = 'unparsed';

const CATEGORY_SET = new Set<string>(REVIEW_FINDING_CATEGORIES);
const SEVERITY_SET = new Set<string>(REVIEW_FINDING_SEVERITIES);

/** The statement stored when the agent did not produce parseable JSON. */
export const REVIEW_UNPARSED = UNPARSED;

/** Banner every surface uses so an unparsed report cannot look like a pass. */
export const UNPARSED_REVIEW_LABEL = 'FAILED REVIEW (unparsed)';

/**
 * True when the report FAILED to parse — either required statement missing, or
 * a verdict outside the closed set (src/review/verdict.ts). Silence is not a
 * pass, and neither is a verdict nobody can act on.
 */
export function reviewReportIsUnparsed(report: ReviewReport): boolean {
  if (report.security === UNPARSED || report.data_integrity === UNPARSED) return true;
  return resolveReviewVerdict(report) === UNPARSED;
}

/**
 * Human-readable report. An unparsed review is a failed review: never
 * "Findings: none", never a clean verdict line with no warning.
 */
export function formatReviewReport(report: ReviewReport): string {
  const lines: string[] = [];
  const unparsed = reviewReportIsUnparsed(report);
  if (unparsed) {
    lines.push(UNPARSED_REVIEW_LABEL);
    lines.push(
      'The reviewer did not produce a parseable security/data-integrity statement, ' +
      'or its verdict was not one of clean / needs_work / needs_human.',
    );
    lines.push('This is not a clean review. Silence is not a pass.');
    lines.push('');
  }
  lines.push(`Verdict: ${report.verdict} (${reviewVerdictLabel(resolveReviewVerdict(report))})`);
  lines.push(`Security: ${report.security}`);
  lines.push(`Data integrity: ${report.data_integrity}`);
  if (report.findings.length === 0) {
    // A failed review's EMPTY findings list is not a clean bill of health —
    // the list itself may be what failed to parse. Say so instead of "none".
    lines.push('', unparsed ? 'Findings: not parsed (do not treat as none)' : 'Findings: none');
    return lines.join('\n');
  }
  lines.push('', `Findings (${report.findings.length}):`);
  for (const finding of report.findings) {
    const where = finding.file
      ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`
      : '(change as a whole)';
    lines.push(`  [${finding.severity}] ${finding.category}  ${where}\n    ${finding.summary}`);
  }
  return lines.join('\n');
}

/** Listing suffix when a stored turn's report failed to parse. Empty otherwise. */
export function formatUnparsedReviewSuffix(turn: { review?: ReviewReport }): string {
  return turn.review && reviewReportIsUnparsed(turn.review) ? ` ${UNPARSED_REVIEW_LABEL}` : '';
}

/**
 * One reply, parsed: the report, plus whether the reply STATED a findings list
 * of its own.
 *
 * The second half exists for the verdict re-ask and nowhere else. A re-ask
 * answers a narrow question, so a reply that leaves `findings` out means
 * "nothing to add" and the first reply's findings carry over
 * (`chooseReviewReport`). Until this flag existed that carry-over keyed on the
 * LIST BEING EMPTY, which made an explicit `"findings": []` indistinguishable
 * from an omitted one — and with the two conflated, a reviewer that re-read the
 * code and concluded its finding was wrong had no way to say so: the prompt
 * told it to, the parser kept the finding anyway, and the implementer got a
 * brief for work that did not exist.
 *
 * An empty array is a STATEMENT ("these are the findings that stand: none") and
 * an absent key is silence. Only the parse can tell them apart, because
 * `ReviewReport.findings` is `[]` either way — so the fact is carried out from
 * here rather than re-derived later.
 *
 * A `findings` key the reviewer MEANT something by, but which produced no list
 * this parser can read, is NOT a statement either. Two shapes reach that: a
 * value that is not an array at all, and — the dangerous one — an array whose
 * every entry was dropped. `parseFindings` keeps an object entry only if it
 * carries a non-empty `summary` or `title`, so a reviewer writing `description`
 * / `issue` / `message`, which models emit routinely, hands over a non-empty
 * array that parses to nothing.
 *
 * Reading THAT as a deliberate withdrawal is how this flag could have re-opened
 * the exact hole the rest of this branch closes: the re-asked report is taken
 * wholesale, so the turn records `needs_work` with zero findings — and
 * `reviewIssuesAwaitingWork` returns null for that shape, because a verdict
 * that parsed with nothing outstanding is not a gate. Accept would then pass on
 * work whose review had filed findings nobody ever saw, with nothing anywhere
 * recording that they existed.
 *
 * So the rule is what SURVIVED, not what was typed: an empty array states a
 * list (the engineer's key-not-length decision — `[]` withdraws), and so does
 * an array at least one entry of which parsed. Anything else is silence, and
 * silence keeps the primary's findings.
 */
export interface ParsedReviewReply {
  report: ReviewReport;
  /**
   * True when the reply STATED a findings list: an empty `findings` array, or
   * one that yielded at least one readable finding.
   */
  statesFindings: boolean;
}

/**
 * Turn the agent's final message into a {@link ReviewReport}.
 *
 * Never throws — a broken or missing JSON block is a degraded report, not a
 * failed turn. The raw text stays on the turn's `content`; this is the
 * structured sibling the PR-comment task will read.
 */
export function parseReviewReport(text: string): ReviewReport {
  return parseReviewReply(text).report;
}

/** {@link parseReviewReport}, plus the findings-key fact only the parse knows. */
export function parseReviewReply(text: string): ParsedReviewReply {
  const raw = text ?? '';
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { report: unparsedReport(raw), statesFindings: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { report: unparsedReport(raw), statesFindings: false };
  }

  if (!isPlainObject(parsed)) {
    return { report: unparsedReport(raw), statesFindings: false };
  }

  const verdict = nonEmptyString(parsed.verdict) ?? UNPARSED;
  const security = nonEmptyString(parsed.security) ?? UNPARSED;
  const dataIntegrity =
    nonEmptyString(parsed.data_integrity) ??
    nonEmptyString(parsed.dataIntegrity) ??
    UNPARSED;
  const findings = parseFindings(parsed.findings);

  return {
    report: {
      verdict,
      security,
      data_integrity: dataIntegrity,
      findings,
    },
    // Decided HERE because this is the only place that can see both halves —
    // the array the reviewer wrote and the findings that survived reading it.
    // A later caller sees one `[]` and cannot tell "none stand" from "none of
    // mine were readable"; see the interface docs for what that cost.
    statesFindings:
      Array.isArray(parsed.findings)
      && (parsed.findings.length === 0 || findings.length > 0),
  };
}

function unparsedReport(raw: string): ReviewReport {
  const trimmed = raw.trim();
  return {
    verdict: trimmed || UNPARSED,
    security: UNPARSED,
    data_integrity: UNPARSED,
    findings: [],
  };
}

function parseFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReviewFinding[] = [];
  for (const item of value) {
    // A finding may arrive as a bare string: the reviewer wrote a list of
    // sentences rather than objects. That is still feedback, and dropping it
    // loses a fix.
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) findings.push({ severity: 'medium', category: 'correctness', summary: text });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const summary = nonEmptyString(item.summary) ?? nonEmptyString(item.title);
    if (!summary) continue;
    // Repaired, never dropped — see the module header. The defaults are the
    // middle of each scale, so a malformed finding neither inflates nor
    // silences itself.
    const category = asCategory(item.category) ?? 'correctness';
    const severity = asSeverity(item.severity) ?? 'medium';
    const finding: ReviewFinding = { severity, category, summary };
    const file = nonEmptyString(item.file);
    if (file) finding.file = file;
    const line = asLine(item.line);
    if (line !== undefined) finding.line = line;
    findings.push(finding);
  }
  return findings;
}

function asCategory(value: unknown): ReviewFindingCategory | undefined {
  if (typeof value !== 'string') return undefined;
  return CATEGORY_SET.has(value) ? (value as ReviewFindingCategory) : undefined;
}

/**
 * INVARIANT: an unrecognised severity resolves to a GATING one (`high`), and
 * the lookup normalises case and surrounding whitespace first.
 *
 * Both halves exist because severity stopped being cosmetic. Once
 * `REVIEW_GATING_SEVERITIES` narrowed the accept gate to critical/high, a
 * reviewer writing `"Critical"`, `" high"` or `"blocker"` produced a finding
 * that silently could not hold a merge — the gate failing OPEN on nothing more
 * than a spelling. A gate may only fail closed, so an unreadable severity is
 * treated as serious and a human decides, rather than being quietly filed as a
 * nit nobody is shown.
 */
function asSeverity(value: unknown): ReviewFindingSeverity | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (SEVERITY_SET.has(normalized)) return normalized as ReviewFindingSeverity;
  // A non-empty string that is not one of ours is a severity the reviewer meant
  // and we cannot read — fail closed. An empty string carries no intent, so it
  // falls through to the caller's own default.
  return normalized ? 'high' : undefined;
}

function asLine(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : undefined;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Prefer a ```json fence; otherwise the first `{` … last `}` span. Either
 * may fail JSON.parse — the caller handles that.
 */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}
