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
import { MCP_EXPECTED_TASK_ID_ENV, MCP_EXPECTED_WORKTREE_ENV } from '../../src/mcp/turn-identity';
import { toolNamesForRole } from '../../src/mcp/tool-surface';
// Imported for the independent re-derivations below — toolNamesForRole is the
// function under test here, so it cannot also be the only source of truth.
import { allTools } from '../../src/mcp/tools';
import { READ_ONLY_TOOL_NAMES } from '../../src/mcp/tool-access';
import { BUILDER_ONLY_TOOL_NAMES } from '../../src/mcp/tool-roles';
import type { Runner } from '../../src/runner/types';

/**
 * A Runner stub that only answers mcpServerConfig — the one method under test.
 * Everything else stays unimplemented on purpose: a call to any of it would be
 * a change in what this seam does, and should fail loudly.
 */
function stubRunner(record: {
  opts?: { readOnly?: boolean; review?: boolean; toolset?: 'full' | 'read' | 'review' };
  taskId?: string;
}): Runner {
  return {
    mcpServerConfig(
      taskId: string,
      worktreePath: string,
      opts?: { readOnly?: boolean; review?: boolean; toolset?: 'full' | 'read' | 'review' },
    ) {
      record.opts = opts;
      record.taskId = taskId;
      const toolset = opts?.toolset
        ?? (opts?.review ? 'review' : opts?.readOnly ? 'read' : 'full');
      const flag =
        toolset === 'review' ? ['--review'] :
        toolset === 'read' ? ['--read-only'] :
        [];
      return {
        command: 'lazy-agent',
        args: ['mcp', '--task-id', taskId, '--worktree', worktreePath, ...flag],
      };
    },
  } as unknown as Runner;
}

const silent = { info: () => {}, warn: () => {} };

