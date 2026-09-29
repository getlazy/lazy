/**
 * The daemon dashboard's "Let its next turn through" control for a paused task:
 * the banner, the task page line, the launch dialogs' box, and the POST route
 * that carries a person's click to the daemon's per-task allowance rule.
 */

import { describe, test, expect } from 'bun:test';
import type { Task } from '../../src/types';
import type { Storage } from '../../src/storage';
import type { UsagePauseState } from '../../src/daemon/usage-pause';
import { createWebRequestHandler } from '../../src/server/index';
import {
  taskUsagePauseHtml,
  usagePauseBannerHtml,
  usagePausePastCheckboxHtml,
} from '../../src/server/usage-pause-banner';
import { taskActionRowHtml } from '../../src/server/templates';

const VERDICT = {
  credential: 'anthropic:alice', window: 'five_hour', usedPercent: 97, threshold: 95,
  resetsAt: null, status: 'allowed',
};

function state(over: Partial<UsagePauseState> = {}): UsagePauseState {
  return {
    configured: { threshold_percent: 95, credentials: {} },
    override: null, overrideSetAt: null, coverage: [], paused: [], held: [], allowed: [],
    ...over,
  } as unknown as UsagePauseState;
}

function task(status: Task['status'] = 'backlog'): Task {
  return {
    id: 'task1234abcd', code: 'paused-task', goal: 'g', prompt: '', type: 'task', status,
    created_at: 1, completed_at: null, target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null, close_reason: null,
  } as Task;
}

function storageOf(t: Task, withSession = false): Storage {
  const session = withSession ? { id: 's1', task_id: t.id, started_at: 1, ended_at: null, agent_session_id: 'a' } : null;
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'getTask') return async () => t;
      if (prop === 'resolveTask') return async () => ({ task: t });
      if (prop === 'getSessionByTaskId') return async () => session;
      if (prop === 'listTaskCodes') return async () => [{ id: t.id, code: t.code }];
      return async () => [];
    },
  }) as unknown as Storage;
}

describe('usage-pause banner', () => {
  // INVARIANT: every HELD task gets a one-click "Let its next turn through"
  // posting to that task's allowance route by FULL id, returning to the banner.
  test('a held task is listed with the button', () => {
    const html = usagePauseBannerHtml(state({
      paused: [VERDICT as never],
      held: [{ taskId: 'task1234abcd', task: 'paused-task', hold: { ...VERDICT, held: 'auto-resume', since: 1 } as never }],
    }));
    expect(html).toContain('<h2>Usage pause</h2>');
    expect(html).toContain('paused-task');
    expect(html).toContain('action="/tasks/task1234abcd/usage-pause/allow"');
    expect(html).toContain('name="back" value="dashboard"');
    expect(html).toContain('Let its next turn through');
  });

  test('a held task behind unreadable readings gets no button', () => {
    const html = usagePauseBannerHtml(state({
      held: [{ taskId: 'task1234abcd', task: 'paused-task', hold: { ...VERDICT, storeError: 'unreadable', held: 'auto-resume', since: 1 } as never }],
    }));
    expect(html).toContain('paused-task');
    expect(html).not.toContain('usage-pause/allow');
  });

  test('a paused resting task is listed with the button', () => {
    const html = usagePauseBannerHtml(state({
      paused: [VERDICT as never],
      pausedTasks: [{ taskId: 'task1234abcd', task: 'paused-task', verdict: VERDICT as never }],
    }));
    expect(html).toContain('<h2>Usage pause</h2>');
    expect(html).toContain('action="/tasks/task1234abcd/usage-pause/allow"');
  });

  test('a pending allowance says who let it through, with a Clear, and no second button', () => {
    const html = usagePauseBannerHtml(state({
      held: [{ taskId: 'task1234abcd', task: 'paused-task', hold: { ...VERDICT, held: 'auto-resume', since: 1 } as never }],
      allowed: [{ taskId: 'task1234abcd', task: 'paused-task', setAt: Date.now(), setBy: 'alice@example.com' }],
    }));
    expect(html).toContain('let through the usage pause by alice@example.com');
    expect(html).toContain('action="/tasks/task1234abcd/usage-pause/clear"');
    expect(html).not.toContain('usage-pause/allow');
  });

  // INVARIANT: an overage-only line is still headed "Usage" and says nothing is paused.
  test('overage alone stays "Usage", nothing paused', () => {
    const html = usagePauseBannerHtml(state({
      coverage: [{ credential: 'c', coverage: 'reading', overage: { status: 'rejected', reason: 'x' } } as never],
    }));
    expect(html).toContain('<h2>Usage</h2>');
    expect(html).toContain('Nothing is paused.');
  });
});

