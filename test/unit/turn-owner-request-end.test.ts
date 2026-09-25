/**
 * A turn-launching request's owner never reaches a turn the daemon starts by
 * itself — not after the request, and not during it.
 *
 * `handleRpc` runs every turn-launching command inside that request's
 * AsyncLocalStorage scope, the only place its owner lives
 * (src/daemon/turn-owner.ts). Every launch the request performs — or queues and
 * performs after returning, like a review ask dispatched in the background —
 * reads its owner from the scope. A turn the daemon starts by itself
 * (auto-deliver, auto-resume, the pending-sync retry loop) runs outside every
 * request, and its right answer is always "nobody asked".
 *
 * Three outcomes are pinned: a background ask whose launch throws after the
 * request returned, and an accept the forge has not finished (`status:
 * 'pending'`, task `merging`) — the two the old per-outcome clears missed —
 * and a daemon-started turn that runs WHILE a member's request is in flight,
 * which the request-end clear of a shared per-task record could not cover.
 * The ask runs the REAL review service and the REAL ask launch path, with only
 * the runner (the external boundary) faked; accept's handler is faked, because
 * the subject there is the wrapper's bookkeeping around a result.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

enableInProcessTestMode();

// --- The runner: the one external boundary the ask path is faked at ---------

/** How the fake runner behaves for the current test. */
let runnerMode: 'unavailable' | 'fails-after-credential' = 'unavailable';
/** Held shut until the test opens it, so the launch runs AFTER the request returned. */
let runnerGate: Promise<void> = Promise.resolve();
let runnerType = 'docker';

const runnerPath = resolve(import.meta.dir, '../../src/runner/index.ts');
const realRunner = await import(runnerPath);
await mockModule(runnerPath, () => ({
  ...realRunner,
  createRunner: async () => ({
    type: runnerType,
    usesSandbox: () => false,
    getAgentInstructions: () => '',
    checkAvailability: async () => {
      await runnerGate;
      if (runnerMode === 'unavailable') throw new Error('runner unavailable (test)');
    },
    // The first runner call after the credential is planned. Throwing here
    // ends the ask having gone through the real planTurnCredential.
    runNameForTask: () => { throw new Error('supervisor launch refused (test)'); },
    isRunning: async () => false,
  }),
}));

// --- Accept: the handler is faked to a chosen result -------------------------

let acceptImpl: (params: { taskId: string }) => Promise<unknown> = async () => ({ status: 'accepted' });

const lifecyclePath = resolve(import.meta.dir, '../../src/daemon/task-lifecycle.ts');
const realLifecycle = await import(lifecyclePath);
await mockModule(lifecyclePath, () => ({
  ...realLifecycle,
  acceptTask: (_root: string, params: { taskId: string }) => acceptImpl(params),
}));

const {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleRpc,
} = await import('../../src/daemon/rpc-handlers');
const { getPendingTurnOwner } = await import('../../src/daemon/turn-owner');
const { planTurnCredential } = await import('../../src/daemon/turn-credentials');
const {
  putUserCredential,
  clearUserCredentialCache,
  SERVICE_CREDENTIAL_USER_ID,
} = await import('../../src/daemon/user-credentials');
const { clearSessionCredentialCache, getTaskSessionBinding } = await import('../../src/daemon/session-credentials');
const { getWorktreePathForRef, taskRef } = await import('../../src/task/identity');
const { loadConfig } = await import('../../src/config/loader');

const ADA = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

afterAll(() => {
  restoreMockedModules();
});

