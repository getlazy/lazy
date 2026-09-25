/**
 * In-container pairing (`pair-in-container`) — the argv contract between the
 * host half (`lazy pair`, src/cli/commands/pair-container.ts) and the
 * in-container half (`lazy-agent pair`, src/supervisor/pair.ts).
 *
 * These are the pieces that cannot be exercised without docker, so they are
 * kept pure and asserted here: the exec argv, the pidfile location the reach-in
 * stop depends on, and each pairing-capable agent's interactive argv.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { buildPairExecArgs, stopOrphanedContainerPair } from '../../src/cli/commands/pair-container';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { SANDBOX_DIR } from '../../src/utils/sandbox';
import { pairPidFilePath } from '../../src/supervisor/pair';
import { getAgent } from '../../src/agent/registry';
import { CURSOR_ENDPOINT_ENV } from '../../src/proxy/cursor-route';

const BASE = {
  binary: 'docker',
  containerName: 'lazy-task-abc123',
  taskId: '11111111-2222-3333-4444-555555555555',
  worktreePath: '/repo/.lazy/worktrees/some-task',
  harness: 'claude-code',
  runnerType: 'docker',
  tty: true,
};

describe('buildPairExecArgs', () => {
  test('execs lazy-agent pair in the task container with the full task id', () => {
    const argv = buildPairExecArgs(BASE);
    expect(argv.slice(0, 4)).toEqual(['docker', 'exec', '-i', '-t']);
    // The container name is the argument right before the command.
    const cmdAt = argv.indexOf('lazy-agent');
    expect(argv[cmdAt - 1]).toBe(BASE.containerName);
    expect(argv[cmdAt + 1]).toBe('pair');
    // The MCP server inside the container is scoped by FULL task id, never the
    // short display id — a short id there yields a session with no lazy tools.
    expect(argv[argv.indexOf('--task-id') + 1]).toBe(BASE.taskId);
    expect(argv[argv.indexOf('--worktree') + 1]).toBe(BASE.worktreePath);
    expect(argv[argv.indexOf('--agent') + 1]).toBe('claude-code');
    expect(argv[argv.indexOf('--runner') + 1]).toBe('docker');
  });

  test('omits -t when there is no terminal, but always keeps -i', () => {
    const argv = buildPairExecArgs({ ...BASE, tty: false });
    expect(argv).not.toContain('-t');
    expect(argv[2]).toBe('-i');
  });

  test('optional flags appear only when asked for', () => {
    const bare = buildPairExecArgs(BASE);
    expect(bare).not.toContain('--resume');
    expect(bare).not.toContain('--model');
    expect(bare).not.toContain('--autonomous');

    const full = buildPairExecArgs({
      ...BASE,
      sessionId: 'sess-1',
      modelId: 'opus',
      autonomous: true,
    });
    expect(full[full.indexOf('--resume') + 1]).toBe('sess-1');
    expect(full[full.indexOf('--model') + 1]).toBe('opus');
    expect(full).toContain('--autonomous');
  });

  // A null session id is the "no session to resume" case, not a session named
  // "null" — passing --resume null makes the agent exit immediately.
  test('a null session id passes no --resume', () => {
    expect(buildPairExecArgs({ ...BASE, sessionId: null })).not.toContain('--resume');
  });

  // The auth env must reach docker as `-e` pairs BEFORE the container name:
  // after it, docker treats them as arguments to the command instead.
  test('env is passed with -e ahead of the container name', () => {
    const argv = buildPairExecArgs({
      ...BASE,
      env: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:41234' },
    });
    const eAt = argv.indexOf('-e');
    expect(argv[eAt + 1]).toBe('ANTHROPIC_BASE_URL=http://host.docker.internal:41234');
    expect(eAt).toBeLessThan(argv.indexOf(BASE.containerName));
  });

  test('podman is driven with the same argv shape', () => {
    const argv = buildPairExecArgs({ ...BASE, binary: 'podman', runnerType: 'podman' });
    expect(argv[0]).toBe('podman');
    expect(argv[argv.indexOf('--runner') + 1]).toBe('podman');
  });

  // Web Pair/Chat reuse this argv over the shell WebSocket. Chat must pass
  // --chat so the in-container process is a reflective conversation, not a
  // pairing takeover (no lock, no model/effort change).
  test('chat mode adds --chat and pairing does not', () => {
    expect(buildPairExecArgs(BASE)).not.toContain('--chat');
    expect(buildPairExecArgs({ ...BASE, chat: true })).toContain('--chat');
  });
});

describe('pairPidFilePath', () => {
  // Both halves compute this from the worktree path, and the sandbox dir is the
  // one directory mounted at the same path on both sides — that is what lets
  // the host read a pid written inside the container. It is also gitignored, so
  // a live pairing session never dirties the task's diff.
  test('lives in the task sandbox dir, which is shared and gitignored', () => {
    expect(pairPidFilePath('/repo/wt')).toBe(join('/repo/wt', '.lazy-task-sandbox', 'pair-session.pid'));
  });
});

describe('buildInteractiveArgs', () => {
  const originalEndpoint = process.env[CURSOR_ENDPOINT_ENV];
  afterEach(() => {
    if (originalEndpoint === undefined) delete process.env[CURSOR_ENDPOINT_ENV];
    else process.env[CURSOR_ENDPOINT_ENV] = originalEndpoint;
  });

  test('claude-code: interactive, never headless', () => {
    const argv = getAgent('claude-code').buildInteractiveArgs({
      sessionId: 'sess-1',
      modelId: 'opus',
      dangerouslySkipPermissions: true,
    });
    expect(argv).toEqual(['claude', '--resume', 'sess-1', '--dangerously-skip-permissions', '--model', 'opus']);
    // -p / --output-format would make it a machine turn, not a pairing session.
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--output-format');
  });

  test('claude-code: permissions stay on unless autonomous was asked for', () => {
    const argv = getAgent('claude-code').buildInteractiveArgs({ modelId: 'test-model', dangerouslySkipPermissions: false });
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  // SECURITY (fix-cursor-security-musts): --force disables approvals AND
  // Cursor's own sandbox. It is only acceptable because this argv is built and
  // run INSIDE the task container — the same trust decision as a supervised
  // turn. It must never appear without an explicit --autonomous.
  test('cursor: --force only under autonomous', () => {
    const cursor = getAgent('cursor');
    expect(cursor.buildInteractiveArgs({ modelId: 'test-model', dangerouslySkipPermissions: false })).not.toContain('--force');
    const forced = cursor.buildInteractiveArgs({ modelId: 'test-model', dangerouslySkipPermissions: true });
    expect(forced).toContain('--force');
    expect(forced!.slice(forced!.indexOf('--sandbox'), forced!.indexOf('--sandbox') + 2))
      .toEqual(['--sandbox', 'disabled']);
  });

  test('cursor: resumes and pins a model, and is never headless', () => {
    const argv = getAgent('cursor').buildInteractiveArgs({
      sessionId: 'chat-1',
      modelId: 'sonnet-4.5',
      dangerouslySkipPermissions: false,
    })!;
    expect(argv[0]).toBe('cursor-agent');
    expect(argv).toContain('--trust');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('chat-1');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet-4.5');
    expect(argv).not.toContain('--print');
    // --approve-mcps is deliberately never passed (see buildExecArgs).
    expect(argv).not.toContain('--approve-mcps');
  });

  // The endpoint is read where the argv is BUILT, which for pairing is inside
  // the container — so a container-reachable proxy address wins.
  test('cursor: forwards the agent endpoint from its own environment', () => {
    process.env[CURSOR_ENDPOINT_ENV] = 'http://127.0.0.1:9999';
    const argv = getAgent('cursor').buildInteractiveArgs({ modelId: 'test-model', dangerouslySkipPermissions: false })!;
    expect(argv[argv.indexOf('--agent-endpoint') + 1]).toBe('http://127.0.0.1:9999');
  });

  // An agent that cannot be paired with declares that by returning null, and
  // `lazy pair` refuses on supportsPairing() long before reaching a container.
  test('qa-agent has no interactive mode', () => {
    expect(getAgent('qa-agent').buildInteractiveArgs({ modelId: 'test-model', dangerouslySkipPermissions: false })).toBeNull();
    expect(getAgent('qa-agent').supportsPairing()).toBe(false);
  });
});

describe('stopOrphanedContainerPair (the --unlock reach-in)', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  // INVARIANT (pair-in-container): the pidfile is the ONLY trigger for reaching
  // into the container. Without one there is no evidence an in-container session
  // was ever orphaned, and --unlock must not call ensureTaskContainer — that
  // would START a stopped container purely to hunt for a process which, the
  // container being stopped, cannot exist. A bogus task id proves the daemon was
  // never contacted: if it were, resolving that id would fail loudly.
  test('no pidfile: returns false without touching the daemon or the container', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-unlock-nopid-'));
    mkdirSync(join(tempDir, SANDBOX_DIR), { recursive: true });

    const reached = await stopOrphanedContainerPair('no-such-task-id', tempDir);

    expect(reached).toBe(false);
  });

  // A pidfile whose contents are not a pid is unusable — there is nothing to
  // signal — but leaving it in place would make every later --unlock reach into
  // the container for a process that was never identified. Clear it.
  test('unusable pidfile: returns false and clears the file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-unlock-badpid-'));
    mkdirSync(join(tempDir, SANDBOX_DIR), { recursive: true });
    const pidFile = pairPidFilePath(tempDir);
    writeFileSync(pidFile, 'not-a-pid\n');

    const reached = await stopOrphanedContainerPair('no-such-task-id', tempDir);

    expect(reached).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });
});
