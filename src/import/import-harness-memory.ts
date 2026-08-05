/**
 * One-time import: pull Claude Code harness memory files into lazy-owned
 * shared memory.
 *
 * WHY: before lazy owned memory, everything the builder "remembered" landed in
 * the Claude Code harness memory directory —
 * `<projects-root>/<encoded-cwd>/memory/<name>.md`. In lazy that directory sits
 * INSIDE each builder's per-builder projects overlay
 * (`<data>/builder-projects/<id>/`), so it was never shared between builders,
 * invisible to agents and other machines, outside lazy state, and pruned with
 * the overlay. Months of builder sessions therefore accumulated no shared
 * memory at all.
 *
 * This module scans the same roots the conversation re-import scans (the shared
 * `~/.claude/projects` dir plus every per-builder isolation dir — see
 * `collectProjectsDirRoots`), parses the harness's frontmatter `.md` format,
 * dedupes by record name across roots (newest copy wins), and persists through
 * the Storage interface. It never writes store files directly.
 *
 * Idempotent: a record whose name is already in the store is skipped, so the
 * import is safe to run repeatedly (and `lazy doctor` can offer it whenever
 * on-disk memory has no lazy counterpart).
 *
 * MECHANISTIC BY DESIGN: the importer brings data in faithfully. It applies no
 * authoring-side validation — in particular the description length budget
 * (`MAX_MEMORY_DESCRIPTION_LENGTH`) is NOT enforced here, and nothing is ever
 * truncated. Records written by another tool under another contract are stored
 * as they were written; curating them afterwards is a separate concern, hinted
 * at by `MemoryImportReport.longDescriptions` rather than forced at intake.
 */

import { join } from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { collectProjectsDirRoots, type ReimportOptions } from './reimport-conversations';
import { encodeProjectPath } from './claude-code-logs';
import {
  normalizeMemoryName,
  normalizeMemoryDescription,
  validateMemoryType,
  exceedsAuthoringDescriptionLimit,
  MAX_MEMORY_DESCRIPTION_LENGTH,
} from '../memory';
import type { MemoryType } from '../types';
import type { Storage } from '../storage/interface';

/** A harness memory file found on disk. */
export interface HarnessMemoryFile {
  /** Record name after normalization (frontmatter `name:`, else the filename). */
  name: string;
  filePath: string;
  mtimeMs: number;
  size: number;
}

/** The parsed contents of a harness memory `.md` file. */
export interface ParsedHarnessMemory {
  name?: string;
  description?: string;
  type?: MemoryType;
  body: string;
}

/**
 * Parse the harness memory format:
 *
 *   ---
 *   name: <slug>
 *   description: <one line>
 *   metadata:
 *     type: user | feedback | project | reference
 *   ---
 *   <body>
 *
 * Deliberately a small, tolerant reader rather than a full YAML parser: these
 * files are machine-written with exactly this shape, and a missing/odd field
 * should degrade to "import what we can" (the caller supplies fallbacks) rather
 * than throw away a real memory. A file with no frontmatter is still importable
 * — its whole content becomes the body.
 */
