/**
 * INVARIANT: every supervisor path that runs an agent writes the MCP config for
 * THAT turn, first.
 *
 * `~/.claude.json` — where Claude Code discovers MCP servers — is not persisted
 * for a task. The container mounts `<worktree>/.lazy-task-sandbox/.claude` at
 * `/home/user/.claude`, but `/home/user/.claude.json` sits beside that mount on
 * the container's ephemeral filesystem, so a relaunched container starts with no
 * lazy entry at all. Ask was the one agent-running path that never wrote it,
 * which is why asking a long-blocked task anything produced "the lazy MCP tools
 * are currently disconnected".
 *
 * The coverage test at the bottom is the part that keeps this fixed: a new
 * agent-running handler that forgets the call would otherwise fail the same way,
 * silently, and only for tasks whose container had already been reaped.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir, hostname } from 'os';
import { join } from 'path';
import { prepareTurnMcp, McpToolsUnavailableError } from '../../src/supervisor/mcp-setup';
import { READ_ONLY_TOOL_NAMES } from '../../src/mcp/tool-access';
import { allTools } from '../../src/mcp/tools';
import type { Runner } from '../../src/runner/types';

/**
 * A Runner stub that only answers mcpServerConfig — the one method under test.
 * Everything else stays unimplemented on purpose: a call to any of it would be
 * a change in what this seam does, and should fail loudly.
 */
function stubRunner(record: { opts?: { readOnly?: boolean }; taskId?: string }): Runner {
  return {
    mcpServerConfig(taskId: string, worktreePath: string, opts?: { readOnly?: boolean }) {
      record.opts = opts;
      record.taskId = taskId;
      return {
        command: 'lazy-agent',
        args: ['mcp', '--task-id', taskId, '--worktree', worktreePath, ...(opts?.readOnly ? ['--read-only'] : [])],
      };
    },
  } as unknown as Runner;
}

const silent = { info: () => {}, warn: () => {} };

