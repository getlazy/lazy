/**
 * Build the unblock note delivered when Review auto-fix runs after a review
 * that found something.
 *
 * The findings ARE the feedback. They reach the implementer as the prompt of
 * its next work turn — the same channel a reviewing human's `lazy unblock`
 * uses — and no Raise exists for them, so there is nothing to comment on,
 * dismiss or resolve. The previous contract filed each finding as a Raise,
 * which cost two dead turns per round (the fixer's `lazy_final` was refused by
 * the reviewer's own blocking raise) and left a human triaging items for
 * defects that had already been fixed.
 *
 * Agents only see MCP tools — never web UI tabs — so the message says what to
 * do in the agent's own vocabulary and invites push-back: a finding the fixer
 * believes is wrong is answered in its response, and the next review either
 * accepts that or re-files. The round cap bounds the argument.
 */

import type { RaisedItem } from '../types';
import type { ReviewFinding } from '../types/review-report';
import { shortId } from '../task/identity';

/** One finding as it appears in the auto-fix NOTES block. */
export function formatFindingForAutoFix(finding: ReviewFinding, index: number): string {
  const where = finding.file
    ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`
    : 'the change as a whole';
  return `${index + 1}. [${finding.severity}] ${finding.category} — ${where}\n` +
    `   ${finding.summary.replace(/\n/g, '\n   ')}`;
}

/** One raise as it appears in the auto-fix NOTES block (the `needs_human` case, and legacy reports). */
export function formatRaiseForAutoFix(item: RaisedItem, index: number): string {
  const id = shortId(item.id);
  const gate = item.blocking ? 'blocking' : 'non-blocking';
  const title = (item.title?.trim() || item.content.split('\n')[0]?.trim() || '(untitled)')
    .slice(0, 120);
  const bodyParts: string[] = [];
  if (item.explanation?.trim()) {
    bodyParts.push(item.explanation.trim());
  } else if (item.title?.trim()) {
    const rest = item.content.trim();
    if (rest && rest !== item.title.trim()) bodyParts.push(rest);
  } else {
    const lines = item.content.split('\n');
    const rest = lines.slice(1).join('\n').trim();
    if (rest) bodyParts.push(rest);
  }

  const head = `${index + 1}. [${id}] (${gate}) ${title}`;
  if (bodyParts.length === 0) return head;
  return `${head}\n${bodyParts.map((p) => p.replace(/^/gm, '   ')).join('\n')}`;
}

/**
 * Full message passed to `launchUnblockTask` after a review that found
 * something. Findings first (they are this round's work); any Raises the
 * review filed follow, because those are decisions rather than fixes.
 */
export function buildReviewAutoFixMessage(
  findings: ReviewFinding[],
  raises: RaisedItem[] = [],
): string {
  const n = findings.length;
  // Never claim findings that are not there. An empty list with raises present
  // is the `needs_human` shape, and "found 0 issues — fix each one below" is
  // both false and unactionable; the agent would go looking for a list that
  // does not exist.
  const header = n > 0
    ? `The automatic review of your work found ${n} issue${n === 1 ? '' : 's'}. ` +
      `Fix each one below, then declare the work done again with lazy_final — ` +
      `a fresh review runs on what you land. ` +
      `If you believe a finding is wrong or out of scope, say so plainly in your ` +
      `response with your reasoning and move on; the next review either agrees ` +
      `or files it again. These findings are not Raises: there is nothing to ` +
      `comment on, dismiss or resolve.`
    : `The automatic review of your work recorded no findings to fix. ` +
      `Read what it did leave below, handle anything that applies, and declare ` +
      `the work done again with lazy_final.`;

  const blocks: string[] = [header];
  if (findings.length > 0) {
    blocks.push(findings.map((f, i) => formatFindingForAutoFix(f, i)).join('\n\n'));
  }
  if (raises.length > 0) {
    blocks.push(
      `The review also raised ${raises.length} item${raises.length === 1 ? '' : 's'} for a ` +
      `human decision. You cannot dismiss or resolve a Raise; record how you handled it ` +
      `with lazy_raised_item_comment.`,
    );
    blocks.push(raises.map((r, i) => formatRaiseForAutoFix(r, i)).join('\n\n'));
  }
  return blocks.join('\n\n');
}
