/**
 * The builder's MCP identity label, and the launch probe that proves the server
 * it names actually starts.
 *
 * WHY THE LABEL MATTERS. The label is the MCP identity key: the daemon binds the
 * minted token to `builder:<label>`, and `lazy builder` hands the same label back
 * on exit to revoke it. When it was `builder-${Date.now()}`, two builders that
 * launched in the same millisecond shared it — mintMcpToken reuses by identity
 * key, so both got the SAME token and both worked, right up until the first one
 * exited and revoked the shared label out from under the one still running. The
 * survivor lost every lazy_* tool for the rest of its session, with no signal.
 * That is the same class of bug as the config/mount race this task fixes, so it
 * gets the same treatment: key on identity, never on the clock.
 *
 * The first describe pins the shared-label failure mode itself (so nobody
 * reintroduces a clock-derived label thinking it is harmless), and pins that the
 * two label sites are derived from an id rather than a timestamp.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mintMcpToken,
  lookupMcpIdentity,
  revokeBuilderMcpToken,
  clearMcpTokenCache,
} from '../../src/daemon/mcp-tokens';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  lazyMcpEntryFromClaudeConfig,
  runMcpHandshake,
  probeLazyMcpServerStartup,
  mcpLogDirFor,
  collectMcpServerErrors,
} from '../../src/builder/mcp-config-check';

const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('builder MCP identity label', () => {
  let root: string;
  let baseDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-mcp-label-'));
    baseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearMcpTokenCache();
  });

  afterEach(async () => {
    clearMcpTokenCache();
    delete process.env.LAZY_DAEMON_BASE_DIR;
    await removeDaemonBaseDir(baseDir);
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: the MCP identity label must be unique per builder LAUNCH.
  // This test documents the damage a colliding label does, which is why the
  // label may never be derived from a clock reading. Do not "simplify" the
  // label back to a timestamp — this is the failure it would restore.
  test('a shared label lets one builder revoke a live builder\'s token', async () => {
    const shared = 'builder-1785961697275';

    const a = await mintMcpToken(root, { kind: 'builder' }, shared);
    const b = await mintMcpToken(root, { kind: 'builder' }, shared);
    // Same identity key → the registry hands back the SAME token, so both
    // containers are authenticated by one credential.
    expect(b).toBe(a);

    // Builder A exits and revokes "its" label...
    await revokeBuilderMcpToken(root, shared);

    // ...and builder B, still running, is now toolless.
    expect(await lookupMcpIdentity(root, b)).toBeNull();
  });

  test('distinct builder ids keep each launch independently revokable', async () => {
    const a = await mintMcpToken(root, { kind: 'builder' }, 'builder-3f2a91c4');
    const b = await mintMcpToken(root, { kind: 'builder' }, 'builder-9c17be40');
    expect(b).not.toBe(a);

    await revokeBuilderMcpToken(root, 'builder-3f2a91c4');

    expect(await lookupMcpIdentity(root, a)).toBeNull();
    // The other builder is untouched — it still has its tools.
    expect(await lookupMcpIdentity(root, b)).not.toBeNull();
  });

  // Source-level pins. The label is computed at exactly two sites and both used
  // to read the clock; the behavior above cannot detect a regression at either
  // one, because a unit test cannot observe two real launches colliding.
  test('lazy builder keys the label on the builder id, not the clock', async () => {
    const src = await readFile(join(REPO_ROOT, 'src', 'cli', 'commands', 'builder.ts'), 'utf-8');
    expect(src).toContain('const daemonMcpName = `builder-${id}`');
    // The old spelling, in code — the comments deliberately quote it as history.
    expect(src).not.toMatch(/^\s*(const|let)\s+daemonMcpName\s*=.*Date\.now/m);
  });

  test('the daemon-side fallback label is random, not the clock', async () => {
    const src = await readFile(join(REPO_ROOT, 'src', 'daemon', 'rpc-handlers.ts'), 'utf-8');
    expect(src).toMatch(/const name = optionalString\(params, 'name'\)[\s\S]{0,80}randomUUID/);
    expect(src).not.toMatch(/^\s*const name = optionalString[\s\S]{0,80}Date\.now/m);
  });
});

describe('lazy MCP server startup probe', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-mcp-probe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write an executable shell script and return its path. */
  async function script(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  test('reads the server command out of the Claude config', () => {
    const entry = lazyMcpEntryFromClaudeConfig({
      mcpServers: {
        lazy: {
          command: 'lazy-agent',
          args: ['mcp', '--daemon-config', '/x.json'],
          env: { LAZY_X: '1', BAD: 3 },
        },
      },
    });
    expect(entry).toEqual({
      command: 'lazy-agent',
      args: ['mcp', '--daemon-config', '/x.json'],
      env: { LAZY_X: '1' },
    });
  });

  test('returns null when the config has no lazy MCP entry', () => {
    expect(lazyMcpEntryFromClaudeConfig({ mcpServers: { other: { command: 'x' } } })).toBeNull();
    expect(lazyMcpEntryFromClaudeConfig({})).toBeNull();
    expect(lazyMcpEntryFromClaudeConfig(null)).toBeNull();
  });

  test('a server that answers initialize passes', async () => {
    const cmd = await script(
      'good-server',
      // Answer the handshake and then sit there, exactly as a real MCP server does.
      `read line\n` +
      `echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}'\n` +
      `sleep 30`,
    );
    const result = await runMcpHandshake({ command: cmd, args: [] }, dir, 10_000);
    expect(result.ok).toBe(true);
  });

  // INVARIANT: the probe must surface the SERVER'S OWN stderr. That text is the
  // whole point — Claude Code owns the real MCP child's stderr pipe and reduces
  // its death to "-32000: Connection closed", so this is the only place the
  // human ever gets to read what the server actually said.
  test('a server that dies is reported with its verbatim stderr', async () => {
    const cmd = await script(
      'dying-server',
      `echo "ENOENT: /nonexistent/token.json" >&2\nexit 3`,
    );
    const result = await runMcpHandshake({ command: cmd, args: [] }, dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('exited (code 3)');
    expect(result.stderr).toContain('ENOENT: /nonexistent/token.json');
  });

  test('a server that never answers fails on the deadline, not on silence', async () => {
    const cmd = await script('hanging-server', `sleep 30`);
    const result = await runMcpHandshake({ command: cmd, args: [] }, dir, 300);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('initialize handshake within 300ms');
  });

  test('a command that does not exist fails without throwing raw ENOENT', async () => {
    const result = await runMcpHandshake(
      { command: join(dir, 'no-such-binary'), args: [] }, dir, 2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/spawn|exited/);
  });

  test('the preflight names the command and the server output when it fails', async () => {
    const cmd = await script('broken', `echo "daemon unreachable at 127.0.0.1:9" >&2\nexit 1`);
    const claudeConfig = join(dir, '.claude.json');
    await writeFile(
      claudeConfig,
      JSON.stringify({ mcpServers: { lazy: { command: cmd, args: ['mcp'] } } }),
    );

    let message = '';
    try {
      await probeLazyMcpServerStartup({ claudeConfigPath: claudeConfig, cwd: dir, timeoutMs: 5_000 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('did not start');
    expect(message).toContain(cmd);
    expect(message).toContain('daemon unreachable at 127.0.0.1:9');
  });

  test('the preflight fails when the config declares no lazy server at all', async () => {
    const claudeConfig = join(dir, '.claude.json');
    await writeFile(claudeConfig, JSON.stringify({ mcpServers: {} }));
    await expect(
      probeLazyMcpServerStartup({ claudeConfigPath: claudeConfig, cwd: dir }),
    ).rejects.toThrow(/no lazy MCP entry/);
  });
});

describe('post-session MCP error scan', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-mcp-logs-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('derives Claude Code\'s log path from the cwd slug', () => {
    expect(mcpLogDirFor('/home/user', '/work/repo-a')).toBe(
      '/home/user/.cache/claude-cli-nodejs/-work-repo-a/mcp-logs-lazy',
    );
  });

  test('reports the server stderr Claude Code recorded during this run', async () => {
    const dir = mcpLogDirFor(home, '/work/repo');
    await Bun.write(
      join(dir, '2026-08-07T00-00-00.jsonl'),
      [
        JSON.stringify({ debug: 'starting' }),
        JSON.stringify({ error: 'Server stderr: daemon token revoked' }),
        JSON.stringify({ error: 'Connection failed (-32000): Connection closed' }),
      ].join('\n') + '\n',
    );

    const errors = await collectMcpServerErrors({ home, cwd: '/work/repo', since: 0 });
    expect(errors).toEqual([
      'Server stderr: daemon token revoked',
      'Connection failed (-32000): Connection closed',
    ]);
  });

  // INVARIANT: the exit banner is about AVAILABILITY. Claude Code logs tool-call
  // error RESULTS into the same file as connection failures, so a raw scan turns
  // every confirmation gate and validation rejection — the server working as
  // designed — into "your lazy_* tools may have been unavailable". Tool results
  // are recognised by Claude's own `Tool '<name>' failed after <d>: <text>` debug
  // echo of the same text, never by matching lazy's own error strings.
  test('a session of nothing but tool-call errors reports nothing', async () => {
    const dir = mcpLogDirFor(home, '/work/repo');
    const stop = '{"error":"STOP. Do NOT call lazy_accept again yet. Confirmation code: ab12"}';
    const validation = 'Memory description is 206 characters; the maximum is 200.';
    await Bun.write(
      join(dir, '2026-08-07T00-00-00.jsonl'),
      [
        JSON.stringify({ debug: 'Successfully connected (transport: stdio) in 68ms' }),
        JSON.stringify({ debug: 'Calling MCP tool: lazy_accept' }),
        JSON.stringify({ error: stop }),
        JSON.stringify({ debug: `Tool 'lazy_accept' failed after 0s: ${stop}` }),
        JSON.stringify({ debug: 'Calling MCP tool: lazy_memory_save' }),
        JSON.stringify({ error: validation }),
        JSON.stringify({ debug: `Tool 'lazy_memory_save' failed after 1s: ${validation}` }),
      ].join('\n') + '\n',
    );

    expect(await collectMcpServerErrors({ home, cwd: '/work/repo', since: 0 })).toEqual([]);
  });

  test('a real connection failure is still reported alongside tool-call errors', async () => {
    const dir = mcpLogDirFor(home, '/work/repo');
    const toolErr = '{"error":"Task not found: deadbeef"}';
    await Bun.write(
      join(dir, '2026-08-07T00-00-00.jsonl'),
      [
        JSON.stringify({ debug: 'Calling MCP tool: lazy_show' }),
        JSON.stringify({ error: toolErr }),
        JSON.stringify({ debug: `Tool 'lazy_show' failed after 0s: ${toolErr}` }),
        JSON.stringify({ error: 'Server stderr: daemon token revoked' }),
        JSON.stringify({ error: 'Connection failed (-32000): Connection closed' }),
      ].join('\n') + '\n',
    );

    expect(await collectMcpServerErrors({ home, cwd: '/work/repo', since: 0 })).toEqual([
      'Server stderr: daemon token revoked',
      'Connection failed (-32000): Connection closed',
    ]);
  });

  // A tool result and a transport failure can carry the same words; only the
  // paired debug echo distinguishes them, and it accounts for one entry, not a
  // whole class of text.
  test('an unpaired error with tool-shaped text is still reported', async () => {
    const dir = mcpLogDirFor(home, '/work/repo');
    await Bun.write(
      join(dir, '2026-08-07T00-00-00.jsonl'),
      [
        JSON.stringify({ error: 'Connection failed (-32000): Connection closed' }),
        JSON.stringify({ debug: "Tool 'lazy_show' failed after 0s: something else entirely" }),
      ].join('\n') + '\n',
    );

    expect(await collectMcpServerErrors({ home, cwd: '/work/repo', since: 0 })).toEqual([
      'Connection failed (-32000): Connection closed',
    ]);
  });

  test('ignores logs left over from a previous session', async () => {
    const dir = mcpLogDirFor(home, '/work/repo');
    await Bun.write(join(dir, 'old.jsonl'), JSON.stringify({ error: 'ancient' }) + '\n');
    // Everything on disk predates this "session start".
    const errors = await collectMcpServerErrors({ home, cwd: '/work/repo', since: Date.now() + 60_000 });
    expect(errors).toEqual([]);
  });

  // INVARIANT: this log format belongs to Claude Code, not to lazy. If it moves
  // or changes shape, the scan must degrade to today's silence — never to a
  // false alarm on a session that was fine.
  test('a missing or malformed log is silence, not a false alarm', async () => {
    expect(await collectMcpServerErrors({ home, cwd: '/nowhere', since: 0 })).toEqual([]);

    const dir = mcpLogDirFor(home, '/work/repo');
    await Bun.write(join(dir, 'weird.jsonl'), 'not json\n{"unexpected":"shape"}\n');
    expect(await collectMcpServerErrors({ home, cwd: '/work/repo', since: 0 })).toEqual([]);
  });
});
