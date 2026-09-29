/**
 * `startBuilderSession` / `endBuilderSession` — credential binding and
 * registry lifecycle, daemon-side (docs/design/actor-identity-and-remote-clients.md §5.2, §5.5).
 *
 * Every assertion here is reachable WITHOUT a real container: the credential
 * check runs before the daemon ever shells out to docker
 * (src/daemon/builder-sessions.ts `launchDetachedContainer`), and the
 * resume-intent → session capture in `endBuilderSession` degrades gracefully
 * when the container is already gone (or never existed) — exactly the shape
 * `lazy upgrade`'s SIGKILL recovery already relies on
 * (test/e2e/builder-kill-resume.test.ts). So this suite talks to the daemon
 * directly over its TCP port and never launches a container.
 *
 * "Already gone" is an ANSWER, though, not an absence of one: the daemon asks
 * the runtime with `docker inspect`, and a runtime that cannot be asked is
 * `unknown`, which it deliberately refuses to act on. So the runtime here is
 * the fake `docker` binary (test/helpers/fake-docker.ts) with no containers
 * seeded — every `inspect` answers "No such container" on any machine, with or
 * without a real docker — and `failRuns()` makes a container launch fail, the
 * "Docker cannot start it" state the launch tests need.
 *
 * The daemon is OUT of process and unmocked (`setupTestLazy({ fakeClaude:
 * true })`, restarted with the fake on its PATH): the module mock replaces the
 * inspect probe wholesale, and an in-process daemon cannot be pointed at a
 * fake binary at all — `Bun.spawn` resolves executables from the environment
 * the process STARTED with, never a later `process.env.PATH` edit.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';
import { RemoteStorage } from '../../src/storage/remote-storage';
import type { BuilderResumeIntent } from '../../src/storage/types';

// setupTestLazy() configures this as the project's git identity — see
// test/helpers/setup.ts. Outside managed mode this is who a control-token
// call is attributed to, and therefore the member a builder session it starts
// is registered under.
const GIT_EMAIL = 'test@lazy.test';

describe('daemon-owned builder session: credential binding and registry', () => {
  let ctx: TestContext;
  let fakeDir: string;
  let docker: FakeDocker;
  let target: string;
  let token: string;

  beforeEach(async () => {
    fakeDir = await mkdtemp(join(tmpdir(), 'lazy-builder-cred-'));
    docker = await installFakeDocker(fakeDir);
    // No container this suite names may ever start: the launch tests assert
    // on a launch that fails at the container step.
    await docker.failRuns();

    ctx = await setupTestLazy({ fakeClaude: true });
    // fakeClaude switches the project to the host-process runner; a builder
    // session's container is the docker runner's, so put that back.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace(
      'type = "dangerously-host-process-without-any-isolation"',
      'type = "docker"',
    );
    if (patched === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);
    await ctx.restartDaemon({
      LAZY_BUILDER_HOMES_BASE_DIR: join(fakeDir, 'builder-homes'),
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
    });

    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) throw new Error('test daemon did not record a TCP target and token');
    target = resolvedTarget;
    token = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(fakeDir, { recursive: true, force: true });
  });

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    try {
      const body = await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
      return { status: 200, body };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, body: { error: err.message } };
    }
  }

  function daemonStorage(): RemoteStorage {
    return new RemoteStorage(DaemonClient.fromTarget(target, token), ctx.root, '');
  }

  // INVARIANT: a member with no stored credential is refused with the wire
  // marker Rails matches on — never silently billed to the project's service
  // credential (§5.5's stated rule: "a builder session is a human asking for
  // something, not automation"). Team mode is turned on here by pushing a
  // credential for a DIFFERENT user; the acting member (the project's git
  // identity) still has none of their own.
  test('a member with no stored credential is refused, not billed to anyone else', async () => {
    await rpc('putUserCredential', { userId: 'someone-else@example.com', kind: 'oauth', token: 'sk-ant-oat01-someone-elses-token' });

    const { status, body } = await rpc('startBuilderSession', {});
    expect(status).toBe(400);
    expect(body.error).toContain(NO_OWNER_CREDENTIAL_MARKER);
    expect(body.error).toContain(GIT_EMAIL);

    // Refused before any row was written — no orphaned 'starting' session left
    // behind by a launch that never got a credential.
    const storage = daemonStorage();
    expect(await storage.listBuilderSessions(ctx.root)).toEqual([]);
  });

  // Outside team mode, `startBuilderSession` must not require a credential at
  // all — the non-managed `lazy builder` path stays exactly as it works today.
  // The launch itself still fails here (the fake runtime refuses every run),
  // but it must fail at the CONTAINER step, never at the credential check.
  test('outside team mode, no credential is required before the container step', async () => {
    const { status, body } = await rpc('startBuilderSession', {});
    // Never the credential refusal.
    expect(body.error ?? '').not.toContain(NO_OWNER_CREDENTIAL_MARKER);
    // The runtime refuses the container, so the launch fails past the
    // credential gate — proving the gate was cleared rather than skipped.
    expect(status).toBeGreaterThanOrEqual(400);
  });

  // The registry state machine: `endBuilderSession` must degrade gracefully
  // when the container is already gone, and must still capture whatever the
  // resume-intent handshake recorded (the SIGTERM path a real supervisor
  // would have stamped — test/e2e/builder-kill-resume.test.ts proves that half
  // of the handshake against a real supervisor process).
  test('endBuilderSession captures the resume-intent session id even when the container is already gone', async () => {
    const storage = daemonStorage();
    const now = new Date().toISOString();
    await storage.createBuilderSession({
      id: 'sess-fixture-1',
      projectRoot: ctx.root,
      memberEmail: GIT_EMAIL,
      kind: 'interactive',
      state: 'running',
      containerName: 'lazy-builder-d0e5a075',
      builderId: 'd0e5a075',
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    await storage.saveBuilderResumeIntent({
      builderId: 'd0e5a075',
      projectRoot: ctx.root,
      sessionId: 'claude-sess-abc',
      createdAt: now,
    } satisfies BuilderResumeIntent);

    const { status, body } = await rpc('endBuilderSession', { id: 'sess-fixture-1' });
    expect(status).toBe(200);
    expect(body.state).toBe('ended');
    expect(body.agentSessionId).toBe('claude-sess-abc');
    expect(body.endedAt).toBeTruthy();
    // "Gone" was the runtime's answer, not a failure to ask it.
    expect((await docker.invocations()).some(l => l.startsWith('inspect lazy-builder-d0e5a075'))).toBe(true);

    // Ending is terminal: the intent was consumed (not left for a resume that
    // will never come — an ended session is never resumed, §5.7).
    expect(await storage.listBuilderResumeIntents(ctx.root)).toEqual([]);
  });

  test('endBuilderSession is idempotent for an already-ended session', async () => {
    const storage = daemonStorage();
    const now = new Date().toISOString();
    await storage.createBuilderSession({
      id: 'sess-fixture-2',
      projectRoot: ctx.root,
      memberEmail: GIT_EMAIL,
      kind: 'interactive',
      state: 'ended',
      containerName: null,
      builderId: '90e0e0e0',
      agentSessionId: 'sess-already',
      createdAt: now,
      updatedAt: now,
      endedAt: now,
    });

    const { status, body } = await rpc('endBuilderSession', { id: 'sess-fixture-2' });
    expect(status).toBe(200);
    expect(body.state).toBe('ended');
    expect(body.agentSessionId).toBe('sess-already');
  });

  test('endBuilderSession 404s for an unknown session id', async () => {
    const { status } = await rpc('endBuilderSession', { id: 'nope' });
    expect(status).toBe(404);
  });

  // INVARIANT: a 'running' row whose container a daemon restart already reaped
  // must not be trusted at face value — startBuilderSession verifies liveness
  // and falls through to the resume path, capturing whatever the resume-intent
  // handshake stamped, exactly as `endBuilderSession` would have. Without this,
  // a restarted daemon would hand back a session row pointing at a container
  // that no longer exists, forever.
  test('a stale "running" row (container already reaped) is detected and moved to stopped, capturing the resume intent', async () => {
    const storage = daemonStorage();
    const now = new Date().toISOString();
    await storage.createBuilderSession({
      id: 'sess-stale-1',
      projectRoot: ctx.root,
      memberEmail: GIT_EMAIL,
      kind: 'interactive',
      state: 'running',
      containerName: 'lazy-builder-7ea9ed00',
      builderId: '7ea9ed00',
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    await storage.saveBuilderResumeIntent({
      builderId: '7ea9ed00',
      projectRoot: ctx.root,
      sessionId: 'claude-sess-after-restart',
      createdAt: now,
      reason: 'daemon-restart',
    } satisfies BuilderResumeIntent);

    // The container named on the row was never actually started in this test
    // (the fake runtime has no such container), so `docker inspect` reports it
    // gone — exactly the state a real daemon restart leaves behind, minus the
    // daemon actually having restarted. startBuilderSession must not trust the
    // stale 'running' row: it falls through to the (refused, and therefore
    // failing) resume launch — but only AFTER capturing the resume intent onto
    // the row.
    await rpc('startBuilderSession', {});

    const after = await storage.getBuilderSession('sess-stale-1');
    expect(after?.agentSessionId).toBe('claude-sess-after-restart');
    expect(after?.state).not.toBe('running');
    expect((await docker.invocations()).some(l => l.startsWith('inspect lazy-builder-7ea9ed00'))).toBe(true);
    // The intent is consumed once captured — a second stale detection must not
    // find a phantom session id from a previous restart.
    expect(await storage.listBuilderResumeIntents(ctx.root)).toEqual([]);
  });
});
