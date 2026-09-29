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
          args: ['mcp', '--daemon-config', configPath, '--task-id', 'task-uuid-1', '--worktree', home],
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
          args: ['mcp', '--daemon-config', configPath, '--task-id', 'some-other-task', '--worktree', home],
        },
      },
    }));
    const result = await runAgentDoctor();
    const c = check(result.checks, 'claude-json');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('stale');
  });

  // INVARIANT: an entry another process wrote over this session's is named as
  // such. Claude Code reads one ~/.claude.json per HOME; on 2026-09-28 a leaked
  // test `lazy mcp` overwrote a builder's entry, and every lazy tool said
  // "Daemon is not running" against a healthy daemon. The remedy must name the
  // stray process and how the entry comes back.
  describe('an entry another process wrote', () => {
    let prevScratch: string | undefined;
    beforeEach(() => {
      prevScratch = process.env.LAZY_SCRATCH_DIR;
    });
    afterEach(() => {
      if (prevScratch === undefined) delete process.env.LAZY_SCRATCH_DIR;
      else process.env.LAZY_SCRATCH_DIR = prevScratch;
    });

    /** A builder container: scratch dir set, no LAZY_DAEMON_CONFIG. */
    function becomeBuilder(): void {
      delete process.env.LAZY_DAEMON_CONFIG;
      process.env.LAZY_SCRATCH_DIR = home;
    }

    test('the incident: a task-scoped server on a builder is flagged even when its worktree exists', async () => {
      becomeBuilder();
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { lazy: { command: 'bun', args: ['/tmp/x/src/index.ts', 'mcp', '--task-id', '605e9a6b', '--worktree', home] } },
      }));
      const result = await runAgentDoctor();
      const c = check(result.checks, 'claude-json');
      expect(c.ok).toBe(false);
      expect(c.detail).toContain('on a builder session');
      expect(c.detail).toContain('no --daemon-config');
      expect(c.remedy).toContain('Another process overwrote this entry');
      // The builder's own config arrives as argv, so its absence from env is not a failure.
      expect(check(result.checks, 'daemon-config').ok).toBe(true);
    });

    test("a builder's own entry passes", async () => {
      becomeBuilder();
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', configPath, '--worktree', home] } },
      }));
      expect(check((await runAgentDoctor()).checks, 'claude-json').ok).toBe(true);
    });

    test('a vanished --worktree is flagged, with the path in the remedy', async () => {
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', configPath, '--task-id', 'task-uuid-1', '--worktree', '/tmp/lazy-poc-gone/poc-demo'] } },
      }));
      const c = check((await runAgentDoctor()).checks, 'claude-json');
      expect(c.ok).toBe(false);
      expect(c.detail).toContain("--worktree '/tmp/lazy-poc-gone/poc-demo' does not exist");
      expect(c.remedy).toContain('--worktree /tmp/lazy-poc-gone/poc-demo');
    });

    test("a --daemon-config other than this session's is flagged", async () => {
      const other = join(home, 'other.json');
      await writeFile(other, '{}');
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', other, '--task-id', 'task-uuid-1', '--worktree', home] } },
      }));
      const c = check((await runAgentDoctor()).checks, 'claude-json');
      expect(c.ok).toBe(false);
      expect(c.detail).toContain("is not this session's config");
    });

    // A host-process task's entry legitimately has no --daemon-config: it runs
    // tools in-process. Flagging it would send a human after a process that
    // does not exist.
    test("a host-process task's own entry passes", async () => {
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--task-id', 'task-uuid-1', '--worktree', home] } },
      }));
      expect(check((await runAgentDoctor()).checks, 'claude-json').ok).toBe(true);
    });
  });

  test('a --daemon-config path that does not exist in this container fails', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        lazy: {
          command: 'lazy-agent',
          args: ['mcp', '--daemon-config', join(home, 'missing.json'), '--task-id', 'task-uuid-1', '--worktree', home],
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

  // INVARIANT: in a member's own terminal container — no lazy MCP server, no
  // daemon config, no lazy tool permissions, all by design — doctor says it is
  // a member session and shows those checks as not applicable, never as
  // failures a member would read as a broken install.
  test('a member terminal session is named, and its absent MCP is not a failure', async () => {
    delete process.env.LAZY_DAEMON_CONFIG;
    await rm(join(home, '.claude.json'));
    await writeFile(join(home, '.claude', 'settings.json'), '{}\n');
    await writeFile(join(home, '.claude', 'lazy-member-session'), 'member\n');
    const result = await runAgentDoctor();
    expect(result.ok).toBe(true);
    expect(result.memberSession).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual(['daemon-config', 'claude-json', 'tool-permissions']);
    for (const c of result.checks) expect(c.data?.notApplicable).toBe(true);
    const text = formatAgentDoctorReport(result);
    expect(text).toContain('member terminal session: no MCP, no daemon config by design');
    expect(text).not.toContain('✗');
    expect(text).not.toContain('builder or project-wide mode');
  });

  // INVARIANT: the marker alone never turns doctor off — a task container's
  // home is agent-writable, and it always has LAZY_DAEMON_CONFIG.
  test('a marker in a container that has a daemon config runs the normal checks', async () => {
    await writeFile(join(home, '.claude', 'lazy-member-session'), 'member\n');
    const result = await runAgentDoctor();
    expect(result.memberSession).toBeUndefined();
    expect(check(result.checks, 'daemon-config').data?.notApplicable).toBeUndefined();
  }, 60_000);
});
