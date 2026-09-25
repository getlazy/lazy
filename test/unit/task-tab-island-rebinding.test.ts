/**
 * `activateScripts()` (task-tabs.ts), the mechanism behind an in-place tab
 * switch running a fragment's own <script> tags: a <script> parsed into
 * detached markup (which is exactly what `wrap.innerHTML = html` in
 * taskTabSwitchScript does) never runs, only a script the browser parses
 * itself, or one inserted as a genuinely new node, executes.
 *
 * This drives that ONE mechanism against a synthetic island — it proves
 * activateScripts re-creates and runs a fragment's <script>, on both a first
 * fetch and a data-lz-stale refetch. It does NOT exercise any real control:
 * the "+" comment button and Verify's Run button ship as page-level islands
 * (reviewScript / verifyRunScript in review.ts / review-verify.ts), never
 * inside a fragment, so activateScripts never touches them. The diff
 * toolbar is the opposite case and DOES depend on activateScripts —
 * changesScripts (changesViewScript + diffViewScript) is built and returned
 * as part of the Changes tab's own fragment body (review.ts, the
 * `embed: 'changes'` return) — so it is real coverage this file cannot
 * claim, not a third page-level exception. Real-control coverage for all
 * three lives in task-tab-real-controls.test.ts, which renders the actual
 * fragments.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { taskTabSwitchScript, taskTabStripHtml } from '../../src/server/task-tabs';

const TASK = 'task-1';

function stripTag(s: string): string {
  return s.replace(/^<script>/, '').replace(/<\/script>$/, '');
}

/** A tab body that carries its own tab-local island, like diffViewScript. */
function bodyWithIsland(path: string, clicks: string): string {
  return (
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${path}">` +
    `<button type="button" id="isle-btn">click me</button>` +
    `<span id="isle-count">0</span>` +
    `<script>
(function () {
  var btn = document.getElementById('isle-btn');
  var count = document.getElementById('isle-count');
  btn.addEventListener('click', function () {
    count.textContent = String(Number(count.textContent) + 1);
  });
  window.${clicks} = (window.${clicks} || 0) + 1;
})();
</script>` +
    `</div>`
  );
}

function fragmentHtml(current: 'landing' | 'changes', bodyMarker: string): string {
  const strip = taskTabStripHtml({ taskId: TASK, current });
  const path = current === 'landing' ? `/tasks/${TASK}` : `/tasks/${TASK}/changes`;
  return `<div class="lz-landing-header"><h1>Task</h1></div>${strip}${bodyWithIsland(path, bodyMarker)}`;
}

function pageHtml(): string {
  const strip = taskTabStripHtml({ taskId: TASK, current: 'landing' });
  const path = `/tasks/${TASK}`;
  return (
    `<div data-lz-task-page data-lz-task-id="${TASK}" data-lz-current-tab="landing">` +
    `<div class="lz-landing-header"><h1>Task</h1></div>` +
    strip +
    `<div data-lz-tab-bodies>` +
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${path}"><p>landing</p></div>` +
    `</div></div>`
  );
}

interface Harness {
  win: InstanceType<typeof Window>;
  doc: Document;
}

function landingFragmentHtml(): string {
  const strip = taskTabStripHtml({ taskId: TASK, current: 'landing' });
  return `<div class="lz-landing-header"><h1>Task</h1></div>${strip}` +
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="/tasks/${TASK}"><p>landing</p></div>`;
}

function setup(servedForChanges: () => string): Harness {
  const win = new Window({
    url: `http://localhost/tasks/${TASK}`,
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = pageHtml();

  const w = win as unknown as Record<string, unknown>;
  w.fetch = ((url: string) => {
    const isChanges = url.indexOf('/changes') !== -1;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(isChanges ? servedForChanges() : landingFragmentHtml()),
    });
  }) as unknown;

  (win as unknown as { eval(c: string): void }).eval(stripTag(taskTabSwitchScript()));
  return { win, doc };
}

async function until(fn: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a tab-local island survives an in-place tab switch', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.win.happyDOM.close();
  });

  test('a fragment fetched by clicking a tab runs its own <script>, and the click handler it binds actually fires', async () => {
    const h = setup(() => fragmentHtml('changes', 'islandRanA'));
    harness = h;

    const w = h.win as unknown as { lzSwitchTaskTab?: (href: string, push: boolean) => void };
    expect(typeof w.lzSwitchTaskTab).toBe('function');
    w.lzSwitchTaskTab!(`/tasks/${TASK}/changes`, true);

    await until(() => !!h.doc.getElementById('isle-btn'), 'the fetched body to land');
    // The island's own top-level code ran (not just parsed inertly).
    await until(
      () => (h.win as unknown as Record<string, unknown>).islandRanA === 1,
      'the island script to execute',
    );

    const btn = h.doc.getElementById('isle-btn') as unknown as { click(): void };
    btn.click();
    expect(h.doc.getElementById('isle-count')?.textContent).toBe('1');
  });

  test('a tab body invalidated and refetched (data-lz-stale) re-runs its island too', async () => {
    let generation = 0;
    const h = setup(() => {
      generation += 1;
      return fragmentHtml('changes', `islandRanGen${generation}`);
    });
    harness = h;
    const w = h.win as unknown as { lzSwitchTaskTab?: (href: string, push: boolean) => void };

    w.lzSwitchTaskTab!(`/tasks/${TASK}/changes`, true);
    await until(() => !!h.doc.getElementById('isle-btn'), 'the first fetch to land');

    // Simulate the live-status island marking the current body stale, then
    // switching away and back — the body gets removed and refetched fresh
    // (task-tabs.ts applyFragment), not reused from cache.
    const body = h.doc.querySelector('[data-lz-tab-body]:not([hidden])');
    body?.setAttribute('data-lz-stale', '1');
    w.lzSwitchTaskTab!(`/tasks/${TASK}`, true);
    await until(
      () => h.doc.querySelector(`[data-lz-tab-path="/tasks/${TASK}"]`)?.hasAttribute('hidden') === false,
      'the landing switch to land',
    );
    w.lzSwitchTaskTab!(`/tasks/${TASK}/changes`, true);

    await until(
      () => (h.win as unknown as Record<string, unknown>).islandRanGen2 === 1,
      'the refetched island script to execute',
    );
    const btn = h.doc.getElementById('isle-btn') as unknown as { click(): void };
    btn.click();
    expect(h.doc.getElementById('isle-count')?.textContent).toBe('1');
  });
});
