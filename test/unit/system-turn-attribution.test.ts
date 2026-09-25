/**
 * "NOBODY ASKED FOR THIS TURN" IS A RECORDED FACT, NOT AN ABSENT FIELD.
 *
 * A turn the daemon starts by itself is attributed to the account that
 * configured the automation (docs/design/actor-identity-and-remote-clients.md
 * §3.3 case 3). What makes a turn one of those is a MARK the launch writes —
 * `Session.turn_system_initiated` — and never the mere absence of an owner,
 * because absence has other causes:
 *
 *   - a best-effort person write that failed (deliberately not fatal);
 *   - a session written before any of this existed;
 *   - a store that never received the write at all.
 *
 * In every one of those the honest answer is NOBODY — the pre-identity shape,
 * which is correctable later — and never "the daemon did this, on the service
 * account's behalf", which is a specific claim about a specific person and is
 * not correctable at all.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import {
  createAgentTurn,
  personForCurrentTurn,
  recordSessionTurnOwner,
  runAsTurnOwnerRequest,
  turnChannelActor,
} from '../../src/daemon/turn-owner';
import { clearGitIdentityCache } from '../../src/identity/git-identity';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import type { Storage } from '../../src/storage/interface';

/** The identity a laptop resolves for system actions — this repo's git config. */
const CONFIGURED = { email: 'ops@example.com', name: 'Ops Person' };

