/**
 * Integration tests for active enforcement through the proxy server (§6.3 layer 1).
 *
 * Starts the proxy in front of a mock upstream that returns tool_use responses,
 * and verifies end-to-end that:
 *   - a default-denied mcp__claude_ai_* connector is rewritten out of the response
 *     and the client receives an explanatory text block (agent course-corrects)
 *   - an allowlisted connector passes through untouched
 *   - an enforcement audit record is written for a denial
 *   - non-tool responses stream through unbuffered (passthrough preserved)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer } from '../../src/proxy/server';
import { defaultPolicyConfig } from '../../src/proxy/policy';
import { parseSSEMessage } from '../../src/proxy/enforce';
import type { Storage } from '../../src/storage/interface';
import type { ProxyAuditRecord } from '../../src/storage/types';

function createMockStorage() {
  const records: ProxyAuditRecord[] = [];
  const storage = {
    appendAuditRecord: async (r: ProxyAuditRecord) => { records.push(r); },
    listAuditRecords: async () => records,
  } as unknown as Storage;
  return { storage, records };
}

function findFreePort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

/** A mock upstream that returns a streaming tool_use SSE response. */
function toolUseSSE(name: string, input: Record<string, unknown>, id = 'toolu_1'): string {
  return [
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: {} } })}`,
    ``,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })}`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    ``,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} })}`,
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ``,
  ].join('\n');
}

describe('proxy enforcement (server integration)', () => {
  let mockUpstream: ReturnType<typeof Bun.serve>;
  let upstreamPort: number;
  // What the mock upstream should return on the next request.
  let nextResponse: () => Response;

  beforeAll(async () => {
    upstreamPort = findFreePort();
    mockUpstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      async fetch() {
        return nextResponse();
      },
    });
    await new Promise((r) => setTimeout(r, 30));
  });

  afterAll(() => {
    mockUpstream.stop();
  });

  function startProxy(policyOverrides = {}) {
    const ms = createMockStorage();
    const proxy = createProxyServer(
      {
        port: findFreePort(),
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        policy: { ...defaultPolicyConfig(), ...policyOverrides },
      },
      ms.storage,
    );
    return { proxy, ms, port: (proxy as unknown as { port: number }).port };
  }

  // A request that DECLARES tools — the only shape whose response can carry a
  // fresh tool_use to enforce against.
  const reqWithTools = {
    model: 'claude-sonnet-4-6',
    stream: true,
    messages: [{ role: 'user', content: 'read my email' }],
    tools: [{ name: 'mcp__claude_ai_gmail_search_threads' }],
    max_tokens: 1024,
  };

  test('denies a mcp__claude_ai_* connector by default and delivers a text denial', async () => {
    nextResponse = () =>
      new Response(toolUseSSE('mcp__claude_ai_gmail_create_draft', { to: 'x@y.com' }, 'toolu_gmail'), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const { proxy, ms, port } = startProxy();
    await new Promise((r) => setTimeout(r, 20));

    const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lazy-role': 'agent', 'x-lazy-task-id': 't1' },
      body: JSON.stringify(reqWithTools),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    const msg = parseSSEMessage(text)!;

    // The denied connector tool_use is gone; the client sees a text explanation.
    expect(msg.content.filter((b) => b.type === 'tool_use')).toHaveLength(0);
    const texts = msg.content.filter((b) => b.type === 'text') as unknown as Array<{ text: string }>;
    expect(texts.some((t) => t.text.includes('mcp__claude_ai_gmail_create_draft'))).toBe(true);
    expect(msg.stop_reason).toBe('end_turn');

    // An enforcement audit record was written recording the denial.
    await new Promise((r) => setTimeout(r, 40));
    const rec = ms.records[ms.records.length - 1];
    expect(rec.enforcement).not.toBeNull();
    expect(rec.enforcement).toHaveLength(1);
    expect(rec.enforcement![0]).toMatchObject({ name: 'mcp__claude_ai_gmail_create_draft', rule: 'connector-deny-default' });
    proxy.stop();
  });

  test('an allowlisted connector passes through untouched', async () => {
    const sse = toolUseSSE('mcp__claude_ai_gmail_search_threads', { q: 'invoice' }, 'toolu_ok');
    nextResponse = () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    const { proxy, ms, port } = startProxy({ connectorAllowlist: ['mcp__claude_ai_gmail_search_threads'] });
    await new Promise((r) => setTimeout(r, 20));

    const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqWithTools),
    });
    const text = await resp.text();
    const msg = parseSSEMessage(text)!;
    const toolUses = msg.content.filter((b) => b.type === 'tool_use') as unknown as Array<{ name: string }>;
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('mcp__claude_ai_gmail_search_threads');

    await new Promise((r) => setTimeout(r, 40));
    expect(ms.records[ms.records.length - 1].enforcement).toBeNull();
    proxy.stop();
  });

  test('denies a secret-path Read tool_use', async () => {
    nextResponse = () =>
      new Response(toolUseSSE('Read', { path: '/home/user/.ssh/id_rsa' }, 'toolu_ssh'), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const { proxy, ms, port } = startProxy();
    await new Promise((r) => setTimeout(r, 20));

    const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...reqWithTools, tools: [{ name: 'Read' }] }),
    });
    const msg = parseSSEMessage(await resp.text())!;
    expect(msg.content.filter((b) => b.type === 'tool_use')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(ms.records[ms.records.length - 1].enforcement![0].rule).toBe('secret-path-read');
    proxy.stop();
  });

  test('a request with NO tools streams through untouched (passthrough preserved)', async () => {
    // Even if the (impossible) response carried a connector, a no-tools request
    // is never buffered — verify the body is returned verbatim and unenforced.
    const plain = `data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: {} } })}\n\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    nextResponse = () => new Response(plain, { headers: { 'content-type': 'text/event-stream' } });
    const { proxy, ms, port } = startProxy();
    await new Promise((r) => setTimeout(r, 20));

    const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(await resp.text()).toBe(plain);
    await new Promise((r) => setTimeout(r, 40));
    expect(ms.records[ms.records.length - 1].enforcement).toBeNull();
    proxy.stop();
  });
});
