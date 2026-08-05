/**
 * INVARIANT: a long MCP tool call reports liveness, and a client abort never
 * cancels work already in flight.
 *
 * The failure these encode: `lazy_accept` over the daemon MCP route ran its
 * pre-accept validation turn for 30 minutes while this server wrote nothing at
 * all to stdout. Claude Code (measured against 2.1.220) arms a per-call
 * watchdog whose clock is reset ONLY by the response or by a
 * `notifications/progress` message — "sent no response or progress for 1800s;
 * aborting" — with a 30-minute default for stdio servers. A pre-accept turn is
 * itself bounded at 30 minutes, so silence guaranteed the client would abandon
 * the accept mid-flight.
 *
 * The rule these tests pin is narrower than "emit progress": progress is
 * emitted from EVIDENCE (a heartbeat the daemon actually wrote), never from a
 * timer of our own. A self-driven keepalive would make a hung handler look
 * healthy forever and would defeat the watchdog it is meant to satisfy — so
 * "handler reports nothing" must keep producing nothing.
 */

import { describe, test, expect } from 'bun:test';
import { McpServer } from '../../src/mcp/server';
import type { McpToolCallContext } from '../../src/mcp/types';

interface JsonRpcLine {
  id?: number | string | null;
  method?: string;
  params?: { progressToken?: string | number; progress?: number; message?: string };
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/** A stdin stand-in a test can write lines into and later close. */
function scriptedInput(): {
  stream: ReadableStream<Uint8Array>;
  write: (line: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    stream,
    write: (line: string) => controller.enqueue(encoder.encode(line + '\n')),
    close: () => controller.close(),
  };
}

function simpleTool(name: string) {
  return { name, description: name, inputSchema: { type: 'object' as const, properties: {} } };
}

/** A tools/call line, with or without the client's progress token. */
function toolCall(id: number, name: string, progressToken?: string | number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: {},
      ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
    },
  });
}

/**
 * Run one tool call against a server whose handler is driven by the test:
 * `report` fires a progress report, `finish` resolves the handler.
 */
function harness(toolName: string) {
  const server = new McpServer({ name: 'test', version: '0' });
  const lines: JsonRpcLine[] = [];

  let reportFn: ((message?: string) => void) | undefined;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });

  server.registerTool(simpleTool(toolName), async (_args, ctx?: McpToolCallContext) => {
    reportFn = ctx?.reportProgress;
    started();
    await released;
    return { ok: true };
  });

  const io = scriptedInput();
  const finished = server.run({
    input: io.stream,
    output: line => { lines.push(JSON.parse(line)); },
  });

  return {
    io,
    lines,
    running,
    report: (message?: string) => reportFn?.(message),
    /** The handler's own progress channel, still callable after it resolved. */
    channel: () => reportFn,
    finish: async () => {
      release();
      io.close();
      await finished;
    },
    notifications: () => lines.filter(l => l.method === 'notifications/progress'),
    replies: () => lines.filter(l => l.id !== undefined && l.id !== null),
  };
}

describe('MCP tool-call progress', () => {
  // The fix: a reported heartbeat becomes a progress notification the client's
  // idle watchdog can see, written BEFORE the call settles.
  test('reported liveness becomes notifications/progress while the call runs', async () => {
    const h = harness('lazy_accept');
    h.io.write(toolCall(1, 'lazy_accept', 7));
    await h.running;

    h.report('accept running on the daemon (5s)');
    h.report('accept running on the daemon (10s)');

    // Both notifications must be out before the reply — that is the whole
    // point: the client is counting the silence, not the eventual result.
    expect(h.notifications().length).toBe(2);
    expect(h.replies().length).toBe(0);

    await h.finish();

    const progress = h.notifications();
    expect(progress[0].params?.progressToken).toBe(7);
    expect(progress[0].params?.message).toContain('accept running on the daemon');
    // MCP requires the progress value to increase for a given token.
    expect(progress[0].params?.progress).toBe(1);
    expect(progress[1].params?.progress).toBe(2);
    expect(h.replies().length).toBe(1);
  });

  // INVARIANT: no token, no notifications. The MCP spec allows progress only
  // for a request that carried a progressToken; an unsolicited one is a
  // protocol violation, and some clients reject the whole connection over it.
  test('a call without a progressToken emits no progress notifications', async () => {
    const h = harness('lazy_accept');
    h.io.write(toolCall(1, 'lazy_accept'));
    await h.running;

    h.report('should be swallowed');
    expect(h.notifications().length).toBe(0);

    await h.finish();
    expect(h.notifications().length).toBe(0);
    expect(h.replies().length).toBe(1);
  });

  // INVARIANT: progress comes from evidence, never from a clock of our own. A
  // handler that reports nothing produces nothing, so a genuinely wedged call
  // still trips the client's idle abort instead of being kept alive forever by
  // a keepalive ticker that knows nothing about the work.
  test('a silent handler produces no progress — liveness is never invented', async () => {
    const h = harness('lazy_accept');
    h.io.write(toolCall(1, 'lazy_accept', 'tok'));
    await h.running;

    await Bun.sleep(50);
    expect(h.notifications().length).toBe(0);

    await h.finish();
    expect(h.notifications().length).toBe(0);
  });

  // A handler that keeps its channel must not interleave a notification behind
  // the response for a request that is already answered.
  test('progress reported after the call settled is dropped', async () => {
    const h = harness('lazy_accept');
    h.io.write(toolCall(1, 'lazy_accept', 3));
    await h.running;
    await h.finish();

    const before = h.notifications().length;
    h.channel()?.('too late');
    expect(h.notifications().length).toBe(before);
  });

  // INVARIANT: cancellation NEVER cancels work in flight. The daemon owns the
  // operation (a merge, a container launch); a half-applied merge is far worse
  // than an unread result. The handler runs to completion and still replies —
  // a client that has moved on simply ignores an id it no longer tracks.
  test('notifications/cancelled does not abort the running tool call', async () => {
    const h = harness('lazy_accept');
    h.io.write(toolCall(1, 'lazy_accept', 1));
    await h.running;

    h.io.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1, reason: 'idle timeout' },
    }));
    await Bun.sleep(20);

    // Still running: no reply yet, and no error line invented for it.
    expect(h.replies().length).toBe(0);

    await h.finish();

    const replies = h.replies();
    expect(replies.length).toBe(1);
    expect(replies[0].result?.isError).toBeFalsy();
    expect(replies[0].result?.content[0].text).toContain('"ok": true');
  });
});
