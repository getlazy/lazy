/**
 * "Start services" runs its terminal IN PLACE — on the Services tab, and on
 * the down-service notice — instead of switching the reader to the Shell tab.
 *
 * These render the ACTUAL markup (`servicesCardHtml`, `serveNoticeHtml`,
 * `shellPanelHtml`) and the ACTUAL client script (`shellClientScript`,
 * `domMorphScript`) in a real DOM (happy-dom), and drive a real click —
 * unlike shell-ui.test.ts's text-pinning, an attribute grep cannot see any of
 * these defects: the mount being deleted by a background morph, the terminal
 * being squeezed into a flex row, or a control that goes dead after one press.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { servicesCardHtml, type ProbedServeState, type ServicesCardControls } from '../../src/server/services-card';
import { serveNoticeHtml } from '../../src/server/serve-notice';
import { shellPanelHtml, shellClientScript } from '../../src/server/shell-ui';
import { domMorphScript } from '../../src/server/dom-morph';
import { taskTabStripHtml, taskTabSwitchScript } from '../../src/server/task-tabs';
import { viewedStateScript } from '../../src/server/viewed-cards';

const TASK_ID = 'task-in-place-0001';
const task = { id: TASK_ID, code: 'svc-task' };

const serve: ProbedServeState = {
  declared: [{ name: 'web', port: 3000 }],
  services: [{ name: 'web', port: 3000, binding: null, url: null, listening: false }],
  unavailable: null,
  containerName: 'lazy-svc-task',
  runnerType: 'docker',
};

const controls: ServicesCardControls = {
  taskId: TASK_ID,
  canStart: true,
  canDesignate: false,
  start: null,
  startServicesCmd: 'bin/dev',
  shellAvailable: true,
};

let win: InstanceType<typeof Window>;
let doc: Document;

/** Strip every `<script>` wrapper and run the island source(s) in the window. */
function installScript(w: InstanceType<typeof Window>, source: string): void {
  const src = source.replace(/<\/?script>/g, '');
  (w as unknown as { eval(code: string): void }).eval(src);
}

/**
 * A minimal stand-in for task-tabs.ts's real tab switcher: toggles `hidden`
 * on tab bodies by path and updates `data-lz-current-tab` — the same two
 * facts shell-ui.ts's goToSession actually reads. The real switcher fetches
 * a fragment over the network, which a unit test has no server for; this
 * covers the observable contract without it.
 */
function installFakeTabSwitcher(w: InstanceType<typeof Window>): void {
  const d = w.document as unknown as Document;
  (w as unknown as { lzSwitchTaskTab(path: string): void }).lzSwitchTaskTab = (path: string) => {
    const page = d.querySelector('[data-lz-task-page]') as Element;
    const bodies = Array.from(d.querySelectorAll('[data-lz-tab-body]')) as HTMLElement[];
    let matchedTab: string | null = null;
    for (const b of bodies) {
      const isTarget = b.getAttribute('data-lz-tab-path') === path;
      b.hidden = !isTarget;
      if (isTarget) matchedTab = b.getAttribute('data-lz-tab-id');
    }
    if (matchedTab) page.setAttribute('data-lz-current-tab', matchedTab);
  };
}

