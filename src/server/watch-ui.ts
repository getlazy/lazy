/**
 * The Watch button, panel, and client script — the web face of `lazy watch`.
 *
 * Watch used to be a `<meta http-equiv="refresh">` loop on the task page, which
 * answered "has anything changed?" every five seconds and never answered "what
 * is the agent doing right now?" — the question a reviewer actually opens Watch
 * to ask. This panel streams the same lines the CLI prints, live, into the same
 * vendored xterm.js terminal the web shell uses.
 *
 * Read-only by construction: the terminal takes no input and the client sends
 * nothing on the socket. Wire protocol: binary frames are output bytes to write
 * verbatim (they carry ANSI, exactly as the CLI emits it); text frames are JSON
 * control messages (`src/server/watch-ws.ts`).
 *
 * The panel is mounted in the task page header's `.action-links` row, which
 * is a WRAPPING FLEX ROW: an open panel therefore has to opt out of being
 * sized like a button by taking a full basis row, which is what the `is-open`
 * class this script toggles does (`src/server/styles/terminal-panels.css`).
 * The header is outside the swapped tab body, so the panel survives an
 * in-place tab switch. Its width comes from the page's content column and
 * from nowhere else — never a fixed pixel width — and the terminal is
 * re-fitted whenever that column changes size.
 */

import { escapeHtml } from './review-diff';
import { XTERM_JS_PATH, XTERM_FIT_JS_PATH, XTERM_CSS_PATH } from './xterm';
import { containerEnsureClientScript } from './container-ensure-client';

/**
 * Render the Watch button and its (hidden) output panel for a task.
 *
 * `offered` is false for a terminal task — nothing can happen on it any more, so
 * there is nothing to watch and no panel is rendered at all. For every other
 * task the button is live even when the task is not currently working: whether
 * an agent is running is a fact that changes between the page render and the
 * click, so the STREAM says "idle", not a stale button.
 */
export function watchPanelHtml(taskId: string, offered: boolean): string {
  if (!offered) return '';
  return (
    `<div class="lz-watch" data-lz-watch-task="${escapeHtml(taskId)}"` +
    ` data-lz-xterm-js="${XTERM_JS_PATH}" data-lz-xterm-fit="${XTERM_FIT_JS_PATH}" data-lz-xterm-css="${XTERM_CSS_PATH}">` +
    `<button type="button" class="btn" data-lz-watch-open>Watch</button>` +
    `<div class="lz-watch-panel" hidden>` +
    `<div class="lz-watch-bar">` +
    `<span class="lz-watch-status" data-lz-watch-status>Disconnected</span>` +
    `<button type="button" class="btn btn-sm" data-lz-watch-reconnect hidden>Reconnect</button>` +
    `<button type="button" class="btn btn-sm" data-lz-watch-close>Close</button>` +
    `</div>` +
    `<div class="lz-watch-term" data-lz-watch-term></div>` +
    `</div>` +
    `</div>`
  );
}

/**
 * The client script driving every watch panel on the page. Same shape as the
 * shell's (lazy asset load, one WebSocket, reconnect), minus every input path:
 * the terminal is created with `disableStdin` and nothing is ever sent.
 */
