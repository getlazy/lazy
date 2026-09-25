/**
 * [usage_pause] hardening: the pause must not silently do nothing, and must not
 * be talked around.
 *
 *  - Readings are durable: written through to Storage and seeded back from it,
 *    so a restart after the bounded audit log rotated away still pauses.
 *  - "Armed, NO READING" is an answer of its own (`usagePauseCoverage`), never
 *    indistinguishable from "not paused".
 *  - The one-shot override is the HUMAN's: the builder, agents and unattributed
 *    calls never take it, and their refusals never name the command.
 *
 * Runs the REAL gate against a project root whose lazy.toml sets a threshold,
 * with readings fed into the daemon's in-process tracker. No module mocks.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertBesideLaunchAllowed,
  besideSpendCredential,
  getUsagePauseOverride,
  mayUseUsagePauseOverride,
  resetUsagePauseStateForTest,
  setUsagePauseOverride,
  usagePauseCoverage,
  usagePauseForSpend,
  daemonBesideLaunchPaused,
  describeUsagePauseState,
  type UsagePauseState,
} from '../../src/daemon/usage-pause';
import { describeOverage } from '../../src/usage-pause/policy';
import { usagePauseBannerHtml } from '../../src/server/usage-pause-banner';
import {
  flushUsageReadingWrites,
  installUsageReadingStore,
  resetUsageReadingsForTest,
  seedUsageReadings,
  type UsageReadingStore,
} from '../../src/daemon/usage-readings';
import { RpcError } from '../../src/daemon/rpc-error';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { loadConfig } from '../../src/config/loader';
import { FileStorage } from '../../src/storage/file-storage';
import type { ProxyAuditRecord, StoredUsageLimitReading } from '../../src/storage/types';
import { mergeUsageLimitReading } from '../../src/storage/usage-limit-readings';
import { STORAGE_METHODS } from '../../src/daemon/rpc-handlers';
import { RemoteStorage } from '../../src/storage/remote-storage';
import { processUsagePauseHolds } from '../../src/daemon/usage-pause';
import { USAGE_PAUSE_PENDING_START_KEY } from '../../src/usage-pause/hold';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';

const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-hardening-'));
  await mkdir(join(root, '.lazy'), { recursive: true });
  await writeFile(join(root, 'lazy.toml'), '[usage_pause]\nthreshold_percent = 95\n');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-usage-pause-hardening';
});

afterAll(async () => {
  if (savedOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetUsageReadingsForTest();
  resetUsagePauseStateForTest();
});
afterEach(() => {
  resetUsageReadingsForTest();
  resetUsagePauseStateForTest();
});

async function builderCredential(): Promise<string> {
  const spend = await besideSpendCredential(root, await loadConfig(root), null);
  expect(spend?.harness).toBe('claude-code');
  return spend!.credential;
}

function pausedReading(credential: string, now = Date.now()): StoredUsageLimitReading {
  return {
    credential, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
    status: 200, taskId: null, model: null,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.97',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
    },
  };
}

/** A proxied request billed to `credential` whose response carried no usage headers. */
function spendWithoutHeaders(credential: string, ts = Date.now()): ProxyAuditRecord {
  return {
    id: 'r', seq: 1, ts, role: 'agent', taskId: null, backend: 'proxy', upstream: 'https://api.anthropic.com',
    method: 'POST', path: '/v1/messages', endpoint: 'messages', model: null, tier: null, stream: null,
    requestShape: null, toolUses: [], toolResults: [], status: 200, usage: null, stopReason: null,
    error: null, durationMs: 1, reroute: null, enforcement: null, credential,
  } as ProxyAuditRecord;
}

/** An in-memory store applying the same merge rule every backend applies. */
function memoryStore(): UsageReadingStore & { rows: StoredUsageLimitReading[] } {
  const rows: StoredUsageLimitReading[] = [];
  return {
    rows,
    async getUsageLimitReadings() { return rows.map((r) => ({ ...r })); },
    async saveUsageLimitReading(r) {
      const i = rows.findIndex((x) => x.credential === r.credential);
      const merged = mergeUsageLimitReading(i >= 0 ? rows[i] : undefined, r);
      if (!merged) return;
      if (i >= 0) rows.splice(i, 1);
      rows.push(merged);
    },
  };
}

