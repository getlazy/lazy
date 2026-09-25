/**
 * End-to-end coverage for user-authored proxy request plugins: the
 * `.lazy/plugins/` convention, the `lazy customize proxy-plugin` scaffold that
 * writes into it, and what the proxy actually puts on the wire as a result.
 *
 * The chain under test is the real one — the CLI writes real files into a real
 * lazy project, the real loader imports them, and the real proxy server
 * forwards to a real upstream that records the RAW bytes it received. Nothing
 * about the plugin path is mocked, because the two claims that matter are both
 * claims about bytes: a project with no plugins is byte-identical to a build
 * without the seam, and a project with one has exactly that plugin's transform
 * applied.
 *
 * The loader is exercised in-process rather than through a booted daemon. It is
 * the same call the daemon makes at startup (src/daemon/server.ts), and driving
 * it directly keeps the fail-loud assertion about the plugin instead of about
 * daemon lifecycle.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { createProxyServer } from '../../src/proxy/server';
import {
  loadProxyRequestPlugins,
  proxyPluginDir,
  ProxyPluginLoadError,
} from '../../src/proxy/plugins/loader';
import type { ProxyRequestPlugin } from '../../src/proxy/plugins/types';
import type { AuditSink } from '../../src/proxy/audit';

enableInProcessTestMode();

// Audit records go to an AuditSink (the project-local bounded log in
// production), never to Storage — this test only needs it to swallow them.
function createMockSink(): AuditSink {
  return { append: async () => {} };
}

function findFreePort(): number {
  return 41000 + Math.floor(Math.random() * 8000);
}

const REQUEST_BODY = {
  model: 'claude-sonnet-4-6',
  max_tokens: 128,
  system: 'You are an agent working on a task in this repository.',
  messages: [{ role: 'user', content: 'Summarize the diff.' }],
};

describe('proxy request plugins', () => {
  let ctx: TestContext;
  let upstream: ReturnType<typeof Bun.serve>;
  let upstreamPort: number;
  let rawForwardedBody: string | null = null;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    upstreamPort = findFreePort();
    upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      async fetch(req) {
        rawForwardedBody = req.method === 'GET' ? null : await req.text();
        return Response.json({ type: 'message', ok: true });
      },
    });
  });

  afterEach(async () => {
    upstream.stop();
    await ctx.cleanup();
  });

  /** Run the real proxy in front of the recording upstream, with a real chain. */
  async function forward(plugins: readonly ProxyRequestPlugin[], bodyText: string): Promise<void> {
    const port = findFreePort();
    const server = createProxyServer(
      { port, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`, plugins },
      createMockSink(),
      // No credential broker: these tests exercise request plugins, not JIT injection.
      null,
    );
    try {
      // Cast widens the assignment so TS does not narrow the flow type to the
      // literal `null` (the same tsc quirk noted in proxy-server.test.ts).
      rawForwardedBody = null as string | null;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyText,
      });
      expect(resp.status).toBe(200);
      await resp.text();
    } finally {
      server.stop();
    }
  }

  /** Write a plugin module into the project's .lazy/plugins directory. */
  async function writePlugin(file: string, source: string): Promise<void> {
    const dir = proxyPluginDir(ctx.root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), source, 'utf-8');
  }

  // INVARIANT: the proxy is on every agent's critical path, and extending it is
  // opt-in by creating a file. A project that never creates one must forward the
  // client's bytes character for character — not a re-serialisation that merely
  // parses back to the same object, because upstream prompt-cache keys are
  // computed over the bytes.
  test('a project with no .lazy/plugins directory forwards bytes untouched', async () => {
    const plugins = await loadProxyRequestPlugins(ctx.root);
    expect(plugins).toEqual([]);

    const sent = JSON.stringify(REQUEST_BODY);
    await forward(plugins, sent);
    expect(rawForwardedBody).toBe(sent);
  });

  test('a user-authored plugin is applied to the request on the wire', async () => {
    await writePlugin(
      'tag-system.ts',
      `export default {
         name: 'tag-system',
         transformRequest(body) {
           const b = body as { system?: unknown };
           if (typeof b.system !== 'string') return null;
           return { ...(body as object), system: '[tagged] ' + b.system };
         },
       };`,
    );

    const plugins = await loadProxyRequestPlugins(ctx.root);
    expect(plugins.map((p) => p.name)).toEqual(['tag-system']);

    await forward(plugins, JSON.stringify(REQUEST_BODY));
    expect(rawForwardedBody).not.toBeNull();
    const forwarded = JSON.parse(rawForwardedBody!) as typeof REQUEST_BODY;
    expect(forwarded.system).toBe(`[tagged] ${REQUEST_BODY.system}`);
    // Everything the plugin did not touch is carried through unchanged.
    expect(forwarded.messages).toEqual(REQUEST_BODY.messages);
    expect(forwarded.model).toBe(REQUEST_BODY.model);
    expect(forwarded.max_tokens).toBe(REQUEST_BODY.max_tokens);
  });

  // INVARIANT (load time fails LOUD, unlike run time which fails open): the user
  // wrote this file on purpose. A proxy that comes up healthy while their
  // transform silently never runs is the worst possible outcome, so this is the
  // same posture as a malformed lazy.toml. This is the exact call the daemon
  // makes at startup, where the throw tears the daemon down with an actionable
  // message rather than falling back to unplugged forwarding.
  test('a broken plugin file fails loud rather than being skipped', async () => {
    await writePlugin('good.ts', `export default { name: 'good', transformRequest: () => null };`);
    await writePlugin('broken.ts', `export default { name: 'broken',,, };`);

    await expect(loadProxyRequestPlugins(ctx.root)).rejects.toThrow(ProxyPluginLoadError);
  });

  test('a module that loads but exports the wrong shape fails loud', async () => {
    await writePlugin('shapeless.ts', `export default { name: 'shapeless' };`);
    await expect(loadProxyRequestPlugins(ctx.root)).rejects.toThrow(/transformRequest/);
  });
});

describe('lazy customize proxy-plugin', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The scaffold's whole job is to produce something that WORKS before the user
  // writes any behaviour: it must load through the real loader and be a no-op on
  // the wire, so a user can confirm the wiring before debugging their transform.
  test('scaffolds a plugin the real loader accepts', async () => {
    const result = await ctx.lazy(['customize', 'proxy-plugin', 'my-plugin', '--no-prompt']);
    expectSuccess(result);
    expectOutput(result, '.lazy/plugins/my-plugin.ts');
    expectOutput(result, '.lazy/plugins/my-plugin.test.ts');

    const plugins = await loadProxyRequestPlugins(ctx.root);
    expect(plugins.map((p) => p.name)).toEqual(['my-plugin']);

    // The template is a deliberate no-op: it declines every request until edited.
    const transformed = plugins[0].transformRequest(
      { model: 'm', system: 'a prompt' },
      { method: 'POST', path: '/v1/messages', endpoint: 'messages' },
    );
    expect(transformed).toBeNull();
  });

  test('the scaffolded smoke test is skipped by the loader, not imported as a plugin', async () => {
    expectSuccess(await ctx.lazy(['customize', 'proxy-plugin', 'solo', '--no-prompt']));
    const plugins = await loadProxyRequestPlugins(ctx.root);
    // Two files were written; exactly one of them is a plugin.
    expect(plugins.map((p) => p.name)).toEqual(['solo']);
  });

  test('prints the agent guide prompt unless --no-prompt is passed', async () => {
    const result = await ctx.lazy(['customize', 'proxy-plugin', 'guided']);
    expectSuccess(result);
    expectOutput(result, 'Develop the lazy proxy request plugin scaffolded at');
    expectOutput(result, '.lazy/plugins/guided.ts');
    // The prompt must state the contract the plugin has to satisfy.
    expectOutput(result, 'Pure, synchronous, deterministic');
  });

  // Scaffolding is a write into the user's project, so it must not clobber work
  // in progress — the second run refuses instead of overwriting the first.
  test('refuses to overwrite an existing plugin without --force', async () => {
    expectSuccess(await ctx.lazy(['customize', 'proxy-plugin', 'dup', '--no-prompt']));
    const pluginPath = join(proxyPluginDir(ctx.root), 'dup.ts');
    await writeFile(pluginPath, '// hand-edited\n' + (await readFile(pluginPath, 'utf-8')), 'utf-8');

    const second = await ctx.lazy(['customize', 'proxy-plugin', 'dup', '--no-prompt']);
    expectFailure(second);
    expectError(second, 'already exists');
    expect(await readFile(pluginPath, 'utf-8')).toContain('// hand-edited');

    const forced = await ctx.lazy(['customize', 'proxy-plugin', 'dup', '--force', '--no-prompt']);
    expectSuccess(forced);
    expect(await readFile(pluginPath, 'utf-8')).not.toContain('// hand-edited');
  });

  test('rejects a name that would not be a safe filename', async () => {
    const result = await ctx.lazy(['customize', 'proxy-plugin', '../escape', '--no-prompt']);
    expectFailure(result);
    expectError(result, 'not a valid plugin name');
    // Nothing was written anywhere.
    await expect(loadProxyRequestPlugins(ctx.root)).resolves.toEqual([]);
  });

  test('an unknown customize subcommand fails with the family usage', async () => {
    const result = await ctx.lazy(['customize', 'not-a-thing']);
    expectFailure(result);
    expectError(result, 'Unknown subcommand: customize not-a-thing');
    // Usage goes to stdout, the same way every other multiplexer prints it.
    expectOutput(result, 'proxy-plugin');
  });
});
