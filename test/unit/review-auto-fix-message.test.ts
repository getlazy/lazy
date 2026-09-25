/**
 * The message a review's findings reach the implementer as.
 *
 * THE CHANNEL CHANGED: findings used to be filed as Raises and this message
 * pointed at them; now the findings themselves are the brief. The message must
 * therefore carry their full text — there is no Raise to go and read — and must
 * invite push-back, because a fixer that disagrees answers in its response and
 * the next review either agrees or files it again.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildReviewAutoFixMessage,
  formatFindingForAutoFix,
  formatRaiseForAutoFix,
} from '../../src/review/auto-fix-message';
import type { RaisedItem } from '../../src/types';
import type { ReviewFinding } from '../../src/types/review-report';

function raise(partial: Partial<RaisedItem> & Pick<RaisedItem, 'id' | 'content'>): RaisedItem {
  return {
    task_id: 'task-1',
    blocking: true,
    created_at: 1,
    status: 'open',
    ...partial,
  };
}

const FINDINGS: ReviewFinding[] = [
  {
    severity: 'high',
    category: 'correctness',
    file: 'src/retry.ts',
    line: 42,
    summary: 'Retry swallows errors, so operators never see the failure.',
  },
  {
    severity: 'low',
    category: 'style',
    summary: 'Docs omit the new flag.',
  },
];

describe('buildReviewAutoFixMessage', () => {
  // INVARIANT: the findings' full text is IN the message. Nothing else carries
  // them — no Raise row exists to go and read — so a message that only counted
  // them would leave the fix turn with an empty brief.
  test('injects every finding in full, with its location', () => {
    const msg = buildReviewAutoFixMessage(FINDINGS);
    expect(msg).toContain('found 2 issues');
    expect(msg).toContain('Retry swallows errors, so operators never see the failure.');
    expect(msg).toContain('src/retry.ts:42');
    expect(msg).toContain('[high] correctness');
    expect(msg).toContain('Docs omit the new flag.');
    expect(msg).toContain('the change as a whole');
    expect(formatFindingForAutoFix(FINDINGS[0]!, 0)).toStartWith('1. [high] correctness');
  });

  // INVARIANT: the message must not send the fixer looking for Raises that do
  // not exist, and must not use web UI jargon an agent cannot act on.
  test('says findings are not Raises, and names no web UI tab', () => {
    const msg = buildReviewAutoFixMessage(FINDINGS);
    expect(msg).toContain('not Raises');
    expect(msg).not.toContain('Raised tab');
    expect(msg).not.toContain('lazy_raised_item_comment');
  });

  // Push-back is part of the contract: the fix turn may disagree in its
  // response, and the round cap bounds the argument.
  test('invites push-back in the response rather than silent compliance', () => {
    const msg = buildReviewAutoFixMessage(FINDINGS);
    expect(msg).toContain('wrong or out of scope');
    expect(msg).toContain('lazy_final');
  });

  // The ONE raise a reviewer may still file — the `needs_human` decision, or a
  // legacy review's findings — is listed after the findings, and THAT is what
  // the comment tool applies to.
  test('lists any Raises the review filed, with the comment instruction', () => {
    const msg = buildReviewAutoFixMessage(FINDINGS, [
      raise({
        id: 'aaaaaaaa-1111-1111-1111-111111111111',
        title: 'The goal contradicts itself',
        explanation: 'X and not-X cannot both hold.',
        content: 'The goal contradicts itself\n\nX and not-X cannot both hold.',
        blocking: true,
      }),
    ]);
    expect(msg).toContain('raised 1 item');
    expect(msg).toContain('The goal contradicts itself');
    expect(msg).toContain('X and not-X cannot both hold.');
    expect(msg).toContain('lazy_raised_item_comment');
    expect(msg).toContain('cannot dismiss');
    expect(formatRaiseForAutoFix(raise({
      id: 'aaaaaaaa-1111-1111-1111-111111111111',
      content: 'x',
    }), 0)).toContain('[aaaaaaaa]');
  });

  test('singular wording for one finding', () => {
    expect(buildReviewAutoFixMessage([FINDINGS[0]!])).toContain('found 1 issue.');
  });
});
