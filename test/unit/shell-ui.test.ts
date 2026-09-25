/**
 * Unit tests for the web shell's markup and client script (src/server/shell-ui.ts).
 *
 * There is no DOM harness here, so the script is pinned as TEXT: the assertions
 * name the hooks the browser behaviour depends on (the custom key handler, the
 * clipboard reads, the re-fit triggers, the run entry point). They are coarse
 * by design — they catch a wiring that was dropped, not a logic bug — and the
 * panel-level behaviour they stand in for is exercised by hand.
 */

import { describe, test, expect } from 'bun:test';
import { shellPanelHtml, shellClientScript, shellTabHtml } from '../../src/server/shell-ui';

describe('shellPanelHtml', () => {
  test('an available shell renders the open button and a hidden panel', () => {
    const html = shellPanelHtml('task-1', { available: true });
    expect(html).toContain('data-lz-shell-task="task-1"');
    expect(html).toContain('data-lz-shell-open');
    expect(html).toContain('<div class="lz-shell-panel" hidden>');
  });

  // Sessions are created by the client script, one per tab. Shipping a terminal
  // in the static markup would make the first session special — the one Run
  // could reuse, which is exactly the behaviour this panel is not supposed to
  // have any more.
  test('the panel ships with an empty tab strip and no terminal', () => {
    const html = shellPanelHtml('task-1', { available: true });
    expect(html).toContain('data-lz-shell-tabs');
    expect(html).toContain('data-lz-shell-sessions');
    expect(html).toContain('data-lz-shell-newtab');
    expect(html).not.toContain('data-lz-shell-term');
  });

  test('an unavailable shell renders a disabled button carrying the reason', () => {
    const html = shellPanelHtml('task-1', { available: false, reason: 'Container is not running.' });
    expect(html).toContain('disabled');
    expect(html).toContain('Container is not running.');
    expect(html).not.toContain('data-lz-shell-open');
  });
});