function setupPage(bodyHtml: { services: string; shell: string; landing?: string }): void {
  win = new Window({
    url: `http://localhost/tasks/${TASK_ID}/services`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  doc = win.document as unknown as Document;

  const persistShellHtml = shellPanelHtml(TASK_ID, { available: true });

  doc.body.innerHTML =
    `<div data-lz-task-page data-lz-task-id="${TASK_ID}" data-lz-current-tab="services">` +
    `<div data-lz-tab-bodies>` +
    `<div data-lz-tab-body data-lz-tab-id="services" data-lz-tab-path="/tasks/${TASK_ID}/services">` +
    bodyHtml.services +
    `</div>` +
    `<div data-lz-tab-body data-lz-tab-id="shell" data-lz-tab-path="/tasks/${TASK_ID}/shell" hidden>` +
    bodyHtml.shell +
    `</div>` +
    (bodyHtml.landing
      ? `<div data-lz-tab-body data-lz-tab-id="landing" data-lz-tab-path="/tasks/${TASK_ID}" hidden>` +
        bodyHtml.landing +
        `</div>`
      : '') +
    `</div>` +
    persistShellHtml +
    `</div>`;

  installScript(win, domMorphScript());
  installScript(win, shellClientScript());
  installFakeTabSwitcher(win);
}

function click(el: Element): void {
  const Ev = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  el.dispatchEvent(new Ev('click', { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  await win.happyDOM.close();
});

describe('Start services runs in place on the Services tab', () => {
  beforeEach(() => {
    const services = servicesCardHtml(task, serve, controls);
    setupPage({ services, shell: '' });
  });

  test('clicking Start services lands a session inside its own mount, not the persist panel', () => {
    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    expect(runBtn).toBeTruthy();
    const step = runBtn.closest('[data-lz-shell-step]') as HTMLElement;
    const mount = step.querySelector('[data-lz-shell-mount]') as HTMLElement;
    expect(mount.querySelector('.lz-shell-session')).toBeNull();

    click(runBtn);

    expect(mount.querySelector('.lz-shell-session')).not.toBeNull();
    // The persist panel (the page-level `.lz-shell-sessions`) never receives it.
    const persistSessions = doc.querySelector('[data-lz-shell-sessions]') as HTMLElement;
    expect(persistSessions.querySelector('.lz-shell-session')).toBeNull();
  });

  test('does not switch tabs — the reader stays on Services', () => {
    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    click(runBtn);
    const page = doc.querySelector('[data-lz-task-page]') as HTMLElement;
    expect(page.getAttribute('data-lz-current-tab')).toBe('services');
    const servicesBody = doc.querySelector('[data-lz-tab-id="services"]') as HTMLElement;
    expect(servicesBody.hidden).toBe(false);
  });

  test('Start services gives way to Open/Re-run once the session is live', () => {
    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    const step = runBtn.closest('[data-lz-shell-step]') as HTMLElement;
    const openBtn = step.querySelector('.rv-cmd-open') as HTMLElement;
    const rerunBtn = step.querySelector('.rv-cmd-rerun') as HTMLElement;
    expect(openBtn.hidden).toBe(true);
    expect(rerunBtn.hidden).toBe(true);

    click(runBtn);

    expect(runBtn.hidden).toBe(true);
    expect(openBtn.hidden).toBe(false);
    expect(rerunBtn.hidden).toBe(false);
  });

  test('switching to Shell and back leaves the session exactly where it was', () => {
    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    const step = runBtn.closest('[data-lz-shell-step]') as HTMLElement;
    const mount = step.querySelector('[data-lz-shell-mount]') as HTMLElement;
    click(runBtn);
    const session = mount.querySelector('.lz-shell-session');
    expect(session).not.toBeNull();

    (win as unknown as { lzSwitchTaskTab(p: string): void }).lzSwitchTaskTab(`/tasks/${TASK_ID}/shell`);
    (win as unknown as { lzSwitchTaskTab(p: string): void }).lzSwitchTaskTab(`/tasks/${TASK_ID}/services`);

    expect(mount.querySelector('.lz-shell-session')).toBe(session as never);
  });
});

describe('Start services on the down-service notice runs in place too', () => {
  beforeEach(() => {
    const notice = serveNoticeHtml(
      task,
      { service: 'web', reason: 'not-listening' },
      serve,
      controls,
      null,
    );
    setupPage({ services: '', shell: '', landing: notice });
    (doc.querySelector('[data-lz-task-page]') as HTMLElement).setAttribute('data-lz-current-tab', 'landing');
    (doc.querySelector('[data-lz-tab-id="landing"]') as HTMLElement).hidden = false;
    (doc.querySelector('[data-lz-tab-id="services"]') as HTMLElement).hidden = true;
  });

  test('the terminal is a sibling block below the actions row, not squeezed inside it', () => {
    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    const actionsRow = runBtn.closest('.lz-serve-notice-actions') as HTMLElement;
    const step = runBtn.closest('[data-lz-shell-step]') as HTMLElement;
    const mount = step.querySelector('[data-lz-shell-mount]') as HTMLElement;
    expect(actionsRow.contains(mount)).toBe(false);
    expect(step.contains(actionsRow)).toBe(true);
    expect(step.contains(mount)).toBe(true);
  });

  test('a live session survives a background morph of the landing body', () => {
    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    const step = runBtn.closest('[data-lz-shell-step]') as HTMLElement;
    const mount = step.querySelector('[data-lz-shell-mount]') as HTMLElement;
    click(runBtn);
    const session = mount.querySelector('.lz-shell-session');
    expect(session).not.toBeNull();

    // Re-render the exact same fragment, as task-live-status.ts's poll would
    // fetch it fresh from the server — always empty, since the server has no
    // notion of the live client-side terminal.
    const fresh = serveNoticeHtml(
      task,
      { service: 'web', reason: 'not-listening' },
      serve,
      controls,
      null,
    );
    const source = doc.createElement('div');
    source.innerHTML = fresh;
    const landingBody = doc.querySelector('[data-lz-tab-id="landing"]') as HTMLElement;
    (win as unknown as { lzMorph(a: unknown, b: unknown): void }).lzMorph(landingBody, source);

    const mountAfter = doc.querySelector('[data-lz-shell-mount]');
    expect(mountAfter).toBe(mount as never);
    expect(mountAfter?.querySelector('.lz-shell-session')).toBe(session as never);
  });
});

async function until(fn: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The REAL in-place tab switcher (`taskTabSwitchScript`) and REAL tab strip
 * (`taskTabStripHtml`), fetch mocked — not a hand-rolled stand-in — because
 * the defect this covers (a live terminal destroyed by `applyFragment`'s
 * `data-lz-stale` → `remove()` branch, task-tabs.ts) lives in that exact
 * script. A fake switcher that only toggled `hidden` would never have caught
 * it, which is exactly why it didn't the first time around.
 */
function setupRealSwitchPage(landingBodyHtml: string, servicesBodyHtml: string): void {
  win = new Window({
    url: `http://localhost/tasks/${TASK_ID}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  doc = win.document as unknown as Document;

  const landingPath = `/tasks/${TASK_ID}`;
  const servicesPath = `/tasks/${TASK_ID}/services`;
  const strip = taskTabStripHtml({ taskId: TASK_ID, current: 'landing' });

  doc.body.innerHTML =
    `<div data-lz-task-page data-lz-task-id="${TASK_ID}" data-lz-current-tab="landing">` +
    strip +
    `<div data-lz-tab-bodies>` +
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${landingPath}">${landingBodyHtml}</div>` +
    `</div>` +
    shellPanelHtml(TASK_ID, { available: true }) +
    `</div>`;

  const w = win as unknown as Record<string, unknown>;
  w.fetch = ((url: string) => {
    const isServices = url.indexOf('/services') !== -1;
    const current = isServices ? 'services' : 'landing';
    const path = isServices ? servicesPath : landingPath;
    const body = isServices ? servicesBodyHtml : landingBodyHtml;
    const html =
      taskTabStripHtml({ taskId: TASK_ID, current }) +
      `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${path}">${body}</div>`;
    return Promise.resolve({ ok: true, text: () => Promise.resolve(html) });
  }) as unknown;

  installScript(win, domMorphScript());
  installScript(win, shellClientScript());
  installScript(win, viewedStateScript(null));
  installScript(win, taskTabSwitchScript());
}

describe('the notice terminal survives a real in-place tab switch away and back', () => {
  test('a body marked data-lz-stale while hosting a live session is morphed, not removed', async () => {
    const notice = serveNoticeHtml(task, { service: 'web', reason: 'not-listening' }, serve, controls, null);
    const services = servicesCardHtml(task, serve, controls);
    setupRealSwitchPage(notice, services);

    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    click(runBtn);
    const landingBody = doc.querySelector('[data-lz-tab-path="/tasks/' + TASK_ID + '"]') as HTMLElement;
    const mount = landingBody.querySelector('[data-lz-shell-mount]') as HTMLElement;
    const session = mount.querySelector('.lz-shell-session');
    expect(session).not.toBeNull();

    // Simulate task-live-status.ts having marked this body stale — the
    // backstop in applyFragment (task-tabs.ts) is what this test is really
    // pinning, independent of how staleness got there.
    landingBody.setAttribute('data-lz-stale', '1');

    const w = win as unknown as { lzSwitchTaskTab(href: string, push: boolean): void };
    w.lzSwitchTaskTab(`/tasks/${TASK_ID}/services`, true);
    await until(
      () => doc.querySelector('[data-lz-tab-path="/tasks/' + TASK_ID + '/services"]')?.hasAttribute('hidden') === false,
      'the services switch to land',
    );
    w.lzSwitchTaskTab(`/tasks/${TASK_ID}`, true);
    await until(
      () => doc.querySelector('[data-lz-tab-path="/tasks/' + TASK_ID + '"]')?.hasAttribute('hidden') === false,
      'the landing switch to land',
    );

    // Same body node, same session node, still holding the terminal — a
    // remove()-and-refetch would have destroyed both identities.
    const landingBodyAfter = doc.querySelector('[data-lz-tab-path="/tasks/' + TASK_ID + '"]');
    expect(landingBodyAfter).toBe(landingBody as never);
    expect(landingBodyAfter?.querySelector('.lz-shell-session')).toBe(session as never);
    expect(landingBodyAfter?.hasAttribute('data-lz-stale')).toBe(false);
  });
});

describe('a live terminal is never a third, dead control after the viewed/unhide pass', () => {
  test('Start services stays hidden (Open/Re-run stay shown) after window.lzRefreshViewable()', () => {
    const services = servicesCardHtml(task, serve, controls);
    setupRealSwitchPage('<p>landing</p>', services);
    // Drive the Services body directly, as if the reader switched to it —
    // simplest way to exercise unhideVerifyControls against real markup.
    const host = doc.querySelector('[data-lz-tab-bodies]') as HTMLElement;
    host.insertAdjacentHTML('beforeend', `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="/tasks/${TASK_ID}/services">${services}</div>`);

    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    click(runBtn);
    const step = runBtn.closest('[data-lz-shell-step]') as HTMLElement;
    const openBtn = step.querySelector('.rv-cmd-open') as HTMLElement;
    const rerunBtn = step.querySelector('.rv-cmd-rerun') as HTMLElement;
    expect(runBtn.hidden).toBe(true);
    expect(openBtn.hidden).toBe(false);
    expect(rerunBtn.hidden).toBe(false);

    // The exact pass every in-place switch and every live morph re-runs.
    (win as unknown as { lzRefreshViewable(): void }).lzRefreshViewable();

    expect(runBtn.hidden).toBe(true);
    expect(openBtn.hidden).toBe(false);
    expect(rerunBtn.hidden).toBe(false);
  });

  test('the Services card never collapses while it hosts a live terminal', () => {
    // The Services card renders with allowViewed:false — no Viewed checkbox
    // at all — so the chevron (`.rv-vw-toggle`) is the ONLY control that can
    // collapse it. That is exactly the path that was folding a running
    // terminal away.
    const services = servicesCardHtml(task, serve, controls);
    setupRealSwitchPage('<p>landing</p>', services);
    const host = doc.querySelector('[data-lz-tab-bodies]') as HTMLElement;
    host.insertAdjacentHTML('beforeend', `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="/tasks/${TASK_ID}/services">${services}</div>`);
    (win as unknown as { lzRefreshViewable(): void }).lzRefreshViewable();

    const runBtn = doc.querySelector('[data-lz-shell-run]') as HTMLElement;
    click(runBtn);
    const section = runBtn.closest('[data-viewed-key]') as HTMLElement;
    expect(section).toBeTruthy();
    expect(section.dataset.collapsed).not.toBe('1');

    const toggle = section.querySelector('.rv-vw-toggle') as HTMLElement;
    click(toggle);
    expect(section.dataset.collapsed).not.toBe('1');

    (win as unknown as { lzRefreshViewable(): void }).lzRefreshViewable();
    expect(section.dataset.collapsed).not.toBe('1');
  });
});
