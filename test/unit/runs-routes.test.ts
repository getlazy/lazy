/**
 * The Run pages' routes turn the daemon's STRUCTURED refusals into a
 * confirm-and-retry (src/server/runs-routes.ts). These pin that mapping
 * against a fake RunActions port — the refusals the e2e suite cannot easily
 * produce (an image that is not ready) and the fields each confirmation must
 * carry so that confirming re-runs exactly what was refused.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { handleRunsRoute } from '../../src/server/runs-routes';
import { getActionRun, resetActionRuns, ACTION_DIALOG_HEADER } from '../../src/server/action-run';
import type { RunActions, RunDetail, RunServeView } from '../../src/server/run-actions';

/** An error shaped like the daemon's RpcError: status, code, details. */
function refusal(status: number, message: string, code?: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { status, code, details });
}

const RUN: RunDetail = {
  id: 'run-1',
  slug: 'main',
  target: { kind: 'branch', branch: 'main' },
  head_sha: 'a'.repeat(40),
  image_choice: null,
  created_at: '2026-10-18T00:00:00.000Z',
  created_by: null,
  last_pulled_at: null,
  last_pulled_by: null,
  hostLabel: 'main',
  pagePath: '/runs/run-1',
  canPull: true,
  commit: null,
  checkout: null,
  remote: null,
  containerRunning: false,
  checkoutExists: true,
};

const SERVE: RunServeView = {
  declared: [],
  services: [],
  unavailable: 'not-running',
  containerName: 'lazyrun-main-0000',
  runnerType: 'docker',
  containerRunning: false,
  startServicesCmd: 'bin/dev',
  servicesRun: null,
};

const DIRTY = refusal(409, 'The run\'s checkout has changes somebody made in it: notes.txt.', 'run_checkout_dirty', {
  dirtyFiles: ['notes.txt'],
  tracked: [],
  untracked: ['notes.txt'],
  localCommits: [],
});
const NOT_READY = refusal(409, 'The project\'s image is still building.', 'runner_image_not_ready');

function fakeActions(overrides: Partial<RunActions> = {}): RunActions & { calls: string[] } {
  const calls: string[] = [];
  const base: RunActions = {
    listBranches: async () => ({ remote: 'origin', defaultBranch: 'main', fetched: false, branches: [] }),
    listRuns: async () => [],
    showRun: async () => RUN,
    createRun: async () => ({ run: RUN, existed: false }),
    pullRun: async () => ({ moved: false, from: RUN.head_sha, to: RUN.head_sha, discarded: [], discardedCommits: [], kept: [], servicesRestarted: false }),
    removeRun: async () => ({ slug: 'main', discarded: [], discardedCommits: [] }),
    setImageChoice: async (_id, choice) => { calls.push(`setImageChoice:${choice}`); },
    runServices: async () => { calls.push('runServices'); },
    stopServices: async () => ({ stopped: true }),
    stopEnvironment: async () => ({ stopped: true }),
    ensureContainer: async () => ({ containerName: 'c', alreadyRunning: true }),
    serveState: async () => SERVE,
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

function post(path: string, fields: Record<string, string>, dialog: boolean): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request(`http://lazy.localhost${path}`, {
    method: 'POST',
    body,
    headers: dialog ? { [ACTION_DIALOG_HEADER]: '1' } : {},
  });
}

async function route(actions: RunActions, req: Request): Promise<Response> {
  const url = new URL(req.url);
  return handleRunsRoute(actions, req, url, url.pathname);
}

/** Start a dialog action and wait for it to settle in the registry. */
async function settle(res: Response) {
  expect(res.status).toBe(202);
  const { runId } = await res.json() as { runId: string };
  for (let i = 0; i < 100; i++) {
    const action = getActionRun(runId);
    if (action && action.status !== 'running') return action;
    await Bun.sleep(5);
  }
  throw new Error('action did not settle');
}

describe('Run page routes: confirm-and-retry', () => {
  beforeEach(() => resetActionRuns());

  // INVARIANT: confirming a refused create re-runs what was PICKED. A
  // confirmation carrying only confirm_discard=1 parses as the default branch
  // and would discard changes in a checkout nobody was shown.
  test('a create refused for a changed checkout confirms with the picked target (dialog)', async () => {
    const actions = fakeActions({ createRun: async () => { throw DIRTY; } });
    const action = await settle(await route(actions, post('/runs', { target: 'branch:feature/x', sha: '' }, true)));
    expect(action.status).toBe('failed');
    expect(action.confirm?.items).toEqual(['notes.txt']);
    expect(action.confirm?.action).toBe('/runs');
    expect(action.confirm?.fields).toEqual({ target: 'branch:feature/x', sha: '', confirm_discard: '1' });
  });

  test('the same refusal without JS renders a confirm form carrying the picked target', async () => {
    const actions = fakeActions({ createRun: async () => { throw DIRTY; } });
    const res = await route(actions, post('/runs', { target: 'sha', sha: 'abcdef1234' }, false));
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('<code>notes.txt</code>');
    expect(html).toContain('name="target" value="sha"');
    expect(html).toContain('name="sha" value="abcdef1234"');
    expect(html).toContain('name="confirm_discard" value="1"');
  });

  test('confirming passes confirmDiscard and the picked target to the daemon', async () => {
    let seen: unknown = null;
    const actions = fakeActions({ createRun: async (input) => { seen = input; return { run: RUN, existed: false }; } });
    const res = await route(actions, post('/runs', { target: 'branch:feature/x', sha: '', confirm_discard: '1' }, false));
    expect(res.status).toBe(303);
    expect(seen).toEqual({ target: { kind: 'branch', branch: 'feature/x' }, confirmDiscard: true });
  });

  test('Run services refused for an image that is not ready offers lazy\'s default image', async () => {
    const actions = fakeActions({ runServices: async () => { throw NOT_READY; } });
    const action = await settle(await route(actions, post('/runs/run-1/services/run', {}, true)));
    expect(action.status).toBe('failed');
    expect(action.confirm).toMatchObject({ items: [], fields: { use_default_image: '1' }, action: '/runs/run-1/services/run' });

    const page = await (await route(actions, post('/runs/run-1/services/run', {}, false))).text();
    expect(page).toContain('name="use_default_image" value="1"');
    expect(page).toContain('Use lazy&#39;s default image and run services');
  });

  test('use_default_image=1 records the image choice before running services', async () => {
    const actions = fakeActions();
    const res = await route(actions, post('/runs/run-1/services/run', { use_default_image: '1' }, false));
    expect(res.status).toBe(303);
    expect(actions.calls).toEqual(['setImageChoice:default', 'runServices']);
  });

  test('a refusal with no confirmation offers none', async () => {
    const actions = fakeActions({ pullRun: async () => { throw refusal(409, 'This run is pinned.'); } });
    const action = await settle(await route(actions, post('/runs/run-1/pull', {}, true)));
    expect(action.status).toBe('failed');
    expect(action.confirm).toBeUndefined();
  });

  test('image-choice accepts only default or project', async () => {
    const actions = fakeActions();
    expect((await route(actions, post('/runs/run-1/image-choice', { choice: 'project' }, false))).status).toBe(303);
    expect(actions.calls).toEqual(['setImageChoice:project']);
    expect((await route(actions, post('/runs/run-1/image-choice', { choice: 'other' }, false))).status).toBe(400);
  });
});
