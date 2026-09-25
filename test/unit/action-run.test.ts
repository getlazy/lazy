/**
 * In-memory registry for live task-page action dialogs.
 *
 * INVARIANT: a double-clicked Unblock must not launch a second turn — begin
 * while in flight returns the same run. Events are whatever the daemon
 * emitted; nothing here invents a phase.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  beginActionRun,
  getActionRun,
  actionRunJson,
  actionRunMatchesPath,
  wantsActionDialog,
  resetActionRuns,
  ACTION_DIALOG_HEADER,
  ACTION_RUN_TERMINAL_TTL_MS,
} from '../../src/server/action-run';
import { acceptRefusal } from '../../src/daemon/accept-refusal';

describe('action-run registry', () => {
  beforeEach(() => resetActionRuns());

  test('kicks off work and records progress until done', async () => {
    const run = beginActionRun({
      taskId: 't1',
      operation: 'stop',
      work: async (onProgress) => {
        onProgress({
          kind: 'phase',
          id: 'preflight',
          label: 'Pre-flight validation',
          state: 'start',
          index: 0,
          total: 0,
        });
        onProgress({
          kind: 'phase',
          id: 'preflight',
          label: 'Pre-flight validation',
          state: 'done',
          index: 0,
          total: 0,
          elapsedMs: 1,
        });
        return { redirect: '/tasks/t1' };
      },
    });
    expect(run.status).toBe('running');
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const snap = getActionRun(run.id);
      if (snap && snap.status === 'done') {
        expect(snap.redirect).toBe('/tasks/t1');
        expect(snap.events.some((e) => e.kind === 'phase' && e.label === 'Pre-flight validation')).toBe(true);
        const json = actionRunJson(snap);
        expect(json.runId).toBe(run.id);
        expect(json.status).toBe('done');
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run never settled');
  });

  test('failed work stays readable with the error', async () => {
    const run = beginActionRun({
      taskId: 't1',
      operation: 'accept',
      work: async () => {
        throw new Error('open raised item');
      },
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const failed = getActionRun(run.id);
      if (failed && failed.status === 'failed') {
        expect(failed.error).toContain('open raised item');
        expect(actionRunJson(failed).error).toContain('open raised item');
        expect(actionRunJson(failed).remedy).toBeUndefined();
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run never failed');
  });

  test('an accept refusal attaches the daemon remedy to the failed run', async () => {
    const run = beginActionRun({
      taskId: 't1',
      operation: 'accept',
      work: async () => {
        throw acceptRefusal(403, 'would merge into main', {
          reason: 'approval-required',
          next: 'Approve it with the passphrase.',
          command: 'lazy accept t1 --approve-file a.spec.ts --reason LGTM',
          uiAction: 'passphrase',
          files: ['a.spec.ts'],
        });
      },
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const failed = getActionRun(run.id);
      if (failed && failed.status === 'failed') {
        expect(failed.remedy?.uiAction).toBe('passphrase');
        expect(failed.remedy?.command).toContain('--approve-file a.spec.ts');
        expect(actionRunJson(failed).remedy).toEqual(failed.remedy);
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run never failed');
  });

  test('a second begin while in flight returns the same run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = beginActionRun({
      taskId: 't1',
      operation: 'unblock',
      work: async () => {
        await gate;
        return { redirect: '/x' };
      },
    });
    const b = beginActionRun({
      taskId: 't1',
      operation: 'unblock',
      work: async () => {
        throw new Error('should not launch twice');
      },
    });
    expect(b.id).toBe(a.id);
    release();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (getActionRun(a.id)?.status === 'done') return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run never finished');
  });

  test('two concurrent link keys produce two runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    const launched: string[] = [];
    const a = beginActionRun({
      taskId: keyA,
      operation: 'link',
      work: async () => {
        launched.push(keyA);
        await gate;
        return { redirect: '/tasks/a' };
      },
    });
    const b = beginActionRun({
      taskId: keyB,
      operation: 'link',
      work: async () => {
        launched.push(keyB);
        await gate;
        return { redirect: '/tasks/b' };
      },
    });
    expect(b.id).not.toBe(a.id);
    expect(a.taskId).toBe(keyA);
    expect(b.taskId).toBe(keyB);
    expect(getActionRun(a.id)?.status).toBe('running');
    expect(getActionRun(b.id)?.status).toBe('running');
    release();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (getActionRun(a.id)?.status === 'done' && getActionRun(b.id)?.status === 'done') {
        expect(getActionRun(a.id)?.redirect).toBe('/tasks/a');
        expect(getActionRun(b.id)?.redirect).toBe('/tasks/b');
        expect(new Set(launched)).toEqual(new Set([keyA, keyB]));
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('link runs never finished');
  });

  test('a run keyed on one task is not readable through another path', () => {
    const run = beginActionRun({
      taskId: 'task-a',
      operation: 'stop',
      work: async () => ({ redirect: '/' }),
    });
    expect(actionRunMatchesPath(run, 'task-a', null)).toBe(true);
    expect(actionRunMatchesPath(run, 'task-a-short', 'task-a')).toBe(true);
    expect(actionRunMatchesPath(run, 'task-b', 'task-b')).toBe(false);
    expect(actionRunMatchesPath(run, crypto.randomUUID(), null)).toBe(false);
  });

  test('a finished unique-key run expires after the terminal TTL', async () => {
    const wall = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const key = crypto.randomUUID();
      const run = beginActionRun({
        taskId: key,
        operation: 'link',
        work: async () => ({ redirect: '/tasks/x' }),
      });
      const deadline = wall() + 2_000;
      while (wall() < deadline) {
        if (getActionRun(run.id)?.status === 'done') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(getActionRun(run.id)?.status).toBe('done');
      now += ACTION_RUN_TERMINAL_TTL_MS + 1;
      expect(getActionRun(run.id)).toBeNull();
    } finally {
      Date.now = wall;
    }
  });

  test('wantsActionDialog reads the header', () => {
    const req = new Request('http://x/', { headers: { [ACTION_DIALOG_HEADER]: '1' } });
    expect(wantsActionDialog(req)).toBe(true);
    expect(wantsActionDialog(new Request('http://x/'))).toBe(false);
  });
});
