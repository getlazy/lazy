/**
 * E2E: the screenshot lightbox, run in a real browser.
 *
 * The unit suite can only pin an island as text — there is no DOM harness — and
 * the whole point of this island is behaviour a reviewer performs: click a
 * thumbnail, walk the set with the arrow keys, close and land back where you
 * were. So this file loads the REAL card markup and the REAL island in headless
 * Chrome, drives them, and reads the resulting DOM.
 *
 * Esc is deliberately NOT driven here: closing on Esc is the platform's own
 * behaviour for a `showModal()` dialog, and a synthetic KeyboardEvent does not
 * trigger a UA default action, so a test of it would prove nothing. What this
 * file proves instead is that the dialog is opened as a MODAL — which is what
 * brings Esc, the backdrop and the focus trap with it.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { dumpDomOfHtml, browserSuiteSkipped } from '../helpers/page-screenshot';
import { bundledStylesheet } from '../../src/server/styles';
import { screenshotsCardHtml } from '../../src/server/review-presentation';
import { screenshotLightboxScript } from '../../src/server/screenshot-lightbox';

/**
 * Drives the lightbox and writes its findings onto <html> for the DOM dump.
 *
 * Reads state after each step rather than at the end: what matters is the
 * sequence (opened → moved → wrapped → closed), not the final resting state.
 */
const PROBE = `<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var out = {};
    function box() { return document.getElementById('lz-shotbox'); }
    function snap() {
      var d = box();
      if (!d) return { present: false };
      var img = d.querySelector('.lz-shotbox-img');
      return {
        present: true,
        open: !!d.open,
        pos: (d.querySelector('.lz-shotbox-pos').textContent || ''),
        caption: (d.querySelector('.lz-shotbox-caption').textContent || ''),
        alt: img.getAttribute('alt') || '',
        src: img.getAttribute('src') || '',
        full: d.querySelector('.lz-shotbox-fullsize').getAttribute('href') || '',
        navHidden: d.querySelector('.lz-shotbox-next').hidden,
        focusInside: d.contains(document.activeElement),
        // A closed dialog that still has a box is the failure a .open
        // assertion cannot see: it goes on occupying the review page.
        display: getComputedStyle(d).display,
        boxHeight: Math.round(d.getBoundingClientRect().height),
        // What a screen reader is handed when the picture changes.
        live: (d.querySelector('[aria-live]') || { textContent: '' }).textContent.replace(/\\s+/g, ' ').trim()
      };
    }
    function arrow(key) {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
    }

    var sets = document.querySelectorAll('.rv-shots');
    var links = sets[0].querySelectorAll('a[data-lz-shot]');
    out.links = links.length;
    out.beforeClick = snap();

    // A middle screenshot: opening must land on the one that was clicked.
    links[1].click();
    out.opened = snap();

    arrow('ArrowRight');
    out.next = snap();
    arrow('ArrowLeft');
    arrow('ArrowLeft');
    // Two steps back from #3 is #1; one more wraps to the last.
    arrow('ArrowLeft');
    out.wrapped = snap();

    // On-screen controls, not just the keys.
    box().querySelector('.lz-shotbox-next').click();
    out.afterNextButton = snap();

    // The letterbox beside a picture narrower than the stage is INSIDE the
    // dialog, and it is most of what a click-away reflex hits.
    box().querySelector('.lz-shotbox-stage').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.afterStageClick = snap();

    // The dialog's 'close' event is dispatched in a queued task, so focus
    // restoration is one tick away — not a missing restore.
    setTimeout(function () {
      out.focusRestored = document.activeElement === links[1];

      // A second card is a second SET: paging must not walk into it.
      var other = sets[1].querySelector('a[data-lz-shot]');
      other.click();
      out.otherSet = snap();

      // A click whose target IS the dialog is a backdrop click.
      box().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.afterBackdrop = snap();
      out.pageScrollHeight = document.documentElement.scrollHeight;
      out.pageScrollHeightNoDialog = (function () {
        var d = box();
        var parent = d.parentNode;
        parent.removeChild(d);
        var h = document.documentElement.scrollHeight;
        parent.appendChild(d);
        return h;
      })();

      document.documentElement.setAttribute('data-lightbox-probe', JSON.stringify(out));
    }, 50);
  }, 250);
});
</script>`;

interface Snap {
  present: boolean;
  open?: boolean;
  pos?: string;
  caption?: string;
  alt?: string;
  src?: string;
  full?: string;
  navHidden?: boolean;
  focusInside?: boolean;
  display?: string;
  boxHeight?: number;
  live?: string;
}

