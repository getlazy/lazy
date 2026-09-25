/**
 * The web-shell button, panel, and client script — shared by the task page and
 * the review page so both open the same terminal.
 *
 * The panel is a progressive enhancement: with JS off, the button is inert and
 * the page is unchanged. On click it lazy-loads the vendored xterm.js assets
 * (only then — an ordinary page render pays nothing), connects the WebSocket at
 * `/tasks/:id/shell/ws`, and relays bytes. Wire protocol: binary frames are raw
 * terminal bytes; text frames are JSON control messages
 * (`src/server/shell-protocol.ts`).
 *
 * The panel holds MANY sessions, not one. Each tab is its own WebSocket and its
 * own `docker exec` into the same container, because the thing a reviewer does
 * with this panel is run a verification step and then keep poking at the result:
 * feeding a second How-to-verify block into the terminal where the first one is
 * still running would interleave two unrelated command streams in one scrollback.
 * A tab per Run keeps each block's output whole and readable, and the human's
 * own interactive shell stays where they left it.
 */

import { escapeHtml } from './review-diff';
import { XTERM_JS_PATH, XTERM_FIT_JS_PATH, XTERM_CSS_PATH } from './xterm';
import { containerEnsureClientScript } from './container-ensure-client';

/**
 * Why the shell is unavailable, as a code the page can branch on.
 *
 * The reason STRING is for the human; the code is so a caller can tell the one
 * fixable case ("the container is not running" — offer to start it) from the
 * ones no button can help with (no session yet, a runner with no container at
 * all). Parsing the prose to decide would be a bug waiting for a reword.
 */
export type ShellUnavailableCode = 'no-session' | 'no-container-runner' | 'not-running';

export type ShellAvailability =
  | { available: true }
  | { available: false; reason: string; code?: ShellUnavailableCode };

/**
 * Render the Shell button and its (hidden) terminal panel for a task. When the
 * shell is unavailable the button is disabled and its reason is shown, so the
 * reviewer learns WHY (container not running, host-process runner) rather than
 * finding a dead button.
 *
 * No Start container button rides along with that reason any more. A container
 * that is merely stopped never reaches here — the page does not probe, and
 * opening a session starts it — so the reasons left (no session yet, a runner
 * with no container) are not ones a button fixes.
 *
 * The panel ships EMPTY: tabs and terminals are created by the client script on
 * demand, one per session. Nothing connects on load — a page render must never
 * exec into a container by itself.
 */
export function shellPanelHtml(taskId: string, avail: ShellAvailability): string {
  if (!avail.available) {
    return (
      `<div class="lz-shell" data-lz-shell-task="${escapeHtml(taskId)}">` +
      `<button type="button" class="btn" disabled title="${escapeHtml(avail.reason)}">Shell</button>` +
      `<span class="text-muted lz-shell-reason">${escapeHtml(avail.reason)}</span>` +
      `</div>`
    );
  }
  return (
    `<div class="lz-shell" data-lz-shell-task="${escapeHtml(taskId)}"` +
    ` data-lz-xterm-js="${XTERM_JS_PATH}" data-lz-xterm-fit="${XTERM_FIT_JS_PATH}" data-lz-xterm-css="${XTERM_CSS_PATH}">` +
    `<button type="button" class="btn" data-lz-shell-open>Shell</button>` +
    `<div class="lz-shell-panel" hidden>` +
    `<div class="lz-shell-bar">` +
    `<span class="lz-shell-tabs" data-lz-shell-tabs role="tablist"></span>` +
    `<button type="button" class="btn btn-sm lz-shell-newtab" data-lz-shell-newtab title="Open another shell in this container">+</button>` +
    `<span class="lz-shell-status" data-lz-shell-status>Disconnected</span>` +
    `<button type="button" class="btn btn-sm" data-lz-shell-reconnect hidden>Reconnect</button>` +
    `<button type="button" class="btn btn-sm" data-lz-shell-close>Close</button>` +
    `</div>` +
    `<div class="lz-shell-sessions" data-lz-shell-sessions></div>` +
    `</div>` +
    `</div>`
  );
}