describe('system-initiated attribution', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;
  let baseDir: string;
  let unpin: () => void;
  let sessionId: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-systurn-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-systurn-store-'));
    baseDir = await makeDaemonBaseDir();
    unpin = pinDaemonBaseDir(baseDir);
    clearGitIdentityCache();

    // A repo with an identity: on a laptop the configured system identity IS
    // the git identity (§3.4), so this is what these turns should name.
    spawnSyncUnsupervised(['git', 'init', '-q'], { cwd: lazyRoot });
    spawnSyncUnsupervised(['git', 'config', 'user.email', CONFIGURED.email], { cwd: lazyRoot });
    spawnSyncUnsupervised(['git', 'config', 'user.name', CONFIGURED.name], { cwd: lazyRoot });

    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    const task = await storage.createTask('System turn attribution test');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/systurn', 'abc123');
    sessionId = session.id;
  });

  afterEach(async () => {
    await storage.close();
    unpin();
    await removeDaemonBaseDir(baseDir);
    clearGitIdentityCache();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  /** Launch with nobody behind it — the reconciler's auto-resume, a daemon sync. */
  async function launchWithNobody(): Promise<void> {
    await recordSessionTurnOwner({ taskId: 'task', sessionId, storage });
  }

  /** Launch somebody asked for. */
  async function launchAskedFor(email: string, name?: string): Promise<void> {
    await runAsTurnOwnerRequest(
      { taskId: 'task', owner: { email, ...(name ? { name } : {}), spendable: false } },
      () => recordSessionTurnOwner({ taskId: 'task', sessionId, storage }),
    );
  }

  test('a launch nobody asked for marks the turn, and the mark names the configured account', async () => {
    await launchWithNobody();

    expect(await personForCurrentTurn(storage, sessionId, lazyRoot))
      .toEqual({ ...CONFIGURED, system: true });
  });

  // INVARIANT: an UNSTAMPED session names nobody. Every session written before
  // this field existed is in exactly this state, and so is one whose launch
  // never reached the store — neither of which is evidence that the daemon
  // started the turn by itself.
  test('a session no launch has stamped names nobody, not the system', async () => {
    expect(await personForCurrentTurn(storage, sessionId, lazyRoot)).toBeNull();
  });

  // INVARIANT: the person write is best-effort BECAUSE its failure degrades to
  // nobody. Once a failure could leave the previous turn's system mark standing,
  // that stopped being true: the rows of a turn ivan asked for would have named
  // the service account, under a role saying nobody asked for it.
  test('a failed person write degrades to nobody, never to the system account', async () => {
    await launchWithNobody();
    expect((await personForCurrentTurn(storage, sessionId, lazyRoot))?.system).toBe(true);

    // ivan's launch, with a store that refuses the write.
    let attempts = 0;
    const failing: Storage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'setSessionTurnOwner') {
          return async (id: string, owner: unknown, systemInitiated?: boolean) => {
            attempts++;
            // The person write fails; the fallback that degrades the record to
            // "nobody" is allowed through, which is the behaviour under test.
            if (owner) throw new Error('store is read-only');
            return (target as any).setSessionTurnOwner(id, owner, systemInitiated);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Storage;

    await runAsTurnOwnerRequest(
      { taskId: 'task', owner: { email: 'ivan@example.com', spendable: false } },
      () => recordSessionTurnOwner({ taskId: 'task', sessionId, storage: failing }),
    );
    expect(attempts).toBeGreaterThan(0);

    expect(await personForCurrentTurn(storage, sessionId, lazyRoot)).toBeNull();
  });

  test('a launch somebody asked for clears the previous turn’s system mark', async () => {
    await launchWithNobody();
    await launchAskedFor('ivan@example.com', 'Ivan');

    expect(await personForCurrentTurn(storage, sessionId, lazyRoot))
      .toEqual({ email: 'ivan@example.com', name: 'Ivan', system: false });
  });

  describe('the rows it writes', () => {
    test('an agent turn nobody asked for carries the configured account as the system', async () => {
      await launchWithNobody();

      const turn = await createAgentTurn(storage, {
        sessionId,
        sequence: 1,
        role: 'agent',
        content: 'work done during a turn nobody asked for',
      }, lazyRoot);

      expect(turn.actor).toBe('system');
      expect(turn.actor_email).toBe(CONFIGURED.email);
      expect(turn.actor_name).toBe(CONFIGURED.name);
    });

    test('an agent turn on an unstamped session carries no person at all', async () => {
      const turn = await createAgentTurn(storage, {
        sessionId,
        sequence: 1,
        role: 'agent',
        content: 'work on a session no launch stamped',
      }, lazyRoot);

      expect(turn.actor_email).toBeUndefined();
      expect(turn.actor).not.toBe('system');
    });
  });

  /**
   * The SYNC path's writer. `recordSyncTurns` and `runSelfSync` both announce a
   * merge lazy performed as a `supervisor`-actored turn, and the role may not
   * move: that idempotency check reads it back, so a role differing between two
   * passes over one response would record the same merge twice.
   */
  describe('a channel of its own (the sync announcement)', () => {
    test('names the human who asked for the sync, keeping the supervisor role', async () => {
      await launchAskedFor('ivan@example.com', 'Ivan');

      expect(await turnChannelActor(storage, sessionId, 'supervisor', lazyRoot))
        .toEqual({ role: 'supervisor', email: 'ivan@example.com', name: 'Ivan' });
    });

    test('names the configured account for a sync nobody asked for', async () => {
      await launchWithNobody();

      expect(await turnChannelActor(storage, sessionId, 'supervisor', lazyRoot))
        .toEqual({ role: 'supervisor', ...CONFIGURED });
    });

    // INVARIANT: the bare role, byte-identical to what this call site passed
    // before any of this existed — an unstamped session is not a system turn.
    test('is the bare role on an unstamped session', async () => {
      expect(await turnChannelActor(storage, sessionId, 'supervisor', lazyRoot)).toBe('supervisor');
    });

    // `runSelfSync` calls this with NO project root, relying on the daemon's own
    // — the path a loop task's self-sync takes, since a loop is `working` for
    // its whole turn and syncs itself between children.
    test('falls back to the daemon’s own project root when given none', async () => {
      await launchWithNobody();

      const { initDaemonStorage } = await import('../../src/daemon/rpc-handlers');
      initDaemonStorage(lazyRoot);

      expect(await turnChannelActor(storage, sessionId, 'supervisor'))
        .toEqual({ role: 'supervisor', ...CONFIGURED });
    });
  });
});
