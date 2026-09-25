/**
 * "Since you last looked" — what happened on a task after the reviewer's last
 * intervention.
 *
 * WHY IT EXISTS
 * A reviewer who steps away and comes back has no cheap way to answer "what
 * moved while I was gone?". The review page shows the whole task: every turn,
 * every commit, every comment. That is the right record and the wrong summary.
 * This card is the summary — one compact list, every item a link into the
 * existing detail page, so re-entering a task costs a glance rather than a
 * scroll through history the reviewer already read.
 *
 * THE ANCHOR
 * "Since you last looked" is anchored on the LAST REVIEW CHUNK BOUNDARY —
 * `isChunkBoundary` from src/utils/turn-chunks.ts, the project's one predicate
 * for "a genuine human/builder review intervention". A boundary is a human-role
 * turn that was NOT authored by automation (not actor `supervisor`/`system`,
 * not `auto_triggered`), so an unblock, a start, or an ask opens a window while
 * a sync, a nudge, or a reconciler auto-resume does not.
 *
 * That is deliberately the same anchor the chunked task page and the TUI review
 * already use. The alternative reading — "since the last non-upstream-merge
 * commit" — answers a different question (what did the agent last WRITE, not
 * when did the human last LOOK) and would jump the window forward every time
 * the agent committed, hiding exactly the turns the reviewer came back for.
 * The commit side of the window is still filtered for merge commits
 * ({@link isUpstreamMergeCommit}) so an upstream sync's merge never shows up as
 * work the agent did.
 *
 * MERGE-COMMIT DETECTION IS BY MESSAGE, DELIBERATELY
 * A stored {@link Commit} carries `{sha, message, timestamp}` and no parent
 * count, so there is no structural way to spot a merge without shelling out to
 * git for every commit on every page render. Lazy writes every sync merge
 * itself, always as `Merge <branch>` / `Merge <branch> into <branch>`
 * (src/supervisor/merge.ts, src/git/operations.ts), so the message IS the
 * reliable signal here. A false positive costs one line in a summary card whose
 * full record is one click away.
 */

import type { Turn, Commit, Comment, JournalEntry, RaisedItem } from '../types';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';
import { escapeHtml } from './review-diff';
import { viewedCardHtml } from './viewed-cards';
import { raisedGateVocabulary } from '../raised/vocabulary';
import { timestampHtml } from './timestamps';

/** Everything the card needs, all of it already loaded by the page routes. */
export interface ReviewActivityInput {
  /** Session turns in sequence order, as `getSessionTurns` returns them. */
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
  journal: JournalEntry[];
  /** Everything the agent raised, blocking and non-blocking alike. */
  raisedItems: RaisedItem[];
}

/** What happened since the reviewer's last intervention. */
export interface ReviewActivity {
  /**
   * Timestamp of the anchoring intervention, or null when the session has never
   * had one (a task auto-started and worked without a human turn) — the window
   * is then the whole session, which is the correct answer for it.
   */
  since: number | null;
  /** One-line description of the anchor, for the card header. */
  anchorLabel: string | null;
  /** Agent turns after the anchor. */
  turns: Turn[];
  /** Commits after the anchor, upstream merges removed. */
  commits: Commit[];
  comments: Comment[];
  journal: JournalEntry[];
  raisedItems: RaisedItem[];
  /** True when nothing at all happened — the card says so in one line. */
  empty: boolean;
}

/**
 * Does this commit message read as a merge lazy itself made while syncing a
 * task with its parent? See the module header for why this is a message test.
 */
export function isUpstreamMergeCommit(message: string): boolean {
  return /^Merge\b/.test(message.trim());
}

/** Items created strictly after the anchor (everything, when there is none). */
function after<T extends { created_at: number }>(items: T[], since: number | null): T[] {
  if (since === null) return [...items];
  return items.filter((item) => item.created_at > since);
}

/**
 * Compute the "since you last looked" window. Pure — every input is already
 * loaded by the caller, so this is testable without storage.
 */
export function computeReviewActivity(input: ReviewActivityInput): ReviewActivity {
  const chunks = groupTurnsIntoChunks(input.turns);
  const last = chunks.length > 0 ? chunks[chunks.length - 1] : null;
  const boundary = last?.boundary ?? null;
  const since = boundary?.timestamp ?? null;

  // Turns in the last chunk minus the boundary itself: the boundary is what the
  // reviewer DID, not something that happened while they were away.
  const chunkTurns = last ? last.turns.filter((t) => t !== boundary) : [];
  const turns = chunkTurns.filter((t) => t.role === 'agent');

  const commits = input.commits.filter(
    (c) => (since === null || c.timestamp > since) && !isUpstreamMergeCommit(c.message),
  );

  const comments = after(input.comments, since);
  const journal = after(input.journal, since);
  const raisedItems = after(input.raisedItems, since);

  return {
    since,
    anchorLabel: boundary ? anchorLabelFor(boundary) : null,
    turns,
    commits,
    comments,
    journal,
    raisedItems,
    empty:
      turns.length === 0 &&
      commits.length === 0 &&
      comments.length === 0 &&
      journal.length === 0 &&
      raisedItems.length === 0,
  };
}

