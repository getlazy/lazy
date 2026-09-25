/**
 * E2E tests for P0.2d: the MCP two-step confirmation is NOT authorization for
 * merges into protected branches.
 *
 * The old confirmation-code mechanism is self-satisfiable — the daemon hands
 * the builder a code and the builder echoes it back. On a protected merge that
 * must not count: lazy_accept refuses UNCONDITIONALLY, never issues a code,
 * and a code cannot complete the accept. Only a human completes the merge —
 * `lazy accept` at a terminal prompts for the approval passphrase (there is
 * deliberately no MCP equivalent and no non-interactive path). The reason the
 * builder handed the refused accept is captured as a pending review the
 * human's accept surfaces and attaches. On UNPROTECTED merges the confirmation
 * protocol keeps working as before (covered by confirm-protocol.test.ts).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { seedFinal } from '../helpers/final';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { enrollPassphrase } from '../helpers/passphrase';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');
const PASSPHRASE = 'test-approval-passphrase';

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
  // Fixture setup, not the subject (see test/helpers/final.ts): the suite's
  // accepts are gated-accept refusals and passphrase accepts, none of which is
  // the no-final refusal.
  await seedFinal(ctx, taskId);
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

  // INVARIANT: on a protected merge, lazy_accept refuses UNCONDITIONALLY and
  // never issues a confirmation code — a code the builder can echo back is not
  // authorization for a protected merge, and there is no pre-approval that
  // could let it through (the stored-approval mechanism was removed as a
  // floating credential).
  test('lazy_accept into a protected branch refuses and issues NO confirmation code', async () => {
    const taskId = await setupBlockedTask(ctx, 'no-code');

    const text = await session.callText('lazy_accept', { task_id: taskId });

    expect(text).toContain('requires human approval');
    expect(text).toContain(`lazy accept ${taskId}`);
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

  // Capture-on-refusal: the reason handed to a refused gated accept is often a
  // real code review. It is kept on the task and the refusal says so; the
  // human's passphrase accept then shows it before the prompt and attaches it
  // to the merge ([Accepted] comment). Last-write-wins: a retry with an
  // updated reason replaces the earlier review, never accumulates copies.
  test('a refused gated accept records the builder review; the human accept attaches it', async () => {
    const taskId = await setupBlockedTask(ctx, 'review-capture');

    const first = await session.callText('lazy_accept', {
      task_id: taskId,
      reason: 'First pass: looks solid overall.',
    });
    expect(first).toContain('requires human approval');
    expect(first).toContain('review has been RECORDED');

    // Retry with an updated review — replaces, does not accumulate.
    const second = await session.callText('lazy_accept', {
      task_id: taskId,
      reason: 'Reviewed the diff thoroughly: correct and well tested.',
    });
    expect(second).toContain('review has been RECORDED');

    // The human accepts with the passphrase; the captured review is shown
    // before the prompt and lands in the [Accepted] comment, attributed.
    const acceptResult = await ctx.lazy(['accept', taskId], {
      env: {
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: '1',
        LAZY_PROMPT_SECRET: PASSPHRASE,
      },
    });
    expect(acceptResult.exitCode).toBe(0);
    expect(acceptResult.stdout).toContain('Review by builder');
    expect(acceptResult.stdout).toContain('Reviewed the diff thoroughly');
    expect(acceptResult.stdout).not.toContain('First pass');

    const show = await ctx.lazy(['show', taskId, '--full']);
    expect(show.stdout).toContain('Reviewed the diff thoroughly');
    expect(show.stdout).toContain('Review by builder');
  }, 60000);

  // INVARIANT: a gated refusal without a reason records nothing and says so —
  // an empty review would be noise in front of the human.
  test('a refused gated accept without a reason records no review', async () => {
    const taskId = await setupBlockedTask(ctx, 'no-review');

    const text = await session.callText('lazy_accept', { task_id: taskId });
    expect(text).toContain('No review text was recorded');
  }, 30000);

  // INVARIANT: there is no MCP tool that can approve a protected merge. If one
  // existed, the builder could approve its own work and the friction model
  // would be theatre.
  test('no MCP tool exposes an approval route', async () => {
    const names = await session.listToolNames();
    expect(names).not.toContain('lazy_approve');
    expect(names.join(',')).not.toContain('approve');
  });
});
