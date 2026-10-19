/**
 * Audit of the content-store blobs an image build committed: does each one
 * still hash to its name?
 *
 * A blob's name IS the sha256 of the bytes containerd handed to write() — the
 * writer hashes as it writes and refuses a commit whose hash differs
 * (docs/damaged-image-store.md). So a blob that does not hash to its name had
 * its bytes changed below the content store. Hashing it TWICE says where:
 *
 *  - wrong right after the build committed it → damaged ON THE WAY DOWN: what
 *    landed on disk (or in the page cache) is not what was written;
 *  - right after the build, wrong after the next idle period → damaged AFTER
 *    it was written: the disk, the filesystem, or memory reclaimed while idle.
 *
 * Reads go through the page cache, like every reader of the store does.
 * Bounded: at most AUDIT_MAX_BLOBS blobs and AUDIT_MAX_BYTES per audit; what
 * is left out is said, never dropped silently.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { sha256OfFile } from './damaged-image-evidence';

export const AUDIT_MAX_BLOBS = 400;
export const AUDIT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** Clock slack: a blob whose ingest started just before the job's own timestamp still counts. */
const MTIME_SLACK_MS = 5_000;

export function contentBlobDir(dataRoot: string): string {
  return join(dataRoot, 'containerd', 'daemon', 'io.containerd.content.v1.content', 'blobs', 'sha256');
}

export interface AuditBlob { digest: string; path: string; size: number }

/**
 * The blobs committed since `sinceMs` (by modification time: the ingest file
 * is written during the build and renamed into place, which keeps it). Blobs
 * that already existed — cached layers — are not this build's and are skipped.
 */
export async function blobsCommittedSince(dir: string, sinceMs: number): Promise<{ blobs: AuditBlob[]; leftOut: number }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { blobs: [], leftOut: 0 };
    throw new Error(`could not list the content store at ${dir}: ${(err as Error).message}`);
  }
  const found: Array<AuditBlob & { mtimeMs: number }> = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (s.isFile() && s.mtimeMs >= sinceMs - MTIME_SLACK_MS) found.push({ digest: name, path, size: s.size, mtimeMs: s.mtimeMs });
    } catch (err) {
      // Removed between readdir and stat (a GC): not this build's to audit.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`could not stat ${path}: ${(err as Error).message}`);
    }
  }
  // Largest first: the damage seen in the field was in the large layers.
  found.sort((a, b) => b.size - a.size);
  const blobs: AuditBlob[] = [];
  let bytes = 0;
  for (const b of found) {
    if (blobs.length >= AUDIT_MAX_BLOBS || bytes + b.size > AUDIT_MAX_BYTES) continue;
    blobs.push({ digest: b.digest, path: b.path, size: b.size });
    bytes += b.size;
  }
  return { blobs, leftOut: found.length - blobs.length };
}

export type BlobCheck = { digest: string; size: number } & (
  | { state: 'intact' }
  | { state: 'mismatch'; actual: string }
  | { state: 'gone' }
  | { state: 'unreadable'; error: string });

/** Hash each blob against its name. Never throws per blob. */
export async function hashBlobs(blobs: AuditBlob[]): Promise<BlobCheck[]> {
  const out: BlobCheck[] = [];
  for (const b of blobs) {
    try {
      const actual = await sha256OfFile(b.path);
      out.push(actual === b.digest ? { digest: b.digest, size: b.size, state: 'intact' } : { digest: b.digest, size: b.size, state: 'mismatch', actual });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      out.push(code === 'ENOENT'
        ? { digest: b.digest, size: b.size, state: 'gone' }
        : { digest: b.digest, size: b.size, state: 'unreadable', error: (err as Error).message });
    }
  }
  return out;
}

/**
 * What one audit pass found.
 *  - `damaged-on-write`: a blob was wrong at its first check, right after the build.
 *  - `damaged-after-write`: a blob right after the build is wrong at the later check.
 *  - `intact`: everything still present hashes to its name.
 * Blobs removed in between (`gone`) are not a fault: images get deleted.
 */
export type AuditVerdict = 'intact' | 'damaged-on-write' | 'damaged-after-write';

export interface AuditClassification {
  verdict: AuditVerdict;
  checked: number;
  damaged: Array<{ digest: string; size: number; actual: string }>;
  gone: number;
  unreadable: Array<{ digest: string; error: string }>;
}

/**
 * Classify a pass. `atCommit` is the pass right after the build; `later`, when
 * given, is the pass after the next idle period. A blob already wrong at
 * commit stays an on-write finding even if it is still wrong later.
 */
export function classifyAudit(atCommit: BlobCheck[], later?: BlobCheck[]): AuditClassification {
  const pass = later ?? atCommit;
  const wrongAtCommit = new Set(atCommit.filter((c) => c.state === 'mismatch').map((c) => c.digest));
  const damaged = pass.flatMap((c) => c.state === 'mismatch' ? [{ digest: c.digest, size: c.size, actual: c.actual }] : []);
  const unreadable = pass.flatMap((c) => c.state === 'unreadable' ? [{ digest: c.digest, error: c.error }] : []);
  let verdict: AuditVerdict = 'intact';
  if (!later) {
    if (damaged.length > 0) verdict = 'damaged-on-write';
  } else if (damaged.some((d) => !wrongAtCommit.has(d.digest))) {
    verdict = 'damaged-after-write';
  } else if (damaged.length > 0) {
    verdict = 'damaged-on-write';
  }
  return { verdict, checked: pass.length, damaged, gone: pass.filter((c) => c.state === 'gone').length, unreadable };
}

/** What the verdict means, in plain words. */
export function auditMeaning(verdict: AuditVerdict): string {
  switch (verdict) {
    case 'intact': return 'Every blob hashes to its name.';
    case 'damaged-on-write':
      return 'A blob did not hash to its name right after the build stored it. Its name is the hash of the bytes Docker wrote, ' +
        'so what was stored is not what was written: the damage happened on the way down (the machine\'s memory or its write path), not later on disk.';
    case 'damaged-after-write':
      return 'A blob hashed to its name right after the build, and no longer does after the machine sat idle. ' +
        'The bytes changed after they were written: the machine\'s disk or filesystem (or its page cache) damaged them.';
  }
}

export function describeAudit(c: AuditClassification, phase: 'after-build' | 'after-idle', leftOut: number): string {
  const when = phase === 'after-build' ? 'right after the build' : 'after the machine sat idle';
  const lines = [`Image data check ${when}: ${c.checked} blob(s) re-hashed. ${auditMeaning(c.verdict)}`];
  for (const d of c.damaged.slice(0, 8)) lines.push(`- ${d.digest} (${d.size} bytes) now hashes to ${d.actual}`);
  if (c.damaged.length > 8) lines.push(`- … and ${c.damaged.length - 8} more`);
  if (c.gone > 0) lines.push(`${c.gone} blob(s) were deleted in between (images removed; not a fault).`);
  for (const u of c.unreadable.slice(0, 4)) lines.push(`- ${u.digest}: not readable (${u.error})`);
  if (leftOut > 0) lines.push(`${leftOut} smaller blob(s) were left out (the check reads at most ${AUDIT_MAX_BLOBS} blobs and ${AUDIT_MAX_BYTES / 1073741824} GiB).`);
  return lines.join('\n');
}
