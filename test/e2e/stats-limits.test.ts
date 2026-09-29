/**
 * `lazy stats limits` — the latest usage-limit reading per credential.
 *
 * Seeds proxy-audit.jsonl directly (capture itself is covered by
 * test/unit/proxy-usage-limits.test.ts). Daemonless, so this exercises the
 * in-process fallback of the `usageLimits` RPC over the same fold.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { auditLogPath } from '../../src/proxy/audit-log';

function line(i: number, ts: number, credential: string | undefined, headers: Record<string, string> | undefined, status = 200): string {
  return JSON.stringify({
    id: `rec-${i}`, seq: i, ts, role: 'agent', taskId: null, backend: 'proxy',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages', endpoint: 'messages',
    model: 'claude-opus', tier: 'opus', stream: true, requestShape: null, toolUses: [], toolResults: [],
    status, usage: null, stopReason: null, error: null, durationMs: 5, reroute: null, enforcement: null,
    ...(credential ? { credential } : {}),
    ...(headers ? { usageLimitHeaders: headers } : {}),
  });
}

describe('lazy stats limits', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function seed(lines: string[]): Promise<void> {
    const path = auditLogPath(join(ctx.root, '.lazy'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lines.join('\n') + '\n', 'utf-8');
  }

  test('empty state when nothing has been captured', async () => {
    await seed([line(1, Date.now(), undefined, undefined)]);
    const result = await ctx.lazy(['stats', 'limits']);
    expectSuccess(result);
    expect(result.stdout).toContain('No usage-limit readings yet');
  });

  test('shows the latest reading per credential, as percent of each window', async () => {
    const now = Date.now();
    await seed([
      line(1, now - 5000, 'credential:CLAUDE_CODE_OAUTH_TOKEN', {
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
      }),
      line(2, now - 1000, 'credential:CLAUDE_CODE_OAUTH_TOKEN', {
        'anthropic-ratelimit-unified-5h-utilization': '0.955',
        'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
      }),
      line(3, now - 2000, 'credential:ANTHROPIC_API_KEY', { 'retry-after': '60' }, 429),
    ]);
    const result = await ctx.lazy(['stats', 'limits']);
    expectSuccess(result);
    expect(result.stdout).toContain('credential:CLAUDE_CODE_OAUTH_TOKEN');
    expect(result.stdout).toContain('95.5% used');
    expect(result.stdout).toContain('allowed_warning');
    expect(result.stdout).not.toContain('10% used');
    expect(result.stdout).toContain('credential:ANTHROPIC_API_KEY');
    expect(result.stdout).toContain('retry-after 60');

    const json = await ctx.lazy(['stats', 'limits', '--json']);
    expectSuccess(json);
    const view = JSON.parse(json.stdout);
    // INVARIANT: the same object lazy_usage_limits returns (one projection).
    expect(view.scope).toBe('project');
    expect(view.pause).toBeDefined();
    expect(view.pause.configured).toBeDefined();
    // ...including the token budget, attached the same way.
    expect(view.budget.scope).toBe('project');
    expect(view.budget.credentials.map((c: { credential: string }) => c.credential)).toContain('credential:CLAUDE_CODE_OAUTH_TOKEN');
    const { readings } = view;
    expect(readings.map((r: { credential: string }) => r.credential)).toEqual([
      'credential:CLAUDE_CODE_OAUTH_TOKEN',
      'credential:ANTHROPIC_API_KEY',
    ]);
  });

  // INVARIANT: a window whose reset has passed is shown as reset, never as its
  // old percentage — in text and --json alike. The engineer read "100% used"
  // of a Codex window that had reset hours earlier and was back at 0%.
  test('a window past its reset shows as reset, not its stored percentage', async () => {
    const readAt = Date.now() - 8 * 3_600_000;
    await seed([
      line(1, readAt, 'credential:ChatGPT subscription', {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-reset-after-seconds': '7200',
        'x-codex-secondary-used-percent': '74',
        'x-codex-secondary-reset-after-seconds': String(32 * 3600),
      }, 429),
    ]);
    const result = await ctx.lazy(['stats', 'limits']);
    expectSuccess(result);
    expect(result.stdout).toContain('reset at');
    expect(result.stdout).toContain('was 100% used');
    expect(result.stdout).not.toMatch(/100% used\s+·/);
    expect(result.stdout).toContain('74% used');

    const json = await ctx.lazy(['stats', 'limits', '--json']);
    expectSuccess(json);
    const [r] = JSON.parse(json.stdout).readings;
    const byName = (ws: { name: string }[], n: string) => ws.find((w) => w.name === n) as Record<string, unknown>;
    expect(byName(r.windows, 'codex-primary').usedPercent).toBeNull();
    expect(typeof byName(r.windows, 'codex-primary').resetSince).toBe('number');
    expect(byName(r.windows, 'codex-secondary')).toMatchObject({ usedPercent: 74, resetSince: null });
    expect(byName(r.storedWindows, 'codex-primary').usedPercent).toBe(100);
  });
});
