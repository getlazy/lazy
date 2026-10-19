/**
 * INVARIANT (fix-empty-failed-turn): a turn that dies must always leave a
 * VISIBLE record.
 *
 * "Visible" means a turn in the task's turns list — the surface a human reads
 * in `lazy show` and the one lazy-teams renders. An interrupt reason buried on
 * the session is not enough: no turn list can show it, so from the outside the
 * task simply came back from `working` having done nothing.
 *
 * The field incident this pins: with a dead credential, the FIRST unblock
 * recorded a fatal_auth turn and the SECOND recorded nothing at all. A
 * `FatalAgentError` response carries no `duration_ms` and no `exit_code`, so
 * two consecutive fatal_auth failures produce byte-identical turn content — and
 * the reconciler's content-based idempotency was scoped to the whole session,
 * so it swallowed the repeat. The task came back in seconds with an empty turns
 * list and nothing to diagnose.
 *
 * This runs on the fake-binary seam on purpose: a mocked `launchSupervisorAsync`
 * never produces a real classified failure, so only here does a real supervisor
 * classify a real 401 and a real reconciler decide what to record.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { crashScenario, successScenario } from '../helpers/fake-claude';
import { readSystemMessagesFile, taskFilePath } from '../helpers/storage';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { agentTurns, allTurns, sessionInterrupt } from '../helpers/agent-seam';

/** What a credential Anthropic rejects looks like on the way out of the agent. */
const AUTH_401 = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}\n';

