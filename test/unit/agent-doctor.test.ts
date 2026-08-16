/**
 * Unit tests for `lazy-agent doctor` (src/agent/doctor.ts).
 *
 * These cover the file-inspection checks, which are the ones a human reads
 * first when an agent has no lazy tools. The live MCP self-test and the daemon
 * round-trip spawn a real server and are exercised end to end instead.
 *
 * HOME is redirected per test so the checks read fixture files rather than the
 * developer's real ~/.claude.json — getHome() reads $HOME.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runAgentDoctor, formatAgentDoctorReport, type DoctorCheck } from '../../src/agent/doctor';

const TOKEN = 'super-secret-daemon-token-value';

function check(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find(c => c.id === id);
  if (!found) throw new Error(`no check with id ${id}`);
  return found;
}

describe('lazy-agent doctor', () => {
  let home: string;
  let configPath: string;
  let prevHome: string | undefined;
  let prevDaemonConfig: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-doctor-home-'));
    configPath = join(home, 'daemon-mcp.json');
    prevHome = process.env.HOME;
    prevDaemonConfig = process.env.LAZY_DAEMON_CONFIG;
    process.env.HOME = home;
    process.env.LAZY_DAEMON_CONFIG = configPath;

    await writeFile(configPath, JSON.stringify({
      token: TOKEN,
      projectRoot: '/repo',
      taskId: 'task-uuid-1',
      target: 'http://host.docker.internal:26024',
    }));
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        lazy: {
          command: 'lazy-agent',
          args: ['mcp', '--daemon-config', configPath, '--task-id', 'task-uuid-1', '--worktree', '/repo'],
        },
      },
    }));
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash', 'mcp__lazy__lazy_status', 'mcp__lazy__lazy_commit'] },
    }));
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDaemonConfig === undefined) delete process.env.LAZY_DAEMON_CONFIG;
    else process.env.LAZY_DAEMON_CONFIG = prevDaemonConfig;
    await rm(home, { recursive: true, force: true });
  });

  // INVARIANT (never-print-the-token): doctor output is meant to be pasted into
  // an issue or a chat. The daemon bearer token is a live credential for this
  // task's identity and must never appear in any surface — text or --json.
  test('never prints the daemon token, in the report or in the JSON', async () => {
    const result = await runAgentDoctor();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(formatAgentDoctorReport(result)).not.toContain(TOKEN);
    // …while still proving it was present, which is what the reader needs.
    expect(check(result.checks, 'daemon-config').detail).toContain('token=present');
  });

  test('reports the config facts a reader needs: project root, task, target', async () => {
    const result = await runAgentDoctor();
    const c = check(result.checks, 'daemon-config');
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('/repo');
    expect(c.detail).toContain('task-uuid-1');
    expect(c.detail).toContain('host.docker.internal');
    expect(result.taskId).toBe('task-uuid-1');
  });

  test('a missing LAZY_DAEMON_CONFIG fails with an actionable remedy', async () => {
    delete process.env.LAZY_DAEMON_CONFIG;
    const result = await runAgentDoctor();
    const c = check(result.checks, 'daemon-config');
    expect(c.ok).toBe(false);
    expect(c.remedy).toBeDefined();
    expect(result.ok).toBe(false);
  });

  test('an unreadable daemon config fails rather than being skipped', async () => {
    await writeFile(configPath, 'not json at all');
    const result = await runAgentDoctor();
    expect(check(result.checks, 'daemon-config').ok).toBe(false);
  });

  test('a missing lazy entry in ~/.claude.json fails and lists what is there', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    const result = await runAgentDoctor();
    const c = check(result.checks, 'claude-json');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('other');
  });

  // A stale entry left by a PREVIOUS task in a reused container is the one
  // shape where the server starts fine — so `claude mcp list` is green — while
  // every call is scoped to the wrong task.
  test('a --task-id that disagrees with this container fails as stale', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        lazy: {
          command: 'lazy-agent',
          args: ['mcp', '--daemon-config', configPath, '--task-id', 'some-other-task', '--worktree', '/repo'],
        },
      },
    }));
    const result = await runAgentDoctor();
    const c = check(result.checks, 'claude-json');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('stale');
  });

  test('a --daemon-config path that does not exist in this container fails', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        lazy: {
          command: 'lazy-agent',
          args: ['mcp', '--daemon-config', join(home, 'missing.json'), '--task-id', 'task-uuid-1', '--worktree', '/repo'],
        },
      },
    }));
    const result = await runAgentDoctor();
    expect(check(result.checks, 'claude-json').ok).toBe(false);
  });

  test('counts the mcp__lazy__* permission entries', async () => {
    const result = await runAgentDoctor();
    const c = check(result.checks, 'tool-permissions');
    expect(c.ok).toBe(true);
    expect(c.data?.lazyAllowCount).toBe(2);
  });

  test('no mcp__lazy__* permissions at all is a failure', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
    const result = await runAgentDoctor();
    expect(check(result.checks, 'tool-permissions').ok).toBe(false);
  });

  // Read-only is a legitimate mode (ask turns), never a failure — but it changes
  // what a healthy tool count looks like, so it has to be reported.
  test('read-only mode is reported, not failed', async () => {
    const prev = process.env.LAZY_MCP_READ_ONLY;
    process.env.LAZY_MCP_READ_ONLY = '1';
    try {
      const result = await runAgentDoctor();
      const c = check(result.checks, 'read-only');
      expect(c.ok).toBe(true);
      expect(c.data?.readOnly).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LAZY_MCP_READ_ONLY;
      else process.env.LAZY_MCP_READ_ONLY = prev;
    }
  });

  // INVARIANT (self-contained-transcript): doctor output gets pasted whole.
  // Without the container id and task at the top, the reader cannot tell which
  // container it came from — which is exactly the confusion it exists to end.
  test('the report identifies the container and the task', async () => {
    const text = formatAgentDoctorReport(await runAgentDoctor());
    expect(text).toContain('lazy-agent doctor — container');
    expect(text).toContain('task: task-uuid-1');
  });
});