/**
 * The Shell tab body: an index of this document's sessions (not a second
 * terminal), Pair/Chat origins, and the one-line warning that sessions die
 * on reload — there is no server-side registry.
 */
export function shellTabHtml(input: {
  taskId: string;
  taskCode: string;
  avail: ShellAvailability;
}): string {
  const code = escapeHtml(input.taskCode);
  const persistNote =
    `<p class="rv-hint">Sessions close when you reload or leave the page. ` +
    `There is no server-side registry — <code>lazy shell ${code}</code> survives a reload.</p>`;
  const reason = input.avail.available ? null : input.avail.reason;
  const disabled = reason ? ' disabled' : '';
  const pairTitle = reason
    ?? 'You drive the agent\'s session. The task is locked until you stop.';
  const chatTitle = reason
    ?? 'Talk to the agent about the task without taking over its session. Turns wait while it is open; the task\'s model is unchanged.';
  const newTitle = reason ?? 'Open a new shell in this task\'s container';
  // The tab is always an index — New / Pair / Chat disable with the same
  // reason when no container can be entered, rather than disappearing.
  const actions =
    `<div class="lz-shell-tab-actions">` +
    `<button type="button" class="btn" data-lz-shell-mode="shell"${disabled} title="${escapeHtml(newTitle)}">+ New</button>` +
    `<button type="button" class="btn" data-lz-shell-mode="pair"${disabled} title="${escapeHtml(pairTitle)}">Pair</button>` +
    `<button type="button" class="btn" data-lz-shell-mode="chat"${disabled} title="${escapeHtml(chatTitle)}">Chat</button>` +
    `</div>` +
    `<p class="rv-hint">Pair takes over the agent's session and locks the task until you stop. ` +
    `Chat is a read-only conversation — it does not lock the task or change its model. ` +
    `A dropped Pair connection ends pairing within 30 seconds so the task cannot stay locked forever.</p>` +
    `<h2>Open sessions</h2>` +
    `<ul class="lz-shell-index" data-lz-shell-index></ul>` +
    `<p class="rv-hint" data-lz-shell-index-empty>None yet. Run a verification step, or open a shell here.</p>`;
  return (
    `<div class="lz-shell-tab-page">` +
    (reason ? `<p class="rv-hint">${escapeHtml(reason)}</p>` : '') +
    actions +
    persistNote +
    `</div>`
  );
}

/**
 * The client script that drives every shell panel on the page. It wires each
 * `.lz-shell` block, loads xterm lazily on first open, and manages one
 * WebSocket, terminal, resize observer and tab per SESSION.
 *
 * Three things beyond plain relaying:
 *
 * - **Clipboard keys.** xterm.js hands the terminal every keystroke, so
 *   Ctrl+V/Cmd+V would reach the PTY as a literal ^V instead of pasting.
 *   `attachCustomKeyEventHandler` intercepts the shortcuts a terminal user
 *   expects — paste on Ctrl/Cmd+V and Shift+Insert, copy on Ctrl/Cmd+C *when
 *   there is a selection* (with none, ^C stays the interrupt it has to be).
 *   Paste reads `navigator.clipboard.readText()`, which some browsers refuse or
 *   prompt for; if it is unavailable or denied nothing is pasted and the
 *   browser's own right-click paste (which xterm handles natively) still works.
 * - **Run opens a NEW tab.** `window.lzShellRun(text, taskId, label)` — what the
 *   How-to-verify Run buttons and the Services card's Start services button
 *   call — always creates a fresh labelled session and runs the text there. It
 *   never types into a shell the human is already using.
 * - **Running is announced, and its exit status is not hidden.** Before the text
 *   goes to the PTY the terminal prints the exact lines about to run; after it,
 *   a trailer echoes `$?`. The reviewer sees what ran and how it ended even for
 *   a command that fails silently.
 */