export function watchClientScript(): string {
  return containerEnsureClientScript() + `<script>
(() => {
  if (window.__lzWatchWired) return;
  window.__lzWatchWired = true;

  let assetsPromise = null;
  function loadAssets(root) {
    if (assetsPromise) return assetsPromise;
    assetsPromise = new Promise((resolve, reject) => {
      const cssHref = root.getAttribute('data-lz-xterm-css');
      if (cssHref && !document.querySelector('link[data-lz-xterm]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = cssHref; link.setAttribute('data-lz-xterm', '1');
        document.head.appendChild(link);
      }
      const jsSrc = root.getAttribute('data-lz-xterm-js');
      const fitSrc = root.getAttribute('data-lz-xterm-fit');
      if (window.Terminal && window.FitAddon) { resolve(); return; }
      const s1 = document.createElement('script');
      s1.src = jsSrc;
      s1.onload = () => {
        const s2 = document.createElement('script');
        s2.src = fitSrc;
        s2.onload = () => resolve();
        s2.onerror = () => reject(new Error('failed to load xterm-fit'));
        document.head.appendChild(s2);
      };
      s1.onerror = () => reject(new Error('failed to load xterm'));
      document.head.appendChild(s1);
    });
    return assetsPromise;
  }

  function wire(root) {
    if (root.__lzWatchWiredEl) return;
    root.__lzWatchWiredEl = true;
    const taskId = root.getAttribute('data-lz-watch-task');
    const panel = root.querySelector('.lz-watch-panel');
    const termEl = root.querySelector('[data-lz-watch-term]');
    const statusEl = root.querySelector('[data-lz-watch-status]');
    const reconnectBtn = root.querySelector('[data-lz-watch-reconnect]');
    const openBtn = root.querySelector('[data-lz-watch-open]');
    const closeBtn = root.querySelector('[data-lz-watch-close]');

    let term = null, fit = null, ws = null, ro = null, closedByUser = false;

    function setStatus(text, connected) {
      statusEl.textContent = text;
      statusEl.classList.toggle('is-connected', !!connected);
    }

    // Show or hide the panel. The class is what makes the open panel claim a
    // whole row of \`.action-links\` (see styles/terminal-panels.css) — without it
    // the root stays an inline flex item and the terminal is capped at the width
    // of the Watch button.
    function setOpen(open) {
      panel.hidden = !open;
      root.classList.toggle('is-open', open);
    }

    // Re-measure the terminal against its container. Called on open, on every
    // panel resize (ResizeObserver) and on window resize — the panel is as wide
    // as the page's content column, so the column changing size has to reflow
    // the terminal. Unlike the shell there is no PTY to tell: nothing is sent.
    //
    // Neither listener is torn down on Close, so both still fire while the panel
    // is hidden; fitting against a display:none element would resize the buffer
    // to FitAddon's 2x1 minimum and mangle the scrollback for the next open.
    // Bail on hidden explicitly — a zero-size container must not be measured.
    function refit() {
      if (!fit || panel.hidden) return;
      try { fit.fit(); } catch (e) { /* terminal not measurable yet */ }
    }

    let resizeTimer = null;
    function onWindowResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = null; refit(); }, 100);
    }

    async function connect() {
      closedByUser = false;
      reconnectBtn.hidden = true;
      setStatus('Connecting…', false);
      try {
        await loadAssets(root);
      } catch (e) {
        setStatus('Failed to load terminal assets', false);
        return;
      }
      if (!term) {
        term = new window.Terminal({ disableStdin: true, cursorBlink: false, fontSize: 13, scrollback: 5000, convertEol: true });
        fit = new window.FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(termEl);
        ro = new ResizeObserver(() => refit());
        ro.observe(termEl);
        window.addEventListener('resize', onWindowResize);
      }
      // The panel is already un-hidden and full-width by now (setOpen runs
      // synchronously on the click), so this measures the real column.
      refit();

      // Opening Watch is a request for this task's environment, so bring the
      // container up (or attach to a start another panel already began) and
      // narrate it here rather than making the human find a button.
      //
      // A failure is NOT fatal here, unlike the shell: the agent stream is
      // tailed off the filesystem and still has something to show without a
      // container. So the reason is written into the terminal, the retry button
      // appears, and the stream connects anyway — refusing to connect would take
      // away output this panel used to give.
      if (window.lzEnsureContainer) {
        setStatus('Starting the container…', false);
        const ensured = await window.lzEnsureContainer(taskId, function (detail) {
          if (!closedByUser) setStatus(detail, false);
        });
        if (closedByUser) return;
        if (!ensured.ok) {
          term.write('\\r\\n\\x1b[33m[lazy] could not start this task\\'s container: ' + ensured.error + '\\x1b[0m\\r\\n');
          reconnectBtn.textContent = 'Start container';
          reconnectBtn.hidden = false;
        } else {
          reconnectBtn.textContent = 'Reconnect';
        }
      }
      setStatus('Connecting…', false);

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // data-lz-watch-task holds the URL-ESCAPED segment — interpolate raw; a
      // second escape turns %20 into %2520, a different address.
      const url = proto + '//' + location.host + '/tasks/' + taskId + '/watch/ws';
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => setStatus('Connected', true);
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === 'ready') setStatus('Watching', true);
          else if (msg.type === 'idle') setStatus('Task is idle (' + msg.status + ')', true);
          else if (msg.type === 'ended') setStatus('Task is no longer running (' + msg.status + ')', false);
          else if (msg.type === 'error') { term.write('\\r\\n[error: ' + msg.message + ']\\r\\n'); }
        } else {
          term.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = () => {
        if (!closedByUser) { setStatus('Disconnected — connection dropped', false); reconnectBtn.textContent = 'Reconnect'; reconnectBtn.hidden = false; }
        else setStatus('Disconnected', false);
        ws = null;
      };
      ws.onerror = () => setStatus('Connection error', false);
    }

    function disconnect() {
      closedByUser = true;
      if (ws) { try { ws.close(); } catch (e) { /* already closing or closed */ } ws = null; }
    }

    openBtn.addEventListener('click', () => {
      const opening = panel.hidden;
      setOpen(opening);
      if (opening) connect(); else disconnect();
    });
    closeBtn.addEventListener('click', () => { setOpen(false); disconnect(); });
    reconnectBtn.addEventListener('click', () => connect());
    window.addEventListener('beforeunload', () => disconnect());
  }

  function wireAll() { document.querySelectorAll('.lz-watch[data-lz-watch-task]').forEach(wire); }
  // Live-status chrome refresh may replace a closed Watch node; the island
  // re-calls this so the new button is wired without a full page load.
  window.lzWireWatch = wireAll;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireAll);
  else wireAll();
})();
</script>`;
}
