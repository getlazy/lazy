import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '../../src/types';
import { loadConfig } from '../../src/config/loader';
import { webInteractiveRefusal, resetUsagePauseStateForTest } from '../../src/daemon/usage-pause';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { putEndpointCredential, clearUserCredentialCache, setCredentialBillingMode } from '../../src/daemon/user-credentials';
import { daemonUsageLimits, memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

let root: string;
let base: string;
let unpin: () => void;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CONFIG = `
[usage_pause]
threshold_percent = 95
[endpoints.sub]
url = "https://api.anthropic.com"
credential = "anthropic"
[endpoints.local]
url = "http://localhost:11434"
credential = "none"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "sub", model = "claude-opus-5-5", threshold_percent = 90 }, { endpoint = "local", model = "qwen3-coder" }]
[agents.paid]
harness = "claude-code"
tiers = [{ endpoint = "sub", model = "claude-opus-5-5", threshold_percent = 90 }]
`;

beforeEach(async () => {
  resetUsageReadingsForTest();
  resetUsagePauseStateForTest();
  clearUserCredentialCache();
  root = await mkdtemp(join(tmpdir(), 'member-interactive-usage-'));
  base = await mkdtemp(join(tmpdir(), 'member-interactive-usage-daemon-'));
  unpin = pinDaemonBaseDir(base);
  await writeFile(join(root, 'lazy.toml'), CONFIG);
  await setCredentialBillingMode(root);
  for (const email of [ALICE, BOB]) {
    await putEndpointCredential(root, {
      userId: email, endpointId: 'sub', origin: 'https://api.anthropic.com',
      provider: 'anthropic', kind: 'oauth', token: `${email}-secret`,
    });
  }
});

afterEach(async () => {
  resetUsageReadingsForTest();
  resetUsagePauseStateForTest();
  clearUserCredentialCache();
  unpin();
  await rm(root, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

function reading(email: string, used: number) {
  daemonUsageLimits.observeReading({
    credential: memberEndpointUsageKey(email, 'sub'), ts: Date.now(),
    upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200, taskId: null, model: null,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': String(used / 100),
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

function task(profile: string): Task {
  return { id: 'task-1', code: 'member-task', agent_id: profile } as Task;
}

for (const mode of ['pair', 'chat'] as const) {
  // INVARIANT: member interactive admission uses the same entire tier chain
  // as requests, so a full first tier cannot hide an available fallback.
  test(`${mode}: a full first tier with an unconditional fallback admits the member`, async () => {
    reading(ALICE, 99);
    const config = await loadConfig(root);
    for (const peek of [true, false]) {
      expect(await webInteractiveRefusal(root, task('chain'), config, mode, peek, ALICE)).toBeNull();
    }
  });

  // INVARIANT: admission judges the attaching member's tier readings and tier
  // thresholds, never the task owner, service holder or another member.
  test(`${mode}: paid tiers use the attaching member's usage and per-tier threshold`, async () => {
    reading(ALICE, 92); // Below global 95, above this tier's 90.
    reading(BOB, 10);
    const config = await loadConfig(root);
    for (const peek of [true, false]) {
      expect(await webInteractiveRefusal(root, task('paid'), config, mode, peek, BOB)).toBeNull();
      const refusal = await webInteractiveRefusal(root, task('paid'), config, mode, peek, ALICE);
      expect(refusal?.status).toBe(429);
      expect(refusal?.message).toContain('92%');
    }
  });
}
