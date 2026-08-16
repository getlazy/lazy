/**
 * INVARIANT (end-to-end): a tool call that outlives the daemon listener's idle
 * timer still completes, and a daemon that is up is never reported as down.
 *
 * This drives the REAL container-side client — a `lazy-agent mcp
 * --daemon-config` subprocess speaking stdio JSON-RPC, forwarding over HTTP —
 * because that is the half the failure lived in. The daemon is stubbed so the
 * idle timeout can be compressed from 120s to 5s; the stub speaks exactly what
 * src/daemon/server.ts speaks on POST /mcp/:taskId/:toolName, including the
 * heartbeat envelope, so the framing under test is the production framing.
 *
 * Regression: `lazy_wait` (timeout=600) failed twice from a builder with
 * "could not reach the daemon ... The daemon appears to be down", while that
 * daemon answered /daemon/status in 5ms and served every other tool call from
 * the same session. Two distinct defects hide behind that one message — a long
 * call that is not kept alive dies at the idle timeout, and the error that
 * results blames the wrong thing.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { spawn } from '../../src/utils/spawn';
import { HEARTBEAT_HEADER, heartbeatEnvelopeResponse } from '../../src/daemon/heartbeat';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');
const TOKEN = 'test-token';

/**
 * Shorter than the work below, so a call that is NOT kept alive is reaped
 * rather than merely slow. Bun degenerates idleTimeout values of 2-4 into a
 * ~4s hard deadline, so 5 is the floor.
 */
const TEST_IDLE_TIMEOUT_S = 5;
const SLOW_OP_MS = 16_000;
const TEST_HEARTBEAT_MS = 1_000;

interface JsonRpcLine {
  id?: number | string | null;
  method?: string;
  params?: { progressToken?: string | number; progress?: number; message?: string };
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/** Every line the MCP subprocess wrote, in the order it wrote them. */
interface CallResult {
  reply: JsonRpcLine;
  progress: JsonRpcLine[];
  /** How many progress notifications landed BEFORE the reply line. */
  progressBeforeReply: number;
}

describe('MCP long tool calls survive the daemon idle timeout', () => {
  let dir: string;
  let stub: ReturnType<typeof Bun.serve> | undefined;
  let configPath: string;
  /** Set by the stub when the client asked for heartbeat framing. */
  let sawHeartbeatHeader: string | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-mcp-wait-'));
    configPath = join(dir, 'daemon-mcp.json');
    sawHeartbeatHeader = null;
  });

