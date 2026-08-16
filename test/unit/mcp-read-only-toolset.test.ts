/**
 * INVARIANT: a read-only MCP server (ask turns) serves the read tools normally
 * and REFUSES the write tools with an actionable message.
 *
 * Both halves matter and each was a real failure mode:
 *
 *  - The reads must work. Ask turns previously had NO lazy tools at all (the
 *    ask path never wrote the MCP config into the container), so an agent asked
 *    about its own task answered "the lazy MCP tools are currently disconnected".
 *  - The writes must be withheld HERE, in the server, not only by the
 *    LAZY_MCP_READ_ONLY env guard in the handlers. Under the daemon proxy the
 *    handlers execute inside the daemon, which never sees that variable — so for
 *    a containerized agent the env guard alone is a no-op.
 *
 * A refused write must not answer "Unknown tool": that reads as lazy being
 * broken and pushes the model to abandon tools entirely. It stays registered
 * and unadvertised, and says what to do instead.
 */

import { describe, test, expect } from 'bun:test';
import { McpServer } from '../../src/mcp/server';
import { registerTools } from '../../src/mcp/index';
import { allTools } from '../../src/mcp/tools';
import { isReadOnlyTool } from '../../src/mcp/tool-access';
import type { McpToolHandler } from '../../src/mcp/types';

interface JsonRpcLine {
  id: number | string | null;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** Handlers that record they ran, so a leaked write tool is visible. */
function trackingHandlers(ran: string[]): Map<string, McpToolHandler> {
  const handlers = new Map<string, McpToolHandler>();
  for (const tool of allTools) {
    handlers.set(tool.name, async () => {
      ran.push(tool.name);
      return { ok: true };
    });
  }
  return handlers;
}

/** Drive the server over a scripted stdin and collect its replies. */
async function exchange(server: McpServer, requests: object[]): Promise<JsonRpcLine[]> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const req of requests) c.enqueue(encoder.encode(JSON.stringify(req) + '\n'));
      c.close();
    },
  });
  const lines: JsonRpcLine[] = [];
  await server.run({ input: stream, output: line => { lines.push(JSON.parse(line)); } });
  return lines;
}

function readOnlyServer(ran: string[]): McpServer {
  const server = new McpServer({ name: 'lazy', version: 'test' });
  registerTools(server, trackingHandlers(ran), allTools, { readOnly: true });
  return server;
}

describe('read-only MCP toolset (ask turns)', () => {
  test('tools/list advertises the read tools and nothing else', async () => {
    const ran: string[] = [];
    const [reply] = await exchange(readOnlyServer(ran), [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);

    const advertised = (reply.result?.tools ?? []).map(t => t.name).sort();
    expect(advertised.length).toBeGreaterThan(0);
    expect(advertised).toEqual(allTools.map(t => t.name).filter(isReadOnlyTool).sort());
    // The tools an ask turn actually needs to answer questions about live state.
    for (const name of ['lazy_show', 'lazy_list', 'lazy_search', 'lazy_status', 'lazy_diff']) {
      expect(advertised).toContain(name);
    }
    for (const name of ['lazy_accept', 'lazy_commit', 'lazy_unblock', 'lazy_close']) {
      expect(advertised).not.toContain(name);
    }
  });

  test('a read tool executes normally', async () => {
    const ran: string[] = [];
    const [reply] = await exchange(readOnlyServer(ran), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lazy_show', arguments: { task_id: 'abc' } } },
    ]);

    expect(reply.result?.isError).toBeFalsy();
    expect(ran).toEqual(['lazy_show']);
  });

  test('a write tool is refused with guidance, and its handler never runs', async () => {
    const ran: string[] = [];
    const [reply] = await exchange(readOnlyServer(ran), [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lazy_commit', arguments: { message: 'x' } } },
    ]);

    expect(reply.result?.isError).toBe(true);
    const text = reply.result?.content?.[0].text ?? '';
    expect(text).toContain('lazy_commit');
    expect(text).toContain('read-only turn');
    // Actionable, not a dead end — and NOT "Unknown tool".
    expect(text).toContain('lazy_show');
    expect(text).not.toContain('Unknown tool');
    expect(ran).toEqual([]);
  });

  test('without readOnly, every tool is advertised and callable', async () => {
    const ran: string[] = [];
    const server = new McpServer({ name: 'lazy', version: 'test' });
    registerTools(server, trackingHandlers(ran), allTools);

    const replies = await exchange(server, [
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lazy_commit', arguments: { message: 'x' } } },
    ]);

    const list = replies.find(r => r.id === 4);
    expect((list?.result?.tools ?? []).map(t => t.name).sort()).toEqual(allTools.map(t => t.name).sort());
    expect(ran).toEqual(['lazy_commit']);
  });
});
