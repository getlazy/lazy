/**
 * "Press ⌘K" vs "press Ctrl+K" — the browser is the only thing that knows.
 *
 * The server renders the same HTML for a Mac and a Linux box, so any shortcut
 * spelled on the server is wrong for somebody. Every dashboard surface that
 * names the palette chord therefore renders {@link MODIFIER_KEY_FALLBACK} as
 * its no-JS text and marks the element for this island, which rewrites it once
 * per page with the platform's real key.
 *
 * Three markers, because a shortcut shows up in three places:
 * - `data-lz-modkey` — the element's TEXT is the chord (`⌘K`).
 * - `data-lz-modkey-title="…%s…"` — `%s` in the tooltip is the chord.
 * - `data-lz-modkey-placeholder="…%s…"` — same, for an input's placeholder.
 *
 * The fallback is the honest both-platforms spelling rather than a guess: with
 * scripting off the human reads `Ctrl/Cmd+K` and is never told the wrong key.
 */

/** What the server renders before the browser tells us which platform it is. */
export const MODIFIER_KEY_FALLBACK = 'Ctrl/Cmd+K';

/**
 * Rewrites every marked shortcut with the platform's key. Emitted from the
 * shared layout, so a new page gets it by existing — no per-page opt-in.
 */
export function modifierKeyScript(): string {
  return `<script>
    (function() {
      // userAgentData.platform is the modern answer; navigator.platform is the
      // one that still works everywhere. Neither is spoofing-proof and neither
      // needs to be — being wrong here costs a mislabelled key, not a bug.
      var p = '';
      try {
        p = (navigator.userAgentData && navigator.userAgentData.platform)
          || navigator.platform || '';
      } catch (e) { /* no platform hint; the Ctrl spelling is the safer default */ }
      var mac = /mac|iphone|ipad|ipod/i.test(p);
      var key = mac ? '⌘K' : 'Ctrl+K';
      var text = document.querySelectorAll('[data-lz-modkey]');
      for (var i = 0; i < text.length; i++) text[i].textContent = key;
      function fill(attr, apply) {
        var els = document.querySelectorAll('[' + attr + ']');
        for (var j = 0; j < els.length; j++) {
          apply(els[j], els[j].getAttribute(attr).replace('%s', key));
        }
      }
      fill('data-lz-modkey-title', function(el, v) { el.setAttribute('title', v); });
      fill('data-lz-modkey-placeholder', function(el, v) { el.setAttribute('placeholder', v); });
    })();
  </script>`;
}