describe('readings survive a restart', () => {
  // INVARIANT: the latest reading per credential is written through to
  // Storage and seeded back from it — with the audit log EMPTY. A paused
  // credential sends no traffic, so during a long pause its reading is exactly
  // what rotates out of the bounded audit log; seeded from the log alone, a
  // restart (a `lazy upgrade`) found "no reading" and let turns start at 97%.
  test('a paused reading written before a restart still pauses after it, with no audit log', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const store = memoryStore();
    installUsageReadingStore(async () => store);
    daemonUsageLimits.observeReading(pausedReading(credential));
    await flushUsageReadingWrites();
    expect(store.rows.map((r) => r.credential)).toEqual([credential]);

    // The restart: the daemon's memory is gone, the audit log is empty.
    resetUsageReadingsForTest();
    installUsageReadingStore(async () => store);
    expect(daemonUsageLimits.readings()).toHaveLength(0);
    const spend = await besideSpendCredential(root, config, null);
    const pause = await usagePauseForSpend(root, config, spend);
    expect(pause?.verdict.usedPercent).toBe(97);
  });

  // INVARIANT: a late write never rolls a credential back to an older reading
  // — in the store as in memory.
  test('FileStorage keeps the newer reading per credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-store-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      const newer = pausedReading('credential:X', 2_000);
      await storage.saveUsageLimitReading(newer);
      await storage.saveUsageLimitReading({ ...pausedReading('credential:X', 1_000), headers: { 'retry-after': '1' } });
      await storage.saveUsageLimitReading(pausedReading('credential:Y', 1_500));
      const got = await storage.getUsageLimitReadings();
      expect(got.find((r) => r.credential === 'credential:X')).toEqual(newer);
      expect(got.map((r) => r.credential).sort()).toEqual(['credential:X', 'credential:Y']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('armed, no reading', () => {
  // INVARIANT: pausing ARMED for a credential lazy is spending, with no usable
  // subscription reading for it, is its own answer — `none` — and is durable
  // across a restart. Without it the gate's "no verdict" read as "not paused"
  // and the feature silently did nothing.
  test('a credential that spent turns with no usage headers is `none`; a reading makes it `reading`', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const store = memoryStore();
    installUsageReadingStore(async () => store);

    expect(await usagePauseCoverage(root, config)).toEqual([]); // nothing spent yet: nothing to warn about
    daemonUsageLimits.observe(spendWithoutHeaders(credential));
    const armed = await usagePauseCoverage(root, config);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ credential, coverage: 'none', readingAt: null });

    // Durable: after a restart with no audit log it is still `none`, not gone.
    await flushUsageReadingWrites();
    resetUsageReadingsForTest();
    installUsageReadingStore(async () => store);
    expect((await usagePauseCoverage(root, config))[0]).toMatchObject({ credential, coverage: 'none' });

    daemonUsageLimits.observeReading({ ...pausedReading(credential), headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.40',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    } });
    expect((await usagePauseCoverage(root, config))[0]).toMatchObject({ credential, coverage: 'reading' });
  });

  test('pausing off: nothing is armed', async () => {
    const off = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-off-'));
    try {
      await mkdir(join(off, '.lazy'), { recursive: true });
      await writeFile(join(off, 'lazy.toml'), '');
      daemonUsageLimits.observe(spendWithoutHeaders(await builderCredential()));
      expect(await usagePauseCoverage(off, await loadConfig(off))).toEqual([]);
    } finally {
      await rm(off, { recursive: true, force: true });
    }
  });
});

describe('the override is the human\'s', () => {
  // INVARIANT: only the `human` channel may set or take the one-shot override.
  // The builder, an agent and a call that names no channel are all models or
  // unknowns that could read a refusal and act on it; letting them use it made
  // the pause a suggestion. Their refusals never name the command either.
  test('the builder, an agent and an unattributed call are refused and leave the override pending', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    daemonUsageLimits.observeReading(pausedReading(credential));
    setUsagePauseOverride(0);

    for (const actor of ['builder', 'agent', undefined] as const) {
      const refusal = await assertBesideLaunchAllowed(root, { config, actor, what: 'a one-shot model run' })
        .then(() => null, (err: unknown) => err);
      expect(refusal).toBeInstanceOf(RpcError);
      expect((refusal as RpcError).status).toBe(429);
      expect((refusal as RpcError).message).toContain('paused');
      expect((refusal as RpcError).message).not.toContain('usage_pause_threshold');
      expect((refusal as RpcError).message).not.toContain('daemon config');
      expect(getUsagePauseOverride()).toBe(0);
    }

    const human = await assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a one-shot model run' })
      .then(() => null, (err: unknown) => err);
    expect(human).toBeNull();
    expect(getUsagePauseOverride()).toBeNull();
    // …and the next person's refusal does name the command.
    const next = await assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a one-shot model run' })
      .then(() => null, (err: unknown) => err);
    expect((next as RpcError).message).toContain('lazy daemon config set usage_pause_threshold off');
  });

  test('only the human channel may set it', () => {
    expect(mayUseUsagePauseOverride('human')).toBe(true);
    expect(mayUseUsagePauseOverride({ role: 'human', email: 'a@b.co' })).toBe(true);
    expect(mayUseUsagePauseOverride('builder')).toBe(false);
    expect(mayUseUsagePauseOverride('agent')).toBe(false);
    expect(mayUseUsagePauseOverride(undefined)).toBe(false);
  });
});

describe('seeding', () => {
  // A reading seeded from Storage is never written back as a new one.
  test('a seeded reading is not re-written to the store', async () => {
    const credential = await builderCredential();
    const store = memoryStore();
    const saved = pausedReading(credential, Date.now() - 5_000);
    store.rows.push(saved);
    let writes = 0;
    installUsageReadingStore(async () => ({
      getUsageLimitReadings: () => store.getUsageLimitReadings(),
      saveUsageLimitReading: async (r) => { writes++; await store.saveUsageLimitReading(r); },
    }));
    await seedUsageReadings(root, await loadConfig(root));
    await flushUsageReadingWrites();
    expect(daemonUsageLimits.readings().map((r) => r.credential)).toContain(credential);
    expect(writes).toBe(0);
  });
});

describe('a spend mark never replaces a reading', () => {
  const T0 = Date.now() - 60_000;
  const T1 = Date.now() - 1_000;
  const spendMark = (credential: string, ts: number): StoredUsageLimitReading => ({
    credential, ts, upstream: 'https://api.anthropic.com', backend: 'proxy',
    status: 200, taskId: null, model: null, headers: {},
  });

  // INVARIANT: a header-less "spent" record never replaces a stored reading,
  // however much newer it is — it only moves `spentAt`. Otherwise one
  // header-less request after a 97% reading erased it from the store, and the
  // next restart let turns start.
  test('through FileStorage: a reading at T0 and a spend mark at T1 > T0 still pauses after a restart', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-spend-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      await storage.saveUsageLimitReading(pausedReading(credential, T0));
      await storage.saveUsageLimitReading(spendMark(credential, T1));
      const [stored] = await storage.getUsageLimitReadings();
      expect(stored!.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.97');
      expect(stored!.ts).toBe(T0);
      expect(stored!.spentAt).toBe(T1);

      // The restart, audit log empty: seeded from the store, still paused.
      installUsageReadingStore(async () => storage);
      const pause = await usagePauseForSpend(root, config, await besideSpendCredential(root, config, null));
      expect(pause?.verdict.usedPercent).toBe(97);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('through the tracker seed: a spend mark after the reading, in either order, leaves it pausing', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const spend = await besideSpendCredential(root, config, null);
    for (const stored of [
      [pausedReading(credential, T0), spendMark(credential, T1)],
      [spendMark(credential, T1), pausedReading(credential, T0)],
    ]) {
      resetUsageReadingsForTest();
      daemonUsageLimits.seed(stored);
      expect((await usagePauseForSpend(root, config, spend))?.verdict.usedPercent).toBe(97);
      expect(daemonUsageLimits.spentCredentials().get(credential)).toBe(T1);
    }
  });

  // INVARIANT: a fresh daemon finishes the Storage seed before it judges a
  // "spent, no reading" mark or writes anything. Its memory is empty until
  // then, so the first header-less request used to look like "no reading" and
  // its mark was written over the stored reading.
  test('a header-less request racing the seed of a fresh daemon writes nothing over the reading', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    // A NAIVE store (last write wins, no merge rule), so this test proves the
    // ORDERING on its own, independent of the store's merge rule above.
    const rows: StoredUsageLimitReading[] = [pausedReading(credential, T0)];
    const store: UsageReadingStore & { rows: StoredUsageLimitReading[] } = {
      rows,
      async getUsageLimitReadings() { return rows.map((r) => ({ ...r })); },
      async saveUsageLimitReading(r) { rows.splice(0, rows.length, ...rows.filter((x) => x.credential !== r.credential), r); },
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    installUsageReadingStore(async () => {
      await gate; // storage is still initialising
      return store;
    });
    daemonUsageLimits.observe(spendWithoutHeaders(credential, T1));
    release();
    await flushUsageReadingWrites();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.97');
    expect((await usagePauseForSpend(root, config, await besideSpendCredential(root, config, null)))?.verdict.usedPercent)
      .toBe(97);
  });

  // INVARIANT: the store keeps the NEWER record per credential, so a record
  // dated in the future would pin a credential's state until then — refused.
  test('a record from the future, or of the wrong shape, is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-valid-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      await expect(storage.saveUsageLimitReading(pausedReading('credential:X', Date.now() + 24 * 3600_000)))
        .rejects.toThrow(/in the future/);
      await expect(storage.saveUsageLimitReading({ ...pausedReading('credential:X'), credential: 'nonsense' }))
        .rejects.toThrow(/credential/);
      await expect(storage.saveUsageLimitReading({ ...pausedReading('credential:X'), headers: { a: 1 as unknown as string } }))
        .rejects.toThrow(/header/);
      expect(await storage.getUsageLimitReadings()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('usage readings are daemon-local', () => {
  // INVARIANT: no caller reaches the stored readings through the storage RPC.
  // A reading decides whether turns may spend a credential, so a member (or
  // anything holding a storage-proxy token) that could write one could lift a
  // pause; and the list names every member's credential.
  test('the storage RPC does not carry them, and RemoteStorage refuses them', async () => {
    expect('saveUsageLimitReading' in STORAGE_METHODS).toBe(false);
    expect('getUsageLimitReadings' in STORAGE_METHODS).toBe(false);
    const remote = new RemoteStorage({} as never, root, join(root, '.lazy'));
    await expect(remote.saveUsageLimitReading(pausedReading('credential:X'))).rejects.toThrow(/not available/);
    await expect(remote.getUsageLimitReadings()).rejects.toThrow(/not available/);
  });
});

describe('a held start under a stopped parent', () => {
  // INVARIANT: a subtask start the usage pause held is never launched while
  // its parent is STOPPED — `lazy stop` means "run nothing of this without me".
  // It stays held (not dropped), and goes ahead once the stop lifts.
  test('stays held while the parent is user_stopped, launches once it is not', async () => {
    const parent = { id: 'parent-1', status: 'blocked', goal: 'p', metadata: {} } as unknown as Task;
    const child = {
      id: 'child-1', status: 'backlog', goal: 'c', target: { kind: 'task', parentTaskId: 'parent-1' },
      metadata: { [USAGE_PAUSE_PENDING_START_KEY]: JSON.stringify({ requestedAt: 1, params: {} }) },
    } as unknown as Task;
    let stopped = true;
    const storage = {
      listTasks: async () => [parent, child],
      getTask: async (id: string) => (id === parent.id ? parent : child),
      getSessionByTaskId: async (id: string) => (id === parent.id ? { id: 's', user_stopped: stopped } : null),
      updateTaskMetadata: async (_id: string, key: string, value: string) => {
        (child.metadata as Record<string, string>)[key] = value;
      },
      getTaskMetadata: async () => null,
    } as unknown as Storage;
    const launched: string[] = [];
    const resume = async (t: Task) => { launched.push(t.id); return 'started' as const; };

    await processUsagePauseHolds(root, storage, undefined, resume);
    expect(launched).toEqual([]);
    expect(child.metadata?.[USAGE_PAUSE_PENDING_START_KEY]).toBeTruthy();

    stopped = false;
    await processUsagePauseHolds(root, storage, undefined, resume);
    expect(launched).toEqual(['child-1']);
  });
});

describe('credential labels with spaces', () => {
  // INVARIANT: a credential key is its prefix plus ANY non-empty label lazy
  // chose — labels are free text, and the Codex subscription's is
  // `credential:ChatGPT subscription`. A key check that refused a space meant
  // Codex readings were never stored, so no Codex pause survived a restart.
  test('a reading for `credential:ChatGPT subscription` is stored and seeded back after a restart', async () => {
    const credential = 'credential:ChatGPT subscription';
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-label-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      installUsageReadingStore(async () => storage);
      daemonUsageLimits.observeReading({
        credential, ts: Date.now(), upstream: 'https://chatgpt.com', backend: 'proxy',
        status: 200, taskId: null, model: null,
        headers: { 'x-codex-primary-used-percent': '97', 'x-codex-primary-reset-after-seconds': '3600' },
      });
      await flushUsageReadingWrites();
      expect((await storage.getUsageLimitReadings()).map((r) => r.credential)).toEqual([credential]);

      resetUsageReadingsForTest();
      installUsageReadingStore(async () => storage);
      await seedUsageReadings(root, await loadConfig(root));
      const seeded = daemonUsageLimits.readings().find((r) => r.credential === credential);
      expect(seeded?.windows.find((w) => w.name === 'codex-primary')?.usedPercent).toBe(97);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a key with a control character, or nothing after the prefix, is still refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-label-bad-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      await expect(storage.saveUsageLimitReading(pausedReading('credential:a\nb'))).rejects.toThrow(/credential/);
      await expect(storage.saveUsageLimitReading(pausedReading('credential:'))).rejects.toThrow(/credential/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('waking the parent of a held start', () => {
  // INVARIANT: once the daemon launches a held subtask start, its parked
  // CLUSTER parent is woken ONCE — unless somebody STOPPED it, when the news is
  // written as a comment and nothing launches. The driver was told to end its
  // turn instead of polling on the paused credential; this is what brings it
  // back. An ordinary parent is never woken (it may be parked on a blocking
  // raise or a final claim, which a daemon unblock walks past): it gets the
  // comment too.
  function parentFixture(stopped: boolean, type: string = 'cluster', status: string = 'blocked') {
    const parent = {
      id: 'parent-1', status, goal: 'p', type,
      metadata: { usage_pause_wake_parent: JSON.stringify({ children: ['child-1'] }) },
    } as unknown as Task;
    const child = { id: 'child-1', code: 'the-child', status: 'working', goal: 'c', metadata: {} } as unknown as Task;
    const comments: string[] = [];
    const storage = {
      listTasks: async () => [parent, child],
      getTask: async (id: string) => (id === parent.id ? parent : child),
      getSessionByTaskId: async (id: string) => (id === parent.id ? { id: 's', user_stopped: stopped } : null),
      updateTaskMetadata: async (id: string, key: string, value: string) => {
        ((id === parent.id ? parent : child).metadata as Record<string, string>)[key] = value;
      },
      getTaskMetadata: async () => null,
      createComment: async (_id: string, content: string) => { comments.push(content); },
    } as unknown as Storage;
    return { parent, storage, comments };
  }

  test('a parked parent is woken once, naming the started child', async () => {
    const { parent, storage } = parentFixture(false);
    const woken: string[] = [];
    await processUsagePauseHolds(root, storage, undefined, undefined, async (p, message) => {
      woken.push(`${p.id}: ${message}`);
      return true;
    });
    expect(woken).toHaveLength(1);
    expect(woken[0]).toContain('the-child');
    expect(parent.metadata?.usage_pause_wake_parent).toBe('');
  });

  test('a stopped parent is not woken: the news goes on it as a comment', async () => {
    const { parent, storage, comments } = parentFixture(true);
    const woken: string[] = [];
    await processUsagePauseHolds(root, storage, undefined, undefined, async (p) => { woken.push(p.id); return true; });
    expect(woken).toEqual([]);
    expect(comments.join('\n')).toContain('the-child');
    expect(parent.metadata?.usage_pause_wake_parent).toBe('');
  });

  test('an ordinary (non-cluster) parent is not woken: the news goes on it as a comment', async () => {
    const { parent, storage, comments } = parentFixture(false, 'task');
    const woken: string[] = [];
    await processUsagePauseHolds(root, storage, undefined, undefined, async (p) => { woken.push(p.id); return true; });
    expect(woken).toEqual([]);
    expect(comments.join('\n')).toContain('[Held subtask starts launched] ');
    expect(comments.join('\n')).toContain('the-child');
    expect(parent.metadata?.usage_pause_wake_parent).toBe('');
  });

  // INVARIANT: the wake mark outlives a parent that has not parked yet. The
  // held-start answer told the driver to end its turn because lazy will wake
  // it; if the child launched while the driver was still working, clearing the
  // mark then left it to park `blocked` with nothing to wake it — a stranded
  // cluster that costs a hand-unblock.
  test('a parent still working when its child launches keeps the mark, and is woken once it parks', async () => {
    const { parent, storage } = parentFixture(false, 'cluster', 'working');
    const woken: string[] = [];
    const wake = async (p: Task) => { woken.push(p.id); return true; };
    await processUsagePauseHolds(root, storage, undefined, undefined, wake);
    expect(woken).toEqual([]);
    expect(parent.metadata?.usage_pause_wake_parent).toContain('child-1');

    (parent as { status: string }).status = 'interrupted';
    await processUsagePauseHolds(root, storage, undefined, undefined, wake);
    expect(woken).toEqual([]);
    expect(parent.metadata?.usage_pause_wake_parent).toContain('child-1');

    (parent as { status: string }).status = 'blocked';
    await processUsagePauseHolds(root, storage, undefined, undefined, wake);
    await processUsagePauseHolds(root, storage, undefined, undefined, wake);
    expect(woken).toEqual(['parent-1']);
    expect(parent.metadata?.usage_pause_wake_parent).toBe('');
  });

  test('an ordinary parent still working gets its note at once; a finished parent just drops the mark', async () => {
    const working = parentFixture(false, 'task', 'working');
    await processUsagePauseHolds(root, working.storage, undefined, undefined, async () => true);
    expect(working.comments.join('\n')).toContain('the-child');
    expect(working.parent.metadata?.usage_pause_wake_parent).toBe('');

    const finished = parentFixture(false, 'cluster', 'complete');
    const woken: string[] = [];
    await processUsagePauseHolds(root, finished.storage, undefined, undefined, async (p) => { woken.push(p.id); return true; });
    expect(woken).toEqual([]);
    expect(finished.comments).toEqual([]);
    expect(finished.parent.metadata?.usage_pause_wake_parent).toBe('');
  });

  test('a wake the launch refuses (held, budget) keeps the mark for the next pass', async () => {
    const { parent, storage } = parentFixture(false);
    await processUsagePauseHolds(root, storage, undefined, undefined, async () => false);
    expect(parent.metadata?.usage_pause_wake_parent).toContain('child-1');
  });
});

describe('the dashboard web Pair and Chat', () => {
  // INVARIANT: the web Pair and Chat terminals spend the TASK's credential like
  // a turn, and the person at the page is the human channel — a paused
  // credential refuses them (429) before any lock or status change, and the
  // one-shot override is taken only after the page's own refusals, so a
  // session the page refuses anyway never spends it.
  async function pausedTask(status = 'blocked') {
    const { planPairOrChatExec, resetWebPairStateForTests } = await import('../../src/server/shell-pair');
    const { turnSpendCredential } = await import('../../src/daemon/usage-pause');
    const { getWorktreePath } = await import('../../src/task/identity');
    resetWebPairStateForTests();
    const task = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001', code: 'web-paused', status, goal: 'g',
      agent_id: 'claude-code', metadata: {}, target: { kind: 'branch', branch: 'main' },
    } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    const config = await loadConfig(root);
    const spend = await turnSpendCredential(root, config, task);
    daemonUsageLimits.observeReading(pausedReading(spend!.credential));
    const writes: string[] = [];
    const storage = new Proxy({}, {
      get: (_t, name) => async () => { writes.push(String(name)); return null; },
    }) as unknown as Storage;
    const session = { id: 's', runner_type: 'docker', agent_session_id: 'x' } as never;
    return { plan: (mode: 'pair' | 'chat') => planPairOrChatExec({ root, storage, task, session, mode }), writes };
  }

  test('a paused credential refuses web Pair and Chat with a 429, writing nothing', async () => {
    const { plan, writes } = await pausedTask();
    for (const mode of ['pair', 'chat'] as const) {
      const result = await plan(mode);
      expect(result.ok).toBe(false);
      expect((result as { status: number }).status).toBe(429);
      expect((result as { message: string }).message).toContain('paused');
    }
    expect(writes.filter((w) => w.startsWith('update'))).toEqual([]);
  });

  test('a web chat the page refuses on its own terms leaves the override pending', async () => {
    const { plan } = await pausedTask('working');
    setUsagePauseOverride(0);
    const result = await plan('chat');
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(409);
    expect(getUsagePauseOverride()).toBe(0);
  });
});

describe('a corrupt readings file', () => {
  // INVARIANT: a readings file that exists but cannot be read is an ERROR,
  // never "no readings" — that answer let turns start on a paused credential,
  // and the next save overwrote the file with one record. Only a missing file
  // is empty; a corrupt one is refused on read and never overwritten. One
  // record dated in the future (the clock moved) is read as taken NOW, never
  // dropped; one record that is otherwise invalid makes the whole file
  // unreadable, exactly like a corrupt file.
  async function store() {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-corrupt-'));
    await mkdir(join(dir, '.lazy'), { recursive: true });
    const storage = new FileStorage(dir);
    await storage.saveUsageLimitReading(pausedReading('credential:A', Date.now() - 1000));
    return { dir, storage };
  }
  async function readingsPath(dir: string): Promise<string> {
    const { readdir } = await import('fs/promises');
    const { join: j } = await import('path');
    // The file sits in the store's base path, under a name FileStorage owns.
    const find = async (d: string): Promise<string | null> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = j(d, e.name);
        if (e.isFile() && e.name === 'usage-limit-readings.json') return p;
        if (e.isDirectory()) { const f = await find(p); if (f) return f; }
      }
      return null;
    };
    return (await find(dir))!;
  }

  test('an unparseable file throws with its path, and a save refuses to overwrite it', async () => {
    const { dir, storage } = await store();
    try {
      const path = await readingsPath(dir);
      await writeFile(path, '{ this is not json');
      await expect(storage.getUsageLimitReadings()).rejects.toThrow(path);
      await expect(storage.saveUsageLimitReading(pausedReading('credential:B'))).rejects.toThrow(path);
      expect(await (await import('fs/promises')).readFile(path, 'utf-8')).toBe('{ this is not json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing file is empty; a wrong shape throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-shape-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      expect(await storage.getUsageLimitReadings()).toEqual([]);
      await storage.saveUsageLimitReading(pausedReading('credential:A'));
      const path = await readingsPath(dir);
      await writeFile(path, JSON.stringify({ readings: 'nope' }));
      await expect(storage.getUsageLimitReadings()).rejects.toThrow(/expected/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a record with a future ts is read as taken now, kept, and replaced by the next real reading', async () => {
    const { dir, storage } = await store();
    try {
      const path = await readingsPath(dir);
      const { readFile } = await import('fs/promises');
      const file = JSON.parse(await readFile(path, 'utf-8'));
      file.readings.push({ ...pausedReading('credential:FUTURE'), ts: Date.now() + 365 * 24 * 3600_000 });
      await writeFile(path, JSON.stringify(file));
      const before = Date.now();
      const read = await storage.getUsageLimitReadings();
      expect(read.map((r) => r.credential).sort()).toEqual(['credential:A', 'credential:FUTURE']);
      const future = read.find((r) => r.credential === 'credential:FUTURE')!;
      expect(future.ts).toBeGreaterThanOrEqual(before);
      expect(future.ts).toBeLessThanOrEqual(Date.now());
      // Another credential's save leaves it exactly as it was…
      await storage.saveUsageLimitReading(pausedReading('credential:B'));
      const after = JSON.parse(await readFile(path, 'utf-8'));
      expect(after.readings.map((r: { credential: string }) => r.credential).sort())
        .toEqual(['credential:A', 'credential:B', 'credential:FUTURE']);
      // …and a real reading for it, taken a moment before the read, replaces it
      // (clamped to "now" it must not win the newer-wins rule and pin itself).
      const fresh = { ...pausedReading('credential:FUTURE', before - 1), headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.40',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      } };
      await storage.saveUsageLimitReading(fresh);
      const replaced = (await storage.getUsageLimitReadings()).find((r) => r.credential === 'credential:FUTURE')!;
      expect(replaced.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.40');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an otherwise invalid record makes the file unreadable, and a save refuses to overwrite it', async () => {
    const { dir, storage } = await store();
    try {
      const path = await readingsPath(dir);
      const { readFile } = await import('fs/promises');
      const file = JSON.parse(await readFile(path, 'utf-8'));
      file.readings.push({ ...pausedReading('credential:BAD'), headers: { a: 1 } });
      const text = JSON.stringify(file);
      await writeFile(path, text);
      await expect(storage.getUsageLimitReadings()).rejects.toThrow(path);
      await expect(storage.saveUsageLimitReading(pausedReading('credential:B'))).rejects.toThrow(path);
      expect(await readFile(path, 'utf-8')).toBe(text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('armed, no reading — only for spend a usage source can read', () => {
  // INVARIANT: "armed, NO READING" counts only spend on an upstream a harness
  // WITH a usage source uses. A team member who only spends on cursor (or a
  // local model) has nothing pausing could ever read there, and flagging them
  // was a false alarm that trains people to ignore the real one.
  test('a member who spent only through cursor is not flagged; one who spent on the Claude upstream is', async () => {
    const { pinDaemonBaseDir } = await import('../helpers/daemon-base-dir');
    const { putUserCredential, clearUserCredentialCache } = await import('../../src/daemon/user-credentials');
    const base = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-team-'));
    const unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    try {
      await putUserCredential(root, { userId: 'ada@example.com', kind: 'api-key', token: 'sk-ant-api-ada-usage' });
      const config = await loadConfig(root);
      const cursorOnly = 'user:cursor@example.com';
      const claude = 'user:claude@example.com';
      daemonUsageLimits.observe({
        ...spendWithoutHeaders(cursorOnly), credential: null, userId: 'cursor@example.com',
        backend: 'cursor', upstream: config.proxy.cursorUpstream,
      } as ProxyAuditRecord);
      daemonUsageLimits.observe({
        ...spendWithoutHeaders(claude), credential: null, userId: 'claude@example.com',
        upstream: config.proxy.upstream,
      } as ProxyAuditRecord);
      const flagged = (await usagePauseCoverage(root, config)).map((c) => c.credential);
      expect(flagged).toContain(claude);
      expect(flagged).not.toContain(cursorOnly);
    } finally {
      unpin();
      clearUserCredentialCache();
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('no daemon to ask', () => {
  // INVARIANT: with the RPC bypassed (the in-process harness, or the daemon
  // itself), `lazy pair` / `lazy chat` admission is still JUDGED in-process —
  // never admitted unjudged because there was no daemon to answer.
  test('the in-process fallback refuses an interactive session on a paused credential', async () => {
    const { queryUsagePause } = await import('../../src/daemon/rpc-fallback');
    const { spawnSync } = await import('child_process');
    const project = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-fallback-'));
    const savedCwd = process.cwd();
    const savedTest = process.env.LAZY_TEST;
    try {
      spawnSync('git', ['init', '-q'], { cwd: project });
      await mkdir(join(project, '.lazy'), { recursive: true });
      await writeFile(
        join(project, 'lazy.toml'),
        `[usage_pause]\nthreshold_percent = 95\n\n[storage]\nbackend = "external"\nexternal_path = "${join(project, 'store')}"\n`,
      );
      const spend = await besideSpendCredential(project, await loadConfig(project), null);
      daemonUsageLimits.observeReading(pausedReading(spend!.credential));
      process.chdir(project);
      process.env.LAZY_TEST = '1';
      const refusal = await queryUsagePause({ action: 'admitInteractive', surface: 'chat' })
        .then(() => null, (err: unknown) => err);
      expect(refusal).toBeInstanceOf(RpcError);
      expect((refusal as RpcError).code).toBe('usage_paused');
    } finally {
      process.chdir(savedCwd);
      if (savedTest === undefined) delete process.env.LAZY_TEST; else process.env.LAZY_TEST = savedTest;
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe('the real Claude header set (captured 2026-09-24)', () => {
  // The exact usage headers a real Claude subscription response carried through
  // the proxy. The two reset times not recorded in the capture (7d, overall)
  // are filled with plausible epoch seconds; everything else is verbatim.
  const RESET_5H = 1790227200;
  const CAPTURED: Record<string, string> = {
    'anthropic-ratelimit-unified-5h-utilization': '0.16',
    'anthropic-ratelimit-unified-5h-reset': String(RESET_5H),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.46',
    'anthropic-ratelimit-unified-7d-reset': String(RESET_5H + 4 * 86_400),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(RESET_5H),
    'anthropic-ratelimit-unified-fallback-percentage': '0.5',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled_until',
  };
  const NOW = (RESET_5H - 3600) * 1000; // an hour before the 5-hour window resets

  function captured(credential: string, headers = CAPTURED): ProxyAuditRecord {
    return { ...spendWithoutHeaders(credential, NOW), usageLimitHeaders: headers } as ProxyAuditRecord;
  }

  // INVARIANT: the real header set is a READING at 16% / 46%: it neither
  // pauses at a 95% threshold nor reads as "armed, NO READING". The overage
  // headers are informational and never a pause input. A parser that missed
  // any of this would either stop a team at 16% or silently never engage.
  test('reads as 16% and 46%, is a reading, pauses nothing, and reports overage off with its reason', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    daemonUsageLimits.observe(captured(credential));

    const reading = daemonUsageLimits.readings().find((r) => r.credential === credential)!;
    const windows = Object.fromEntries(reading.windows.map((w) => [w.name, w]));
    expect(windows['unified-5h']).toMatchObject({ usedPercent: 16, status: 'allowed' });
    expect(windows['unified-7d']).toMatchObject({ usedPercent: 46, status: 'allowed' });
    expect(windows['unified']).toMatchObject({ usedPercent: null, status: 'allowed' });

    const spend = await besideSpendCredential(root, config, null);
    expect(await usagePauseForSpend(root, config, spend, undefined, NOW)).toBeNull();

    const coverage = await usagePauseCoverage(root, config, NOW);
    expect(coverage).toEqual([expect.objectContaining({
      credential, coverage: 'reading',
      overage: { status: 'rejected', reason: 'org_level_disabled_until' },
    })]);
    expect(describeOverage(credential, coverage[0].overage!)).toBe(
      `${credential}: overage is off (org_level_disabled_until) — the provider stops at the limit itself.`,
    );
    expect(usagePauseBannerHtml({ ...emptyState(), coverage })).toContain('overage off');
  });

  // INVARIANT: overage ALLOWED is said plainly and changes nothing about
  // pausing — the pause is what keeps that credential under, not a reason to
  // pause sooner.
  test('overage allowed is said on every surface and still pauses nothing at 16%', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const headers: Record<string, string> = { ...CAPTURED, 'anthropic-ratelimit-unified-overage-status': 'allowed' };
    delete headers['anthropic-ratelimit-unified-overage-disabled-reason'];
    daemonUsageLimits.observe(captured(credential, headers));

    const spend = await besideSpendCredential(root, config, null);
    expect(await usagePauseForSpend(root, config, spend, undefined, NOW)).toBeNull();
    const coverage = await usagePauseCoverage(root, config, NOW);
    expect(coverage[0]).toMatchObject({ coverage: 'reading', overage: { status: 'allowed', reason: null } });
    const line = describeOverage(credential, coverage[0].overage!);
    expect(line).toBe(`${credential}: overages ENABLED on this credential: the pause is what keeps you under.`);
    expect(usagePauseBannerHtml({ ...emptyState(), coverage })).toContain('overages ENABLED on this credential');
  });

  // INVARIANT: an overall `unified-status: rejected` pauses like a window's
  // `rejected` does — the provider is already refusing on that credential.
  test('an overall rejected status pauses', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    daemonUsageLimits.observe(captured(credential, { ...CAPTURED, 'anthropic-ratelimit-unified-status': 'rejected' }));
    const spend = await besideSpendCredential(root, config, null);
    const paused = await usagePauseForSpend(root, config, spend, undefined, NOW);
    expect(paused?.verdict).toMatchObject({ credential, window: 'unified', status: 'rejected' });
  });
});

function emptyState(): UsagePauseState {
  return {
    configured: { threshold_percent: 95, credentials: {} },
    override: null, overrideSetAt: null, coverage: [], paused: [], held: [],
  } as unknown as UsagePauseState;
}

describe('unreadable saved readings fail closed', () => {
  // INVARIANT: while the saved readings cannot be read, the gate REFUSES every
  // launch it would judge, and every surface says which file to fix. A corrupt
  // file after a restart, during a long pause, with the audit log rotated, left
  // the tracker empty: the gate said "nothing paused", doctor listed nothing,
  // and a turn started at 97%. No override lifts the refusal — a person fixes
  // the file, and the next check lets launches through again.
  test('a corrupt readings file and an empty audit log never come out as "nothing paused"', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-fail-closed-'));
    try {
      await mkdir(join(dir, '.lazy'), { recursive: true });
      const storage = new FileStorage(dir);
      // The reading a long pause depends on, saved before the restart…
      await storage.saveUsageLimitReading(pausedReading(credential));
      const { readdir, unlink } = await import('fs/promises');
      const find = async (d: string): Promise<string | null> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isFile() && e.name === 'usage-limit-readings.json') return p;
          if (e.isDirectory()) { const f = await find(p); if (f) return f; }
        }
        return null;
      };
      const path = (await find(dir))!;
      // …then corrupted. A fresh daemon (nothing in memory, no audit log) starts.
      await writeFile(path, '{ "readings": [ truncated');
      installUsageReadingStore(async () => storage);

      // Every launch the pause judges is refused, naming the file.
      const spend = await besideSpendCredential(root, config, null);
      const verdict = (await usagePauseForSpend(root, config, spend))?.verdict;
      expect(verdict?.storeError).toContain(path);
      // Not even judged at the override's threshold: `off` is 0, and 0 would mean "never pause".
      expect((await usagePauseForSpend(root, config, spend, 0))?.verdict.storeError).toContain(path);
      expect(await daemonBesideLaunchPaused(root)).not.toBeNull();

      // A person's pending override does not lift it, and is left unused.
      setUsagePauseOverride(0);
      const refused = await assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a one-shot' })
        .then(() => null, (err: unknown) => err as RpcError);
      expect(refused?.status).toBe(429);
      expect(refused?.message).toContain(`saved usage readings unreadable at ${path}`);
      expect(refused?.message).toContain('does not lift');
      expect(getUsagePauseOverride()).toBe(0);
      // An agent's refusal never points it at the override.
      const agentRefusal = await assertBesideLaunchAllowed(root, { config, actor: 'agent', what: 'a one-shot' })
        .then(() => null, (err: unknown) => err as RpcError);
      expect(agentRefusal?.message).toContain('do not retry');
      expect(agentRefusal?.message).not.toContain('lazy daemon config set');

      // Every surface says it.
      const state = await describeUsagePauseState(root, null);
      expect(state.storeError?.path).toBe(path);
      expect(usagePauseBannerHtml(state)).toContain('readings unreadable');

      // The file fixed (moved aside): the next check lets launches through.
      await unlink(path);
      await expect(assertBesideLaunchAllowed(root, { config, actor: 'agent', what: 'a one-shot' })).resolves.toBeUndefined();
      expect((await describeUsagePauseState(root, null)).storeError).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a saved reading dated in the future', () => {
  // INVARIANT: a saved reading is never dropped for being dated in the future.
  // After a clock correction (a VM resumed, the store moved between hosts) a
  // valid 97% reading used to be skipped on read with its spend mark: after a
  // restart nothing paused, nothing said "armed, NO READING", and the next
  // header-less request wrote a spend mark over it for good. It is read as
  // taken now instead; a record invalid in any OTHER way fails closed.
  async function futureStore(credential: string, mutate: (r: Record<string, unknown>) => void) {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-usage-readings-future-'));
    await mkdir(join(dir, '.lazy'), { recursive: true });
    const storage = new FileStorage(dir);
    // The reading the pause depends on: 97%, window resetting in 3 hours…
    const reading = pausedReading(credential);
    reading.headers['anthropic-ratelimit-unified-5h-reset'] = String(Math.floor(Date.now() / 1000) + 3 * 3600);
    await storage.saveUsageLimitReading(reading);
    const { readdir, readFile } = await import('fs/promises');
    const find = async (d: string): Promise<string | null> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isFile() && e.name === 'usage-limit-readings.json') return p;
        if (e.isDirectory()) { const f = await find(p); if (f) return f; }
      }
      return null;
    };
    const path = (await find(dir))!;
    // …then, on disk, the clock moves.
    const file = JSON.parse(await readFile(path, 'utf-8'));
    mutate(file.readings[0]);
    await writeFile(path, JSON.stringify(file));
    return { dir, storage, path };
  }

  test('a future-dated 97% reading, an empty audit log and a restart still pause', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const { dir, storage, path } = await futureStore(credential, (r) => {
      r.ts = Date.now() + 2 * 3600_000;
    });
    try {
      // A fresh daemon: nothing in memory, no audit log.
      installUsageReadingStore(async () => storage);
      const spend = await besideSpendCredential(root, config, null);
      expect((await usagePauseForSpend(root, config, spend))?.verdict.usedPercent).toBe(97);
      const coverage = await usagePauseCoverage(root, config);
      expect(coverage.find((c) => c.credential === credential)?.coverage).toBe('reading');

      // A header-less request does not write a spend mark over it.
      daemonUsageLimits.observe(spendWithoutHeaders(credential));
      await flushUsageReadingWrites();
      const { readFile } = await import('fs/promises');
      const kept = JSON.parse(await readFile(path, 'utf-8')).readings[0];
      expect(kept.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.97');

      // And after another restart it still pauses.
      resetUsageReadingsForTest();
      installUsageReadingStore(async () => storage);
      expect((await usagePauseForSpend(root, config, spend))?.verdict.usedPercent).toBe(97);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a stored record invalid in another way fails closed, naming the file', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    const { dir, storage, path } = await futureStore(credential, (r) => {
      r.headers = { 'anthropic-ratelimit-unified-5h-utilization': 97 };
    });
    try {
      installUsageReadingStore(async () => storage);
      const spend = await besideSpendCredential(root, config, null);
      expect((await usagePauseForSpend(root, config, spend))?.verdict.storeError).toContain(path);
      expect((await describeUsagePauseState(root, null)).storeError?.path).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the usage-limits view carries coverage and never an unreadable store', () => {
  const pauseInput = () => ({
    configured: { threshold_percent: 95, credentials: {} },
    override: null,
    paused: [],
    held: [],
    coverage: [
      { credential: 'user:alice@example.com', coverage: 'none' as const, readingAt: null, lastSpentAt: 1, overage: null },
      { credential: 'user:bob@example.com', coverage: 'none' as const, readingAt: null, lastSpentAt: 1, overage: null },
      { credential: 'credential:ANTHROPIC_API_KEY', coverage: 'none' as const, readingAt: null, lastSpentAt: 1, overage: null },
    ],
  });

  // INVARIANT: "armed, NO READING" is in the machine-readable view, scoped
  // like the readings. A credential with no reading has no entry in
  // `readings`, so without `coverage` a builder planning from
  // `lazy_usage_limits` saw it as untouched headroom; and another member's
  // entry names their account, so it is narrowed exactly as their reading is.
  test('coverage rides the view, narrowed per caller like the readings', async () => {
    const { projectUsageLimits, scopeUsageLimitsView, memberUsageLimitsView } = await import('../../src/usage-pause/limits-view');
    const view = projectUsageLimits([], pauseInput());
    expect(view.pause.coverage.map((c) => c.credential)).toHaveLength(3);
    expect(scopeUsageLimitsView(view, 'user:alice@example.com', 't1').pause.coverage.map((c) => c.credential))
      .toEqual(['user:alice@example.com']);
    expect(scopeUsageLimitsView(view, null, 't1').pause.coverage).toEqual([]);
    const member = memberUsageLimitsView(view, 'user:alice@example.com', 'user:__service__');
    expect(member.pause.coverage.map((c) => c.credential).sort())
      .toEqual(['credential:ANTHROPIC_API_KEY', 'user:alice@example.com']);
    expect(JSON.stringify(member)).not.toContain('bob@example.com');
  });

  // INVARIANT: a view is never built over unreadable saved readings — every
  // surface that builds one refuses with the same message, naming the file.
  test('an unreadable store refuses the view, naming the file', async () => {
    const { projectUsageLimits, UsageLimitsUnreadableError } = await import('../../src/usage-pause/limits-view');
    const storeError = { path: '/store/usage-limit-readings.json', message: 'not valid JSON' };
    expect(() => projectUsageLimits([], { ...pauseInput(), storeError })).toThrow(UsageLimitsUnreadableError);
    expect(() => projectUsageLimits([], { ...pauseInput(), storeError }))
      .toThrow('saved usage readings unreadable at /store/usage-limit-readings.json');
    // An older daemon's answer (no coverage, no storeError) still projects.
    const { coverage: _dropped, ...older } = pauseInput();
    expect(projectUsageLimits([], older).pause.coverage).toEqual([]);
  });
});

describe('the CLI names the override only to a person who could use it', () => {
  // INVARIANT: the CLI pre-flight and `lazy daemon config get` never name the
  // override command to a caller the daemon would not name it to. The builder
  // runs `lazy unblock` from its own shell; a hint spelling out the escape
  // hatch there undid the daemon's careful refusal.
  test('the pre-flight refusal names the command only when offered', async () => {
    const { preflightRefusalLines } = await import('../../src/cli/usage-pause-preflight');
    const verdict = {
      credential: 'credential:CLAUDE_CODE_OAUTH_TOKEN', window: 'unified-5h', usedPercent: 97, status: null,
      threshold: 95, resetsAt: Date.now() + 3_600_000, readingAt: Date.now(),
    };
    const builder = preflightRefusalLines(verdict, 'unblock', false).join('\n');
    expect(builder).toContain('cannot be unblocked right now');
    expect(builder).not.toContain('lazy daemon config set');
    expect(builder).toContain('once the window resets');
    expect(preflightRefusalLines(verdict, 'unblock', true).join('\n')).toContain('lazy daemon config set usage_pause_threshold off');
  });

  test('the builder channel is never offered it', async () => {
    const { mayOfferUsagePauseOverride } = await import('../../src/cli/human-terminal');
    const saved = process.env.LAZY_ACTOR;
    process.env.LAZY_ACTOR = 'builder';
    try {
      expect(await mayOfferUsagePauseOverride()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LAZY_ACTOR;
      else process.env.LAZY_ACTOR = saved;
    }
  });
});

describe('doctor and show name the override only to a person who could use it', () => {
  // INVARIANT: `lazy doctor` and `lazy show` never name the override command to
  // a caller the daemon would not name it to. Doctor is where every refusal
  // points (the builder's and an agent's included); and a held subtask START
  // is never released by the override, so show says it starts after the reset.
  test('doctor advice names the command only when offered', async () => {
    const { usagePauseAdvice } = await import('../../src/doctor/sweep');
    expect(usagePauseAdvice(false).join('\n')).not.toContain('usage_pause_threshold off');
    expect(usagePauseAdvice(false).join('\n')).toContain('once the window resets');
    expect(usagePauseAdvice(true).join('\n')).toContain('lazy daemon config set usage_pause_threshold off');
  });

  test('a show hold line names it only when offered, and never for a held subtask start', async () => {
    const { usagePauseHoldLines } = await import('../../src/cli/commands/show');
    const hold = {
      credential: 'credential:CLAUDE_CODE_OAUTH_TOKEN', window: 'unified-5h', usedPercent: 97, status: null,
      threshold: 95, resetsAt: Date.now() + 3_600_000, readingAt: Date.now(), held: 'auto-resume', since: Date.now(),
    };
    const text = (o: { heldStart: boolean; offerOverride: boolean }) => usagePauseHoldLines(hold, o).join('\n');
    expect(text({ heldStart: false, offerOverride: false })).not.toContain('usage_pause_threshold off');
    expect(text({ heldStart: false, offerOverride: true })).toContain('usage_pause_threshold off');
    const start = text({ heldStart: true, offerOverride: true });
    expect(start).toContain('starts by itself after the reset');
    expect(start).not.toContain('usage_pause_threshold off');
  });
});

describe('a launch takes the override only when a person asked', () => {
  // INVARIANT: the `human` channel is attribution, not proof a person asked.
  // `lazy start` / `unblock` / `resume` / `review` / `ask` / `sync` carry it from
  // any process, the builder's shell included, so the gate takes the one-shot
  // override — and names it in the refusal — only when the caller vouched
  // (`overrideEligible`); otherwise the builder spent the override a person
  // had set for another task, and was told the command.
  test('an unvouched human launch is refused without taking or naming the override', async () => {
    const credential = await builderCredential();
    const config = await loadConfig(root);
    daemonUsageLimits.observeReading(pausedReading(credential));
    setUsagePauseOverride(0);

    const refused = await assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a launch', overrideEligible: false })
      .then(() => null, (err: unknown) => err as RpcError);
    expect(refused?.status).toBe(429);
    expect(refused?.message).not.toContain('usage_pause_threshold');
    expect(getUsagePauseOverride()).toBe(0);

    await expect(assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a launch', overrideEligible: true }))
      .resolves.toBeUndefined();
    expect(getUsagePauseOverride()).toBeNull();
  });
});
