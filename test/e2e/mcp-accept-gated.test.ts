/**
 * E2E tests for P0.2d: the MCP two-step confirmation is NOT authorization for
 * merges into protected branches.
 *
 * The old confirmation-code mechanism is self-satisfiable — the daemon hands
 * the builder a code and the builder echoes it back. On a protected merge that
 * must no longer count: lazy_accept refuses up front, never issues a code, and
 * a code cannot complete the accept. Only a human `lazy approve` (CLI-only —
 * there is deliberately no MCP equivalent) unlocks the merge. On UNPROTECTED
 * merges the confirmation protocol keeps working as before (covered by
 * confirm-protocol.test.ts).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';
import { enrollPassphrase } from '../helpers/passphrase';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');
const PASSPHRASE = 'test-approval-passphrase';

/**
 * Env that drives the masked `lazy approve` prompt as if a human typed the
 * correct passphrase at a TTY. The passphrase is TTY-only BY DESIGN — no flag,
 * no env var, no piped-stdin route — so this test-only pair is the only way a
 * test can supply it (see test/e2e/system-passphrase.test.ts).
 */
const TYPES_PASSPHRASE = {
  LAZY_FORCE_TTY: '1',
  LAZY_PROMPT_DEFAULTS: '1',
  LAZY_PROMPT_SECRET: PASSPHRASE,
};

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

/** Persistent builder-mode MCP session against a real daemon (no LAZY_TEST). */
class McpSession {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdin: import('bun').FileSink;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private nextId = 1;

  constructor(root: string, worktreePath: string) {
    this.proc = Bun.spawn(
      ['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', '', '--worktree', worktreePath],
      { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...MCP_SERVER_ENV_PINS } },
    );
    this.stdin = this.proc.stdin as import('bun').FileSink;
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
  }

  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const nl = this.buffer.indexOf('\n');
      if (nl !== -1) {
        const line = this.buffer.substring(0, nl).trim();
        this.buffer = this.buffer.substring(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse;
            if (parsed.id === id) return parsed;
          } catch {
            // not JSON; keep reading
          }
        }
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`MCP process exited before response for id=${id}`);
      this.buffer += decoder.decode(value, { stream: true });
    }
    throw new Error(`Timeout waiting for MCP response id=${id}`);
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    await this.stdin.flush();
    return this.readResponse(id);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  }

  /** Call a tool and return the flattened text (payload, isError text, or JSON-RPC error). */
  async callText(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) return JSON.stringify(res.error);
    const result = res.result!;
    return (result.content?.map(c => c.text).join('\n') ?? '') + (result.isError ? ' [isError]' : '');
  }

  /** List available tool names. */
  async listToolNames(): Promise<string[]> {
    const res = await this.request('tools/list', {});
    const tools = (res.result as unknown as { tools: Array<{ name: string }> }).tools;
    return tools.map(t => t.name);
  }

  async close(): Promise<void> {
    this.stdin.end();
    this.reader.releaseLock();
    await this.proc.exited;
  }
}

/** Opt in to branch protection (OFF by default) and enroll the passphrase. */
async function enableProtection(ctx: TestContext): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  if (!toml.includes('[protection]')) {
    throw new Error('Expected lazy init template to contain a [protection] section');
  }
  await writeFile(tomlPath, toml.replace('[protection]\n', '[protection]\nenabled = true\n'));
  await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);
}

async function setupBlockedTask(ctx: TestContext, name: string): Promise<string> {
  const taskId = await createTask(ctx, `MCP gate test ${name}`, 'Add a file');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, `${name}.txt`), 'content\n');
  ctx.git('-C', worktreePath, 'add', `${name}.txt`);
  ctx.git('-C', worktreePath, 'commit', '-m', `Add ${name}.txt`);
  return taskId;
}

describe('MCP lazy_accept into protected branches (P0.2d)', () => {
  let ctx: TestContext;
  let session: McpSession;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    await enableProtection(ctx);
    session = new McpSession(ctx.root, ctx.root);
    await session.initialize();
  });

  afterEach(async () => {
    await session.close();
    await ctx.cleanup();
  });

  // INVARIANT: on a protected merge with no pending human approval,
  // lazy_accept refuses up front and never issues a confirmation code — a code
  // the builder can echo back is not authorization for a protected merge.
  test('lazy_accept into a protected branch refuses and issues NO confirmation code', async () => {
    const taskId = await setupBlockedTask(ctx, 'no-code');

    const text = await session.callText('lazy_accept', { task_id: taskId });

    expect(text).toContain('requires human approval');
    expect(text).toContain(`lazy approve ${taskId}`);
    // No confirmation code anywhere in the refusal (codes look like "ac-1a2b").
    expect(text).not.toMatch(/\b[a-z]{2}-[0-9a-f]{4}\b/);
  }, 30000);

  // INVARIANT: supplying a confirmation code cannot complete a protected
  // accept — the protection refusal wins before code validation, and even a
  // hypothetically valid code would still hit the daemon's check.
  test('lazy_accept with a confirmation code cannot complete a protected accept', async () => {
    const taskId = await setupBlockedTask(ctx, 'forged-code');

    const text = await session.callText('lazy_accept', {
      task_id: taskId,
      confirmation_code: 'ac-dead',
    });

    expect(text).toContain('requires human approval');
    // The task was not merged.
    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).not.toContain('forged-code');
  }, 30000);

  // INVARIANT: a human `lazy approve` (CLI) is what unlocks the protected
  // accept, and the MCP flow then completes it.
  test('after human lazy approve, MCP lazy_accept completes the merge', async () => {
    const taskId = await setupBlockedTask(ctx, 'approved-mcp');

    const approveResult = await ctx.lazy(['approve', taskId], { env: TYPES_PASSPHRASE });
    expectSuccess(approveResult);

    // Tiny diff → confirmation level 'none' → executes directly; the daemon
    // consumes the recorded approval.
    const text = await session.callText('lazy_accept', { task_id: taskId });
    expect(text).toContain('accepted and merged');

    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).toContain('MCP gate test approved-mcp');
  }, 30000);

  // INVARIANT: there is no MCP tool that records a human approval. If one
  // existed, the builder could approve its own work and the friction model
  // would be theatre.
  test('no MCP tool exposes lazy approve', async () => {
    const names = await session.listToolNames();
    expect(names).not.toContain('lazy_approve');
    expect(names.join(',')).not.toContain('approve');
  });
});
