/**
 * INVARIANT (end-to-end): a long-running MCP tool call does not block other
 * tool calls from the same session.
 *
 * This exercises the REAL production path — a `lazy-agent mcp --daemon-config`
 * subprocess (the stdio JSON-RPC loop) forwarding over HTTP to a daemon — rather
 * than the stdio loop alone, because the serialization could have lived in
 * either half: the read loop awaiting each handler, or the proxy's fetch
 * multiplexing every call onto one connection. Both are covered here.
 *
 * The daemon is stubbed so "slow" is deterministic and controllable: the real
 * slow call is `lazy_accept` running a merge, which takes minutes and cannot be
 * staged in a test. What matters is the transport, and the stub speaks exactly
 * what src/daemon/server.ts speaks on POST /mcp/:taskId/:toolName.
 *
 * Regression: while a `lazy_accept` ran (2+ min), concurrent `lazy_active` /
 * `lazy_blocked` calls from the same builder hung for the accept's full
 * duration, while the daemon answered direct HTTP probes in milliseconds.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { spawn } from '../../src/utils/spawn';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');
const TOKEN = 'test-token';

interface JsonRpcLine {
  id: number | string | null;
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

describe('MCP tool calls do not serialize behind a long call', () => {
  let dir: string;
  let stub: ReturnType<typeof Bun.serve>;
  /** Resolves the in-flight slow tool call. */
  let releaseSlow!: () => void;
  /** Resolves once the stub has actually received the slow call. */
  let slowArrived!: () => void;
  let slowRunning: Promise<void>;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-mcp-conc-'));

    const slowDone = new Promise<void>(r => { releaseSlow = r; });
    slowRunning = new Promise<void>(r => { slowArrived = r; });

    // Port 0 — let the OS pick a free port rather than walking the shared
    // daemon window, which stray daemons can exhaust.
    stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/mcp\/([^/]+)\/(.+)$/);
        if (!match) return Response.json({ error: 'not found' }, { status: 404 });
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const tool = decodeURIComponent(match[2]);
        if (tool === 'lazy_accept') {
          slowArrived();
          await slowDone;
          return Response.json({ result: { merged: true } });
        }
        return Response.json({ result: { tool, fast: true } });
      },
    });

    configPath = join(dir, 'daemon-mcp.json');
    await writeFile(configPath, JSON.stringify({
      token: TOKEN,
      projectRoot: dir,
      taskId: '',
      target: `http://127.0.0.1:${stub.port}`,
    }));
  });

  afterEach(async () => {
    releaseSlow();
    stub.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test('a read completes while a long write is still in flight', async () => {
    const proc = spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--daemon-config', configPath, '--worktree', dir], {
      cwd: dir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
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
    const send = (id: number, name: string) => {
      stdin.write(JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} },
      }) + '\n');
      stdin.flush();
    };

    // Long write first...
    send(1, 'lazy_accept');
    await slowRunning;

    // ...then two reads that must not wait for it.
    send(2, 'lazy_active');
    send(3, 'lazy_blocked');

    const deadline = Date.now() + 10_000;
    while (lines.length < 2 && Date.now() < deadline) await Bun.sleep(20);

    const idsBeforeRelease = lines.map(l => l.id).sort();
    expect(idsBeforeRelease).toEqual([2, 3]);
    expect(lines.every(l => (l.result?.content[0].text ?? '').includes('fast'))).toBe(true);

    // Only now let the long call finish.
    releaseSlow();
    const acceptDeadline = Date.now() + 10_000;
    while (lines.length < 3 && Date.now() < acceptDeadline) await Bun.sleep(20);

    expect(lines.length).toBe(3);
    expect(lines[2].id).toBe(1);
    expect(lines[2].result?.content[0].text).toContain('merged');

    stdin.end();
    await reading;
    await proc.exited;
  }, 30_000);
});
