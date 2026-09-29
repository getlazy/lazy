/**
 * `lazy stats budget` — the token budgets in play. Daemonless, so this runs
 * the in-process fallback of the `tokenBudget` RPC over a seeded audit trail.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { seedBudgetAudit } from '../helpers/budget-audit';

describe('lazy stats budget', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a fresh project says there are no readings and no agent turns', async () => {
    const result = await ctx.lazy(['stats', 'budget']);
    expectSuccess(result);
    expect(result.stdout).toContain('No usage-limit readings yet');
    expect(result.stdout).toContain('(no agent turns)');
  });

  // INVARIANT: "left" is an extrapolation of the provider's own percentage
  // from the tokens spent in the window — never money.
  test('a window reading with spend in it shows the tokens spent and an estimate of what is left', async () => {
    await seedBudgetAudit(ctx.root);
    const result = await ctx.lazy(['stats', 'budget']);
    expectSuccess(result);
    expect(result.stdout).toContain('credential:CLAUDE_CODE_OAUTH_TOKEN');
    expect(result.stdout).toMatch(/5-hour window\s+30% used/);
    expect(result.stdout).toContain('30.0k tokens spent in window');
    expect(result.stdout).toContain('~70.0k tokens left');
    expect(result.stdout).not.toMatch(/\$|USD/);

    const json = await ctx.lazy(['stats', 'budget', '--json']);
    expectSuccess(json);
    const view = JSON.parse(json.stdout);
    expect(view.scope).toBe('project');
    const w = view.credentials[0].windows[0];
    expect(w).toMatchObject({ name: 'unified-5h', spentTokens: 30_000, spendSource: 'audit', tokensPerPercent: 1000, leftTokens: 70_000, gap: null });
    expect(view.days).toHaveLength(7);
  });

  test('--help documents the command', async () => {
    const result = await ctx.lazy(['stats', 'budget', '--help']);
    expectSuccess(result);
    expect(result.stdout).toContain('Usage: lazy stats budget');
  });
});
