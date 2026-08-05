/**
 * INVARIANT: the MCP stdio server dispatches requests CONCURRENTLY.
 *
 * The read loop must never await a handler before reading the next request
 * line. Awaiting turned the stdio server into a global mutex over every lazy
 * tool: while one `lazy_accept` ran its merge (minutes), every following
 * `lazy_active` / `lazy_blocked` / `lazy_wait` from the same session sat unread
 * in the stdin buffer and appeared to hang — repeatedly misdiagnosed as a
 * "daemon blip" even though the daemon never received those requests.
 *
 * Ordering between genuinely conflicting mutations belongs to the daemon's
 * per-task lifecycle mutex (src/daemon/task-lifecycle-lock.ts), not to the
 * transport. A read must never queue behind an unrelated write.
 */

import { describe, test, expect } from 'bun:test';
import { McpServer } from '../../src/mcp/server';

interface JsonRpcLine {
  id: number | string | null;
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/** A stdin stand-in that a test can write lines into and later close. */
function scriptedInput(): {
  stream: ReadableStream<Uint8Array>;
  write: (line: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return {
    stream,
    write: (line: string) => controller.enqueue(encoder.encode(line + '\n')),
    close: () => controller.close(),
  };
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

function simpleTool(name: string) {
  return { name, description: name, inputSchema: { type: 'object' as const, properties: {} } };
}

describe('McpServer concurrent dispatch', () => {
  test('a fast read answers while a slow write is still in flight', async () => {
    const server = new McpServer({ name: 'test', version: '0' });

    let releaseSlow!: () => void;
    const slowDone = new Promise<void>(resolve => { releaseSlow = resolve; });
    let slowStarted!: () => void;
    const slowRunning = new Promise<void>(resolve => { slowStarted = resolve; });

    server.registerTool(simpleTool('slow_write'), async () => {
      slowStarted();
      await slowDone;
      return { ok: 'slow' };
    });
    server.registerTool(simpleTool('fast_read'), async () => ({ ok: 'fast' }));

    const io = scriptedInput();
    const lines: JsonRpcLine[] = [];
    const running = server.run({
      input: io.stream,
      output: line => { lines.push(JSON.parse(line)); },
    });

    io.write(toolCall(1, 'slow_write'));
    await slowRunning;

    io.write(toolCall(2, 'fast_read'));

    // The fast read must complete while the slow write is still blocked. If the
    // loop awaited, this poll would spin until the test timed out.
    const deadline = Date.now() + 5000;
    while (lines.length === 0 && Date.now() < deadline) await Bun.sleep(10);

    expect(lines.length).toBe(1);
    expect(lines[0].id).toBe(2);
    expect(lines[0].result?.content[0].text).toContain('fast');

    releaseSlow();
    io.close();
    await running;

    expect(lines.map(l => l.id)).toEqual([2, 1]);
    expect(lines[1].result?.content[0].text).toContain('slow');
  });

  test('replies are still delivered when stdin closes mid-flight', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    server.registerTool(simpleTool('slow_read'), async () => {
      await Bun.sleep(150);
      return { ok: true };
    });

    const io = scriptedInput();
    const lines: JsonRpcLine[] = [];
    const running = server.run({
      input: io.stream,
      output: line => { lines.push(JSON.parse(line)); },
    });

    io.write(toolCall(7, 'slow_read'));
    // Close immediately — run() must drain in-flight handlers before resolving.
    io.close();
    await running;

    expect(lines.length).toBe(1);
    expect(lines[0].id).toBe(7);
  });

  test('independent slow calls overlap rather than queue', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    server.registerTool(simpleTool('sleeper'), async () => {
      await Bun.sleep(200);
      return { ok: true };
    });

    const io = scriptedInput();
    const lines: JsonRpcLine[] = [];
    const started = Date.now();
    const running = server.run({
      input: io.stream,
      output: line => { lines.push(JSON.parse(line)); },
    });

    for (let i = 1; i <= 4; i++) io.write(toolCall(i, 'sleeper'));
    io.close();
    await running;

    const elapsed = Date.now() - started;
    expect(lines.length).toBe(4);
    // Serialized would be ~800ms; concurrent is ~200ms. 500ms separates them
    // without being flaky on a loaded machine.
    expect(elapsed).toBeLessThan(500);
  });

  test('a handler that throws outside the tool path still answers its id', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    server.registerTool(simpleTool('boom'), async () => { throw new Error('kaboom'); });

    const io = scriptedInput();
    const lines: JsonRpcLine[] = [];
    const running = server.run({
      input: io.stream,
      output: line => { lines.push(JSON.parse(line)); },
    });

    io.write(toolCall(3, 'boom'));
    io.close();
    await running;

    expect(lines.length).toBe(1);
    expect(lines[0].id).toBe(3);
    expect(lines[0].result?.isError).toBe(true);
    expect(lines[0].result?.content[0].text).toContain('kaboom');
  });
});