describe("a turn-launching request's owner does not outlive the request", () => {
  let root: string;
  let base: string;
  let taskId: string;
  let sessionId: string;
  let unpinConfig: () => void;
  let unpinBase: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-owner-request-end-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-owner-request-end-base-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    unpinBase = pinDaemonBaseDir(base);
    initDaemonStorage(root);
    clearUserCredentialCache();
    clearSessionCredentialCache();
    runnerMode = 'unavailable';
    runnerGate = Promise.resolve();
    runnerType = (await loadConfig(root)).runner.type;
    acceptImpl = async () => ({ status: 'accepted' });

    // TEAM MODE: Ada has her own credential, and the service credential is
    // what a turn nobody asked for spends.
    await putUserCredential(root, { userId: ADA.email, kind: 'api-key', token: 'sk-ant-api-ada' });
    await putUserCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'api-key', token: 'sk-ant-api-svc' });

    // A task that has run once and is paused — i.e. one a live ask can reach.
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Owner-lifetime task');
    const session = await storage.createSession(task.id, task.agent_id, `lazy/${task.code}`, 'abc123');
    await storage.updateSessionClaudeId(session.id, 'agent-session-1');
    await storage.updateTaskStatus(task.id, 'working', 'system');
    await storage.updateTaskStatus(task.id, 'blocked', 'system');
    await mkdir(getWorktreePathForRef(root, taskRef(task)), { recursive: true });
    taskId = task.id;
    sessionId = session.id;
  });

  afterEach(async () => {
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await closeAllStorage();
    unpinBase();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  /** Wait for the background ask on the review comment to settle. */
  async function askSettled(): Promise<{ ask_state?: string; ask_error?: string | null }> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const comments = await (await getOrCreateStorage()).getTaskReviewComments(taskId);
      const asked = comments.find((c) => c.role === 'human');
      if (asked && asked.ask_state !== 'pending') return asked;
      if (Date.now() > deadline) throw new Error(`ask never settled; state ${asked?.ask_state ?? 'no comment'}`);
      await Bun.sleep(5);
    }
  }

  /** A turn the daemon starts by itself: no request, so no scope. */
  async function daemonStartedTurnBills(): Promise<string | undefined> {
    const plan = await planTurnCredential(root, { taskId, sessionId, storage: await getOrCreateStorage() });
    return plan.mode === 'session' ? plan.ownerUserId : undefined;
  }

  // INVARIANT: an ask whose background launch throws before any turn starts
  // leaves no turn owner behind. `reviewAsk` returns before the ask runs, so the
  // request succeeded and the old outcome-based clears kept the record "for the
  // launch" — which then never happened, and the next turn the daemon started
  // on the task (auto-deliver, auto-resume, a pending-sync retry) billed the
  // asker. A daemon-started turn must spend the service credential.
  test('an ask whose background launch throws leaves no owner', async () => {
    runnerMode = 'unavailable';
    await handleRpc('reviewAsk', root, { taskId, content: 'Why this way?' }, undefined, ADA);

    const settled = await askSettled();
    expect(settled.ask_state).toBe('failed');
    expect(settled.ask_error).toContain('runner unavailable');

    expect(getPendingTurnOwner(taskId)).toBeNull();
    expect(await daemonStartedTurnBills()).toBe(SERVICE_CREDENTIAL_USER_ID);
  });

  // INVARIANT: a launch that runs after its request has returned — the
  // background ask — still bills the person who asked, through the real launch
  // path into planTurnCredential, even though nothing outside the request names
  // them by then. The scope is what carries the owner, and the only thing.
  test("a background ask's launch still reads its request's owner after the request ended", async () => {
    runnerMode = 'fails-after-credential';
    let open!: () => void;
    runnerGate = new Promise<void>((r) => { open = r; });

    await handleRpc('reviewAsk', root, { taskId, content: 'And this?' }, undefined, ADA);
    // The request is over and nothing outside it names Ada...
    expect(getPendingTurnOwner(taskId)).toBeNull();
    // ...and only now does the queued ask reach the credential plan.
    open();
    const settled = await askSettled();
    expect(settled.ask_error).toContain('supervisor launch refused');

    const storage = await getOrCreateStorage();
    expect((await storage.getSession(sessionId))?.turn_owner_email).toBe(ADA.email);
    expect((await getTaskSessionBinding(root, taskId))?.ownerUserId).toBe(ADA.email);

    // Nothing of Ada's is left for the next turn the daemon starts.
    expect(getPendingTurnOwner(taskId)).toBeNull();
    expect(await daemonStartedTurnBills()).toBe(SERVICE_CREDENTIAL_USER_ID);
  });

  // INVARIANT: an accept the forge has not finished (`status: 'pending'`) leaves
  // no turn owner behind. It launched no turn, and the task stays `merging` —
  // not terminal, so the old terminal-only clear kept the record. A pipeline
  // failure or a closed PR then parks the task paused, and the next turn the
  // daemon starts there would bill the person who pressed accept.
  test('a pending accept leaves no owner', async () => {
    let seenDuringAccept: string | null = null;
    acceptImpl = async (params) => {
      seenDuringAccept = getPendingTurnOwner(params.taskId)?.email ?? null;
      await (await getOrCreateStorage()).updateTaskStatus(taskId, 'merging', 'system');
      return { taskId, status: 'pending', reason: 'Waiting for required checks' };
    };

    const result = await handleRpc('acceptTask', root, { taskId }, undefined, ADA) as { status: string };
    expect(result.status).toBe('pending');
    // It really was Ada's inside the request — its absence after is what is
    // under test.
    expect(seenDuringAccept as string | null).toBe(ADA.email);
    expect((await (await getOrCreateStorage()).getTask(taskId))?.status).toBe('merging');

    expect(getPendingTurnOwner(taskId)).toBeNull();
    // The forge's pipeline fails; remote-sync parks the task paused.
    await (await getOrCreateStorage()).updateTaskStatus(taskId, 'blocked', 'system');
    expect(await daemonStartedTurnBills()).toBe(SERVICE_CREDENTIAL_USER_ID);
  });

  // INVARIANT: a turn the daemon starts by itself WHILE a member's
  // turn-launching request on the same task is still in flight bills the
  // service credential and records no asker — and the member's own launch,
  // later in that same request, is still theirs. Nobody asked for the daemon's
  // turn: a pending owner lives only in the request that asked, never in a
  // record a concurrent reader could see. The shared per-task record this
  // replaced was written when the request arrived and cleared when it ended,
  // so for that whole window an auto-deliver, auto-resume, pending-sync retry
  // or cluster restart on the task billed the member and stamped them on its
  // rows. Ordered with gates: the daemon's plan runs strictly while Ada's
  // accept is inside its handler.
  test("a daemon-started turn during a member's in-flight request bills the service credential", async () => {
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let memberBilled: string | undefined;
    acceptImpl = async () => {
      entered();
      await held;
      // Ada's own launch, in her request, after the daemon's turn has gone.
      const plan = await planTurnCredential(root, { taskId, sessionId, storage: await getOrCreateStorage() });
      memberBilled = plan.mode === 'session' ? plan.ownerUserId : undefined;
      return { taskId, status: 'accepted' };
    };

    const accepting = handleRpc('acceptTask', root, { taskId }, undefined, ADA);
    await inHandler;

    // The daemon starts a turn on the task now — outside any request.
    expect(await daemonStartedTurnBills()).toBe(SERVICE_CREDENTIAL_USER_ID);
    const session = await (await getOrCreateStorage()).getSession(sessionId);
    expect(session?.turn_owner_email ?? null).toBeNull();
    expect(session?.turn_system_initiated).toBe(true);

    release();
    await accepting;
    expect(memberBilled).toBe(ADA.email);
  });
});