function anchorLabelFor(boundary: Turn): string {
  const who =
    boundary.actor === 'builder' ? 'the builder'
    : boundary.actor === 'agent' ? 'an agent'
    : 'you';
  return `since ${who} last acted, ${formatDate(boundary.timestamp)}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** First line of a body, trimmed to something that fits on one row. */
function oneLine(text: string, max = 100): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Journal labels strip a leading markdown heading so `# Chose X` reads as the title. */
function journalLabel(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return oneLine(first.replace(/^#+\s*/, ''));
}

function turnActivityLabel(turn: Turn): string {
  // Review turns store JSON. Name the verdict instead of dumping the payload
  // — the Reviews block on Summary is the structured view.
  if (turn.turn_type === 'review' && turn.review) {
    return `Review: ${turn.review.verdict}`;
  }
  return oneLine(turn.content) || 'agent turn';
}

/**
 * One row. WHEN is part of the row, not something behind a click: "since you
 * last looked" is a list of events, and an event with no time is half an
 * answer — the reader cannot tell a nudge from ten minutes ago from a turn
 * from yesterday.
 */
function item(label: string, bodyHtml: string, at: number): string {
  return `<li><span class="ra-kind">${escapeHtml(label)}</span> ${bodyHtml}` +
    ` <span class="ra-when">${timestampHtml(at)}</span></li>`;
}

/**
 * The card itself, rendered through the shared viewable-card mechanism so a
 * reviewer can tick it away exactly like any other card on the page. Its
 * content hash covers what it listed, so the card comes back unviewed the
 * moment something new happens.
 */
export function reviewActivityCardHtml(activity: ReviewActivity, taskId: string): string {
  const rows: string[] = [];
  // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw in
  // every /tasks/ link; only ids and anchors inside the path are escaped once.

  // The row's link text is the turn's own first line, which says nothing about
  // where the link LEADS — so the destination is named in the title. Same for
  // commits, whose rows are built the same way.
  for (const turn of activity.turns) {
    rows.push(item(
      `Turn #${turn.sequence}`,
      `<a href="/tasks/${escapeHtml(taskId)}/turns/${turn.sequence}" title="Open turn #${turn.sequence} in its chunk">` +
      `${escapeHtml(turnActivityLabel(turn))}</a>`,
      turn.timestamp,
    ));
  }
  for (const commit of activity.commits) {
    rows.push(item(
      commit.sha.substring(0, 8),
      `<a href="/tasks/${escapeHtml(taskId)}/commits/${encodeURIComponent(commit.id)}" title="Open commit ${escapeHtml(commit.sha.substring(0, 8))} on its own page">` +
      `${escapeHtml(oneLine(commit.message))}</a>`,
      commit.timestamp,
    ));
  }
  for (const raised of activity.raisedItems) {
    // The feed's left column is plain text, so it carries the vocabulary's
    // glyph and word rather than a badge — the same two words the badges use,
    // which the old `Raised` / `Raised (FYI)` pair was not.
    const gate = raisedGateVocabulary(raised.blocking);
    rows.push(item(
      `${gate.emoji} Raised (${gate.label})`,
      `<a href="/raised/${encodeURIComponent(raised.id)}" title="Open this raised item">` +
      `${escapeHtml(oneLine(raised.title ?? raised.content))}</a>`,
      raised.created_at,
    ));
  }
  for (const comment of activity.comments) {
    // Task notes (getTaskComments), not review-diff threads. They live on
    // the Turns tab; the folding slice will give each one a chunk home.
    rows.push(item(
      'Comment',
      `<a href="/tasks/${escapeHtml(taskId)}/turns#comment-${encodeURIComponent(comment.id)}" title="Open this comment on the Turns tab">` +
      `${escapeHtml(oneLine(comment.content))}</a>`,
      comment.created_at,
    ));
  }
  for (const entry of activity.journal) {
    rows.push(item(
      'Journal',
      `<a href="/tasks/${escapeHtml(taskId)}/turns#journal-${encodeURIComponent(entry.id)}" title="Open this journal entry on the Turns tab">` +
      `${escapeHtml(journalLabel(entry.content))}</a>`,
      entry.created_at,
    ));
  }

  const counts: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (activity.turns.length) counts.push(plural(activity.turns.length, 'turn'));
  if (activity.commits.length) counts.push(plural(activity.commits.length, 'commit'));
  if (activity.raisedItems.length) counts.push(plural(activity.raisedItems.length, 'raised item'));
  if (activity.comments.length) counts.push(plural(activity.comments.length, 'comment'));
  if (activity.journal.length) counts.push(plural(activity.journal.length, 'journal entry', 'journal entries'));

  const suffix = activity.anchorLabel ? ` — ${escapeHtml(activity.anchorLabel)}` : '';
  const headHtml = activity.empty
    ? `Since you last looked${suffix}`
    : `Since you last looked: ${escapeHtml(counts.join(', '))}${suffix}`;

  const bodyHtml = activity.empty
    ? `<p class="text-muted">Nothing has happened since you last looked.</p>`
    : `<ul class="ra-list">${rows.join('')}</ul>`;

  // The hash is taken over what the card SAYS, so ticking it off survives a
  // reload and comes undone the moment the list changes.
  const content = activity.empty ? 'empty' : rows.join('\n');

  return viewedCardHtml({
    key: 'since-last-looked',
    content,
    headHtml,
    bodyHtml,
    sectionClass: 'review-activity',
    id: 'since-last-looked',
  });
}
