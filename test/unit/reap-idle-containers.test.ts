/**
 * Wiring test for the reconciler's idle-container reaper sweep.
 *
 * The pure decision (selectContainersToReap) is covered in concurrency.test.ts;
 * this verifies the sweep actually (a) treats only blocked tasks with a live
 * container as candidates, (b) derives idle-since from the last turn timestamp,
 * and (c) reaps via the Runner (`removeRun`) AND clears `container_name` so the
 * existing slot accounting frees the slot — the mechanism required by the spec.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { reapIdleContainers } from '../../src/utils/reconcile';
import type { Runner } from '../../src/runner';
import type { Storage } from '../../src/storage';
import { pinConfig } from '../helpers/pin-config';

interface FakeTask { id: string; status: string; priority: string; created_at: number; }
interface FakeSession { id: string; container_name: string | null; last_interaction_at: number | null; started_at: number; }

function fakeStorage(opts: {
  tasks: FakeTask[];
  sessions: Record<string, FakeSession>;       // taskId → session
  lastTurnTs: Record<string, number>;           // sessionId → last turn timestamp
  cleared: string[];                            // out: session ids whose container_name was cleared
}): Storage {
  return {
    async listTasksWithOptions() {
      // The reaper only asks for nonTerminalOnly; return all fakes.
      return opts.tasks as any;
    },
    async getSessionByTaskId(taskId: string) {
      return (opts.sessions[taskId] ?? null) as any;
    },
    async getSessionTurns(sessionId: string) {
      const ts = opts.lastTurnTs[sessionId];
      return ts !== undefined ? [{ timestamp: ts }] as any : [];
    },
    async updateSessionContainerName(sessionId: string, name: string | null) {
      if (name === null) opts.cleared.push(sessionId);
    },
  } as unknown as Storage;
}

function fakeRunner(removed: string[], reapsIdleRuns = true): Runner {
  return {
    reapsIdleRuns,
    async runExists() { return true; },
    async removeRun(name: string) { removed.push(name); },
  } as unknown as Runner;
}

describe('reapIdleContainers sweep', () => {
  let root: string;
  let unpinConfig: () => void;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-reap-'));
    // reapIdleContainers -> loadConfig walks up from process.cwd() (this repo's
    // own worktree under `bun test`) when LAZY_CONFIG isn't pinned, silently
    // picking up ITS lazy.toml (idle_grace_minutes = 120) instead of the
    // DEFAULT_CONFIG (10) this suite's comments assume. Write an empty config
    // so the temp root resolves to a real, existing file with no [limits]
    // override, and pin LAZY_CONFIG to it to stop the upward walk.
    await writeFile(join(root, 'lazy.toml'), '');
    unpinConfig = pinConfig(root);
  });
  afterEach(async () => {
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('base-reaps an over-grace blocked container: removeRun + clear container_name', async () => {
    const now = Date.now();
    const removed: string[] = [];
    const cleared: string[] = [];
    // Default grace is 10 min (no lazy.toml in temp root → DEFAULT_CONFIG). Idle 30m.
    const storage = fakeStorage({
      tasks: [{ id: 'blk', status: 'blocked', priority: 'normal', created_at: 1 }],
      sessions: { blk: { id: 'sess-blk', container_name: 'lazy-blk', last_interaction_at: now, started_at: now } },
      lastTurnTs: { 'sess-blk': now - 30 * 60_000 },
      cleared,
    });

    await reapIdleContainers(storage, root, fakeRunner(removed));

    expect(removed).toEqual(['lazy-blk']);
    expect(cleared).toEqual(['sess-blk']);
  });

  test('does not reap a fresh in-grace blocked container with no demand', async () => {
    const now = Date.now();
    const removed: string[] = [];
    const cleared: string[] = [];
    const storage = fakeStorage({
      tasks: [{ id: 'blk', status: 'blocked', priority: 'normal', created_at: 1 }],
      sessions: { blk: { id: 'sess-blk', container_name: 'lazy-blk', last_interaction_at: now, started_at: now } },
      lastTurnTs: { 'sess-blk': now - 2 * 60_000 }, // 2 min < 10 min grace
      cleared,
    });

    await reapIdleContainers(storage, root, fakeRunner(removed));

    expect(removed).toEqual([]);
    expect(cleared).toEqual([]);
  });

  test('skips a blocked task with no live container (nothing to reap)', async () => {
    const now = Date.now();
    const removed: string[] = [];
    const cleared: string[] = [];
    const storage = fakeStorage({
      tasks: [{ id: 'blk', status: 'blocked', priority: 'normal', created_at: 1 }],
      sessions: { blk: { id: 'sess-blk', container_name: null, last_interaction_at: now, started_at: now } },
      lastTurnTs: { 'sess-blk': now - 30 * 60_000 },
      cleared,
    });

    await reapIdleContainers(storage, root, fakeRunner(removed));

    expect(removed).toEqual([]);
    expect(cleared).toEqual([]);
  });
});
