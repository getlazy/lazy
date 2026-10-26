/**
 * The daemon dashboard's browser terminals — the task Shell and Watch — carry
 * the same controls as Lazy Teams' terminals, in a real headless Chromium.
 *
 * The page is the real `shellPanelHtml` / `watchPanelHtml` markup, the real
 * client scripts, the real dashboard stylesheet and the real vendored xterm,
 * served by a stand-in for the daemon's task routes (container ensure and the
 * two WebSocket routes). A real container cannot exist here; everything the
 * controls act on — layout, xterm, the resize frames the PTY would receive — is
 * real. Teams' side of the same promise is lazy-teams/test/system/terminal_controls_test.rb.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { shellPanelHtml, shellClientScript } from '../../src/server/shell-ui';
import { watchPanelHtml, watchClientScript } from '../../src/server/watch-ui';
import {
  XTERM_JS_PATH, XTERM_FIT_JS_PATH, XTERM_CSS_PATH,
  bundledXtermJs, bundledXtermFitJs, bundledXtermCss,
} from '../../src/server/xterm';
import { STYLESHEET_PATH, bundledStylesheet } from '../../src/server/styles';
import { browserSuiteSkipped, launchBrowser, type Browser } from '../helpers/cdp-browser';

const skipped = browserSuiteSkipped('dashboard terminal controls');

interface Resize { cols: number; rows: number }

describe.skipIf(skipped)('dashboard terminal controls', () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  const resizes: Resize[] = [];
  // What the browser typed into the shell session, and its socket.
  let typed = '';
  let shellSocket: { send(data: string | Uint8Array): void } | null = null;
  // The query of every shell socket the page opened, in order.
  const shellQueries: string[] = [];

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/ws')) {
          if (url.pathname.endsWith('/shell/ws')) shellQueries.push(url.search);
          return srv.upgrade(req, { data: { shell: url.pathname.endsWith('/shell/ws') } }) ? undefined : new Response('upgrade failed', { status: 400 });
        }
        const text = (body: string, type: string) => new Response(body, { headers: { 'content-type': type } });
        switch (url.pathname) {
          case XTERM_JS_PATH: return text(bundledXtermJs(), 'text/javascript');
          case XTERM_FIT_JS_PATH: return text(bundledXtermFitJs(), 'text/javascript');
          case XTERM_CSS_PATH: return text(bundledXtermCss(), 'text/css');
          case STYLESHEET_PATH: return text(bundledStylesheet(), 'text/css');
          case '/tasks/t1/container/ensure':
            return Response.json({ phase: 'done' });
          case '/':
            return text(
              `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${STYLESHEET_PATH}"></head><body>` +
              `<div class="action-links">${shellPanelHtml('t1', { available: true })}${watchPanelHtml('t1', true)}</div>` +
              shellClientScript() + watchClientScript() + '</body></html>', 'text/html');
          default: return new Response('not found', { status: 404 });
        }
      },
      websocket: {
        open(ws) {
          if ((ws.data as { shell?: boolean }).shell) shellSocket = ws;
          ws.send(JSON.stringify({ type: 'ready' }));
          // Enough output to scroll back through.
          ws.send(new TextEncoder().encode(Array.from({ length: 150 }, (_, i) => `line ${i}\r\n`).join('')));
        },
        message(ws, message) {
          if (typeof message !== 'string') {
            if ((ws.data as { shell?: boolean }).shell) typed += new TextDecoder().decode(message as Uint8Array);
            return;
          }
          const frame = JSON.parse(message) as { type?: string; cols?: number; rows?: number };
          if (frame.type === 'resize') resizes.push({ cols: frame.cols!, rows: frame.rows! });
        },
      },
    });
    browser = await launchBrowser([]);
    await browser.setViewport(1400, 900);
    await browser.goto(`http://127.0.0.1:${server.port}/`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
      await Bun.sleep(100);
    }
  }

  async function shot(name: string): Promise<void> {
    const dir = process.env.TERMINAL_SHOTS_DIR;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${name}.png`, await browser.screenshot());
  }

  // INVARIANT: every dashboard terminal has a visibly labelled "Fill window"
  // control that makes the terminal cover the whole window — its rows and
  // columns grow with it — and "Exit full window" or Esc restores it. A control
  // that exists only on one terminal, or fills only part of the window, is how
  // shells ended up unable to be made bigger.
  async function exercise(opts: { panel: string; fill: string; term: string; size: () => Promise<[number, number]> }) {
    const q = (s: string) => JSON.stringify(s);
    const text = await browser.evaluate<string>(`document.querySelector(${q(opts.fill)}).textContent`);
    expect(text).toBe('Fill window');
    await Bun.sleep(500);
    const before = await opts.size();
    await shot(`${opts.panel.replace(/\W+/g, '-')}-before`);

    await browser.evaluate(`document.querySelector(${q(opts.fill)}).click()`);
    const after = await until(opts.size, (s) => s[0] > before[0] && s[1] > before[1], 'the terminal to grow');
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[1]).toBeGreaterThan(before[1]);
    const box = await browser.evaluate<number[]>(
      `(() => { const r = document.querySelector(${q(opts.panel)}).getBoundingClientRect(); return [r.left, r.top, r.width, r.height, innerWidth, innerHeight]; })()`);
    expect(box.slice(0, 4)).toEqual([0, 0, box[4], box[5]]);
    expect(await browser.evaluate<string>(`document.querySelector(${q(opts.fill)}).textContent`)).toBe('Exit full window');
    await shot(`${opts.panel.replace(/\W+/g, '-')}-filled`);

    // Esc inside the terminal belongs to its program: still filled.
    await browser.evaluate(`document.querySelector(${q(opts.panel)} + ' .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await Bun.sleep(300);
    expect(await browser.evaluate<boolean>(`document.querySelector(${q(opts.panel)}).classList.contains('is-maximised')`)).toBe(true);
    // Esc with focus on the button (outside the terminal) leaves it.
    await browser.evaluate(`document.querySelector(${q(opts.fill)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    const restored = await until(opts.size, (s) => s[0] === before[0] && s[1] === before[1], 'the terminal to restore');
    expect(restored).toEqual(before);
    expect(await browser.evaluate<string>(`document.querySelector(${q(opts.fill)}).textContent`)).toBe('Fill window');
  }

  const screenSize = (root: string) => async (): Promise<[number, number]> =>
    browser.evaluate<[number, number]>(
      `(() => { const t = document.querySelector(${JSON.stringify(root)}); return [t.querySelector('.xterm-screen').clientWidth, t.querySelector('.xterm-rows').children.length]; })()`);

  test('the task shell has the Fill window control and it fills the window', async () => {
    await browser.evaluate(`document.querySelector('[data-lz-shell-open]').click()`);
    await until(() => browser.evaluate<string>(`document.querySelector('[data-lz-shell-status]').textContent`),
      (s) => s === 'Connected', 'the shell to connect');
    const session = '.lz-shell-session';
    expect(await browser.evaluate<boolean>(`!!document.querySelector('${session} [data-lz-term-paste]')`)).toBe(true);
    await until(async () => resizes.length, (n) => n > 0, 'the first resize frame');
    const sent = resizes.length;
    await exercise({ panel: session, fill: `${session} [data-lz-term-fill]`, term: '[data-lz-shell-term]', size: screenSize(session) });
    // The PTY was told: a larger size on the way up, the original on the way back.
    const frames = resizes.slice(sent);
    expect(Math.max(...frames.map((f) => f.cols))).toBeGreaterThan(resizes[0]!.cols);
    expect(frames[frames.length - 1]).toEqual(resizes[sent - 1]!);
  }, 60_000);

  test('Watch has the same Fill window control and it fills the window', async () => {
    await browser.evaluate(`document.querySelector('[data-lz-watch-open]').click()`);
    await until(() => browser.evaluate<string>(`document.querySelector('[data-lz-watch-status]').textContent`),
      (s) => s !== 'Connecting…' && s !== 'Disconnected', 'watch to connect');
    const panel = '.lz-watch-panel';
    await exercise({ panel, fill: `${panel} [data-lz-term-fill]`, term: '[data-lz-watch-term]', size: screenSize(panel) });
  }, 60_000);

  // INVARIANT: PageUp scrolls the terminal's scrollback on every dashboard
  // terminal, as it does in Teams, rather than reaching the program.
  const pageUpScrolls = async (root: string) => {
    const rowsText = () => browser.evaluate<string>(`document.querySelector(${JSON.stringify(root)} + ' .xterm-rows').textContent`);
    await until(rowsText, (t) => t.includes('line 149'), 'the output to arrive');
    await browser.evaluate(`document.querySelector(${JSON.stringify(root)} + ' .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }))`);
    await until(rowsText, (t) => !t.includes('line 149'), 'PageUp to scroll back');
  };

  test('PageUp scrolls back in Watch and in the shell', async () => {
    await pageUpScrolls('.lz-watch-panel');
    await pageUpScrolls('.lz-shell-session');
  }, 60_000);

  // A readable clipboard holding PASTE-ME (so a second paste path would show),
  // recording writes in window.__copied.
  const stubClipboard = () => browser.evaluate(`(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => Promise.resolve('PASTE-ME'), writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); })()`);

  // INVARIANT: Ctrl/Cmd+V pastes exactly ONCE. The keydown is kept from the
  // program (no ^V), and the browser's own paste event that follows it is the
  // one paste; pasting from the keydown as well delivered the text twice.
  test('Ctrl+V pastes once into the shell', async () => {
    const ta = `document.querySelector('.lz-shell-session .xterm-helper-textarea')`;
    await stubClipboard();
    typed = '';
    await browser.evaluate(`(() => { const t = ${ta}; t.focus();
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
      const dt = new DataTransfer(); dt.setData('text/plain', 'PASTE-ME');
      t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await until(async () => typed, (t) => t.includes('PASTE-ME'), 'the paste to arrive');
    await Bun.sleep(500);
    expect(typed.split('PASTE-ME').length - 1).toBe(1);
    expect(typed).not.toContain('\x16');
  }, 60_000);

  // INVARIANT: on a program's full screen (the alternate buffer — Claude Code's
  // fullscreen view) PageUp/PageDown go to the program, which scrolls itself;
  // that buffer has no scrollback for the terminal to scroll.
  test('PageUp reaches a full-screen program', async () => {
    shellSocket!.send(new TextEncoder().encode('\x1b[?1049h'));
    await Bun.sleep(300);
    typed = '';
    await browser.evaluate(`document.querySelector('.lz-shell-session .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', code: 'PageUp', keyCode: 33, bubbles: true, cancelable: true }))`);
    await until(async () => typed, (t) => t.includes('\x1b[5~'), 'PageUp to reach the program');
    shellSocket!.send(new TextEncoder().encode('\x1b[?1049l'));
  }, 60_000);

  // INVARIANT: a program setting the clipboard with OSC 52 (how Claude Code
  // copies its own selection) lands on the clipboard. xterm ignores OSC 52
  // unless the page handles it, which is why "N characters copied" copied nothing.
  // Only right after the person acted, though: output alone never writes it.
  test('OSC 52 from the program sets the clipboard', async () => {
    await stubClipboard();
    // No user activation in this page for a while: refused.
    await Bun.sleep(5_500);
    shellSocket!.send(new TextEncoder().encode(`\x1b]52;c;${Buffer.from('unasked').toString('base64')}\x07`));
    await Bun.sleep(500);
    expect(await browser.evaluate<string | null>(`window.__copied`)).toBeNull();
    // The person just clicked: the program's copy lands.
    await browser.evaluate(`document.querySelector('.lz-shell-session .xterm-helper-textarea').focus()`, { userGesture: true });
    shellSocket!.send(new TextEncoder().encode(`\x1b]52;c;${Buffer.from('copied ✓').toString('base64')}\x07`));
    await until(() => browser.evaluate<string | null>(`window.__copied || null`), (v) => v === 'copied ✓', 'the clipboard write');
    await shot('shell-osc52-copied');
  }, 60_000);

  // INVARIANT: closing a filled shell session releases the page's scroll lock
  // (body.lz-shell-maximised); with the session gone nothing else could.
  test('closing a filled session releases the page scroll lock', async () => {
    await browser.evaluate(`document.querySelector('.lz-shell-session [data-lz-term-fill]').click()`);
    expect(await browser.evaluate<boolean>(`document.body.classList.contains('lz-shell-maximised')`)).toBe(true);
    await browser.evaluate(`document.querySelector('.lz-shell-session .lz-shell-session-bar [title="Close this shell"]').click()`);
    expect(await browser.evaluate<boolean>(`document.body.classList.contains('lz-shell-maximised')`)).toBe(false);
  }, 60_000);

  // A verification step's shell is MOUNTED under the step, not in the panel;
  // it has the same Fill window control and fills the same way.
  test('a mounted (Verify) session has Fill window and fills the window', async () => {
    await browser.evaluate(`(() => { const m = document.createElement('div'); m.id = 'mnt'; m.className = 'lz-shell-mount'; m.hidden = true; document.body.appendChild(m); })()`);
    expect(await browser.evaluate<unknown>(`window.lzShellRun('echo hi', 't1', 'Verify', { mount: document.getElementById('mnt') })`)).toBeTruthy();
    await until(() => browser.evaluate<boolean>(`!!document.querySelector('#mnt .xterm-rows')`), (b) => b, 'the mounted terminal');
    await exercise({ panel: '#mnt .lz-shell-session', fill: '#mnt [data-lz-term-fill]', term: '#mnt [data-lz-shell-term]', size: screenSize('#mnt') });
  }, 60_000);

  // INVARIANT: each plain shell the dashboard opens is a tmux session of its
  // own in the container — the first is the default `shell` (no `session=`),
  // later ones `shell-<n>`, a Run `run-<n>` — so a reconnect or `lazy shell`
  // lands back in the same one, and two terminals are never one session
  // mirrored twice.
  test('each shell opened here asks for its own named session', async () => {
    const before = shellQueries.length;
    const newButton = `document.querySelector('[data-lz-shell-newtab]').click()`;
    await browser.evaluate(newButton);
    await browser.evaluate(newButton);
    await browser.evaluate(`window.lzShellRun('echo hi\\n', 't1', 'Run')`);
    const opened = await until(async () => shellQueries.slice(before), (q) => q.length >= 3, 'three shell sockets');
    const sessions = shellQueries.map((q) => new URLSearchParams(q).get('session'));
    // The very first plain shell of the page is the default session.
    expect(sessions.filter((s) => s === null).length).toBe(1);
    expect(opened.map((q) => new URLSearchParams(q).get('session')).filter((s) => s !== null && /^shell-\d+$/.test(s)).length).toBeGreaterThanOrEqual(1);
    expect(opened.some((q) => /^run-\d+$/.test(new URLSearchParams(q).get('session') ?? ''))).toBe(true);
    expect(new Set(sessions).size).toBe(sessions.length);
  });
});