describe('task page usage-pause line and launch boxes', () => {
  test('a paused task says why and offers the button', () => {
    const html = taskUsagePauseHtml('task1234abcd', { reason: 'anthropic:alice is 97% used', liftable: true, allowed: null });
    expect(html).toContain('anthropic:alice is 97% used');
    expect(html).toContain('action="/tasks/task1234abcd/usage-pause/allow"');
    expect(html).not.toContain('name="back"');
  });

  test('a pending allowance is said, with Clear', () => {
    const html = taskUsagePauseHtml('task1234abcd', { reason: null, liftable: true, allowed: { setBy: 'human', setAt: Date.now() } });
    expect(html).toContain('let through the usage pause by human');
    expect(html).toContain('usage-pause/clear');
  });

  // INVARIANT: unreadable saved readings are never lifted by an allowance, so
  // the page offers no button for them — even with one already pending.
  test('no button for a pause no allowance lifts', () => {
    const view = { reason: 'saved usage readings unreadable at /x', liftable: false, allowed: { setBy: 'human', setAt: 1 } };
    const html = taskUsagePauseHtml('task1234abcd', view);
    expect(html).toContain('readings unreadable');
    expect(html).not.toContain('usage-pause/allow');
    expect(html).not.toContain('let through the usage pause by');
  });

  test('nothing when the task would start', () => {
    expect(taskUsagePauseHtml('t', { reason: null, liftable: true, allowed: null })).toBe('');
    expect(taskUsagePauseHtml('t', null)).toBe('');
  });

  // INVARIANT: the "let this turn through" box appears only when the daemon
  // judged the task paused — never as a standing option on every launch.
  test('Start dialog carries the box only when paused', () => {
    expect(taskActionRowHtml(task(), false, undefined, true)).toContain('name="past_usage_pause"');
    expect(taskActionRowHtml(task(), false, undefined, false)).not.toContain('past_usage_pause');
    expect(usagePausePastCheckboxHtml(false)).toBe('');
  });
});

