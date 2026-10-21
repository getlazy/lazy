/**
 * A PAIRING SESSION DRIVES ITS OWN SUBTASKS THROUGH ITS lazy MCP TOOLS.
 *
 * Both pairing surfaces give the paired agent the task's own MCP token, served
 * through the daemon's `/mcp` routes, so the daemon's turn-authority rule
 * (src/daemon/mcp-turn-authority.ts) is what decides what it may do: a
 * `pairing` task acts with the full toolset.
 *
 *  - In the CONTAINER, `lazy pair <task>` runs `lazy-agent mcp --daemon-config`
 *    with the config the daemon minted for the task (src/supervisor/pair.ts).
 *    The suite below runs that same server, over that same token, and drives
 *    create → start → wait → accept into the paired task.
 *  - On the HOST, `lazy pair <task> --host` asks the daemon for the token
 *    (`getTaskMcpConfig`) and hands Claude Code `--mcp-config <private file>
 *    --strict-mcp-config` (src/supervisor/host-session-mcp.ts). A fake `claude`
 *    on PATH plays Claude Code's MCP client from that very file, mid-session.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join, dirname } from 'path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { spawn } from '../../src/utils/spawn';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import {
  findFullTaskId,
  readSessionJson,
  readTaskStatus,
  setTaskMetadata,
  setTaskStatus,
  taskFilePath,
  worktreePathFor,
} from '../helpers/storage';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';
import { installFakeClaude, setClaudeScenario, type FakeClaude, type McpCallRecord } from '../helpers/fake-claude';
import { getDaemonTcpTarget } from '../../src/daemon/lifecycle';
import { clearMcpTokenCache, lookupMcpIdentity, mintMcpToken } from '../../src/daemon/mcp-tokens';
import type { DaemonMcpConfigFile } from '../../src/daemon/mcp-proxy';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

async function waitForTask(ctx: TestContext, taskId: string): Promise<void> {
  const result = await ctx.lazy(['wait', taskId]);
  if (result.exitCode !== 0) throw new Error(`wait failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
}

/** Start a top-level task and leave it blocked with a session, a branch and a worktree. */
async function startedTask(ctx: TestContext, goal: string): Promise<string> {
  const id = await createTask(ctx, goal, `Do ${goal}`);
  expectSuccess(await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } }));
  await waitForTask(ctx, id);
  return id;
}

function branchOf(ctx: TestContext, shortId: string): string {
  const branch = readSessionJson(ctx.root, shortId)?.git_branch as string | undefined;
  if (!branch) throw new Error(`No git_branch recorded for ${shortId}`);
  return branch;
}

function childIdFrom(text: string): string {
  const id = text.match(/\b([0-9a-f]{8})\b/)?.[1];
  if (!id) throw new Error(`no task id in lazy_create's answer: ${text}`);
  return id;
}

/** A stdio MCP session on one server process: initialize, then tool calls. */
class McpClient {
  private proc: ReturnType<typeof spawn>;
  private stdin: import('bun').FileSink;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private nextId = 1;

  constructor(argv: string[], cwd: string) {
    this.proc = spawn(argv, {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...MCP_SERVER_ENV_PINS },
      timeout: 0,
    });
    this.stdin = this.proc.stdin as import('bun').FileSink;
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++;
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    await this.stdin.flush();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const nl = this.buffer.indexOf('\n');
      if (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: Record<string, any>;
        try { parsed = JSON.parse(line); } catch { continue; /* a non-JSON line is not a reply */ }
        if (parsed.id === id) return parsed;
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`MCP server exited before replying to ${method}`);
      this.buffer += decoder.decode(value, { stream: true });
    }
    throw new Error(`Timed out waiting for the MCP reply to ${method}`);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {});
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) return { text: JSON.stringify(res.error), isError: true };
    return {
      text: (res.result?.content ?? []).map((c: { text: string }) => c.text).join('\n'),
      isError: res.result?.isError === true,
    };
  }

  async close(): Promise<void> {
    this.stdin.end();
    this.reader.releaseLock();
    await this.proc.exited;
  }
}

