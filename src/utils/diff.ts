import { createPatch } from 'diff';
import type { Turn, Comment } from '../types';
import { runGit } from './git';

const COMMENT_PREFIX = '#';

export interface EditorFeedbackResult {
  /** Whether the user made any meaningful edits */
  hasChanges: boolean;
  /** The formatted feedback message to send to the LLM */
  feedbackText: string;
}

/**
 * Strips lines starting with the comment prefix from content.
 * Used to remove instruction headers from editor content before diffing.
 */
export function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .filter(line => !line.startsWith(COMMENT_PREFIX))
    .join('\n')
    .trim();
}

/**
 * Builds the initial content for the editor buffer.
 * Includes an instruction header (comment lines) followed by the agent's response.
 */
export function buildEditorContent(agentResponse: string, taskId?: string, goal?: string, remoteUrl?: string): string {
  const header = [
    ...(taskId ? [`# Task: ${taskId}`] : []),
    ...(goal ? [`# Goal: ${goal}`] : []),
    ...(remoteUrl ? [`# Remote: ${remoteUrl}`] : []),
    ...(taskId || goal ? ['#'] : []),
    '# Review the agent\'s response below and edit it to provide feedback.',
    '# - Add text to request additions',
    '# - Delete text to request removals',
    '# - Modify text to request changes',
    '# - Lines starting with # are ignored.',
    '# Save and close the editor when done. Save without changes to cancel.',
    '#',
    '',
  ].join('\n');

  return header + agentResponse;
}

/**
 * Builds editor content for when there is no previous agent turn.
 * Just instruction comments and an empty body for freeform feedback.
 */
export function buildFreeformEditorContent(taskId?: string, goal?: string, remoteUrl?: string): string {
  return [
    ...(taskId ? [`# Task: ${taskId}`] : []),
    ...(goal ? [`# Goal: ${goal}`] : []),
    ...(remoteUrl ? [`# Remote: ${remoteUrl}`] : []),
    ...(taskId || goal ? ['#'] : []),
    '# No previous agent response available.',
    '# Type your feedback below. Lines starting with # are ignored.',
    '# Save and close the editor when done.',
    '#',
    '',
  ].join('\n');
}

/**
 * Extracts feedback from the diff between the original editor content
 * and the user's edited version.
 *
 * IMPORTANT: originalEditorContent must be the EXACT content that was written
 * to the temp file before the editor opened — not a reconstruction. This
 * ensures that appended content (like code diffs) doesn't create false
 * positives when the user saves without making changes.
 *
 * Returns a formatted message suitable for sending to an LLM.
 */
export function extractFeedbackFromDiff(
  originalEditorContent: string,
  editedContent: string,
): EditorFeedbackResult {
  // Strip comment lines from both sides
  const original = stripCommentLines(originalEditorContent);
  const edited = stripCommentLines(editedContent);

  // If content is identical, no changes
  if (original === edited) {
    return { hasChanges: false, feedbackText: '' };
  }

  // Generate unified diff
  const patch = createPatch(
    'agent-response',
    original + '\n',
    edited + '\n',
  );

  const feedbackText = [
    'I reviewed your last response and made edits to indicate what should change.',
    'Here is a unified diff of my edits (- = remove/wrong, + = add/correct):',
    '',
    '```diff',
    patch,
    '```',
    '',
    'Please apply these changes to your approach and continue working.',
  ].join('\n');

  return { hasChanges: true, feedbackText };
}

// Markers used to delimit the notes section in editor content
const NOTES_SECTION_START = '# --- Unseen comments (edit or delete as needed) ---';
const NOTES_SECTION_END = '# --- End comments ---';

/**
 * Build the notes section for inclusion in editor content.
 * Comments are NOT #-prefixed so they survive comment-stripping and
 * become part of the content the agent sees.
 */
export function buildNotesSectionForEditor(comments: Comment[]): string {
  if (comments.length === 0) return '';

  const lines: string[] = [];
  lines.push(NOTES_SECTION_START);
  lines.push('');
  for (const comment of comments) {
    const dateStr = new Date(comment.created_at).toISOString().replace('T', ' ').substring(0, 19);
    lines.push(`[${dateStr}] ${comment.content.split('\n')[0]}`);
    // Include additional lines of multi-line comments
    const extraLines = comment.content.split('\n').slice(1);
    if (extraLines.length > 0) {
      lines.push(...extraLines);
    }
    lines.push('');
  }
  lines.push(NOTES_SECTION_END);
  return lines.join('\n');
}

/**
 * Builds editor content for freeform feedback (no agent turns) with notes.
 * Returns a pair: editorContent has real comments, comparisonContent has placeholder.
 */
export function buildFreeformEditorContentWithNotes(taskId?: string, goal?: string, notes?: Comment[], remoteUrl?: string): EditorContentPair {
  const base = buildFreeformEditorContent(taskId, goal, remoteUrl);
  if (!notes || notes.length === 0) {
    return { editorContent: base, comparisonContent: base };
  }
  return {
    editorContent: base + '\n' + buildNotesSectionForEditor(notes),
    comparisonContent: base + '\n' + NOTES_SECTION_START + '\n' + NOTES_SECTION_END,
  };
}

/**
 * Extract comment lines that survive in the edited content.
 * Parses the content between NOTES_SECTION_START and NOTES_SECTION_END markers
 * and returns non-empty, non-#-prefixed lines.
 *
 * Returns null if the notes section markers are absent (no notes were shown),
 * or an array of surviving comment lines (possibly empty if all were deleted).
 */
