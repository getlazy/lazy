/**
 * The one definition of which system messages a bulk dismissal touches.
 *
 * Every Storage backend calls this, so "dismiss all like this" means the same
 * thing whichever store answers — and no client re-implements it: the CLI and
 * Teams send a filter, the daemon's store applies it. Zero imports beyond
 * types, so a backend can depend on it without a cycle.
 */

import type { SystemMessage, SystemMessageDismissFilter } from '../types';

/**
 * Validate a filter at the boundary: every field present must be a non-empty
 * string. A blank `source` matching nothing would be harmless; a blank
 * `titleContains` matching EVERYTHING would turn a typo into "dismiss all".
 */
export function parseSystemMessageDismissFilter(raw: unknown): SystemMessageDismissFilter {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('System message filter must be an object with optional source, title, titleContains.');
  }
  const filter: SystemMessageDismissFilter = {};
  for (const key of ['source', 'title', 'titleContains'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`System message filter field '${key}' must be a non-empty string.`);
    }
    filter[key] = value;
  }
  const unknown = Object.keys(raw).filter(k => !['source', 'title', 'titleContains'].includes(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown system message filter field(s): ${unknown.join(', ')}.`);
  }
  return filter;
}

/** Whether an OPEN message falls under `filter`. Dismissed ones never do. */
export function systemMessageMatchesFilter(message: SystemMessage, filter: SystemMessageDismissFilter): boolean {
  if (message.dismissed_at) return false;
  if (filter.source !== undefined && message.source !== filter.source) return false;
  if (filter.title !== undefined && message.title !== filter.title) return false;
  if (filter.titleContains !== undefined
    && !message.title.toLowerCase().includes(filter.titleContains.toLowerCase())) return false;
  return true;
}

/** The open message a repeat of `input` collapses into, if any. */
export function openRepeatOf(
  messages: SystemMessage[],
  input: { source: string; kind: string; title: string },
): SystemMessage | undefined {
  return messages.find(m =>
    !m.dismissed_at && m.source === input.source && m.kind === input.kind && m.title === input.title,
  );
}
