/**
 * Which files of a task's diff are shown as pictures, and whether a blob's
 * bytes really are the picture its name says.
 *
 * ONE RULE for every surface: the daemon's dashboard renders from it directly,
 * and Lazy Teams receives its answer (`imagePreviews` beside the diff) rather
 * than keeping its own extension list.
 *
 * Two checks, deliberately in two places:
 *  - the EXTENSION decides, at render time, that a file gets an image slot —
 *    the page has no bytes yet, and images load only when looked at;
 *  - the CONTENT decides, at serve time, that the bytes are served at all. A
 *    `.png` whose bytes are not a PNG is refused (415), and the slot falls back
 *    to "Binary file — not shown". The served Content-Type is the one the
 *    extension names and the bytes confirmed — never a browser's sniff.
 *
 * Pure: no git, no daemon, no web layer, so the detection is unit-testable.
 */

/** Largest blob served for preview. Above it the slot says "too large to preview". */
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** The image type a path's extension names, or null for anything else. */
export function imageTypeForPath(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Do these bytes carry the signature of `type`? */
export function bytesMatchImageType(bytes: Uint8Array, type: string): boolean {
  switch (type) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'));
    case 'image/webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
    case 'image/avif':
      // ISO-BMFF: `ftyp` box at offset 4, major brand avif/avis.
      return startsWith(bytes, ascii('ftyp'), 4) &&
        (startsWith(bytes, ascii('avif'), 8) || startsWith(bytes, ascii('avis'), 8));
    case 'image/svg+xml':
      return looksLikeSvg(bytes);
    default:
      return false;
  }
}

/**
 * An SVG is text: after an optional BOM, XML declaration, comments and a
 * DOCTYPE, the first element must be `<svg`. Anything else — HTML, a script, a
 * PNG renamed `.svg` — is not served as an SVG.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  text = text.replace(/^\uFEFF/, '');
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, '')
      .replace(/^<\?xml[\s\S]*?\?>/, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .replace(/^<!DOCTYPE[^>]*>/i, '');
    if (text === before) break;
  }
  return /^<svg[\s>/]/.test(text);
}

export type ImageBlobVerdict =
  | { ok: true; contentType: string }
  | { ok: false; status: 413 | 415; error: string };

/** May these bytes, read from `path`, be served as an image preview? */
export function classifyImageBlob(path: string, bytes: Uint8Array): ImageBlobVerdict {
  const type = imageTypeForPath(path);
  if (!type) return { ok: false, status: 415, error: `Not an image file type: ${path}` };
  if (bytes.length > MAX_IMAGE_PREVIEW_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Too large to preview: ${path} is ${bytes.length} bytes, the limit is ${MAX_IMAGE_PREVIEW_BYTES}.`,
    };
  }
  if (!bytesMatchImageType(bytes, type)) {
    return { ok: false, status: 415, error: `Contents of ${path} are not a ${type} image.` };
  }
  return { ok: true, contentType: type };
}

/**
 * Headers for serving a preview blob. The page renders it only through
 * `<img>`, where an SVG's script never runs; these cover the blob opened on its
 * own, as a top-level document on the app's origin.
 */
export function imageBlobHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
  };
}

/** The image slot one diff file gets: which sides exist and where they live. */
export interface ImagePreview {
  path: string;
  /** Pre-image path (differs from `path` on a rename); null when the file was added. */
  oldPath: string | null;
  /** The post-image exists (null side on a delete). */
  hasNew: boolean;
  hasOld: boolean;
  /** `added` | `deleted` | `modified`. */
  change: 'added' | 'deleted' | 'modified';
}

/** The fields of a parsed diff file this rule reads — kept structural so any parser fits. */
export interface ImageDiffFileLike {
  path: string;
  oldPath: string | null;
  added?: boolean;
  deleted?: boolean;
}

/** The image slot for a diff file, or null when it is not an image. */
export function imagePreviewFor(file: ImageDiffFileLike): ImagePreview | null {
  const newType = imageTypeForPath(file.path);
  const oldPath = file.added ? null : (file.oldPath ?? file.path);
  const oldType = oldPath ? imageTypeForPath(oldPath) : null;
  if (!newType && !oldType) return null;
  const hasNew = !file.deleted && newType !== null;
  const hasOld = oldPath !== null && oldType !== null;
  if (!hasNew && !hasOld) return null;
  const change = file.added ? 'added' : file.deleted ? 'deleted' : 'modified';
  return { path: file.path, oldPath: hasOld ? oldPath : null, hasNew, hasOld, change };
}
