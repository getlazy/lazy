/**
 * The screenshot lightbox contract that a browser test cannot state.
 *
 * The behaviour — open, page, close, restore focus — is driven for real in
 * `test/e2e/screenshot-lightbox.test.ts`. What lives here is the shape of the
 * markup the island depends on, the progressive-enhancement fallback, and the
 * mechanical rule that a page rendering screenshots also ships the island.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

import { screenshotsCardHtml } from '../../src/server/review-presentation';
import { screenshotLightboxScript } from '../../src/server/screenshot-lightbox';

const SERVER_DIR = join(import.meta.dir, '../../src/server');

describe('screenshot thumbnails', () => {
  // INVARIANT: a thumbnail stays a real link to the full-size artifact. The
  // lightbox is an interception of that link, so with JS off (or in a browser
  // without <dialog>) a click still shows the picture instead of doing nothing.
  test('each thumbnail is a real link the island can intercept', () => {
    const html = screenshotsCardHtml('task-1', [
      { artifact: 'shots/ui.png', caption: 'Settings page' },
    ]);
    expect(html).toContain('href="/api/review/task-1/artifact?name=shots%2Fui.png"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('data-lz-shot ');
    expect(html).toContain('data-lz-shot-caption="Settings page"');
    expect(html).toContain('aria-label="View screenshot: Settings page"');
  });

  // The caption is the only description of the picture that exists, so it is
  // what both the thumbnail's alt text and the overlay's alt text say. A
  // caption-less screenshot falls back to the artifact name rather than to ''.
  test('the caption is the alt text, with the artifact name as the fallback', () => {
    const withCaption = screenshotsCardHtml('t', [{ artifact: 'a.png', caption: 'The overlay' }]);
    expect(withCaption).toContain('alt="The overlay"');
    expect(withCaption).toContain('data-lz-shot-caption="The overlay"');
    const without = screenshotsCardHtml('t', [{ artifact: 'a.png' }]);
    expect(without).toContain('alt="a.png"');
    expect(without).toContain('data-lz-shot-caption="a.png"');
  });

  // An affordance nobody is told about is one nobody uses, and this card's
  // hint line is the only place the arrow keys are named.
  test('the card says a click opens in place and the arrows walk the set', () => {
    const html = screenshotsCardHtml('t', [{ artifact: 'a.png', caption: 'One' }]);
    expect(html).toContain('Click a screenshot to open it here');
    expect(html).toContain('&larr; / &rarr;');
  });

  // Caption text reaches an attribute as well as the body, so an unescaped
  // quote would break out of it.
  test('a caption with quotes does not escape its attribute', () => {
    const html = screenshotsCardHtml('t', [{ artifact: 'a.png', caption: 'The "big" button' }]);
    expect(html).toContain('data-lz-shot-caption="The &quot;big&quot; button"');
    expect(html).not.toContain('data-lz-shot-caption="The "big"');
  });
});

describe('the lightbox island', () => {
  // Modal, not `open`: showModal() is what brings the focus trap, the inert
  // page behind, the backdrop and Esc — none of which is hand-rolled here.
  test('opens the overlay as a modal dialog', () => {
    const js = screenshotLightboxScript();
    expect(js).toContain('dialog.showModal()');
    expect(js).toContain("dialog.addEventListener('close'");
    expect(js).toContain('opener.focus()');
  });

  // "Click outside the image" has to mean the letterbox too: that strip is
  // inside the dialog, so a backdrop-only rule leaves most of a click-away
  // reflex landing on dead space.
  test('dismisses on the backdrop and on the letterbox beside the picture', () => {
    const js = screenshotLightboxScript();
    expect(js).toContain('ev.target === dialog || ev.target === els.stage');
  });

  // The position without the caption tells a non-sighted reviewer that they
  // moved but not what to, so one live region covers both.
  test('announces the position and the caption as one live region', () => {
    const js = screenshotLightboxScript();
    expect(js).toContain('<div class="lz-shotbox-text" aria-live="polite">');
    expect(js).not.toContain('lz-shotbox-pos" aria-live');
  });

  // A modified click is a deliberate "somewhere else" and must keep working:
  // ctrl/cmd-click is how a reviewer opens one screenshot in a background tab.
  test('leaves modified and non-primary clicks to the browser', () => {
    const js = screenshotLightboxScript();
    expect(js).toContain('ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey');
    expect(js).toContain('ev.button !== 0');
  });

  // The full-size view is kept, demoted from the default click to a link.
  test('keeps a full-size escape hatch in its own tab', () => {
    expect(screenshotLightboxScript()).toContain('lz-shotbox-fullsize');
    expect(screenshotLightboxScript()).toContain('target="_blank" rel="noopener"');
  });
});

/**
 * INVARIANT: a page that can render the screenshots card also ships the
 * lightbox island. Mechanical, not a hand-kept list: without the island the
 * card silently reverts to opening a new tab per screenshot — the exact
 * behaviour this replaced, and nothing would fail.
 */
describe('every page rendering screenshots ships the island', () => {
  test('screenshotsCardHtml and screenshotLightboxScript travel together', async () => {
    const files = (await readdir(SERVER_DIR)).filter((f) => f.endsWith('.ts'));
    const missing: string[] = [];
    for (const file of files) {
      if (file === 'review-presentation.ts') continue; // defines the card
      const src = await readFile(join(SERVER_DIR, file), 'utf8');
      if (!src.includes('screenshotsCardHtml(')) continue;
      if (!src.includes('screenshotLightboxScript(')) missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  // Sanity: a scan matching nothing would pass the check above vacuously.
  test('the scan finds the pages that render screenshots', async () => {
    const files = (await readdir(SERVER_DIR)).filter((f) => f.endsWith('.ts'));
    const renderers: string[] = [];
    for (const file of files) {
      if (file === 'review-presentation.ts') continue;
      const src = await readFile(join(SERVER_DIR, file), 'utf8');
      if (src.includes('screenshotsCardHtml(')) renderers.push(file);
    }
    expect(renderers.sort()).toEqual(['review.ts', 'task-page.ts']);
  });
});
