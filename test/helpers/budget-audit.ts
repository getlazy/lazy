/**
 * Seed a proxy audit trail that gives one credential a 5-hour window reading
 * at 30% with 30,000 tokens spent inside it — enough for the token-budget view
 * to estimate what is left. Written straight to the (disposable) audit log
 * file, the way test/e2e/stats-limits.test.ts seeds readings.
 */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { auditLogPath } from '../../src/proxy/audit-log';

const H = 3_600_000;

function record(i: number, ts: number, tokens: number, headers?: Record<string, string>): string {
  return JSON.stringify({
    id: `budget-${i}`, seq: i, ts, role: 'agent', taskId: null, backend: 'anthropic',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages', endpoint: 'messages',
    model: 'claude-opus-5-5', tier: 'opus', stream: true, requestShape: null, toolUses: [], toolResults: [],
    status: 200, stopReason: null, error: null, durationMs: 5, reroute: null, enforcement: null,
    usage: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    credential: 'credential:CLAUDE_CODE_OAUTH_TOKEN',
    ...(headers ? { usageLimitHeaders: headers } : {}),
  });
}

/** Returns the window's reset time (unix ms). */
export async function seedBudgetAudit(root: string, now: number = Date.now()): Promise<number> {
  const resetAt = Math.floor((now + 2 * H) / 1000);
  const path = auditLogPath(join(root, '.lazy'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    // Before the window began (reset − 5h): proves the trail covers it, never counted.
    record(1, now - 4 * H, 777),
    record(2, now - H, 30_000, {
      'anthropic-ratelimit-unified-5h-utilization': '0.30',
      'anthropic-ratelimit-unified-5h-reset': String(resetAt),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }),
  ].join('\n') + '\n', 'utf-8');
  return resetAt * 1000;
}
