/**
 * The invariant the parent task asked for, driven against the REAL rendered
 * controls: the diff toolbar's "+" comment button and Verify's Run button
 * both work identically whether reached by a full page load, an in-place tab
 * switch, or a `data-lz-stale` refetch.
 *
 * Unlike task-tab-island-rebinding.test.ts (which proves only that
 * activateScripts runs a fragment's own <script>), this renders the ACTUAL
 * `taskPageHtml` output — full load and `fragment: true` — because the
 * comment button and Run button are bound by page-level islands
 * (reviewScript, verifyRunScript) that ship OUTSIDE every fragment and never
 * go through activateScripts at all. Their fix is that they delegate on
 * `document`, bound once at page load, so they need no re-binding on any
 * later switch — this test is what would have caught that they did not.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { Window } from 'happy-dom';
import { taskPageHtml, type TaskPageInput } from '../../src/server/task-page';
import type { Task } from '../../src/storage';
import type { TurnReport, ReviewComment } from '../../src/types';
import type { TaskTabId } from '../../src/server/task-tabs';
import { bundledStylesheet } from '../../src/server/styles';

const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// The task's code — the segment the server stamps onto tab bodies
// (data-lz-task-id drives it). Body identity is CANONICAL since the
// canonical-identity fix: a body is /tasks/<code>[/<tab>] regardless of the
// spelling the reader drove (the switchTab calls below deliberately keep
// driving uuid-spelled hrefs to pin that navigation). Select the bodies by
// the canonical stamp, never the entry spelling.
const CODE = 'demo-task';
const SERVER_DIR = join(import.meta.dir, '../../src/server');

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..89abcde 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 3;
`;

function task(): Task {
  return {
    id: TASK_ID,
    code: 'demo-task',
    goal: 'Do the thing',
    prompt: '',
    type: 'task',
    status: 'blocked',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  } as Task;
}

function verifyReport(): TurnReport {
  return {
    id: 'r1',
    task_id: TASK_ID,
    session_id: 's1',
    created_at: 1,
    sections: [{ kind: 'how_to_verify', body: '```bash\nbun test\n```' }] as TurnReport['sections'],
  };
}

/** A report whose prose annotateProse() will hang "+" buttons off. */
function proseReport(): TurnReport {
  return {
    id: 'r1',
    task_id: TASK_ID,
    session_id: 's1',
    created_at: 1,
    sections: [
      { kind: 'implementation', body: 'A paragraph of the report worth asking about.' },
    ] as TurnReport['sections'],
  };
}

/** A report with a real mermaid fence, so the page carries a diagram widget. */
function mermaidReport(): TurnReport {
  return {
    id: 'r1',
    task_id: TASK_ID,
    session_id: 's1',
    created_at: 1,
    sections: [
      { kind: 'implementation', body: 'Here is the flow:\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n' },
    ] as TurnReport['sections'],
  };
}

/**
 * A report declaring a presentation, so the Changes tab renders the SAME file
 * twice — `#rv-presented` and `#rv-root` — with identical anchors, and
 * changesViewScript hides one of the two panes.
 */
function presentedReport(): TurnReport {
  return {
    id: 'r1',
    task_id: TASK_ID,
    session_id: 's1',
    created_at: 1,
    sections: [],
    presentation: {
      groups: [{ title: 'Core', tier: 'core', items: [{ kind: 'file', file: 'src/foo.ts' }] }],
    },
  } as TurnReport;
}

// Matches src/review/draft-key.ts's draftKey(anchor, threadId, 'task') for
// the task-level anchor ((task), side new, line 0) and thread t1.
const TASK_REPLY_DRAFT_KEY = 'task new 0 t1 (task)';

const baseInput = {
  task: task(),
  session: null,
  turns: [],
  commits: [],
  comments: [],
  journal: [],
  raisedItems: [],
  children: [],
  promptVersions: [],
  // The real route (src/server/index.ts) resolves `shell` unconditionally on
  // every render, whichever tab — never gated on the tab being Verify. Match
  // that here: verifyRunScript is page-level and must be present on a
  // landing-tab load exactly as it is in production.
  shell: { available: true },
  // reviewScript (which seeds window LINE_DRAFTS) is page-level — it ships
  // ONLY on a full load, never in a fragment — so a stored draft has to be
  // seeded here, on whichever tab is the INITIAL full load, not on whatever
  // tab is later fetched as a fragment.
  lineDrafts: { [TASK_REPLY_DRAFT_KEY]: 'half-typed reply' },
} satisfies Partial<TaskPageInput>;

