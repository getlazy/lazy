/**
 * The screenshot lightbox — the highest-traffic interaction on a review page.
 *
 * Screenshots render at the very top of a review, so clicking one is usually
 * the first thing a reviewer does. Opening each in its own tab made that a
 * loop of open-look-close-return; this island keeps the reviewer on the page
 * and lets them walk the whole set with ← / →.
 *
 * PROGRESSIVE ENHANCEMENT. Each thumbnail stays a real `<a href>` to the
 * artifact route with `target="_blank"` — with JS off, a click still shows the
 * picture, exactly as before. The island intercepts the click, which is the
 * same shape as the raised-item permalinks in raised-dialog.ts.
 *
 * NATIVE `<dialog>` + `showModal()`. Focus trapping, inertness of the page
 * behind, `Esc`, and the backdrop are all the platform's, not ours — a
 * hand-rolled trap is the part of a modal that is always subtly wrong. The
 * element is CREATED by the island and appended to `document.body` rather than
 * server-rendered: the card that holds the screenshots is collapsible, and a
 * dialog living inside a collapsed card is a dialog that cannot be seen.
 *
 * Two things the platform will NOT do for a `<dialog>`, both learned here:
 * an author-origin `display` on the element beats the UA's
 * `dialog:not([open]) { display: none }`, so a closed overlay goes on
 * occupying the page (see the styles in review.css, which set none); and the
 * backdrop is only what falls OUTSIDE the element, while the letterbox beside
 * a picture narrower than the stage is inside it — so "click away to close"
 * has to cover the stage as well, which is what most of that reflex hits.
 *
 * THE SET IS THE DOM. Which screenshots a reviewer can page through is read at
 * click time from the thumbnail's own `.rv-shots` container, so a tab swap or
 * an added card needs no re-registration, and two sets on one page stay two
 * sets.
 *
 * NAVIGATION WRAPS. `→` on the last screenshot returns to the first. The
 * position indicator ("3 of 7") is what tells the reviewer where they are, and
 * with it visible, wrapping beats a dead arrow key at each end.
 *
 * FULL SIZE STAYS REACHABLE. The overlay scales an image to fit the viewport,
 * which is the wrong thing for someone who wants to zoom into a detail — so
 * "Open full size" is an explicit link in the overlay. It is no longer what a
 * plain click does, which is the whole point of the change.
 */

/** Attribute marking a thumbnail link the island owns. */
export const SHOT_LINK_ATTR = 'data-lz-shot';

/**
 * Page-level island: intercept thumbnail clicks, drive the overlay.
 *
 * Emitted on every page that can render a screenshots card (the review page
 * and the task page). It costs nothing on a page with no screenshots: the
 * dialog is built on the first click, and there is never a first click.
 */
