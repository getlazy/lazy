/**
 * Slice 5 of the tabbed task page: Verification and Shell tabs, per-step
 * verified ticks, superseded history, and the inline-shell mount.
 *
 * JS behaviour (Run does not scroll, the Shell tab lists a live session) is
 * pinned as text in test/unit/shell-ui.test.ts — there is no DOM harness here.
 * These cases fetch as a browser with scripting off, plus the host-process
 * runner case that hides the Shell tab.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { findFullTaskId, taskFilePath, worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { successScenario } from '../helpers/fake-claude';
import { DaemonClient } from '../../src/daemon/client';

describe('tabbed task page verify + shell', () => {
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

  async function blockedTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Do work');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const waited = await ctx.lazy(['wait', shortId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${shortId}: ${waited.stderr}\n${waited.stdout}`);
    }
    return shortId;
  }

  async function submitReport(taskId: string, sections: Array<{ kind: string; body: string }>): Promise<void> {
    const worktree = worktreePathFor(ctx.root, taskId);
    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_report', arguments: { sections } },
      },
    ], { timeoutMs: 60_000 });
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBeFalsy();
  }

  function seedOlderVerifyReport(taskId: string, body: string, turnSequence: number): void {
    const path = taskFilePath(ctx.root, taskId, 'turn-reports.json');
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as {
      turn_reports: Array<Record<string, unknown>>;
    };
    existing.turn_reports.unshift({
      id: 'older-report',
      task_id: findFullTaskId(ctx.root, taskId),
      session_id: 'older-session',
      turn_sequence: turnSequence,
      sections: [{ kind: 'how_to_verify', body }],
      created_at: Date.UTC(2026, 8, 5),
    });
    writeFileSync(path, JSON.stringify(existing));
  }

  test('current steps render; older ones are collapsed and labelled superseded', async () => {
    const taskId = await blockedTask('Verify current vs history');
    await submitReport(taskId, [
      {
        kind: 'how_to_verify',
        body: 'Open the page.\n\n```bash\nbun test test/e2e/task-tabs-verify-shell.test.ts\n```',
      },
    ]);
    seedOlderVerifyReport(taskId, '```\necho obsolete\n```', 3);

    const html = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    expect(html).toContain('lz-verify-current');
    expect(html).toContain('data-verify-current');
    expect(html).toContain('bun test test/e2e/task-tabs-verify-shell.test.ts');
    expect(html).toContain('data-lz-shell-mount');
    expect(html).toContain('>Run in shell</button>');
    // Open / Re-run only ship when a shell can be opened (unit-tested). This
    // harness has no running container, so Run is the disabled control.
    expect(html).toContain('Earlier verification steps (1)');
    expect(html).toContain('Turn #3 · superseded · 2026-09-05');
    expect(html).toContain('echo obsolete');
    // History is not runnable — slice only the <details>, not the rest of the
    // page (scripts below mention rv-cmd-run).
    const histStart = html.indexOf('lz-verify-history');
    const histEnd = html.indexOf('</details>', histStart);
    const history = html.slice(histStart, histEnd);
    expect(history).not.toContain('rv-cmd-run');
    expect(html).toContain('<noscript>');
    expect(html).toContain('lazy shell');
  }, 90_000);

  test('a verified tick survives a reload and clears when the step text changes', async () => {
    const taskId = await blockedTask('Verify tick persistence');
    await submitReport(taskId, [
      { kind: 'how_to_verify', body: 'Look at the page.\n\nThen stop.' },
    ]);

    const page = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    const match = page.match(
      /data-verify-current[^>]*data-viewed-key="([^"]+)"[^>]*data-content-hash="([^"]+)"/,
    );
    expect(match).toBeTruthy();
    const key = match![1];
    const hash = match![2];

    const saved = await fetch(`${base}/tasks/${taskId}/review/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { viewedFiles: { [key]: hash } } }),
    });
    expect(saved.status).toBe(200);

    const reload = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    expect(reload).toContain(`data-viewed-key="${key}"`);
    expect(reload).toContain(`data-content-hash="${hash}"`);
    expect(reload).toContain('title="1 of 1 verified"');
    const review = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(review).toContain('1 of 1 steps verified');

    await submitReport(taskId, [
      { kind: 'how_to_verify', body: 'Look at the page again — the text changed.' },
    ]);
    const after = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    const newMatch = after.match(
      /data-verify-current[^>]*data-viewed-key="([^"]+)"[^>]*data-content-hash="([^"]+)"/,
    );
    expect(newMatch).toBeTruthy();
    expect(newMatch![1]).toBe(key);
    expect(newMatch![2]).not.toBe(hash);
    expect(after).toContain('title="0 of 1 verified"');
    const reviewAfter = await (await fetch(`${base}/tasks/${taskId}/review`)).text();
    expect(reviewAfter).toContain('0 of 1 steps verified');
  }, 90_000);

  // INVARIANT: the `reviewVerify` RPC answers with the dashboard's own split,
  // tick keys and hashes, superseded history and verified count. A remote
  // client (Lazy Teams) renders the Verify tab from it and must never carry its
  // own copy of those rules — a tick stored under a key or hash the daemon
  // would not produce never counts.
  test('reviewVerify serves the Verify tab as data, with the caller\'s own count', async () => {
    const taskId = await blockedTask('Verify over RPC');
    await submitReport(taskId, [
      { kind: 'how_to_verify', body: 'Open the page.\n\n```console\n$ one\n$ two\n```' },
    ]);
    seedOlderVerifyReport(taskId, '```\necho obsolete\n```', 3);

    const page = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    const rendered = [...page.matchAll(
      /data-verify-current[^>]*data-viewed-key="([^"]+)"[^>]*data-content-hash="([^"]+)"/g,
    )].map((m) => ({ key: m[1], hash: m[2] }));
    expect(rendered.length).toBe(2);

    const client = (await DaemonClient.create(ctx.root))!;
    type Wire = {
      current: { turnSequence: number; steps: Array<Record<string, unknown>> };
      earlier: Array<{ turnSequence: number; steps: Array<Record<string, unknown>> }>;
      progress: { verified: number; total: number };
    };
    const state = (await client.rpc('reviewVerify', ctx.root, { taskId })) as Wire;
    expect(state.current.steps.map((s) => ({ key: s.tickKey, hash: s.hash }))).toEqual(rendered);
    expect(state.current.steps[1]).toMatchObject({
      kind: 'code',
      lang: 'console',
      copyText: 'one\ntwo',
      perLine: ['one', 'two'],
    });
    expect(state.earlier.length).toBe(1);
    expect(state.earlier[0].turnSequence).toBe(3);
    expect(state.earlier[0].steps[0]).toMatchObject({ kind: 'code', code: 'echo obsolete' });
    expect(state.progress).toEqual({ verified: 0, total: 2 });

    // Without history: the same current steps, no superseded sessions.
    const lean = (await client.rpc('reviewVerify', ctx.root, { taskId, history: false })) as Wire;
    expect(lean.current).toEqual(state.current);
    expect(lean.earlier).toEqual([]);

    await client.rpc('reviewSaveDraft', ctx.root, {
      taskId,
      patch: { viewedFiles: { [rendered[0].key]: rendered[0].hash, [rendered[1].key]: 'stale' } },
    });
    const after = (await client.rpc('reviewVerify', ctx.root, { taskId })) as Wire;
    expect(after.progress).toEqual({ verified: 1, total: 2 });
  }, 90_000);

  test('the Shell tab is an index that names sessions close on reload', async () => {
    const taskId = await blockedTask('Shell tab index');
    const html = await (await fetch(`${base}/tasks/${taskId}/shell`)).text();
    expect(html).toContain('data-lz-tab="shell"');
    expect(html).toContain('data-lz-shell-index');
    expect(html).toContain('data-lz-shell-mode="pair"');
    expect(html).toContain('data-lz-shell-mode="chat"');
    expect(html).toContain('Sessions close when you reload');
    expect(html).toContain('does not lock the task');
    expect(html).toContain('30 seconds');
  }, 90_000);
});

describe('tabbed task page shell hidden on host runner', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('the Shell tab is absent on a runner with no container', async () => {
    const taskId = await createTask(ctx, 'Host runner has no shell tab', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'host-sess' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const landing = await (await fetch(`${base}/tasks/${taskId}`)).text();
    const verify = await (await fetch(`${base}/tasks/${taskId}/verify`)).text();
    for (const html of [landing, verify]) {
      expect(html).not.toContain('data-lz-tab="shell"');
      expect(html).not.toContain('data-lz-shell-task=');
    }
    // The route still exists so a typed URL is not a 404.
    const shell = await fetch(`${base}/tasks/${taskId}/shell`);
    expect(shell.status).toBe(200);
    const shellHtml = await shell.text();
    expect(shellHtml).not.toContain('data-lz-tab="shell"');
  }, 90_000);
});
