import { describe, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * The proxy plane fails loud.
 *
 * INVARIANT (the audit plane must not silently degrade): the proxy is ALWAYS
 * ON — there is no `[proxy] enabled` option any more — so every launch routes
 * model traffic through lazy's local audit/policy proxy. When the live proxy address cannot be resolved
 * (daemon down, RPC failure, proxy not bound), the launch FAILS with an
 * actionable error. It must NEVER fall through to a direct api.anthropic.com
 * connection: that traffic would be unaudited and unenforced while the audit
 * trail recorded nothing, so the trail would lie by omission — and, being
 * silent, the degradation would rot unnoticed. Daemon RPC blips are real, so
 * this path is exercised in practice.
 *
 * There is NO opt-out. `[proxy] enabled` was removed: `enabled = false` is
 * rejected at load and `enabled = true` warns as a dead line; the only way to
 * send a role somewhere else is an explicit `endpoint` on that role, which was
 * never proxied to begin with.
 *
 * How the gate is armed here: a daemonless e2e suite runs the CLI with
 * LAZY_TEST=1, under which the daemon RPC is bypassed BY DESIGN (there is no
 * daemon to answer and no launch to protect), so the gate is deliberately off.
 * `LAZY_FORCE_PROXY_GATE=1` re-arms it — the same technique as
 * `LAZY_FORCE_PREFLIGHT` / `LAZY_FORCE_TTY`, and the reason the production code
 * keys off an explicit bypass signal rather than "the RPC returned null".
 */
describe('proxy fail-loud', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function appendConfig(extra: string): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    await writeFile(configPath, existing + '\n' + extra, 'utf-8');
  }

  /** Arm the gate so the CLI behaves as it does in production (no LAZY_TEST bypass). */
  const ARMED = { env: { LAZY_FORCE_PROXY_GATE: '1' } };

  test('launch fails actionably when the proxy is unresolvable', async () => {
    // No [proxy] section at all — the proxy is always on.
    const result = await ctx.lazy(['pair'], ARMED);

    expectFailure(result);
    // What was attempted and why it is blocked...
    expectError(result, 'could not resolve the live proxy address');
    // Post proxy-role-upstreams the message names "the upstream", not
    // api.anthropic.com: a role's upstream may be a local Ollama server the
    // proxy forwards to, so naming Anthropic would be wrong for that config.
    expectError(result, 'no audit record');
    // ...and what to do about it.
    expectError(result, 'lazy daemon status');
    expectError(result, 'lazy daemon logs');
    // REGRESSION: the error used to advertise `[proxy] enabled = false` as the
    // escape hatch. That option is gone — never point a user at it again.
    if (result.stderr.includes('enabled = false')) {
      throw new Error(`proxy error still advertises the removed opt-out:\n${result.stderr}`);
    }
    // REGRESSION (proxy-role-upstreams): the per-ROLE opt-outs are gone too —
    // an ollama backend and an explicit `endpoint` are both proxied now, and
    // this text used to recommend exactly those as the way out.
    expectError(result, 'no role configuration that opts out');
  });

  test('an explicit [proxy] section fails the same way (no partial mode)', async () => {
    await appendConfig('[proxy]\nupstream = "https://api.anthropic.com"\n');

    const result = await ctx.lazy(['pair'], ARMED);

    expectFailure(result);
    expectError(result, 'could not resolve the live proxy address');
  });

  // INVARIANT: `[proxy] enabled = false` — the REMOVED key asking for
  // something lazy no longer does — is rejected outright, naming the option.
  // Silently ignoring it would leave the user believing their traffic is
  // unproxied when every byte of it is proxied — the worst of both worlds
  // (external-surfaces-validate-inputs).
  test('a lazy.toml that still says [proxy] enabled = false is rejected', async () => {
    await appendConfig('[proxy]\nenabled = false\n');

    const result = await ctx.lazy(['list']);

    expectFailure(result);
    expectError(result, 'enabled');
    expectError(result, 'has been removed');
    expectError(result, 'always on');
  });

  // `enabled = true` asks for what lazy already does, so the line is merely
  // dead: the command WARNS about the removed option and still runs. Refusing
  // to start over a stale line that changes nothing would be pure obstruction.
  test('[proxy] enabled = true warns but the command still runs', async () => {
    await appendConfig('[proxy]\nenabled = true\n');

    const result = await ctx.lazy(['list']);

    expectSuccess(result);
    expectError(result, 'has been removed');
  });

  // An ollama role is never proxied (the proxy has a single Anthropic-native
  // upstream, and a local model is not it), so an unresolvable proxy must not
  // block a local-model launch — the gate is scoped to traffic it actually owns.
  test('an ollama role is unaffected by the gate', async () => {
    await appendConfig(`
[models.roles.builder]
backend = "ollama"
model = "qwen3:8b"
endpoint = "http://localhost:11434"
`);

    const result = await ctx.lazy(['pair'], ARMED);

    if (result.stderr.includes('could not resolve the live proxy address')) {
      throw new Error(`proxy gate fired for an ollama role:\n${result.stderr}`);
    }
  });

  // The gate is not a `pair`-only guard. Task agents launch through the runner
  // factory (src/runner/index.ts `withProxyTargets`), a different code path from
  // the CLI-client seam above, and it is the path that carries the bulk of the
  // traffic the audit plane exists for — so it must fail the same way.
  test('a task agent launch fails the same way (runner factory path)', async () => {
    const taskId = await createTask(ctx, 'proxy gate applies to agents too', 'do the thing');

    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, ARMED);

    expectFailure(result);
    const output = result.stderr + result.stdout;
    if (!output.includes('could not resolve the live proxy address')) {
      throw new Error(`agent launch did not fail loud on the proxy gate:\n${output}`);
    }
    if (!output.includes('lazy daemon status') || !output.includes('lazy daemon logs')) {
      throw new Error(`agent launch failure was not actionable:\n${output}`);
    }
  });

  // Without the force flag the daemonless test harness keeps working — the
  // bypass is explicit (LAZY_TEST), not "null means fine".
  test('the LAZY_TEST bypass keeps daemonless runs working', async () => {
    const result = await ctx.lazy(['create', '--goal', 'still works']);
    expectSuccess(result);

    const pair = await ctx.lazy(['pair']);
    expectOutput(pair, 'Launching Claude Code');
  });
});
