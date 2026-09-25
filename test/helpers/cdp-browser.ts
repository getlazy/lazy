/**
 * A real headless Chromium, driven over the DevTools protocol, for the few
 * dashboard behaviours that only a browser can show.
 *
 * WHY A BROWSER AND NOT `fetch`. Some dashboard failures live entirely in the
 * browser's cookie policy: whether a `SameSite=Strict` session cookie rides on a
 * redirect that belongs to a navigation another site started is Chromium's
 * decision, and no server-side assertion can observe it. The case that made this
 * helper necessary was a login link that redeemed perfectly under `fetch` and
 * landed a real browser on the sign-in page, because the link was CLICKED from
 * another page rather than typed.
 *
 * `--host-resolver-rules` maps made-up hostnames to 127.0.0.1, so a suite can
 * stand up "another site" and "the public dashboard origin" on loopback without
 * touching DNS or /etc/hosts.
 *
 * Gate a suite on {@link browserSuiteSkipped}: a machine with no Chrome prints
 * one line saying the suite was skipped, never a silent green.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { findChromeBinary } from '../../src/utils/chrome';

/** Resolved once at import: the gate below runs at module scope. */
const chromeBinary = await findChromeBinary();

/**
 * True when no headless Chrome is available, printing one line saying so.
 * Intended for `describe.skipIf(browserSuiteSkipped('name'))(...)`.
 */
export function browserSuiteSkipped(suiteName: string): boolean {
  if (chromeBinary) return false;
  console.log(`skipped: browser suite "${suiteName}" — no headless Chrome found (set $CHROME_BIN)`);
  return true;
}

/** What the page shows once navigation has settled. */
export interface PageState {
  url: string;
  title: string;
  text: string;
}

export interface Browser {
  /** Navigate the tab to `url` and wait for it (and any client redirect) to settle. */
  goto(url: string): Promise<PageState>;
  /** Click the element matching `selector` and wait for navigation to settle. */
  click(selector: string): Promise<PageState>;
  /** The tab's current state. */
  state(): Promise<PageState>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Launch a fresh browser — its own profile, so no cookie leaks between calls.
 *
 * @param hostMap hostnames to resolve to 127.0.0.1 (e.g. `['lazy-proxy.test']`).
 */
export async function launchBrowser(hostMap: string[]): Promise<Browser> {
  if (!chromeBinary) throw new Error('launchBrowser: no Chrome — gate the suite on browserSuiteSkipped()');
  const profile = await mkdtemp(join(tmpdir(), 'lazy-cdp-'));
  const port = await freePort();
  const rules = hostMap.map((h) => `MAP ${h} 127.0.0.1`).join(', ');
  const proc = Bun.spawn([
    chromeBinary,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    // Suites serve HTTPS with throwaway self-signed certificates.
    '--ignore-certificate-errors',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...(rules ? [`--host-resolver-rules=${rules}`] : []),
    'about:blank',
  ], { stdout: 'ignore', stderr: 'ignore' });

  let wsUrl: string | null = null;
  const deadline = Date.now() + 15_000;
  while (!wsUrl) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`Chrome did not open its DevTools port ${port} within 15s`);
    }
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch (err) {
      // Not listening yet — the loop's deadline bounds the wait.
      void err;
    }
    if (!wsUrl) await Bun.sleep(100);
  }

  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (msg.id === undefined) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`could not attach to Chrome at ${wsUrl}`));
  });

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const state = async (): Promise<PageState> => {
    const res = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ url: location.href, title: document.title, text: document.body ? document.body.innerText : "" })',
      returnByValue: true,
    }) as { result: { value: string } };
    return JSON.parse(res.result.value) as PageState;
  };

  // Wait until the URL stops changing and the document is complete — a client
  // redirect (meta refresh, location.replace) is a SECOND navigation, and the
  // interesting page is the one after it.
  const settle = async (): Promise<PageState> => {
    let last = '';
    let stableSince = Date.now();
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      await Bun.sleep(100);
      let current: PageState & { ready?: string };
      try {
        const res = await send('Runtime.evaluate', {
          expression: 'JSON.stringify({ url: location.href, ready: document.readyState })',
          returnByValue: true,
        }) as { result: { value: string } };
        current = JSON.parse(res.result.value);
      } catch (err) {
        // The context was torn down by a navigation mid-evaluate; try again.
        void err;
        continue;
      }
      const key = `${current.url}|${current.ready}`;
      if (key !== last) {
        last = key;
        stableSince = Date.now();
      } else if (current.ready === 'complete' && Date.now() - stableSince >= 500) {
        return state();
      }
    }
    return state();
  };

  return {
    async goto(url) {
      await send('Page.navigate', { url });
      return settle();
    },
    async click(selector) {
      await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)}).click()` });
      return settle();
    },
    state,
    async close() {
      ws.close();
      proc.kill();
      await proc.exited;
      await rm(profile, { recursive: true, force: true });
    },
  };
}