export function shellClientScript(): string {
  return containerEnsureClientScript() + `<script>
(() => {
  if (window.__lzShellWired) return;
  window.__lzShellWired = true;

  // Printed after a Run block. It is a shell command like any other, so it runs
  // when the block's last command finishes — including minutes later, for one
  // that blocks — and reports THAT command's status. A verification step that
  // fails quietly must not read as a step that passed.
  const EXIT_TRAILER = 'echo "[lazy] exit status: $?"\\n';

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
    if (root.__lzWired) return;
    root.__lzWired = true;
    const taskId = root.getAttribute('data-lz-shell-task');
    const panel = root.querySelector('.lz-shell-panel');
    const tabsEl = root.querySelector('[data-lz-shell-tabs]');
    const sessionsEl = root.querySelector('[data-lz-shell-sessions]');
    const statusEl = root.querySelector('[data-lz-shell-status]');
    const reconnectBtn = root.querySelector('[data-lz-shell-reconnect]');
    const openBtn = root.querySelector('[data-lz-shell-open]');
    const closeBtn = root.querySelector('[data-lz-shell-close]');
    const newTabBtn = root.querySelector('[data-lz-shell-newtab]');
    // The unavailable variant is a disabled button and a reason — same root
    // class, nothing to wire. Bail rather than throw on the missing panel.
    if (!panel || !openBtn || !sessionsEl) return;

    const sessions = [];
    let active = null;
    let seq = 0;

    // The status line and Reconnect belong to whichever tab is in front.
    function refreshStatus() {
      if (!active) {
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('is-connected');
        reconnectBtn.hidden = true;
        return;
      }
      statusEl.textContent = active.status;
      statusEl.classList.toggle('is-connected', !!active.connected);
      // One button, two jobs: reconnect a dropped exec, or retry a container
      // start that failed. It is labelled for whichever one it is about to do,
      // and it is the ONLY Start control this panel ever shows — the fallback
      // for an auto-start that did not take, not a step in the normal route.
      reconnectBtn.hidden = !active.dropped && !active.startFailed;
      reconnectBtn.textContent = active.startFailed ? 'Start container' : 'Reconnect';
    }

    // Re-measure a session's terminal and tell its PTY. Called on open, on every
    // panel resize (ResizeObserver) and on window resize — the panel is as wide
    // as the page column, so the column changing size must reflow the terminal.
    function sendResize(s) {
      if (!s || !s.fit) return;
      try {
        s.fit.fit();
        if (s.ws && s.ws.readyState === WebSocket.OPEN) {
          s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
        }
      } catch (e) { /* terminal not measurable yet */ }
    }

    function sendText(s, text) {
      if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(new TextEncoder().encode(text));
        return;
      }
      s.pending.push(text);
    }

    function flushPending(s) {
      while (s.pending.length && s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(new TextEncoder().encode(s.pending.shift()));
      }
    }

    function pasteInto(s) {
      if (!(navigator.clipboard && navigator.clipboard.readText)) return;
      navigator.clipboard.readText().then(function (text) {
        if (text) sendText(s, text);
      }).catch(function () { /* clipboard read denied or dismissed: nothing pasted */ });
    }

    // Returns false to keep xterm from also handling the event.
    function makeKeyHandler(s) {
      return function handleKey(ev) {
        if (ev.type !== 'keydown') return true;
        if (ev.shiftKey && ev.key === 'Insert') { pasteInto(s); return false; }
        if (!ev.ctrlKey && !ev.metaKey) return true;
        const key = (ev.key || '').toLowerCase();
        if (key === 'v') { pasteInto(s); return false; }
        if (key === 'c') {
          const selection = s.term.getSelection();
          // No selection: ^C must stay the interrupt, so let xterm send it.
          if (!selection) return true;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(selection).catch(function () { /* copy refused */ });
          }
          s.term.clearSelection();
          return false;
        }
        return true;
      };
    }

    let resizeTimer = null;
    function onWindowResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = null; sendResize(active); }, 100);
    }
    window.addEventListener('resize', onWindowResize);

    function activate(s) {
      active = s;
      for (let i = 0; i < sessions.length; i++) {
        const other = sessions[i];
        // Mounted sessions stay visible in their slot. Only persist-hosted
        // sessions share one panel and take turns being shown.
        if (!other.mount) other.el.hidden = other !== s;
        if (other.tab && other.tabBtn) {
          other.tab.classList.toggle('is-active', other === s && !other.mount);
          other.tabBtn.setAttribute('aria-selected', other === s ? 'true' : 'false');
        }
      }
      refreshStatus();
      refreshIndex();
      sendResize(s);
      if (s && s.term) s.term.focus();
    }

    /**
     * Announce, then run. The block is printed into the terminal before a byte
     * of it reaches the PTY, so the reviewer reads what is about to execute in
     * the same place the output will appear — and the shell's own echo then
     * shows each line as it actually runs.
     */
    function startRun(s) {
      if (!s.run || s.ran) return;
      s.ran = true;
      const lines = s.run.replace(/\\n+$/, '').split('\\n');
      s.term.write('\\r\\n\\x1b[36m[lazy] ' + s.label + ' — running in this task\\'s container:\\x1b[0m\\r\\n');
      for (let i = 0; i < lines.length; i++) {
        s.term.write('\\x1b[36m  ' + lines[i] + '\\x1b[0m\\r\\n');
      }
      sendText(s, lines.join('\\n') + '\\n');
      sendText(s, EXIT_TRAILER);
    }

    function setStepLive(mount, live) {
      if (!mount) return;
      const step = mount.closest('[data-lz-shell-step]');
      if (!step) return;
      const run = step.querySelector('.rv-cmd-run');
      const open = step.querySelector('.rv-cmd-open');
      const rerun = step.querySelector('.rv-cmd-rerun');
      if (run) run.hidden = !!live;
      if (open) open.hidden = !live;
      if (rerun) rerun.hidden = !live;
    }

    function sessionForMount(mount) {
      for (let i = 0; i < sessions.length; i++) {
        if (sessions[i].mount === mount) return sessions[i];
      }
      return null;
    }

    function refreshIndex() {
      const lists = document.querySelectorAll('[data-lz-shell-index]');
      const empties = document.querySelectorAll('[data-lz-shell-index-empty]');
      const has = sessions.length > 0;
      for (let e = 0; e < empties.length; e++) empties[e].hidden = has;
      for (let li = 0; li < lists.length; li++) {
        const list = lists[li];
        list.innerHTML = '';
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          const row = document.createElement('li');
          row.className = 'lz-shell-index-row';
          row.setAttribute('data-lz-shell-index-id', s.id);
          const dot = document.createElement('span');
          dot.className = 'lz-shell-index-dot' + (s.connected ? ' is-connected' : '');
          dot.setAttribute('aria-hidden', 'true');
          const label = document.createElement('strong');
          label.textContent = s.label;
          const origin = document.createElement('span');
          origin.className = 'rv-hint';
          origin.textContent = s.origin || (s.mount ? 'Verification' : 'here');
          const state = document.createElement('span');
          state.className = 'lz-shell-index-state';
          state.textContent = s.status;
          const go = document.createElement('button');
          go.type = 'button';
          go.className = 'btn btn-sm';
          go.textContent = 'go to';
          go.addEventListener('click', function () { goToSession(s); });
          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'btn btn-sm';
          close.textContent = '×';
          close.title = 'Close this shell';
          close.addEventListener('click', function () { closeSession(s); });
          row.appendChild(dot);
          row.appendChild(label);
          row.appendChild(origin);
          row.appendChild(state);
          row.appendChild(go);
          row.appendChild(close);
          list.appendChild(row);
        }
      }
      refreshShellBadge();
    }

    function refreshShellBadge() {
      const tab = document.querySelector('.lz-tab[data-lz-tab="shell"]');
      if (!tab) return;
      let badge = tab.querySelector('.lz-tab-badge');
      const n = sessions.length;
      if (n === 0) {
        if (badge) badge.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'lz-tab-badge';
        tab.appendChild(badge);
      }
      badge.textContent = String(n);
      badge.setAttribute('title', n + ' open session' + (n === 1 ? '' : 's'));
    }

    function goToSession(s) {
      activate(s);
      if (s.mount) {
        const page = document.querySelector('[data-lz-task-page]');
        // The mount's own tab body carries the path it was rendered for
        // (Verify, Services, ...) — read that instead of a hardcoded tab, so
        // "go to" returns the reader to wherever this session actually lives.
        // "Already here?" is decided the same way task-tabs.ts itself decides
        // it — whether that body is the hidden, cached one — not by comparing
        // the body's UUID-keyed data-lz-tab-path against location.pathname,
        // which carries the task's code on a /tasks/<code>/... URL and would
        // never match.
        const body = s.mount.closest('[data-lz-tab-body]');
        const targetPath = body ? body.getAttribute('data-lz-tab-path') : null;
        if (page && body && body.hidden && targetPath && window.lzSwitchTaskTab) {
          window.lzSwitchTaskTab(targetPath, true);
          setTimeout(function () { s.mount.scrollIntoView({ block: 'nearest' }); sendResize(s); }, 50);
        } else {
          s.mount.scrollIntoView({ block: 'nearest' });
        }
        if (s.term) s.term.focus();
        return;
      }
      const page = document.querySelector('[data-lz-task-page]');
      const id = page ? page.getAttribute('data-lz-task-id') : taskId;
      if (page && page.getAttribute('data-lz-current-tab') !== 'shell' && window.lzSwitchTaskTab) {
        window.lzSwitchTaskTab('/tasks/' + id + '/shell', true);
      }
    }

    function toggleMaximise(s) {
      const on = !s.el.classList.contains('is-maximised');
      for (let i = 0; i < sessions.length; i++) sessions[i].el.classList.remove('is-maximised');
      if (on) s.el.classList.add('is-maximised');
      document.body.classList.toggle('lz-shell-maximised', on);
      sendResize(s);
    }

    async function connect(s) {
      s.closedByUser = false;
      s.dropped = false;
      s.startFailed = null;
      s.status = 'Connecting…';
      s.connected = false;
      refreshStatus();
      refreshIndex();
      try {
        await loadAssets(root);
      } catch (e) {
        s.status = 'Failed to load terminal assets';
        refreshStatus();
        refreshIndex();
        return;
      }
      if (!s.term) {
        s.term = new window.Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false });
        s.fit = new window.FitAddon.FitAddon();
        s.term.loadAddon(s.fit);
        s.term.open(s.termEl);
        s.term.attachCustomKeyEventHandler(makeKeyHandler(s));
        s.term.onData((d) => {
          if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(new TextEncoder().encode(d));
        });
        s.ro = new ResizeObserver(() => sendResize(s));
        s.ro.observe(s.termEl);
      }
      try { s.fit.fit(); } catch (e) { /* terminal not measurable yet */ }

      // The container is this session's business, not the human's. Bring it up
      // (or attach to a start another panel already began) before the upgrade
      // handshake, narrating the launch into this tab's own status line — the
      // page no longer says "container not running" and asks for a click.
      if (window.lzEnsureContainer) {
        s.status = 'Starting the container…';
        refreshStatus(); refreshIndex();
        const ensured = await window.lzEnsureContainer(taskId, function (detail) {
          if (s.closedByUser) return;
          s.status = detail;
          refreshStatus(); refreshIndex();
        });
        if (s.closedByUser) return;
        if (!ensured.ok) {
          // The one place a Start container button belongs on this panel: after
          // a start we asked for on the human's behalf actually failed.
          s.status = ensured.error;
          s.startFailed = ensured.error;
          refreshStatus(); refreshIndex();
          return;
        }
        s.startFailed = null;
      }

      s.status = 'Connecting…';
      refreshStatus();
      const cols = s.term.cols || 80, rows = s.term.rows || 24;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // data-lz-task-id holds the URL-ESCAPED segment — interpolate raw; a
      // second escape turns %20 into %2520, a different address.
      let url = proto + '//' + location.host + '/tasks/' + taskId +
        '/shell/ws?cols=' + cols + '&rows=' + rows;
      if (s.mode && s.mode !== 'shell') url += '&mode=' + encodeURIComponent(s.mode);
      const ws = new WebSocket(url);
      s.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        s.status = 'Connected'; s.connected = true; refreshStatus(); refreshIndex();
        sendResize(s); flushPending(s);
        if (active === s) s.term.focus();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === 'ready') {
            s.status = 'Connected'; s.connected = true; refreshStatus(); refreshIndex();
            // The block goes in only once the exec is actually up, so its
            // announcement lands above its own output and not above an error.
            startRun(s);
            flushPending(s);
          }
          else if (msg.type === 'exit') { s.term.write('\\r\\n[process exited' + (msg.code != null ? ' (' + msg.code + ')' : '') + ']\\r\\n'); }
          else if (msg.type === 'error') { s.term.write('\\r\\n[error: ' + msg.message + ']\\r\\n'); }
        } else {
          s.term.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = () => {
        s.connected = false;
        s.status = s.closedByUser ? 'Disconnected' : 'Disconnected — connection dropped';
        s.dropped = !s.closedByUser;
        if (s.ws === ws) s.ws = null;
        refreshStatus();
        refreshIndex();
      };
      ws.onerror = () => { s.status = 'Connection error'; s.connected = false; refreshStatus(); refreshIndex(); };
    }

    function disconnect(s) {
      s.closedByUser = true;
      if (s.ws) { try { s.ws.close(); } catch (e) {} s.ws = null; }
    }

    /** Close one session: its exec, its terminal, its row in the strip or slot. */
    function closeSession(s) {
      disconnect(s);
      if (s.ro) { try { s.ro.disconnect(); } catch (e) {} s.ro = null; }
      if (s.term) { try { s.term.dispose(); } catch (e) {} s.term = null; }
      const i = sessions.indexOf(s);
      if (i >= 0) sessions.splice(i, 1);
      if (s.tab) s.tab.remove();
      s.el.classList.remove('is-maximised');
      s.el.remove();
      if (s.mount) {
        s.mount.hidden = true;
        s.mount.classList.remove('is-live');
        setStepLive(s.mount, false);
      }
      const hosted = sessions.filter(function (x) { return !x.mount; });
      if (active === s) {
        active = null;
        if (sessions.length) activate(sessions[sessions.length - 1]);
        else setOpen(false);
      } else if (hosted.length === 0) {
        setOpen(false);
      }
      refreshStatus();
      refreshIndex();
    }

    function closeAll() {
      while (sessions.length) closeSession(sessions[sessions.length - 1]);
    }

    /**
     * Open a new session. \`run\`, when given, is the text executed in it once the
     * exec is ready — that is what makes Run a fresh session rather than a write
     * into somebody else's terminal. \`opts.mount\` appends the terminal under a
     * verification step instead of the persist panel; the element never moves.
     */
    function openSession(label, run, opts) {
      opts = opts || {};
      seq++;
      const s = {
        id: 's' + seq,
        label: label || ('Shell ' + seq),
        run: run || null,
        ran: false,
        pending: [],
        status: 'Connecting…',
        connected: false,
        dropped: false,
        closedByUser: false,
        startFailed: null,
        term: null, fit: null, ws: null, ro: null,
        mount: opts.mount || null,
        origin: opts.origin || (opts.mount ? 'Verification' : 'here'),
        mode: opts.mode || 'shell',
      };

      const tab = document.createElement('span');
      tab.className = 'lz-shell-tab';
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'lz-shell-tab-btn';
      tabBtn.setAttribute('role', 'tab');
      tabBtn.textContent = s.label;
      const tabClose = document.createElement('button');
      tabClose.type = 'button';
      tabClose.className = 'lz-shell-tab-close';
      tabClose.title = 'Close this shell';
      tabClose.setAttribute('aria-label', 'Close ' + s.label);
      tabClose.textContent = '×';
      tab.appendChild(tabBtn);
      tab.appendChild(tabClose);
      if (!s.mount) tabsEl.appendChild(tab);
      else tab.hidden = true;

      const el = document.createElement('div');
      el.className = 'lz-shell-session';
      el.setAttribute('data-lz-shell-session', s.id);
      const bar = document.createElement('div');
      bar.className = 'lz-shell-session-bar';
      const barLabel = document.createElement('span');
      barLabel.textContent = s.label;
      const maxBtn = document.createElement('button');
      maxBtn.type = 'button';
      maxBtn.className = 'btn btn-sm';
      maxBtn.textContent = 'maximise';
      maxBtn.title = 'Enlarge this terminal in place';
      const sessClose = document.createElement('button');
      sessClose.type = 'button';
      sessClose.className = 'btn btn-sm';
      sessClose.textContent = '×';
      sessClose.title = 'Close this shell';
      bar.appendChild(barLabel);
      bar.appendChild(maxBtn);
      bar.appendChild(sessClose);
      const termEl = document.createElement('div');
      termEl.className = 'lz-shell-term';
      termEl.setAttribute('data-lz-shell-term', '');
      el.appendChild(bar);
      el.appendChild(termEl);

      if (s.mount) {
        s.mount.hidden = false;
        s.mount.classList.add('is-live');
        s.mount.appendChild(el);
        s.mount.__lzRun = { text: run, label: s.label, origin: s.origin };
        setStepLive(s.mount, true);
      } else {
        sessionsEl.appendChild(el);
      }

      s.tab = tab; s.tabBtn = tabBtn; s.el = el; s.termEl = termEl;
      sessions.push(s);
      tabBtn.addEventListener('click', () => activate(s));
      tabClose.addEventListener('click', () => closeSession(s));
      maxBtn.addEventListener('click', () => toggleMaximise(s));
      sessClose.addEventListener('click', () => closeSession(s));
      activate(s);
      void connect(s);
      refreshIndex();
      return s;
    }

    function setOpen(open) {
      panel.hidden = !open;
      root.classList.toggle('is-open', open);
    }

    function switchToShellTab() {
      const page = document.querySelector('[data-lz-task-page]');
      if (!page || page.getAttribute('data-lz-current-tab') === 'shell') return;
      if (typeof window.lzSwitchTaskTab !== 'function') return;
      const id = page.getAttribute('data-lz-task-id') || taskId;
      window.lzSwitchTaskTab('/tasks/' + id + '/shell', true);
    }

    // Open a NEW session. A mount option appends under the step that launched
    // it and does not scroll. Without a mount, the persist panel hosts it and
    // we switch to the Shell tab so the terminal is actually visible.
    root.__lzGoToMount = (mount) => {
      const live = sessionForMount(mount);
      if (live) goToSession(live);
    };

    root.__lzShellRun = (text, label, opts) => {
      opts = opts || {};
      if (opts.mount) {
        const live = sessionForMount(opts.mount);
        if (live && opts.rerun) closeSession(live);
        else if (live && (live.connected || live.ws)) return 'live';
        else if (live) closeSession(live);
        openSession(label, text, { mount: opts.mount, origin: opts.origin, mode: opts.mode });
        return true;
      }
      setOpen(true);
      openSession(label, text, { origin: opts.origin || 'here', mode: opts.mode });
      switchToShellTab();
      return true;
    };

    openBtn.addEventListener('click', () => {
      const opening = panel.hidden;
      setOpen(opening);
      if (!opening) { closeAll(); return; }
      const hosted = sessions.filter(function (x) { return !x.mount; });
      if (!hosted.length) openSession('Shell', null);
      else activate(active || hosted[hosted.length - 1]);
    });
    if (newTabBtn) newTabBtn.addEventListener('click', () => openSession('Shell', null));
    closeBtn.addEventListener('click', () => { setOpen(false); closeAll(); });
    reconnectBtn.addEventListener('click', () => { if (active) void connect(active); });
    window.addEventListener('beforeunload', () => closeAll());
  }

  /**
   * Run text in a task's shell from elsewhere on the page, in a new labelled
   * session. \`opts.mount\` (a DOM node) is the slot under a verification step.
   * With no taskId (the usual case — one panel per page) the first wired
   * panel is used.
   */
  window.lzShellRun = function (text, taskId, label, opts) {
    const roots = document.querySelectorAll('.lz-shell[data-lz-shell-task]');
    for (let i = 0; i < roots.length; i++) {
      const el = roots[i];
      if (taskId && el.getAttribute('data-lz-shell-task') !== taskId) continue;
      if (typeof el.__lzShellRun === 'function') { return el.__lzShellRun(text, label, opts); }
    }
    return false;
  };

  function wireAll() { document.querySelectorAll('.lz-shell[data-lz-shell-task]').forEach(wire); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireAll);
  else wireAll();

  // Run-a-command buttons (the Services card's "Start services", and the same
  // button on the down-service notice). Delegated, so a card rendered anywhere
  // on the page finds its shell panel by task id.
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest ? ev.target.closest('[data-lz-shell-run]') : null;
    if (!btn) return;
    const taskId = btn.getAttribute('data-lz-shell-for');
    const root = document.querySelector('.lz-shell[data-lz-shell-task="' + (window.CSS && CSS.escape ? CSS.escape(taskId) : taskId) + '"]');
    if (!root) return;
    wire(root);
    const cmd = btn.getAttribute('data-lz-shell-run') || '';
    const label = btn.getAttribute('data-lz-shell-label') || 'Run';
    // A mount slot right beneath the button, same convention as the
    // How-to-verify Run buttons (review-verify.ts's codePanelHtml): the
    // terminal opens in place, on whatever tab the button lives on, instead
    // of pulling the reader over to the Shell tab.
    const step = btn.closest('[data-lz-shell-step]');
    const mount = step ? step.querySelector('[data-lz-shell-mount]') : null;
    // Same convention as the How-to-verify Run buttons: the caller supplies the
    // newline that actually runs the command.
    if (cmd && root.__lzShellRun) {
      root.__lzShellRun(cmd.replace(/\\n+$/, '') + '\\n', label, { mount: mount || undefined, origin: 'Services' });
    }
  });

  document.addEventListener('click', (ev) => {
    const open = ev.target.closest ? ev.target.closest('.rv-cmd-open') : null;
    if (open) {
      ev.preventDefault();
      const step = open.closest('[data-lz-shell-step]');
      const mount = step ? step.querySelector('[data-lz-shell-mount]') : null;
      if (!mount) return;
      const root = document.querySelector('.lz-shell[data-lz-shell-task]');
      if (!root || !root.__lzGoToMount) return;
      root.__lzGoToMount(mount);
      return;
    }
    const rerun = ev.target.closest ? ev.target.closest('.rv-cmd-rerun') : null;
    if (rerun) {
      ev.preventDefault();
      const step = rerun.closest('[data-lz-shell-step]');
      const mount = step ? step.querySelector('[data-lz-shell-mount]') : null;
      if (!mount || !mount.__lzRun) return;
      const runBtn = step.querySelector('.rv-cmd-run');
      const text = (runBtn && runBtn.dataset.run) ? runBtn.dataset.run.replace(/\\n+$/, '') + '\\n' : mount.__lzRun.text;
      const label = (runBtn && runBtn.dataset.runLabel) || mount.__lzRun.label;
      const origin = (runBtn && runBtn.getAttribute('data-lz-shell-origin')) || mount.__lzRun.origin;
      window.lzShellRun(text, null, label, { mount: mount, origin: origin, rerun: true });
      return;
    }
    const modeBtn = ev.target.closest ? ev.target.closest('[data-lz-shell-mode]') : null;
    if (!modeBtn) return;
    ev.preventDefault();
    const mode = modeBtn.getAttribute('data-lz-shell-mode') || 'shell';
    const label = mode === 'pair' ? 'Pair' : mode === 'chat' ? 'Chat' : 'Shell';
    window.lzShellRun('', null, label, { mode: mode, origin: mode === 'shell' ? 'here' : label });
  });
})();
</script>`;
}
