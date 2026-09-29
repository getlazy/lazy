/**
 * The token-budget projection behind `lazy stats budget`, the dashboard's
 * budget box, Lazy Teams' project page and `lazy_usage_limits.budget`.
 */
import { describe, test, expect } from 'bun:test';
import { projectTokenBudget, windowLengthMs, type BudgetTurnInput } from '../../src/usage-pause/budget-view';
import { projectUsageLimits, scopeUsageLimitsView } from '../../src/usage-pause/limits-view';
import type { UsageLimitReading } from '../../src/proxy/usage-limits';
import type { ProxyAuditRecord } from '../../src/storage/types';

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const pause = { configured: { threshold_percent: 90, credentials: {} }, override: null, paused: [], held: [] };

function reading(credential: string, windows: UsageLimitReading['windows'], headers: Record<string, string> = {}): UsageLimitReading {
  return { credential, ts: NOW - 60_000, upstream: 'u', backend: 'anthropic', status: 200, taskId: null, model: null, headers, windows };
}
function audit(credential: string, ts: number, tokens: number, taskId = 't1', model = 'claude-opus-5-5'): ProxyAuditRecord {
  return {
    credential, ts, taskId, model, role: 'agent',
    usage: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  } as unknown as ProxyAuditRecord;
}
function turn(agent: string | undefined, ts: number, tokens: number | null, taskId = 't1', credential: string | null = 'user:a'): BudgetTurnInput {
  return {
    taskId, taskCode: `code-${taskId}`, agent, timestamp: ts, credential,
    usage: tokens === null ? null : { inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
}

const fiveHour = { name: 'unified-5h', usedPercent: 40, resetsAt: NOW + 2 * H, status: null };

describe('token budget view', () => {
  test('a percentage window with covering audit trail gets spend, tokens-per-percent and what is left', () => {
    const limits = projectUsageLimits([reading('user:a', [fiveHour])], pause, NOW);
    // Window began at NOW - 3h; the first record predates it and must not count.
    const trail = [audit('user:a', NOW - 4 * H, 999), audit('user:a', NOW - 2 * H, 30_000), audit('user:a', NOW - H, 10_000, 't2'),
      audit('user:other', NOW - H, 50_000)];
    const turns = [turn('claude-code', NOW - H, 2_000), turn('claude-code', NOW - 2 * H, 4_000)];
    const view = projectTokenBudget(limits, trail, turns, NOW);
    const w = view.credentials[0].windows[0];
    expect(view.credentials[0].harness).toBe('claude-code');
    expect(w.windowStart).toBe(NOW - 3 * H);
    expect(w.spendSource).toBe('audit');
    expect(w.spentTokens).toBe(40_000);
    expect(w.tokensPerPercent).toBe(1_000);
    expect(w.leftPercent).toBe(60);
    expect(w.leftTokens).toBe(60_000);
    expect(w.leftTurns).toBe(20); // typical claude-code turn = median(2000, 4000) = 3000
    expect(w.gap).toBeNull();
    expect(w.byTask.map((t) => t.key)).toEqual(['t1', 't2']);
  });

  test('a short trail falls back to the recorded turns when one credential meters the harness', () => {
    const limits = projectUsageLimits([reading('user:a', [fiveHour])], pause, NOW);
    const view = projectTokenBudget(limits, [audit('user:a', NOW - H, 1)], [turn('claude-code', NOW - H, 20_000), turn('codex', NOW - H, 99_999)], NOW);
    const w = view.credentials[0].windows[0];
    expect(w.spendSource).toBe('turns');
    expect(w.spentTokens).toBe(20_000);
    expect(w.leftTokens).toBe(30_000);
  });

  // INVARIANT: a budget is only an extrapolation of a percentage the provider
  // reported. With no way to know the window's spend, no estimate is invented.
  test('a short trail with a turn whose credential is unknown gives no estimate, and says why', () => {
    const limits = projectUsageLimits([reading('user:a', [fiveHour])], pause, NOW);
    const turns = [turn('claude-code', NOW - H, 20_000), turn('claude-code', NOW - H, 5_000, 't2', null)];
    const w = projectTokenBudget(limits, [audit('user:a', NOW - H, 1)], turns, NOW).credentials[0].windows[0];
    expect(w.spentTokens).toBeNull();
    expect(w.leftTokens).toBeNull();
    expect(w.gap).toBe('trail-shorter-than-window');
    expect(w.leftPercent).toBe(60);
  });

  // INVARIANT: a window only ever counts turns that spent ITS credential —
  // including when the view is narrowed to one credential, where the other
  // credentials' turns are still in the input and must not inflate the estimate.
  test('two credentials on one harness each count only their own turns', () => {
    const turns = [turn('claude-code', NOW - H, 20_000), turn('claude-code', NOW - H, 80_000, 't2', 'user:b')];
    const both = projectUsageLimits([reading('user:a', [fiveHour]), reading('user:b', [fiveHour])], pause, NOW);
    const view = projectTokenBudget(both, [audit('user:a', NOW - H, 1)], turns, NOW);
    expect(view.credentials.map((c) => c.windows[0].spentTokens)).toEqual([20_000, 80_000]);

    const narrowed = scopeUsageLimitsView(both, 'user:a', 't1');
    const own = projectTokenBudget(narrowed, [audit('user:a', NOW - H, 1)], turns, NOW, { taskId: 't1' });
    expect(own.credentials[0].windows[0]).toMatchObject({ spendSource: 'turns', spentTokens: 20_000, leftTokens: 30_000 });
  });

  test('every turn in the harness and task totals lands in a day bucket', () => {
    const limits = projectUsageLimits([], pause, NOW);
    // 6.4 days ago is the oldest bucket's UTC date; 6.9 days ago is the day before it.
    const view = projectTokenBudget(limits, [], [turn('pi', NOW - 6.4 * 24 * H, 10), turn('pi', NOW - 6.9 * 24 * H, 99)], NOW);
    expect(view.harnesses[0].tokens).toBe(10);
    expect(view.harnesses[0].tokens).toBe(view.days.reduce((n, d) => n + d.tokens, 0));
  });

  test('no percentage, a reset window, an unknown length and too little use each carry a gap and no estimate', () => {
    const limits = projectUsageLimits([reading('user:a', [
      { name: 'unified-7d', usedPercent: null, resetsAt: NOW + H, status: 'allowed' },
      { name: 'unified-5h', usedPercent: 50, resetsAt: NOW - H, status: null },
      { name: 'tokens', usedPercent: 50, resetsAt: NOW + H, status: null },
      { name: 'codex-primary', usedPercent: 1, resetsAt: NOW + H, status: null },
    ], { 'x-codex-primary-window-minutes': '300' })], pause, NOW);
    const view = projectTokenBudget(limits, [audit('user:a', NOW - 200 * H, 5)], [], NOW);
    expect(view.credentials[0].windows.map((w) => w.gap)).toEqual(['no-percent', 'reset', 'unknown-window-length', 'too-little-data']);
    expect(view.credentials[0].windows.every((w) => w.leftTokens === null)).toBe(true);
  });

  test('window lengths come from the name or the Codex header, never guessed', () => {
    expect(windowLengthMs('unified-5h', {})).toBe(5 * H);
    expect(windowLengthMs('unified-7d', {})).toBe(7 * 24 * H);
    expect(windowLengthMs('codex-secondary', { 'x-codex-secondary-window-minutes': '10080' })).toBe(7 * 24 * H);
    expect(windowLengthMs('codex-primary', {})).toBeNull();
    expect(windowLengthMs('requests', {})).toBeNull();
  });

  // INVARIANT: harnesses with no percentage window are shown as spend only.
  test('harness rows mark which have a window reading; turns without usage are counted, not guessed', () => {
    const limits = projectUsageLimits([reading('user:a', [fiveHour])], pause, NOW);
    const turns = [turn('claude-code', NOW - H, 100), turn('cursor', NOW - H, null), turn('pi', NOW - H, 50), turn(undefined, NOW - H, 10),
      turn('claude-code', NOW - 8 * 24 * H, 1_000_000)];
    const view = projectTokenBudget(limits, [], turns, NOW);
    const by = Object.fromEntries(view.harnesses.map((h) => [h.harness, h]));
    expect(by['claude-code']).toMatchObject({ budget: 'percent', tokens: 100, turns: 1 });
    expect(by.cursor).toMatchObject({ budget: 'tokens-only', turns: 1, turnsWithUsage: 0, tokens: 0, typicalTurnTokens: null });
    expect(by.pi.budget).toBe('tokens-only');
    expect(by.unknown.tokens).toBe(10);
    expect(view.days).toHaveLength(7);
    expect(view.days[6].tokens).toBe(160);
  });

  test('a task-scoped view lists only the calling task and only its own credential', () => {
    const limits = scopeUsageLimitsView(projectUsageLimits([reading('user:a', [fiveHour]), reading('user:b', [fiveHour])], pause, NOW), 'user:a', 't1');
    const view = projectTokenBudget(limits, [], [turn('claude-code', NOW - H, 5, 't1'), turn('claude-code', NOW - H, 7, 't2')], NOW, { taskId: 't1' });
    expect(view.scope).toBe('task');
    expect(view.credentials.map((c) => c.credential)).toEqual(['user:a']);
    expect(view.tasks.map((t) => t.taskId)).toEqual(['t1']);
  });
});

describe('Teams turn credential', () => {
  // INVARIANT: a Teams turn is attributed only to the credential its own row
  // proves it billed — the asker's, or the service credential for a turn the
  // daemon started — and to nothing when the row names neither.
  test('asker, system and unknown turns', async () => {
    const { teamsTurnCredential } = await import('../../src/daemon/token-budget');
    expect(teamsTurnCredential({ actor: 'agent', actor_email: 'm@example.com' })).toBe('user:m@example.com');
    expect(teamsTurnCredential({ actor: 'system', actor_email: 'owner@example.com' })).toBe('user:__service__');
    expect(teamsTurnCredential({ actor: 'agent' })).toBeNull();
  });
});

describe('attachBudget', () => {
  // INVARIANT: a budget failure never costs the readings; the unreadable-
  // readings refusal still fails loudly.
  test('a failing budget yields budget null with the reason; the unreadable refusal is rethrown', async () => {
    const { attachBudget } = await import('../../src/usage-pause/budget-view');
    const { usageLimitsUnreadableMessage } = await import('../../src/usage-pause/limits-view');
    const view = { scope: 'project', readings: [1] };
    const out = await attachBudget(view, async () => { throw new Error('Unknown RPC method: tokenBudget'); });
    expect(out.readings).toEqual([1]);
    expect(out.budget).toBeNull();
    expect(out.budgetError).toContain('Unknown RPC method');
    await expect(attachBudget(view, async () => {
      throw new Error(usageLimitsUnreadableMessage({ path: '/x', message: 'bad json' }));
    })).rejects.toThrow("Could not read the proxy's usage-limit readings");
  });
});
