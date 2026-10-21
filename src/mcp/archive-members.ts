/**
 * Member listing and single-member reads for tar / tgz / zip artifacts, so a
 * caller can look inside an archive without decoding it. Pure buffer parsing —
 * no subprocess, no filesystem.
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';

/** Cap on decompressed output: artifacts are untrusted and a 1 MiB bomb must not expand unbounded. */
export const MAX_ARCHIVE_EXPANDED_BYTES = 64 * 1024 * 1024;

export type ArchiveKind = 'tar' | 'tgz' | 'zip';

export interface ArchiveMember {
  name: string;
  size: number;
}

export function detectArchiveKind(name: string, bytes: Buffer): ArchiveKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] <= 0x08) return 'zip';
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return /\.(tgz|tar\.gz)$/i.test(name) ? 'tgz' : null;
  }
  if (bytes.length >= 262 && bytes.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return null;
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf-8');
}

interface TarEntry extends ArchiveMember {
  data: Buffer;
}

function parseTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    let name = cString(header.subarray(0, 100));
    // The prefix field is POSIX-only; in GNU `ustar ` headers those bytes are atime/ctime.
    const prefix = header.subarray(257, 263).toString('latin1') === 'ustar\0' ? cString(header.subarray(345, 500)) : '';
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(cString(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > tar.length) {
      throw new Error(`corrupt tar header at offset ${off}: bad or out-of-range size`);
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(off + 512, off + 512 + size);
    const next = off + 512 + Math.ceil(size / 512) * 512;
    if (next <= off) throw new Error(`corrupt tar header at offset ${off}`);
    off = next;
    if (type === 'L') { longName = cString(data); continue; }
    if (type === 'x' || type === 'g') continue; // pax headers: names we do not need
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') out.push({ name, size, data });
  }
  return out;
}

interface ZipEntry extends ArchiveMember {
  method: number;
  compressedSize: number;
  localOffset: number;
}

function parseZip(zip: Buffer): ZipEntry[] {
  if (zip.length < 22) throw new Error('not a valid zip: too short');
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a valid zip: end-of-central-directory record not found');
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(off + 10);
    const compressedSize = zip.readUInt32LE(off + 20);
    const size = zip.readUInt32LE(off + 24);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const localOffset = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString('utf-8');
    off += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('/')) out.push({ name, size, method, compressedSize, localOffset });
  }
  return out;
}

function readZipEntry(zip: Buffer, e: ZipEntry): Buffer {
  const nameLen = zip.readUInt16LE(e.localOffset + 26);
  const extraLen = zip.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const raw = zip.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
  throw new Error(`zip member '${e.name}' uses unsupported compression method ${e.method}`);
}

function tarBytes(kind: ArchiveKind, bytes: Buffer): Buffer {
  return kind === 'tgz' ? gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES }) : bytes;
}

export function listArchiveMembers(kind: ArchiveKind, bytes: Buffer): ArchiveMember[] {
  if (kind === 'zip') return parseZip(bytes).map(({ name, size }) => ({ name, size }));
  return parseTar(tarBytes(kind, bytes)).map(({ name, size }) => ({ name, size }));
}

export function readArchiveMember(kind: ArchiveKind, bytes: Buffer, member: string): Buffer | null {
  if (kind === 'zip') {
    const e = parseZip(bytes).find(m => m.name === member);
    return e ? readZipEntry(bytes, e) : null;
  }
  const e = parseTar(tarBytes(kind, bytes)).find(m => m.name === member);
  return e ? Buffer.from(e.data) : null;
}