describe('shellClientScript', () => {
  const script = shellClientScript();

  // The panel is as wide as the page's content column, so anything that changes
  // that column's size has to reflow the terminal AND tell the PTY its new size.
  test('re-fits and sends the resize frame on open, panel resize and window resize', () => {
    expect(script).toContain('new ResizeObserver');
    expect(script).toContain("window.addEventListener('resize', onWindowResize)");
    expect(script).toContain("type: 'resize'");
    // The fit itself must not be gated on the socket: a panel opened before the
    // connection lands still has to measure, or the first frame is 80x24.
    expect(script).toMatch(/function sendResize\(s\)\s*\{\s*\n\s*if \(!s \|\| !s\.fit\) return;/);
  });

  test('the open/close toggle drives the full-width class', () => {
    expect(script).toContain("root.classList.toggle('is-open', open)");
  });

  test('a custom key handler is attached for the clipboard shortcuts', () => {
    expect(script).toContain('s.term.attachCustomKeyEventHandler(makeKeyHandler(s))');
    // Ctrl/Cmd+V and Shift+Insert paste through the async clipboard API.
    expect(script).toContain('navigator.clipboard.readText()');
    expect(script).toContain("ev.key === 'Insert'");
    expect(script).toContain("if (key === 'v') { pasteInto(s); return false; }");
    // Ctrl+C copies a selection, and without one falls through so ^C still
    // reaches the process as the interrupt.
    expect(script).toContain('s.term.getSelection()');
    expect(script).toContain('if (!selection) return true;');
    expect(script).toContain('navigator.clipboard.writeText(selection)');
  });

  test('exposes lzShellRun, which queues text until the session is connected', () => {
    expect(script).toContain('window.lzShellRun = function (text, taskId, label, opts)');
    expect(script).toContain('root.__lzShellRun');
    expect(script).toContain('s.pending.push(text)');
    expect(script).toContain('flushPending(s)');
  });

  // INVARIANT: a Run gets a shell of its own. Writing into the session already
  // on screen interleaves an unrelated command stream with whatever the human
  // was doing, and mixes two verification blocks' output into one scrollback.
  test('running always opens a new labelled session rather than reusing one', () => {
    expect(script).toContain('root.__lzShellRun = (text, label, opts) => {');
    expect(script).toContain('function openSession(label, run, opts)');
    // A mount reuses the live session (Open / Re-run). Without a mount, a Run
    // still always creates a fresh session — never types into one already open.
    expect(script).toContain("openSession(label, text, { origin: opts.origin || 'here', mode: opts.mode })");
  });

  test('a mount option appends under the step and does not scroll the page', () => {
    expect(script).toContain('opts.mount');
    expect(script).toContain('s.mount.appendChild(el)');
    // scrollIntoView is only the index "go to" path, never the Run-to-mount path.
    expect(script).toContain('function goToSession(s)');
    expect(script).toMatch(/root\.__lzShellRun = \(text, label, opts\) => \{[\s\S]*?if \(opts\.mount\) \{[\s\S]*?openSession\([\s\S]*?return true;/);
    expect(script).not.toMatch(/root\.__lzShellRun[\s\S]*?opts\.mount[\s\S]*?scrollIntoView/);
  });

  // INVARIANT: a mounted session (Verify, Services, ...) can live on any tab.
  // "go to" must read which tab it is actually mounted on from the DOM rather
  // than hardcoding one — a hardcoded 'verify' here previously sent a Services
  // session's "go to" to the wrong tab.
  // The real DOM behaviour (a mounted session found on whichever tab it lives
  // on, and "already here" decided by the body's own hidden state rather than
  // a path/pathname string compare) is exercised end-to-end in
  // test/unit/services-shell-in-place.test.ts. This just pins the mechanism.
  test('goToSession reads the mount\'s own tab body, and decides "already here" by its hidden state', () => {
    expect(script).toContain("s.mount.closest('[data-lz-tab-body]')");
    expect(script).toContain("body.getAttribute('data-lz-tab-path')");
    expect(script).toContain('body && body.hidden && targetPath');
  });

  test('maximise toggles a class on the session element rather than re-parenting it', () => {
    expect(script).toContain("s.el.classList.add('is-maximised')");
    expect(script).toContain("document.body.classList.toggle('lz-shell-maximised', on)");
  });

  // INVARIANT: executing is visible and its outcome is not hidden. The block is
  // printed before it runs, and a trailer reports the status of a command that
  // would otherwise fail without saying so.
  test('a run announces its commands and echoes the exit status', () => {
    expect(script).toContain('[lazy] exit status: $?');
    expect(script).toContain("s.term.write('\\r\\n\\x1b[36m[lazy] ' + s.label");
    expect(script).toContain('sendText(s, EXIT_TRAILER);');
    // Only once per session: a reconnect must not silently re-execute the block.
    expect(script).toContain('if (!s.run || s.ran) return;');
  });

  // INVARIANT: nothing execs into a container without a click. The run entry
  // point is only ever reached from a listener.
  test('the block is sent only once the exec is ready, never on load', () => {
    expect(script).toMatch(/msg\.type === 'ready'[\s\S]*?startRun\(s\);/);
  });

  test('closing a tab tears down its exec, terminal and observer', () => {
    expect(script).toContain('function closeSession(s)');
    expect(script).toContain('s.ro.disconnect()');
    expect(script).toContain('s.term.dispose()');
    expect(script).toContain("window.addEventListener('beforeunload', () => closeAll())");
  });

  test('Pair and Chat ride the same WebSocket with a mode query', () => {
    expect(script).toContain("url += '&mode=' + encodeURIComponent(s.mode)");
    expect(script).toContain("data-lz-shell-mode");
  });
});

describe('shellTabHtml', () => {
  test('available shell offers New, Pair, Chat, and says sessions die on reload', () => {
    const html = shellTabHtml({
      taskId: 'task-1',
      taskCode: 'fix-hub',
      avail: { available: true },
    });
    expect(html).toContain('data-lz-shell-mode="shell"');
    expect(html).toContain('data-lz-shell-mode="pair"');
    expect(html).toContain('data-lz-shell-mode="chat"');
    expect(html).toContain('data-lz-shell-index');
    expect(html).toContain('Sessions close when you reload');
    expect(html).toContain('lazy shell fix-hub');
    expect(html).toContain('does not lock the task');
  });

  test('unavailable shell shows the reason and still names lazy shell', () => {
    const html = shellTabHtml({
      taskId: 'task-1',
      taskCode: 'fix-hub',
      avail: { available: false, reason: 'Container for this task is not running.', code: 'not-running' },
    });
    expect(html).toContain('Container for this task is not running.');
    // INVARIANT: no Start container button here. Opening a session starts the
    // container itself, so a button beside the reason was pure ceremony.
    expect(html).not.toContain('container/start');
    expect(html).not.toContain('Start container');
    expect(html).toContain('data-lz-shell-mode="pair"');
    expect(html).toContain('data-lz-shell-index');
    expect(html).toContain(' disabled title="Container for this task is not running."');
    expect(html).toContain('lazy shell fix-hub');
  });
});

