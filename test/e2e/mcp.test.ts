/**
 * E2E tests for the MCP server.
 *
 * Tests the lazy-agent mcp subcommand: starts the MCP server as a subprocess,
 * sends JSON-RPC messages via stdin, and verifies responses on stdout.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { writeFileSync } from 'fs';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Run a short MCP session: send messages, close stdin, collect all stdout.
 * Returns parsed JSON-RPC responses.
 */
async function runMcpSession(
  root: string,
  taskId: string,
  worktreePath: string,
  messages: Array<{ method: string; id: number; params?: Record<string, unknown> }>,
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', worktreePath], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const stdin = proc.stdin as import('bun').FileSink;

  // Send all messages
  for (const msg of messages) {
    const request = JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n';
    stdin.write(request);
    // Small delay between messages to ensure order
    await Bun.sleep(50);
  }

  // Close stdin to signal end
  stdin.end();

  // Read all output
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  // Parse responses (one per line)
  const responses: JsonRpcResponse[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      // Skip non-JSON lines
    }
  }

  return responses;
}

describe('lazy-agent mcp', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('starts and responds to initialize', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const initResponse = responses.find(r => r.id === 1);
    expect(initResponse).toBeDefined();
    expect(initResponse!.result).toBeDefined();

    const result = initResponse!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toBeDefined();
    expect(result.serverInfo).toBeDefined();

    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('lazy');

    // INVARIANT: initialize must return `instructions` so Claude Code injects
    // lazy MCP context into every session — including subagents spawned via the
    // Task tool, which would otherwise have no idea what lazy is or how to use
    // its tools.
    expect(typeof result.instructions).toBe('string');
    expect((result.instructions as string).length).toBeGreaterThan(0);
    expect(result.instructions as string).toContain('lazy_search');
  });

  test('lists all tools', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
      { method: 'tools/list', id: 2 },
    ]);

    const toolsResponse = responses.find(r => r.id === 2);
    expect(toolsResponse).toBeDefined();
    expect(toolsResponse!.result).toBeDefined();

    const result = toolsResponse!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    expect(result.tools).toBeArray();
    expect(result.tools.length).toBe(31);

    const toolNames = result.tools.map(t => t.name).sort();
    expect(toolNames).toEqual([
      'lazy_accept',
      'lazy_active',
      'lazy_add_followup',
      'lazy_ask',
      'lazy_blocked',
      'lazy_clone',
      'lazy_close',
      'lazy_comment',
      'lazy_commit',
      'lazy_conversation_read',
      'lazy_conversation_search',
      'lazy_conversations',
      'lazy_create',
      'lazy_diff',
      'lazy_edit',
      'lazy_list',
      'lazy_propose',
      'lazy_redo',
      'lazy_reject',
      'lazy_reopen',
      'lazy_reparent',
      'lazy_resume',
      'lazy_search',
      'lazy_show',
      'lazy_start',
      'lazy_status',
      'lazy_stop',
      'lazy_submit',
      'lazy_sync',
      'lazy_unblock',
      'lazy_wait',
    ]);

    // Each tool should have a description and inputSchema
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as Record<string, unknown>).type).toBe('object');
    }
  });

  test('responds to ping', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'ping', id: 2 },
    ]);

    const pingResponse = responses.find(r => r.id === 2);
    expect(pingResponse).toBeDefined();
    expect(pingResponse!.result).toEqual({});
    expect(pingResponse!.error).toBeUndefined();
  });

  test('returns error for unknown method', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'nonexistent/method', id: 2 },
    ]);

    const errorResponse = responses.find(r => r.id === 2);
    expect(errorResponse).toBeDefined();
    expect(errorResponse!.error).toBeDefined();
    expect(errorResponse!.error!.code).toBe(-32601);
  });

  test('returns error for unknown tool', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'nonexistent_tool', arguments: {} } },
    ]);

    const errorResponse = responses.find(r => r.id === 2);
    expect(errorResponse).toBeDefined();
    expect(errorResponse!.error).toBeDefined();
    expect(errorResponse!.error!.code).toBe(-32602);
    expect(errorResponse!.error!.message).toContain('nonexistent_tool');
  });

  test('lazy_status returns worktree info', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    expect(statusResponse).toBeDefined();
    expect(statusResponse!.result).toBeDefined();

    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeArray();
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.worktree).toBeDefined();
    expect(parsed.worktree.branch).toBe('main');
    expect(typeof parsed.worktree.changed_files).toBe('number');
  });

  test('lazy_commit commits changes', async () => {
    // Create a file to commit
    writeFileSync(join(ctx.root, 'test-file.txt'), 'hello from MCP test\n');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Test commit from MCP', files: ['test-file.txt'] } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    expect(commitResponse).toBeDefined();
    expect(commitResponse!.result).toBeDefined();

    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.committed).toBe(true);
    expect(parsed.sha).toBeTruthy();
    expect(parsed.message).toBe('Test commit from MCP');

    // Verify the commit actually happened
    const gitLog = ctx.git('log', '--oneline', '-1');
    expect(gitLog.stdout).toContain('Test commit from MCP');
  });

  test('lazy_commit returns nothing-to-commit when clean', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Empty commit' } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    expect(commitResponse).toBeDefined();

    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.committed).toBe(false);
  });

  test('lazy_search works with existing tasks', async () => {
    // Create a task first via the normal CLI
    const taskShortId = await createTask(ctx, 'Fix the authentication bug');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_search', arguments: { query: 'authentication' } } },
    ]);

    const searchResponse = responses.find(r => r.id === 2);
    expect(searchResponse).toBeDefined();

    const result = searchResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
  });

  test('lazy_create creates a new task', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'MCP test task', code: 'mcp-test' } } },
    ]);

    const createResponse = responses.find(r => r.id === 2);
    expect(createResponse).toBeDefined();

    const result = createResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goal).toBe('MCP test task');
    expect(parsed.code).toBe('mcp-test');
    expect(parsed.id).toBeTruthy();
    expect(parsed.status).toBe('backlog');

    // Verify via CLI
    const showResult = await ctx.lazy(['show', parsed.id]);
    expect(showResult.stdout).toContain('MCP test task');
  });

  test('lazy_show returns task details', async () => {
    // Create a task first
    const taskShortId = await createTask(ctx, 'Show test task');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskShortId } } },
    ]);

    const showResponse = responses.find(r => r.id === 2);
    expect(showResponse).toBeDefined();

    const result = showResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goal).toBe('Show test task');
    expect(parsed.status).toBe('backlog');
    expect(parsed.id).toBe(taskShortId);
  });

  test('lazy_show returns error for nonexistent task', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: 'nonexist' } } },
    ]);

    const showResponse = responses.find(r => r.id === 2);
    expect(showResponse).toBeDefined();

    const result = showResponse!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test('lazy_comment adds a comment to current task', async () => {
    // Create a task first and use its ID as the "current" task
    const taskShortId = await createTask(ctx, 'Comment test task');

    // We need the full UUID to pass to MCP. Look it up via show.
    const showResult = await ctx.lazy(['show', taskShortId, '--full']);
    const idMatch = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);

    // The MCP server takes a full UUID but the comment tool also accepts short IDs
    const responses = await runMcpSession(ctx.root, idMatch![1], ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_comment', arguments: { message: 'MCP comment test' } } },
    ]);

    const commentResponse = responses.find(r => r.id === 2);
    expect(commentResponse).toBeDefined();

    const result = commentResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe('MCP comment test');
    expect(parsed.task_id).toBe(taskShortId);
  });

  test('lazy_propose creates a proposal', async () => {
    // Create a task first
    const taskShortId = await createTask(ctx, 'Propose test task');
    const showResult = await ctx.lazy(['show', taskShortId, '--full']);
    const idMatch = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);

    const responses = await runMcpSession(ctx.root, idMatch![1], ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_propose', arguments: { goal: 'Add input validation', code: 'add-validation' } } },
    ]);

    const proposeResponse = responses.find(r => r.id === 2);
    expect(proposeResponse).toBeDefined();

    const result = proposeResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goal).toBe('Add input validation');
    expect(parsed.code).toBe('add-validation');
    expect(parsed.status).toBe('pending');
    expect(parsed.task_id).toBe(taskShortId);
  });

  test('handles malformed JSON gracefully', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', ctx.root], {
      cwd: ctx.root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    const stdin = proc.stdin as import('bun').FileSink;

    // Send malformed JSON
    stdin.write('this is not json\n');
    await Bun.sleep(50);

    // Send a valid request after the malformed one
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await Bun.sleep(50);

    stdin.end();

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const responses = stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

    // Should have a parse error response and a successful ping response
    expect(responses.length).toBe(2);

    const parseError = responses[0];
    expect(parseError.error).toBeDefined();
    expect(parseError.error.code).toBe(-32700);

    const pingResponse = responses[1];
    expect(pingResponse.id).toBe(1);
    expect(pingResponse.result).toEqual({});
  });

  test('exits cleanly when --help is passed', async () => {
    const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--help'], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('lazy-agent mcp');
    expect(stdout).toContain('--task-id');
    expect(stdout).toContain('--worktree');
  });

  test('exits with error when required flags are missing', async () => {
    const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp'], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Thorough lazy_commit tests (new tool, not a migration)
  // -----------------------------------------------------------------------

  test('lazy_commit with specific files array stages only those files', async () => {
    // Create two files but only commit one
    writeFileSync(join(ctx.root, 'included.txt'), 'should be committed\n');
    writeFileSync(join(ctx.root, 'excluded.txt'), 'should NOT be committed\n');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Selective commit', files: ['included.txt'] } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    expect(commitResponse).toBeDefined();

    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.committed).toBe(true);
    expect(parsed.sha).toBeTruthy();
    expect(parsed.message).toBe('Selective commit');
    expect(parsed.files_changed).toBe(1);
    expect(parsed.diff_stat).toContain('included.txt');

    // Verify excluded.txt is still untracked
    const status = ctx.git('status', '--porcelain');
    expect(status.stdout).toContain('excluded.txt');

    // Verify included.txt was committed
    const show = ctx.git('show', '--stat', '--format=', 'HEAD');
    expect(show.stdout).toContain('included.txt');
    expect(show.stdout).not.toContain('excluded.txt');
  });

  test('lazy_commit with no files stages all changes', async () => {
    writeFileSync(join(ctx.root, 'file-a.txt'), 'content a\n');
    writeFileSync(join(ctx.root, 'file-b.txt'), 'content b\n');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Stage all' } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.committed).toBe(true);
    expect(parsed.files_changed).toBe(2);

    // Worktree should be clean now
    const status = ctx.git('status', '--porcelain');
    expect(status.stdout.trim()).toBe('');
  });

  test('lazy_commit response includes structured fields', async () => {
    writeFileSync(join(ctx.root, 'structured.txt'), 'test\n');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Structured response test' } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    // Verify all expected fields are present
    expect(parsed.committed).toBe(true);
    expect(typeof parsed.sha).toBe('string');
    expect(parsed.sha.length).toBe(7);
    expect(typeof parsed.full_sha).toBe('string');
    expect(parsed.full_sha.length).toBe(40);
    expect(parsed.message).toBe('Structured response test');
    expect(typeof parsed.files_changed).toBe('number');
    expect(typeof parsed.diff_stat).toBe('string');
  });

  test('lazy_commit with files array containing paths with spaces', async () => {
    writeFileSync(join(ctx.root, 'file with spaces.txt'), 'spaces in name\n');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Spaces test', files: ['file with spaces.txt'] } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.committed).toBe(true);

    // Verify commit happened
    const gitLog = ctx.git('log', '--oneline', '-1');
    expect(gitLog.stdout).toContain('Spaces test');
  });

  test('lazy_commit clean worktree returns committed false', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'Nothing to do' } } },
    ]);

    const commitResponse = responses.find(r => r.id === 2);
    const result = commitResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.committed).toBe(false);
    expect(parsed.message).toContain('Nothing to commit');
    // Should NOT have sha or files_changed fields
    expect(parsed.sha).toBeUndefined();
    expect(parsed.files_changed).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Thorough lazy_status tests (new tool, not a migration)
  // -----------------------------------------------------------------------

  test('lazy_status returns correct branch name', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.worktree.branch).toBe('main');
    expect(parsed.worktree.path).toBe(ctx.root);
  });

  test('lazy_status shows correct changed file count', async () => {
    // Start clean, then add files
    writeFileSync(join(ctx.root, 'status-test-1.txt'), 'a\n');
    writeFileSync(join(ctx.root, 'status-test-2.txt'), 'b\n');
    writeFileSync(join(ctx.root, 'status-test-3.txt'), 'c\n');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.worktree.changed_files).toBe(3);
    expect(parsed.worktree.uncommitted_changes).toContain('status-test-1.txt');
    expect(parsed.worktree.uncommitted_changes).toContain('status-test-2.txt');
    expect(parsed.worktree.uncommitted_changes).toContain('status-test-3.txt');
  });

  test('lazy_status includes recent commits', async () => {
    // Make a commit so there's something in the log
    writeFileSync(join(ctx.root, 'for-log.txt'), 'log test\n');
    ctx.git('add', 'for-log.txt');
    ctx.git('commit', '-m', 'Commit for status log test');

    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.worktree.recent_commits).toContain('Commit for status log test');
  });

  test('lazy_status includes task metadata when task exists', async () => {
    const taskShortId = await createTask(ctx, 'Status metadata test task');
    const showResult = await ctx.lazy(['show', taskShortId, '--full']);
    const idMatch = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);

    const responses = await runMcpSession(ctx.root, idMatch![1], ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.task).toBeDefined();
    expect(parsed.task.id).toBe(taskShortId);
    expect(parsed.task.goal).toBe('Status metadata test task');
    expect(parsed.task.status).toBe('backlog');
  });

  test('lazy_status returns null task when task ID does not exist', async () => {
    const fakeTaskId = '99999999-9999-9999-9999-999999999999';

    const responses = await runMcpSession(ctx.root, fakeTaskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.task).toBeNull();
    expect(parsed.session).toBeNull();
    // Worktree info should still be present
    expect(parsed.worktree).toBeDefined();
    expect(parsed.worktree.branch).toBe('main');
  });

  // INVARIANT: Unknown parameters are rejected with a clear error message.
  // Callers must not silently lose parameters due to typos (e.g. parent_task_id vs parent).
  test('rejects unknown parameters with error and suggestions', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Test task', parent_task_id: 'abc123' } } },
    ]);

    const createResponse = responses.find(r => r.id === 2);
    expect(createResponse).toBeDefined();
    expect(createResponse!.error).toBeDefined();
    expect(createResponse!.error!.code).toBe(-32602);
    expect(createResponse!.error!.message).toContain('parent_task_id');
    expect(createResponse!.error!.message).toContain('parent');
    // Should list valid parameters so the caller can self-correct
    expect(createResponse!.error!.message).toContain('Valid parameters');
    expect(createResponse!.error!.message).toContain('goal');
  });

  test('rejects completely unknown parameters without suggestion', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: { xyzzy: true } } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    expect(statusResponse).toBeDefined();
    expect(statusResponse!.error).toBeDefined();
    expect(statusResponse!.error!.code).toBe(-32602);
    expect(statusResponse!.error!.message).toContain('xyzzy');
  });

  test('accepts valid parameters without error', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_search', arguments: { query: 'test', fuzzy: true } } },
    ]);

    const searchResponse = responses.find(r => r.id === 2);
    expect(searchResponse).toBeDefined();
    expect(searchResponse!.error).toBeUndefined();
    expect(searchResponse!.result).toBeDefined();
  });

  test('lazy_status shows zero changed files on clean worktree', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.worktree.changed_files).toBe(0);
    expect(parsed.worktree.uncommitted_changes).toBeNull();
  });

  // -----------------------------------------------------------------------
  // lazy_active tests - verifies it returns ALL non-terminal tasks with sessions
  // -----------------------------------------------------------------------

  test('lazy_active returns tasks in blocked status with sessions', async () => {
    // Create task 1: start it to get working status with session
    const t1ShortId = await createTask(ctx, 'Working task', 'Test prompt for task 1');
    const t1Start = await ctx.lazyMocked(['start', t1ShortId], MOCK_CLAUDE_SUCCESS);
    expect(t1Start.exitCode).toBe(0);

    // Create task 2: start it then wait to get blocked status with session
    const t2ShortId = await createTask(ctx, 'Blocked task', 'Test prompt for task 2');
    const t2Start = await ctx.lazyMocked(['start', t2ShortId], MOCK_CLAUDE_SUCCESS);
    expect(t2Start.exitCode).toBe(0);

    // Wait transitions the task to blocked
    const t2Wait = await ctx.lazy(['wait', t2ShortId]);
    expect(t2Wait.exitCode).toBe(0);

    // Create task 3: backlog status with NO session (should NOT be returned)
    const t3ShortId = await createTask(ctx, 'Backlog task without session');

    // Call lazy_active via MCP (using any task ID as context)
    const responses = await runMcpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_active', arguments: {} } },
    ]);

    const activeResponse = responses.find(r => r.id === 2);
    expect(activeResponse).toBeDefined();
    expect(activeResponse!.result).toBeDefined();

    const result = activeResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    // Should return 2 tasks (working + blocked, both have sessions)
    expect(parsed.count).toBe(2);
    expect(parsed.tasks).toHaveLength(2);

    // Extract returned task IDs
    const returnedIds = parsed.tasks.map((t: { id: string }) => t.id);

    // Should include both working and blocked tasks
    expect(returnedIds).toContain(t1ShortId); // working with session
    expect(returnedIds).toContain(t2ShortId); // blocked with session

    // Should NOT include backlog task without session
    expect(returnedIds).not.toContain(t3ShortId);
  });
});
