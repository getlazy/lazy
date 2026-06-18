/**
 * Unit tests for runner-driven agent session-log discovery.
 *
 * INVARIANT (encoded by this block): each runner is the single source of truth
 * for where ITS agent writes Claude Code session JSONL, and the shared
 * `findLatestSessionFile` helper scans whatever directory the runner names.
 * A regression where discovery hard-codes the sandbox location makes
 * `lazy watch` (and the activity monitor) show NO agent output for host-runner
 * tasks — the bug this suite guards against.
 *
 *   - sandbox runners (docker/podman): <worktree>/.lazy-task-sandbox/.claude/projects/<encoded>
 *   - host-process runner:             <host-home>/.claude/projects/<encoded>
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findLatestSessionFile } from '../../src/agent/session-discovery';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { createRunnerFromType } from '../../src/runner';

// ── Runners own their session-log location ────────────────────────────────

describe('Runner.agentSessionProjectDir', () => {
  let worktree: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-disc-wt-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-disc-home-'));
    // HostProcessRunner resolves HOME via getHome() → process.env.HOME first.
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test('docker (sandbox) runner resolves to the in-worktree sandbox dir', () => {
    const runner = createRunnerFromType('docker');
    const encoded = encodeProjectPath(worktree);
    expect(runner.agentSessionProjectDir(worktree)).toBe(
      join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded),
    );
  });

  test('podman runner inherits the sandbox location', () => {
    const runner = createRunnerFromType('podman');
    const encoded = encodeProjectPath(worktree);
    expect(runner.agentSessionProjectDir(worktree)).toBe(
      join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encoded),
    );
  });

  test('host-process runner resolves to the real host home', () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    const encoded = encodeProjectPath(worktree);
    expect(runner.agentSessionProjectDir(worktree)).toBe(
      join(fakeHome, '.claude', 'projects', encoded),
    );
  });
});

// ── Discovery scans the runner-named directory ────────────────────────────

describe('findLatestSessionFile', () => {
  let worktree: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-disc2-wt-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-disc2-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  // Docker/sandbox runner: JSONL lives under the worktree's sandbox HOME.
  test('discovers the session via a docker runner dir', async () => {
    const runner = createRunnerFromType('docker');
    const projDir = runner.agentSessionProjectDir(worktree);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'docker-session.jsonl'), '{"type":"system"}\n', 'utf-8');

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('docker-session');
    expect(info?.path).toBe(join(projDir, 'docker-session.jsonl'));
  });

  // Host-process runner: JSONL lives under the real host HOME, NOT the sandbox.
  // This is the case the original bug missed entirely.
  test('discovers the session via a host-process runner dir', async () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    const projDir = runner.agentSessionProjectDir(worktree);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'host-session.jsonl'), '{"type":"system"}\n', 'utf-8');

    // Sanity: this is the host home, not the sandbox.
    expect(projDir.startsWith(fakeHome)).toBe(true);

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('host-session');
    expect(info?.path).toBe(join(projDir, 'host-session.jsonl'));
  });

  test('returns the most recently modified file in the dir', async () => {
    const projDir = join(worktree, 'proj');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'older.jsonl'), '{}\n', 'utf-8');
    await Bun.sleep(20);
    await writeFile(join(projDir, 'newer.jsonl'), '{}\n', 'utf-8');

    const info = await findLatestSessionFile(projDir);
    expect(info?.sessionId).toBe('newer');
  });

  test('returns null when the directory does not exist', async () => {
    const info = await findLatestSessionFile(join(worktree, 'nope'));
    expect(info).toBeNull();
  });

  test('returns null when the directory holds no JSONL', async () => {
    const projDir = join(worktree, 'empty');
    await mkdir(projDir, { recursive: true });
    const info = await findLatestSessionFile(projDir);
    expect(info).toBeNull();
  });

  test('honors the minMtimeMs cutoff', async () => {
    const projDir = join(worktree, 'proj');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'stale.jsonl'), '{}\n', 'utf-8');

    // Cutoff in the future — the only file on disk is older, so nothing matches.
    const info = await findLatestSessionFile(projDir, Date.now() + 60_000);
    expect(info).toBeNull();
  });
});
