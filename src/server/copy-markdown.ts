/**
 * The Copy control on every card that renders markdown from a stored source.
 *
 * The card shows RENDERED markdown, and selecting it copies plain text that has
 * lost its headings, lists, fences and links. This button copies the markdown
 * SOURCE the card was rendered from, byte for byte. The daemon puts that source
 * on the page itself (JSON-encoded, then HTML-escaped, in a data attribute);
 * the client never re-derives it from the rendered DOM.
 *
 * JSON rather than the raw string because the HTML parser normalises CR/CRLF in
 * attribute values, and the source must survive exactly. HTML-escaping on top
 * keeps a hostile source (`"><script>`) inert in the attribute.
 */

import { escapeHtml } from './escape';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';

/** The button for one card. Place it beside the card's rendered body. */
export function copyMarkdownButtonHtml(source: string): string {
  // Nothing to copy: an empty card must not offer a button that reports "Copied" for an empty string.
  if (!source.trim()) return '';
  return `<button type="button" class="md-copy" data-copy-md="${escapeHtml(JSON.stringify(source))}" ` +
    `aria-label="Copy markdown source" title="Copy markdown source" aria-live="polite">Copy</button>`;
}

/**
 * The one page-wide handler (delegated, so cards that arrive later in a tab
 * fragment work too). Prefers the async clipboard API; falls back to a hidden
 * textarea + execCommand where there is no secure context (plain-http dashboard
 * access off localhost). Shows "Copied" or "Copy failed" briefly.
 */
export function copyMarkdownScript(): string {
  return `<script>
(function () {
  (window.lzOnce || function (k, f) { f(); })('copy-markdown', function () {
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok ? Promise.resolve() : Promise.reject(new Error('execCommand copy refused'));
    }
    function copy(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
      }
      return fallbackCopy(text);
    }
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.md-copy') : null;
      if (!btn) return;
      ev.preventDefault();
      var text;
      try { text = JSON.parse(btn.getAttribute('data-copy-md') || '""'); } catch (e) { text = null; }
      if (typeof text !== 'string') { flash(btn, 'Copy failed', true); return; }
      copy(text).then(function () { flash(btn, 'Copied', false); },
                      function () { flash(btn, 'Copy failed', true); });
    });
    function flash(btn, label, bad) {
      if (btn.__mdTimer) clearTimeout(btn.__mdTimer);
      btn.textContent = label;
      btn.classList.toggle('md-copy-bad', bad);
      btn.__mdTimer = setTimeout(function () {
        btn.textContent = 'Copy';
        btn.classList.remove('md-copy-bad');
      }, 1500);
    }
  });
})();
</script>`;
}

/** The common case: the Copy button, then the source rendered, for a body container. */
export function renderMarkdownWithCopy(source: string, options?: RenderMarkdownOptions): string {
  return copyMarkdownButtonHtml(source) + renderMarkdown(source, options);
}
