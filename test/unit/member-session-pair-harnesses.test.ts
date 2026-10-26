/**
 * The in-container half of a member's Pair/Chat (`lazy-agent pair
 * --member-session`, src/supervisor/pair.ts) on Codex, Cursor and Pi, run for
 * real as a subprocess with a stand-in agent binary on PATH that records the
 * argv it was started with and the home config it found.
 *
 * INVARIANT (engineer, 2026-10-24: Pair/Chat on every harness): a member
 * session on Codex, Cursor or Pi gets lazy's tools from the MEMBER's own lazy
 * server only, written into the member's own home — never the turn-writable
 * sandbox's config — and its model traffic pinned to lazy's proxy:
 *   - Codex: the managed config.toml names only the member's lazy server, the
 *     live proxy, and marks the worktree UNTRUSTED (its `.codex/` layer and
 *     hooks are not loaded, and codex never offers to trust it);
 *   - Cursor: ~/.cursor/mcp.json names only the member's lazy server, and the
 *     session is NOT pre-trusted (no `--trust`) — whether to trust a
 *     turn-writable worktree is the member's question;
 *   - Pi: the bridge extension names the member's lazy server; `--no-approve`
 *     ignores project-local resources.
 * And a Chat is read-only per harness: Cursor and Pi without their write
 * tools, the lazy server read-only; Codex refuses to start one.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const ENTRY = join(import.meta.dir, '../../src/agent-entry.ts');
const MEMBER_MCP = '/run/lazy-member-mcp/0123456789abcdef0123456789abcdef.json';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function runPair(harness: string, binary: string, extra: string[], env: Record<string, string> = {}) {
  root = await realpath(await mkdtemp(join(tmpdir(), `member-pair-${harness}-`)));
  const worktree = join(root, 'wt');
  const sandbox = join(worktree, '.lazy-task-sandbox');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(sandbox, { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(bin, { recursive: true });
  // What a turn could plant in the sandbox's agent homes.
  const planted = 'planted-by-a-turn';
  for (const dir of ['.codex', '.cursor', join('.pi', 'agent', 'extensions')]) {
    await mkdir(join(sandbox, dir), { recursive: true });
  }
  await writeFile(join(sandbox, '.codex', 'config.toml'), `[mcp_servers.thief]\ncommand = "${planted}"\n`);
  await writeFile(join(sandbox, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { thief: { command: planted } } }));

  const record = join(root, 'record');
  await writeFile(join(bin, binary), `#!/bin/sh
printf '%s\\n' "$@" > "${record}.argv"
cat "$HOME/.codex/config.toml" > "${record}.codex" 2>/dev/null
cat "$HOME/.cursor/mcp.json" > "${record}.cursor" 2>/dev/null
cat "$HOME/.pi/agent/extensions/"* > "${record}.pi" 2>/dev/null
exit 0
`);
  await chmod(join(bin, binary), 0o755);

  const proc = Bun.spawn(['bun', 'run', ENTRY, 'pair',
    '--task-id', '11111111-2222-3333-4444-555555555555',
    '--worktree', worktree, '--agent', harness, '--runner', 'docker',
    '--model', 'some-model', '--member-session', '--member-mcp-config', MEMBER_MCP, ...extra], {
    cwd: worktree,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, LAZY_DAEMON_CONFIG: '', ...env },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  const read = (suffix: string) => readFile(`${record}.${suffix}`, 'utf-8').catch(() => '');
  return {
    code, stderr, planted, worktree,
    argv: (await read('argv')).trim().split('\n'),
    codex: await read('codex'),
    cursor: await read('cursor'),
    pi: await read('pi'),
  };
}

const PROXY_ENV = {
  // As a member container is created: the proxy base it was handed, and the
  // Codex endpoint built on it. A daemon restarted since moved its proxy.
  LAZY_PROXY_BASE_URL: 'http://host.docker.internal:41111',
  LAZY_CODEX_API_BASE: 'http://host.docker.internal:41111/v1',
  ANTHROPIC_BASE_URL: 'http://host.docker.internal:41111',
  LAZY_LIVE_PROXY_PORT: '42222',
};

describe("a member's Pair on another harness", () => {
  test('Codex: the member\'s lazy server, the LIVE proxy, the worktree untrusted', async () => {
    const r = await runPair('codex', 'codex', [], PROXY_ENV);
    expect(r.stderr).not.toContain('Error');
    expect(r.code).toBe(0);
    expect(r.codex).toContain('[mcp_servers.lazy]');
    expect(r.codex).toContain(MEMBER_MCP);
    expect(r.codex).not.toContain(r.planted);
    // Moved off the port the container was created with.
    expect(r.codex).toContain('base_url = "http://host.docker.internal:42222/v1"');
    expect(r.codex).toContain(`[projects.${JSON.stringify(r.worktree)}]\ntrust_level = "untrusted"`);
    // A shell that works in a container (codex's own sandbox cannot run there).
    expect(r.argv[r.argv.indexOf('--sandbox') + 1]).toBe('danger-full-access');
  }, 60_000);

  test('Cursor: the member\'s lazy server only, and not pre-trusted', async () => {
    const r = await runPair('cursor', 'cursor-agent', [], PROXY_ENV);
    expect(r.code).toBe(0);
    const config = JSON.parse(r.cursor);
    expect(Object.keys(config.mcpServers)).toEqual(['lazy']);
    expect(config.mcpServers.lazy.args).toContain(MEMBER_MCP);
    expect(r.argv).not.toContain('--trust');
    expect(r.argv).not.toContain('--approve-mcps');
  }, 60_000);

  test('Pi: the bridge to the member\'s lazy server, project files ignored', async () => {
    const r = await runPair('pi', 'pi', [], { ...PROXY_ENV, LAZY_PI_UPSTREAM_TIMEOUT_MS: '1800000' });
    expect(r.stderr).not.toContain('Error');
    expect(r.code).toBe(0);
    expect(r.pi).toContain(MEMBER_MCP);
    expect(r.argv).toContain('--no-approve');
  }, 60_000);
});

describe("a member's Chat on another harness", () => {
  test('Cursor chats without its write tools, keeping read-only lazy tools', async () => {
    const r = await runPair('cursor', 'cursor-agent', ['--chat'], PROXY_ENV);
    expect(r.code).toBe(0);
    // Never Cursor's own --mode ask/plan: those reject MCP calls too.
    expect(r.argv).not.toContain('--mode');
    expect(r.argv[r.argv.indexOf('--exclude-tools') + 1]).toBe('shellToolCall,editToolCall,deleteToolCall,writeShellStdinToolCall');
    expect(JSON.parse(r.cursor).mcpServers.lazy.args).toContain('--read-only');
  }, 60_000);

  test('Pi chats without its write tools', async () => {
    const r = await runPair('pi', 'pi', ['--chat'], { ...PROXY_ENV, LAZY_PI_UPSTREAM_TIMEOUT_MS: '1800000' });
    expect(r.code).toBe(0);
    expect(r.argv[r.argv.indexOf('--exclude-tools') + 1]).toBe('bash,edit,write,powershell');
    expect(r.pi).toContain('--read-only');
  }, 60_000);

  test('Codex refuses a Chat rather than run one unlocked', async () => {
    const r = await runPair('codex', 'codex', ['--chat'], PROXY_ENV);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Chat is not available for Codex');
    expect(r.argv).toEqual(['']);
  }, 60_000);
});
