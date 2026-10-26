/**
 * The daemon dashboard's Services tab Sessions panel, in a real headless
 * Chromium: the task container's tmux sessions, their live screens and logs,
 * and Attach (read-only) / Take control (read-write) terminals on them — the
 * same thing Lazy Teams' Services tab shows (lazy-teams/test/system/task_sessions_test.rb).
 *
 * The page is the real panel markup and client scripts (./task-sessions-panel,
 * ./shell-ui), and the fragment it polls is rendered by the real
 * `loadTaskSessionsFragment` → `listTaskSessions` / `readTaskSession`, parsing
 * what the in-container scripts print. The stand-ins are the container (its
 * `docker exec` answers are scripted) and the shell WebSocket, which records
 * the query each terminal opened with and what was typed into it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { shellPanelHtml, shellClientScript } from '../../src/server/shell-ui';
import { taskSessionsPanelHtml, taskSessionsClientScript, loadTaskSessionsFragment } from '../../src/server/task-sessions-panel';
import {
  XTERM_JS_PATH, XTERM_FIT_JS_PATH, XTERM_CSS_PATH,
  bundledXtermJs, bundledXtermFitJs, bundledXtermCss,
} from '../../src/server/xterm';
import { STYLESHEET_PATH, bundledStylesheet } from '../../src/server/styles';
import { browserSuiteSkipped, launchBrowser, type Browser } from '../helpers/cdp-browser';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';

const skipped = browserSuiteSkipped('dashboard task sessions');

const task = { id: 't1', code: 't1', status: 'blocked' } as unknown as Task;
const storage = {
  resolveTask: async () => ({ task }),
  getSessionByTaskId: async () => ({ id: 'sess-1', task_id: 't1' }),
  getSessionTurns: async () => [],
  getStatusHistory: async () => [],
} as unknown as Storage;

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe.skipIf(skipped)('dashboard task sessions panel', () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  // Bumped on every screen read, so a poll that re-rendered is visible.
  let reads = 0;
  const shellQueries: string[] = [];
  const typed: Record<string, string> = {};

  async function fakeExec(argv: string[]) {
    const script = argv[5] ?? '';
    const args = argv.slice(7);
    const created = Math.floor(Date.now() / 1000) - 42 * 60;
    if (script.startsWith('for n in')) {
      return { exitCode: 0, stdout: args.map(n => `${n} ${Math.floor(Date.now() / 1000) - 8}`).join('\n') + '\n', stderr: '' };
    }
    if (args.length === 0) {
      return { exitCode: 0, stdout: `@@sessions\nservices\t42\t0\t\t${created}\t0\nworker\t\t1\t3\t${created}\t0\n@@end\n`, stderr: '' };
    }
    reads++;
    const screen = args[0] === 'services'
      ? `\x1b[32m✓\x1b[0m Ready on http://localhost:3000\nGET / 200 in 12ms (read ${reads})\n`
      : 'Error: queue unreachable\n';
    return { exitCode: 0, stdout: `@@screen ${b64(screen)}\n@@logbytes 40\n@@end\n${args[0]} started\n`, stderr: '' };
  }

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/tasks/t1/shell/ws') {
          shellQueries.push(url.search);
          return srv.upgrade(req, { data: { query: url.search } }) ? undefined : new Response('upgrade failed', { status: 400 });
        }
        const text = (body: string, type: string) => new Response(body, { headers: { 'content-type': type } });
        switch (url.pathname) {
          case XTERM_JS_PATH: return text(bundledXtermJs(), 'text/javascript');
          case XTERM_FIT_JS_PATH: return text(bundledXtermFitJs(), 'text/javascript');
          case XTERM_CSS_PATH: return text(bundledXtermCss(), 'text/css');
          case STYLESHEET_PATH: return text(bundledStylesheet(), 'text/css');
          case '/tasks/t1/container/ensure': return Response.json({ phase: 'done' });
          case '/tasks/t1/container/sessions':
            return text(await loadTaskSessionsFragment('/project', storage, 't1', {
              taskSeg: 't1',
              canAttach: true,
              deps: { containerTarget: async () => ({ binary: 'docker', name: 'lazy-t1' }), exec: fakeExec },
            }), 'text/html');
          case '/':
            return text(
              `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${STYLESHEET_PATH}"></head><body><main class="container">` +
              `<div data-lz-persist-shell>${shellPanelHtml('t1', { available: true })}</div>` +
              taskSessionsPanelHtml('t1') +
              `</main>` + shellClientScript() + taskSessionsClientScript() + '</body></html>', 'text/html');
          default: return new Response('not found', { status: 404 });
        }
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: 'ready' }));
          ws.send(new TextEncoder().encode('\x1b[32m✓\x1b[0m Ready on http://localhost:3000\r\nGET / 200 in 12ms\r\n'));
        },
        message(ws, message) {
          if (typeof message === 'string') return;
          const q = (ws.data as { query: string }).query;
          typed[q] = (typed[q] ?? '') + new TextDecoder().decode(message as Uint8Array);
        },
      },
    });
    browser = await launchBrowser([]);
    await browser.setViewport(1400, 1000);
    await browser.goto(`http://127.0.0.1:${server.port}/`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
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
    const dir = process.env.TERMINAL_SHOTS_DIR;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${name}.png`, await browser.screenshot());
  }

  const textOf = (sel: string) => browser.evaluate<string>(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);

  test('lists the sessions with state, screen and log, and keeps them current', async () => {
    await until(() => textOf('[data-lz-sessions-list]'), t => t.includes('services'), 'the session list');
    expect(await textOf('[data-lz-sessions-list] tr[data-session="services"]')).toContain('running');
    expect(await textOf('[data-lz-sessions-list] tr[data-session="worker"]')).toContain('exited (3)');
    expect(await textOf('[data-lz-sessions-list] tr[data-session="services"]')).toContain('42 minutes');
    const first = await textOf('#task-session-services [data-session-screen]');
    expect(first).toContain('Ready on http://localhost:3000');
    expect(first).not.toContain('\x1b');
    // INVARIANT: the poll never takes the reader's place — an opened Log
    // stays open across a re-render.
    await browser.evaluate(`document.querySelector('#task-session-services details[data-session-log]').open = true`);
    // The poll renders again on its own.
    await until(() => textOf('#task-session-services [data-session-screen]'), t => t !== first, 'a polled screen');
    expect(await browser.evaluate<boolean>(`document.querySelector('#task-session-services details[data-session-log]').open`)).toBe(true);
    await shot('dashboard-task-sessions');
  });

  // INVARIANT: Attach is read-only — its socket asks for `readonly=1` and the
  // browser sends nothing typed; only Take control types into the session.
  test('Attach watches read-only; Take control types', async () => {
    await browser.evaluate(`document.querySelector('#task-session-services [data-lz-shell-attach][data-lz-shell-readonly="1"]').click()`);
    await until(async () => shellQueries.length, n => n === 1, 'the attach socket');
    expect(shellQueries[0]).toContain('tmux=services');
    expect(shellQueries[0]).toContain('readonly=1');
    expect(shellQueries[0]).not.toContain('mode=');
    await until(() => textOf('#task-session-services .xterm-rows'), t => t.includes('Ready on'), 'the attached screen');
    await browser.evaluate(`document.querySelector('#task-session-services .xterm-helper-textarea').dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true }))`);
    await Bun.sleep(300);
    expect(typed[shellQueries[0]!] ?? '').toBe('');

    // A poll while the terminal is open keeps it: same socket count, still attached.
    await Bun.sleep(3500);
    expect(await browser.evaluate<number>(`document.querySelectorAll('#task-session-services .xterm').length`)).toBe(1);
    await shot('dashboard-task-session-attach');

    await browser.evaluate(`document.querySelector('#task-session-services [data-lz-shell-attach][data-lz-shell-readonly="0"]').click()`);
    await until(async () => shellQueries.length, n => n === 2, 'the control socket');
    expect(shellQueries[1]).toContain('tmux=services');
    expect(shellQueries[1]).not.toContain('readonly');
    await until(() => textOf('#task-session-services .xterm-rows'), t => t.includes('Ready on'), 'the control screen');
    await browser.evaluate(`(() => { const t = document.querySelector('#task-session-services .xterm-helper-textarea'); t.value = 'rs'; t.dispatchEvent(new InputEvent('input', { data: 'rs', inputType: 'insertText', bubbles: true })); })()`);
    await until(async () => typed[shellQueries[1]!] ?? '', t => t.includes('rs'), 'typed bytes on the control socket');
  });

  test('phone width', async () => {
    await browser.setViewport(390, 844);
    await browser.evaluate(`document.getElementById('task-sessions').scrollIntoView()`);
    await Bun.sleep(300);
    await shot('dashboard-task-sessions-phone');
  });
});
