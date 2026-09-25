/**
 * A sync or reparent leaves no turn owner behind, whatever it did, and one
 * request's owner is never taken — or spent — by another request, or by a turn
 * the daemon starts by itself.
 *
 * `handleRpc` decides who asked for a turn (the pending owner,
 * src/daemon/turn-owner.ts) before the handler runs, and runs the handler in
 * that request's scope — the only place the owner lives. A sync-family command
 * can succeed WITHOUT launching a turn — nothing to merge, a clean merge done on
 * the host, a failed fetch queued for the retry loop — and any owner visible
 * after it would bill that member for the next turn on the task (auto-deliver,
 * auto-resume). One that does launch reads its owner from its request's scope.
 * test/unit/turn-owner-request-end.test.ts covers the non-sync outcomes, and a
 * daemon-started credential plan racing a member's request.
 *
 * The handler is replaced by a fake that returns a chosen result, because the
 * subject here is the wrapper's bookkeeping around it. The real clean-merge
 * path against a live daemon is test/e2e/daemon-actor-tokens.test.ts ("a sync
 * that merges cleanly leaves no owner behind for the next turn").
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

type SyncParams = { taskId: string; actor?: unknown };
type SyncFake = (params: SyncParams) => Promise<unknown>;
let syncImpl: SyncFake = async () => ({ status: 'up_to_date' });

const lifecyclePath = resolve(import.meta.dir, '../../src/daemon/task-lifecycle.ts');
const realLifecycle = await import(lifecyclePath);
await mockModule(lifecyclePath, () => ({
  ...realLifecycle,
  syncTask: (_root: string, params: SyncParams) => syncImpl(params),
}));

const {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleRpc,
} = await import('../../src/daemon/rpc-handlers');
const { getPendingTurnOwner } = await import('../../src/daemon/turn-owner');

const ADA = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;
const BEA = { kind: 'user', email: 'bea@example.com', name: 'Bea' } as const;

/** A promise plus the function that settles it, for ordering two requests. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(r => { open = r; });
  return { wait, open };
}

/**
 * Which member a faked sync is running for: the person `applyCallerActor`
 * stamped on the handler's params. Deliberately NOT the pending owner, which is
 * part of what these tests exercise, and NOT call order, which two concurrent
 * requests do not guarantee.
 */
function callerOf(params: SyncParams): string | null {
  const actor = params.actor as { email?: unknown } | undefined;
  return typeof actor?.email === 'string' ? actor.email : null;
}

/**
 * The owner a turn the DAEMON starts on `taskId` would read — asked from the
 * test's own context, outside every request, which is where the reconciler,
 * auto-deliver and the pending-sync retry loop run.
 */
function daemonSideOwner(taskId: string): string | null {
  return getPendingTurnOwner(taskId)?.email ?? null;
}

afterAll(() => {
  restoreMockedModules();
});

