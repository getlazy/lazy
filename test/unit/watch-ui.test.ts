/**
 * Unit tests for the watch panel's markup, client script and sizing
 * (src/server/watch-ui.ts + src/server/styles/terminal-panels.css).
 *
 * There is no DOM harness here — deliberately: the panel's width is decided by
 * two things a browser is not needed to see, the class the script toggles and
 * the rule that class selects. So the script is pinned as TEXT and the rule is
 * read out of the served stylesheet. Coarse by design: these catch a wiring or
 * a rule that was dropped, not a layout bug, and the panel itself is looked at
 * by hand in a browser.
 */

import { describe, test, expect } from 'bun:test';
import { watchPanelHtml, watchClientScript } from '../../src/server/watch-ui';
import { bundledStylesheet, stylesheetFromDisk } from '../../src/server/styles';

describe('watchPanelHtml', () => {
  test('a watchable task renders the open button and a hidden panel', () => {
    const html = watchPanelHtml('task-1', true);
    expect(html).toContain('data-lz-watch-task="task-1"');
    expect(html).toContain('data-lz-watch-open');
    expect(html).toContain('<div class="lz-watch-panel" hidden>');
    expect(html).toContain('data-lz-watch-term');
  });

  test('a terminal task renders nothing at all', () => {
    expect(watchPanelHtml('task-1', false)).toBe('');
  });
});

describe('watchClientScript', () => {
  const script = watchClientScript();

  // The panel is mounted in `.action-links`, a WRAPPING FLEX ROW. Without this
  // class the root is a content-sized flex item and the terminal is capped at
  // the width of the Watch button — which is the bug this file regresses.
  test('the open/close toggle drives the full-width class', () => {
    expect(script).toContain("root.classList.toggle('is-open', open)");
    // Both exits from an open panel go through it, or Close leaves a full-basis
    // row behind and the other actions never come back inline.
    expect(script).toContain('setOpen(opening)');
    expect(script).toContain('setOpen(false)');
  });

  // The panel is as wide as the page's content column, so anything that changes
  // that column's size has to reflow the terminal.
  test('re-fits on open, on panel resize and on window resize', () => {
    expect(script).toContain('new ResizeObserver');
    expect(script).toContain("window.addEventListener('resize', onWindowResize)");
    expect(script).toMatch(/function refit\(\)\s*\{\s*\n\s*if \(!fit \|\| panel\.hidden\) return;/);
  });

  // INVARIANT: never fit a hidden panel. Close tears down neither the
  // ResizeObserver nor the window listener, so both keep firing on a closed
  // panel; FitAddon measures the container's computed size and would clamp the
  // buffer to its 2x1 minimum, mangling the scrollback for the next open. It
  // happens to be inert today only because the shared `.lz-watch-term` height
  // is a `calc()` that FitAddon's parseInt reads as NaN — an accident of the
  // stylesheet, not a guarantee. This assertion is the guarantee.
  test('refit bails while the panel is hidden', () => {
    expect(script).toContain('if (!fit || panel.hidden) return;');
  });

  // Every wired listener is registered once, inside the `if (!term)` block that
  // builds the terminal — reopening a panel must not stack another one.
  test('the window resize listener is registered only on first open', () => {
    const registrations = script.match(/window\.addEventListener\('resize'/g) ?? [];
    expect(registrations).toHaveLength(1);
    const firstOpenBlock = script.match(/if \(!term\) \{[\s\S]*?\n    \}/)?.[0];
    expect(firstOpenBlock).toContain("window.addEventListener('resize', onWindowResize)");
  });
});

describe('watch panel sizing', () => {
  const css = bundledStylesheet();

  test('an open panel claims a whole row of the wrapping action bar', () => {
    // `.action-links` wraps, so a full basis is what puts the panel on its own
    // row at the full content width instead of beside the buttons.
    expect(css).toMatch(/\.lz-watch\.is-open\s*\{[^}]*flex:\s*1 1 100%/);
    expect(css).toMatch(/\.lz-watch\.is-open\s*\{[^}]*width:\s*100%/);
  });

  test('the panel and terminal take their width from the column, never a pixel value', () => {
    const panelRule = css.match(/\.lz-watch-panel\s*\{[^}]*\}/)?.[0];
    expect(panelRule).toBeDefined();
    expect(panelRule).toContain('width: 100%');
    expect(panelRule).toContain('max-width: 100%');
    // INVARIANT: no magic pixel widths. The panel is as wide as the page's
    // content column and nothing else — a px width here would be right at one
    // viewport and wrong at every other one. Height is free to be a pixel
    // value: it is the reviewer's, dragged on the vertical resize handle.
    expect(panelRule).not.toMatch(/(?<!max-|min-)width:\s*[\d.]+(px|rem|em|ch)/);
    expect(css).toMatch(/\.lz-watch-term\s*\{[^}]*width:\s*100%/);
  });

  // Shell and watch are one component behind two prefixes. Grouping their rules
  // is what keeps them from drifting, so the shell must still be selected by
  // every rule the watch panel relies on.
  test('the shell panel is styled by the same rules', () => {
    expect(css).toMatch(/\.lz-shell\.is-open,\s*\n?\s*\.lz-watch\.is-open/);
    expect(css).toMatch(/\.lz-shell-panel,\s*\n?\s*\.lz-watch-panel/);
    expect(css).toMatch(/\.lz-shell-term,\s*\n?\s*\.lz-watch-term/);
  });
});

// INVARIANT: the bundled and from-disk stylesheets are the same bytes. The
// daemon serves the copy compiled into the binary; a from-source dev process
// re-reads the files. A part whose text import and whose path disagree — the
// easy half of a rename to forget — ships a daemon and a dev server that
// disagree about the page, or a dev server that 500s on a missing file.
test('both stylesheet sources produce identical CSS', async () => {
  expect(await stylesheetFromDisk()).toBe(bundledStylesheet());
});
