/**
 * Evidence captured when a launch fails with a layer-extraction error, BEFORE
 * the self-repair (src/docker/damaged-image.ts) removes anything — so the next
 * occurrence explains itself instead of needing someone to run diagnostics by
 * hand on a machine that has meanwhile healed (token-watch, 2026-10-15/16: the
 * damage was intermittent and gone by the time it could be looked at).
 *
 * What it records, all bounded:
 *   - the failing blob: the digest it is filed under, the digest its bytes
 *     actually hash to, its size, the first compressed offset at which gzip
 *     decoding fails, and a 64-byte hex window there;
 *   - a run of the memory canary (src/docker/memory-canary.ts), on a Teams
 *     project machine: a lost store there blames memory, not the disk;
 *   - what else was going on: lazy's own image builds around that moment
 *     (running or finished in the last hour), the guest's dockerd death/reset
 *     history, and Docker's image events of the last two hours.
 *
 * Secrets: layer bytes can hold anything a Dockerfile copied in. The hex window
 * is 64 bytes, and any run of printable characters in it (8 or more) is
 * WITHHELD rather than shown — a corrupted region that is somebody's text file
 * is still visible as "text, N bytes", never as its content.
 *
 * Reading the blob needs read access to Docker's data-root, which the daemon
 * has inside a Teams microVM (it runs as root there). Elsewhere — Docker
 * Desktop keeps its data-root inside its own VM — the evidence says the store
 * was not readable and records the rest.
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { open, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { createGunzip } from 'zlib';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn } from '../utils/spawn';

/** Upper bound on the whole evidence text. */
export const EVIDENCE_MAX_CHARS = 6000;
const HEX_WINDOW = 64;
const SCAN_CHUNK = 16 * 1024;