describe('POST /tasks/:id/usage-pause/:op', () => {
  function handler(t: Task, calls: string[]) {
    const taskActions = {
      resumeTask: async (id: string, _p: unknown, opts?: { pastUsagePause?: boolean }) => {
        calls.push(`resume:${id}:${opts?.pastUsagePause === true}`);
        return {};
      },
      allowPastUsagePause: async (id: string) => { calls.push(`allow:${id}`); },
      clearUsagePauseAllowance: async (id: string) => { calls.push(`clear:${id}`); },
      startTask: async (id: string, _p: unknown, opts?: { pastUsagePause?: boolean }) => {
        calls.push(`start:${id}:${opts?.pastUsagePause === true}`);
        return {};
      },
    };
    const reviewActions = {
      unblock: async (id: string, _m: string, _r: unknown, _p: unknown, opts?: { pastUsagePause?: boolean }) => {
        calls.push(`unblock:${id}:${opts?.pastUsagePause === true}`);
        return {};
      },
      saveDraft: async () => ({}),
    };
    return createWebRequestHandler(storageOf(t), reviewActions as never, { taskActions: taskActions as never });
  }

  test('allow calls the daemon rule by full id and returns to the task page', async () => {
    const calls: string[] = [];
    const res = await handler(task(), calls)(new Request('http://localhost/tasks/paused-task/usage-pause/allow', {
      method: 'POST', body: new FormData(),
    }));
    expect(res.status).toBe(303);
    expect(calls).toEqual(['allow:task1234abcd']);
    expect(res.headers.get('location')).toStartWith('http://localhost/tasks/paused-task?flash=');
  });

  test('clear with back=dashboard returns to the banner', async () => {
    const calls: string[] = [];
    const form = new FormData();
    form.set('back', 'dashboard');
    const res = await handler(task(), calls)(new Request('http://localhost/tasks/paused-task/usage-pause/clear', {
      method: 'POST', body: form,
    }));
    expect(res.status).toBe(303);
    expect(calls).toEqual(['clear:task1234abcd']);
    expect(res.headers.get('location')).toBe('http://localhost/#usage-pause-status');
  });

  test('GET is refused and an unknown op is a 404', async () => {
    const calls: string[] = [];
    const h = handler(task(), calls);
    expect((await h(new Request('http://localhost/tasks/paused-task/usage-pause/allow'))).status).toBe(405);
    expect((await h(new Request('http://localhost/tasks/paused-task/usage-pause/nope', { method: 'POST' }))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('the Start dialog box reaches the launch as pastUsagePause', async () => {
    const calls: string[] = [];
    const form = new FormData();
    form.set('past_usage_pause', '1');
    const res = await handler(task(), calls)(new Request('http://localhost/tasks/paused-task/actions/start', {
      method: 'POST', body: form,
    }));
    expect(res.status).toBe(303);
    expect(calls).toEqual(['start:task1234abcd:true']);
  });
});

describe('the launch boxes reach the daemon', () => {
  function handler(t: Task, calls: string[]) {
    const taskActions = {
      resumeTask: async (id: string, _p: unknown, opts?: { pastUsagePause?: boolean }) => {
        calls.push(`resume:${id}:${opts?.pastUsagePause === true}`);
        return {};
      },
    };
    const reviewActions = {
      unblock: async (id: string, _m: string, _r: unknown, _p: unknown, opts?: { pastUsagePause?: boolean }) => {
        calls.push(`unblock:${id}:${opts?.pastUsagePause === true}`);
        return {};
      },
      saveDraft: async () => ({}),
    };
    return createWebRequestHandler(storageOf(t, true), reviewActions as never, { taskActions: taskActions as never });
  }
  function form(box: boolean, message?: string): FormData {
    const f = new FormData();
    if (message) f.set('message', message);
    if (box) f.set('past_usage_pause', '1');
    return f;
  }

  test('Resume dialog box reaches resumeTask', async () => {
    const calls: string[] = [];
    const res = await handler(task('blocked'), calls)(new Request('http://localhost/tasks/paused-task/actions/resume', {
      method: 'POST', body: form(true),
    }));
    expect(res.status).toBe(303);
    expect(calls).toEqual(['resume:task1234abcd:true']);
  });

  for (const dialog of [false, true]) {
    test(`Unblock box reaches unblock (${dialog ? 'dialog' : 'plain form'})`, async () => {
      for (const box of [true, false]) {
        const calls: string[] = [];
        const res = await handler(task('blocked'), calls)(new Request('http://localhost/tasks/paused-task/review/unblock', {
          method: 'POST', body: form(box, 'do it'),
          ...(dialog ? { headers: { 'X-Lazy-Action-Dialog': '1' } } : {}),
        }));
        expect(res.status).toBeLessThan(400);
        // A dialog run completes in the background.
        for (let i = 0; i < 50 && calls.length === 0; i++) await Bun.sleep(5);
        expect(calls).toEqual([`unblock:task1234abcd:${box}`]);
      }
    });
  }
});

describe('the task page renders the daemon view', () => {
  // INVARIANT: the page shows the daemon's reason and offers the button and
  // the Start box exactly when the daemon says the next turn would be paused.
  test('a paused backlog task shows why, the button and the Start box', async () => {
    const taskActions = new Proxy({
      usagePauseForTask: async () => ({ reason: 'anthropic:alice is 97% used', liftable: true, allowed: null }),
    } as Record<string, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return async () => { throw new Error(`not stubbed: ${String(prop)}`); };
      },
    });
    const h = createWebRequestHandler(storageOf(task('backlog')), undefined, { taskActions: taskActions as never });
    const res = await h(new Request('http://localhost/tasks/paused-task'));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('anthropic:alice is 97% used');
    expect(body).toContain('action="/tasks/task1234abcd/usage-pause/allow"');
    expect(body).toContain('name="past_usage_pause"');
  });
});
