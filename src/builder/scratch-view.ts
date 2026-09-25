/**
 * The read rules every web surface over the builder scratch store shares.
 *
 * The daemon dashboard calls these in-process; Lazy Teams reaches the same
 * functions through the `scratchList` / `scratchShow` / `scratchSearch` /
 * `scratchMentions` RPCs (src/daemon/rpc-handlers.ts). Each is an ANSWER, not a
 * rule for a client to re-apply: why a file has no stored body, which paths a
 * message mentions, how a scratch search is phrased — so the two UIs cannot
 * disagree about the same record.
 *
 * Read-only by construction. Removal stays `lazy scratch rm`.
 */

import type { Storage } from '../storage/interface';
import type { ScratchFile, ScratchSkipReason } from '../types';
import type { SearchResult } from '../storage/types';
import { executeSearch } from '../search/run';
import { MAX_SCRATCH_FILE_BYTES, MAX_SCRATCH_SANDBOX_BYTES, formatBytes } from './scratch-limits';

/** A captured file without its body — what a listing needs. */
export interface ScratchFileEntry {
  path: string;
  size: number;
  skipped?: ScratchSkipReason;
  /** Human sentence for `skipped`; absent for stored files. */
  skippedReason?: string;
  session_id?: string;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

/** Files of one builder session, path-ordered. `session_id` null = not recorded. */
export interface ScratchSessionGroup {
  session_id: string | null;
  /** Newest capture in the group — the order groups are listed in. */
  latest_at: number;
  files: ScratchFileEntry[];
}

/**
 * Why a file was recorded by name only. The record is the answer — a surface
 * must say this rather than render an empty body.
 */
export function describeScratchSkip(reason: ScratchSkipReason): string {
  switch (reason) {
    case 'too_large':
      return `Over the ${formatBytes(MAX_SCRATCH_FILE_BYTES)} per-file limit — recorded by name only.`;
    case 'binary':
      return 'Binary (not UTF-8 text) — recorded by name only.';
    case 'sandbox_full':
      return `Over the ${formatBytes(MAX_SCRATCH_SANDBOX_BYTES)} scratch budget — recorded by name only.`;
  }
}

export function scratchEntry(file: ScratchFile): ScratchFileEntry {
  return {
    path: file.path,
    size: file.size,
    ...(file.skipped ? { skipped: file.skipped, skippedReason: describeScratchSkip(file.skipped) } : {}),
    ...(file.session_id ? { session_id: file.session_id } : {}),
    created_at: file.created_at,
    updated_at: file.updated_at,
    updated_by: String(file.updated_by),
  };
}

/**
 * Group captured files by the builder session that last wrote them. Groups run
 * newest-first; files within a group sort by path. Files with no recorded
 * session form one trailing group.
 */
export function groupScratchBySession(files: ScratchFile[]): ScratchSessionGroup[] {
  const groups = new Map<string | null, ScratchSessionGroup>();
  for (const file of files) {
    const key = file.session_id ?? null;
    let group = groups.get(key);
    if (!group) {
      group = { session_id: key, latest_at: 0, files: [] };
      groups.set(key, group);
    }
    group.files.push(scratchEntry(file));
    group.latest_at = Math.max(group.latest_at, file.updated_at);
  }
  const list = [...groups.values()];
  for (const g of list) g.files.sort((a, b) => a.path.localeCompare(b.path));
  list.sort((a, b) => {
    if ((a.session_id === null) !== (b.session_id === null)) return a.session_id === null ? 1 : -1;
    return b.latest_at - a.latest_at;
  });
  return list;
}

/** The structured query a scratch search runs — `in:scratch "<text>"`. */
export function scratchSearchQuery(text: string): string {
  return `in:scratch "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One hit of a scratch search, with the file's listing entry when still captured. */
export interface ScratchSearchHit {
  path: string;
  match_context: string;
  file: ScratchFileEntry | null;
}

/** Search within captured scratch files, through the one search entry point. */
export async function searchScratch(storage: Storage, text: string): Promise<ScratchSearchHit[]> {
  const outcome = await executeSearch(storage, { query: scratchSearchQuery(text), types: ['scratch'] });
  const files = new Map((await storage.listScratchFiles()).map((f) => [f.path, f]));
  const seen = new Set<string>();
  const hits: ScratchSearchHit[] = [];
  for (const r of outcome.results as SearchResult[]) {
    if (seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    const file = files.get(r.entity_id);
    hits.push({ path: r.entity_id, match_context: r.match_context ?? '', file: file ? scratchEntry(file) : null });
  }
  return hits;
}

/**
 * Captured scratch paths a piece of text mentions — how a system message that
 * names `$LAZY_SCRATCH_DIR/review/accept-foo.md` (or an absolute path ending in
 * it, or the bare relative path) links to the file.
 *
 * A path counts only at a boundary: preceded by start, `/`, whitespace or
 * punctuation, and not followed by more path characters. So `a.md` never
 * matches inside `data.md`, nor `notes.md` inside `notes.md.bak`. Longest paths
 * first, in order of first appearance.
 */
export function scratchPathsMentionedIn(text: string, paths: string[]): string[] {
  const found: Array<{ path: string; at: number }> = [];
  // Spans already claimed by a longer path: `accept-foo.md` must not also match
  // inside a mention of `review/accept-foo.md`.
  const claimed: Array<[number, number]> = [];
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A trailing sentence period is allowed; `notes.md.bak` is not a mention of `notes.md`.
    const re = new RegExp(`(?:^|[\\s/\`'"(\\[<])(${escaped})(?![\\w/-]|\\.[\\w/-])`, 'g');
    let first: number | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index + m[0].length - m[1].length;
      const end = start + m[1].length;
      re.lastIndex = start + 1;
      if (claimed.some(([s, e]) => start >= s && end <= e)) continue;
      claimed.push([start, end]);
      if (first === null) first = start;
    }
    if (first !== null) found.push({ path, at: first });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.path);
}