export function extractSurvivingNotes(editedContent: string): string[] | null {
  const startIdx = editedContent.indexOf(NOTES_SECTION_START);
  if (startIdx === -1) return null;

  const endIdx = editedContent.indexOf(NOTES_SECTION_END, startIdx);
  // If end marker was deleted, treat everything after start as notes section
  const sectionEnd = endIdx !== -1 ? endIdx : editedContent.length;

  const section = editedContent.substring(
    startIdx + NOTES_SECTION_START.length,
    sectionEnd,
  );

  return section
    .split('\n')
    .filter(line => line.trim() !== '' && !line.startsWith(COMMENT_PREFIX))
    .map(line => line.trim());
}

export interface TurnDiffResult {
  /** The unified diff text */
  diff: string;
  /** Number of files changed */
  filesChanged: number;
  /** Whether this is a fallback (full task diff instead of per-turn) */
  isFallback: boolean;
}

/**
 * Compute the git diff for a specific turn using its SHAs.
 * Excludes .lazy/ state files from the diff.
 *
 * Prefers start_sha_work..end_sha_work (agent work only, excluding sync merges).
 * Falls back to upstream_merge_sha..end_sha for older turns (excludes upstream changes).
 * Falls back to start_sha..end_sha if no upstream_merge_sha available.
 * Falls back to full task diff (fromRef..HEAD) if no SHAs available at all.
 */
export function getTurnDiff(
  turn: Turn,
  worktreePath: string,
  fallbackFromRef?: string,
  upstreamMergeSha?: string,
): TurnDiffResult | null {
  let fromSha: string;
  let toSha: string;
  let isFallback = false;

  if (turn.start_sha_work && turn.end_sha_work) {
    // Best case: use the work-only SHAs (excludes pre/post-turn sync merges)
    fromSha = turn.start_sha_work;
    toSha = turn.end_sha_work;
  } else if (turn.start_sha && turn.end_sha) {
    // Backward compat: older turns without work SHAs.
    // Use upstream_merge_sha if available to exclude upstream changes that were
    // merged during the turn. Otherwise fall back to start_sha (may include upstream).
    fromSha = upstreamMergeSha ?? turn.start_sha;
    toSha = turn.end_sha;
  } else if (fallbackFromRef) {
    fromSha = fallbackFromRef;
    toSha = 'HEAD';
    isFallback = true;
  } else {
    return null;
  }

  // Get the diff excluding .lazy/ directory.
  // Use three-dot diff for the fallback case (branch ref vs HEAD) to exclude
  // upstream changes merged into the task branch. Specific SHA-to-SHA cases
  // use two-dot because those are concrete commits on the same branch.
  const diffRange = isFallback ? `${fromSha}...${toSha}` : `${fromSha}..${toSha}`;
  const result = runGit(
    ['diff', '--no-color', diffRange, '--', '.', ':!.lazy*'],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0) {
    return null;
  }

  const fullDiff = result.stdout;
  if (!fullDiff.trim()) {
    return { diff: '', filesChanged: 0, isFallback };
  }

  // Count files changed
  const filesChanged = (fullDiff.match(/^diff --git /gm) || []).length;

  return { diff: fullDiff, filesChanged, isFallback };
}

export interface EditorContentPair {
  /** Content shown to the human in the editor (includes real comments) */
  editorContent: string;
  /** Content used as the diff baseline (comments replaced by # placeholder) */
  comparisonContent: string;
}

/**
 * Build editor content that includes the agent's response, any notes added
 * since the last turn, and the turn's code diff.
 *
 * Returns two versions:
 * - editorContent: what the human sees (real comments as non-# text)
 * - comparisonContent: what we diff against (comments area is a # placeholder)
 *
 * This means when extractFeedbackFromDiff strips # lines and compares:
 * - No edit → diff shows comments as additions (they ARE the feedback)
 * - Human deletes comments → diff is clean (no changes)
 * - Human edits comments → diff shows edited comments
 */
export function buildEditorContentWithDiff(
  agentResponse: string,
  turnDiff: TurnDiffResult | null,
  taskId?: string,
  goal?: string,
  notes?: Comment[],
  remoteUrl?: string,
): EditorContentPair {
  const base = buildEditorContent(agentResponse, taskId, goal, remoteUrl);
  const editorParts: string[] = [base];
  const comparisonParts: string[] = [base];

  // Comments section: editor gets real comments, comparison gets # placeholder
  if (notes && notes.length > 0) {
    editorParts.push('\n\n' + buildNotesSectionForEditor(notes));
    comparisonParts.push('\n\n' + NOTES_SECTION_START + '\n' + NOTES_SECTION_END);
  }

  // Diff section (same in both versions — it's # prefixed via the section header
  // and the raw diff lines aren't # prefixed but they're identical in both)
  if (turnDiff && turnDiff.diff.trim()) {
    const fileLabel = turnDiff.filesChanged === 1
      ? '1 file'
      : `${turnDiff.filesChanged} files`;

    const diffHeader = turnDiff.isFallback
      ? `\n\n# ─── Changes (full task diff — per-turn diff unavailable) (${fileLabel}) ───\n`
      : `\n\n# ─── Changes this turn (${fileLabel}) ───\n`;

    editorParts.push(diffHeader);
    editorParts.push(turnDiff.diff);
    comparisonParts.push(diffHeader);
    comparisonParts.push(turnDiff.diff);
  }

  return {
    editorContent: editorParts.join(''),
    comparisonContent: comparisonParts.join(''),
  };
}