describe('a failed turn always leaves a visible record', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a repeat unblock against the same dead credential records a SECOND failure turn', async () => {
    const taskId = await createTask(ctx, 'Dead credential', 'Do the work');
    // The same rejection on every invocation — exactly the field condition.
    await ctx.setClaudeScenario(crashScenario({ stderr: AUTH_401, exitCode: 1 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterFirst = await agentTurns(ctx.root, taskId);
    expect(afterFirst.length).toBe(1);
    expect(String(afterFirst[0]!.content)).toContain('fatal_auth');

    // A classified failure blocks the task for a human, so the human unblocks —
    // against the still-dead credential.
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'try again']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const afterSecond = await agentTurns(ctx.root, taskId);
    expect(afterSecond.length).toBe(2);
    expect(String(afterSecond[1]!.content)).toContain('fatal_auth');

    // And the failure is legible from the task read, not just from the file.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'fatal_auth');

    const interrupt = await sessionInterrupt(ctx.root, taskId);
    expect(interrupt.interrupt_reason).toContain('fatal_auth');
  }, 150_000);

  // INVARIANT (fix-fatal-failure-silent-park): a turn that dies on an
  // unrecoverable failure is VISIBLE AS A FAILURE, not as a review park. The
  // task shows failed:<class> with the fix, lazy files exactly one alert for the
  // problem (no agent runs to write one when the credential is what broke), the
  // park names the system with its reason — never the human who unblocked — and
  // the next successful turn clears the label. In the field a member re-sent
  // the same feedback for 14 hours because the task read as plain `blocked`.
  test('a fatal_auth turn shows failed:fatal_auth, files one alert, names no human, and clears on success', async () => {
    const taskId = await createTask(ctx, 'Dead credential, visibly', 'Do the work');
    await ctx.setClaudeScenario(crashScenario({ stderr: AUTH_401, exitCode: 1 }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    // A second failing turn on the same problem must not file a second alert.
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'please continue']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expectOutput(list, 'failed:fatal_auth');
    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'the last turn failed (fatal_auth)');
    expectOutput(show, 'Fix:');

    // The failure notice is lazy's, structurally — not the agent's reply.
    const turns = await agentTurns(ctx.root, taskId);
    expect((turns.at(-1) as { failure?: { class: string } }).failure?.class).toBe('fatal_auth');

    const alerts = readSystemMessagesFile(ctx.root).filter(m => m.kind === 'alert' && m.source === 'turn-failure');
    expect(alerts.length).toBe(1);
    // The second failure was COUNTED on the open alert, not dropped.
    expect(alerts[0]!.repeat_count).toBe(2);
    expect(alerts[0]!.title).toContain('fatal_auth');
    expect(alerts[0]!.body).toContain('What to do:');

    const changes = JSON.parse(await readFile(taskFilePath(ctx.root, taskId, 'status-changelog.json'), 'utf-8')).changes as
      Array<{ status: string; actor?: string; reason?: string }>;
    const park = changes.at(-1)!;
    expect(park.status).toBe('blocked');
    expect(park.actor).not.toBe('human');
    expect(park.reason).toContain('fatal_auth');

    // The credential is fixed: the next turn succeeds and the label is gone.
    await ctx.setClaudeScenario(successScenario());
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'credential fixed']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const after = await ctx.lazy(['list']);
    expectSuccess(after);
    expect(after.stdout).not.toContain('failed:');

    // Never lose human feedback: the words sent into the failed turn reach
    // the turn that finally ran.
    const delivered = (await allTurns(ctx.root, taskId))
      .filter(t => t.role === 'human' && String(t.content).includes('credential fixed'));
    expect(delivered.length).toBe(1);
    expect(String(delivered[0]!.content)).toContain('please continue');
  }, 200_000);

  // INVARIANT (fix-fatal-failure-silent-park): when the task's environment
  // fails to START on an unblock, the park names the system with its reason,
  // never the person who unblocked, and leaves a failure notice. In the field
  // this park was `actor: human` with no reason and no turn, and read as the
  // member stopping the task themselves.
  test('an unblock whose supervisor fails to launch parks as the system, with reason and a notice', async () => {
    const taskId = await createTask(ctx, 'Launch dies', 'Do the work');
    await ctx.setClaudeScenario(successScenario());
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // An agent profile whose pinned upstream answers nothing: the launch's
    // preflight throws inside launchSupervisor.
    const tomlPath = join(ctx.root, 'lazy.toml');
    await writeFile(tomlPath, (await readFile(tomlPath, 'utf-8')) +
      '\n[agents.dead-endpoint]\nharness = "claude-code"\nmodel = "claude-opus-5-5"\nendpoint = "http://10.255.255.1:9"\ncredential = "none"\n');

    const unblock = await ctx.lazy(['unblock', taskId, '--agent', 'dead-endpoint', '--message', 'carry on']);
    expect(unblock.exitCode).not.toBe(0);

    const changes = JSON.parse(await readFile(taskFilePath(ctx.root, taskId, 'status-changelog.json'), 'utf-8')).changes as
      Array<{ status: string; actor?: string; reason?: string }>;
    const park = changes.at(-1)!;
    expect(park.status).toBe('interrupted');
    expect(park.actor).not.toBe('human');
    expect(park.reason).toContain('did not start');
    const last = (await allTurns(ctx.root, taskId)).at(-1) as { failure?: { class: string } };
    expect(last.failure?.class).toBe('launch_failed');
    expectOutput(await ctx.lazy(['list']), 'failed:launch_failed');
    // The decorated status fits its column: every column after STATUS starts
    // where its header does (a fixed 12-wide STATUS let this label spill over).
    const lines = (await ctx.lazy(['list'])).stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    const header = lines.find(l => l.startsWith('CODE'))!;
    const row = lines.find(l => l.includes('failed:launch_failed'))!;
    const modelAt = header.indexOf('MODEL');
    const statusAt = header.indexOf('STATUS');
    expect(row.slice(statusAt, modelAt).trimEnd()).toBe('interrupted(failed:launch_failed)');
    expect(row[modelAt - 1]).toBe(' ');
    expect(row[modelAt]).not.toBe(' ');
    // The status history says WHY lazy parked it, not only who did.
    expect((await ctx.lazy(['show', taskId])).stdout).toMatch(/→ interrupted by system.*— the task's container did not start/);
  }, 200_000);
});
