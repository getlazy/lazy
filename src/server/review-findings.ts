/**
 * Render a stored agent-review report for the task page.
 *
 * Presentation only: the daemon owns parsing. This module turns a
 * {@link ReviewReport} into HTML — verdict and the two required statements
 * first, then findings grouped by category, with file+line jump links into
 * the Changes tab. A review lives on the task; lazy posts none of it to a
 * PR/MR (engineer decision, 2026-09-21).
 *
 * An unparsed report is a failed review: never "Findings: none".
 */

import { escapeHtml, anchorDomId, fileSectionId } from './review-diff';
import { timestampHtml } from './timestamps';
import {
  reviewReportIsUnparsed,
  UNPARSED_REVIEW_LABEL,
} from '../review/parse-report';
import { successfulReviewTurnsOf } from '../review/success';
import {
  REVIEW_FINDING_CATEGORIES,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewReport,
} from '../types/review-report';

const CATEGORY_LABEL: Record<ReviewFindingCategory, string> = {
  security: 'Security',
  'data-integrity': 'Data integrity',
  correctness: 'Correctness',
  tests: 'Tests',
  incomplete: 'Incomplete',
  style: 'Style',
};

export interface ReviewFindingTurn {
  sequence: number;
  review: ReviewReport;
  /** When the review turn happened — rendered in the card head, no click. */
  createdAt?: number;
}

/** Jump target on the Changes tab for a finding's file (and line, when set). */
export function findingChangesHref(taskId: string, finding: ReviewFinding): string | null {
  if (!finding.file) return null;
  if (finding.line !== undefined) {
    return `/tasks/${taskId}/changes#${anchorDomId({
      file: finding.file,
      side: 'new',
      line: finding.line,
    })}`;
  }
  return `/tasks/${taskId}/changes#${fileSectionId(finding.file)}`;
}

function findingWhereHtml(taskId: string, finding: ReviewFinding): string {
  if (!finding.file) return '<span class="lz-finding-where">change as a whole</span>';
  const href = findingChangesHref(taskId, finding);
  const label = finding.line !== undefined
    ? `${finding.file}:${finding.line}`
    : finding.file;
  if (!href) return `<span class="lz-finding-where">${escapeHtml(label)}</span>`;
  return `<a class="lz-finding-where" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/**
 * One review's structured body: verdict, required statements, then findings.
 */
export function reviewReportHtml(
  taskId: string,
  report: ReviewReport,
  opts: { heading?: string; turnHref?: string; createdAt?: number } = {},
): string {
  const unparsed = reviewReportIsUnparsed(report);
  // When the review ran belongs in its heading: a Summary listing three
  // reviews with no times cannot be read in order without opening each one.
  const when = opts.createdAt
    ? ` <span class="lz-findings-when">${timestampHtml(opts.createdAt)}</span>`
    : '';
  const heading = opts.heading
    ? (opts.turnHref
      ? `<h3 class="lz-findings-head"><a href="${escapeHtml(opts.turnHref)}">${escapeHtml(opts.heading)}</a>${when}</h3>`
      : `<h3 class="lz-findings-head">${escapeHtml(opts.heading)}${when}</h3>`)
    : '';

  const banner = unparsed
    ? `<p class="lz-findings-unparsed">${escapeHtml(UNPARSED_REVIEW_LABEL)}. The reviewer's verdict was not one of clean / needs_work / needs_human, or a required security or data-integrity statement was missing. This is not a clean review.</p>`
    : '';

  const statements = `
    <dl class="lz-findings-statements">
      <div><dt>Verdict</dt><dd>${escapeHtml(report.verdict)}</dd></div>
      <div><dt>Security</dt><dd>${escapeHtml(report.security)}</dd></div>
      <div><dt>Data integrity</dt><dd>${escapeHtml(report.data_integrity)}</dd></div>
    </dl>`;

  // A FAILED review still SHOWS its findings. They are the issue store now —
  // what the fixer is handed — so hiding them because the verdict line was
  // unreadable would hide the only actionable part of the review. What stays
  // suppressed is "Findings: none", which on a failed report would be a
  // claim about something that may simply not have parsed.
  if (unparsed && report.findings.length === 0) {
    return `<article class="lz-findings-report lz-findings-failed">${heading}${banner}${statements}</article>`;
  }
  const groups = new Map<ReviewFindingCategory, ReviewFinding[]>();
  for (const cat of REVIEW_FINDING_CATEGORIES) groups.set(cat, []);
  for (const finding of report.findings) {
    groups.get(finding.category)?.push(finding);
  }

  const groupHtml: string[] = [];
  for (const cat of REVIEW_FINDING_CATEGORIES) {
    const items = groups.get(cat) ?? [];
    if (items.length === 0) continue;
    const rows = items.map((finding) =>
      `<li class="lz-finding lz-finding-${escapeHtml(finding.severity)}">
        <span class="lz-finding-sev">${escapeHtml(finding.severity)}</span>
        ${findingWhereHtml(taskId, finding)}
        <span class="lz-finding-summary">${escapeHtml(finding.summary)}</span>
      </li>`,
    ).join('');
    groupHtml.push(
      `<section class="lz-findings-group" data-category="${escapeHtml(cat)}">
        <h4>${escapeHtml(CATEGORY_LABEL[cat])}</h4>
        <ul>${rows}</ul>
      </section>`,
    );
  }

  const findingsBlock = groupHtml.length > 0
    ? groupHtml.join('')
    : '<p class="lz-findings-none">Findings: none</p>';

  const raiseIds = report.raised_item_ids ?? [];
  const raisesBlock = raiseIds.length > 0
    ? `<p class="lz-findings-raises"><a href="/tasks/${escapeHtml(taskId)}/raised">${raiseIds.length} raise${raiseIds.length === 1 ? '' : 's'}</a>` +
      ` · <a href="/tasks/${escapeHtml(taskId)}/reviews">Reviews</a></p>`
    : `<p class="lz-findings-raises"><a href="/tasks/${escapeHtml(taskId)}/reviews">Reviews</a></p>`;

  const cls = unparsed ? 'lz-findings-report lz-findings-failed' : 'lz-findings-report';
  return `<article class="${cls}">${heading}${banner}${statements}${raisesBlock}${findingsBlock}</article>`;
}

/**
 * Landing / Turns: every agent review turn, newest first.
 *
 * A turn without a stored report is skipped — those are the human half of
 * the exchange (`[system] Agent review…`), not findings.
 */
export function reviewFindingsSectionHtml(
  taskId: string,
  turns: ReviewFindingTurn[],
): string {
  if (turns.length === 0) return '';
  const cards = turns.map((turn) =>
    reviewReportHtml(taskId, turn.review, {
      heading: `Review · turn #${turn.sequence}`,
      turnHref: `/tasks/${taskId}/turns/${turn.sequence}`,
      createdAt: turn.createdAt,
    }),
  ).join('');
  return `<section class="lz-findings" id="lz-review-findings">
    <h2>Reviews</h2>
    ${cards}
  </section>`;
}

/** Agent review turns that count as successful reviews, newest first. */
export function reviewFindingTurnsOf(
  turns: Array<{ sequence: number; role: string; turn_type?: string; review?: ReviewReport; created_at?: number; timestamp?: number }>,
): ReviewFindingTurn[] {
  return successfulReviewTurnsOf(
    turns.map((t) => ({
      sequence: t.sequence,
      role: t.role,
      turn_type: t.turn_type,
      review: t.review,
      created_at: t.created_at ?? t.timestamp,
    })),
  ).map((t) => ({ sequence: t.sequence, review: t.review, createdAt: t.created_at }));
}