/** The blob digest Docker names in an extraction error, or null. */
export function failingLayerDigest(dockerMessage: string): string | null {
  const m = /failed to extract layer (?:\(?)sha256:([0-9a-f]{64})/i.exec(dockerMessage)
    ?? /layer (?:sha256:)?([0-9a-f]{64})/i.exec(dockerMessage);
  return m ? m[1] : null;
}

export interface BlobExamination {
  path: string;
  size: number;
  expectedDigest: string;
  actualDigest: string;
  /**
   * First compressed offset at which gzip fails, at SCAN_CHUNK granularity
   * ([from, to)); null when the whole blob decodes.
   */
  gzipFailure: { from: number; to: number; error: string } | null;
  /** 64 bytes around the failure (or the blob's start), printable runs withheld. */
  hexWindow: { offset: number; lines: string[] } | null;
}

/** Hex dump of `buf` at `offset`, 16 bytes a line, printable runs of 8+ withheld. */
export function safeHexDump(buf: Buffer, offset: number): string[] {
  // Mark every byte that belongs to a printable run of 8 or more.
  const hidden = new Array<boolean>(buf.length).fill(false);
  let runStart = -1;
  for (let i = 0; i <= buf.length; i++) {
    const printable = i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x7e;
    if (printable && runStart < 0) runStart = i;
    if (!printable && runStart >= 0) {
      if (i - runStart >= 8) for (let j = runStart; j < i; j++) hidden[j] = true;
      runStart = -1;
    }
  }
  const withheld = hidden.filter(Boolean).length;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const cells: string[] = [];
    for (let j = i; j < Math.min(i + 16, buf.length); j++) {
      cells.push(hidden[j] ? '..' : buf[j].toString(16).padStart(2, '0'));
    }
    lines.push(`${(offset + i).toString().padStart(12)}  ${cells.join(' ')}`);
  }
  if (withheld > 0) lines.push(`(${withheld} bytes of readable text withheld as "..": the content is not recorded)`);
  return lines;
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * The first compressed offset at which gunzip fails, fed SCAN_CHUNK at a time.
 * Deflate can decode damaged data without complaint and fail only on its
 * CRC/length trailer — then the failure sits at the end and says nothing about
 * where the damage is; the caller says so.
 */
async function firstGzipFailure(path: string): Promise<{ from: number; to: number; error: string } | null> {
  // Count the compressed bytes fed in; when gunzip fails, the damage it noticed
  // lies within the last chunk fed (give or take gunzip's own input buffer,
  // one more chunk — the range below is widened by that much).
  let fed = 0;
  const counter = new Transform({ transform(chunk: Buffer, _enc, cb) { fed += chunk.length; cb(null, chunk); } });
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  try {
    await pipeline(createReadStream(path, { highWaterMark: SCAN_CHUNK }), counter, createGunzip(), sink);
    return null;
  } catch (err) {
    return { from: Math.max(0, fed - 3 * SCAN_CHUNK), to: fed, error: (err as Error).message };
  }
}

/** Examine one content blob. Throws only when it cannot be read at all. */
export async function examineBlob(path: string, expectedDigest: string): Promise<BlobExamination> {
  const size = (await stat(path)).size;
  const actualDigest = await sha256OfFile(path);
  const gzipFailure = await firstGzipFailure(path);
  const at = gzipFailure ? Math.max(0, gzipFailure.from) : 0;
  const fh = await open(path, 'r');
  let hexWindow: BlobExamination['hexWindow'] = null;
  try {
    const buf = Buffer.alloc(HEX_WINDOW);
    const { bytesRead } = await fh.read(buf, 0, HEX_WINDOW, at);
    hexWindow = { offset: at, lines: safeHexDump(buf.subarray(0, bytesRead), at) };
  } finally {
    await fh.close();
  }
  return { path, size, expectedDigest, actualDigest, gzipFailure, hexWindow };
}

export function describeExamination(x: BlobExamination): string {
  const lines = [
    `Blob ${x.expectedDigest} (${x.size} bytes):`,
    x.actualDigest === x.expectedDigest
      ? `- its bytes hash to its name: the blob itself is intact (the fault is elsewhere — the unpack, or the snapshot)`
      : `- its bytes hash to ${x.actualDigest}, NOT to its name: the stored bytes changed after they were written`,
  ];
  if (!x.gzipFailure) {
    lines.push('- gzip decodes the whole blob without error');
  } else {
    const trailer = /crc|length/i.test(x.gzipFailure.error) || x.size - x.gzipFailure.to < SCAN_CHUNK;
    lines.push(
      `- gzip first fails between compressed offsets ${x.gzipFailure.from} and ${x.gzipFailure.to}: ${x.gzipFailure.error}` +
      (trailer ? ' (a trailer check: deflate decoded the damage silently, so this offset does not locate it)' : ''),
    );
  }
  if (x.hexWindow) lines.push(`- bytes at ${x.hexWindow.offset}:`, ...x.hexWindow.lines.map((l) => `    ${l}`));
  return lines.join('\n');
}

async function run(argv: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: code === 0 ? out : `${out}${err}` };
}

export interface CollectEvidenceInput {
  binary: string;
  imageName: string;
  dockerMessage: string;
  /** Docker's data-root; asked of `docker info` when absent (test seam). */
  dataRoot?: string;
  /** The guest's dockerd history log (test seam). */
  historyLog?: string;
  now?: Date;
}

