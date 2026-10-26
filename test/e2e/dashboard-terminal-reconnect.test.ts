/**
 * The daemon dashboard's shell and Watch reattach BY THEMSELVES when their
 * connection drops, in a real headless Chromium.
 *
 * The page is the real panel markup and client scripts; the shell socket is
 * served by the daemon's REAL terminal relay (`createShellRelayHandler` and
 * `tryResumeUpgrade`, src/server/shell-ws.ts) over a real `ExecStream` against
 * the fake Engine API, which echoes keystrokes — so the session the page
 * reattaches to is a real held exec, and "the same session" is checked by the
 * engine's own count of execs. Only the route in front of the relay (auth,
 * resolving the task) is a stand-in, as in dashboard-terminal-controls.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerWebSocket } from 'bun';
import { shellPanelHtml, shellClientScript } from '../../src/server/shell-ui';
import { watchPanelHtml, watchClientScript } from '../../src/server/watch-ui';
import { createShellRelayHandler, tryResumeUpgrade, SHELL_CMD, type ShellSocketData } from '../../src/server/shell-ws';
import {
  XTERM_JS_PATH, XTERM_FIT_JS_PATH, XTERM_CSS_PATH,
  bundledXtermJs, bundledXtermFitJs, bundledXtermCss,
} from '../../src/server/xterm';
import { STYLESHEET_PATH, bundledStylesheet } from '../../src/server/styles';
import { browserSuiteSkipped, launchBrowser, type Browser } from '../helpers/cdp-browser';
import { startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';

const skipped = browserSuiteSkipped('dashboard terminal reconnect');

describe.skipIf(skipped)('dashboard terminals reattach after a dropped connection', () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  let engine: FakeEngine;
  let dir: string;
  const savedDockerHost = process.env.DOCKER_HOST;
  const shellPaths: string[] = [];
  const shellSockets: Array<ServerWebSocket<ShellSocketData>> = [];
  const watchSockets: Array<ServerWebSocket<unknown>> = [];
  // While set, the shell route answers 503: the page stays "reconnecting".
  let unreachable = false;
  // While set, the page and the shell route answer 401, as the dashboard's
  // sign-in gate does for a browser whose session is gone.
  let signedOut = false;
  let refusedUpgrades = 0;
  const relay = createShellRelayHandler() as unknown as {
    open(ws: unknown): Promise<void>; message(ws: unknown, m: unknown): void; close(ws: unknown, c: number, r: string): void;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lz-dash-reconnect-'));
    engine = startFakeEngine(join(dir, 'docker.sock'), { allowExec: true });
    process.env.DOCKER_HOST = `unix://${engine.socketPath}`;
    server = Bun.serve({
      port: 0,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (signedOut && (url.pathname === '/' || url.pathname.endsWith('/ws'))) {
          if (url.pathname.endsWith('/ws')) refusedUpgrades++;
          return new Response('sign in', { status: 401 });
        }
        if (url.pathname === '/tasks/t1/shell/ws') {
          shellPaths.push(url.pathname + url.search);
          if (unreachable) return new Response('unreachable', { status: 503 });
          const owner = 'dash:task:t1:shell';
          const resumed = tryResumeUpgrade(req, srv as never, url, owner);
          if (resumed) return resumed === 'upgraded' ? undefined : resumed;
          const data: ShellSocketData = {
            socketPath: '', container: 'box', binary: 'docker', cols: 80, rows: 24, exec: null,
            cmd: SHELL_CMD, env: [], onClose: null, resumeOwner: owner,
          };
          return srv.upgrade(req, { data }) ? undefined : new Response('no', { status: 426 });
        }
        if (url.pathname === '/tasks/t1/watch/ws') {
          return srv.upgrade(req, { data: { watch: true } }) ? undefined : new Response('no', { status: 426 });
        }
        const text = (body: string, type: string) => new Response(body, { headers: { 'content-type': type } });
        switch (url.pathname) {
          case XTERM_JS_PATH: return text(bundledXtermJs(), 'text/javascript');
          case XTERM_FIT_JS_PATH: return text(bundledXtermFitJs(), 'text/javascript');
          case XTERM_CSS_PATH: return text(bundledXtermCss(), 'text/css');
          case STYLESHEET_PATH: return text(bundledStylesheet(), 'text/css');
          case '/tasks/t1/container/ensure': return Response.json({ phase: 'done' });
          case '/':
            return text(
              `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${STYLESHEET_PATH}"></head><body>` +
              `<div class="action-links">${shellPanelHtml('t1', { available: true })}${watchPanelHtml('t1', true)}</div>` +
              shellClientScript() + watchClientScript() + '</body></html>', 'text/html');
          default: return new Response('not found', { status: 404 });
        }
      },
      websocket: {
        async open(ws) {
          if ((ws.data as { watch?: boolean }).watch) {
            watchSockets.push(ws);
            ws.send(JSON.stringify({ type: 'ready', task: 't1' }));
            ws.send(new TextEncoder().encode(`watch line ${watchSockets.length}\n`));
            return;
          }
          shellSockets.push(ws as unknown as ServerWebSocket<ShellSocketData>);
          await relay.open(ws);
        },
        message(ws, m) { if (!(ws.data as { watch?: boolean }).watch) relay.message(ws, m); },
        close(ws, c, r) { if (!(ws.data as { watch?: boolean }).watch) relay.close(ws, c, r); },
      },
    });
    browser = await launchBrowser([]);
    await browser.setViewport(1400, 900);
    await browser.goto(`http://127.0.0.1:${server.port}/`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    engine?.stop();
    if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = savedDockerHost;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
      await Bun.sleep(100);
    }
  }

  async function shot(name: string): Promise<void> {
    const out = process.env.TERMINAL_SHOTS_DIR;
    if (!out) return;
    await mkdir(out, { recursive: true });
    await writeFile(`${out}/${name}.png`, await browser.screenshot());
  }

  const shellStatus = () => browser.evaluate<string>(`document.querySelector('[data-lz-shell-status]').textContent`);
  const shellRows = () => browser.evaluate<string>(`document.querySelector('.lz-shell-session .xterm-rows').textContent`);
  // Typed through xterm's own input path, as a paste.
  const type = (text: string) => browser.evaluate(`(() => { const t = document.querySelector('.lz-shell-session .xterm-helper-textarea'); t.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);

  // INVARIANT: a dropped connection to a running session reattaches by itself
  // to the SAME session (one exec, ever), the screen keeps what it showed, and
  // nothing is drawn twice — "Reconnect"/"Reload" is never the advice.
  test('the shell reattaches by itself to the same session after a drop', async () => {
    await browser.evaluate(`document.querySelector('[data-lz-shell-open]').click()`);
    await until(shellStatus, (s) => s === 'Connected', 'the shell to connect');
    await until(shellRows, (t) => t.includes('exec:box'), 'the session banner');
    await type('before-drop');
    await until(shellRows, (t) => t.includes('before-drop'), 'the echo');
    const execs = engine.execCreates.length;

    // Cut the connection from the server side with no close handshake, and
    // keep the server out of reach for a moment: the page says it is
    // reconnecting, in place.
    unreachable = true;
    shellSockets[shellSockets.length - 1]!.terminate();
    // The page asks whether it is signed out (it is not: `/` answers 200) and
    // keeps trying — the probe's "keep going" branch.
    await until(shellStatus, (st) => st === 'Connection lost — reconnecting… (typing is paused)', 'the reconnecting status');
    await shot('dashboard-shell-reconnecting');
    await browser.setViewport(390, 844);
    await shot('dashboard-shell-reconnecting-phone');
    await browser.setViewport(1400, 900);
    unreachable = false;
    await until(() => Promise.resolve(shellPaths.length), (n) => n >= 2, 'a reattach');
    expect(shellPaths[shellPaths.length - 1]).toMatch(/resume=[A-Za-z0-9_-]{32}&offset=\d+/);
    await until(shellStatus, (s) => s === 'Connected', 'the reattach');
    expect(engine.execCreates.length).toBe(execs); // the same program
    const rows = await shellRows();
    expect(rows.split('before-drop').length - 1).toBe(1); // still there, once
    expect(rows.split('exec:box').length - 1).toBe(1);
    expect(await browser.evaluate<boolean>(`document.querySelector('[data-lz-shell-reconnect]').hidden`)).toBe(true);

    await type(' after');
    await until(shellRows, (t) => t.includes('after'), 'typing after the reattach');
  }, 60_000);

  test('a reattach to a session that ended says so and stops trying', async () => {
    // The page holds a token the server no longer knows: end it behind the page's back.
    const before = shellPaths.length;
    const ws = shellSockets[shellSockets.length - 1]!;
    ws.data.endRequested = true; // as if the page had said `end`: the next close ends the exec
    ws.terminate();
    await until(shellStatus, (s) => /ended/.test(s) || /This terminal has ended/.test(s), 'the end to be reported');
    await shot('dashboard-shell-ended');
    await browser.setViewport(390, 844);
    await shot('dashboard-shell-ended-phone');
    await browser.setViewport(1400, 900);
    const attempts = shellPaths.length;
    expect(attempts).toBeGreaterThan(before);
    await Bun.sleep(2000);
    expect(shellPaths.length).toBe(attempts); // no retry after a real end
    expect(await shellRows()).toContain('This terminal has ended');
  }, 60_000);

  // INVARIANT: authorization applies on every reattach. The dashboard's sign-in
  // gate refuses a signed-out upgrade as plain HTTP — a bare close to the page —
  // so the page asks, learns it is signed out, says so and stops trying.
  test('a reattach after the dashboard session ended says so and stops trying', async () => {
    await browser.evaluate(`document.querySelector('[data-lz-shell-newtab]').click()`);
    await until(shellStatus, (st) => st === 'Connected', 'a new session');
    signedOut = true;
    try {
      shellSockets[shellSockets.length - 1]!.terminate();
      await until(shellStatus, (st) => /signed out/.test(st), 'the signed-out status');
      expect(refusedUpgrades).toBe(1); // the one reattach that found out
      await Bun.sleep(2000);
      expect(refusedUpgrades).toBe(1); // and none after it
    } finally {
      signedOut = false;
    }
  }, 60_000);

  test('Watch reopens by itself after a drop, from a clear screen', async () => {
    await browser.evaluate(`document.querySelector('[data-lz-watch-open]').click()`);
    const watchRows = () => browser.evaluate<string>(`document.querySelector('.lz-watch-panel .xterm-rows').textContent`);
    await until(watchRows, (t) => t.includes('watch line 1'), 'the first stream');
    watchSockets[0]!.terminate();
    await until(watchRows, (t) => t.includes('watch line 2'), 'the reopened stream');
    expect(await watchRows()).not.toContain('watch line 1');
  }, 60_000);
});
