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
    const { readings } = view;
    expect(readings.map((r: { credential: string }) => r.credential)).toEqual([
      'credential:CLAUDE_CODE_OAUTH_TOKEN',
      'credential:ANTHROPIC_API_KEY',
    ]);
  });
});