export function screenshotLightboxScript(): string {
  return `<script>
(function () {
  var LINK = 'a[data-lz-shot]';
  var dialog = null;
  var els = null;
  var shots = [];
  var index = 0;
  var opener = null;

  function build() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'rv-dialog lz-shotbox';
    dialog.id = 'lz-shotbox';
    dialog.setAttribute('aria-label', 'Screenshot viewer');
    dialog.innerHTML =
      '<div class="lz-shotbox-stage">' +
        '<button type="button" class="lz-shotbox-nav lz-shotbox-prev" aria-label="Previous screenshot">&#8249;</button>' +
        '<img class="lz-shotbox-img" alt="">' +
        '<button type="button" class="lz-shotbox-nav lz-shotbox-next" aria-label="Next screenshot">&#8250;</button>' +
      '</div>' +
      '<div class="lz-shotbox-bar">' +
        // One live region over BOTH, so a step announces "3 of 7" and the
        // caption together. Announcing the position alone tells a non-sighted
        // reviewer that they moved but not what to — and the caption is the
        // only description of a screenshot that exists.
        '<div class="lz-shotbox-text" aria-live="polite">' +
        // The space between the two spans is deliberate: the gap between them
        // is CSS, and a reader that concatenates text nodes would otherwise
        // announce "3 of 7The last one".
          '<span class="lz-shotbox-pos"></span> ' +
          '<span class="lz-shotbox-caption"></span>' +
        '</div>' +
        '<div class="lz-shotbox-actions">' +
          '<a class="lz-shotbox-fullsize" target="_blank" rel="noopener">Open full size &#8599;</a>' +
          '<button type="button" class="lz-shotbox-close">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dialog);
    els = {
      stage: dialog.querySelector('.lz-shotbox-stage'),
      img: dialog.querySelector('.lz-shotbox-img'),
      prev: dialog.querySelector('.lz-shotbox-prev'),
      next: dialog.querySelector('.lz-shotbox-next'),
      pos: dialog.querySelector('.lz-shotbox-pos'),
      caption: dialog.querySelector('.lz-shotbox-caption'),
      full: dialog.querySelector('.lz-shotbox-fullsize'),
      close: dialog.querySelector('.lz-shotbox-close')
    };

    els.prev.addEventListener('click', function () { step(-1); });
    els.next.addEventListener('click', function () { step(1); });
    els.close.addEventListener('click', function () { dialog.close(); });

    // Clicking away from the picture closes. That means the backdrop (which
    // targets the dialog element itself) AND the letterbox around an image
    // narrower than the stage — which is INSIDE the dialog, and is most of
    // what a reviewer's click-away reflex actually hits. The image and the
    // controls are not dismiss targets, so they are excluded by being
    // children rather than the target.
    dialog.addEventListener('click', function (ev) {
      if (ev.target === dialog || ev.target === els.stage) dialog.close();
    });

    // Esc is the platform's (it fires 'cancel' then 'close'); the arrows are
    // ours. Bound on the dialog, so they only steer while it is open.
    dialog.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
      else if (ev.key === 'Home') { ev.preventDefault(); show(0); }
      else if (ev.key === 'End') { ev.preventDefault(); show(shots.length - 1); }
    });

    // Focus goes back where it came from, so a keyboard reviewer resumes on
    // the thumbnail they opened rather than at the top of the document.
    dialog.addEventListener('close', function () {
      if (opener && document.contains(opener)) opener.focus();
      opener = null;
    });

    return dialog;
  }

  /** The set a thumbnail belongs to: its own card, or the page when it has no card. */
  function setFor(link) {
    var box = link.closest ? link.closest('.rv-shots') : null;
    var found = (box || document).querySelectorAll(LINK);
    var list = [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      list.push({
        url: el.getAttribute('href') || '',
        caption: el.getAttribute('data-lz-shot-caption') || '',
        el: el
      });
    }
    return list;
  }

  function show(i) {
    if (!shots.length) return;
    var n = shots.length;
    index = ((i % n) + n) % n;
    var shot = shots[index];
    els.img.src = shot.url;
    // The caption IS the alt text: it is the only description of the picture
    // the agent wrote, and a screenshot with no alt is a screenshot a
    // screen-reader user cannot know anything about.
    els.img.alt = shot.caption;
    els.caption.textContent = shot.caption;
    els.full.href = shot.url;
    var many = n > 1;
    els.pos.textContent = many ? (index + 1) + ' of ' + n : '';
    els.prev.hidden = !many;
    els.next.hidden = !many;
  }

  function step(delta) {
    show(index + delta);
  }

  function open(link) {
    build();
    shots = setFor(link);
    if (!shots.length) return false;
    var at = 0;
    for (var i = 0; i < shots.length; i++) if (shots[i].el === link) at = i;
    opener = link;
    show(at);
    if (!dialog.showModal) return false;
    if (!dialog.open) dialog.showModal();
    // Land on Next when there is somewhere to go: the reviewer opened a set to
    // walk it. With one screenshot Next is hidden, so Close takes the focus.
    var first = shots.length > 1 ? els.next : els.close;
    first.focus();
    return true;
  }

  document.addEventListener('click', function (ev) {
    var link = ev.target && ev.target.closest ? ev.target.closest(LINK) : null;
    if (!link) return;
    // Leave every deliberate "somewhere else" alone: middle-click, modified
    // click, an already-handled event.
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    // A browser with no <dialog> support falls through to the link's own
    // target="_blank" — the pre-lightbox behaviour, not a dead click.
    if (!window.HTMLDialogElement || !document.createElement('dialog').showModal) return;
    if (open(link)) ev.preventDefault();
  });
})();
</script>`;
}
