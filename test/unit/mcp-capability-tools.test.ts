/**
 * INVARIANT: `lazy_image_build` is not even LISTED anywhere but a task agent's
 * work turn on a daemon that granted the `image-build` capability (a managed
 * daemon on the microVM backend — src/daemon/image-try-build.ts). It is kept
 * out of `allTools`, the role surface every agent and builder pays for, and is
 * still REGISTERED everywhere so a stale call gets its handler's refusal.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { McpServer } from '../../src/mcp/server';
import { registerTools } from '../../src/mcp/index';
import { allTools, capabilityTools, createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { toolNamesForRole } from '../../src/mcp/tool-surface';
import { readDaemonMcpConfig, readDaemonMcpConfigWithRetry } from '../../src/daemon/mcp-proxy';
import type { McpCapability, McpRole } from '../../src/mcp/tool-roles';
import type { McpToolset } from '../../src/mcp/tool-access';
import type { Storage } from '../../src/storage';

async function exchange(server: McpServer, requests: object[]) {
  const encoder = new TextEncoder();
  const lines: Array<{ id: number; result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } }> = [];
  await server.run({
    input: new ReadableStream({ start(c) { for (const r of requests) c.enqueue(encoder.encode(JSON.stringify(r) + '\n')); c.close(); } }),
    output: (line) => { lines.push(JSON.parse(line)); },
  });
  return lines;
}

async function listed(role: McpRole, capabilities: McpCapability[], toolset?: McpToolset): Promise<string[]> {
  const server = new McpServer({ name: 'lazy', version: 'test' });
  const handlers = createAllHandlers({ taskId: role === 'agent' ? 'abc12345' : '', worktreePath: '/nonexistent', storage: undefined as unknown as Storage });
  registerTools(server, handlers, allTools, { role, capabilities, ...(toolset ? { toolset } : {}) });
  const encoder = new TextEncoder();
  const lines: Array<{ id: number; result?: { tools?: Array<{ name: string }> } }> = [];
  await server.run({
    input: new ReadableStream({ start(c) { c.enqueue(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')); c.close(); } }),
    output: (line) => { lines.push(JSON.parse(line)); },
  });
  return (lines[0].result?.tools ?? []).map((t) => t.name);
}

describe('capability-gated MCP tools', () => {
  test('lazy_image_build is not part of any role surface', () => {
    expect(allTools.map((t) => t.name)).not.toContain('lazy_image_build');
    expect(capabilityTools.map((t) => t.name)).toEqual(['lazy_image_build']);
    expect(toolNamesForRole('agent')).not.toContain('lazy_image_build');
    expect(toolNamesForRole('builder')).not.toContain('lazy_image_build');
  });

  test('listed only to a task agent on a work turn holding the capability', async () => {
    expect(await listed('agent', ['image-build'])).toContain('lazy_image_build');
    expect(await listed('agent', [])).not.toContain('lazy_image_build');
    expect(await listed('builder', ['image-build'])).not.toContain('lazy_image_build');
    expect(await listed('agent', ['image-build'], 'read')).not.toContain('lazy_image_build');
    expect(await listed('agent', ['image-build'], 'review')).not.toContain('lazy_image_build');
  });

  test('the handler refuses outside a managed microVM daemon, and refuses the builder', async () => {
    const ctx = (taskId: string): McpToolContext => ({ taskId, worktreePath: '/nonexistent', storage: undefined as unknown as Storage });
    const agentErr = await createAllHandlers(ctx('abc12345')).get('lazy_image_build')!({}).catch((e: Error) => e) as Error;
    expect(String(agentErr.message)).toContain('only available on Lazy Teams projects that run on a microVM');
    const builderErr = await createAllHandlers(ctx('')).get('lazy_image_build')!({}).catch((e: Error) => e) as Error;
    expect(String(builderErr.message)).toContain('builder mode');
  });

  test('a daemon MCP config carries only capabilities lazy knows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-mcp-caps-'));
    try {
      const path = join(dir, 'c.json');
      await writeFile(path, JSON.stringify({ token: 't', projectRoot: '/p', taskId: 'x', target: 'http://h', capabilities: ['image-build', 'root-shell'] }));
      expect(readDaemonMcpConfig(path).capabilities).toEqual(['image-build']);
      await writeFile(path, JSON.stringify({ token: 't', projectRoot: '/p', taskId: 'x', target: 'http://h' }));
      expect(readDaemonMcpConfig(path).capabilities).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // INVARIANT: the container's MCP server reads its config through the
  // RETRYING reader; a capability that reader drops is a tool no agent sees.
  test('the retrying config reader carries the capability through to tools/list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-mcp-caps-retry-'));
    try {
      const path = join(dir, 'c.json');
      const listedFor = async (file: object) => {
        await writeFile(path, JSON.stringify(file));
        const config = await readDaemonMcpConfigWithRetry(path);
        const server = new McpServer({ name: 'lazy', version: 'test' });
        const handlers = createAllHandlers({ taskId: 'abc12345', worktreePath: '/nonexistent', storage: undefined as unknown as Storage });
        registerTools(server, handlers, allTools, { role: 'agent', capabilities: config.capabilities ?? [] });
        const [reply] = await exchange(server, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
        return (reply.result?.tools ?? []).map((t) => t.name);
      };
      const base = { token: 't', projectRoot: '/p', taskId: 'abc12345', target: 'http://h' };
      expect(await listedFor({ ...base, capabilities: ['image-build', 'bogus'] })).toContain('lazy_image_build');
      expect(await listedFor(base)).not.toContain('lazy_image_build');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('on a read-only turn a stale call gets the restricted-turn refusal, not "Unknown tool"', async () => {
    const server = new McpServer({ name: 'lazy', version: 'test' });
    registerTools(server, new Map(), allTools, { role: 'agent', toolset: 'read', capabilities: ['image-build'] });
    const replies = await exchange(server, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lazy_image_build', arguments: {} } },
    ]);
    expect((replies.find((r) => r.id === 1)?.result?.tools ?? []).map((t) => t.name)).not.toContain('lazy_image_build');
    const call = replies.find((r) => r.id === 2);
    expect(call?.result?.isError).toBe(true);
    expect(call?.result?.content?.[0].text ?? '').toMatch(/read-only turn/);
  });
});
