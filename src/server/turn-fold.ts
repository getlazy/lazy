/**
 * Fold comments and journal entries into the turn chunk they belong to,
 * by timestamp.
 *
 * A chunk is already "what happened after I last acted". Putting the
 * extras in the same window is what gives *Since you last looked* a real
 * `#` home on the Turns tab — a journal entry with no anchor is a dead
 * link from that card.
 *
 * Commits are NOT folded here: they nest under the agent/work turn that
 * produced them (see turn-commits.ts), so they read as that turn's work
 * rather than a loose note in the chunk.
 *
 * Window: `[first turn timestamp of chunk, first turn timestamp of next
 * chunk)`. The last chunk is `[start, ∞)`. Items earlier than the first
 * chunk land in the first chunk so they still render.
 *
 * When there are extras but no turns, we still return one synthetic
 * group so the anchors exist — `taskDetailHtml` unit tests render
 * journal/comments with an empty turn list.
 */

import type { Turn, Comment, JournalEntry } from '../types';
import { groupTurnsIntoChunks, type TurnChunk } from '../utils/turn-chunks';

export type FoldedKind = 'turn' | 'comment' | 'journal';

export interface FoldedTurn {
  kind: 'turn';
  timestamp: number;
  turn: Turn;
}

export interface FoldedComment {
  kind: 'comment';
  timestamp: number;
  comment: Comment;
}

export interface FoldedJournal {
  kind: 'journal';
  timestamp: number;
  journal: JournalEntry;
}

export type FoldedItem = FoldedTurn | FoldedComment | FoldedJournal;

export interface FoldedChunk {
  /** Null only for the extras-but-no-turns synthetic group. */
  chunk: TurnChunk | null;
  items: FoldedItem[];
}

export interface TurnFoldExtras {
  comments?: Comment[];
  journal?: JournalEntry[];
}

const KIND_ORDER: Record<Exclude<FoldedKind, 'turn'>, number> = {
  comment: 0,
  journal: 1,
};

function extrasList(extras: TurnFoldExtras | undefined): FoldedItem[] {
  if (!extras) return [];
  const out: FoldedItem[] = [];
  for (const comment of extras.comments ?? []) {
    out.push({ kind: 'comment', timestamp: comment.created_at, comment });
  }
  for (const journal of extras.journal ?? []) {
    out.push({ kind: 'journal', timestamp: journal.created_at, journal });
  }
  return out;
}

/**
 * Which chunk a timestamp belongs to. `starts` is the first-turn timestamp
 * of each chunk, in chunk order. Items before the first start go to 0.
 */
export function chunkIndexFor(timestamp: number, starts: number[]): number {
  if (starts.length === 0) return -1;
  if (timestamp < starts[0]!) return 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    if (timestamp >= starts[i]!) return i;
  }
  return 0;
}

function compareFolded(a: FoldedItem, b: FoldedItem): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  // Equal timestamp: turns stay in sequence order and render before extras
  // so a note stamped at the same ms as the turn still reads as "the turn,
  // then what it produced".
  if (a.kind === 'turn' && b.kind === 'turn') {
    return a.turn.sequence - b.turn.sequence;
  }
  if (a.kind === 'turn') return -1;
  if (b.kind === 'turn') return 1;
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  return foldedId(a).localeCompare(foldedId(b));
}

function foldedId(item: FoldedItem): string {
  switch (item.kind) {
    case 'turn':
      return String(item.turn.sequence);
    case 'comment':
      return item.comment.id;
    case 'journal':
      return item.journal.id;
  }
}

function sortItems(items: FoldedItem[]): FoldedItem[] {
  return [...items].sort(compareFolded);
}

/**
 * Build the folded record. Empty turns + empty extras → `[]` (the renderer
 * shows the empty-tab copy). Empty turns + extras → one synthetic group.
 */
export function foldRecordIntoChunks(turns: Turn[], extras?: TurnFoldExtras): FoldedChunk[] {
  const extraItems = extrasList(extras);
  const chunks = groupTurnsIntoChunks(turns);

  if (chunks.length === 0) {
    if (extraItems.length === 0) return [];
    return [{ chunk: null, items: sortItems(extraItems) }];
  }

  const starts = chunks.map((c) => c.turns[0]!.timestamp);
  const buckets: FoldedItem[][] = chunks.map((c) =>
    c.turns.map((turn): FoldedTurn => ({ kind: 'turn', timestamp: turn.timestamp, turn })),
  );

  for (const item of extraItems) {
    const idx = chunkIndexFor(item.timestamp, starts);
    if (idx < 0) continue;
    buckets[idx]!.push(item);
  }

  return chunks.map((chunk, i) => ({
    chunk,
    items: sortItems(buckets[i]!),
  }));
}
