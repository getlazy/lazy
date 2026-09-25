/**
 * Capture the live builder scratch dir into the project store.
 *
 * WHY A CAPTURE RATHER THAN WRITING STRAIGHT TO THE STORE: the live directory
 * (`$LAZY_SCRATCH_DIR`, see scratch.ts) has to stay the working area. It is a
 * real filesystem the builder writes with ordinary tools, mounted at the SAME
 * absolute path inside a container as on the host so a path the builder prints
 * pastes into the engineer's shell — `lazy accept <task> --message "$(cat
 * $LAZY_SCRATCH_DIR/accept-foo.md)"`. Replacing that with store-only writes
 * would mean a builder could no longer `cat`, `grep` or pipe its own artifacts,
 * and the engineer could no longer read them without lazy running. So the
 * directory stays authoritative for WRITING and the store is the durable copy:
 * it survives the host, reaches other builders, and is searchable.
 *
 * WHEN IT RUNS: on the builder supervisor's existing capture cadence (every
 * CAPTURE_INTERVAL_MS, on SIGINT/SIGTERM, and on the final flush after Claude
 * exits) — the same safety net that keeps conversations from being lost to a
 * non-graceful exit, for the same reason. Also on demand via `lazy scratch sync`.
 *
 * WHAT IT DOES NOT DO: it never deletes. A file removed from the live directory
 * keeps its stored record — the store outliving the host directory is the entire
 * point, and a `rm` in a scratch dir must not silently destroy an artifact the
 * engineer was about to read. Removal is explicit (`lazy scratch rm`).
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, sep } from 'path';
import type { Storage } from '../storage/interface';
import type { Actor, ScratchFileInput, ScratchSkipReason } from '../types';
import {
  MAX_SCRATCH_FILE_BYTES,
  MAX_SCRATCH_SANDBOX_BYTES,
  formatBytes,
} from './scratch-limits';

/** One file's outcome in a sync pass. */
export interface ScratchSyncEntry {
  /** Sandbox-relative path, always with forward slashes. */
  path: string;
  size: number;
  /** Absent when the content was stored. */
  skipped?: ScratchSkipReason;
}

export interface ScratchSyncResult {
  /** Files whose content was newly stored or updated this pass. */
  stored: ScratchSyncEntry[];
  /** Files recorded as metadata only, with the reason. */
  skipped: ScratchSyncEntry[];
  /** Files already in the store with identical content — not rewritten. */
  unchanged: number;
  /**
   * Human-readable warnings for anything the engineer should know about: every
   * skip produces one. Callers surface these (supervisor log, CLI stderr)
   * rather than letting a silently-unpersisted artifact look persisted.
   */
  warnings: string[];
}

/**
 * Walk a scratch directory and return every regular file's sandbox-relative
 * path (forward-slashed) and size, deepest-last but otherwise unordered.
 *
 * Dot-prefixed entries are skipped at every level: `.DS_Store`, editor swap
 * files and `.git` directories are noise no engineer wants in a search hit, and
 * a leading dot is the one convention every tool already agrees means "not
 * content". Symlinks are not followed — a symlink into the repo or into `$HOME`
 * would quietly pull unrelated (and possibly secret) files into the store.
 */
async function walkScratchDir(root: string): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];

  const walk = async (dir: string): Promise<void> => {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // never created
      throw new Error(`Failed to read scratch dir ${dir}: ${(err as Error).message}`);
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        try {
          const info = await stat(full);
          out.push({ path: relative(root, full).split(sep).join('/'), size: info.size });
        } catch (err) {
          // The builder is live and may be mid-write; a file that vanished
          // between readdir and stat simply isn't there to capture. Anything
          // else is a real problem.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      // Symlinks, sockets and devices fall through deliberately.
    }
  };

  await walk(root);
  return out;
}

/**
 * Read a file as UTF-8, or report it as binary.
 *
 * Bun/Node's UTF-8 decoder is lossy — invalid bytes become U+FFFD rather than
 * throwing — so "did it decode" is not a question `readFile(path, 'utf-8')` can
 * answer. Decoding with `fatal: true` is the check: a scratch pad's value is
 * that a human and a search index can read it, and a JPEG rendered as replacement
 * characters is neither readable nor searchable, just large.
 */
async function readUtf8(path: string): Promise<string | null> {
  const buf = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Not valid UTF-8 — genuinely binary. The caller records it as such; this
    // is the one thing we know about the file, not an error to propagate.
    return null;
  }
}

