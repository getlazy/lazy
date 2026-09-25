/**
 * Sentinel anchor for a task-level review ask — a question about the work as a
 * whole, not a specific diff line.
 *
 * Stored like any other review comment so threading, retry, withdraw and poll
 * reuse the same machinery. The file name is deliberately not a repo path.
 */

import type { ReviewCommentSide } from '../types';

export const TASK_LEVEL_REVIEW_FILE = '(task)';
export const TASK_LEVEL_REVIEW_LINE = 0;
export const TASK_LEVEL_REVIEW_SIDE: ReviewCommentSide = 'new';

/** Anchor fields for a new task-level thread or reply. */
export const TASK_LEVEL_REVIEW_ANCHOR = {
  file: TASK_LEVEL_REVIEW_FILE,
  line: TASK_LEVEL_REVIEW_LINE,
  side: TASK_LEVEL_REVIEW_SIDE,
} as const;

export function isTaskLevelReviewAnchor(file: string, line: number): boolean {
  return file === TASK_LEVEL_REVIEW_FILE && line === TASK_LEVEL_REVIEW_LINE;
}
