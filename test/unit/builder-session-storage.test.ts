/**
 * Unit tests: builder-session storage entity — the registry a daemon-owned
 * builder session is recorded in (docs/design/actor-identity-and-remote-clients.md §5.2).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { BuilderSessionStateConflictError } from '../../src/storage/interface';
import type { BuilderSession } from '../../src/storage/types';

describe('builder-session storage', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-bs-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-bs-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  const session = (overrides: Partial<BuilderSession> = {}): BuilderSession => ({
    id: 'sess-1',
    projectRoot: '/proj/a',
    memberEmail: 'ivan@example.com',
    kind: 'interactive',
    state: 'starting',
    containerName: null,
    builderId: 'b1',
    agentSessionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    ...overrides,
  });

  test('create then get returns the session', async () => {
    const s = session();
    await storage.createBuilderSession(s);
    expect(await storage.getBuilderSession('sess-1')).toEqual(s);
  });

  test('getBuilderSession returns null for an unknown id', async () => {
    expect(await storage.getBuilderSession('nope')).toBeNull();
  });

  test('createBuilderSession refuses a duplicate id', async () => {
    await storage.createBuilderSession(session());
    await expect(storage.createBuilderSession(session())).rejects.toThrow(/already exists/);
  });

  test('listBuilderSessions filters by project root', async () => {
    await storage.createBuilderSession(session({ id: 'a', projectRoot: '/proj/a' }));
    await storage.createBuilderSession(session({ id: 'b', projectRoot: '/proj/b' }));

    expect((await storage.listBuilderSessions('/proj/a')).map(s => s.id)).toEqual(['a']);
    expect((await storage.listBuilderSessions()).map(s => s.id).sort()).toEqual(['a', 'b']);
  });

  test('updateBuilderSession patches fields and stamps updatedAt', async () => {
    const s = session({ state: 'starting', containerName: null });
    await storage.createBuilderSession(s);

    const before = s.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = await storage.updateBuilderSession('sess-1', {
      state: 'running',
      containerName: 'lazy-builder-b1',
    });

    expect(updated.state).toBe('running');
    expect(updated.containerName).toBe('lazy-builder-b1');
    expect(updated.updatedAt).not.toBe(before);
    // Unpatched fields survive untouched.
    expect(updated.memberEmail).toBe('ivan@example.com');
  });

  test('updateBuilderSession throws for an unknown id', async () => {
    await expect(storage.updateBuilderSession('nope', { state: 'ended' })).rejects.toThrow(/not found/);
  });

  // INVARIANT: a session the member explicitly ended is never resurrected by
  // a launch that was already in flight (§5.7 — "a session ends explicitly,
  // and not otherwise"). The expected-state (CAS) guard decides INSIDE the
  // same locked critical section as the write, so the refusal is the
  // serialization point — not an advisory check the patch can outrun. The
  // guard never rewrites the row: the member's decision survives, and the
  // refused caller re-reads and defers.
  test('updateBuilderSession expected-state guard refuses a write whose row moved on', async () => {
    await storage.createBuilderSession(session({ state: 'starting' }));
    // The member's explicit end lands while a launch was in flight.
    await storage.updateBuilderSession('sess-1', { state: 'ended', endedAt: new Date().toISOString() });

    // A reconcile whose expected state no longer matches is refused ...
    await expect(
      storage.updateBuilderSession('sess-1', { state: 'running', containerName: 'lazy-builder-b1' }, 'starting'),
    ).rejects.toBeInstanceOf(BuilderSessionStateConflictError);
    // ... and the member's decision survives untouched — the guard never
    // rewrites the row it refused.
    const survived = await storage.getBuilderSession('sess-1');
    expect(survived?.state).toBe('ended');
    expect(survived?.containerName).toBeNull();

    // The happy path: a matching expected state lands ...
    await storage.createBuilderSession(session({ id: 'sess-2', builderId: 'b2' }));
    const running = await storage.updateBuilderSession(
      'sess-2',
      { state: 'running', containerName: 'lazy-builder-b2' },
      'starting',
    );
    expect(running.state).toBe('running');

    // ... and callers passing no expected state are unchanged.
    await expect(storage.updateBuilderSession('sess-1', { state: 'ended' })).resolves.toBeDefined();
  });

  // INVARIANT: the CAS can pin a LAUNCH, not just a state. A relaunch returns
  // the row to the same state under a new builder id, so a stop/end guarded on
  // state alone would overwrite the new launch and orphan its container.
  test('updateBuilderSession refuses when the expected builder id no longer matches', async () => {
    await storage.createBuilderSession(session({ state: 'running', builderId: 'b2', containerName: 'lazy-builder-b2' }));
    const refusal = storage.updateBuilderSession('sess-1', { state: 'ended', containerName: null }, 'running', 'b1');
    await expect(refusal).rejects.toBeInstanceOf(BuilderSessionStateConflictError);
    await expect(refusal).rejects.toThrow('relaunched');
    expect((await storage.getBuilderSession('sess-1'))?.containerName).toBe('lazy-builder-b2');

    const ended = await storage.updateBuilderSession('sess-1', { state: 'ended', containerName: null }, 'running', 'b2');
    expect(ended.state).toBe('ended');
  });

  // INVARIANT: "one session per member per project" (§5.7) is served by this
  // lookup — a second `startBuilderSession` call for the same member finds the
  // existing non-ended row instead of registering a second one.
  test('getActiveBuilderSessionForMember finds the non-ended session and ignores ended ones', async () => {
    await storage.createBuilderSession(session({ id: 'old', state: 'ended', endedAt: new Date().toISOString() }));
    await storage.createBuilderSession(session({ id: 'new', state: 'running' }));

    const active = await storage.getActiveBuilderSessionForMember('/proj/a', 'ivan@example.com');
    expect(active?.id).toBe('new');
  });

  test('getActiveBuilderSessionForMember returns null when every session for the member has ended', async () => {
    await storage.createBuilderSession(session({ id: 'old', state: 'ended', endedAt: new Date().toISOString() }));
    expect(await storage.getActiveBuilderSessionForMember('/proj/a', 'ivan@example.com')).toBeNull();
  });

  test('getActiveBuilderSessionForMember scopes by member email, not just project', async () => {
    await storage.createBuilderSession(session({ id: 'ivan', memberEmail: 'ivan@example.com', state: 'running' }));
    await storage.createBuilderSession(session({ id: 'pete', memberEmail: 'pete@example.com', state: 'running' }));

    expect((await storage.getActiveBuilderSessionForMember('/proj/a', 'pete@example.com'))?.id).toBe('pete');
    expect(await storage.getActiveBuilderSessionForMember('/proj/a', 'nobody@example.com')).toBeNull();
  });
});
