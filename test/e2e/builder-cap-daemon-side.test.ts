/**
 * INVARIANT: `max_concurrent_builders` is enforced by the DAEMON, not by the
 * CLI that happens to launch builders today.
 *
 * The cap used to be a comparison inside `lazy builder`
 * (`src/cli/commands/builder.ts`), so it bound exactly one launcher: anything
 * else that spawned a builder container — a web UI, a script, a second copy of
 * the CLI — walked straight past it. Found during spike-ui-builder-conversations
 * (docs/spikes/ui-builder-conversations.md §2.4).
 *
 * Every test here therefore talks to the daemon DIRECTLY over its TCP port
 * and never runs `lazy builder` at all — that is the whole point. If the CLI's
 * friendly pre-check were the only gate, every assertion below would fail.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { resetConcurrencyStateForTest } from '../../src/daemon/concurrency';

const TOKEN = 'test-token-builder-cap';

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('builder concurrency cap is enforced daemon-side', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    // Daemonless project + an in-process daemon, as in mcp-route-status: the
    // handlers run in this process, which is also what lets us reset the
    // daemon's in-memory slot state between tests.
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    // This daemon starts in-process, so loadConfig would otherwise walk up from
    // `bun test`'s cwd (lazy's own worktree) and adopt lazy's real storage path.
    restoreConfig = pinConfig(ctx.root);
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    resetConcurrencyStateForTest();
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    resetConcurrencyStateForTest();
    restoreConfig?.();
    restoreConfig = undefined;
    // Reap the daemon FIRST: cleanup resolves its pidfile through
    // LAZY_DAEMON_BASE_DIR, so unpinning before this looks under the default
    // base dir and leaves the daemon running.
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  /** POST an RPC on the daemon's TCP port — no CLI in the path. */
  async function rpc(command: string, params: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/${command}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify(params),
    });
    return { status: resp.status, body: await resp.json() };
  }

  const admit = (builderId: string) => rpc('builderSlot', { action: 'admit', builderId });
  const release = (builderId: string) => rpc('builderSlot', { action: 'release', builderId });
  /** Pin the effective cap for this daemon process (ephemeral override). */
  const setCap = (value: number) =>
    rpc('concurrency', { action: 'set', key: 'max_concurrent_builders', value });

  // INVARIANT: with a free slot, a launcher the daemon has never heard of is
  // admitted and its slot is reserved — admission is a decision plus a claim,
  // not a read.
  test('admits a builder when the cap has room, and counts it', async () => {
    const { status, body } = await admit('aaa11111');
    expect(status).toBe(200);
    expect(body.admitted).toBe(true);
    expect(body.running).toBe(1); // the builder just admitted

    const limits = await rpc('concurrency', { action: 'get' });
    expect(limits.body.builders.running).toBe(1);
  });

  // THE REGRESSION THIS FILE EXISTS FOR: the CLI's check is bypassed entirely
  // here, and the cap still holds. Before daemon-side admission, a second
  // launcher at a full cap was refused by nothing.
  test('refuses a second builder at the cap, with the CLI never involved', async () => {
    await setCap(1);

    const first = await admit('aaa11111');
    expect(first.body.admitted).toBe(true);

    const second = await admit('bbb22222');
    expect(second.status).toBe(200);
    expect(second.body.admitted).toBe(false);
    expect(second.body.running).toBe(1);
    expect(second.body.limit).toBe(1);
  });

  // The ephemeral `lazy daemon config set` override is what admission decides
  // against — not just the lazy.toml value — so raising the cap at runtime
  // takes effect on the very next launch.
  test('honors the ephemeral cap override in both directions', async () => {
    await setCap(1);
    expect((await admit('aaa11111')).body.admitted).toBe(true);
    expect((await admit('bbb22222')).body.admitted).toBe(false);

    await setCap(2);
    const afterRaise = await admit('bbb22222');
    expect(afterRaise.body.admitted).toBe(true);
    expect(afterRaise.body.limit).toBe(2);
  });

  // A released slot is immediately reusable: this is the path a failed launch
  // (or an exited builder) takes, and it must not strand the slot until the
  // reservation TTL expires.
  test('releasing a slot frees it for the next builder', async () => {
    await setCap(1);
    await admit('aaa11111');
    expect((await admit('bbb22222')).body.admitted).toBe(false);

    const released = await release('aaa11111');
    expect(released.status).toBe(200);
    expect(released.body.released).toBe(true);

    expect((await admit('bbb22222')).body.admitted).toBe(true);
  });

  // Idempotence: a retried admit for the same builder must not charge a second
  // slot, or a client that retries once would deadlock itself out of the cap.
  test('re-admitting the same builder id does not consume a second slot', async () => {
    await setCap(1);
    expect((await admit('aaa11111')).body.admitted).toBe(true);

    const again = await admit('aaa11111');
    expect(again.body.admitted).toBe(true);
    expect(again.body.running).toBe(1);
  });

  // Release is idempotent too — an exit path that runs twice must not throw.
  test('releasing an unknown builder id succeeds', async () => {
    const result = await release('never-admitted');
    expect(result.status).toBe(200);
    expect(result.body.released).toBe(true);
  });

  // Boundary validation (memory: external-surfaces-validate-inputs): the RPC is
  // an external surface and confirms its own inputs rather than assuming a
  // well-behaved CLI built the request.
  test('rejects a request with no builder id', async () => {
    const missing = await rpc('builderSlot', { action: 'admit' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('builderId is required');

    const badAction = await rpc('builderSlot', { action: 'demolish', builderId: 'aaa11111' });
    expect(badAction.status).toBe(400);
  });
});
