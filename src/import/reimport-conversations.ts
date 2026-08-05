/**
 * Built-in recovery: re-import builder conversations from every candidate
 * Claude projects dir into the conversation store.
 *
 * WHY: builder conversation capture was silently broken for weeks (see task
 * `fix-conversation-capture`) — the in-container supervisor wrote captures to an
 * unmounted storage path, so nothing reached the store. The raw session JSONLs,
 * however, still exist on the host in two places:
 *   1. the shared `~/.claude/projects/<encoded-cwd>/` dir, and
 *   2. the per-builder isolation dirs under `<data>/builder-projects/<id>/`
 *      (see src/builder/projects-isolation.ts for the layout).
 *
 * This module scans ALL of those roots, dedupes sessions (the same session is
 * seeded into many isolation dirs, so it can appear repeatedly — we keep the
 * largest/newest copy), parses each with the EXISTING capture/import machinery
 * (parseConversation), skips sessions already in the store (idempotent), and
 * persists through the Storage interface. It never writes store files directly —
 * the caller hands it a daemon-backed Storage.
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import {
  discoverProjectSessionFiles,
  parseConversation,
  extractSummary,
  conversationStats,
  type SessionFileInfo,
} from './claude-code-logs';
import { toStoredConversation } from './conversation-storage';
import { isMachineOneshotSessionFile } from './machine-oneshot';
import { builderProjectsRoot } from '../builder/projects-isolation';
import type { Storage } from '../storage/interface';
import { getHome } from '../utils/home';

/** A discovered session file annotated with the projects-dir root it lives in. */
export interface CandidateSession extends SessionFileInfo {
  /**
   * Root that holds `<projectPath>/<sessionId>.jsonl` — the shared
   * `~/.claude/projects` dir or a `<data>/builder-projects/<id>` isolation dir.
   * Passed to parseConversation so the file is read from where it actually is.
   */
  projectsDirRoot: string;
}

export interface ReimportOptions {
  /** Repo root — its encoded form is the projects subdir name we match. */
  lazyRoot: string;
  /** Absolute data dir (`<root>/<config.data.path>`) holding builder-projects/. */
  dataDirAbs: string;
  /** Host home holding the shared ~/.claude/projects dir. Injectable for tests. */
  homeDirAbs?: string;
}

/**
 * Collect every projects-dir-shaped root to scan for this project: the shared
 * host `~/.claude/projects` dir plus every per-builder isolation dir. Missing
 * roots are simply omitted — a fresh machine may have neither.
 */
export async function collectProjectsDirRoots(opts: ReimportOptions): Promise<string[]> {
  const { dataDirAbs, homeDirAbs = getHome() } = opts;
  const roots: string[] = [join(homeDirAbs, '.claude', 'projects')];

  const isolationRoot = builderProjectsRoot(dataDirAbs);
  let children: string[] = [];
  try {
    children = await readdir(isolationRoot);
  } catch {
    // No isolation root yet (isolation never ran, or was pruned) — only the
    // shared dir contributes. Normal on many machines.
    children = [];
  }
  for (const child of children) {
    roots.push(join(isolationRoot, child));
  }
  return roots;
}

/** Discovery split into what capture wants and what it deliberately ignores. */
export interface PartitionedCandidateSessions {
  /** Real conversations — the sessions every capture surface acts on. */
  capturable: CandidateSession[];
  /**
   * Machine-generated lazy one-shots (fidelity summaries, `lazy report` units,
   * LLM memory compaction). Deliberately excluded from capture, reimport, and
   * doctor's uncaptured count — reported here only so callers can say how many
   * they skipped rather than silently dropping them.
   */
  machineOneshots: CandidateSession[];
}

