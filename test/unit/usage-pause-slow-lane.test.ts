/**
 * The slow-lane auto-resume queue passes over a task a [usage_pause] holds
 * WITHOUT recording an attempt (src/daemon/auto-resume-queue.ts).
 *
 * Runs the REAL gate: a project root whose lazy.toml sets a threshold, and a
 * reading fed into the daemon's in-process usage tracker under the exact
 * credential key the gate resolves for a Claude Code task. No module mocks.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { processAutoResumeQueue, getSlowLaneState } from '../../src/daemon/auto-resume-queue';
import { MAX_CONSECUTIVE_INTERRUPTIONS } from '../../src/utils/auto-resume';
import {
  assertTurnStartAllowed,
  getUsagePauseOverride,
  setUsagePauseOverride,
  turnSpendCredential,
} from '../../src/daemon/usage-pause';
import { USAGE_PAUSE_HELD_KEY } from '../../src/usage-pause/hold';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { loadConfig } from '../../src/config/loader';
import type { Storage } from '../../src/storage/interface';
import type { Task, Session } from '../../src/types';

function createMockStorage(tasks: Task[], sessions: Map<string, Session>) {
  const metadata = new Map<string, Map<string, string>>();
  const notices: Array<{ title: string }> = [];
  const storage = {
    async createSystemMessage(input: { title: string }) {
      notices.push(input);
      return input;
    },
    async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
      return metadata.get(taskId)?.get(key) ?? null;
    },
    async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
      if (!metadata.has(taskId)) metadata.set(taskId, new Map());
      metadata.get(taskId)!.set(key, value);
    },
    async listTasks(): Promise<Task[]> {
      return tasks;
    },
    async getSessionByTaskId(taskId: string): Promise<Session | null> {
      return sessions.get(taskId) ?? null;
    },
  } as unknown as Storage;
  return { storage, metadata, notices };
}

/** Interrupted, past the fast-lane breaker, and past its first slow-lane interval. */
function trippedSession(now: number): Session {
  return {
    ended_at: null,
    consecutive_interruptions: MAX_CONSECUTIVE_INTERRUPTIONS,
    user_stopped: false,
    interrupt_at: now - 60 * 60_000,
  } as Session;
}

describe('slow lane under a usage pause', () => {
  let root: string;
  const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-slow-lane-'));
    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[usage_pause]\nthreshold_percent = 95\n');
    // The credential a Claude Code turn spends is the daemon's own Anthropic
    // credential; the gate names it by its variable. The OAuth one here, so this
    // file's reading cannot collide in the process-wide tracker with another
    // file's (usage-pause-auto-react uses ANTHROPIC_API_KEY): the tracker keeps
    // the NEWEST reading per credential and would ignore this one.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-usage-pause-slow-lane';
  });

  afterAll(async () => {
    if (savedOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a held launch consumes nothing it retries from. A slow-lane
  // attempt the pause refused would spend the task's bounded attempt budget on
  // a window that was always going to reset — enough of them exhaust the task
  // for good — so the pass-over records no attempt and takes no project gap.
  test('a paused task is passed over with no attempt recorded; the hold is marked', async () => {
    const now = Date.now();
    const config = await loadConfig(root);
    const paused = { id: 'paused-task-0000-0000-000000000001', status: 'interrupted', agent_id: 'claude-code' } as Task;

    const spend = await turnSpendCredential(root, config, paused);
    expect(spend?.credential).toBe('credential:CLAUDE_CODE_OAUTH_TOKEN');
    daemonUsageLimits.observeReading({
      credential: spend!.credential,
      ts: now - 1000,
      upstream: 'https://api.anthropic.com',
      backend: 'proxy',
      status: 200,
      taskId: null,
      model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
      },
    });

    const { storage, metadata, notices } = createMockStorage([paused], new Map([[paused.id, trippedSession(now)]]));
    const dataDir = join(root, '.lazy');
    const result = await processAutoResumeQueue(storage, root, config, dataDir, now);

    expect(result.attempted).toBe(false);
    expect(await getSlowLaneState(storage, paused.id)).toEqual({ attempts: 0, lastAttemptAt: null, exhausted: false });
    const hold = JSON.parse(metadata.get(paused.id)?.get(USAGE_PAUSE_HELD_KEY) ?? 'null');
    expect(hold?.held).toBe('auto-resume');
    expect(hold?.usedPercent).toBe(97);
    // The first hold of the episode is announced for whoever is not watching.
    expect(notices.map((n) => n.title).join('\n')).toContain('paused');
  });

  // INVARIANT: a launch the DAEMON starts never spends a person's one-shot
  // override, even when it rides the explicit unblock path carrying that
  // person as its actor (a review's auto-fix carries the reviewer's). The
  // override is for the turn its setter is about to start; `daemonLaunch` makes
  // the gate judge without it. A person's own launch still uses it.
  test('the explicit gate never gives a daemon launch the override', async () => {
    const now = Date.now();
    const config = await loadConfig(root);
    const task = { id: 'gated-task-0000-0000-000000000003', status: 'blocked', agent_id: 'claude-code' } as Task;
    const spend = await turnSpendCredential(root, config, task);
    daemonUsageLimits.observeReading({
      credential: spend!.credential, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
      status: 200, taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
      },
    });
    setUsagePauseOverride(0);
    try {
      await expect(
        assertTurnStartAllowed(root, { task, config, actor: 'human', verb: 'unblock', daemonLaunch: true }),
      ).rejects.toThrow(/paused/);
      expect(getUsagePauseOverride()).toBe(0);

      await assertTurnStartAllowed(root, { task, config, actor: 'human', verb: 'unblock' });
      expect(getUsagePauseOverride()).toBeNull();
    } finally {
      setUsagePauseOverride(null);
    }
  });

  // The contrast that makes the test above mean something: the same queue, with
  // a task whose harness has no usage signal, does make (and record) an attempt.
  test('an unpaused task in the same queue is attempted and recorded', async () => {
    const now = Date.now();
    const config = await loadConfig(root);
    const other = { id: 'cursor-task-0000-0000-000000000002', status: 'interrupted', agent_id: 'cursor' } as Task;
    const { storage } = createMockStorage([other], new Map([[other.id, trippedSession(now)]]));
    const dataDir = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-slow-lane-gap-'));
    try {
      const result = await processAutoResumeQueue(storage, root, config, dataDir, now);
      expect(result.attempted).toBe(true);
      expect((await getSlowLaneState(storage, other.id)).attempts).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