describe('in-container pairing: the agent drives a subtask into its own task', () => {
  let ctx: TestContext;
  let scratch: string;
  const clients: McpClient[] = [];

  beforeEach(async () => {
    clearMcpTokenCache();
    ctx = await setupTestLazy({ withDaemon: true });
    scratch = mkdtempSync(join(tmpdir(), 'lazy-pair-mcp-e2e-'));
  }, 90_000);

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => { /* already gone */ });
    await ctx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
    clearMcpTokenCache();
  }, 90_000);

  // INVARIANT: a `pairing` task's own MCP token, through the same daemon-proxy
  // server the container runs, may create, start, wait on and ACCEPT a subtask
  // into the paired task. That is what makes a pairing session able to
  // orchestrate work: the daemon's turn-authority rule grants a pairing session
  // the full toolset, and the accept gate lets the paired task itself merge into
  // its active branch. Losing either would send the paired agent back to the CLI,
  // where the daemon cannot tell it from the human.
  test('create → start → wait → accept, over the task token', async () => {
    const parentId = await startedTask(ctx, 'Paired parent');
    const parentFull = findFullTaskId(ctx.root, parentId);
    setTaskStatus(ctx.root, parentId, 'pairing');
    setTaskMetadata(ctx.root, parentId, 'pairing_pid', String(process.pid));
    setTaskMetadata(ctx.root, parentId, 'pairing_started_at', new Date().toISOString());

    // The config the container's server reads, but with the loopback address a
    // process outside a container reaches the daemon on.
    const target = getDaemonTcpTarget(ctx.root);
    if (!target) throw new Error('test daemon recorded no TCP target');
    const daemonConfig: DaemonMcpConfigFile = {
      token: await mintMcpToken(ctx.root, { kind: 'task', taskId: parentFull }, 'e2e-pair-container'),
      projectRoot: ctx.root,
      taskId: parentFull,
      target,
    };
    const configPath = join(scratch, 'daemon-mcp.json');
    writeFileSync(configPath, JSON.stringify(daemonConfig), { mode: 0o600 });

    const worktree = worktreePathFor(ctx.root, parentId);
    const agent = new McpClient(
      ['bun', 'run', AGENT_ENTRY, 'mcp', '--daemon-config', configPath, '--task-id', parentFull, '--worktree', worktree],
      ctx.root,
    );
    clients.push(agent);
    await agent.initialize();

    const created = await agent.call('lazy_create', { goal: 'Paired child', prompt: 'Do the paired child' });
    expect(created.isError).toBe(false);
    const childId = childIdFrom(created.text);

    const started = await agent.call('lazy_start', { task_id: childId });
    expect(started.isError).toBe(false);

    const waited = await agent.call('lazy_wait', { task_id: childId, timeout: 120 });
    expect(waited.isError).toBe(false);
    expect(readTaskStatus(ctx.root, childId)).not.toBe('working');

    // The daemon's mock agent does not commit; give the child real work.
    const childWorktree = worktreePathFor(ctx.root, childId);
    writeFileSync(join(childWorktree, 'paired-child.txt'), 'paired child work\n');
    ctx.git('-C', childWorktree, 'add', 'paired-child.txt');
    ctx.git('-C', childWorktree, 'commit', '-m', 'Paired child work');
    await seedFinal(ctx, childId);

    const accepted = await agent.call('lazy_accept', { task_id: childId });
    expect(accepted.isError).toBe(false);

    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
    const parentBranch = branchOf(ctx, parentId);
    expect(ctx.git('show', `${parentBranch}:paired-child.txt`).stdout).toBe('paired child work\n');
    expect(ctx.git('show', 'main:paired-child.txt').exitCode).not.toBe(0);
  }, 240_000);
});

