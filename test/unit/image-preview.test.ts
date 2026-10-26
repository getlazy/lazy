import { describe, test, expect } from 'bun:test';
import {
  MAX_IMAGE_PREVIEW_BYTES,
  classifyImageBlob,
  imageBlobHeaders,
  imagePreviewFor,
  imageTypeForPath,
} from '../../src/review/image-preview';
import { parseUnifiedDiff, renderReviewDiff } from '../../src/server/review-diff';
import { solidPng } from '../helpers/png';

const bytes = (s: string) => new TextEncoder().encode(s);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = bytes('GIF89a\x01\x00\x01\x00');
const WEBP = new Uint8Array([...bytes('RIFF'), 0, 0, 0, 0, ...bytes('WEBPVP8 ')]);
const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...bytes('ftypavif'), 0, 0, 0, 0]);

describe('image preview detection', () => {
  test('recognises each format by extension, case-insensitively', () => {
    expect(imageTypeForPath('a/b.PNG')).toBe('image/png');
    expect(imageTypeForPath('x.jpeg')).toBe('image/jpeg');
    expect(imageTypeForPath('x.jpg')).toBe('image/jpeg');
    expect(imageTypeForPath('x.gif')).toBe('image/gif');
    expect(imageTypeForPath('x.webp')).toBe('image/webp');
    expect(imageTypeForPath('x.avif')).toBe('image/avif');
    expect(imageTypeForPath('x.svg')).toBe('image/svg+xml');
    expect(imageTypeForPath('x.bmp')).toBeNull();
    expect(imageTypeForPath('png')).toBeNull();
    expect(imageTypeForPath('.png')).toBeNull();
  });

  test('accepts bytes that match their extension', () => {
    expect(classifyImageBlob('a.png', solidPng(2, 2, [255, 0, 0]))).toEqual({ ok: true, contentType: 'image/png' });
    expect(classifyImageBlob('a.jpg', JPEG)).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(classifyImageBlob('a.gif', GIF)).toEqual({ ok: true, contentType: 'image/gif' });
    expect(classifyImageBlob('a.webp', WEBP)).toEqual({ ok: true, contentType: 'image/webp' });
    expect(classifyImageBlob('a.avif', AVIF)).toEqual({ ok: true, contentType: 'image/avif' });
    expect(classifyImageBlob('a.svg', bytes('<?xml version="1.0"?>\n<!-- hi -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')))
      .toEqual({ ok: true, contentType: 'image/svg+xml' });
  });

  // INVARIANT: the bytes, not the name, decide what is served. A task branch is
  // agent-written, so `logo.png` may hold HTML, and `icon.svg` may be a page.
  test('refuses bytes that do not match their extension', () => {
    expect(classifyImageBlob('a.png', JPEG)).toMatchObject({ ok: false, status: 415 });
    expect(classifyImageBlob('a.png', bytes('<html><script>alert(1)</script>'))).toMatchObject({ ok: false, status: 415 });
    expect(classifyImageBlob('a.svg', bytes('<html><body><svg/></body></html>'))).toMatchObject({ ok: false, status: 415 });
    expect(classifyImageBlob('a.webp', bytes('RIFF....AVI '))).toMatchObject({ ok: false, status: 415 });
    expect(classifyImageBlob('a.txt', solidPng(1, 1, [0, 0, 0]))).toMatchObject({ ok: false, status: 415 });
  });

  test('refuses a blob over the cap', () => {
    const big = new Uint8Array(MAX_IMAGE_PREVIEW_BYTES + 1);
    big.set(solidPng(1, 1, [0, 0, 0]));
    expect(classifyImageBlob('big.png', big)).toMatchObject({ ok: false, status: 413 });
  });

  // INVARIANT: an agent-written SVG opened on its own must not run script on
  // the app's origin — the type is never sniffed and the document is sandboxed.
  test('serving headers pin the type and sandbox the document', () => {
    const h = imageBlobHeaders('image/svg+xml');
    expect(h['Content-Type']).toBe('image/svg+xml');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });

  test('a parsed diff yields one slot per image file, by kind of change', () => {
    const diff = [
      'diff --git a/added.png b/added.png', 'new file mode 100644', 'index 0000000..1111111',
      'Binary files /dev/null and b/added.png differ',
      'diff --git a/gone.png b/gone.png', 'deleted file mode 100644', 'index 1111111..0000000',
      'Binary files a/gone.png and /dev/null differ',
      'diff --git a/shot.png b/shot.png', 'index 1111111..2222222 100644',
      'Binary files a/shot.png and b/shot.png differ',
      'diff --git a/old.png b/new.png', 'similarity index 90%', 'rename from old.png', 'rename to new.png',
      'Binary files a/old.png and b/new.png differ',
      'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-a', '+b',
      '',
    ].join('\n');
    const slots = parseUnifiedDiff(diff).map(imagePreviewFor);
    expect(slots).toEqual([
      { path: 'added.png', oldPath: null, hasNew: true, hasOld: false, change: 'added' },
      { path: 'gone.png', oldPath: 'gone.png', hasNew: false, hasOld: true, change: 'deleted' },
      { path: 'shot.png', oldPath: 'shot.png', hasNew: true, hasOld: true, change: 'modified' },
      { path: 'new.png', oldPath: 'old.png', hasNew: true, hasOld: true, change: 'modified' },
      null,
    ]);
  });

  // INVARIANT: a binary file's "Viewed" fingerprint changes when its bytes do —
  // a retaken screenshot must come back unviewed, not hide behind an old tick.
  test('a binary file hashes by its blob ids', () => {
    const diff = (ids: string) => `diff --git a/s.png b/s.png\nindex ${ids} 100644\nBinary files a/s.png and b/s.png differ\n`;
    const hash = (ids: string) => /data-content-hash="([^"]+)"/.exec(renderReviewDiff(parseUnifiedDiff(diff(ids)), new Map()))![1];
    expect(hash('1111111..2222222')).not.toBe(hash('1111111..3333333'));
  });
});
