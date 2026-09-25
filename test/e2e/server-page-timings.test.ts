import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

/**
 * E2E for the page instrumentation: every task and review render publishes its
 * own cost.
 *
 * The header is the contract. It ships on every render — not behind a flag, not
 * only when something is slow — so that "which phase is expensive on this page"
 * is answered by opening dev tools rather than by guessing or by re-deriving it
 * from the code. These tests assert the phases a redesign's before/after
 * comparison needs, which is why they name them individually rather than
 * checking the header merely exists.
 */
describe('web page server timings', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** `name` → `dur=` value, for every metric in a Server-Timing header. */
  function parseServerTiming(header: string | null): Map<string, string> {
    expect(header).not.toBeNull();
    const metrics = new Map<string, string>();
    for (const metric of (header ?? '').split(',')) {
      const [name, ...params] = metric.trim().split(';');
      const value = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('dur=') || p.startsWith('desc='));
      metrics.set(name, (value ?? '').replace(/^(dur|desc)=/, '').replace(/^"|"$/g, ''));
    }
    return metrics;
  }

  test('the task page reports its phases and its size counts', async () => {
    const taskId = await createTask(ctx, 'Timing test task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const res = await fetch(`${base}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const metrics = parseServerTiming(res.headers.get('Server-Timing'));

    // Load phases: the storage reads, nested under one `storage` total so the
    // page's read cost is legible as a single number as well as per entity.
    for (const phase of ['total', 'storage', 'storage.turns', 'storage.children', 'render']) {
      expect(metrics.has(phase)).toBe(true);
      expect(Number(metrics.get(phase))).toBeGreaterThanOrEqual(0);
    }

    // Layout is measured on every tab. Turns and children live on their own
    // tabs now, so those phases are on those pages rather than on Landing.
    expect(metrics.has('render.layout')).toBe(true);
    const turnsPage = parseServerTiming((await fetch(`${base}/tasks/${taskId}/turns`)).headers.get('Server-Timing'));
    expect(turnsPage.has('render.turns')).toBe(true);
    const childrenPage = parseServerTiming((await fetch(`${base}/tasks/${taskId}/subtasks`)).headers.get('Server-Timing'));
    expect(childrenPage.has('render.children')).toBe(true);

    // Size counts: what made the page as big as it is.
    expect(Number(metrics.get('turns'))).toBeGreaterThan(0);
    expect(metrics.has('children')).toBe(true);
    expect(metrics.has('comments')).toBe(true);
    expect(Number(metrics.get('html_bytes'))).toBeGreaterThan(0);
  });

  test('the review page reports the diff, the parse and the Changes render separately', async () => {
    const taskId = await createTask(ctx, 'Timing review task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // The review page needs the task to have reached review.
    let res = await fetch(`${base}/tasks/${taskId}/changes`);
    const deadline = Date.now() + 20_000;
    while (res.status !== 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      res = await fetch(`${base}/tasks/${taskId}/changes`);
    }
    expect(res.status).toBe(200);
    const metrics = parseServerTiming(res.headers.get('Server-Timing'));

    // The three phases the "terribly slow review page" question turns on:
    // fetching the diff, parsing it, and emitting HTML for it. Attributing the
    // cost needs all three separately — a single "render" number cannot tell
    // git apart from the parser apart from the row emitter.
    for (const phase of ['total', 'diff', 'diff_parse', 'render', 'render.changes']) {
      expect(metrics.has(phase)).toBe(true);
      expect(Number(metrics.get(phase))).toBeGreaterThanOrEqual(0);
    }
    expect(metrics.has('render.threads')).toBe(true);
    expect(metrics.has('render.report')).toBe(true);
    expect(metrics.has('render.layout')).toBe(true);

    // Size counts, including the diff's own size — the input whose growth the
    // engineer suspects. `diff_files` is recorded by the route's parse and by
    // the renderer's; both see the same diff, so one value is reported.
    expect(metrics.has('diff_bytes')).toBe(true);
    expect(metrics.has('diff_files')).toBe(true);
    expect(metrics.has('threads')).toBe(true);
    expect(Number(metrics.get('html_bytes'))).toBeGreaterThan(0);
  });

  test('the task list and the review queue are measured too', async () => {
    await createTask(ctx, 'Queue timing task', 'Do work');

    const list = parseServerTiming((await fetch(`${base}/tasks`)).headers.get('Server-Timing'));
    expect(list.has('storage.list')).toBe(true);
    expect(list.has('render')).toBe(true);
    expect(Number(list.get('tasks'))).toBeGreaterThan(0);

    const queue = parseServerTiming((await fetch(`${base}/review`)).headers.get('Server-Timing'));
    expect(queue.has('queue')).toBe(true);
    expect(queue.has('render')).toBe(true);
    expect(queue.has('entries')).toBe(true);
  });

  /**
   * INVARIANT: rendering a task page reads no full task set.
   *
   * The page needs two things from the whole store — every code, to autolink
   * `task-code` in prose, and how many tasks hang under each child. Both used
   * to arrive as `listTasks()`, which reads every task.json and was the largest
   * phase on the page, growing linearly with the store. Both are identity-only
   * questions the store answers from its index, so a `storage.all_tasks` phase
   * reappearing here means someone put the scan back.
   */
  test('no tab reads the full task set', async () => {
    const taskId = await createTask(ctx, 'No full scan', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    for (const tab of ['', '/turns', '/subtasks']) {
      const metrics = parseServerTiming(
        (await fetch(`${base}/tasks/${taskId}${tab}`)).headers.get('Server-Timing'),
      );
      expect(metrics.has('storage.all_tasks')).toBe(false);
      expect(metrics.has('storage.task_codes')).toBe(true);
    }
  });

  /**
   * INVARIANT: a page never blocks on the container runtime.
   *
   * Deriving the working substate cost a `docker ps` with a ten-second cap, on
   * every render of every tab of a working task — so a wedged Docker Desktop
   * stalled Turns, Subtasks and Changes on a question none of them asks. The
   * page's only use of it was the agent's progress line, which is one file
   * read (`loadTaskProgressLine`, no runner, no probe).
   *
   * That file read is now on EVERY tab, deliberately. Only Landing RENDERS the
   * line, but every tab stamps it into the header freshness key, and
   * `/live-status` always reads it — so scoping the read to Landing meant a
   * working task sitting on Turns compared a key with no progress against a
   * payload with one, and refreshed its chrome every three seconds forever.
   * One small file read on tabs that do not render it is the cost of that fix;
   * what the invariant forbids is the PROBE, which is why `serve` (the phase
   * that shells out to docker) is still absent from tabs that show no services.
   */
  test('the progress line is one file read on every tab, and never a runner probe', async () => {
    const taskId = await createTask(ctx, 'Progress on every tab', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const landing = parseServerTiming(
      (await fetch(`${base}/tasks/${taskId}`)).headers.get('Server-Timing'),
    );
    expect(landing.has('progress')).toBe(true);
    expect(landing.has('serve')).toBe(false);

    for (const tab of ['/turns', '/subtasks']) {
      const metrics = parseServerTiming(
        (await fetch(`${base}/tasks/${taskId}${tab}`)).headers.get('Server-Timing'),
      );
      expect(metrics.has('progress')).toBe(true);
      // The docker-probing phase stays off the tabs that render no services.
      expect(metrics.has('serve')).toBe(false);
    }
  });

  /**
   * INVARIANT: a fragment render pays for the fragment only.
   *
   * `?fragment=1` returns strip + body — the header stays put in the browser —
   * so header-only data computed for one is thrown away. Current review renders
   * the upstream line in its own body, which is why that one tab still asks.
   */
  test('an in-place tab switch skips the header-only work', async () => {
    const taskId = await createTask(ctx, 'Fragment skips header work', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const fragment = parseServerTiming(
      (await fetch(`${base}/tasks/${taskId}/turns?fragment=1`)).headers.get('Server-Timing'),
    );
    expect(fragment.has('upstream')).toBe(false);
    expect(fragment.has('reparent_targets')).toBe(false);

    // The review tab renders the upstream line inside the fragment body, so it
    // is the deliberate exception — never the reparent target list.
    let res = await fetch(`${base}/tasks/${taskId}/review?fragment=1`);
    const deadline = Date.now() + 20_000;
    while (res.status !== 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      res = await fetch(`${base}/tasks/${taskId}/review?fragment=1`);
    }
    expect(res.status).toBe(200);
    const reviewFragment = parseServerTiming(res.headers.get('Server-Timing'));
    expect(reviewFragment.has('reparent_targets')).toBe(false);
  });

  // Measurement must not change what the page SAYS. The instrumentation adds a
  // header and a log line; the body is the page it always was.
  test('measuring a page changes nothing about the page', async () => {
    const taskId = await createTask(ctx, 'Unchanged body task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const res = await fetch(`${base}/tasks/${taskId}`);
    const body = await res.text();
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(body).toContain('Unchanged body task');
    // The numbers live on the header, never in the markup — a page that
    // rendered its own timings would be a behaviour change.
    expect(body).not.toContain('Server-Timing');
    expect(body).not.toContain('html_bytes');
  });
});
