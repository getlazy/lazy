/**
 * INVARIANT: the protocol dir is mounted inside the supervisor container at a
 * fixed top-level path, never at its host path, and the wrapper script points
 * lazy-agent at that container path. The host path is `~/.lazy/protocol/<id>`
 * of whoever runs the daemon; as root (a Linux self-host, the daemon image
 * inside a fleet microVM) that is under `/root`, mode 0700 in the runner
 * image, which the container's unprivileged user cannot traverse — so the
 * supervisor never saw command.json and waited for ever (fleet demo runs 5
 * and 6, 2026-09-21). A Mac's user home hid it.
 */

import { describe, test, expect } from 'bun:test';
import { buildSupervisorDockerArgs, buildSupervisorWrapperScript, containerProtocolDir } from '../../src/capture/claude';

describe('containerProtocolDir', () => {
  test('is a fixed top-level path keyed by the task dir name', () => {
    expect(containerProtocolDir('/root/.lazy/protocol/abc-123')).toBe('/lazy-protocol/abc-123');
    expect(containerProtocolDir('/Users/me/.lazy/protocol/abc-123')).toBe('/lazy-protocol/abc-123');
  });

  test('the mount lands there, and lazy-agent is told that path, not the host one', () => {
    const host = '/root/.lazy/protocol/abc-123';
    const worktree = '/repo/.lazy/worktrees/t';
    const args = buildSupervisorDockerArgs({
      binary: 'docker',
      containerName: 'c',
      imageName: 'img',
      repoRoot: '/repo',
      sandbox: { permission_mode: 'bypass', worktreePath: worktree, sandboxPath: `${worktree}/.lazy-task-sandbox` } as never,
      protocolDir: host,
      agentBinaryPath: '/bin/lazy-agent-x',
      authEnvVars: [],
      taskEnvArgs: [],
      customMountArgs: [],
      gitMountArgs: [],
      publishArgs: [],
      runArgs: [],
      wrapperScript: buildSupervisorWrapperScript(containerProtocolDir(host), worktree),
    });
    const mounts = args.filter((_, i) => args[i - 1] === '-v');
    expect(mounts).toContain(`${host}:/lazy-protocol/abc-123`);
    expect(mounts.some((m) => m.endsWith(`:${host}`))).toBe(false);
    const script = args[args.length - 1]!;
    expect(script).toContain('--protocol-dir "/lazy-protocol/abc-123"');
    expect(script).not.toContain(`--protocol-dir "${host}"`);
  });
});

// INVARIANT: a root-run daemon makes the task's protocol dir writable by the
// container's unprivileged user; a non-root daemon leaves the mode alone. The
// supervisor writes response.json and status.json there and deletes
// command.json; root-owned 0755 refused all three (fleet demo run 7, EACCES in
// writeResponse). The dir's ancestor is root's 0700 home, so 0777 exposes it to
// nobody on the host but root.
describe('protocolDirModeFor', () => {
  test('root gets a world-writable mailbox, everyone else the default', async () => {
    const { protocolDirModeFor } = await import('../../src/protocol/io');
    expect(protocolDirModeFor(0)).toBe(0o777);
    expect(protocolDirModeFor(1000)).toBeNull();
    expect(protocolDirModeFor(undefined)).toBeNull();
  });
});

// INVARIANT: before every turn the wrapper takes ownership of each mounted
// path the container user cannot write — the mailbox, the worktree, its
// gitdir, the shared objects dir and the sandbox's agent files — and only
// those. A root-run daemon on native Linux leaves them all root-owned (fleet
// demo run 8: the MCP config could not be written), while `find -writable`
// finds nothing to adopt on a Mac, where Docker Desktop maps ownership.
describe('the wrapper adopts what it cannot write', () => {
  test('lists the mailbox, the worktree, both git dirs and the sandbox files, before lazy-agent starts', async () => {
    const { supervisorWritablePaths } = await import('../../src/capture/claude');
    const paths = supervisorWritablePaths({
      protocolDir: '/lazy-protocol/abc', worktreePath: '/repo/.lazy/worktrees/t',
      objectsDir: '/repo/.git/objects', worktreeGitDir: '/repo/.git/worktrees/t',
    });
    expect(paths).toEqual([
      '/lazy-protocol/abc', '/repo/.lazy/worktrees/t', '/repo/.git/worktrees/t', '/repo/.git/objects',
      '/home/user/.claude.json', '/home/user/.claude', '/home/user/.pi', '/home/user/.codex', '/home/user/.cursor',
    ]);
    const script = buildSupervisorWrapperScript('/lazy-protocol/abc', '/repo/.lazy/worktrees/t', paths);
    expect(script).toContain('find "$p" ! -writable -print -quit');
    expect(script).toContain('sudo -n chown -R "$(id -u):$(id -g)" "$p"');
    expect(script.indexOf('adopt "/lazy-protocol/abc" "/repo/.lazy/worktrees/t"')).toBeLessThan(script.indexOf('lazy-agent --one-shot'));
  });

  test('with no paths the loop is unchanged', () => {
    expect(buildSupervisorWrapperScript('/p', '/w')).not.toContain('  adopt ');
  });
});

// INVARIANT: the per-task MCP config (a bearer credential mounted read-only
// into one container) stays 0600 for a non-root daemon and becomes 0644 under
// a root daemon, whose container user could not open it otherwise (fleet demo
// run 9). Same rule as the mailbox: root's base dir is reachable by root and
// that container alone.
describe('containerHandoffFileModeFor', () => {
  test('0644 for root, 0600 for everyone else', async () => {
    const { containerHandoffFileModeFor } = await import('../../src/protocol/io');
    expect(containerHandoffFileModeFor(0)).toBe(0o644);
    expect(containerHandoffFileModeFor(1000)).toBe(0o600);
    expect(containerHandoffFileModeFor(undefined)).toBe(0o600);
  });
});