  afterEach(async () => {
    try { stub?.stop(true); } catch { /* already stopped */ }
    stub = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Start a stub daemon. `mode: 'truncate'` sends the framing preamble and then
   * drops the stream without a result line — what a long call looks like when
   * the connection dies mid-flight while the daemon itself stays up.
   */
  async function startStub(mode: 'frame' | 'truncate'): Promise<void> {
    stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: TEST_IDLE_TIMEOUT_S,
      async fetch(req) {
        const url = new URL(req.url);
        // Answering /daemon/status is the whole point of the second test: it is
        // the evidence that proves the daemon is up.
        if (url.pathname === '/daemon/status') {
          return Response.json({ status: 'running', projectRoot: dir });
        }
        const match = url.pathname.match(/^\/mcp\/([^/]+)\/(.+)$/);
        if (!match) return Response.json({ error: 'not found' }, { status: 404 });
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        sawHeartbeatHeader = req.headers.get(HEARTBEAT_HEADER);

        if (mode === 'frame') {
          return heartbeatEnvelopeResponse(
            async () => {
              await Bun.sleep(SLOW_OP_MS);
              return { status: 200, body: { result: { task_id: 'abc12345', status: 'working', timed_out: true } } };
            },
            { intervalMs: TEST_HEARTBEAT_MS },
          );
        }

        // Framing declared, preamble sent, then the stream ends with no result
        // line — byte-for-byte what the client sees when a framed call is cut
        // off mid-flight.
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ lazyEnvelope: 1 }) + '\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        );
      },
    });

    await writeFile(configPath, JSON.stringify({
      token: TOKEN,
      projectRoot: dir,
      taskId: '',
      target: `http://127.0.0.1:${stub.port}`,
    }));
  }

  /**
   * Run one `lazy_wait` tool call through a real MCP subprocess. Passing a
   * `progressToken` is what a client does to ask for liveness reports.
   */
  async function callWait(progressToken?: number): Promise<CallResult> {
    const proc = spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--daemon-config', configPath, '--worktree', dir], {
      cwd: dir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...MCP_SERVER_ENV_PINS },
    });

    const lines: JsonRpcLine[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try { lines.push(JSON.parse(line)); } catch { /* banner noise */ }
        }
      }
    })();

    const stdin = proc.stdin as import('bun').FileSink;
    stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'lazy_wait',
        arguments: { task_id: 'abc12345', timeout: 600 },
        ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
      },
    }) + '\n');
    stdin.flush();

    const isReply = (l: JsonRpcLine) => l.id !== undefined && l.id !== null;
    const deadline = Date.now() + SLOW_OP_MS + 20_000;
    while (!lines.some(isReply) && Date.now() < deadline) await Bun.sleep(50);

    stdin.end();
    await reading;
    await proc.exited;

    const replies = lines.filter(isReply);
    if (replies.length !== 1) {
      const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      throw new Error(`expected 1 JSON-RPC reply, got ${replies.length}. stderr:\n${err}`);
    }
    const replyIndex = lines.findIndex(isReply);
    const progress = lines.filter(l => l.method === 'notifications/progress');
    return {
      reply: replies[0],
      progress,
      progressBeforeReply: lines
        .slice(0, replyIndex)
        .filter(l => l.method === 'notifications/progress').length,
    };
  }

  // The reproduction: 16s of work against a 5s idle timer. It only survives
  // because the client asks for framing and the daemon honours it.
  test('a wait longer than the idle timeout returns its result', async () => {
    await startStub('frame');
    const { reply } = await callWait();

    // The client must have opted in — without this header the daemon replies
    // unframed and the connection is reaped mid-call.
    expect(sawHeartbeatHeader).not.toBeNull();
    expect(reply.result?.isError).toBeFalsy();
    expect(reply.result?.content[0].text).toContain('abc12345');
    expect(reply.result?.content[0].text).toContain('timed_out');
  }, SLOW_OP_MS + 40_000);

  // INVARIANT: the daemon answering /daemon/status is NOT down, so the error
  // must not say it is. This is the misdiagnosis from the field report — the
  // operator was told to relaunch a builder that did not need relaunching.
  test('a call cut off mid-flight fails as a lost connection, never as a down daemon', async () => {
    await startStub('truncate');
    const { reply } = await callWait();

    expect(reply.result?.isError).toBe(true);
    const text = reply.result?.content[0].text ?? '';
    expect(text).not.toContain('appears to be down');
    expect(text).toContain('lazy_wait');
    expect(text).toContain('not a daemon that is down');
  }, SLOW_OP_MS + 40_000);

  /**
   * The field failure, reproduced end-to-end: `lazy_accept` spent 30 minutes in
   * its pre-accept validation turn while this subprocess wrote nothing at all,
   * and the client aborted at its 1800s idle limit. The daemon's heartbeats
   * were already flowing over HTTP — they died here, in the process that reads
   * them. Below, a 16s call must produce progress lines on stdout WHILE it runs.
   */
  test('a long call reports progress to the client while it is still running', async () => {
    await startStub('frame');
    const { reply, progress, progressBeforeReply } = await callWait(42);

    // The heartbeat interval is 1s over a 16s call; anything above a handful
    // proves a stream, not a single courtesy frame. Kept loose because the
    // subprocess spawn and HTTP setup eat an unpredictable slice of the window.
    expect(progressBeforeReply).toBeGreaterThanOrEqual(3);
    // INVARIANT: progress must precede the reply. A notification emitted after
    // the result is worthless — the client's watchdog has already fired.
    expect(progressBeforeReply).toBe(progress.length);
    expect(progress[0].params?.progressToken).toBe(42);
    // MCP requires the value to increase for a given token.
    expect(progress[0].params?.progress).toBe(1);
    expect(progress[1].params?.progress).toBe(2);
    expect(progress[0].params?.message).toContain('lazy_wait');

    // And the call still returns its real result.
    expect(reply.result?.isError).toBeFalsy();
    expect(reply.result?.content[0].text).toContain('abc12345');
  }, SLOW_OP_MS + 40_000);

  // INVARIANT: no progressToken, no notifications. The MCP spec permits
  // progress only for a request that asked for it; an unsolicited notification
  // is a protocol violation some clients drop the connection over. The long
  // call must still succeed — framing keeps it alive regardless of progress.
  test('a long call without a progressToken emits no notifications and still succeeds', async () => {
    await startStub('frame');
    const { reply, progress } = await callWait();

    expect(progress.length).toBe(0);
    expect(reply.result?.isError).toBeFalsy();
    expect(reply.result?.content[0].text).toContain('abc12345');
  }, SLOW_OP_MS + 40_000);
});
