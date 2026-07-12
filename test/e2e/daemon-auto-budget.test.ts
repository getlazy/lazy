/**
 * E2e tests for `lazy daemon auto-budget` subcommands and the local-day helper.
 *
 * Covers list / update / pause / resume and the local-timezone day semantics
 * that back them. These commands read/write project state files directly and
 * do NOT require a running daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

describe('local-day helper', () => {
  test('localDayKey matches local calendar components (not UTC)', async () => {
    const { localDayKey } = await import('../../src/utils/local-day');
    const d = new Date(2026, 0, 15, 23, 30); // Jan 15 2026, 23:30 local
    expect(localDayKey(d)).toBe('2026-01-15');
  });

  test('nextLocalMidnight is the start of tomorrow, local', async () => {
    const { nextLocalMidnight } = await import('../../src/utils/local-day');
    const from = new Date(2026, 0, 15, 14, 0, 0);
    const next = nextLocalMidnight(from);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
    expect(next.getSeconds()).toBe(0);
  });

  test('describeExpiry produces a countdown with a local clock tag', async () => {
    const { describeExpiry } = await import('../../src/utils/local-day');
    const now = new Date(2026, 0, 15, 18, 0, 0);
    const target = new Date(2026, 0, 16, 0, 0, 0); // 6h later, local midnight
    const out = describeExpiry(target, now);
    expect(out).toContain('in 6h');
    expect(out).toContain('00:00 local');
  });

  test('describeExpiry reports "now" once the target has passed', async () => {
    const { describeExpiry } = await import('../../src/utils/local-day');
    const now = new Date(2026, 0, 16, 1, 0, 0);
    const target = new Date(2026, 0, 16, 0, 0, 0);
    expect(describeExpiry(target, now)).toContain('now');
  });
});

describe('lazy daemon auto-budget', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function readBudget(): Record<string, unknown> {
    const p = join(ctx.root, '.lazy', 'auto-react-budget.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {};
  }

  test('list shows used/limit, reset countdown, and no activity initially', async () => {
    const result = await ctx.lazy(['daemon', 'auto-budget', 'list']);
    expectSuccess(result);
    expectOutput(result, 'Auto-react daily budget');
    expectOutput(result, '0/50 turns'); // default configured budget
    expectOutput(result, 'resets in');
    expectOutput(result, '00:00 local');
    expectOutput(result, 'none today');
    expectOutput(result, 'not paused');
  });

  test('update =100 sets an absolute today-only cap', async () => {
    const result = await ctx.lazy(['daemon', 'auto-budget', 'update', '=100']);
    expectSuccess(result);
    expectOutput(result, "Today's auto-react cap set to 100");
    expectOutput(result, 'today-only override');

    expect(readBudget().capOverride).toBe(100);

    const list = await ctx.lazy(['daemon', 'auto-budget', 'list']);
    expectOutput(list, '0/100 turns');
    expectOutput(list, 'today-only cap');
  });

  test('update +50 and -20 adjust relative to the effective cap', async () => {
    await ctx.lazy(['daemon', 'auto-budget', 'update', '+50']); // 50 -> 100
    expect(readBudget().capOverride).toBe(100);

    await ctx.lazy(['daemon', 'auto-budget', 'update', '-20']); // 100 -> 80
    expect(readBudget().capOverride).toBe(80);
  });

  test('update rejects garbage deltas', async () => {
    const result = await ctx.lazy(['daemon', 'auto-budget', 'update', 'banana']);
    expectFailure(result);
  });

  test('pause sets a midnight-bounded pause; resume clears it', async () => {
    const pause = await ctx.lazy(['daemon', 'auto-budget', 'pause']);
    expectSuccess(pause);
    expectOutput(pause, 'Auto-react paused');
    expectOutput(pause, '00:00 local');

    // Pause state is persisted with an expiry.
    const pausePath = join(ctx.root, '.lazy', 'auto-react-paused.json');
    const pauseState = JSON.parse(readFileSync(pausePath, 'utf-8'));
    expect(pauseState.paused).toBe(true);
    expect(typeof pauseState.expires_at).toBe('number');

    const list = await ctx.lazy(['daemon', 'auto-budget', 'list']);
    expectOutput(list, 'PAUSED');
    expectOutput(list, 'resumes in');

    const resume = await ctx.lazy(['daemon', 'auto-budget', 'resume']);
    expectSuccess(resume);
    expectOutput(resume, 'Auto-react resumed');

    const resumed = JSON.parse(readFileSync(pausePath, 'utf-8'));
    expect(resumed.paused).toBe(false);
  });

  test('an expired pause auto-resumes when read', async () => {
    const { setGlobalAutoReactPaused, isGlobalAutoReactPaused } = await import('../../src/daemon/auto-react-budget');
    const dataDir = join(ctx.root, '.lazy');

    // Pause that expired one second ago.
    await setGlobalAutoReactPaused(dataDir, true, 'test', Date.now() - 1000);
    const status = await isGlobalAutoReactPaused(dataDir);
    // INVARIANT: an expired pause must read as NOT paused so the daemon
    // auto-resumes at local midnight without a manual resume.
    expect(status.paused).toBe(false);
  });
});
