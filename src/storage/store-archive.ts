/**
 * The archive a store backup's data is kept in: a POSIX tar (ustar, with PAX
 * records for long paths and big files), gzip-compressed — `store.tar.gz`,
 * which any `tar xzf` can unpack by hand.
 *
 * Written and read here rather than by a system `tar`, whose behaviour differs
 * between a Mac, the Lazy Teams host and a project's machine. Only what a
 * store holds is written: directories, regular files and symlinks.
 *
 * The reader is the dangerous half: a backup is read back on the HOST, and on
 * Lazy Teams its contents came from a guest-writable store. So `unpackArchive`
 * refuses — before writing anything for that entry — every path that is
 * absolute, has an empty, `.` or `..` component, or would land outside the
 * destination; every entry type other than file, directory and symlink
 * (hardlinks, devices, FIFOs, global headers); and every symlink placed under
 * another symlink, or whose target passes through one (chained links are how a
 * text-only target check is defeated). Symlinks are created only after every
 * file and directory, so no entry can be written THROUGH one, and files are
 * created O_EXCL|O_NOFOLLOW, so a duplicate entry cannot overwrite another.
 * A symlink whose target is absolute or resolves outside the destination is
 * not created at all and is reported back (`skipped`): the store recorded it,
 * but recreating it on the host is the escape this reader exists to prevent.
 *
 * Compression is gzip from zlib, run off the event loop one block at a time:
 * the archive is a series of gzip members (valid gzip, which every gunzip
 * reads as one stream). That costs a little ratio and keeps a daemon start
 * responsive while a large store is archived.
 */