/**
 * Capture `scratchDir` into `storage`.
 *
 * Files whose stored content already matches are left alone, so a sync every 30
 * seconds for a session that writes nothing is nearly free and does not churn
 * `updated_at` (which is what tells the engineer when an artifact last changed).
 *
 * `sessionId` is the provenance stamp — the Claude session of the builder doing
 * the writing, when the supervisor has detected one. It is what links a scratch
 * artifact back to the conversation that produced it.
 */
export async function syncScratchDir(options: {
  scratchDir: string;
  storage: Storage;
  actor: Actor;
  sessionId?: string;
}): Promise<ScratchSyncResult> {
  const { scratchDir, storage, actor, sessionId } = options;

  const result: ScratchSyncResult = { stored: [], skipped: [], unchanged: 0, warnings: [] };
  const onDisk = await walkScratchDir(scratchDir);
  if (onDisk.length === 0) return result;

  // `listScratchFiles()` pulls full bodies on every tick, which is what makes the
  // unchanged-content comparison below exact. Bounded by the 32 MiB sandbox cap,
  // so the worst case is small; a hash-based diff would avoid the read entirely
  // and is the obvious optimization if that cap ever grows.
  const existing = new Map((await storage.listScratchFiles()).map(f => [f.path, f]));

  // Budget for the whole sandbox, seeded with what is already stored so a sync
  // cannot walk the store past the cap one pass at a time. Recomputed from
  // scratch each pass rather than tracked incrementally: it must stay correct
  // after a `lazy scratch rm` or a store restored from elsewhere.
  let storedBytes = 0;
  for (const file of existing.values()) storedBytes += Buffer.byteLength(file.content, 'utf-8');

  // Smallest first, so a single huge dump cannot starve every ordinary document
  // out of the remaining budget. A builder that writes one 30 MB file and ten
  // review notes gets the notes.
  const ordered = [...onDisk].sort((a, b) => a.size - b.size);

  for (const { path, size } of ordered) {
    const prior = existing.get(path);

    const record = async (input: ScratchFileInput): Promise<void> => {
      await storage.saveScratchFile(input, actor);
    };

    // Over the per-file cap: recorded, never truncated. Checked against the
    // on-disk size before reading, so a 2 GB file is never pulled into memory.
    if (size > MAX_SCRATCH_FILE_BYTES) {
      if (prior?.skipped === 'too_large' && prior.size === size) {
        result.unchanged++;
        continue;
      }
      await record({ path, content: '', size, skipped: 'too_large', session_id: sessionId });
      result.skipped.push({ path, size, skipped: 'too_large' });
      result.warnings.push(
        `${path} (${formatBytes(size)}) exceeds the ${formatBytes(MAX_SCRATCH_FILE_BYTES)} ` +
        `per-file cap — recorded by name only. It is still on disk at ${join(scratchDir, path)}; ` +
        `persist a summary instead if the engineer needs to read it through lazy.`,
      );
      continue;
    }

    const content = await readUtf8(join(scratchDir, path));

    if (content === null) {
      if (prior?.skipped === 'binary' && prior.size === size) {
        result.unchanged++;
        continue;
      }
      await record({ path, content: '', size, skipped: 'binary', session_id: sessionId });
      result.skipped.push({ path, size, skipped: 'binary' });
      result.warnings.push(
        `${path} (${formatBytes(size)}) is not UTF-8 text — recorded by name only, since ` +
        `binary content cannot be read or searched through lazy. It remains on disk at ` +
        `${join(scratchDir, path)}.`,
      );
      continue;
    }

    if (prior && !prior.skipped && prior.content === content) {
      result.unchanged++;
      continue;
    }

    const bytes = Buffer.byteLength(content, 'utf-8');
    const priorBytes = prior && !prior.skipped ? Buffer.byteLength(prior.content, 'utf-8') : 0;
    if (storedBytes - priorBytes + bytes > MAX_SCRATCH_SANDBOX_BYTES) {
      if (prior?.skipped === 'sandbox_full' && prior.size === size) {
        result.unchanged++;
        continue;
      }
      await record({ path, content: '', size, skipped: 'sandbox_full', session_id: sessionId });
      result.skipped.push({ path, size, skipped: 'sandbox_full' });
      result.warnings.push(
        `${path} (${formatBytes(size)}) was not persisted: the scratch sandbox is at its ` +
        `${formatBytes(MAX_SCRATCH_SANDBOX_BYTES)} total cap (${formatBytes(storedBytes)} stored). ` +
        `Free space with \`lazy scratch rm <path>\`; the file is still on disk at ` +
        `${join(scratchDir, path)}.`,
      );
      continue;
    }

    await record({ path, content, size, session_id: sessionId });
    storedBytes += bytes - priorBytes;
    result.stored.push({ path, size });
  }

  return result;
}