/**
 * Discover all recoverable sessions across every candidate root, deduped by
 * sessionId, and split off the machine-generated one-shots.
 *
 * When the same session appears in several roots (seeding copies it into each
 * isolation dir) we keep the copy with the most content — the largest size,
 * breaking ties on the newest mtime. That copy is the most complete transcript
 * of the run.
 *
 * The one-shot split happens HERE, after dedupe, so that every consumer —
 * the daemon capture sweep, `lazy doctor --reimport-conversations`,
 * `lazy import-conversation`, `lazy init`'s preview, and doctor's capture-rot
 * check — inherits one predicate from one place, and each unique session is
 * examined at most once per discovery pass. See src/import/machine-oneshot.ts
 * for what the marker is and why it is a marker rather than a content heuristic.
 */
export async function discoverCandidateSessionsPartitioned(
  opts: ReimportOptions,
): Promise<PartitionedCandidateSessions> {
  const { lazyRoot } = opts;
  const roots = await collectProjectsDirRoots(opts);

  const best = new Map<string, CandidateSession>();
  for (const root of roots) {
    const files = await discoverProjectSessionFiles(lazyRoot, root);
    for (const file of files) {
      const candidate: CandidateSession = { ...file, projectsDirRoot: root };
      const prev = best.get(file.sessionId);
      if (
        !prev ||
        candidate.size > prev.size ||
        (candidate.size === prev.size && candidate.mtimeMs > prev.mtimeMs)
      ) {
        best.set(file.sessionId, candidate);
      }
    }
  }

  // Stable, human-friendly ordering: newest-modified first.
  const deduped = Array.from(best.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: PartitionedCandidateSessions = { capturable: [], machineOneshots: [] };
  for (const c of deduped) {
    if (await isMachineOneshotSessionFile(c.filePath)) out.machineOneshots.push(c);
    else out.capturable.push(c);
  }
  return out;
}

/**
 * The sessions capture cares about: everything discovered EXCEPT lazy's own
 * machine-generated one-shots. Use discoverCandidateSessionsPartitioned when you
 * also want to report how many one-shots were skipped.
 */
export async function discoverCandidateSessions(opts: ReimportOptions): Promise<CandidateSession[]> {
  return (await discoverCandidateSessionsPartitioned(opts)).capturable;
}

/** One imported session's headline facts, for reporting. */
export interface ReimportedSessionInfo {
  sessionId: string;
  startedAt: string | null;
  messageCount: number;
  totalTokens: number;
}

export interface ReimportReport {
  /** Unique sessions discovered on disk across all roots. */
  found: number;
  /** Sessions newly parsed and persisted this run. */
  imported: ReimportedSessionInfo[];
  /** Sessions skipped because they were already in the store. */
  skippedAlready: string[];
  /** Sessions skipped because they had no parseable messages (empty shells). */
  skippedEmpty: string[];
  /**
   * Machine-generated lazy one-shots that were never candidates (fidelity
   * summaries, `lazy report`, memory compaction). Counted, not listed — the
   * point of skipping them is that nobody wants to see them enumerated.
   */
  skippedMachineOneshots: number;
  /** Per-session parse/save failures — surfaced, never swallowed. */
  errors: Array<{ sessionId: string; error: Error }>;
}

/**
 * Scan → dedupe → import. Sessions already in the store are skipped (so this is
 * safe to run repeatedly); empty JSONL shells (a file Claude created before any
 * turn landed) are skipped rather than persisted as content-free stubs.
 *
 * `onImported` fires after each successful persist so callers can stream
 * progress; the same facts are also returned in the report.
 */
export async function reimportConversations(
  opts: ReimportOptions & { storage: Storage; onImported?: (info: ReimportedSessionInfo) => void },
): Promise<ReimportReport> {
  const { storage, onImported } = opts;
  const { capturable: candidates, machineOneshots } = await discoverCandidateSessionsPartitioned(opts);

  const report: ReimportReport = {
    found: candidates.length,
    imported: [],
    skippedAlready: [],
    skippedEmpty: [],
    skippedMachineOneshots: machineOneshots.length,
    errors: [],
  };

  for (const c of candidates) {
    try {
      if (await storage.isConversationImported(c.sessionId)) {
        report.skippedAlready.push(c.sessionId);
        continue;
      }

      const conversation = await parseConversation(c.projectPath, c.sessionId, c.projectsDirRoot);
      // A JSONL with no parseable messages is an empty shell — don't persist a
      // content-free stub (exactly the 0-assistant-message noise that made the
      // capture bug hard to spot). Wait for a copy that actually has content.
      if (conversation.messages.length === 0) {
        report.skippedEmpty.push(c.sessionId);
        continue;
      }

      const summary = extractSummary(conversation);
      const stats = conversationStats(conversation);
      const stored = toStoredConversation(conversation, summary, stats);
      await storage.saveConversation(stored);

      const info: ReimportedSessionInfo = {
        sessionId: c.sessionId,
        startedAt: conversation.startedAt,
        messageCount: stats.messageCount,
        totalTokens: stats.totalTokens,
      };
      report.imported.push(info);
      onImported?.(info);
    } catch (err) {
      report.errors.push({
        sessionId: c.sessionId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return report;
}

/** A session on disk that the store has no record of, with its file mtime. */
export interface MissingConversation {
  sessionId: string;
  /** Last modification of the JSONL — how `lazy doctor` tells rot from history. */
  mtimeMs: number;
}

/**
 * Cheap detection for `lazy doctor`: which unique on-disk sessions are NOT yet
 * in the store. No parsing — just discovery + an isConversationImported check
 * per session, so it's fast enough to run on every `lazy doctor`.
 *
 * INVARIANT: this must count only sessions capture is actually TRYING to store.
 * Machine-generated one-shots are deliberately never captured, so counting them
 * here would leave the capture-rot check permanently red — crying wolf forever
 * about the one thing that is working as designed. They are excluded because
 * discoverCandidateSessions excludes them; do not reintroduce them.
 */
export async function listMissingConversations(
  opts: ReimportOptions & { storage: Storage },
): Promise<MissingConversation[]> {
  const { storage } = opts;
  const candidates = await discoverCandidateSessions(opts);
  const missing: MissingConversation[] = [];
  for (const c of candidates) {
    if (!(await storage.isConversationImported(c.sessionId))) {
      missing.push({ sessionId: c.sessionId, mtimeMs: c.mtimeMs });
    }
  }
  return missing;
}

/**
 * A session modified this recently is probably still being written (or the
 * daemon's capture sweep simply hasn't ticked yet) — too fresh to call rot.
 * Comfortably larger than the sweep interval so a healthy system never trips it.
 */
export const CAPTURE_SETTLE_MS = 5 * 60_000;

/**
 * How far back a miss still counts as "capture is broken NOW" rather than
 * recoverable history. A day is long enough to catch a rot that started
 * overnight and short enough that pre-fix history never masquerades as one.
 */
export const CAPTURE_ROT_WINDOW_MS = 24 * 60 * 60_000;

export interface CaptureRotClassification {
  /** Recent, settled, and still missing — live capture is broken right now. */
  rotted: MissingConversation[];
  /** Older misses — recoverable history, not evidence of a current break. */
  historical: MissingConversation[];
  /** Modified within the settle window — still in flight, no verdict. */
  inFlight: MissingConversation[];
}

/**
 * Split missing sessions by file age into rot / history / in-flight. Pure and
 * time-injectable so `lazy doctor`'s verdict is directly testable.
 */
export function classifyMissingConversations(
  missing: MissingConversation[],
  nowMs: number,
): CaptureRotClassification {
  const out: CaptureRotClassification = { rotted: [], historical: [], inFlight: [] };
  for (const m of missing) {
    const age = nowMs - m.mtimeMs;
    if (age < CAPTURE_SETTLE_MS) out.inFlight.push(m);
    else if (age <= CAPTURE_ROT_WINDOW_MS) out.rotted.push(m);
    else out.historical.push(m);
  }
  return out;
}

/** How many on-disk sessions are missing from the store. */
export async function countMissingConversations(
  opts: ReimportOptions & { storage: Storage },
): Promise<number> {
  return (await listMissingConversations(opts)).length;
}