/** Bound a block of text to `max` characters, saying what was cut. */
function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`;
}

/**
 * Collect the evidence for one extraction failure, as bounded plain text.
 * Never throws: every part that cannot be gathered says why instead.
 */
export async function collectDamagedImageEvidence(input: CollectEvidenceInput): Promise<string> {
  const now = input.now ?? new Date();
  const parts: string[] = [`Evidence captured ${now.toISOString()} for ${input.imageName}, before the repair removed anything.`];

  // 1. The failing blob.
  const digest = failingLayerDigest(input.dockerMessage);
  if (!digest) {
    parts.push('Blob: Docker\'s message names no full layer digest, so the blob could not be examined.');
  } else {
    let dataRoot = input.dataRoot;
    if (!dataRoot) {
      const info = await run([input.binary, 'info', '--format', '{{.DockerRootDir}}'], 10_000).catch((e) => ({ code: 1, out: String(e) }));
      dataRoot = info.code === 0 ? info.out.trim() : undefined;
    }
    const path = dataRoot ? join(dataRoot, 'containerd', 'daemon', 'io.containerd.content.v1.content', 'blobs', 'sha256', digest) : null;
    if (!path) {
      parts.push(`Blob ${digest}: Docker's data-root could not be read from \`docker info\`.`);
    } else {
      try {
        parts.push(describeExamination(await examineBlob(path, digest)));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        parts.push(`Blob ${digest}: not examined — ${code === 'ENOENT' ? 'no such blob in the content store' : code === 'EACCES' ? 'the content store is not readable from this process' : (err as Error).message} (${path}).`);
      }
    }
  }

  // 1b. The memory canary, run now — the blob was read first, and nothing has
  // been removed yet. A failure here blames the machine's memory, not its disk.
  try {
    const { canaryEvidenceForExtractionFailure } = await import('../daemon/machine-integrity');
    parts.push(await canaryEvidenceForExtractionFailure());
  } catch (err) {
    parts.push(`Memory check: not available (${(err as Error).message}).`);
  }

  // 2. lazy's own image builds around this moment.
  try {
    const { listImageBuildJobs } = await import('../daemon/image-build-job');
    const hourAgo = now.getTime() - 3600_000;
    const recent = listImageBuildJobs().filter((j) => j.outcome === 'running' || Date.parse(j.finishedAt ?? j.startedAt) >= hourAgo);
    parts.push(recent.length === 0
      ? 'lazy image builds in the last hour: none.'
      : ['lazy image builds in the last hour (newest first):', ...recent.slice(0, 10).map((j) =>
          `- ${j.title}: ${j.outcome}, started ${j.startedAt}${j.finishedAt ? `, finished ${j.finishedAt}` : ''}`)].join('\n'));
  } catch (err) {
    parts.push(`lazy image builds: not available (${(err as Error).message}).`);
  }

  // 3. The guest's dockerd history: deaths, restarts, storage resets.
  try {
    const { DOCKERD_HISTORY_LOG } = await import('../daemon/guest-dockerd');
    const text = await readFile(input.historyLog ?? DOCKERD_HISTORY_LOG, 'utf8');
    const events = text.split('\n').filter((l) => /^=== /.test(l)).slice(-8);
    parts.push(events.length ? ['dockerd history (latest last):', ...events].join('\n') : 'dockerd history: no deaths, restarts or resets recorded.');
  } catch (err) {
    parts.push((err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'dockerd history: none on this machine (not a Teams microVM, or nothing recorded this boot).'
      : `dockerd history: not readable (${(err as Error).message}).`);
  }

  // 4. Docker's image events of the last two hours (pulls, deletes, tags).
  const events = await run([input.binary, 'events', '--since', '2h', '--until', '0s', '--filter', 'type=image',
    '--format', '{{.TimeNano}} {{.Action}} {{.Actor.ID}}'], 15_000).catch((e) => ({ code: 1, out: String(e) }));
  if (events.code === 0) {
    const lines = events.out.trim().split('\n').filter(Boolean).slice(-20).map((l) => {
      const [ns, ...rest] = l.split(' ');
      const t = Number(ns) ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : ns;
      return `- ${t} ${rest.join(' ')}`;
    });
    parts.push(lines.length ? ['Docker image events in the last 2 hours (latest 20):', ...lines].join('\n') : 'Docker image events in the last 2 hours: none.');
  } else {
    parts.push(`Docker image events: not available (${events.out.trim().slice(0, 200)}).`);
  }
  parts.push('Not visible to lazy: BuildKit\'s own garbage collection runs (Docker emits no event for them).');

  return bound(parts.join('\n\n'), EVIDENCE_MAX_CHARS);
}
