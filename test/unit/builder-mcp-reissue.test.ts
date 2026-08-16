/**
 * Unit tests for the builder's daemon-restart watcher (src/builder/mcp-reissue.ts).
 *
 * What it exists for: a daemon that comes back WITHOUT this session's token
 * record — registry moved by an upgrade, cleared by a repair, label evicted by
 * the builder cap — rejects the mounted credential forever, and the only
 * documented remedy was to throw the conversation away and relaunch. The owner
 * of the session (the `lazy builder` process) notices the new instance and asks
 * for a credential again under its OWN label.
 *
 * The security contract these tests pin, because this is the part that must not
 * quietly become "long-lived tokens":
 *   - re-issue only ever asks for THIS session's label — never another
 *     session's, never a task identity
 *   - it only fires when the daemon is genuinely a different instance (or has
 *     been away), never on a steady-state poll
 *   - it stops before the session's revoke runs, and stop() waits for an
 *     in-flight re-issue, so a token can never be minted behind a dead session
 */

import { describe, test, expect } from 'bun:test';
import { startBuilderMcpReissueWatcher } from '../../src/builder/mcp-reissue';
import type { DaemonStatus } from '../../src/daemon/lifecycle';

const up = (pid: number): DaemonStatus => ({ running: true, pid, buildTime: 'dev', codeSha: 'abc' });
const down: DaemonStatus = { running: false };

/**
 * Drive the watcher over a fixed sequence of observations.
 *
 * NOTE: the watcher handshakes eagerly at construction (deliberately — a
 * restart in the first poll interval must count as a restart, not become the
 * baseline), so `statuses[0]` is consumed by that handshake and each explicit
 * `tick()` takes the next one. The last entry repeats.
 */
function harness(statuses: DaemonStatus[]) {
  const reissued: string[] = [];
  let i = 0;
  const watcher = startBuilderMcpReissueWatcher({
    name: 'builder-1700000000000',
    projectRoot: '/proj',
    // Long enough that the timer never fires during a test — ticks are driven
    // explicitly so the assertions are about the LOGIC, not about timing.
    pollMs: 60_000,
    status: async () => statuses[Math.min(i++, statuses.length - 1)]!,
    reissue: async (name) => { reissued.push(name); },
    log: () => {},
  });
  return { watcher, reissued };
}

describe('builder daemon-restart MCP re-issue watcher', () => {
  // INVARIANT: no churn. A daemon that just keeps running must never cause a
  // credential to be re-minted — re-issue is a restart response, not a refresh
  // loop that keeps a token alive.
  test('a steady daemon never triggers a re-issue', async () => {
    const { watcher, reissued } = harness([up(100), up(100), up(100)]);
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    await watcher.stop();
    expect(reissued).toEqual([]);
  });

  // The failure this task is about: the daemon is rebuilt and restarted, so a
  // different process answers. The session asks for its credential again.
  test('a different daemon instance triggers exactly one re-issue', async () => {
    const { watcher, reissued } = harness([up(100), up(200), up(200)]);
    await watcher.tick();   // handshake with the instance that minted our token
    await watcher.tick();   // new pid → re-issue
    await watcher.tick();   // same pid → nothing more
    await watcher.stop();
    expect(reissued).toEqual(['builder-1700000000000']);
  });

  // A restart is usually observed as a GAP, not as two pids in a row: the
  // daemon is simply unreachable for a while. Coming back at all is enough.
  test('a daemon that went away and came back triggers a re-issue', async () => {
    const { watcher, reissued } = harness([up(100), down, up(100)]);
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    await watcher.stop();
    expect(reissued).toEqual(['builder-1700000000000']);
  });

  // SECURITY INVARIANT: re-issue is always for THIS session's builder label.
  // The watcher has no way to name another identity, and nothing in its inputs
  // can make it: the label is fixed at construction.
  test('re-issue always names this session own label', async () => {
    const seen: string[] = [];
    let pid = 1;
    const watcher = startBuilderMcpReissueWatcher({
      name: 'builder-42',
      projectRoot: '/proj',
      pollMs: 60_000,
      status: async () => up(pid),
      reissue: async (name) => { seen.push(name); },
      log: () => {},
    });
    await watcher.tick();
    pid = 2;
    await watcher.tick();
    await watcher.stop();
    expect(seen).toEqual(['builder-42']);
  });

  // SECURITY INVARIANT: the session's token dies with the session. `lazy
  // builder` stops the watcher before revoking, and stop() must make that
  // ordering real — a re-issue landing after the revoke would leave a live
  // credential behind a dead session.
  test('stop() prevents further re-issues and waits for an in-flight one', async () => {
    const reissued: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredReissue = new Promise<void>((resolve) => { entered = resolve; });
    let pid = 100;

    const watcher = startBuilderMcpReissueWatcher({
      name: 'builder-7',
      projectRoot: '/proj',
      pollMs: 60_000,
      status: async () => up(pid),
      reissue: async (name) => { entered(); await gate; reissued.push(name); },
      log: () => {},
    });

    await watcher.tick();          // steady state
    pid = 200;
    const inFlight = watcher.tick();  // observes the restart, blocks in reissue
    await enteredReissue;             // it is genuinely in flight now

    const stopped = watcher.stop();
    release();
    await stopped;
    await inFlight;

    // The in-flight re-issue completed BEFORE stop() resolved — so the caller's
    // revoke, which runs after stop(), can never be overtaken by it.
    expect(reissued).toEqual(['builder-7']);

    // And nothing after stop() re-issues again.
    pid = 300;
    await watcher.tick();
    expect(reissued).toEqual(['builder-7']);
  });

  // A builder session must never die because housekeeping did.
  test('a failing probe or re-issue never throws at the caller', async () => {
    const watcher = startBuilderMcpReissueWatcher({
      name: 'builder-9',
      projectRoot: '/proj',
      pollMs: 60_000,
      status: async () => { throw new Error('daemon socket gone'); },
      reissue: async () => { throw new Error('daemon refused'); },
      log: () => {},
    });
    await watcher.tick();
    await watcher.tick();
    await watcher.stop();
  });
});
