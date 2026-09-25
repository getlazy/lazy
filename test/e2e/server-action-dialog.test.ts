/**
 * E2E for the task-page action dialog path: POST with
 * `X-Lazy-Action-Dialog: 1` returns a run id immediately, then GET
 * `/tasks/:id/action-runs/:runId` follows the same daemon ProgressEvents the
 * CLI prints. Success settles `done` with a redirect; failure stays `failed`
 * with the error. A POST without the header is still the 303 used by
 * scripting-off forms (covered in server-review / server-task-actions).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS, disablePreAccept, setProtectedPatterns } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { taskFilePath, worktreePathFor } from '../helpers/storage';
import { enrollPassphrase } from '../helpers/passphrase';
import { seedFinal } from '../helpers/final';
import { ACTION_DIALOG_HEADER } from '../../src/server/action-run';

describe('lazy web action dialogs', () => {
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
    expectSuccess(await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    // The final-accept gate (§5.1) refuses an accept nobody declared done.
    // The module mock's wrap-up handler declares the final synchronously.
    const id = await waitForReviewQueue(shortId);
    await seedFinal(ctx, id);
    return id;
  }

  async function waitForReviewQueue(shortId: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  async function pollRun(
    taskId: string,
    runId: string,
    timeoutMs = 90_000,
  ): Promise<{ status: string; events: Array<{ kind: string; label?: string; state?: string }>; error?: string; redirect?: string }> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/action-runs/${runId}`);
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      expect(res.ok).toBe(true);
      last = (await res.json()) as Record<string, unknown>;
      if (last.status === 'done' || last.status === 'failed') return last as never;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`run ${runId} never settled: ${JSON.stringify(last)}`);
  }

  function dialogPost(url: string, fields: Record<string, string>): Promise<Response> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return fetch(url, {
      method: 'POST',
      headers: { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
    });
  }

  test('the Current review page offers dialogs, not in-card tabs or expanders', async () => {
    const id = await blockedTask('Dialog chrome');
    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(review).toContain('id="lz-action-dialog"');
    expect(review).toContain('data-lz-action-open="unblock"');
    expect(review).toContain('data-lz-action-open="ask"');
    expect(review).toContain('data-lz-action-open="accept"');
    expect(review).toContain('data-lz-action-open="reject"');
    expect(review).not.toContain('rv-tablist');
    expect(review).not.toContain('task-action-disclosure');
    // INVARIANT: Close stays clickable for a live run; dismiss does not
    // cancel. Served script must not disable Close or trap ESC.
    expect(review).toContain('data-lz-action-cancel');
    expect(review).toContain('method="dialog"');
    expect(review).not.toContain('closeBtn.disabled');
    expect(review).not.toContain("addEventListener('cancel'");
    expect(review).not.toContain('AbortController');
    const css = await (await fetch(`${base}/assets/app.css`)).text();
    expect(css).toContain('min-height: min(28rem, calc(100vh - 40px))');
    expect(css).toContain('.lz-action-dialog-body .rv-form-actions');
    expect(css).toContain('position: sticky');
    const landing = await (await fetch(`${base}/tasks/${id}`)).text();
    expect(landing).toContain('data-lz-action-open="sync"');
    expect(landing).toContain('data-lz-action-open="reparent"');
    expect(landing).not.toContain('task-action-disclosure');
  }, 90_000);



  test('dialog unblock succeeds and the run carries CLI phase labels', async () => {
    const id = await blockedTask('Dialog unblock ok');
    const res = await dialogPost(`${base}/tasks/${id}/review/unblock`, {
      message: 'please continue',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string; taskId: string; status: string };
    expect(started.runId).toBeTruthy();
    expect(started.status).toBe('running');

    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('done');
    expect(settled.redirect).toContain(`/tasks/${id}`);
    const labels = (settled.events ?? [])
      .filter((e) => e.kind === 'phase')
      .map((e) => e.label)
      .join('\n');
    expect(labels).toContain('Pre-flight validation');
  }, 120_000);

  test('dialog unblock with empty feedback is a JSON 400 and starts no run', async () => {
    const id = await blockedTask('Dialog unblock empty');
    const res = await dialogPost(`${base}/tasks/${id}/review/unblock`, { message: '   ' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Feedback cannot be empty');
  }, 90_000);

  test('dialog accept succeeds and the run carries CLI phase labels', async () => {
    const id = await blockedTask('Dialog accept ok');
    const res = await dialogPost(`${base}/tasks/${id}/review/accept`, {
      reason: 'looks good',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string; status: string };
    expect(started.runId).toBeTruthy();

    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('done');
    expect(settled.redirect).toContain(`/tasks/${id}`);
    const labels = (settled.events ?? [])
      .filter((e) => e.kind === 'phase')
      .map((e) => e.label)
      .join('\n');
    expect(labels).toContain('Pre-flight validation');
    expect(labels).toContain('Merge');
  }, 120_000);

  // "Dialog Accept → run review first" test retired with the choice itself
  // (final-turn design §8): a review now always exists by the time a human
  // opens Accept, so the accept_path=review branch and its 202/redirect
  // behavior are gone — posting that form value now falls through to accept.

  test('dialog accept failure stays on the run with the error', async () => {
    const id = await blockedTask('Dialog accept fail');
    const raisedId = randomUUID();
    writeFileSync(
      taskFilePath(ctx.root, id, 'raised-items.json'),
      JSON.stringify({
        raised_items: [
          {
            id: raisedId,
            task_id: id,
            content: 'Keep the legacy flag?',
            title: 'Keep the legacy flag?',
            blocking: true,
            created_at: Date.now(),
            status: 'open',
          },
        ],
      }),
    );

    const res = await dialogPost(`${base}/tasks/${id}/review/accept`, {
      reason: 'looks good',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string };
    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('failed');
    expect(settled.error ?? '').toMatch(/raised item/i);
  }, 120_000);
});

/**
 * The case the engineer hit: accepting a conflict task into protected main
 * from the web. The daemon must compose the complete `lazy accept` command
 * (approved files + reason), the passphrase retry must carry those files,
 * and the approved file must survive the merge.
 */