describe('host pairing: Claude Code gets the task-scoped lazy MCP server', () => {
  let ctx: TestContext;
  let fake: FakeClaude;
  let fakeDir: string;

  beforeEach(async () => {
    clearMcpTokenCache();
    ctx = await setupTestLazy({ withDaemon: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'lazy-pair-host-fake-'));
    fake = await installFakeClaude(fakeDir);
  }, 90_000);

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(fakeDir, { recursive: true, force: true });
    clearMcpTokenCache();
  }, 90_000);

  // INVARIANT: `lazy pair <task> --host` launches Claude Code with exactly ONE
  // MCP server — lazy's, from a private file, with --strict-mcp-config — whose
  // token is the paired task's own, so the agent on the host has the same tools
  // and the same scope as the agent in the container. Nothing is written into
  // the host home, and the file (it holds a bearer token) is gone when the
  // session ends.
  test('the session sees a task-scoped config, can act as the pairing session, and the config is removed', async () => {
    const parentId = await startedTask(ctx, 'Host paired parent');
    const parentFull = findFullTaskId(ctx.root, parentId);
    // The mock turn recorded a session id but wrote no transcript; start the
    // paired session fresh rather than exercise session bridging here.
    const sessionPath = taskFilePath(ctx.root, parentId, 'session.json');
    writeFileSync(sessionPath, JSON.stringify({ ...readSessionJson(ctx.root, parentId), agent_session_id: null }, null, 2));

    await setClaudeScenario(fake, {
      steps: [{
        kind: 'mcp-call',
        recordFile: 'mcp-record.json',
        calls: [
          { tool: 'lazy_status' },
          { tool: 'lazy_create', arguments: { goal: 'Child from host pairing', prompt: 'Work' } },
        ],
      }],
    });

    const result = await ctx.lazy(['pair', parentId, '--host', '--no-summary'], {
      env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` },
    });
    if (result.exitCode !== 0) throw new Error(`pair failed:\n${result.stdout}\n${result.stderr}`);

    const record = JSON.parse(await readFile(join(fake.dir, 'mcp-record.json'), 'utf-8')) as McpCallRecord;

    // Claude Code was told to use this file and nothing else.
    expect(record.argv).toContain('--strict-mcp-config');
    expect(record.argv[record.argv.indexOf('--mcp-config') + 1]).toBe(record.mcpConfigPath);

    // One server, lazy's, scoped to the paired task through the daemon proxy.
    const mcpConfig = JSON.parse(record.files[record.mcpConfigPath].content);
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(['lazy']);
    const serverArgs: string[] = mcpConfig.mcpServers.lazy.args;
    expect(serverArgs[serverArgs.indexOf('--task-id') + 1]).toBe(parentFull);
    const daemonConfigPath = serverArgs[serverArgs.indexOf('--daemon-config') + 1];
    const daemonConfig = JSON.parse(record.files[daemonConfigPath].content) as DaemonMcpConfigFile;
    expect(daemonConfig.taskId).toBe(parentFull);
    expect(await lookupMcpIdentity(ctx.root, daemonConfig.token)).toEqual({ kind: 'task', taskId: parentFull });

    // Private: readable by the user only, never under the host home.
    expect(record.files[record.mcpConfigPath].mode).toBe(0o600);
    expect(record.files[daemonConfigPath].mode).toBe(0o600);
    expect(record.mcpConfigPath.startsWith(join(process.env.HOME ?? '/nonexistent', '.claude'))).toBe(false);

    // The tools work, with the full toolset a pairing session is granted.
    expect(record.tools).toContain('lazy_accept');
    expect(record.results.map(r => [r.tool, r.isError])).toEqual([['lazy_status', false], ['lazy_create', false]]);
    const childId = childIdFrom(record.results[1].text);
    const listed = await ctx.lazy(['show', childId]);
    expectSuccess(listed);
    expect(listed.stdout).toContain('Child from host pairing');

    // Removed when the session ended.
    expect(existsSync(record.mcpConfigPath)).toBe(false);
    expect(existsSync(dirname(record.mcpConfigPath))).toBe(false);
    // And the task is back out of `pairing`.
    expect(readTaskStatus(ctx.root, parentId)).not.toBe('pairing');
  }, 240_000);

  // INVARIANT: the token is handed only to the session that holds the task in
  // `pairing`. Asked for any other task, the daemon refuses — the host MCP
  // surface is this pairing's, not anybody-on-the-host's.
  test('the daemon refuses the task token for a task that is not being paired', async () => {
    const parentId = await startedTask(ctx, 'Not paired');
    const parentFull = findFullTaskId(ctx.root, parentId);
    const { DaemonClient } = await import('../../src/daemon/client');
    const { readToken } = await import('../../src/daemon/lifecycle');
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon recorded no target/token');
    await expect(
      DaemonClient.fromTarget(target, token).rpc('getTaskMcpConfig', ctx.root, { taskId: parentFull }),
    ).rejects.toThrow(/not 'pairing'/);
  }, 120_000);
});