interface Probe {
  links: number;
  beforeClick: Snap;
  opened: Snap;
  next: Snap;
  wrapped: Snap;
  afterNextButton: Snap;
  afterStageClick: Snap;
  afterBackdrop: Snap;
  focusRestored: boolean;
  otherSet: Snap;
  pageScrollHeight: number;
  pageScrollHeightNoDialog: number;
}

function parseProbe(dom: string): Probe {
  const match = dom.match(/data-lightbox-probe="([^"]*)"/);
  if (!match) throw new Error(`no data-lightbox-probe in dumped DOM:\n${dom.slice(0, 1200)}`);
  const json = match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return JSON.parse(json);
}

function fixtureHtml(): string {
  const many = screenshotsCardHtml('task-shots', [
    { artifact: 'one.png', caption: 'The review page' },
    { artifact: 'two.png', caption: 'The overlay open' },
    { artifact: 'three.png', caption: 'The last one' },
  ]);
  const single = screenshotsCardHtml('task-other', [{ artifact: 'solo.png', caption: 'Alone' }]);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${bundledStylesheet()}</style></head>
<body>
${many}
${single}
${screenshotLightboxScript()}
${PROBE}
</body></html>`;
}

let skip = false;
beforeAll(async () => {
  skip = await browserSuiteSkipped('screenshot lightbox');
});

describe('screenshot lightbox', () => {
  test('opens in place, walks the set, and hands focus back', async () => {
    if (skip) return;
    const probe = parseProbe(await dumpDomOfHtml(fixtureHtml()));

    expect(probe.links).toBe(3);
    // Nothing is built until the first click — a page with no screenshots
    // never pays for the overlay.
    expect(probe.beforeClick.present).toBe(false);

    // Opens on the thumbnail that was clicked, as a modal, with focus inside
    // it (the focus trap is the platform's, and this is the evidence it is on).
    expect(probe.opened.open).toBe(true);
    expect(probe.opened.pos).toBe('2 of 3');
    expect(probe.opened.caption).toBe('The overlay open');
    // INVARIANT: the caption is the image's alt text. It is the only
    // description of the picture the agent wrote.
    expect(probe.opened.alt).toBe('The overlay open');
    expect(probe.opened.focusInside).toBe(true);
    // INVARIANT: the live region carries the position AND the caption, so a
    // step announces where the reviewer is and what they are looking at.
    // Position alone says they moved but not what to.
    expect(probe.opened.live).toBe('2 of 3 The overlay open');
    // Full size stays reachable — as an explicit link, no longer as the click.
    expect(probe.opened.full).toContain('name=two.png');

    expect(probe.next.pos).toBe('3 of 3');
    expect(probe.next.caption).toBe('The last one');
    expect(probe.next.live).toBe('3 of 3 The last one');
    // → past the end and ← past the start both wrap: with the position
    // indicator on screen, wrapping beats a dead arrow key.
    expect(probe.wrapped.pos).toBe('3 of 3');
    expect(probe.afterNextButton.pos).toBe('1 of 3');

    // A click on the letterbox beside the picture closes — that strip is
    // inside the dialog, and it is most of what a click-away reflex hits.
    expect(probe.afterStageClick.open).toBe(false);
    expect(probe.focusRestored).toBe(true);

    // INVARIANT: a closed overlay occupies NOTHING. An author-origin `display`
    // on the dialog element beats the UA's `dialog:not([open]) { display: none }`,
    // and the symptom is invisible to `.open`, to text and to focus: the
    // reviewer closes a screenshot and a viewport-sized image, its arrows and
    // its caption bar stay laid out at the bottom of the review, once per close.
    expect(probe.afterStageClick.display).toBe('none');
    expect(probe.afterStageClick.boxHeight).toBe(0);
    expect(probe.afterBackdrop.open).toBe(false);
    expect(probe.afterBackdrop.display).toBe('none');
    expect(probe.afterBackdrop.boxHeight).toBe(0);
    // Belt and braces, measured rather than inferred: taking the closed dialog
    // out of the document changes the page's height by nothing.
    expect(probe.pageScrollHeight).toBe(probe.pageScrollHeightNoDialog);

    // A lone screenshot shows no nav and no position — there is nowhere to go.
    expect(probe.otherSet.open).toBe(true);
    expect(probe.otherSet.caption).toBe('Alone');
    expect(probe.otherSet.pos).toBe('');
    expect(probe.otherSet.navHidden).toBe(true);
  }, 90_000);
});