export function parseHarnessMemory(content: string): ParsedHarnessMemory {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return { body: content.trim() };
  }

  const [, frontmatter, body] = match;
  const parsed: ParsedHarnessMemory = { body: body.trim() };

  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim();
    const kv = /^(-\s*)?([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[2];
    const value = kv[3].trim().replace(/^["']|["']$/g, '');
    if (!value) continue;

    if (key === 'name') parsed.name = value;
    else if (key === 'description') parsed.description = value;
    else if (key === 'type') {
      // `type:` appears nested under `metadata:` — indentation is irrelevant to
      // us, the key is unambiguous within these files.
      try {
        parsed.type = validateMemoryType(value);
      } catch {
        // Unknown type in a hand-edited file: leave it unset so the caller
        // falls back to a default rather than dropping the whole record.
      }
    }
  }

  return parsed;
}

/**
 * Discover every harness memory file for this project across all candidate
 * projects-dir roots, deduped by record name. When the same name appears in
 * several roots (each builder overlay has its own copy), the newest mtime wins;
 * ties break on the larger file — the most recently written, most complete copy.
 *
 * `MEMORY.md` is skipped: it is the harness's rendered index of the other
 * files, not a record. Lazy renders its own index from the records.
 */
export async function discoverHarnessMemoryFiles(opts: ReimportOptions): Promise<HarnessMemoryFile[]> {
  const roots = await collectProjectsDirRoots(opts);
  const encodedPrefix = encodeProjectPath(opts.lazyRoot);

  const best = new Map<string, HarnessMemoryFile>();

  for (const root of roots) {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(root);
    } catch {
      continue; // root doesn't exist (normal on a fresh machine)
    }

    for (const dir of projectDirs) {
      // Prefix match so worktree project dirs (which encode a longer path) are
      // scanned too — same rule as conversation discovery.
      if (!dir.startsWith(encodedPrefix)) continue;

      const memoryDir = join(root, dir, 'memory');
      let entries: string[];
      try {
        entries = await readdir(memoryDir);
      } catch {
        continue; // no memory dir for this project dir
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        if (entry === 'MEMORY.md') continue;

        const filePath = join(memoryDir, entry);
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(filePath);
        } catch {
          continue; // vanished between readdir and stat
        }
        if (!fileStat.isFile()) continue;

        let name: string;
        try {
          const content = await readFile(filePath, 'utf-8');
          const parsed = parseHarnessMemory(content);
          name = normalizeMemoryName(parsed.name ?? entry.replace(/\.md$/, ''));
        } catch {
          // Unreadable or un-nameable — surfaced later as an import error only
          // if it is the copy we choose; here we simply cannot key it.
          continue;
        }

        const candidate: HarnessMemoryFile = {
          name,
          filePath,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        };
        const prev = best.get(name);
        if (
          !prev ||
          candidate.mtimeMs > prev.mtimeMs ||
          (candidate.mtimeMs === prev.mtimeMs && candidate.size > prev.size)
        ) {
          best.set(name, candidate);
        }
      }
    }
  }

  return Array.from(best.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface ImportedMemoryInfo {
  name: string;
  type: MemoryType;
  description: string;
  filePath: string;
}

export interface MemoryImportReport {
  /** Unique record names discovered on disk across all roots. */
  found: number;
  imported: ImportedMemoryInfo[];
  /** Names skipped because lazy already has a record with that name. */
  skippedExisting: string[];
  /** Files skipped because they had no usable body. */
  skippedEmpty: string[];
  /** Per-file parse/save failures — surfaced, never swallowed. */
  errors: Array<{ name: string; error: Error }>;
  /**
   * Names of imported records whose description exceeds the AUTHORING limit
   * (`MAX_MEMORY_DESCRIPTION_LENGTH`). They were imported verbatim — this is a
   * curation hint for the human, not a rejection.
   */
  longDescriptions: string[];
}

/**
 * Scan → dedupe → import. Records already in lazy's store are skipped, so this
 * is safe to run repeatedly.
 *
 * Imported records are attributed to the `system` actor: lazy performed the
 * write, and pretending a human or builder authored it would falsify the
 * append-only history. The original file's own authorship is not recoverable —
 * the harness format does not record it.
 */
export async function importHarnessMemory(
  opts: ReimportOptions & { storage: Storage; onImported?: (info: ImportedMemoryInfo) => void },
): Promise<MemoryImportReport> {
  const { storage, onImported } = opts;
  const candidates = await discoverHarnessMemoryFiles(opts);

  const report: MemoryImportReport = {
    found: candidates.length,
    imported: [],
    skippedExisting: [],
    skippedEmpty: [],
    errors: [],
    longDescriptions: [],
  };

  for (const candidate of candidates) {
    try {
      if (await storage.getMemory(candidate.name)) {
        report.skippedExisting.push(candidate.name);
        continue;
      }

      const parsed = parseHarnessMemory(await readFile(candidate.filePath, 'utf-8'));
      if (!parsed.body.trim()) {
        report.skippedEmpty.push(candidate.name);
        continue;
      }

      // MECHANISTIC INTAKE: the description is normalized to one line (the
      // injected index is one record per line) and stored VERBATIM otherwise —
      // never length-checked, never truncated. These files were written by
      // another tool under another contract; rejecting a 300-character
      // description would discard curated knowledge, and truncating would
      // mangle it. The authoring limit lives on `lazy memory save` /
      // `lazy_memory_save` only (see MAX_MEMORY_DESCRIPTION_LENGTH), and
      // over-limit imports are reported afterwards as a curation hint.
      //
      // Fall back rather than reject: a harness file missing `description` or
      // `type` still holds real knowledge, and dropping it would repeat exactly
      // the loss this import exists to repair.
      const description = normalizeMemoryDescription(
        parsed.description ?? parsed.body.split('\n').find(l => l.trim())?.trim() ?? candidate.name,
      );
      const type = parsed.type ?? 'project';

      const record = await storage.saveMemory(
        { name: candidate.name, description, type, body: parsed.body },
        'system',
      );

      const info: ImportedMemoryInfo = {
        name: record.name,
        type: record.type,
        description: record.description,
        filePath: candidate.filePath,
      };
      report.imported.push(info);
      if (exceedsAuthoringDescriptionLimit(record.description)) {
        report.longDescriptions.push(record.name);
      }
      onImported?.(info);
    } catch (err) {
      report.errors.push({
        name: candidate.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return report;
}

/**
 * The post-import curation hint, or null when nothing is over the authoring
 * limit. Shared by `lazy doctor --import-memory` and the `lazy init` offer so
 * both say the same thing: the records ARE imported, and tightening them is an
 * optional follow-up — never a failure.
 */
export function formatLongDescriptionNotice(report: MemoryImportReport): string | null {
  const n = report.longDescriptions.length;
  if (n === 0) return null;
  return (
    `${n} imported record(s) have descriptions longer than ${MAX_MEMORY_DESCRIPTION_LENGTH} characters ` +
    `(imported verbatim; the limit applies only to records you write with 'lazy memory save'). ` +
    `Consider tightening them: ${report.longDescriptions.join(', ')}`
  );
}

/**
 * Cheap detection for `lazy doctor`: how many on-disk harness memory records
 * have no lazy counterpart yet. Discovery + one getMemory per record, so it is
 * fast enough to run on every `lazy doctor`.
 */
export async function countImportableMemories(
  opts: ReimportOptions & { storage: Storage },
): Promise<number> {
  const { storage } = opts;
  const candidates = await discoverHarnessMemoryFiles(opts);
  let missing = 0;
  for (const c of candidates) {
    if (!(await storage.getMemory(c.name))) missing++;
  }
  return missing;
}
