/**
 * `lazy watch --traffic` really prints traffic — real CLI, real daemon, real proxy.
 *
 * WHY THIS EXISTS: the unit wiring test proves the proxy publishes onto the bus
 * in-process, and the handler test proves the daemon filters and emits. Both
 * passed while the feature produced ZERO lines in the field: watch subscribed
 * with the task's full id, but the proxy attributes traffic from the credential
 * grant, which carries the task REF (`task.metadata.task_ref` — the task's code,
 * or its short id). The prefix match between them could never be true, so every
 * event was filtered out and the header printed above an empty screen.
 *
 * Nothing below the CLI can catch that class of bug, because every layer was
 * individually correct. So this suite runs the actual `lazy watch` subprocess
 * against a live daemon and asserts lines LAND ON STDOUT.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { extractTaskId } from '../helpers/assertions';

const ENTRY_PATH = join(import.meta.dir, '../../src/index.ts');

describe('lazy watch --traffic against a live daemon proxy', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  let upstream: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-watch-traffic-'));
    daemonBaseDir = await makeDaemonBaseDir();
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = req.method === 'GET' ? null : await req.json().catch(() => null);
        return Response.json({
          type: 'message',
          model: (body as { model?: string } | null)?.model ?? 'test-model',
          usage: { input_tokens: 7, output_tokens: 3 },
        });
      },
    });
  });

  afterEach(async () => {
    upstream?.stop(true);
    upstream = null;
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
    await removeDaemonBaseDir(daemonBaseDir);
  });

  const env = () => ({
    HOME: tmpHome,
    LAZY_DAEMON_BASE_DIR: daemonBaseDir,
    // A real daemon is running for this suite, so LAZY_TEST must stay unset —
    // otherwise the CLI takes the local-storage bypass and never reaches it.
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
    CLAUDE_CODE_OAUTH_TOKEN: '',
  });

  /** Pin `[server] port` to a port the OS just reported free. */
  async function pinFreeServerPort(): Promise<void> {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('p') });
    const port = probe.port!;
    probe.stop(true);
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    const updated = existing.replace(/^port\s*=\s*\d+/m, `port = ${port}`);
    expect(updated).not.toBe(existing);
    await writeFile(configPath, updated);
  }

  /** Send the proxy's forwards to the local mock instead of Anthropic. */
  async function pinUpstream(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${upstream!.port}"\n`,
    );
  }

  /** The live proxy address the daemon reports — the one agents are handed. */
  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
  }

  /**
   * Run `lazy watch` in the background, accumulating stdout.
   *
   * watch never exits on its own — that is the point of it — so this returns a
   * handle whose output is polled and which is killed by the test.
   */
  function startWatch(args: string[]) {
    const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
      cwd: ctx.root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env() },
    });
    let out = '';
    const pump = (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        out += new TextDecoder().decode(chunk);
      }
    })();
    return {
      output: () => out,
      async waitFor(needle: string, timeoutMs = 20_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (out.includes(needle)) return true;
          await Bun.sleep(150);
        }
        return false;
      },
      async stop() {
        proc.kill();
        await proc.exited;
        await pump.catch(() => {});
      },
    };
  }

  /**
   * A request as an AGENT sends it: attributed with the task REF, which is what
   * the launch mints its credential grant against, not the full task id.
   */
  async function sendAgentRequest(address: string, taskRef: string): Promise<number> {
    const res = await fetch(`${address}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lazy-role': 'agent',
        'x-lazy-task-id': taskRef,
      },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    await res.text();
    return res.status;
  }

  // THE FIELD BUG: watch was given the task's full id while the proxy recorded
  // the task's ref. Every layer agreed and the user saw nothing. Attribution
  // has to be resolved to the task, not string-matched.
  test('a task-scoped watch prints traffic attributed by task ref', async () => {
    await pinFreeServerPort();
    await pinUpstream();
    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);

    let watcher: ReturnType<typeof startWatch> | null = null;
    try {
      const created = await ctx.lazy(
        ['create', '--goal', 'traffic please', '--code', 'traffic-demo'],
        { env: env() },
      );
      expect(created.exitCode).toBe(0);
      const taskId = extractTaskId(created.stdout);
      const address = await proxyAddress();

      // Watch by full id — exactly what `lazy watch <task>` resolves to, and
      // exactly the form that did not match in the field.
      watcher = startWatch(['watch', taskId, '--traffic']);
      expect(await watcher.waitFor('Watching', 20_000)).toBe(true);

      const status = await sendAgentRequest(address, 'traffic-demo');
      expect(status).toBe(200);

      const sawLine = await watcher.waitFor('POST /v1/messages');
      expect(sawLine, `no traffic line rendered:\n${watcher.output()}`).toBe(true);
      expect(watcher.output()).toContain('net>');
      // The close half carries the outcome, so the watcher can tell a request
      // that finished from one still in flight.
      expect(await watcher.waitFor('200')).toBe(true);
    } finally {
      await watcher?.stop();
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  }, 90_000);

  // The firehose has no filter to get wrong, so it is the control: if this
  // passes and the scoped test above fails, the fault is attribution, not
  // plumbing. It also covers the CLI→daemon→bus path end to end.
  test('the firehose prints traffic from any task', async () => {
    await pinFreeServerPort();
    await pinUpstream();
    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);

    let watcher: ReturnType<typeof startWatch> | null = null;
    try {
      const address = await proxyAddress();
      watcher = startWatch(['watch', '--traffic']);
      expect(await watcher.waitFor('Watching', 20_000)).toBe(true);

      expect(await sendAgentRequest(address, 'some-other-task')).toBe(200);

      const sawLine = await watcher.waitFor('POST /v1/messages');
      expect(sawLine, `no traffic line rendered:\n${watcher.output()}`).toBe(true);
      // The firehose labels each line with its task (elided to keep lines short),
      // since more than one task can appear at once.
      expect(watcher.output()).toContain('some-oth');
    } finally {
      await watcher?.stop();
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  }, 90_000);
});
