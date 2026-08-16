/**
 * E2E invariant test: `lazy_ask` works on tasks in `conflict` status.
 *
 * `conflict` is a blocked-variant ("blocked, with a protected-file conflict to
 * resolve"). An ask is read-only — it resumes the paused agent session in plan
 * mode, touches no commits and no worktree files — so it is safe against a
 * conflict task. Forcing the reviewer to unblock just to ask a question is a
 * surprise (and would lose the conflict state). This pins that behavior down.
 *
 * `start` and `ask` are daemon-owned (storage is daemon-owned since v0.11), so
 * the test runs against a real test daemon loaded with the mock supervisor.
 * The daemon is given mock-file env so its start turn modifies a protected
 * file → the task lands in `conflict` (same mechanism as permissions.test.ts).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { basename, join, resolve } from 'path';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

// The daemon's fixed mock response (set via daemonEnv) is used for every turn,
// including the ask — so this is the answer text the ask returns.
const ASK_ANSWER = 'Mocked agent answer for the conflict ask.';

// The mock supervisor modifies this protected file on the start turn, which
// triggers a permission violation → the task transitions to `conflict`.
const MOCK_FILES = JSON.stringify([
  { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
]);

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function getStorageDir(root: string): string {
  return join(homedir(), '.lazy', basename(root));
}

/**
 * Resolve a short id to the full task UUID.
 *
 * `--task-id` is documented as the FULL uuid (see `lazy-agent mcp` usage) and
 * that is what the runners pass in production. The MCP ownership gate compares
 * it to `task.id` by identity, so handing the server a short id makes an agent
 * fail to recognize its OWN task.
 */
function fullTaskId(root: string, shortId: string): string {
  const tasksDir = join(getStorageDir(root), 'tasks');
  const fullId = readdirSync(tasksDir).find(d => d.startsWith(shortId));
  if (!fullId) throw new Error(`Task directory not found for ${shortId}`);
  return fullId;
}

function readTaskStatus(root: string, shortId: string): string {
  const tasksDir = join(getStorageDir(root), 'tasks');
  return JSON.parse(readFileSync(join(tasksDir, fullTaskId(root, shortId), 'task.json'), 'utf-8')).status;
}

/**
 * Drive a standalone MCP session that routes through the running daemon (no
 * LAZY_TEST → the daemon services the ask with its mock supervisor).
 */
async function runMcpSession(
  ctx: TestContext,
  taskId: string,
  messages: Array<{ method: string; id: number; params?: Record<string, unknown> }>,
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(
    ['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', ctx.root],
    {
      cwd: ctx.root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        LAZY_PROTOCOL_BASE: ctx.protocolBase,
        ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
        ...MCP_SERVER_ENV_PINS,
      },
    },
  );

  const stdin = proc.stdin as import('bun').FileSink;
  for (const msg of messages) {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    await Bun.sleep(50);
  }
  stdin.end();

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const responses: JsonRpcResponse[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      // skip non-JSON
    }
  }
  return responses;
}

describe('lazy_ask on conflict tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        // The daemon runs the supervisor; give it the mock response + the
        // protected-file modification that drives the task into `conflict`.
        LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
          result: ASK_ANSWER,
          session_id: 'mock-sess-conflict',
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
        LAZY_MOCK_SHOULD_COMMIT: '1',
        LAZY_MOCK_FILES: MOCK_FILES,
      },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: ask is read-only (plan-mode resume; no commits, no worktree
  // writes), and `conflict` is an askable blocked-variant. Asking a conflict
  // task must return the agent's answer AND leave the task in `conflict` —
  // never silently unblock or otherwise mutate its state.
  test('asking a conflict task returns an answer and leaves it in conflict', async () => {
    // Enable a protected pattern + add the file the mock agent will modify, so
    // the start turn completes with a violation → task lands in `conflict`.
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8') + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const startResult = await ctx.lazy(['start', taskId, '--yes']);
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Precondition: the task is genuinely in `conflict` (not `blocked`).
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Ask a question while the task sits in `conflict`.
    // Agent context, scoped to this very task — the server needs the full uuid
    // (what the runners pass) for the ownership gate to recognize it.
    const responses = await runMcpSession(ctx, fullTaskId(ctx.root, taskId), [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_ask', arguments: { task_id: taskId, message: 'Why did you change the spec file?' } },
      },
    ]);

    const callResponse = responses.find(r => r.id === 2);
    expect(callResponse).toBeDefined();
    const result = callResponse!.result as { content: Array<{ text: string }>; isError?: boolean };

    // The ask must NOT be rejected by the status gate, and must return the answer.
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(ASK_ANSWER);

    // INVARIANT: a read-only ask leaves the task exactly as it found it.
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
  });
});
