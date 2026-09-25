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
import { extractTaskId } from '../helpers/assertions';
import { writeFileSync } from 'fs';
import { readSystemMessagesFile, readTaskJson } from '../helpers/storage';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

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
    env: { ...process.env, ...MCP_SERVER_ENV_PINS },
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

/** Resolve a task's full UUID from its short id via `lazy show --full`. */
async function fullTaskId(ctx: TestContext, shortId: string): Promise<string> {
  const showResult = await ctx.lazy(['show', shortId, '--full']);
  const match = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);
  if (!match) {
    throw new Error(`Could not extract full task id for ${shortId}: ${showResult.stdout}`);
  }
  return match[1];
}

describe('lazy-agent mcp', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Storage-dependent MCP tools (lazy_status/create/show/comment/...) reach
    // storage through resolveStorage(). The MCP server is spawned WITHOUT
    // LAZY_TEST=1 (runMcpSession pins it off, see MCP_SERVER_ENV_PINS), so it must
    // reach a real daemon over RPC — exactly like the pairing/builder MCP
    // server does in production. A daemonless setup leaves those tools with no
    // storage backend (resolveStorage throws "Daemon is not running"), and the
    // lazy_active test's start→wait lifecycle can't run without a daemon at all.
    // Mirrors the sibling mcp-start / mcp-actor / mcp-lifecycle suites.
    ctx = await setupTestLazy({ withDaemon: true });
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

  test('lists the tools an AGENT is served', async () => {
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
    // INVARIANT: this pins the tool surface an AGENT is served — the session is
    // spawned with --task-id, and a non-empty task id IS the agent role. If you
    // add/remove a tool, or change which role it is advertised to, update BOTH
    // the count and the sorted name list (a silently-dropped tool is a
    // regression, and a silently-added one is context every turn pays for).
    //
    // Absent by ROLE, not by removal: the builder-only tools (lazy_memory_save,
    // lazy_scratch, lazy_raised_promote, lazy_message_dismiss, lazy_clone,
    // lazy_redo, lazy_reparent) are still REGISTERED for this session — their
    // handlers answer with the same server-side refusal as before — but they are
    // not advertised, so an agent does not pay ~9k characters of context for
    // tools it can never call. The refusal, not the advertisement, is the
    // security boundary; see test/unit/mcp-tool-roles.test.ts.
    //
    // Advertised to agents ON PURPOSE, each with its own subtree gate rather
    // than a role hide: lazy_link (an agent may only adopt a branch/PR as a
    // child of its own task), lazy_review (own task or a direct subtask), and
    // lazy_raised_item_comment (agent-only — its handler refuses builder mode,
    // since it annotates "the current task"'s Raises).
    //
    // Removed outright and must NOT reappear: lazy_propose (agents decompose via
    // lazy_create + lazy_start), lazy_prioritize (removed with the agent
    // concurrency cap), and the pre-unification aliases lazy_add_followup /
    // lazy_followups / lazy_followup_promote — raised items are one entity now,
    // and lazy_raise / lazy_raised_items / lazy_raised_promote are the surface.
    // 48 since lazy_usage_limits; 47 since the final-turn slice 1 added `lazy_final`; 46 before that, when
    // the release-v022 merge added `lazy_regions`. Agent-advertised by design,
    // not by omission: reading a task's regions is open on both surfaces
    // (public-docs/surface-asymmetries.md §25) — an agent reviewing a large
    // branch a region at a time is what the tool exists for. Only the human
    // OVERLAY (naming, sign-off) is CLI-only, and that is a separate tool.
    expect(result.tools.length).toBe(48);

    const toolNames = result.tools.map(t => t.name).sort();
    expect(toolNames).not.toContain('lazy_propose');
    expect(toolNames).not.toContain('lazy_prioritize');
    expect(toolNames).not.toContain('lazy_add_followup');
    expect(toolNames).not.toContain('lazy_followups');
    expect(toolNames).not.toContain('lazy_followup_promote');
    expect(toolNames).toEqual([
      'lazy_accept',
      'lazy_active',
      'lazy_artifact_add',
      'lazy_artifact_get',
      'lazy_artifact_list',
      'lazy_ask',
      'lazy_blocked',
      'lazy_close',
      'lazy_comment',
      'lazy_commit',
      'lazy_conversation_ask',
      'lazy_conversation_read',
      'lazy_conversation_search',
      'lazy_conversations',
      'lazy_create',
      'lazy_diff',
      'lazy_edit',
      'lazy_final',
      'lazy_journal',
      'lazy_justify_maintain',
      'lazy_justify_protected',
      'lazy_link',
      'lazy_list',
      'lazy_memory_recall',
      'lazy_message_post',
      'lazy_messages',
      'lazy_raise',
      'lazy_raised_item_comment',
      'lazy_raised_items',
      'lazy_regions',
      'lazy_reject',
      'lazy_reopen',
      'lazy_report',
      'lazy_resume',
      'lazy_review',
      'lazy_search',
      'lazy_show',
      'lazy_start',
      'lazy_status',
      'lazy_stop',
      'lazy_submit',
      'lazy_sync',
      'lazy_tag',
      'lazy_unblock',
      'lazy_untag',
      'lazy_update_progress',
      'lazy_usage_limits',
      'lazy_wait',
    ]);

    // Each tool should have a description and inputSchema
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as Record<string, unknown>).type).toBe('object');
    }
  });

  // INVARIANT: hiding a tool from a role is an ADVERTISEMENT decision, never an
  // enforcement one. A builder-only tool stays registered for an agent session,
  // so an agent whose context still lists it (a stale system prompt, a resumed
  // conversation) gets the tool's own actionable refusal rather than the useless
  // "Unknown tool: lazy_memory_save".
  test('an unadvertised builder-only tool still answers with its refusal', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_memory_save',
          arguments: { name: 'x', description: 'd', type: 'project', body: 'b' },
        },
      },
    ]);

    const call = responses.find(r => r.id === 2);
    expect(call).toBeDefined();
    const text = JSON.stringify(call);
    expect(text).not.toContain('Unknown tool');
    expect(text.toLowerCase()).toContain('memory');
  });

  // INVARIANT: lazy_start must expose the `force_local` escape hatch so a
  // builder can start a task whose parent ref genuinely isn't on the remote
  // (the CLI has --force-local; the MCP tool must offer the same). Offline mode
  // implies it automatically, but the online missing-ref case needs it explicit.
  test('lazy_start exposes an optional force_local boolean param', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/list', id: 2 },
    ]);

    const result = responses.find(r => r.id === 2)!.result as {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, { type?: string }>; required?: string[] } }>;
    };
    const startTool = result.tools.find(t => t.name === 'lazy_start');
    expect(startTool).toBeDefined();
    expect(startTool!.inputSchema.properties?.force_local).toBeDefined();
    expect(startTool!.inputSchema.properties?.force_local?.type).toBe('boolean');
    // Optional — must not be in the required list.
    expect(startTool!.inputSchema.required ?? []).not.toContain('force_local');
  });

  // INVARIANT: `lazy_message_post` is the channel an agent uses MID-TASK to
  // report an environment problem only the human can fix. It survived the
  // removal of the wrap-up's systemic check, which was a different mechanism
  // (one prompt at the end of every final, asking what about the project got
  // in the way) — nothing in a turn's lifecycle files a message on the agent's
  // behalf, so this call is the only way one is created.
  test('lazy_message_post files a system message from an agent session', async () => {
    const taskShortId = await createTask(ctx, 'Infra reporter', 'Do work');
    const taskFullId = await fullTaskId(ctx, taskShortId);

    const responses = await runMcpSession(ctx.root, taskFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_message_post',
          arguments: {
            title: 'Flaky e2e suite on slow machines',
            body: 'The agent suite flakes on slow machines; needs an explicit timeout.',
            kind: 'notice',
          },
        },
      },
    ]);

    const call = responses.find(r => r.id === 2)!;
    expect(call.error).toBeUndefined();
    const result = call.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      id: string;
      short_id: string;
      source: string;
      title: string;
      kind: string;
      created_at: string;
    };
    expect(parsed.kind).toBe('notice');
    expect(parsed.title).toBe('Flaky e2e suite on slow machines');
    // The reply's short_id is the MESSAGE's (the read tool takes it) — the
    // task attribution rides `source`.
    expect(parsed.short_id).toBe(parsed.id.slice(0, 8));
    // Source is attributed to the filing task (no code set → the short id).
    expect(parsed.source).toBe(taskShortId);

    // It landed in the store, unread, verbatim.
    const messages = readSystemMessagesFile(ctx.root);
    expect(messages.length).toBe(1);
    expect(messages[0]!.id).toBe(parsed.id);
    expect(messages[0]!.kind).toBe('notice');
    expect(messages[0]!.title).toBe('Flaky e2e suite on slow machines');
    expect(messages[0]!.body).toContain('needs an explicit timeout');
    expect(messages[0]!.source).toBe(taskShortId);
    expect(messages[0]!.read_at).toBeUndefined();

    // And the human surface shows it.
    const listResult = await ctx.lazy(['messages']);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('Flaky e2e suite on slow machines');
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

  // When an agent (non-empty taskId) calls lazy_create, the new task is created
  // as a subtask of the agent's OWN task — never a top-level task.
  test('lazy_create creates a subtask of the calling agent task', async () => {
    const parentShortId = await createTask(ctx, 'Parent agent task');
    const parentFullId = await fullTaskId(ctx, parentShortId);

    const responses = await runMcpSession(ctx.root, parentFullId, ctx.root, [
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
    // The created task must be parented to the calling agent's task.
    expect(parsed.parent_task_id).toBe(parentShortId);

    // Verify via CLI that it shows up as a child of the parent
    const showResult = await ctx.lazy(['show', parentShortId]);
    expect(showResult.stdout).toContain('MCP test task');
  });

  // INVARIANT: Agents may only create subtasks of their OWN task. Passing a
  // branch (e.g. 'main') as parent — which would make a top-level task — is
  // rejected server-side. This is the create-ownership security boundary.
  test('lazy_create rejects an agent creating a top-level task (parent=branch)', async () => {
    const parentShortId = await createTask(ctx, 'Parent agent task');
    const parentFullId = await fullTaskId(ctx, parentShortId);

    const responses = await runMcpSession(ctx.root, parentFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Top level attempt', parent: 'main' } } },
    ]);

    const createResponse = responses.find(r => r.id === 2);
    expect(createResponse).toBeDefined();
    const result = createResponse!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('own task');
  });

  // INVARIANT: Agents may only create subtasks of their OWN task. Parenting
  // under a DIFFERENT existing task is rejected server-side.
  test('lazy_create rejects an agent creating under a different parent', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const otherShortId = await createTask(ctx, 'Some other task');

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Wrong parent attempt', parent: otherShortId } } },
    ]);

    const createResponse = responses.find(r => r.id === 2);
    expect(createResponse).toBeDefined();
    const result = createResponse!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('own task');
  });

  // An agent passing its OWN task id as parent is allowed (equivalent to omitting it).
  test('lazy_create allows an agent passing its own task id as parent', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_create', arguments: { goal: 'Explicit own parent', parent: myShortId } } },
    ]);

    const createResponse = responses.find(r => r.id === 2);
    const result = createResponse!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.parent_task_id).toBe(myShortId);
  });

  // INVARIANT: Agents may only START their own subtasks. Starting a task that
  // is not a child of the calling agent's task is rejected server-side, before
  // any worktree/branch/supervisor is created.
  test('lazy_start rejects an agent starting a task it does not own', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const otherShortId = await createTask(ctx, 'Unrelated task', 'Do work');

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_start', arguments: { task_id: otherShortId } } },
    ]);

    const startResponse = responses.find(r => r.id === 2);
    expect(startResponse).toBeDefined();
    const result = startResponse!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('own subtasks');
  });

  // INVARIANT: Agents may NOT reparent any task. Reparent is a builder/human
  // operation — allowing it would let an agent escape the create/start
  // ownership boundary.
  test('lazy_reparent rejects an agent caller', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const otherShortId = await createTask(ctx, 'Unrelated task');

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_reparent', arguments: { task_id: otherShortId, parent: 'main' } } },
    ]);

    const reparentResponse = responses.find(r => r.id === 2);
    expect(reparentResponse).toBeDefined();
    const result = reparentResponse!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('cannot reparent');
  });

  // ── Self-orchestration ownership boundary ────────────────────────────────
  // An agent may run its OWN subtasks end-to-end, but every task-MUTATING
  // self-orchestration tool is confined to the agent's own task or a direct
  // child. These tests encode that security boundary.
  //
  // It is a WRITE boundary only. Read-only tools are deliberately absent from
  // GATED_TOOLS — see the "reads are open tree-wide" block below.

  // INVARIANT: each state-changing self-orchestration tool rejects a target the
  // agent does not own (neither its own task nor a direct subtask),
  // server-side. `phrase` defaults to the shared own-task-or-direct-child
  // refusal. Accept is stricter (direct children ONLY — see the child-only
  // tests below), so it carries its own phrase.
  const GATED_TOOLS: Array<{ name: string; extraArgs: Record<string, unknown>; phrase?: string }> = [
    { name: 'lazy_unblock', extraArgs: { feedback: 'do x' } },
    { name: 'lazy_accept', extraArgs: {}, phrase: 'own direct subtasks' },
    { name: 'lazy_reject', extraArgs: {} },
    { name: 'lazy_close', extraArgs: { reason: 'nope' } },
    { name: 'lazy_edit', extraArgs: { goal: 'changed' } },
    { name: 'lazy_stop', extraArgs: { reason: 'x' } },
    { name: 'lazy_submit', extraArgs: {} },
    { name: 'lazy_resume', extraArgs: {} },
    { name: 'lazy_ask', extraArgs: { message: 'q' } },
    { name: 'lazy_sync', extraArgs: {} },
    { name: 'lazy_reopen', extraArgs: {} },
  ];

  for (const tool of GATED_TOOLS) {
    test(`${tool.name} rejects an agent targeting a task it does not own`, async () => {
      const myShortId = await createTask(ctx, 'My agent task');
      const myFullId = await fullTaskId(ctx, myShortId);
      const otherShortId = await createTask(ctx, 'Unrelated task', 'Do work');

      const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
        { method: 'initialize', id: 1, params: {} },
        { method: 'tools/call', id: 2, params: { name: tool.name, arguments: { task_id: otherShortId, ...tool.extraArgs } } },
      ]);

      const resp = responses.find(r => r.id === 2);
      expect(resp).toBeDefined();
      const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain(tool.phrase ?? 'own task or its direct subtasks');
    });
  }

  // INVARIANT: lazy_accept is stricter than the shared gate — a DIRECT SUBTASK
  // only. An agent accepting its OWN task would merge its work upward and mark
  // itself complete with no human review, which is exactly the boundary the
  // review step exists to hold. Refused server-side, not by prompt guidance.
  // (The merge behaviour itself lives in test/e2e/mcp-agent-accept.test.ts.)
  test('lazy_accept rejects an agent accepting its own task', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_accept', arguments: { task_id: myShortId } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('may not accept their own task');
  });

  // INVARIANT: lazy_clone and lazy_redo are OUT of the agent surface entirely —
  // both manufacture a task whose parent the agent cannot constrain to its own
  // subtree (clone parents under the source; redo under the original's parent).
  // An agent caller is rejected outright, even targeting its own task.
  for (const tc of [
    { name: 'lazy_clone', phrase: 'cannot clone' },
    { name: 'lazy_redo', phrase: 'cannot redo' },
  ]) {
    test(`${tc.name} rejects an agent caller outright`, async () => {
      const myShortId = await createTask(ctx, 'My agent task');
      const myFullId = await fullTaskId(ctx, myShortId);
      const otherShortId = await createTask(ctx, 'Unrelated task', 'Do work');

      const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
        { method: 'initialize', id: 1, params: {} },
        { method: 'tools/call', id: 2, params: { name: tc.name, arguments: { task_id: otherShortId } } },
      ]);

      const resp = responses.find(r => r.id === 2);
      expect(resp).toBeDefined();
      const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain(tc.phrase);
    });
  }

  // ── Reads are open tree-wide (the lazy flywheel) ─────────────────────────
  // INVARIANT: read-only MCP tools are NOT ownership-gated for agent callers.
  // An agent may read ANY task in the project — its own, a child's, a
  // stranger's. Agents learning from the work of the agents before them is the
  // day-one intent of lazy; gating reads defeated it (a spike told by its own
  // prompt to read a prior spike with lazy_show was refused and had to
  // reconstruct it from 500-char search excerpts). Explicit engineer decision,
  // 2026-08-06 — memory record `lazy-flywheel-agents-read-everything`, task
  // `agent-tree-read-access`. Writes stay gated (GATED_TOOLS above).
  // Do NOT re-add read gating or file its absence as a bug.
  test('lazy_show reads a task the agent does not own, in full', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const otherShortId = await createTask(ctx, 'Unrelated prior task', 'Prior task prompt body');

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: otherShortId, sections: ['turns'] } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goal).toBe('Unrelated prior task');
    // The full prompt, untruncated — this is the depth search excerpts cannot give.
    expect(parsed.prompt).toBe('Prior task prompt body');
  });

  // INVARIANT (flywheel, as above): lazy_diff and lazy_wait are read-only and
  // therefore ungated. A backlog task has no branch/session, so these calls may
  // still fail on task STATE — what must never appear is the ownership refusal.
  for (const tool of [
    { name: 'lazy_diff', extraArgs: {} },
    { name: 'lazy_wait', extraArgs: { timeout: 1 } },
  ]) {
    test(`${tool.name} does not refuse a task the agent does not own`, async () => {
      const myShortId = await createTask(ctx, 'My agent task');
      const myFullId = await fullTaskId(ctx, myShortId);
      const otherShortId = await createTask(ctx, 'Unrelated task', 'Do work');

      const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
        { method: 'initialize', id: 1, params: {} },
        { method: 'tools/call', id: 2, params: { name: tool.name, arguments: { task_id: otherShortId, ...tool.extraArgs } } },
      ]);

      const resp = responses.find(r => r.id === 2);
      const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      if (result.isError) {
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error).not.toContain('own task or its direct subtasks');
      }
    });
  }

  // INVARIANT: lazy_wait refuses exactly ONE target — the caller's own task.
  //
  // This is NOT an ownership rule (wait is open across the whole tree, per the
  // flywheel block above); it is mechanical. The caller's turn ending is
  // precisely the event the wait is waiting for, so an agent waiting on itself
  // can only sit there until the timeout expires. Refusing it up front, with a
  // message that says why, turns a silent 600 s stall into an immediate,
  // actionable error. Engineer decision, 2026-08-07 (task
  // `agent-tree-read-access`).
  test('lazy_wait rejects an agent waiting on its own task', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_wait', arguments: { task_id: myShortId, timeout: 1 } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('may not wait on their own task');
    // The message must explain the mechanism, not just refuse.
    expect(parsed.error).toContain('can only time out');
  });

  // An agent CAN review its own direct subtask.
  test('lazy_show allows an agent to inspect its own subtask', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const childRes = await ctx.lazy(['create', '--goal', 'My subtask', '--prompt', 'do', '--parent', myShortId]);
    const childShortId = extractTaskId(childRes.stdout);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: childShortId } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goal).toBe('My subtask');
  });

  // An agent CAN inspect its own task.
  test('lazy_show allows an agent to inspect its own task', async () => {
    const myShortId = await createTask(ctx, 'My own agent task');
    const myFullId = await fullTaskId(ctx, myShortId);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: myShortId } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goal).toBe('My own agent task');
    // INVARIANT: lazy_show carries the "Before you can accept" rows the show
    // RPC serves, so an agent can see what holds its own accept. Empty here —
    // nothing has run — but present, never absent.
    expect(parsed.accept_gate).toEqual({ rows: [] });
  });

  // The ownership gate must NOT block a lifecycle tool on an own subtask. The
  // accept then fails on task state (the subtask has no session yet) — a
  // different error — proving the gate let it through.
  test('lazy_accept lets an agent target its own subtask (gate passes)', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);
    const childRes = await ctx.lazy(['create', '--goal', 'My subtask', '--prompt', 'do', '--parent', myShortId]);
    const childShortId = extractTaskId(childRes.stdout);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_accept', arguments: { task_id: childShortId } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    if (result.isError) {
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).not.toContain('own direct subtasks');
    }
  });

  // INVARIANT: agents cannot reparent via lazy_edit's `parent` field — even on
  // their own task. That is the lazy_reparent backdoor and stays closed.
  test('lazy_edit forbids an agent changing a task parent (reparent backdoor)', async () => {
    const myShortId = await createTask(ctx, 'My agent task');
    const myFullId = await fullTaskId(ctx, myShortId);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_edit', arguments: { task_id: myShortId, parent: 'main' } } },
    ]);

    const resp = responses.find(r => r.id === 2);
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('cannot change a task\'s parent');
  });

  test('lazy_show returns task details', async () => {
    // The agent shows its OWN task (reads are open on any task; this is the
    // ordinary shape).
    const taskShortId = await createTask(ctx, 'Show test task');
    const taskFullId = await fullTaskId(ctx, taskShortId);

    const responses = await runMcpSession(ctx.root, taskFullId, ctx.root, [
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

  // INVARIANT: a builder driving tasks over MCP has no host CLI, so lazy_show
  // must report retry state. The positive path lives in
  // test/unit/mcp-retry-status.test.ts — forcing a `working` task here would
  // need in-test Storage writes, and this suite's daemon holds the storage lock.
  test('lazy_show omits retry_status when the task is not retrying', async () => {
    const taskShortId = await createTask(ctx, 'Non-retrying show task');
    const taskFullId = await fullTaskId(ctx, taskShortId);

    const responses = await runMcpSession(ctx.root, taskFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskShortId } } },
    ]);

    const result = responses.find(r => r.id === 2)!.result as { content: Array<{ type: string; text: string }> };
    expect(JSON.parse(result.content[0].text).retry_status).toBeUndefined();
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

  // This used to comment on the CALLER'S OWN task with `task_id` omitted. That
  // is now refused: an agent may only comment on a DIRECT SUBTASK, because a
  // comment is delivered into the target's next turn prompt and a comment on
  // yourself just lands in your own. Engineer decision, 2026-08-07 (task
  // `agent-tree-read-access`) — the refusal itself is asserted in
  // test/e2e/mcp-annotation-gate.test.ts; this test keeps the end-to-end
  // happy path over MCP, retargeted at a subtask.
  test('lazy_comment adds a comment to a direct subtask', async () => {
    const taskShortId = await createTask(ctx, 'Comment test task');
    const myFullId = await fullTaskId(ctx, taskShortId);
    const childRes = await ctx.lazy(['create', '--goal', 'Comment target', '--prompt', 'do', '--parent', taskShortId]);
    const childShortId = extractTaskId(childRes.stdout);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_comment', arguments: { task_id: childShortId, message: 'MCP comment test' } } },
    ]);

    const commentResponse = responses.find(r => r.id === 2);
    expect(commentResponse).toBeDefined();

    const result = commentResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe('MCP comment test');
    expect(parsed.task_id).toBe(childShortId);
  });

  // INVARIANT: lazy_propose is no longer exposed as an MCP tool. Calling it
  // must fail as an unknown tool — agents decompose/run work via lazy_create +
  // lazy_start (and the self-orchestration tools) instead.
  test('lazy_propose is no longer an available MCP tool', async () => {
    const taskShortId = await createTask(ctx, 'Propose removed task');
    const fullId = await fullTaskId(ctx, taskShortId);

    const responses = await runMcpSession(ctx.root, fullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_propose', arguments: { goal: 'Add input validation', code: 'add-validation' } } },
    ]);

    const proposeResponse = responses.find(r => r.id === 2);
    expect(proposeResponse).toBeDefined();
    expect(proposeResponse!.error).toBeDefined();
    expect(proposeResponse!.error!.code).toBe(-32602);
    expect(proposeResponse!.error!.message).toContain('lazy_propose');
  });

  test('handles malformed JSON gracefully', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';

    const proc = Bun.spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', ctx.root], {
      cwd: ctx.root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...MCP_SERVER_ENV_PINS },
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

  // INVARIANT: lazy_status carries the same dashboard base URL as
  // `lazy daemon dashboard-url`, so agents can construct clickable links
  // without a dedicated tool. Not a guessed host: it comes from the daemon.
  test('lazy_status includes dashboard_url matching the daemon dashboard', async () => {
    const urlResult = await ctx.lazy(['daemon', 'dashboard-url']);
    expect(urlResult.exitCode).toBe(0);
    const expected = urlResult.stdout.trim();

    const responses = await runMcpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_status', arguments: {} } },
    ]);

    const statusResponse = responses.find(r => r.id === 2);
    const result = statusResponse!.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.dashboard_url).toBe(expected);
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

    // Each task must carry its status and a substate field so consumers can see
    // what an active task is actually doing — the gap this task closed. substate
    // is a string for working tasks (agent / harness / not-alive) and null
    // otherwise.
    for (const task of parsed.tasks as Array<{ status: string; substate: string | null }>) {
      expect(typeof task.status).toBe('string');
      expect(task.status.length).toBeGreaterThan(0);
      expect('substate' in task).toBe(true);
    }

    // The blocked task is not `working`, so its substate is null.
    const blockedTask = parsed.tasks.find((t: { id: string }) => t.id === t2ShortId);
    expect(blockedTask.status).toBe('blocked');
    expect(blockedTask.substate).toBeNull();
  });

  // INVARIANT: lazy_active's optional task_id filters to the task's SUBTREE —
  // it and ALL descendants — mirroring `lazy active <task_id>` on the CLI.
  // lazy_list's task_id uses the SAME scope; both go through filterToSubtree,
  // so there is one definition of what a task_id filter means.
  test('lazy_active task_id filters to the task subtree, including grandchildren', async () => {
    const rootShortId = await createTask(ctx, 'Subtree root', 'Root work');
    expect((await ctx.lazyMocked(['start', rootShortId], MOCK_CLAUDE_SUCCESS)).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', rootShortId])).exitCode).toBe(0);
    const rootFullId = await fullTaskId(ctx, rootShortId);

    const childCreate = await ctx.lazy(['create', '--goal', 'Subtree child', '--prompt', 'Child work', '--parent', rootFullId]);
    expect(childCreate.exitCode).toBe(0);
    const childShortId = extractTaskId(childCreate.stdout);
    expect((await ctx.lazyMocked(['start', childShortId], MOCK_CLAUDE_SUCCESS)).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', childShortId])).exitCode).toBe(0);
    const childFullId = await fullTaskId(ctx, childShortId);

    const grandCreate = await ctx.lazy(['create', '--goal', 'Subtree grandchild', '--prompt', 'Grandchild work', '--parent', childFullId]);
    expect(grandCreate.exitCode).toBe(0);
    const grandShortId = extractTaskId(grandCreate.stdout);
    expect((await ctx.lazyMocked(['start', grandShortId], MOCK_CLAUDE_SUCCESS)).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', grandShortId])).exitCode).toBe(0);

    // A started task outside the subtree — must be filtered out.
    const outsiderShortId = await createTask(ctx, 'Outside the subtree', 'Other work');
    expect((await ctx.lazyMocked(['start', outsiderShortId], MOCK_CLAUDE_SUCCESS)).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', outsiderShortId])).exitCode).toBe(0);

    const responses = await runMcpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_active', arguments: { task_id: rootShortId } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_active', arguments: { task_id: 'no-such-task' } } },
    ]);

    const filtered = JSON.parse(
      (responses.find(r => r.id === 2)!.result as { content: Array<{ text: string }> }).content[0].text,
    );
    const ids = filtered.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(rootShortId);
    expect(ids).toContain(childShortId);
    expect(ids).toContain(grandShortId);
    expect(ids).not.toContain(outsiderShortId);
    expect(filtered.count).toBe(3);

    // Parent links come back so the subtree can be reassembled by a consumer.
    const child = filtered.tasks.find((t: { id: string }) => t.id === childShortId);
    expect(child.parent_task_id).toBe(rootShortId);

    // An unknown task_id is an error, not a silently unfiltered listing.
    const notFound = responses.find(r => r.id === 3)!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(notFound.isError).toBe(true);
    expect(notFound.content[0].text).toContain('Task not found: no-such-task');
  });

  // -----------------------------------------------------------------------
  // lazy_list scope — same as `lazy list [<id>]`
  // -----------------------------------------------------------------------

  // INVARIANT: lazy_list's task_id filters to the task's SUBTREE — it and ALL
  // descendants — exactly like `lazy list <id>` and like lazy_active's own
  // task_id. It used to return DIRECT CHILDREN only while its own description
  // promised the subtree, so an agent reviewing a decomposed task silently saw
  // a truncated tree and could conclude grandchild work did not exist.
  test('lazy_list task_id returns the whole subtree, including grandchildren', async () => {
    const rootShortId = await createTask(ctx, 'List subtree root', 'Root work');
    const rootFullId = await fullTaskId(ctx, rootShortId);

    const childCreate = await ctx.lazy(['create', '--goal', 'List subtree child', '--parent', rootFullId]);
    expect(childCreate.exitCode).toBe(0);
    const childShortId = extractTaskId(childCreate.stdout);
    const childFullId = await fullTaskId(ctx, childShortId);

    const grandCreate = await ctx.lazy(['create', '--goal', 'List subtree grandchild', '--parent', childFullId]);
    expect(grandCreate.exitCode).toBe(0);
    const grandShortId = extractTaskId(grandCreate.stdout);

    const outsiderShortId = await createTask(ctx, 'Outside the list subtree');

    const responses = await runMcpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_list', arguments: { task_id: rootShortId } } },
    ]);

    const parsed = JSON.parse(
      (responses.find(r => r.id === 2)!.result as { content: Array<{ text: string }> }).content[0].text,
    );
    const ids = parsed.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(rootShortId);
    expect(ids).toContain(childShortId);
    expect(ids).toContain(grandShortId); // the whole point — was missing before
    expect(ids).not.toContain(outsiderShortId);
  });

  // INVARIANT: `all` and `task_id` are INDEPENDENT — `all` decides which tasks
  // are in play, `task_id` narrows them to a subtree. `all` used to be ignored
  // whenever task_id was present, so asking for a subtree's closed subtasks
  // returned a non-terminal-only answer with no indication anything was hidden.
  test('lazy_list honors all together with task_id', async () => {
    const rootShortId = await createTask(ctx, 'All+subtree root', 'Root work');
    const rootFullId = await fullTaskId(ctx, rootShortId);

    const childCreate = await ctx.lazy(['create', '--goal', 'Closed child', '--parent', rootFullId]);
    expect(childCreate.exitCode).toBe(0);
    const childShortId = extractTaskId(childCreate.stdout);
    expect((await ctx.lazy(['close', childShortId, '--reason', 'not needed', '--yes'])).exitCode).toBe(0);

    const responses = await runMcpSession(ctx.root, '00000000-0000-0000-0000-000000000001', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_list', arguments: { task_id: rootShortId } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_list', arguments: { task_id: rootShortId, all: true } } },
    ]);

    const parse = (id: number) => JSON.parse(
      (responses.find(r => r.id === id)!.result as { content: Array<{ text: string }> }).content[0].text,
    );

    const withoutAll = parse(2).tasks.map((t: { id: string }) => t.id);
    expect(withoutAll).toContain(rootShortId);
    expect(withoutAll).not.toContain(childShortId); // terminal, excluded by default

    const withAll = parse(3).tasks.map((t: { id: string }) => t.id);
    expect(withAll).toContain(rootShortId);
    expect(withAll).toContain(childShortId); // `all` is honored WITH task_id
  });

  // -----------------------------------------------------------------------
  // lazy_diff base ref — one implementation, shared with `lazy diff`
  // -----------------------------------------------------------------------

  // INVARIANT: lazy_diff computes NO base ref of its own. It routes through the
  // daemon's handleDiff — the same code path `lazy diff` uses — so base-ref
  // resolution lives in exactly one place. The MCP side used to derive its own
  // base and fall back to the LITERAL branch name 'main' for every top-level
  // task, so a task targeting a release branch was diffed against main and
  // reported that branch's commits as its own work, with no error anywhere.
  test('lazy_diff bases the diff on the task target branch, not the literal main', async () => {
    expect(ctx.git('checkout', '-b', 'release-x').exitCode).toBe(0);
    // A commit that exists on release-x but not on main. Diffed against main it
    // would be attributed to the task; against release-x it correctly vanishes.
    writeFileSync(join(ctx.root, 'release-only.txt'), 'shipped on release-x\n');
    expect(ctx.git('add', 'release-only.txt').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'release-x only').exitCode).toBe(0);
    expect(ctx.git('checkout', 'main').exitCode).toBe(0);

    const create = await ctx.lazy(['create', '--goal', 'Diff base ref', '--prompt', 'Work']);
    expect(create.exitCode).toBe(0);
    const taskShortId = extractTaskId(create.stdout);
    expect((await ctx.lazyMocked(['start', taskShortId], MOCK_CLAUDE_SUCCESS)).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', taskShortId])).exitCode).toBe(0);
    // Point the started task at release-x through the supported route. (Setting
    // the target at create time does not survive `lazy start`, which rewrites a
    // top-level task's target to the repo default — a separate bug, filed as a
    // follow-up; reparent keeps this test about the diff base and nothing else.)
    expect((await ctx.lazyMocked(['reparent', taskShortId, '--parent', 'release-x', '--yes'], MOCK_CLAUDE_SUCCESS)).exitCode).toBe(0);
    expect((await ctx.lazy(['wait', taskShortId])).exitCode).toBe(0);
    const taskFullId = await fullTaskId(ctx, taskShortId);

    const responses = await runMcpSession(ctx.root, taskFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_diff', arguments: { task_id: taskShortId } } },
    ]);

    const result = responses.find(r => r.id === 2)!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.diff_range).toBe('release-x...HEAD');
    // The canonical short id, not whatever string the caller passed in.
    expect(parsed.task_id).toBe(taskShortId);
    // release-x's own commit is NOT the task's work.
    expect(parsed.diff).not.toContain('release-only.txt');
    // The "how to see everything" hint must name a call an MCP client can make.
    if (parsed.diff.includes('For full diff')) {
      expect(parsed.diff).toContain('lazy_diff(');
    }
  });

  // -----------------------------------------------------------------------
  // lazy_create: runner on the AGENT path
  // -----------------------------------------------------------------------

  // INVARIANT: every field lazy_create advertises on its schema is applied on
  // the agent path too. runner used to be read and then dropped when ctx.taskId
  // was set. It does not widen the agent's blast radius — the parent is still
  // forced to the calling task — so it is honored; silent acceptance was the
  // one unacceptable option.
  test('lazy_create applies runner when called by an agent', async () => {
    const parentShortId = await createTask(ctx, 'Runner parent');
    const parentFullId = await fullTaskId(ctx, parentShortId);

    const responses = await runMcpSession(ctx.root, parentFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_create',
          arguments: { goal: 'Honors runner', runner: 'podman' },
        },
      },
    ]);

    const result = responses.find(r => r.id === 2)!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.runner).toBe('podman');
    expect(parsed.parent_task_id).toBe(parentShortId);

    const stored = readTaskJson(ctx.root, parsed.id);
    expect(stored.runner_type).toBe('podman');
  });

  // --- artifacts ---

  test('lazy_artifact_add attaches a worktree file, and list/get read it back', async () => {
    const myShortId = await createTask(ctx, 'Artifact publisher');
    const myFullId = await fullTaskId(ctx, myShortId);
    writeFileSync(join(ctx.root, 'report.md'), '# findings\n');

    // The write and the reads are separate sessions on purpose: runMcpSession
    // pipelines requests without waiting for each response, so a read issued in
    // the same session can overtake the write it depends on.
    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_artifact_add', arguments: { path: 'report.md' } } },
    ]);
    const reads = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 3, params: { name: 'lazy_artifact_list', arguments: {} } },
      { method: 'tools/call', id: 4, params: { name: 'lazy_artifact_get', arguments: { name: 'report.md' } } },
    ]);

    const added = JSON.parse((responses.find(r => r.id === 2)!.result as any).content[0].text);
    expect(added.name).toBe('report.md');
    // An agent's own attach defaults to `output` — it is publishing something,
    // not being handed something.
    expect(added.origin).toBe('output');
    expect(added.worktree_path).toBe('.lazy-task-sandbox/artifacts/report.md');

    const listed = JSON.parse((reads.find(r => r.id === 3)!.result as any).content[0].text);
    expect(listed.artifacts.map((a: any) => a.name)).toEqual(['report.md']);
    expect(listed.remaining_slots).toBeGreaterThan(0);

    const got = JSON.parse((reads.find(r => r.id === 4)!.result as any).content[0].text);
    expect(got.content).toBe('# findings\n');
  });

  test('lazy_artifact_add accepts inline content and rejects two sources at once', async () => {
    const myFullId = await fullTaskId(ctx, await createTask(ctx, 'Inline artifact'));

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_artifact_add', arguments: { name: 'note.txt', content: 'inline' } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_artifact_add', arguments: { name: 'note.txt', content: 'inline', path: 'note.txt' } } },
    ]);

    const added = JSON.parse((responses.find(r => r.id === 2)!.result as any).content[0].text);
    expect(added.size).toBe(6);

    // Two content sources is an ambiguity we refuse rather than resolve by
    // precedence — the caller would never learn which one it got.
    const bad = responses.find(r => r.id === 3)!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(bad.isError).toBe(true);
  });

  // INVARIANT: attach is ownership-gated like every other agent write — an agent
  // cannot push files onto a task that is neither its own nor a direct subtask.
  test('lazy_artifact_add rejects an agent targeting an unrelated task', async () => {
    const myFullId = await fullTaskId(ctx, await createTask(ctx, 'My task'));
    const otherShortId = await createTask(ctx, 'Unrelated task');

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_artifact_add', arguments: { task_id: otherShortId, name: 'x.txt', content: 'x' } } },
    ]);

    const result = responses.find(r => r.id === 2)!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  // Reads stay open tree-wide (the lazy flywheel): an agent may read what
  // another task published without being able to write to it.
  test('lazy_artifact_list reads an unrelated task', async () => {
    const myFullId = await fullTaskId(ctx, await createTask(ctx, 'Reader'));
    const otherShortId = await createTask(ctx, 'Publisher');
    writeFileSync(join(ctx.root, 'out.txt'), 'published\n');
    await ctx.lazy(['artifact', 'add', otherShortId, 'out.txt']);

    const responses = await runMcpSession(ctx.root, myFullId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_artifact_list', arguments: { task_id: otherShortId } } },
    ]);

    const listed = JSON.parse((responses.find(r => r.id === 2)!.result as any).content[0].text);
    expect(listed.artifacts.map((a: any) => a.name)).toEqual(['out.txt']);
  });
});
