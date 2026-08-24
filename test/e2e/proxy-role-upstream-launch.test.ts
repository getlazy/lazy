/**
 * The last proxy bypass, observed at the launch boundary.
 *
 * INVARIANT: no role configuration produces a direct connection. An `ollama`
 * role used to hand the launched agent the ollama endpoint as its
 * ANTHROPIC_BASE_URL and let it dial the model server itself — real agent
 * traffic with no audit record and no policy check. `endpoint` now names the
 * upstream lazy's PROXY forwards that role to, so the launched process must be
 * pointed at the proxy and must never be told the endpoint at all.
 *
 * Only the fake-binary seam can see this: it is the one seam where a real
 * supervisor really launches a real agent process, so the env it was handed is
 * observable. Asserting the ABSENCE of the endpoint is the point — nothing else
 * would fail if it started leaking back into the launch env.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';

describe('an ollama role is proxied, not dialed directly', () => {
  let ctx: TestContext;
  let ollama: ReturnType<typeof Bun.serve>;
  let ollamaUrl: string;
  /** Requests the stub Ollama server received, by path. */
  let hits: string[];

  beforeEach(async () => {
    hits = [];
    // A stand-in Ollama. It exists so the role's PREFLIGHT (which lazy runs on
    // the host, against the upstream the proxy would forward to) passes — and
    // so we can see whether anything else dialed it.
    ollama = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return Response.json({ models: [] });
      },
    });
    ollamaUrl = `http://127.0.0.1:${ollama.port}`;
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    ollama.stop(true);
    await ctx.cleanup();
  });

  /**
   * Point the agent role at the stub Ollama, and COMMIT it: the daemon resolves
   * a turn's config from the TASK WORKTREE, which is branched from main, so an
   * uncommitted edit would never reach the launch (same reason as `setGuards`).
   */
  async function useOllamaAgentRole(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${existing}\n[models.roles.agent]\nbackend = "ollama"\nmodel = "qwen-test"\nendpoint = "${ollamaUrl}"\n`,
    );
    ctx.git('add', 'lazy.toml');
    const commit = ctx.git('commit', '-m', 'Route the agent role at a stub Ollama');
    if (commit.exitCode !== 0) throw new Error(`Failed to commit role config: ${commit.stderr}`);
  }

  test('the agent is launched at the proxy and never told the ollama endpoint', async () => {
    await useOllamaAgentRole();
    const taskId = await createTask(ctx, 'Ollama role launch', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-ollama-role' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await ctx.claudeInvocations();
    const launched = invocations.filter(i => i.env?.ANTHROPIC_BASE_URL !== undefined);
    expect(launched.length).toBeGreaterThan(0);

    for (const inv of launched) {
      // THE assertion: the base URL is lazy's proxy, not the model server.
      expect(inv.env.ANTHROPIC_BASE_URL).not.toBe(ollamaUrl);
      expect(inv.env.ANTHROPIC_BASE_URL).not.toContain(String(ollama.port));
    }
    // Belt and braces: the endpoint appears nowhere in the launch — not in any
    // env var, not in the argv.
    expect(JSON.stringify(invocations)).not.toContain(String(ollama.port));

    // INVARIANT: an ollama-backed role is the documented escape hatch from the
    // daemon credential gate, so making it proxied must not quietly require a
    // real credential — but it still gets a redeemable placeholder, because
    // that grant is how the proxy authenticates the caller and knows which
    // role's upstream to forward it to.
    // ANTHROPIC_AUTH_TOKEN is the slot the synthetic local-backend credential
    // occupies, so its presence also proves this launch really resolved the
    // ollama role rather than falling through to the anthropic default.
    for (const inv of launched) {
      expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBeDefined();
      // A per-launch placeholder, not the literal stand-in.
      expect(inv.env.ANTHROPIC_AUTH_TOKEN).toContain('-lazy-');
    }

    // The only thing that dialed the model server directly is lazy's own
    // host-side preflight probe, which runs on the host before the launch. The
    // agent never reached it.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(p => p === '/api/tags')).toBe(true);
  }, 90_000);
});
