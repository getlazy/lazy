/**
 * A daemon says which lazy source it is running, and the CLI can compare.
 *
 * This is the wire contract Lazy Teams' fleet roll is built on: the app asks a
 * checkout for its identity with `lazy system source-id`, asks each daemon for
 * its own via `GET /daemon/status`, and restarts every project where the two
 * disagree. If either half stopped answering, the fleet would either never roll
 * or roll forever — and neither failure is visible on any screen.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';

describe('the daemon reports the source it runs', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** The port `/daemon/status` is on, from the daemon's own marker. */
  async function statusPayload(): Promise<Record<string, unknown>> {
    const result = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(result);
    const port = result.stdout.match(/:(\d+)/)?.[1];
    expect(port).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}/daemon/status`);
    expect(response.ok).toBe(true);
    return await response.json() as Record<string, unknown>;
  }

  test('GET /daemon/status carries a source id and says how it was arrived at', async () => {
    const payload = await statusPayload();

    expect(typeof payload.sourceId).toBe('string');
    expect(payload.sourceId as string).toMatch(/^[0-9a-f]{16}$/);
    expect([ 'baked', 'computed' ]).toContain(payload.sourceIdKind as string);
  });

  // The two halves of the comparison a fleet makes every minute. They are
  // computed by different processes from different entry points, and they must
  // be the same string — a mismatch here IS the "restart the world every
  // minute" failure, seen before it reaches anyone.
  test('the id the daemon reports is the id the CLI reports for the same checkout', async () => {
    const payload = await statusPayload();

    const cli = await ctx.lazy(['system', 'source-id']);
    expectSuccess(cli);

    expect(cli.stdout.trim().split('\n').pop()).toBe(payload.sourceId as string);
  });

  test('--json carries the kind and the checkout path alongside the id', async () => {
    const cli = await ctx.lazy(['system', 'source-id', '--json']);
    expectSuccess(cli);

    const parsed = JSON.parse(cli.stdout.trim().split('\n').pop()!);
    expect(parsed.id).toMatch(/^[0-9a-f]{16}$/);
    expect([ 'baked', 'computed' ]).toContain(parsed.kind);
    expect(typeof parsed.checkoutPath).toBe('string');
  });

  // `lazy daemon status` is where a human at a terminal learns their daemon is
  // stale. With the daemon on this very checkout there is nothing to warn
  // about, so the line must read as current rather than as a false alarm.
  test('lazy daemon status reports the source as up to date, with no stale warning', async () => {
    const result = await ctx.lazy(['daemon', 'status']);
    expectSuccess(result);

    expect(result.stdout).toContain('Source:');
    expect(result.stdout).toContain('up to date');
    expect(result.stdout).not.toContain('STALE');
  });
});