describe('handleRpc turn-owner bookkeeping for the sync family', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-sync-owner-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    taskId = (await (await getOrCreateStorage()).createTask('Sync-owner task')).id;
    syncImpl = async () => ({ status: 'up_to_date' });
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a sync that merged cleanly on the host launched no turn, so it
  // leaves no pending owner. `merged` is the ordinary result whenever the parent
  // moved without conflicts; the owner record it once left billed this member
  // for the next auto-deliver on the task.
  test('a clean-merge sync leaves no pending owner', async () => {
    let seenDuringSync: string | null = null;
    syncImpl = async () => {
      seenDuringSync = getPendingTurnOwner(taskId)?.email ?? null;
      return { status: 'merged' };
    };
    const result = await handleRpc('syncTask', root, { taskId }, undefined, ADA) as { status: string };

    expect(result.status).toBe('merged');
    // It really was Ada's inside the request — its absence after is what is
    // under test.
    expect(seenDuringSync as string | null).toBe('ada@example.com');
    expect(daemonSideOwner(taskId)).toBeNull();
  });

  // INVARIANT: a sync whose fetch failed queues the merge for the retry loop and
  // launches nothing now. The retry is a turn the daemon starts by itself, so
  // the asker's owner must not wait for it — or for whatever launches first.
  test('a sync queued as pending_sync leaves no pending owner', async () => {
    syncImpl = async () => ({ status: 'pending_sync' });
    await handleRpc('syncTask', root, { taskId }, undefined, ADA);
    expect(daemonSideOwner(taskId)).toBeNull();
  });

  // INVARIANT: a sync that launched its merge turn bills that turn to its
  // caller, and still leaves no owner once the request is over: the launch
  // read its owner inside the request, and anything reading outside it is a
  // turn the daemon started by itself.
  test('a sync that launched its merge turn launched it as its caller, and leaves no owner', async () => {
    let launchedAs: string | null = null;
    syncImpl = async () => {
      launchedAs = getPendingTurnOwner(taskId)?.email ?? null;
      return { status: 'sync_launched' };
    };
    await handleRpc('syncTask', root, { taskId }, undefined, ADA);
    expect(launchedAs as string | null).toBe('ada@example.com');
    expect(getPendingTurnOwner(taskId)).toBeNull();
  });

  // INVARIANT: a request's owner is its own until its launch, whatever a
  // concurrent request on the same task does. Bea's sync coming back with
  // nothing to merge must not take Ada's owner with it, or Ada's turn runs on
  // the service account (or is refused). And for the whole time both requests
  // are in flight, a turn the daemon starts by itself on the task — which reads
  // outside either request — finds NOBODY: neither member asked for it. This
  // replaces "a no-turn sync does not clear a concurrent request's owner",
  // which guarded the per-request token on a shared per-task record; the record
  // is gone, and so is the window in which it billed a member for the daemon's
  // turn.
  test("a no-turn sync does not take a concurrent request's owner, and a daemon read finds nobody", async () => {
    const beaEntered = gate();
    const adaEntered = gate();
    const beaFetching = gate();
    const adaLaunching = gate();
    let adaLaunchedAs: string | null = null;
    syncImpl = async (params) => {
      // Bea's sync finds nothing to merge; Ada's launches.
      if (callerOf(params) === BEA.email) {
        beaEntered.open();
        await beaFetching.wait;
        return { status: 'up_to_date' };
      }
      adaEntered.open();
      await adaLaunching.wait;
      adaLaunchedAs = getPendingTurnOwner(taskId)?.email ?? null;
      return { status: 'sync_launched' };
    };

    const bea = handleRpc('syncTask', root, { taskId }, undefined, BEA);
    await beaEntered.wait;
    const ada = handleRpc('syncTask', root, { taskId }, undefined, ADA);
    await adaEntered.wait;
    // Both members' requests are inside their handlers.
    expect(daemonSideOwner(taskId)).toBeNull();

    beaFetching.open();
    await bea;
    expect(daemonSideOwner(taskId)).toBeNull();

    adaLaunching.open();
    await ada;
    expect(adaLaunchedAs as string | null).toBe('ada@example.com');
  });

  // INVARIANT: a launch bills the request that asked for it, even when a
  // concurrent request on the same task arrived after it. Bea's sync began,
  // Ada's request began; Bea's merge turn must still be Bea's and Ada's Ada's —
  // and while both are in flight, nobody's from outside them. This replaces "a
  // launch reads its own request's owner, not a later overwrite", which pinned
  // the same property against a shared per-task record that has been removed.
  test("each launch reads its own request's owner, whichever arrived last", async () => {
    const beaEntered = gate();
    const adaEntered = gate();
    const beaFetching = gate();
    const adaHolding = gate();
    let beaLaunchedAs: string | null = null;
    let adaLaunchedAs: string | null = null;
    syncImpl = async (params) => {
      if (callerOf(params) === BEA.email) {
        beaEntered.open();
        await beaFetching.wait;
        beaLaunchedAs = getPendingTurnOwner(taskId)?.email ?? null;
        return { status: 'sync_launched' };
      }
      adaEntered.open();
      await adaHolding.wait;
      adaLaunchedAs = getPendingTurnOwner(taskId)?.email ?? null;
      return { status: 'sync_launched' };
    };

    const bea = handleRpc('syncTask', root, { taskId }, undefined, BEA);
    await beaEntered.wait;
    const ada = handleRpc('syncTask', root, { taskId }, undefined, ADA);
    await adaEntered.wait;
    expect(daemonSideOwner(taskId)).toBeNull();
    beaFetching.open();
    await bea;

    expect(beaLaunchedAs as string | null).toBe('bea@example.com');
    expect(daemonSideOwner(taskId)).toBeNull();
    adaHolding.open();
    await ada;
    expect(adaLaunchedAs as string | null).toBe('ada@example.com');
  });

  // INVARIANT: the refusal path takes nothing from a concurrent request either,
  // and leaves nothing a daemon read could find. Replaces "a refused sync does
  // not clear a concurrent request's owner" (the removed shared record's
  // token-scoped clear).
  test("a refused sync does not take a concurrent request's owner", async () => {
    const beaEntered = gate();
    const adaEntered = gate();
    const beaFetching = gate();
    const adaHolding = gate();
    let adaLaunchedAs: string | null = null;
    syncImpl = async (params) => {
      if (callerOf(params) === BEA.email) {
        beaEntered.open();
        await beaFetching.wait;
        throw new Error('fetch refused');
      }
      adaEntered.open();
      await adaHolding.wait;
      adaLaunchedAs = getPendingTurnOwner(taskId)?.email ?? null;
      return { status: 'sync_launched' };
    };

    const bea = handleRpc('syncTask', root, { taskId }, undefined, BEA).catch(err => err);
    await beaEntered.wait;
    const ada = handleRpc('syncTask', root, { taskId }, undefined, ADA);
    await adaEntered.wait;
    beaFetching.open();
    expect(await bea).toBeInstanceOf(Error);

    expect(daemonSideOwner(taskId)).toBeNull();
    adaHolding.open();
    await ada;
    expect(adaLaunchedAs as string | null).toBe('ada@example.com');
  });
});
