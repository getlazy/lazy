/**
 * Autosave for a review in progress, shared by the diff review page and the
 * builder review-session page.
 *
 * WHY IT IS SHARED
 * Both pages hold words the reviewer has typed and not yet sent, and both used
 * to hold them in the DOM only: navigating away, opening the task in a second
 * tab, or picking the review back up on another machine started from an empty
 * box. Unsent words are human feedback (CLAUDE.md: never lose it), so they are
 * patched onto the task through the daemon instead — one endpoint, one debounce,
 * one way of telling the reviewer when a save failed.
 *
 * WHAT IT DOES
 * Every element carrying `data-rv-draft="<field>"` autosaves its value into that
 * field of the task's review draft, debounced, and flushed when the page is
 * hidden or unloaded so the last keystrokes before a navigation are usually not
 * the ones that get dropped. It exposes `window.lazyReviewDraftSave(patch)` for
 * state that is not a form field (the diff page's viewed ticks).
 *
 * The unload flush is a best effort, NOT a guarantee: `keepalive` requests are
 * capped at 64 KiB of body by the Fetch standard, and a browser may still drop
 * one. The short debounce is what actually keeps losses to the last fraction of
 * a second — the flush only narrows that window further.
 *
 * PATCH, NEVER REPLACE: a field the caller does not name is left exactly as it
 * was, so the feedback box autosaving cannot blank an accept reason typed in
 * another tab.
 *
 * With JS off none of this runs, and nothing is lost: the unblock, accept and
 * session-send routes persist what was submitted BEFORE they attempt anything.
 */

import { scriptJson } from './escape';

/** The `<script>` tag, ready to inline. Emit it before any island that uses it. */
export function reviewDraftScript(taskId: string): string {
  return `<script>
(function () {
  var TASK = ${scriptJson(taskId)};
  var pending = null;
  var timer = null;

  function show(text, failed) {
    var indicators = document.querySelectorAll('[data-rv-draft-state]');
    for (var i = 0; i < indicators.length; i++) {
      indicators[i].textContent = text;
      indicators[i].dataset.state = failed ? 'error' : 'ok';
    }
  }

  function flush(leaving) {
    if (!pending) return;
    var body = JSON.stringify({ patch: pending });
    pending = null;
    if (timer) { clearTimeout(timer); timer = null; }
    // TASK is the URL-ESCAPED segment the server stamped (scriptJson of
    // taskPathSegment) — interpolate raw; a second escape turns %20 into
    // %2520, a different address.
    fetch('/tasks/' + TASK + '/review/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      // The page may be unloading; without this the browser is free to cancel
      // the request carrying the last thing that was typed. It improves the
      // odds rather than guaranteeing delivery — see the 64 KiB cap above.
      keepalive: !!leaving,
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { return null; });
      })
      .then(function (body) {
        // A patch can be PARTLY stored: an over-limit comment box is refused on
        // its own so the rest of the patch still saves. Saying "Draft saved"
        // over that would be the mute failure the split exists to remove.
        if (body && body.warning) show(body.warning, true);
        else show('Draft saved', false);
      })
      .catch(function (err) {
        // Never silent: the words are still in the textarea, and the reviewer
        // has to know that is the only place they are.
        show('Draft NOT saved — keep this tab open', true);
        if (window.console) console.warn('review draft autosave failed', err);
      });
  }

  window.lazyReviewDraftSave = function (patch) {
    pending = pending || {};
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      // lineDrafts is the one field whose patch is PARTIAL — one anchor per
      // save, so that a second tab's autosave cannot erase this tab's boxes
      // (and the daemon merges it the same way). Two saves inside one debounce
      // window therefore have to be merged here as well: overwriting would
      // drop the anchor named by the first, and dropping it is losing what was
      // typed into that box. Every other field is a whole value: replace.
      if (k === 'lineDrafts' && pending[k] && patch[k] && typeof patch[k] === 'object') {
        for (var anchor in patch[k]) {
          if (Object.prototype.hasOwnProperty.call(patch[k], anchor)) pending[k][anchor] = patch[k][anchor];
        }
      } else {
        pending[k] = patch[k];
      }
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { flush(false); }, 600);
  };

  window.addEventListener('pagehide', function () { flush(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });

  // Delegation, not a one-shot query: in-place tab switches insert new
  // draft fields, and a bound-at-load list would miss them.
  document.addEventListener('input', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-rv-draft]') : null;
    if (!el) return;
    var patch = {};
    patch[el.dataset.rvDraft] = el.value;
    window.lazyReviewDraftSave(patch);
  });
})();
</script>`;
}
