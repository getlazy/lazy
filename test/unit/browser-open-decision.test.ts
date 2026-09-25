/**
 * When `lazy dashboard` opens a browser, and when it prints the URL instead.
 *
 * The decision is pure so it can be tested without a browser, a display, or a
 * subprocess — and it needs testing, because a wrong "yes" is not a cosmetic
 * bug: the URL carries a SINGLE-USE login ticket, so opening a browser that
 * never appears spends the ticket on nothing and leaves the operator with no
 * way in and no error to read.
 */

import { describe, test, expect } from 'bun:test';
import {
  decideBrowserOpen,
  browserOpenCommand,
  openInBrowser,
  type BrowserOpenContext,
} from '../../src/cli/open-url';

/** A desktop Linux session with a display — the plain "yes" case. */
function ctx(overrides: Partial<BrowserOpenContext> = {}): BrowserOpenContext {
  return {
    platform: 'linux',
    isTty: true,
    env: { DISPLAY: ':0' },
    ...overrides,
  };
}

describe('decideBrowserOpen', () => {
  test('opens on a graphical Linux session', () => {
    expect(decideBrowserOpen(ctx())).toEqual({ open: true });
  });

  test('opens on macOS and Windows without consulting a display variable', () => {
    expect(decideBrowserOpen(ctx({ platform: 'darwin', env: {} }))).toEqual({ open: true });
    expect(decideBrowserOpen(ctx({ platform: 'win32', env: {} }))).toEqual({ open: true });
  });

  test('opens under WSL, which has no X display of its own', () => {
    expect(decideBrowserOpen(ctx({ env: { WSL_DISTRO_NAME: 'Ubuntu' } }))).toEqual({ open: true });
    expect(decideBrowserOpen(ctx({ env: { WSL_INTEROP: '/run/WSL/8_interop' } }))).toEqual({ open: true });
  });

  test('prints when asked for the URL only', () => {
    const decision = decideBrowserOpen(ctx({ printOnly: true }));
    expect(decision.open).toBe(false);
    // --print wins even where a browser could have been opened.
    expect(decideBrowserOpen(ctx({ platform: 'darwin', printOnly: true })).open).toBe(false);
  });

  test('prints when there is no terminal', () => {
    const decision = decideBrowserOpen(ctx({ isTty: false }));
    expect(decision.open).toBe(false);
    if (!decision.open) expect(decision.reason).toContain('terminal');
  });

  // The browser would open on the far end of the SSH connection, where nobody
  // is sitting — and the ticket would be spent.
  test('prints over SSH, on every spelling of the session variables', () => {
    for (const key of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT']) {
      const decision = decideBrowserOpen(ctx({ env: { DISPLAY: ':0', [key]: 'x' } }));
      expect(decision.open).toBe(false);
      if (!decision.open) expect(decision.reason).toContain('SSH');
    }
    // Even on macOS, where there is otherwise always a desktop.
    expect(decideBrowserOpen(ctx({ platform: 'darwin', env: { SSH_TTY: '/dev/ttys001' } })).open).toBe(false);
  });

  test('prints on Linux with no graphical session', () => {
    const decision = decideBrowserOpen(ctx({ env: {} }));
    expect(decision.open).toBe(false);
    if (!decision.open) expect(decision.reason).toContain('DISPLAY');
  });

  test('opens under Wayland, which sets no DISPLAY', () => {
    expect(decideBrowserOpen(ctx({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))).toEqual({ open: true });
  });
});

describe('browserOpenCommand', () => {
  test('uses the platform opener', () => {
    expect(browserOpenCommand('darwin', 'http://x/')).toEqual(['open', 'http://x/']);
    expect(browserOpenCommand('linux', 'http://x/')).toEqual(['xdg-open', 'http://x/']);
  });

  // The empty string is `start`'s window-title argument. Without it, the URL is
  // taken AS the title and nothing opens.
  test('passes start an empty window title on Windows', () => {
    expect(browserOpenCommand('win32', 'http://x/')).toEqual(['cmd', '/c', 'start', '', 'http://x/']);
  });
});

describe('openInBrowser', () => {
  // A minimal Linux install with no xdg-open is a normal environment, not an
  // error: the caller prints the URL and the operator carries on.
  test('returns false instead of throwing when the opener is missing', async () => {
    const opened = await openInBrowser('http://127.0.0.1:1/', 'freebsd' as NodeJS.Platform);
    expect(opened).toBe(false);
  });
});
