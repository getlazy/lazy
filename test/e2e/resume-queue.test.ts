/**
 * E2e tests for `lazy daemon resume-queue` and the slow-lane auto-resume
 * indicators surfaced by `lazy list` / `lazy show`.
 *
 * The command is read-only against Storage + config, so these tests run
 * daemonless: they seed a task past the fast-lane circuit breaker
 * (MAX_CONSECUTIVE_INTERRUPTIONS consecutive crashes) directly in storage,
 * mirroring the circuit-breaker seeding pattern in auto-resume.test.ts.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, setTaskStatus, readSessionJson, writeSessionJson } from '../helpers/storage';
import { MAX_CONSECUTIVE_INTERRUPTIONS } from '../../src/utils/auto-resume';

describe('lazy daemon resume-queue', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Trip the fast-lane circuit breaker on an already-started task, putting it in the slow lane. */
  function tripCircuitBreaker(taskId: string): void {
    setTaskStatus(ctx.root, taskId, 'interrupted');
    const session = readSessionJson(ctx.root, taskId) ?? {};
    session.consecutive_interruptions = MAX_CONSECUTIVE_INTERRUPTIONS;
    session.ended_at = null;
    session.user_stopped = false;
    // show.ts only renders the slow-lane line inside its interrupt-diagnostics
    // block, which is itself gated on interrupt_at.
    session.interrupt_at = Date.now();
    writeSessionJson(ctx.root, taskId, session);
  }

  test('reports empty when nothing is queued', async () => {
    const result = await ctx.lazy(['daemon', 'resume-queue']);
    expectSuccess(result);
    expectOutput(result, 'empty');
  });

  test('reports disabled when daemon.auto_resume is false', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace('# auto_resume = true', 'auto_resume = false');
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);

    const result = await ctx.lazy(['daemon', 'resume-queue']);
    expectSuccess(result);
    expectOutput(result, 'auto_resume is false');
  });

  test('lists a task whose fast-lane circuit breaker has tripped', async () => {
    const taskId = await createTask(ctx, 'Slow lane test', 'Do the work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const fullId = findFullTaskId(ctx.root, taskId);
    tripCircuitBreaker(fullId);

    const result = await ctx.lazy(['daemon', 'resume-queue']);
    expectSuccess(result);
    expectOutput(result, 'task(s) queued');
    expectOutput(result, 'attempt 1/24');
  });

  test('a healthy task does not appear in the queue', async () => {
    const taskId = await createTask(ctx, 'Not interrupted', 'Do the work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const result = await ctx.lazy(['daemon', 'resume-queue']);
    expectSuccess(result);
    expectOutput(result, 'empty');
  });
});

describe('slow-lane indicators in list/show', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function tripCircuitBreaker(taskId: string): void {
    setTaskStatus(ctx.root, taskId, 'interrupted');
    const session = readSessionJson(ctx.root, taskId) ?? {};
    session.consecutive_interruptions = MAX_CONSECUTIVE_INTERRUPTIONS;
    session.ended_at = null;
    session.user_stopped = false;
    session.interrupt_at = Date.now();
    writeSessionJson(ctx.root, taskId, session);
  }

  test('lazy list shows the auto-resume queue position', async () => {
    const taskId = await createTask(ctx, 'Queued in list', 'Do the work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const fullId = findFullTaskId(ctx.root, taskId);
    tripCircuitBreaker(fullId);

    const result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'auto-resume');
    expectOutput(result, 'attempt 1/24');
  });

  test('lazy show shows the slow-lane auto-resume line', async () => {
    const taskId = await createTask(ctx, 'Queued in show', 'Do the work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const fullId = findFullTaskId(ctx.root, taskId);
    tripCircuitBreaker(fullId);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Slow-lane auto-resume:');
    expectOutput(result, 'attempt 1/24');
  });
});