function fullLoadHtml(tab: TaskTabId = 'landing', extra: Partial<TaskPageInput> = {}): string {
  // Landing is the ordinary entry point (`/tasks/<id>`), and the worst case
  // for the "+" / Run tests below — neither #rv-changes/#rv-root nor a
  // .rv-cmd-run button exists anywhere on that page. A direct full load of
  // Changes/Verify/Services is the OTHER case that must work: it is the one
  // render order where window.lzOnce previously did not exist yet when a
  // tab-local island's own <script> ran (inner, which holds the tab body,
  // renders before taskPageHtml's page-level `scripts` block that used to
  // define it) — see the layoutOpenHtml fix.
  if (tab === 'changes') {
    return taskPageHtml({ ...baseInput, tab, review: { diffText: PATCH, reviewComments: [] }, ...extra });
  }
  if (tab === 'verify') {
    return taskPageHtml({ ...baseInput, tab, turnReport: verifyReport(), ...extra });
  }
  if (tab === 'services') {
    return taskPageHtml({
      ...baseInput,
      tab,
      branchAdvice: [{ name: 'web', port: 3000, command: 'lazy url demo-task web' }],
      ...extra,
    });
  }
  if (tab === 'review') {
    // A task-level ask thread: currentReviewHtml renders its Reply button
    // with BOTH .rv-reply and .rv-task-reply (threadHtml's taskLevel case) —
    // the exact double-class case the comment-listener scoping has to get
    // right. baseInput's lineDrafts (TASK_REPLY_DRAFT_KEY) is what makes the
    // double-fire bug OBSERVABLE: with no draft, the second (bogus)
    // invocation's closeTaskForms() finds the first box empty and removes it
    // before adding its own, landing back at one box by coincidence — the
    // real failure needs the first box to already hold text a human typed.
    return taskPageHtml({ ...baseInput, tab, review: { reviewComments: [taskLevelAskComment()] }, ...extra });
  }
  return taskPageHtml({ ...baseInput, tab, ...extra });
}

function taskLevelAskComment(): ReviewComment {
  return {
    id: 'c1',
    task_id: TASK_ID,
    thread_id: 't1',
    file: '(task)',
    line: 0,
    side: 'new',
    role: 'human',
    content: 'why this approach?',
    created_at: 1,
  } as ReviewComment;
}

function changesFragmentHtml(extra: Partial<TaskPageInput> = {}): string {
  return taskPageHtml({
    ...baseInput,
    tab: 'changes',
    fragment: true,
    review: { diffText: PATCH, reviewComments: [] },
    ...extra,
  });
}

function verifyFragmentHtml(): string {
  return taskPageHtml({
    ...baseInput,
    tab: 'verify',
    fragment: true,
    shell: { available: true },
    turnReport: verifyReport(),
  });
}

function reviewFragmentHtml(): string {
  // No lineDrafts here: reviewScript (which reads it into LINE_DRAFTS) is
  // page-level and never ships in a fragment — the draft has to already be
  // in the browser's LINE_DRAFTS from the original full load (baseInput),
  // same as production.
  return taskPageHtml({
    ...baseInput,
    tab: 'review',
    fragment: true,
    review: { reviewComments: [taskLevelAskComment()] },
  });
}

interface Harness {
  win: InstanceType<typeof Window>;
  doc: Document;
  shellRuns: string[];
  clipboardWrites: string[];
  threadFetches: number;
}

function setup(
  initialTab: TaskTabId = 'landing',
  extra: Partial<TaskPageInput> = {},
  opts: { collapseTimers?: boolean } = {},
): Harness {
  const win = new Window({
    url: `http://localhost/tasks/${TASK_ID}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      // The real stylesheet <link> and the mermaid asset <script src> are
      // both relative URLs happy-dom otherwise tries to fetch for real
      // against http://localhost — nothing is listening there in a test.
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  const doc = win.document as unknown as Document;

  const w = win as unknown as Record<string, unknown>;

  // reviewScript's poll schedules its next tick 3s/10s out. Collapsing that
  // lets a test observe a SECOND tick without a real wait — but it also
  // makes the poll's own restoreDrafts pass run every few milliseconds,
  // racing any test that asserts on which box is open where. So it is
  // opt-in: only the test that needs a second tick asks for it, and every
  // other test sees the poll fire once, at load, and then stay out of the
  // way.
  if (opts.collapseTimers) {
    const realSetTimeout = win.setTimeout.bind(win);
    w.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms && ms > 40 ? 5 : (ms ?? 0))) as unknown;
  }

  // fetch is mocked BEFORE doc.write: reviewScript's poll() fires
  // synchronously as soon as its <script> is parsed — on a full page load
  // exactly as fast as any switch-driven one — so it must already exist.
  let threadFetches = 0;
  w.fetch = ((url: string) => {
    if (url.indexOf('/threads') !== -1) {
      threadFetches += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          threads: [], queued: [], taskThreads: [],
          state: { status: 'blocked', turns: 0, lastActiveAt: Date.now(), askable: false },
          pending: 0, pendingDelivery: 0, everQueued: false, everAsked: false,
        }),
      });
    }
    const html = url.indexOf('/verify') !== -1
      ? verifyFragmentHtml()
      : url.indexOf('/changes') !== -1
        // The per-test override rides along into the FRAGMENT too, not just
        // the full load — a test that puts something in the page (a diagram,
        // a report) usually means it to arrive with the switched-to body.
        ? changesFragmentHtml(extra)
        : url.indexOf('/review') !== -1
          ? reviewFragmentHtml()
          : fullLoadHtml();
    return Promise.resolve({ ok: true, text: () => Promise.resolve(html) });
  }) as unknown;

  doc.open();
  doc.write(fullLoadHtml(initialTab, extra));
  doc.close();

  // lzShellRun/clipboard are mocked AFTER doc.write, on purpose: the real
  // page defines its own window.lzShellRun (shellClientScript, included
  // whenever `shell.available` is true — every fixture here) as part of that
  // same write, with no "already set" guard of its own. Mocking first would
  // just get overwritten by the real one a moment later.
  const shellRuns: string[] = [];
  const clipboardWrites: string[] = [];
  w.lzShellRun = ((text: string) => {
    shellRuns.push(text);
    return true;
  }) as unknown;
  Object.defineProperty(win.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });

  return { win, doc, shellRuns, clipboardWrites, get threadFetches() { return threadFetches; } };
}

async function until(fn: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function switchTab(h: Harness, path: string): void {
  const w = h.win as unknown as { lzSwitchTaskTab: (href: string, push: boolean) => void };
  w.lzSwitchTaskTab(path, true);
}

/** Mark the currently-visible tab body stale, as the live-status island does. */
function markCurrentBodyStale(h: Harness): void {
  const body = h.doc.querySelector('[data-lz-tab-body]:not([hidden])');
  body?.setAttribute('data-lz-stale', '1');
}

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.win.happyDOM.close();
  harness = null;
});

describe('the "+" comment button survives switching onto Changes', () => {
  test('after an in-place switch from landing, clicking "+" opens a comment box', async () => {
    const h = setup();
    harness = h;
    expect(h.doc.getElementById('rv-changes')).toBeNull();

    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => !!h.doc.querySelector('.rv-add-comment'), 'the Changes fragment to land');

    const btn = h.doc.querySelector('.rv-add-comment') as unknown as { click(): void };
    btn.click();
    await until(
      () => !!h.doc.querySelector('textarea[placeholder="Ask the agent about this line"]'),
      'the comment box to open',
    );
  });

  test('after a data-lz-stale refetch of Changes, "+" still opens a comment box', async () => {
    const h = setup();
    harness = h;

    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => !!h.doc.querySelector('.rv-add-comment'), 'the first Changes fetch to land');

    markCurrentBodyStale(h);
    switchTab(h, `/tasks/${TASK_ID}`);
    await until(
      () => h.doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}"]`)?.hasAttribute('hidden') === false,
      'the landing switch to land',
    );
    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => !!h.doc.querySelector('.rv-add-comment'), 'the refetched Changes body to land');

    const btn = h.doc.querySelector('.rv-add-comment') as unknown as { click(): void };
    btn.click();
    await until(
      () => !!h.doc.querySelector('textarea[placeholder="Ask the agent about this line"]'),
      'the comment box to open after refetch',
    );
  });
});

