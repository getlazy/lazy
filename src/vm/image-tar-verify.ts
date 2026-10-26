/**
 * Verify a `docker save` tar on the host before a fleet boots from it: every
 * content-addressed blob in it must hash to its own name. The image was built
 * on a smolvm machine's disk and crossed to the host over virtiofs — both
 * places where bytes have gone wrong before (src/daemon/machine-integrity.ts) —
 * so a tar is trusted only once it re-hashes here.
 *
 * Both layouts `docker save` writes are read: the OCI one (`blobs/sha256/<hex>`)
 * and the legacy one (`<hex>.json` config). A tar with no `manifest.json`, or
 * with nothing it could verify, is refused rather than waved through.
 */
import { createReadStream } from 'fs';
import { createHash, type Hash } from 'crypto';

export interface TarVerification { verifiedBlobs: number; hasManifest: boolean }

const OCI_BLOB = /^(?:\.\/)?blobs\/sha256\/([0-9a-f]{64})$/;
const LEGACY_CONFIG = /^(?:\.\/)?([0-9a-f]{64})\.json$/;

function parseOctal(field: Buffer): number {
  // GNU base-256 for sizes past 8 GiB.
  if (field[0]! & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let rest = body.toString('utf8');
  while (rest.length) {
    const space = rest.indexOf(' ');
    if (space < 0) break;
    const len = parseInt(rest.slice(0, space), 10);
    if (!len) break;
    const record = rest.slice(space + 1, len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    rest = rest.slice(len);
  }
  return out;
}

export async function verifyImageTar(path: string): Promise<TarVerification> {
  let buf: Buffer = Buffer.alloc(0);
  let state: 'header' | 'body' | 'pad' = 'header';
  let remaining = 0;
  let pad = 0;
  let name = '';
  let typeflag = '';
  let hash: Hash | null = null;
  let expect = '';
  let paxBody: Buffer[] = [];
  let pax: Record<string, string> = {};
  let verifiedBlobs = 0;
  let hasManifest = false;
  let done = false;
  const files = new Set<string>();
  let manifestBody: Buffer[] | null = null;

  const finishEntry = () => {
    if (typeflag === 'x') pax = parsePax(Buffer.concat(paxBody));
    else if (typeflag === 'g') { /* global pax header: nothing lazy reads */ }
    else {
      if (hash) {
        const got = hash.digest('hex');
        if (got !== expect) throw new Error(`${path}: ${name} hashes to sha256:${got}, not the digest it is named for — the image is damaged; build it again`);
        verifiedBlobs++;
      }
      pax = {};
    }
    hash = null; paxBody = [];
  };

  for await (const chunk of createReadStream(path)) {
    buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
    while (!done) {
      if (state === 'header') {
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (header.every((b) => b === 0)) { done = true; break; }
        const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
        typeflag = String.fromCharCode(header[156]!) .replace('\0', '0');
        remaining = pax.size ? Number(pax.size) : parseOctal(header.subarray(124, 136));
        name = pax.path ?? (prefix ? `${prefix}/${rawName}` : rawName);
        pad = (512 - (remaining % 512)) % 512;
        hash = null; expect = '';
        if (typeflag === '0' || typeflag === '7') {
          const n = name.replace(/^\.\//, '');
          files.add(n);
          if (n === 'manifest.json') { hasManifest = true; manifestBody = []; }
          const m = OCI_BLOB.exec(name) ?? LEGACY_CONFIG.exec(name);
          if (m) { hash = createHash('sha256'); expect = m[1]!; }
        }
        state = 'body';
        if (remaining === 0) { finishEntry(); state = pad ? 'pad' : 'header'; }
      } else if (state === 'body') {
        if (!buf.length) break;
        const take = Math.min(remaining, buf.length);
        const part = buf.subarray(0, take);
        if (hash) (hash as Hash).update(part);
        if (typeflag === 'x') paxBody.push(Buffer.from(part));
        if (manifestBody && name.replace(/^\.\//, '') === 'manifest.json') manifestBody.push(Buffer.from(part));
        buf = buf.subarray(take);
        remaining -= take;
        if (remaining === 0) { finishEntry(); state = pad ? 'pad' : 'header'; }
      } else {
        if (buf.length < pad) { pad -= buf.length; buf = Buffer.alloc(0); break; }
        buf = buf.subarray(pad); pad = 0; state = 'header';
      }
    }
    if (done) break;
  }
  if (state === 'body' && remaining > 0) throw new Error(`${path}: the tar ends inside ${name} — it was cut short; build it again`);
  if (!hasManifest) throw new Error(`${path}: no manifest.json — not a \`docker save\` image tar`);
  // Every file the manifest names must be in the tar: a missing layer would otherwise surface only at machine boot.
  let manifest: Array<{ Config?: string; Layers?: string[] }>;
  try { manifest = JSON.parse(Buffer.concat(manifestBody ?? []).toString('utf8')); }
  catch (err) { throw new Error(`${path}: manifest.json does not parse: ${(err as Error).message}`); }
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    for (const named of [entry.Config, ...(entry.Layers ?? [])]) {
      if (named && !files.has(named.replace(/^\.\//, ''))) throw new Error(`${path}: manifest.json names ${named}, which the tar does not hold — the image is incomplete; build it again`);
    }
  }
  if (verifiedBlobs === 0) throw new Error(`${path}: holds no content-addressed blob to verify, so nothing in it could be checked`);
  return { verifiedBlobs, hasManifest };
}