import { constants } from 'fs';
import { lstat, mkdir, open, rm, symlink, type FileHandle } from 'fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'path';
import { createGunzip, gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const BLOCK = 512;
/** Uncompressed bytes gathered before one gzip member is written. */
const MEMBER_BYTES = 1 << 20;

export type ArchiveEntryType = 'file' | 'dir' | 'symlink';

export interface ArchiveEntry {
  type: ArchiveEntryType;
  /** Relative, `/`-separated. */
  path: string;
  mode: number;
  size: number;
  /** A symlink's target. */
  target?: string;
}

/** Appends entries to a gzip-compressed tar file. Call `finish()` once, or `abort()`. */
export class ArchiveWriter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private written = 0;

  private constructor(private readonly fh: FileHandle) {}

  static async create(path: string): Promise<ArchiveWriter> {
    return new ArchiveWriter(await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  }

  /** Compressed bytes on disk so far. */
  get compressedBytes(): number {
    return this.written;
  }

  async directory(path: string, mode: number): Promise<void> {
    await this.header({ type: 'dir', path: path + '/', mode, size: 0 });
  }

  async symlink(path: string, target: string): Promise<void> {
    await this.header({ type: 'symlink', path, mode: 0o777, size: 0, target });
  }

  /** A file of exactly `size` bytes; follow with `data()` calls totalling `size`, then `endFile(size)`. */
  async beginFile(path: string, mode: number, size: number): Promise<void> {
    await this.header({ type: 'file', path, mode, size });
  }

  async data(chunk: Buffer): Promise<void> {
    await this.push(Buffer.from(chunk));
  }

  async endFile(size: number): Promise<void> {
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) await this.push(Buffer.alloc(pad));
  }

  async finish(): Promise<void> {
    await this.push(Buffer.alloc(BLOCK * 2));
    await this.flush();
    await this.fh.sync();
    await this.fh.close();
  }

  async abort(): Promise<void> {
    await this.fh.close().catch(() => {
      // Handled: the archive is being abandoned because of an earlier error,
      // which is the one the caller reports; a close failure adds nothing.
    });
  }

  private async header(e: ArchiveEntry): Promise<void> {
    const pax: string[] = [];
    const pathBytes = Buffer.byteLength(e.path);
    if (pathBytes > 100 || /[^\x20-\x7e]/.test(e.path)) pax.push(paxRecord('path', e.path));
    if (e.target !== undefined && (Buffer.byteLength(e.target) > 100 || /[^\x20-\x7e]/.test(e.target))) pax.push(paxRecord('linkpath', e.target));
    if (e.size > 0o77777777777) pax.push(paxRecord('size', String(e.size)));
    if (pax.length) {
      const body = Buffer.from(pax.join(''));
      await this.push(ustarHeader({ name: 'PaxHeader', mode: 0o644, size: body.length, type: 'x', linkname: '' }));
      await this.push(body);
      await this.endFile(body.length);
    }
    await this.push(ustarHeader({
      name: e.path,
      mode: e.mode,
      size: e.type === 'file' ? e.size : 0,
      type: e.type === 'file' ? '0' : e.type === 'dir' ? '5' : '2',
      linkname: e.target ?? '',
    }));
  }

  private async push(buf: Buffer): Promise<void> {
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    if (this.pendingBytes >= MEMBER_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.pendingBytes) return;
    const member = await gzipAsync(Buffer.concat(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
    let off = 0;
    while (off < member.length) {
      const { bytesWritten } = await this.fh.write(member, off, member.length - off);
      off += bytesWritten;
    }
    this.written += member.length;
  }
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(body);
  // The record's length counts its own digits.
  let digits = 1;
  while (String(bytes + digits).length !== digits) digits++;
  return `${bytes + digits}${body}`;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function ustarHeader(h: { name: string; mode: number; size: number; type: string; linkname: string }): Buffer {
  const buf = Buffer.alloc(BLOCK);
  // Long names travel in the PAX record; the ustar field keeps a truncated copy.
  buf.write(truncateBytes(h.name, 100), 0, 'utf-8');
  buf.write(octal(h.mode & 0o7777, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');
  buf.write(octal(0, 8), 116, 'ascii');
  buf.write(octal(Math.min(h.size, 0o77777777777), 12), 124, 'ascii');
  buf.write(octal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(h.type, 156, 'ascii');
  buf.write(truncateBytes(h.linkname, 100), 157, 'utf-8');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(octal(sum, 7) + ' ', 148, 'ascii');
  return buf;
}

function truncateBytes(s: string, max: number): string {
  let out = s;
  while (Buffer.byteLength(out) > max) out = out.slice(0, -1);
  return out;
}

/** Exact-length reads over an async stream of chunks. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private readonly it: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const next = await this.it.next();
      if (next.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, next.value]) : next.value;
    }
    return this.buf.length >= n;
  }

  /** Exactly `n` bytes, or null at a clean end of input before any of them. */
  async read(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) {
      if (this.buf.length === 0) return null;
      throw new Error('the archive ends in the middle of an entry (it is truncated)');
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Up to `max` bytes (at least one), for streaming a file's data. */
  async some(max: number): Promise<Buffer> {
    if (!(await this.fill(1))) throw new Error('the archive ends in the middle of an entry (it is truncated)');
    const n = Math.min(max, this.buf.length);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

function parseOctal(field: Buffer, what: string): number {
  const text = field.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`the archive has a malformed ${what} field (${JSON.stringify(text)})`);
  return parseInt(text, 8);
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf-8');
}

function parsePax(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off < body.length) {
    const space = body.indexOf(0x20, off);
    if (space === -1) throw new Error('the archive has a malformed PAX record');
    const len = Number(body.subarray(off, space).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || off + len > body.length) throw new Error('the archive has a malformed PAX record');
    const rec = body.subarray(space + 1, off + len - 1).toString('utf-8');
    const eq = rec.indexOf('=');
    if (eq === -1) throw new Error('the archive has a malformed PAX record');
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    off += len;
  }
  return out;
}

/**
 * Read every entry of an archive in order. `onEntry` receives each entry and,
 * for a file, its data as chunks (which it must consume or leave — the rest is
 * skipped). Throws on corrupt compression, a bad header checksum, truncation
 * and any entry type this format does not write.
 */
export async function scanArchive(
  archivePath: string,
  onEntry: (entry: ArchiveEntry, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const fh = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!(await fh.stat().catch(async (err) => { await fh.close(); throw err; })).isFile()) {
    await fh.close();
    throw new Error(`${archivePath} is not a regular file`);
  }
  const file = fh.createReadStream();
  const gunzip = createGunzip();
  file.on('error', (err) => gunzip.destroy(err));
  file.pipe(gunzip);
  const reader = new ByteReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  let pax: Map<string, string> | null = null;
  try {
    for (;;) {
      const header = await reader.read(BLOCK);
      if (header === null) throw new Error('the archive ends without its end-of-archive marker (it is truncated)');
      if (header.every(b => b === 0)) return;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
      if (parseOctal(header.subarray(148, 156), 'checksum') !== sum) throw new Error('the archive has a header whose checksum does not match (it is corrupt)');
      const type = String.fromCharCode(header[156]);
      let size = parseOctal(header.subarray(124, 136), 'size');
      if (type === 'x') {
        if (size > 1 << 20) throw new Error('the archive has an oversized PAX record');
        const body = await reader.read(size + ((BLOCK - (size % BLOCK)) % BLOCK));
        if (!body) throw new Error('the archive ends in the middle of an entry (it is truncated)');
        pax = parsePax(body.subarray(0, size));
        continue;
      }
      const prefix = cString(header.subarray(345, 500));
      let path = pax?.get('path') ?? (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)));
      const target = pax?.get('linkpath') ?? cString(header.subarray(157, 257));
      if (pax?.has('size')) size = Number(pax.get('size'));
      pax = null;
      const mode = parseOctal(header.subarray(100, 108), 'mode');
      let entryType: ArchiveEntryType;
      if (type === '0' || type === '\0') entryType = 'file';
      else if (type === '5') entryType = 'dir';
      else if (type === '2') entryType = 'symlink';
      else throw new Error(`the archive has an entry of a kind a store backup never contains (type ${JSON.stringify(type)} at ${JSON.stringify(path)}); refusing it`);
      if (entryType === 'dir') path = path.replace(/\/+$/, '');
      if (entryType !== 'file') size = 0;
      let left = size;
      const data: AsyncIterable<Buffer> = {
        async *[Symbol.asyncIterator]() {
          while (left > 0) {
            const chunk = await reader.some(Math.min(left, 1 << 20));
            left -= chunk.length;
            yield chunk;
          }
        },
      };
      await onEntry({ type: entryType, path, mode, size, ...(entryType === 'symlink' ? { target } : {}) }, data);
      while (left > 0) left -= (await reader.some(Math.min(left, 1 << 20))).length;
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad && !(await reader.read(pad))) throw new Error('the archive ends in the middle of an entry (it is truncated)');
    }
  } finally {
    file.destroy();
    gunzip.destroy();
  }
}

/** A relative entry path that stays inside its destination, or a refusal naming it. */
export function safeEntryPath(path: string): string {
  const parts = path.split('/');
  if (
    path === '' || path.includes('\0') || isAbsolute(path) || path.startsWith('\\') ||
    parts.some(p => p === '' || p === '.' || p === '..') || /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`the archive has an entry with an unsafe path (${JSON.stringify(path)}); refusing to unpack it`);
  }
  return parts.join(sep);
}

/** Refuse when any directory between `root` and `abs` (exclusive) is a symlink on disk. */
async function assertNoLinkAbove(root: string, rel: string): Promise<void> {
  const parts = rel.split(sep);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    const st = await lstat(cur).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (st?.isSymbolicLink()) throw new Error(`the archive has an entry under a symlink (${JSON.stringify(rel)}); refusing to unpack it`);
  }
}

/**
 * Unpack an archive into `dest` (an existing, empty directory), refusing every
 * entry that could reach outside it (see the header). Returns the symlinks it
 * created, and the ones it left out because they point outside `dest`.
 */
export async function unpackArchive(
  archivePath: string,
  dest: string,
  onFile?: (entry: ArchiveEntry, chunk: Buffer) => void,
): Promise<{ links: { path: string; target: string }[]; skipped: { path: string; target: string }[] }> {
  const root = resolve(dest);
  const links: { path: string; target: string }[] = [];
  const skipped: { path: string; target: string }[] = [];
  const written: string[] = [];
  await scanArchive(archivePath, async (entry, data) => {
    const rel = safeEntryPath(entry.path);
    const abs = join(root, rel);
    if (entry.type !== 'symlink') written.push(abs);
    if (entry.type === 'dir') {
      await mkdir(abs, { recursive: true, mode: 0o700 });
    } else if (entry.type === 'symlink') {
      const target = entry.target ?? '';
      if (target.includes('\0')) throw new Error(`the archive has a symlink ${JSON.stringify(entry.path)} with an unsafe target; refusing to unpack it`);
      const resolved = target === '' || isAbsolute(target) ? null : normalize(join(abs, '..', target));
      if (resolved === null || (resolved !== root && !resolved.startsWith(root + sep))) skipped.push({ path: entry.path, target });
      // Created last, so nothing in the archive is ever written through one.
      else links.push({ path: entry.path, target });
    } else {
      await mkdir(join(abs, '..'), { recursive: true, mode: 0o700 });
      const fh = await open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode & 0o777 || 0o600);
      try {
        for await (const chunk of data) {
          let off = 0;
          while (off < chunk.length) off += (await fh.write(chunk, off, chunk.length - off)).bytesWritten;
          onFile?.(entry, chunk);
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
  });
  // A link may not sit under another link, nor point through one: either lets
  // a chain of individually "inside" targets resolve outside `root`.
  // Compared lowercased and NFC-normalised (the disk check below is the
  // authority): on a case-insensitive host
  // filesystem (a Mac's default APFS) `A` IS the link `a`, so a target passing
  // through `A/..` would follow it while a byte comparison saw no link there.
  const fold = (p: string) => p.normalize('NFC').toLowerCase();
  const linkPaths = new Set(links.map(l => fold(join(root, safeEntryPath(l.path)))));
  const writtenFolded = written.map(fold);
  for (const link of links) {
    const abs = fold(join(root, safeEntryPath(link.path)));
    let cur = join(abs, '..');
    for (const part of link.target.split('/')) {
      if (part === '' || part === '.') continue;
      cur = part === '..' ? join(cur, '..') : join(cur, fold(part));
      if (linkPaths.has(cur) && cur !== abs) {
        throw new Error(`the archive has a symlink ${JSON.stringify(link.path)} whose target passes through another symlink (${JSON.stringify(link.target)}); refusing to unpack it`);
      }
    }
    if ([...linkPaths].some(p => abs.startsWith(p + sep)) || writtenFolded.some(w => w.startsWith(abs + sep))) {
      throw new Error(`the archive has an entry under a symlink (${JSON.stringify(link.path)}); refusing to unpack it`);
    }
  }
  for (const link of links) {
    const rel = safeEntryPath(link.path);
    await assertNoLinkAbove(root, rel);
    await symlink(link.target, join(root, rel));
  }
  // The checks above compare names; the filesystem decides which names are the
  // same (case, Unicode normalisation). So ask the disk too: walk each target
  // and refuse if any step of it is a symlink, removing what was created.
  for (const link of links) {
    const abs = join(root, safeEntryPath(link.path));
    let cur = join(abs, '..');
    for (const part of link.target.split('/')) {
      if (part === '' || part === '.') continue;
      cur = part === '..' ? join(cur, '..') : join(cur, part);
      const st = await lstat(cur).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
      });
      if (!st) break;
      if (st.isSymbolicLink() && cur !== abs) {
        for (const l of links) await rm(join(root, safeEntryPath(l.path)), { force: true });
        throw new Error(`the archive has a symlink ${JSON.stringify(link.path)} whose target passes through another symlink (${JSON.stringify(link.target)}); refusing to unpack it`);
      }
    }
  }
  return { links, skipped };
}
