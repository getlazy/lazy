/**
 * [usage_pause] for model runs BESIDE a task — a review conversation's builder
 * turn, a link description, a model memory compact, a CLI one-shot, an ask
 * answered from a task's stored record (src/daemon/usage-pause.ts,
 * `assertBesideLaunchAllowed`).
 *
 * Runs the REAL gate: a project root whose lazy.toml sets a threshold, and a
 * reading fed into the daemon's in-process usage tracker under the credential
 * the gate resolves for the builder role. No module mocks.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  admitOneshotCommand,
  assertBesideLaunchAllowed,
  besideSpendCredential,
  oneshotAllowanceValid,
  ONESHOT_ALLOWANCE_TTL_MS,
  getUsagePauseOverride,
  setUsagePauseOverride,
} from '../../src/daemon/usage-pause';
import { RpcError } from '../../src/daemon/rpc-error';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { loadConfig } from '../../src/config/loader';
import { createWebRequestHandler } from '../../src/server/index';
import { createStorageMemoryActions } from '../../src/daemon/memory-service';
import type { Storage } from '../../src/storage';

describe('usage pause beside a task', () => {
  let root: string;
  const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-beside-'));
    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[usage_pause]\nthreshold_percent = 95\n');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-usage-pause-beside';
  });

  afterEach(() => setUsagePauseOverride(null));

  afterAll(async () => {
    if (savedOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
    await rm(root, { recursive: true, force: true });
  });

  async function pauseBuilderCredential(): Promise<void> {
    const config = await loadConfig(root);
    const spend = await besideSpendCredential(root, config, null);
    expect(spend?.harness).toBe('claude-code');
    const now = Date.now();
    daemonUsageLimits.observeReading({
      credential: spend!.credential, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
      status: 200, taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
      },
    });
  }

  // INVARIANT: a model run beside a task that a person asks for is REFUSED on
  // a paused builder credential, with the same message as a refused start and
  // a code callers can tell from a failure (`usage_paused`).
  test('a paused builder credential refuses the launch, naming what was not started', async () => {
    await pauseBuilderCredential();
    const config = await loadConfig(root);
    const refusal = await assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a memory compact with a model' })
      .then(() => null, (err: unknown) => err);
    expect(refusal).toBeInstanceOf(RpcError);
    expect((refusal as RpcError).status).toBe(429);
    expect((refusal as RpcError).code).toBe('usage_paused');
    expect((refusal as RpcError).message).toContain('A memory compact with a model was not started');
    expect((refusal as RpcError).message).toContain('97%');
    expect((refusal as RpcError).message).toContain('usage_pause_threshold off');
  });

  // INVARIANT: the one-shot override lets exactly ONE launch a person asks for
  // through — beside a task as much as a task turn — and nobody else spends it.
  test('the override is taken by a person, never by an unattributed or agent launch', async () => {
    await pauseBuilderCredential();
    const config = await loadConfig(root);
    setUsagePauseOverride(0);

    await expect(
      assertBesideLaunchAllowed(root, { config, actor: 'agent', what: 'a one-shot model run' }),
    ).rejects.toThrow(/paused/);
    await expect(
      assertBesideLaunchAllowed(root, { config, actor: undefined, what: 'a one-shot model run' }),
    ).rejects.toThrow(/paused/);
    expect(getUsagePauseOverride()).toBe(0);

    await assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a one-shot model run' });
    expect(getUsagePauseOverride()).toBeNull();
    await expect(
      assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a one-shot model run' }),
    ).rejects.toThrow(/paused/);
  });
});

describe('usage pause beside a task: one-shot commands and the dashboard compact', () => {
  let root: string;
  const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-beside-2-'));
    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[usage_pause]\nthreshold_percent = 95\n');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-usage-pause-beside';
  });

  afterEach(() => setUsagePauseOverride(null));

  afterAll(async () => {
    if (savedOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
    await rm(root, { recursive: true, force: true });
  });

  async function pause(): Promise<void> {
    const config = await loadConfig(root);
    const spend = await besideSpendCredential(root, config, null);
    const now = Date.now();
    daemonUsageLimits.observeReading({
      credential: spend!.credential, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
      status: 200, taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
      },
    });
  }

  // INVARIANT: a one-shot command of many calls (`lazy report`, an ask over a
  // long conversation) is judged ONCE. The override is taken by the admission,
  // and every call presenting its allowance goes through — so an override lets
  // the whole command finish instead of chunk 1 alone.
  test('an override lets a multi-call command finish; the calls themselves are not judged again', async () => {
    await pause();
    setUsagePauseOverride(0);
    const allowance = await admitOneshotCommand(root, 'human');
    expect(getUsagePauseOverride()).toBeNull();
    // Every chunk of the command presents it and is let through…
    for (let chunk = 0; chunk < 5; chunk++) expect(oneshotAllowanceValid(allowance)).toBe(true);
    // …while a call judged on its own, as each was before, is now refused.
    const config = await loadConfig(root);
    await expect(
      assertBesideLaunchAllowed(root, { config, actor: 'human', what: 'a one-shot model run' }),
    ).rejects.toThrow(/paused/);
    // An allowance is not a string anybody can make up, and it expires.
    expect(oneshotAllowanceValid('made-up')).toBe(false);
    expect(oneshotAllowanceValid(allowance, Date.now() + ONESHOT_ALLOWANCE_TTL_MS + 1)).toBe(false);
  });

  test('an agent\'s command is refused while paused and leaves the override alone', async () => {
    await pause();
    setUsagePauseOverride(0);
    await expect(admitOneshotCommand(root, 'agent')).rejects.toThrow(/paused/);
    expect(getUsagePauseOverride()).toBe(0);
  });

  // INVARIANT: the dashboard's compact button reaches the SAME compact path as
  // `lazy memory compact`, and a model compact is refused there on a paused
  // credential — it used to call the actions in process, past the RPC's gate.
  // A mechanical compact runs no model and is never refused.
  test('the dashboard compact route refuses a model compact while paused, and runs a mechanical one', async () => {
    await pause();
    const storage = new Proxy({}, {
      get: (_t, prop) => {
        // Not a thenable: the actions await the storage getter's result.
        if (prop === 'then') return undefined;
        if (prop === 'getMemoryCompact' || prop === 'getMemory') return async () => null;
        return async () => [];
      },
    }) as unknown as Storage;
    const handler = createWebRequestHandler(storage, undefined, {
      memoryActions: createStorageMemoryActions(async () => storage, root),
    });
    const post = (mode: string) => handler(new Request('http://localhost/memory/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mode }),
    }));

    const refused = await (await post('llm')).text();
    expect(refused).toContain('A memory compact with a model was not started');
    expect(refused).toContain('paused');

    const mechanical = await (await post('mechanical')).text();
    expect(mechanical).not.toContain('was not started');
    expect(mechanical).toContain('No memory records to compact');
  });
});