describe('protected-branch accept of a conflict task through the web', () => {
  const PASSPHRASE = 'test-approval-passphrase';
  const ORIGINAL = 'describe("existing", () => {});\n';
  const AGENT = 'describe("agent kept this", () => { /* must survive */ });\n';
  const SPEC = 'a.spec.ts';

  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_FILES: JSON.stringify([{ path: SPEC, content: AGENT }]),
      },
    });
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    const updated = toml.replace('[protection]\n', '[protection]\nenabled = true\n');
    expect(updated).not.toBe(toml);
    await writeFile(tomlPath, updated);
    disablePreAccept(ctx.root);
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    writeFileSync(join(ctx.root, SPEC), ORIGINAL);
    ctx.git('add', 'lazy.toml', SPEC);
    ctx.git('commit', '-m', 'Protect main and add a spec file');
    await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);

    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function conflictTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Touch the spec');
    expectSuccess(await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', shortId])).exitCode).toBe(0);
    // The final-accept gate (§5.1) refuses an accept nobody declared done.
    const id = await waitForReviewQueue(shortId);
    await seedFinal(ctx, id);
    return id;
  }

  async function waitForReviewQueue(shortId: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  async function approveFile(taskId: string, file: string): Promise<void> {
    const res = await fetch(`${base}/tasks/${taskId}/review/violation`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ file, approved: '1' }).toString(),
    });
    expect(res.ok).toBe(true);
  }

  async function pollRun(
    taskId: string,
    runId: string,
    timeoutMs = 90_000,
  ): Promise<{
    status: string;
    error?: string;
    redirect?: string;
    remedy?: { command?: string; uiAction?: string; files?: string[] };
  }> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/action-runs/${runId}`);
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      expect(res.ok).toBe(true);
      last = (await res.json()) as Record<string, unknown>;
      if (last.status === 'done' || last.status === 'failed') return last as never;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`run ${runId} never settled: ${JSON.stringify(last)}`);
  }

  // INVARIANT: a conflict task's protection-gate refusal names every already-
  // approved file on the pasteable command. A bare `lazy accept <id>` would
  // look like a revert of those files.
  test('dialog accept without a passphrase fails with the complete CLI command', async () => {
    const id = await conflictTask('Dialog gated conflict');
    await approveFile(id, SPEC);

    const form = new FormData();
    form.set('reason', 'keep the spec');
    form.append('approved_files', SPEC);
    const res = await fetch(`${base}/tasks/${id}/review/accept`, {
      method: 'POST',
      headers: { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string };
    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('failed');
    expect(settled.error ?? '').toContain('requires human approval');
    expect(settled.remedy?.uiAction).toBe('passphrase');
    expect(settled.remedy?.command ?? '').toContain(`--approve-file ${SPEC}`);
    expect(settled.remedy?.command ?? '').toContain('--reason');
    expect(settled.remedy?.command ?? '').toContain('keep the spec');
    expect(readFileSync(join(ctx.root, SPEC), 'utf-8')).toBe(ORIGINAL);
  }, 120_000);

  // The passphrase retry must submit the same approved files as the first
  // accept. After the merge, main still has the agent's content — not a revert.
  test('dialog passphrase retry keeps the approved file through the merge', async () => {
    const id = await conflictTask('Dialog passphrase keeps file');
    await approveFile(id, SPEC);

    const form = new FormData();
    form.set('reason', 'keep the spec');
    form.set('passphrase', PASSPHRASE);
    form.append('approved_files', SPEC);
    const res = await fetch(`${base}/tasks/${id}/review/accept`, {
      method: 'POST',
      headers: { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string };
    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('done');
    expect(readFileSync(join(ctx.root, SPEC), 'utf-8')).toBe(AGENT);
  }, 120_000);

  // Scripting off: the same POST without the dialog header still 303s, still
  // carries approved_files, and still leaves the agent's file on main.
  test('no-script passphrase accept of a conflict task keeps the approved file', async () => {
    const id = await conflictTask('Noscript passphrase keeps file');
    await approveFile(id, SPEC);

    const refused = await fetch(`${base}/tasks/${id}/review/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        reason: 'keep the spec',
        approved_files: SPEC,
      }).toString(),
      redirect: 'manual',
    });
    expect(refused.status).toBe(200);
    const html = await refused.text();
    expect(html).toContain('name="passphrase"');
    expect(html).toContain('Approve and accept');
    expect(html).toContain(`name="approved_files" value="${SPEC}"`);
    expect(html).toContain(`--approve-file ${SPEC}`);
    expect(html).toContain('Or run this in the project directory');
    // The gate text is in the failed notice; the remedy must not duplicate the
    // long "would merge" paragraph a second time next to the form. The notice
    // is the failed-step analogue for scripting-off.
    const mergeMentions = html.split('would merge').length - 1;
    expect(mergeMentions).toBeLessThanOrEqual(1);

    const ok = await fetch(`${base}/tasks/${id}/review/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        reason: 'keep the spec',
        approved_files: SPEC,
        passphrase: PASSPHRASE,
      }).toString(),
      redirect: 'manual',
    });
    expect(ok.status).toBe(303);
    expect(readFileSync(join(ctx.root, SPEC), 'utf-8')).toBe(AGENT);
  }, 120_000);
});

/**
 * Web unblock of a conflict task asks for no file decision and reverts nothing.
 *
 * WAS: the Unblock dialog carried a Keep/Revert radio per pending file, a POST
 * without one was refused (409 / re-rendered page), and Revert reverted the
 * file and told the agent so. The engineer retired all of it on 2026-09-13
 * (move-file-approval-to-accept): the decision is owed at ACCEPT, and forcing
 * it on every feedback round made reviewers rule on files they had not read.
 *
 * IS: unblock is a plain feedback POST whatever the violation set looks like,
 * and the agent's content survives it.
 */
describe('web unblock of a conflict task asks for no file decision', () => {
  const ORIGINAL = 'describe("existing", () => {});\n';
  const AGENT = 'describe("agent kept this", () => { /* must survive keep */ });\n';
  const SPEC = 'a.spec.ts';

  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_FILES: JSON.stringify([{ path: SPEC, content: AGENT }]),
      },
    });
    disablePreAccept(ctx.root);
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    writeFileSync(join(ctx.root, SPEC), ORIGINAL);
    ctx.git('add', 'lazy.toml', SPEC);
    ctx.git('commit', '-m', 'Protect specs and seed a spec file');

    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function conflictTask(goal: string): Promise<string> {
    const shortId = await createTask(ctx, goal, 'Touch the spec');
    expectSuccess(await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', shortId])).exitCode).toBe(0);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { queue } = await (await fetch(`${base}/api/review/queue`)).json();
      const hit = (queue as { id: string }[]).find((e) => e.id.startsWith(shortId));
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`task ${shortId} never reached the review queue`);
  }

  async function pollRun(
    taskId: string,
    runId: string,
    timeoutMs = 90_000,
  ): Promise<{ status: string; error?: string; redirect?: string }> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/action-runs/${runId}`);
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      expect(res.ok).toBe(true);
      last = (await res.json()) as Record<string, unknown>;
      if (last.status === 'done' || last.status === 'failed') return last as never;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`run ${runId} never settled: ${JSON.stringify(last)}`);
  }

  async function worktreeSpec(taskId: string): Promise<string> {
    return readFileSync(join(worktreePathFor(ctx.root, taskId.slice(0, 8)), SPEC), 'utf-8');
  }

  async function nextHumanPrompt(taskId: string, needle: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const show = await ctx.lazy(['show', taskId, '--json']);
      const turns = (JSON.parse(show.stdout).turns ?? []) as Array<{
        role: string;
        prompt: string | null;
      }>;
      const hit = turns.find((t) => t.role === 'human' && (t.prompt ?? '').includes(needle));
      if (hit) return hit.prompt ?? '';
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no human turn containing ${JSON.stringify(needle)}`);
  }

  // INVARIANT (approval-happens-at-accept): no per-file question on the page,
  // and a POST without one is a normal unblock.
  test('dialog unblock with a pending file needs no decision and keeps the file', async () => {
    const id = await conflictTask('Dialog unblock no decision');
    const review = await (await fetch(`${base}/tasks/${id}/review`)).text();
    expect(review).not.toContain('data-lz-unblock-pending');
    expect(review).not.toContain(`name="lz_vd:${SPEC}"`);

    const form = new FormData();
    form.set('message', 'KEEP_SPEC: please continue');
    const res = await fetch(`${base}/tasks/${id}/review/unblock`, {
      method: 'POST',
      headers: { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string };
    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('done');
    expect(await worktreeSpec(id)).toBe(AGENT);
    const prompt = await nextHumanPrompt(id, 'KEEP_SPEC');
    expect(prompt).toContain('KEEP_SPEC: please continue');
    expect(prompt).not.toContain('REVERTED by the reviewer');
  }, 120_000);

  test('no-script unblock with a pending file redirects and keeps the file', async () => {
    const id = await conflictTask('Noscript unblock no decision');
    const res = await fetch(`${base}/tasks/${id}/review/unblock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message: 'please continue' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(await worktreeSpec(id)).toBe(AGENT);
  }, 120_000);

  // INVARIANT: the retired field is INERT, not honoured. A stale form (a cached
  // page, a script someone wrote against the old shape) must not be able to
  // revert a file through a parameter the server no longer reads.
  test('a stale lz_vd:<file>=revert field reverts nothing', async () => {
    const id = await conflictTask('Stale revert field');
    const form = new FormData();
    form.set('message', 'STALE_FIELD: try another way');
    form.set(`lz_vd:${SPEC}`, 'revert');
    const res = await fetch(`${base}/tasks/${id}/review/unblock`, {
      method: 'POST',
      headers: { [ACTION_DIALOG_HEADER]: '1', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string };
    const settled = await pollRun(id, started.runId);
    expect(settled.status).toBe('done');

    const worktree = worktreePathFor(ctx.root, id.slice(0, 8));
    const log = ctx.git('-C', worktree, 'log', '--oneline', '--all');
    expect(log.stdout).not.toContain('Revert protected file changes');
    expect(await worktreeSpec(id)).toBe(AGENT);
    const prompt = await nextHumanPrompt(id, 'STALE_FIELD');
    expect(prompt).not.toContain('REVERTED by the reviewer');
  }, 120_000);
});