describe('prepareTurnMcp', () => {
  let home: string;
  let originalHome: string | undefined;
  let originalTurnEnv: Array<[string, string | undefined]> = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-mcp-setup-'));
    originalHome = process.env.HOME;
    // writeMcpConfig/writeToolPermissions resolve $HOME via getHome(); pointing
    // it at a temp dir keeps the test off the developer's real ~/.claude.json.
    process.env.HOME = home;
    // prepareTurnMcp declares this turn's identity on process.env, and one
    // process.env is shared by every test FILE in a bun test run. Leaking these
    // would make a later suite's `lazy-agent mcp` subprocess refuse to start
    // (it checks its own --task-id against them) — the same cross-file env leak
    // class CLAUDE.md documents for LAZY_TEST / LAZY_IS_DAEMON.
    originalTurnEnv = [MCP_EXPECTED_TASK_ID_ENV, MCP_EXPECTED_WORKTREE_ENV].map(
      k => [k, process.env[k]] as [string, string | undefined],
    );
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const [key, value] of originalTurnEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  async function readConfig() {
    return JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8'));
  }
  async function readAllowList(): Promise<string[]> {
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf-8'));
    return settings.permissions.allow as string[];
  }

  // INVARIANT: the pre-approved tool list is the AGENT role's list, not every
  // tool that exists. Pre-approving a builder-only tool (lazy_memory_save,
  // lazy_raised_promote, …) would tell the agent's harness a tool is available
  // that the server does not advertise and the handler refuses.
  test('a write turn gets the agent toolset and no --read-only', async () => {
    const record: { opts?: { toolset?: 'full' | 'read' | 'review' } } = {};
    await prepareTurnMcp(stubRunner(record), 'abcdef1234', '/wt', { readOnly: false }, silent);

    expect(record.opts).toEqual({ toolset: 'full' });
    const config = await readConfig();
    expect(config.mcpServers.lazy.command).toBe('lazy-agent');
    expect(config.mcpServers.lazy.args).not.toContain('--read-only');
    expect(config.mcpServers.lazy.args).not.toContain('--review');

    const allow = await readAllowList();
    expect(allow.sort()).toEqual(toolNamesForRole('agent').map(n => `mcp__lazy__${n}`).sort());
    expect(allow).not.toContain('mcp__lazy__lazy_memory_save');

    // Independent anchor: the line above compares against the same function
    // prepareTurnMcp itself calls, so the two agree even if that function is
    // broken — a collapsed or empty list would satisfy it vacuously. Re-derive
    // the size from constants the function does not produce.
    expect(allow).toHaveLength(allTools.length - BUILDER_ONLY_TOOL_NAMES.length);
    for (const name of ['lazy_commit', 'lazy_raise', 'lazy_report', 'lazy_show']) {
      expect(allow).toContain(`mcp__lazy__${name}`);
    }
  });

  test('a read-only turn asks the runner for a --read-only server and approves only reads', async () => {
    const record: { opts?: { toolset?: 'full' | 'read' | 'review' } } = {};
    await prepareTurnMcp(stubRunner(record), 'abcdef1234', '/wt', { readOnly: true }, silent);

    // The flag must reach the ARGS: under the daemon proxy the handlers execute
    // in the daemon, so only the in-container server can withhold a write tool.
    expect(record.opts).toEqual({ toolset: 'read' });
    const config = await readConfig();
    expect(config.mcpServers.lazy.args).toContain('--read-only');
    expect(config.mcpServers.lazy.args).not.toContain('--review');

    const allow = await readAllowList();
    expect(allow.sort()).toEqual(
      toolNamesForRole('agent', { toolset: 'read' }).map(n => `mcp__lazy__${n}`).sort(),
    );
    // Same independent re-derivation as the write turn: read-only ∩ agent role,
    // built from the two constants rather than from the function under test.
    expect(allow.sort()).toEqual(
      [...READ_ONLY_TOOL_NAMES]
        .filter(n => !BUILDER_ONLY_TOOL_NAMES.includes(n))
        .map(n => `mcp__lazy__${n}`)
        .sort(),
    );
    expect(allow).not.toContain('mcp__lazy__lazy_commit');
    expect(allow).not.toContain('mcp__lazy__lazy_raise');
    // Read-only narrows on top of the role, not instead of it: lazy_scratch is
    // a READ, but it is builder-only, so an agent's ask turn never sees it.
    expect(allow).not.toContain('mcp__lazy__lazy_scratch');
  });

  test('a review turn advertises reads plus lazy_raise via --review', async () => {
    const record: { opts?: { toolset?: 'full' | 'read' | 'review' } } = {};
    await prepareTurnMcp(stubRunner(record), 'abcdef1234', '/wt', { toolset: 'review' }, silent);

    expect(record.opts).toEqual({ toolset: 'review' });
    const config = await readConfig();
    expect(config.mcpServers.lazy.args).toContain('--review');
    expect(config.mcpServers.lazy.args).not.toContain('--read-only');

    const allow = await readAllowList();
    expect(allow).toContain('mcp__lazy__lazy_raise');
    expect(allow).toContain('mcp__lazy__lazy_show');
    expect(allow).not.toContain('mcp__lazy__lazy_commit');
    expect(allow.sort()).toEqual(
      toolNamesForRole('agent', { toolset: 'review' }).map(n => `mcp__lazy__${n}`).sort(),
    );
  });

  // INVARIANT (fix-e2e-supervisor-leak): the turn declares which task's tools
  // its agent may be given. ~/.claude.json holds ONE lazy entry per HOME, so
  // another supervisor sharing this HOME can overwrite it between this write
  // and the agent's spawn; the MCP server compares its own --task-id against
  // these and exits rather than serving the wrong task. Dropping this makes the
  // hijack silent again — an agent operating on another task's state.
  test('declares the turn identity the MCP server must match', async () => {
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', {}, silent);

    expect(process.env[MCP_EXPECTED_TASK_ID_ENV]).toBe('abcdef1234');
    expect(process.env[MCP_EXPECTED_WORKTREE_ENV]).toBe('/wt');
  });

  // INVARIANT (cursor-first-class-agent): a cursor turn must get the lazy MCP
  // server in ~/.cursor/mcp.json — cursor-agent never reads ~/.claude.json, so
  // without this file the cursor agent runs with NO lazy tools at all.
  test('a cursor turn additionally writes ~/.cursor/mcp.json', async () => {
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false, harness: 'cursor' }, silent);

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
    await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { harness: 'cursor' }, silent);

    const cursorConfig = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.other).toEqual({ command: 'x' });
    expect(cursorConfig.mcpServers.lazy).toBeDefined();
  });

  // INVARIANT (add-codex-agent): a codex turn must get ~/.codex/config.toml —
  // it carries BOTH the lazy MCP entry (codex never reads ~/.claude.json) and
  // the model-provider block that routes codex through lazy's audit proxy
  // (OPENAI_BASE_URL is ignored by the CLI; the file is the only routing
  // mechanism). Without the proxy env the turn must FAIL, never dial
  // api.openai.com directly.
  describe('codex turns', () => {
    let savedEndpoint: string | undefined;
    beforeEach(() => {
      savedEndpoint = process.env.LAZY_CODEX_API_BASE;
      // The COMPLETE base_url, path prefix included — the launch computes it,
      // because only the launch knows which upstream this profile routes to
      // and that is what decides the prefix (src/proxy/codex-route.ts). The
      // supervisor writes what it is given, verbatim.
      process.env.LAZY_CODEX_API_BASE = 'http://host.docker.internal:8766/v1';
    });
    afterEach(() => {
      if (savedEndpoint === undefined) delete process.env.LAZY_CODEX_API_BASE;
      else process.env.LAZY_CODEX_API_BASE = savedEndpoint;
    });

    test('a codex turn writes the managed ~/.codex/config.toml', async () => {
      await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false, harness: 'codex' }, silent);

      const toml = await readFile(join(home, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('model_provider = "lazy"');
      expect(toml).toContain('base_url = "http://host.docker.internal:8766/v1"');
      expect(toml).toContain('env_key = "OPENAI_API_KEY"');
      expect(toml).toContain('[mcp_servers.lazy]');
      expect(toml).toContain('command = "lazy-agent"');
      // The claude config is still written — in-container merge turns run claude.
      expect((await readConfig()).mcpServers.lazy).toBeDefined();
    });

    // INVARIANT: the supervisor writes the base_url VERBATIM and never appends
    // a path segment of its own. A ChatGPT-subscription profile's base already
    // ends at `/backend-api/codex`, where the Responses API is `<base>/responses`
    // — a `/v1` added here would 404 every subscription turn, and the supervisor
    // has no way to know which upstream it is talking to.
    test('a subscription base_url is written without a /v1 the supervisor invented', async () => {
      process.env.LAZY_CODEX_API_BASE = 'http://host.docker.internal:8766';
      await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false, harness: 'codex' }, silent);

      const toml = await readFile(join(home, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('base_url = "http://host.docker.internal:8766"');
      expect(toml).not.toContain('/v1');
      // Same credential mechanism either way: codex bearers the JIT placeholder
      // and the proxy decides what it stands for.
      expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    });

    test('a codex turn FAILS when the proxy env is missing (no direct-egress fallback)', async () => {
      delete process.env.LAZY_CODEX_API_BASE;
      await expect(
        prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false, harness: 'codex' }, silent),
      ).rejects.toThrow(McpToolsUnavailableError);
      expect(await Bun.file(join(home, '.codex', 'config.toml')).exists()).toBe(false);
    });

    test('a codex turn refuses to clobber an unmanaged config.toml', async () => {
      await Bun.write(join(home, '.codex', 'config.toml'), 'model = "user-pinned"\n');
      await expect(
        prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { harness: 'codex' }, silent),
      ).rejects.toThrow(McpToolsUnavailableError);
      expect(await readFile(join(home, '.codex', 'config.toml'), 'utf-8')).toBe('model = "user-pinned"\n');
    });

    test('a claude turn does not create ~/.codex/config.toml', async () => {
      await prepareTurnMcp(stubRunner({}), 'abcdef1234', '/wt', { readOnly: false }, silent);
      expect(await Bun.file(join(home, '.codex', 'config.toml')).exists()).toBe(false);
    });
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

    // Handlers that launch Claude Code on the task. Ask was once missing this
    // call; a fresh handler must not repeat that.
    const handlers = [
      'handleTurnCommand',
      'handleSyncCommand',
      'handleAskCommand',
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
    const call = body.slice(body.indexOf('prepareTurnMcp('));
    expect(call.slice(0, call.indexOf('\n'))).toContain("toolset: 'read'");
  });

  test('review is the review toolset (reads + lazy_raise)', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'supervisor', 'index.ts'),
      'utf-8',
    );
    const start = source.indexOf('async function handleReviewCommand(');
    const body = source.slice(start, start + 8000);
    const call = body.slice(body.indexOf('prepareTurnMcp('));
    expect(call.slice(0, call.indexOf('\n'))).toContain("toolset: 'review'");
    // INVARIANT: review turns clear + collect turn-handoff.jsonl so Raises
    // still land when MCP is unreachable (same path as work/ask).
    expect(body).toContain('clearTurnHandoff');
    expect(body).toContain('handoffField');
  });
});