describe('Verify\'s Run button survives switching onto Verify', () => {
  test('after an in-place switch from landing, clicking Run reaches window.lzShellRun', async () => {
    const h = setup();
    harness = h;
    expect(h.doc.querySelector('.rv-cmd-run')).toBeNull();

    switchTab(h, `/tasks/${TASK_ID}/verify`);
    await until(() => !!h.doc.querySelector('.rv-cmd-run'), 'the Verify fragment to land');
    await until(
      () => h.doc.querySelector('.rv-cmd-run')?.hasAttribute('hidden') === false,
      'unhideVerifyControls to unhide Run',
    );

    const btn = h.doc.querySelector('.rv-cmd-run') as unknown as { click(): void };
    btn.click();
    await until(() => h.shellRuns.length === 1, 'window.lzShellRun to be called');
    expect(h.shellRuns[0]).toContain('bun test');
  });

  test('after a data-lz-stale refetch of Verify, Run still reaches window.lzShellRun', async () => {
    const h = setup();
    harness = h;

    switchTab(h, `/tasks/${TASK_ID}/verify`);
    await until(() => !!h.doc.querySelector('.rv-cmd-run'), 'the first Verify fetch to land');

    markCurrentBodyStale(h);
    switchTab(h, `/tasks/${TASK_ID}`);
    await until(
      () => h.doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}"]`)?.hasAttribute('hidden') === false,
      'the landing switch to land',
    );
    switchTab(h, `/tasks/${TASK_ID}/verify`);
    await until(() => !!h.doc.querySelector('.rv-cmd-run'), 'the refetched Verify body to land');
    await until(
      () => h.doc.querySelector('.rv-cmd-run')?.hasAttribute('hidden') === false,
      'unhideVerifyControls to unhide Run after refetch',
    );

    const btn = h.doc.querySelector('.rv-cmd-run') as unknown as { click(): void };
    btn.click();
    await until(() => h.shellRuns.length === 1, 'window.lzShellRun to be called after refetch');
    expect(h.shellRuns[0]).toContain('bun test');
  });
});

