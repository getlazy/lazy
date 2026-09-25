/**
 * Raised-item body shape — structured proposals vs plain single-field `content`.
 *
 * A structured item carries title + explanation + optional proposed task fields;
 * a plain one only has `content` (treated as title+explanation combined). Both
 * flavours exist for blocking and non-blocking items alike.
 */

import type { RaisedItem, RaisedItemInput } from '../types';
import {
  composeRaisedContent,
  raisedDisplayBody,
  raisedTitle,
  firstSentence,
  normalizeRaisedContent,
} from './title';

/** The proposal fields a normalized create input can carry. */
type NormalizedRaisedContent = Pick<RaisedItem, 'content'> &
  Pick<RaisedItem, 'title' | 'explanation' | 'proposed_code' | 'proposed_prompt' | 'options'>;

/** Normalize create input: bare string, `{ note }`, or structured proposal. */
export function normalizeRaisedCreateInput(
  input: string | RaisedItemInput,
): NormalizedRaisedContent {
  if (typeof input === 'string') {
    // Preserve newlines — collapsed form is only for dedupe, not storage
    const content = input.trim();
    if (!content) {
      throw new Error('Raised item requires a title or content');
    }
    return { content };
  }

  const title = input.title?.trim();
  const note = input.note?.trim() || input.content?.trim();
  const explanation = input.explanation?.trim();
  const proposed_code = input.proposed_code?.trim() || undefined;
  const proposed_prompt = input.proposed_prompt?.trim() || undefined;
  const options = input.options?.map((o) => o.trim()).filter(Boolean);

  const extras = {
    ...(proposed_code ? { proposed_code } : {}),
    ...(proposed_prompt ? { proposed_prompt } : {}),
    ...(options?.length ? { options } : {}),
  };

  if (title) {
    return {
      // INVARIANT: `title` and `content` are INDEPENDENT fields. A caller that
      // supplies both gets both stored verbatim — the title must never
      // overwrite the body. Composing unconditionally is what destroyed the
      // body of every structured item raised with a title AND content: the
      // agent's paragraphs were replaced by its own one-line headline at write
      // time, with no error anywhere. `content` is only DERIVED from
      // title+explanation when the caller gave no body of its own, because
      // storage requires a non-empty content.
      content: note || composeRaisedContent(title, explanation),
      title,
      ...(explanation ? { explanation } : {}),
      ...extras,
    };
  }

  if (!note) {
    throw new Error('Raised item requires a title or content');
  }

  // note is already trimmed; preserve newlines — collapsed form is only for dedupe
  return { content: note, ...extras };
}

/** Display title for listings — explicit title or first sentence of content. */
export function raisedDisplayTitle(item: RaisedItem, maxLen = 80): string {
  if (item.title?.trim()) {
    return raisedTitle(item.title, maxLen);
  }
  return raisedTitle(item.content, maxLen);
}

export { raisedDisplayBody, composeRaisedContent, firstSentence };

/**
 * Idempotency key for duplicate detection on one task.
 *
 * Covers `title` as well as `content`: now that a title no longer folds itself
 * into the body, two items that share a body but carry different headlines are
 * different items, and keying on the body alone would silently swallow the
 * second raise.
 */
export function raisedDedupeKey(item: Pick<RaisedItem, 'content' | 'title'>): string {
  const title = item.title?.trim();
  const body = normalizeRaisedContent(item.content);
  return title ? `${normalizeRaisedContent(title)}\u0000${body}` : body;
}

/** Whether this item carries an agent-authored task proposal. */
export function raisedHasProposal(item: RaisedItem): boolean {
  return Boolean(
    item.title?.trim()
    || item.proposed_code?.trim()
    || item.proposed_prompt?.trim(),
  );
}

/** Search haystack — all human-visible proposal fields. */
export function raisedSearchText(item: RaisedItem): string {
  return [
    item.content,
    item.title,
    item.explanation,
    item.proposed_code,
    item.proposed_prompt,
  ].filter(Boolean).join('\n');
}
