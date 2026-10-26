/**
 * The dashboard's before/after pictures for an image file in a task diff.
 *
 * WHICH files get one is `imagePreviewFor` (src/review/image-preview.ts), the
 * rule Lazy Teams receives too. The bytes come from the daemon's `diffBlob`
 * read, served by `/api/review/:id/blob` with the image's own type, `nosniff`
 * and a sandbox CSP. They are drawn ONLY through `<img>`, where an SVG's
 * script never runs — never inline, `<object>` or `<iframe>`.
 *
 * `loading="lazy"`, and a collapsed file hides the pane (display: none), so a
 * picture is fetched only once its file is open and scrolled into view.
 */

import type { ImagePreview } from '../review/image-preview';
import { escapeHtml } from './escape';

const CHANGE_LABEL: Record<ImagePreview['change'], string> = {
  added: 'image added',
  deleted: 'image deleted',
  modified: 'image changed',
};

/** The header stat that replaces an image's dishonest `+0 −0`. */
export function imageStatHtml(preview: ImagePreview): string {
  return `<span class="rv-stat rv-stat-image">${CHANGE_LABEL[preview.change]}</span>`;
}

function blobSrc(blobUrl: string, path: string, side: 'base' | 'head'): string {
  return `${blobUrl}?path=${encodeURIComponent(path)}&side=${side}`;
}

function sideHtml(label: string, src: string, alt: string): string {
  return (
    `<figure class="rv-image-side">` +
    `<figcaption>${escapeHtml(label)}</figcaption>` +
    `<div class="rv-image-frame"><img loading="lazy" decoding="async" data-rv-image` +
    ` src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"></div>` +
    `<p class="rv-image-meta" data-rv-image-meta></p>` +
    `</figure>`
  );
}

/** The pane: added → the new image, deleted → the old, modified → both. */
export function imagePreviewHtml(preview: ImagePreview, blobUrl: string): string {
  const sides: string[] = [];
  if (preview.hasOld && preview.oldPath) {
    sides.push(sideHtml(preview.hasNew ? 'Before' : 'Deleted', blobSrc(blobUrl, preview.oldPath, 'base'), `Before: ${preview.oldPath}`));
  }
  if (preview.hasNew) {
    sides.push(sideHtml(preview.hasOld ? 'After' : 'Added', blobSrc(blobUrl, preview.path, 'head'), `After: ${preview.path}`));
  }
  return `<div class="rv-image${sides.length === 2 ? ' rv-image-pair' : ''}" data-rv-image-pane>${sides.join('')}</div>`;
}

/**
 * One island for every picture on the page, including cards the progressive
 * loader adds later: `load` and `error` do not bubble, so it listens in the
 * capture phase. A loaded picture is labelled with its pixel and file size; a
 * refused one is replaced by the daemon's reason — "too large to preview", or
 * "Binary file — not shown" when the bytes were not the image they claimed.
 */
export function imagePreviewScript(): string {
  return `<script>
(function () {
  if (window.__lzImagePreview) return;
  window.__lzImagePreview = true;
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function meta(img) {
    var fig = img.closest('figure');
    return fig && fig.querySelector('[data-rv-image-meta]');
  }
  function onLoad(img) {
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-rv-image')) return;
    var m = meta(img);
    if (!m) return;
    var parts = [];
    if (img.naturalWidth) parts.push(img.naturalWidth + ' × ' + img.naturalHeight + ' px');
    var entry = performance.getEntriesByName(img.currentSrc || img.src)[0];
    if (entry && entry.decodedBodySize) parts.push(fmt(entry.decodedBodySize));
    m.textContent = parts.join(' · ');
  }
  function onError(img) {
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-rv-image') || !img.isConnected) return;
    var m = meta(img);
    var frame = img.parentNode;
    var src = img.src;
    img.remove();
    if (m) m.textContent = 'Loading the preview failed.';
    fetch(src, { credentials: 'same-origin' }).then(function (r) {
      return r.status === 413 ? 'Too large to preview.' :
        r.status === 415 ? 'Binary file — not shown.' :
        r.json().then(function (j) { return j.error || ('Preview unavailable (' + r.status + ').'); },
          function () { return 'Preview unavailable (' + r.status + ').'; });
    }).catch(function () { return 'Preview unavailable.'; }).then(function (msg) {
      if (frame) frame.hidden = true;
      if (m) m.textContent = msg;
    });
  }
  document.addEventListener('load', function (e) { onLoad(e.target); }, true);
  document.addEventListener('error', function (e) { onError(e.target); }, true);
  // Pictures that settled before this island ran fired their events to nobody.
  document.querySelectorAll('img[data-rv-image]').forEach(function (img) {
    if (!img.complete) return;
    if (img.naturalWidth > 0) onLoad(img); else onError(img);
  });
})();
</script>`;
}