// The headline symptom this whole task exists to fix: nothing above clicks
// a toolbar button and checks the observable effect. A suite that only
// checks markup (hidden attribute present, MODES object exists as text)
// would stay green even if diffViewScript stopped reaching the toolbar —
// which is exactly the regression that opened this task.
describe('the diff toolbar responds to a click, not just renders', () => {
  function toolbarBar(h: Harness): Element | null {
    return h.doc.querySelector('[data-rv-viewopts]');
  }
  function wrapButton(h: Harness): Element | null {
    return h.doc.querySelector('[data-rv-mode="wrap"][data-rv-value="1"]');
  }
  function diffRoot(h: Harness): Element | null {
    return h.doc.getElementById('rv-root');
  }

  test('on a DIRECT full load of Changes, clicking Wrap toggles the class and aria-pressed', async () => {
    // The render order that broke window.lzOnce: inner (the tab body, with
    // diffViewScript inside it) comes before task-page.ts's page-level
    // `scripts` block in the returned HTML, so this is the one case where a
    // guard depending on something defined later would silently never run.
    const h = setup('changes');
    harness = h;

    await until(() => toolbarBar(h)?.hasAttribute('hidden') === false, 'diffViewScript to unhide the toolbar');
    const btn = wrapButton(h) as unknown as { click(): void; getAttribute(n: string): string | null };
    expect(btn).not.toBeNull();
    expect(diffRoot(h)?.classList.contains('rv-wrap')).toBe(false);

    btn.click();
    expect(diffRoot(h)?.classList.contains('rv-wrap')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  test('after an in-place switch onto Changes, clicking Wrap toggles the class and aria-pressed', async () => {
    const h = setup();
    harness = h;

    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => toolbarBar(h)?.hasAttribute('hidden') === false, 'diffViewScript to unhide the toolbar');

    const btn = wrapButton(h) as unknown as { click(): void; getAttribute(n: string): string | null };
    btn.click();
    expect(diffRoot(h)?.classList.contains('rv-wrap')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  test('after a data-lz-stale refetch of Changes, clicking Wrap still toggles the class', async () => {
    const h = setup();
    harness = h;

    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => toolbarBar(h)?.hasAttribute('hidden') === false, 'the first toolbar to unhide');

    markCurrentBodyStale(h);
    switchTab(h, `/tasks/${TASK_ID}`);
    await until(
      () => h.doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}"]`)?.hasAttribute('hidden') === false,
      'the landing switch to land',
    );
    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => toolbarBar(h)?.hasAttribute('hidden') === false, 'the refetched toolbar to unhide');

    const btn = wrapButton(h) as unknown as { click(): void; getAttribute(n: string): string | null };
    btn.click();
    expect(diffRoot(h)?.classList.contains('rv-wrap')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});

// window.lzOnce previously came from taskTabSwitchScript, which sits in
// task-page.ts's page-level `scripts` block — AFTER the tab body in render
// order. A direct full load of a tab whose body carries an island guarded by
// window.lzOnce ran that island's <script> before lzOnce existed, so the
// guard's `if (window.lzOnce)` was silently false and the listener never
// registered. Fixed by defining lzOnce in layoutOpenHtml, before anything
// else in <body>. These two tests are the ones that would have caught it.
describe('window.lzOnce exists before any tab body script runs', () => {
  test('on a direct full load of Services, clicking Copy reaches navigator.clipboard', async () => {
    const h = setup('services');
    harness = h;

    const btn = h.doc.querySelector('.svc-copy') as unknown as { click(): void; hasAttribute(n: string): boolean } | null;
    expect(btn).not.toBeNull();
    await until(() => btn!.hasAttribute('hidden') === false, 'servicesCopyScript to unhide Copy');

    btn!.click();
    await until(() => h.clipboardWrites.length === 1, 'navigator.clipboard.writeText to be called');
    expect(h.clipboardWrites[0]).toContain('lazy url');
  });

  test('window.lzOnce is defined as soon as the page starts parsing, before the tab body', () => {
    const h = setup('changes');
    harness = h;
    expect(typeof (h.win as unknown as { lzOnce?: unknown }).lzOnce).toBe('function');
  });
});

// currentRoot() is the detached stand-in on Current review (no diff, no
// prose), so the poll-frequency guard added for Turns/Commits/etc. would
// silently switch off live updates there too unless it also recognizes what
// THIS tab needs the same poll for: task-level Asks, the queued list, and
// the Unblock/Accept busy gate.
describe('Current review keeps polling for live updates', () => {
  test('a direct full load of Current review fetches /threads on load', async () => {
    const h = setup('review');
    harness = h;
    await until(() => h.threadFetches >= 1, 'the initial poll to fire');
  });
});

// The guard's whole point is that a tab with none of diff/prose/task-threads/
// actions does NOT poll — #rv-statusbar must NOT be one of the checked
// targets, because it is on every page unconditionally and a "skip when
// there's no bar" term can never be true, silently defeating the guard back
// to "every tab polls" regardless of the other terms. This is the test that
// would have caught that: it fails (threadFetches > 0) against a guard that
// includes `!bar`.
describe('a tab with nothing for the poll to update does not poll', () => {
  test('a direct full load of Turns issues no /threads fetch', async () => {
    const h = setup('turns');
    harness = h;
    // No positive assertion is possible for "never happens" — wait past a
    // few event-loop turns and check nothing arrived.
    await new Promise((r) => setTimeout(r, 200));
    expect(h.threadFetches).toBe(0);
  });

  test('switching onto Changes starts polling', async () => {
    // The only test that needs a SECOND poll tick, so the only one that
    // collapses the 3s/10s schedule — see setup().
    const h = setup('turns', {}, { collapseTimers: true });
    harness = h;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.threadFetches).toBe(0);

    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => !!h.doc.querySelector('.rv-add-comment'), 'the Changes fragment to land');
    await until(() => h.threadFetches >= 1, 'a poll to start now that Changes is live');
  });
});

// The raised-item dialog (raised-dialog.ts) is page-level, not inside any
// [data-lz-tab-body] — so a marker in its fetched panel is never "off tab" the
// way a cached tab body's content is. Closing the dialog leaves that markup in
// #lz-raised-dialog-body's innerHTML (fillAndShow only overwrites it on the
// NEXT open), so the guard used to keep finding it forever: once any raised
// item had ever been opened this session, the whole-document check for
// [data-rv-prose] was permanently true and Turns/Commits/etc. polled for the
// rest of the session, exactly the bug the tab-caching fix was for, wearing a
// different hat.
describe('closing a raised item stops it from defeating the poll-skip guard', () => {
  test('a dialog fetched and then closed does not keep Turns polling forever', async () => {
    const h = setup('turns', {}, { collapseTimers: true });
    harness = h;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.threadFetches).toBe(0);

    // Simulate what raisedDialogScript's fillAndShow + showModal do: fill the
    // page-level dialog body with the fetched panel (which carries
    // [data-rv-prose] on the item's own text) and open it.
    const body = h.doc.getElementById('lz-raised-dialog-body');
    const dialog = h.doc.getElementById('lz-raised-dialog') as unknown as { open: boolean };
    expect(body).not.toBeNull();
    body!.innerHTML = '<div data-rv-prose="raised/r1">a raised item</div>';
    dialog.open = true;

    // Open: the guard should treat this as a live target and poll.
    await until(() => h.threadFetches >= 1, 'a poll to start while the raised dialog is open');

    // Close it — the content stays in the DOM (nothing clears innerHTML on
    // close), same as production.
    dialog.open = false;
    const fetchesAtClose = h.threadFetches;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.threadFetches).toBe(fetchesAtClose);
  });
});

// A task-level Reply carries BOTH .rv-reply and .rv-task-reply (threadHtml's
// taskLevel case). Two delegated document click listeners each match one
// class; without :not(.rv-task-reply) scoping the first, both fired per
// click, prefilling two boxes from the one stored draft — sending one
// deleted the draft while the other stayed on screen with orphaned text a
// second click would re-post as a duplicate. That is the never-lose-
// feedback invariant on the one surface whose job is carrying the human's
// words to the agent exactly once.
describe('a task-level Reply is handled once, not twice', () => {
  test('clicking Reply with a stored draft opens exactly one form, not a duplicate', async () => {
    const h = setup();
    harness = h;

    switchTab(h, `/tasks/${TASK_ID}/review`);
    await until(() => !!h.doc.querySelector('.rv-reply.rv-task-reply'), 'the Current review fragment to land');

    // applyFragment's lzRestoreDrafts hook already auto-opened a box from
    // the seeded draft — the ordinary case a reviewer sees on arriving at
    // Current review with unsent words. Clicking Reply on TOP of that
    // (previously a second, un-scoped listener firing; now also a plain
    // click on an anchor that already has an open box) must reuse the
    // existing box, not add a second one bound to the same draft key.
    await until(() => h.doc.querySelectorAll('.rv-task-form').length > 0, 'the draft to auto-restore');
    expect(h.doc.querySelectorAll('.rv-task-form').length).toBe(1);

    const btn = h.doc.querySelector('.rv-reply.rv-task-reply') as unknown as { click(): void };
    btn.click();
    const forms = h.doc.querySelectorAll('.rv-task-form');
    expect(forms.length).toBe(1);
    const textarea = forms[0]?.querySelector('textarea') as unknown as { value: string } | null;
    expect(textarea?.value).toBe('half-typed reply');
  });
});

// review-diff.ts:1068 ships the toolbar `hidden`, and diffViewScript clears
// it once bound — but `.rv-viewopts { display: flex }` had no `[hidden]`
// companion rule, so an AUTHOR rule beat the UA default and it rendered
// fully visible and pressable whenever nothing had bound to it yet. This is
// the confirmed "visible but locked in place" mechanism the engineer
// reported; it is a CSS test, not a DOM one, because the previous bug was
// invisible to every test that only checked the `hidden` ATTRIBUTE (which
// was always correctly present) rather than its rendered effect.
/**
 * INVARIANT: a control that ships `hidden` for an island to unhide must
 * actually be hidden.
 *
 * There is no global `[hidden] { display: none }` reset in this bundle, so a
 * class that sets `display` beats the UA rule and the attribute does nothing
 * — the control renders, fully visible and completely dead, which is the
 * exact symptom this whole task was filed about (the diff toolbar) and was
 * separately true of the Viewed tick, the section nav, the diagram toolbar
 * and the shell panel.
 *
 * The list is DERIVED from the markup rather than written here, because a
 * hand-kept list pins the instances already fixed and can never see the next
 * one — which is how four of the five got missed after the rule itself was
 * correctly written down.
 */
describe('a control that ships hidden actually hides when nothing has bound to it', () => {
  /** Classes emitted with a literal ` hidden` attribute, from src/server/. */
  async function classesShippedHidden(): Promise<string[]> {
    const files = (await readdir(SERVER_DIR)).filter((f) => f.endsWith('.ts'));
    const found = new Set<string>();
    for (const file of files) {
      const raw = await readFile(join(SERVER_DIR, file), 'utf8');
      // `class="a b" ... hidden` within one tag, the attribute unquoted and
      // standing alone — which is how every such control is written here.
      for (const m of raw.matchAll(/class="([^"${}]+)"[^<>]{0,200}?\shidden(?=[\s>])/g)) {
        for (const cls of (m[1] ?? '').trim().split(/\s+/)) {
          if (cls) found.add(cls);
        }
      }
    }
    return [...found].sort();
  }

  test('every class that ships hidden and sets display has a [hidden] companion', async () => {
    // Comments stripped first: several of these rules carry a comment that
    // NAMES another one ("see .rv-viewopts[hidden] in diff.css"), and left in
    // place that prose satisfied the companion check for a rule that had
    // none — the guard passing on the strength of its own cross-reference.
    const css = bundledStylesheet().replace(/\/\*[\s\S]*?\*\//g, ' ');
    const offenders: string[] = [];
    for (const cls of await classesShippedHidden()) {
      // Does any rule give this class a `display`? (Bare `.cls { … }` only:
      // a descendant or state rule like `.x .cls` / `.cls[data-y]` cannot be
      // what makes the default state visible.)
      // 'm' so `^` is a LINE start: without it this matched only rules that
      // happened to follow a `}` or `,` on the same run of text, which meant
      // any rule preceded by a comment was invisible and four of the five
      // known instances went unseen.
      const sets = new RegExp(`(^|[,}])\\s*\\.${cls.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'gm');
      let setsDisplay = false;
      for (const m of css.matchAll(sets)) {
        if (/(^|;)\s*display\s*:/.test(m[2] ?? '')) setsDisplay = true;
      }
      if (!setsDisplay) continue;
      const companion = new RegExp(
        `\\.${cls.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\[hidden\\][^{]*\\{[^}]*display\\s*:\\s*none`,
      );
      if (!companion.test(css)) offenders.push(cls);
    }
    // Fail with the fix in the message, and name every instance at once.
    expect(offenders.map((c) => `.${c} sets display but has no .${c}[hidden] { display: none }`)).toEqual([]);
  });

  // Sanity: a scan that finds no candidates would pass vacuously, exactly as
  // the island-coverage scan would.
  test('the scan actually finds the controls that ship hidden', async () => {
    const classes = await classesShippedHidden();
    expect(classes.length).toBeGreaterThan(5);
    expect(classes).toContain('rv-viewopts');
    expect(classes).toContain('rv-viewed');
  });
});

describe('a diagram in a tab reached by an in-place switch is rendered, not raw source', () => {
  test('a diagram arriving with a switched-to fragment is claimed by the enhancer', async () => {
    // The enhancement half needs no mermaid library to be observable: run()
    // claims the block before it ever tries to load one, and the library is
    // deliberately unreachable in this harness.
    const h = setup('landing', { turnReport: mermaidReport() });
    harness = h;
    // Landing carries no diagram, so the enhancer found nothing at load —
    // the fragment is what brings one in.
    expect(h.doc.querySelector('[data-lz-mermaid]')).toBeNull();

    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(() => !!h.doc.querySelector('[data-lz-mermaid]'), 'the diagram to arrive with the fragment');
    await until(
      () => !!h.doc.querySelector('[data-lz-mermaid][data-lz-mermaid-claimed]'),
      'applyFragment to run the enhancer over the new body',
    );
  });

  test('re-running the enhancer over a morphed block does not wire its toggle twice', async () => {
    const h = setup('changes', { turnReport: mermaidReport() });
    harness = h;
    await until(
      () => !!h.doc.querySelector('[data-lz-mermaid][data-lz-mermaid-claimed]'),
      'the diagram to be claimed on load',
    );
    const el = h.doc.querySelector('[data-lz-mermaid]') as unknown as {
      addEventListener: (t: string, f: unknown) => void;
      removeAttribute(n: string): void;
      hasAttribute(n: string): boolean;
    };

    // The toggle guard is a JS PROPERTY precisely because no morph can strip
    // it, and that property is what this asserts. A listener COUNT would be
    // the better assertion and is not available here: happy-dom offers no
    // listener introspection, and the enhancer only reaches wireToggle once
    // the mermaid library resolves, which this harness deliberately cannot
    // fetch — a counter around addEventListener therefore observes nothing
    // either way, which would make this test pass whatever the guard did.
    expect((el as unknown as { __lzMermaidWired?: boolean }).__lzMermaidWired).toBe(true);

    // Exactly what a background live update does: lzMorph keeps this node
    // (matched positionally) but strips the claim attribute, which is not in
    // MORPH_PRESERVED_ATTRIBUTES. The next refresh then sees it as new — and
    // must re-claim it WITHOUT wiring its toggle a second time.
    el.removeAttribute('data-lz-mermaid-claimed');
    (h.win as unknown as { lzRefreshMermaid: () => void }).lzRefreshMermaid();
    await until(() => el.hasAttribute('data-lz-mermaid-claimed'), 're-claim after the morph');
    expect((el as unknown as { __lzMermaidWired?: boolean }).__lzMermaidWired).toBe(true);
  });
});

// One draft key means one box, on EVERY surface that opens one. Prose is the
// one most commenting actually happens on — report paragraphs, presentation
// summaries, raised-item bodies — and it was the surface left out when the
// diff-line and task-thread paths got the rule: closeProseForms() keeps a
// box that has text, so clicking "+" again built a second box bound to the
// same key, one send cleared the draft, and the survivor's words could be
// posted a second time.
// A tab you are not looking at is NOT a pane you are looking past. The tab
// island CACHES a body rather than destroying it (hidden, still in the
// document), so "is this box reachable" must not answer no just because the
// reviewer stepped onto another tab: the words are exactly where they left
// them and will be there when they come back. Answering no moved them into
// the orphan box above the diff, under a label saying the line is not on
// screen — while the line was right there.
describe('an unsent comment stays on its line across a tab round-trip', () => {
  test('type on a line, leave the tab, come back: still on the row, nothing orphaned', async () => {
    const h = setup('changes', { lineDrafts: {} });
    harness = h;

    await until(() => !!h.doc.querySelector('.rv-add-comment'), 'the diff to render');
    const add = h.doc.querySelector(
      '#rv-root tr.rv-line[data-line="1"][data-side="new"] .rv-add-comment',
    ) as unknown as { click(): void };
    add.click();

    const ta = h.doc.querySelector('tr.rv-form-row textarea') as unknown as
      { value: string; dispatchEvent(e: Event): boolean };
    ta.value = 'words typed on the line';
    ta.dispatchEvent(new h.win.Event('input', { bubbles: true }) as unknown as Event);

    // Tag the very node the reviewer typed into. Identity is the assertion
    // BECAUSE the end-to-end symptom is not reproducible here: the orphan
    // hop needs hostForAnchor to find no host, which it decides with
    // getClientRects() — and happy-dom returns a rect for everything,
    // hidden or not. What IS reproducible is the step before it, and the
    // one that causes it: treating the off-tab box as garbage and removing
    // it. In a real browser the rebuild that follows has nowhere to go and
    // lands in #rv-draft-orphans, under a label saying the line is not on
    // screen, while the line is right there.
    const original = h.doc.querySelector('tr.rv-form-row form') as unknown as { __tag?: string };
    original.__tag = 'the box the reviewer typed into';

    switchTab(h, `/tasks/${TASK_ID}/turns`);
    await until(
      () => h.doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/turns"]`)?.hasAttribute('hidden') === false,
      'the Turns tab to show',
    );
    switchTab(h, `/tasks/${TASK_ID}/changes`);
    await until(
      () => h.doc.querySelector(`[data-lz-tab-path="/tasks/${CODE}/changes"]`)?.hasAttribute('hidden') === false,
      'the Changes tab to come back',
    );

    const rowForms = h.doc.querySelectorAll('tr.rv-form-row form');
    const survivor = rowForms[0] as unknown as { __tag?: string } | undefined;
    expect({
      onTheRow: rowForms.length,
      orphaned: h.doc.querySelectorAll('#rv-draft-orphans form').length,
      text: (rowForms[0]?.querySelector('textarea') as unknown as { value: string } | undefined)?.value,
      untouched: survivor?.__tag,
    }).toEqual({
      onTheRow: 1,
      orphaned: 0,
      text: 'words typed on the line',
      untouched: 'the box the reviewer typed into',
    });
  });
});

// The other direction of the same rule, and the one the off-tab carve-out
// broke when it was folded into the shared predicate: a draft whose surface
// does not exist on the tab you are on gets parked in #rv-draft-orphans
// there — and that parked box must NOT then count as "this key already has
// a box" once you walk to the tab that really hosts the anchor. It did, so
// Current review opened with no box for a half-typed Ask, and clicking
// Reply focused the orphan on the hidden Changes body: visible, pressable,
// nothing happens.
describe('a draft whose anchor lives on another tab opens a box when you get there', () => {
  test('a task-level Ask parked as an orphan on Changes opens properly on Current review', async () => {
    const h = setup('changes', {
      review: { diffText: PATCH, reviewComments: [taskLevelAskComment()] },
    });
    harness = h;

    // On Changes there is no task thread, so the seeded task-level draft
    // (baseInput's TASK_REPLY_DRAFT_KEY) parks above the diff.
    await until(
      () => h.doc.querySelectorAll('#rv-draft-orphans form').length === 1,
      'the task-level draft to park in the orphan box on Changes',
    );

    switchTab(h, `/tasks/${TASK_ID}/review`);
    await until(() => !!h.doc.querySelector('.rv-reply.rv-task-reply'), 'Current review to land');

    // The box must be HERE, on the thread that hosts the anchor, with the
    // words — not left behind as an orphan on the tab we walked away from.
    await until(
      () => h.doc.querySelectorAll('.rv-task-form').length === 1,
      'the draft to open on the thread that hosts it',
    );
    const form = h.doc.querySelector('.rv-task-form form') as unknown as HTMLElement;
    const ta = form.querySelector('textarea') as unknown as { value: string };
    expect({
      text: ta.value,
      onThisTab: !form.closest('[data-lz-tab-body][hidden]'),
      stillOrphanedElsewhere: h.doc.querySelectorAll('#rv-draft-orphans form').length,
    }).toEqual({ text: 'half-typed reply', onThisTab: true, stillOrphanedElsewhere: 0 });

    // And Reply is not a dead control: clicking it reuses that same box
    // rather than finding the stale copy and building nothing.
    const btn = h.doc.querySelector('.rv-reply.rv-task-reply') as unknown as { click(): void };
    btn.click();
    expect(h.doc.querySelectorAll('.rv-task-form').length).toBe(1);
  });
});

describe('a prose comment box is never opened twice on one anchor', () => {
  test('clicking the prose "+" again reuses the open box instead of duplicating it', async () => {
    // Changes, because that is the tab whose body carries the agent report's
    // prose (landing's [data-rv-prose] container is the header one, with no
    // blocks for annotateProse to hang a "+" on). lineDrafts cleared because
    // the shared seed is a TASK-level draft with no thread on this page, so
    // restoreDrafts parks it in the orphan box — which is itself an
    // .rv-prose-form and would make the counts below about the wrong box.
    const h = setup('changes', { turnReport: proseReport(), lineDrafts: {} });
    harness = h;

    await until(() => !!h.doc.querySelector('.rv-prose-add'), 'annotateProse to hang a "+" on the report');
    const add = h.doc.querySelector('.rv-prose-add') as unknown as { click(): void };

    add.click();
    await until(() => h.doc.querySelectorAll('.rv-prose-form').length === 1, 'the first box to open');

    // Type, the way a reviewer would: that autosaves under the box's draft
    // key and — crucially — makes closeProseForms() keep this box, which is
    // the precondition the duplicate needed.
    const ta = h.doc.querySelector('.rv-prose-form textarea') as unknown as
      { value: string; dispatchEvent(e: Event): boolean };
    ta.value = 'a half-typed question';
    ta.dispatchEvent(new h.win.Event('input', { bubbles: true }) as unknown as Event);

    add.click();
    expect(h.doc.querySelectorAll('.rv-prose-form').length).toBe(1);
    const survivor = h.doc.querySelector('.rv-prose-form textarea') as unknown as { value: string };
    expect(survivor.value).toBe('a half-typed question');
  });
});

// When the agent declares a presentation the Changes tab renders the same
// file TWICE — #rv-presented and #rv-root — with identical anchors, so both
// panes produce the SAME draft key, and changesViewScript hides one pane
// rather than removing it. A box restored into the hidden pane is, from
// where the reviewer sits, indistinguishable from their words being lost;
// the file states that rule for hostForAnchor and it has to hold here too.
describe('a restored draft lands where the reviewer can see it, never in a hidden pane', () => {
  test('after flipping Presented to Raw, clicking "+" on that line shows the words again', async () => {
    // The engineer's own reproduction: words typed on a line in one pane,
    // then the other pane is the one on screen. Both panes render this line
    // with identical anchors, so both share this key.
    const lineKey = 'line new 1 - src/foo.ts';
    const h = setup('changes', {
      turnReport: presentedReport(),
      lineDrafts: { [lineKey]: 'words typed in one pane' },
    });
    harness = h;

    const formsForKey = () => Array.from(
      h.doc.querySelectorAll('form.rv-form[data-rv-draft-key]'),
    ).filter((f) => (f as HTMLElement).dataset.rvDraftKey === lineKey);

    await until(() => !!h.doc.getElementById('rv-presented'), 'both Changes panes to render');
    await until(() => formsForKey().length > 0, 'the draft to be restored into a pane');
    // Precondition, asserted rather than assumed: the restored box is in the
    // Presented pane, which is the one changesViewScript shows by default.
    expect(formsForKey()[0]!.closest('#rv-presented')).not.toBeNull();

    // "Raw files" — the real toolbar control. set() hides #rv-presented
    // (attribute, which review.css turns into display:none) WITHOUT removing
    // it, so the box holding their words is now off screen.
    const rawBtn = h.doc.querySelector('[data-rv-changes-value="raw"]') as unknown as { click(): void };
    rawBtn.click();
    expect(h.doc.getElementById('rv-presented')?.hasAttribute('hidden')).toBe(true);
    expect(h.doc.getElementById('rv-root')?.hasAttribute('hidden')).toBe(false);

    // Click "+" on the SAME line in the pane that is now on screen. Treating
    // the hidden box as "already open" made this a no-op: no box, no text,
    // no sign the words still existed — this task's own bug, reintroduced.
    const add = h.doc.querySelector(
      '#rv-root tr.rv-line[data-line="1"][data-side="new"] .rv-add-comment',
    ) as unknown as { click(): void };
    expect(add).not.toBeNull();
    add.click();

    // Captured into plain booleans and asserted as one object, deliberately:
    // it reports BOTH facts in the failure message, and keeps the assertion
    // about values rather than about DOM node identity.
    const forms = formsForKey();
    expect(forms.length).toBe(1);
    const ta = forms[0]!.querySelector('textarea') as unknown as { value: string };
    expect({
      inHiddenPane: !!forms[0]!.closest('[hidden]'),
      inRawPane: !!forms[0]!.closest('#rv-root'),
      text: ta.value,
    }).toEqual({ inHiddenPane: false, inRawPane: true, text: 'words typed in one pane' });
  });
});