describe('prepareTurnMcp', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-mcp-setup-'));
    originalHome = process.env.HOME;
    // writeMcpConfig/writeToolPermissions resolve $HOME via getHome(); pointing
    // it at a temp dir keeps the test off the developer's real ~/.claude.json.
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  async function readConfig() {
    return JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8'));
  }
  async function readAllowList(): Promise<string[]> {
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf-8'));
    return settings.permissions.allow as string[];
  }

  test('a write turn gets the full toolset and no --read-only', async () => {
    const record: { opts?: { readOnly?: boolean } } = {};
    await prepareTurnMcp(stubRunner(record), 'abcdef1234', '/wt', { readOnly: false }, silent);

    expect(record.opts).toEqual({ readOnly: false });
    const config = await readConfig();
    expect(config.mcpServers.lazy.command).toBe('lazy-agent');
    expect(config.mcpServers.lazy.args).not.toContain('--read-only');

    const allow = await readAllowList();
    expect(allow.sort()).toEqual(allTools.map(t => `mcp__lazy__${t.name}`).sort());
  });

  test('a read-only turn asks the runner for a --read-only server and approves only reads', async () => {
    const record: { opts?: { readOnly?: boolean } } = {};
    await prepareTurnMcp(stubRunner(record), 'abcdef1234', '/wt', { readOnly: true }, silent);

    // The flag must reach the ARGS: under the daemon proxy the handlers execute
    // in the daemon, so only the in-container server can withhold a write tool.
    expect(record.opts).toEqual({ readOnly: true });
    const config = await readConfig();
    expect(config.mcpServers.lazy.args).toContain('--read-only');

    const allow = await readAllowList();
    expect(allow.sort()).toEqual([...READ_ONLY_TOOL_NAMES].map(n => `mcp__lazy__${n}`).sort());
    expect(allow).not.toContain('mcp__lazy__lazy_commit');
  });

  // INVARIANT (cursor-first-class-agent): a cursor turn must get the lazy MCP
  // server in ~/.cursor/mcp.json — cursor-agent never reads ~/.claude.json, so
  // without this file the cursor agent runs with NO lazy tools at all.
  test('a cursor turn additionally writes ~/.cursor/mcp.json', async () => {
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false, agentId: 'cursor' }, silent);

    const cursorConfig = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.lazy.command).toBe('lazy-agent');
    // The claude config is still written — in-container merge turns run claude.
    expect((await readConfig()).mcpServers.lazy).toBeDefined();
  });

  test('a claude turn does not create ~/.cursor/mcp.json', async () => {
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false }, silent);
    expect(await Bun.file(join(home, '.cursor', 'mcp.json')).exists()).toBe(false);
  });

  test('cursor mcp.json write preserves other servers', async () => {
    await Bun.write(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { agentId: 'cursor' }, silent);

    const cursorConfig = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.other).toEqual({ command: 'x' });
    expect(cursorConfig.mcpServers.lazy).toBeDefined();
  });

  test('preserves other MCP servers already in the config', async () => {
    await Bun.write(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', {}, silent);

    const config = await readConfig();
    expect(config.mcpServers.other).toEqual({ command: 'x' });
    expect(config.mcpServers.lazy).toBeDefined();
  });

  // INVARIANT (fix-mcp-config-swallow-and-legacy-purge): a turn that could not
  // register the lazy tools must NOT silently proceed. This assertion is the
  // deliberate REVERSAL of the earlier "a failure is logged, not thrown — a turn
  // without lazy tools still runs". That swallow is what made a real incident
  // undiagnosable for days: an agent ran a full turn with zero lazy_* tools and
  // the only trace was one warn line inside a container. An agent without lazy
  // tools cannot read task history, record follow-ups, or reach any lazy state,
  // so the turn is broken rather than degraded. Do not restore the swallow.
  test('a config failure throws — a turn without lazy tools must not run', async () => {
    const broken = {
      mcpServerConfig() { throw new Error('runner exploded'); },
    } as unknown as Runner;

    await expect(
      prepareTurnMcp(broken, 'abcdef1234', '/wt', {}, silent),
    ).rejects.toThrow(McpToolsUnavailableError);
  });

  test('the failure names the task, the host, the scope and the cause', async () => {
    const broken = {
      mcpServerConfig() { throw new Error('LAZY_DAEMON_CONFIG not set'); },
    } as unknown as Runner;

    const err = await prepareTurnMcp(broken, 'abcdef1234', '/wt', {}, silent).then(
      () => { throw new Error('expected prepareTurnMcp to reject'); },
      (e: unknown) => e as Error,
    );

    // Actionable per CLAUDE.md: not just "MCP config failed".
    expect(err.message).toContain('abcdef12');            // which task
    expect(err.message).toContain(hostname());            // which container/host
    expect(err.message).toContain('LAZY_DAEMON_CONFIG');  // what was missing
    expect(err.message).toContain('write');               // which turn scope
  });

  // The deliberate asymmetry: losing PERMISSIONS is degraded-but-working (tools
  // are registered and callable, the agent is merely prompted), so it stays
  // non-fatal while a missing config fails the turn. See prepareTurnMcp.
  test('a tool-permissions failure is logged, not thrown', async () => {
    const warnings: string[] = [];
    // Make ~/.claude a FILE so writeToolPermissions cannot create the directory,
    // while the MCP config write (which targets ~/.claude.json) still succeeds.
    await rm(join(home, '.claude'), { recursive: true, force: true });
    await Bun.write(join(home, '.claude'), 'not a directory');

    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', {}, {
      info: () => {}, warn: m => warnings.push(m),
    });

    expect(warnings.join('\n')).toContain('tool permissions');
    // The config half still landed — the two halves are independent.
    expect((await readConfig()).mcpServers.lazy).toBeDefined();
  });
});

describe('supervisor MCP coverage', () => {
  test('every agent-running command handler calls prepareTurnMcp', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'supervisor', 'index.ts'),
      'utf-8',
    );

    // Handlers that launch Claude Code on the task. Ask and pre-accept were both
    // missing this call; a fresh handler must not repeat that.
    const handlers = [
      'handleTurnCommand',
      'handleSyncCommand',
      'handleAskCommand',
      'handlePreAcceptCommand',
    ];

    for (const name of handlers) {
      const start = source.indexOf(`async function ${name}(`);
      expect(start, `${name} not found — rename it here too`).toBeGreaterThan(-1);
      const next = handlers
        .map(h => source.indexOf(`async function ${h}(`))
        .filter(idx => idx > start);
      const end = next.length ? Math.min(...next) : source.length;
      const body = source.slice(start, end);
      expect(body.includes('prepareTurnMcp('), `${name} must call prepareTurnMcp`).toBe(true);
    }
  });

  test('ask is the read-only turn', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'supervisor', 'index.ts'),
      'utf-8',
    );
    const start = source.indexOf('async function handleAskCommand(');
    const body = source.slice(start, start + 6000);
    expect(body).toContain('prepareTurnMcp(runner, cmd.task_id, worktreePath, { readOnly: true, agentId: cmd.agent_id })');
  });
});
