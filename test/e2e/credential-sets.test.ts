import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { credentialSwapScenario } from '../helpers/fake-claude';
import { credentialSecretsPath } from '../../src/credentials/scope';

describe('named credential sets through the CLI', () => {
  let temp: string;
  let unpin: () => void;
  let ctx: TestContext;
  const contexts: TestContext[] = [];
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  const personEnv = { LAZY_MCP_EXPECTED_TASK_ID: '', LAZY_MCP_EXPECTED_WORKTREE: '', LAZY_TASK: '', LAZY_CREDENTIAL_SHARED_KEY: '' };

  async function project(fakeClaude = false): Promise<TestContext> {
    const context = await setupTestLazy({ fakeClaude, daemonEnv: personEnv });
    contexts.push(context);
    const path = join(context.root, 'lazy.toml');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original + '\n[credentials]\nbackend = "file"\n');
    return context;
  }

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'lazy-set-e2e-'));
    unpin = pinDaemonBaseDir(join(temp, 'daemon'));
    ctx = await project();
  });

  afterEach(async () => {
    try {
      for (const context of contexts.splice(0)) await context.cleanup();
    } finally {
      upstream?.stop(true);
      upstream = undefined;
      unpin();
      await rm(temp, { recursive: true, force: true });
    }
  });

  const auth = (context: TestContext, args: string[], input?: string, env = personEnv) =>
    context.lazy(['auth', ...args], { env, input });

  test('store once, bind, report the source and timestamp, remove with a warning, and unbind', async () => {
    const before = await readFile(join(ctx.root, 'lazy.toml'), 'utf8');
    expectSuccess(await auth(ctx, ['set', 'shared-key', '--set', 'personal'], 'secret-shared-123456\n'));
    expectSuccess(await auth(ctx, ['use', 'personal']));
    const listing = await auth(ctx, ['list']);
    expectSuccess(listing);
    expect(listing.stdout).toContain('In effect:  set personal (file)');
    expect(listing.stdout).toMatch(/binding changed \d{4}-\d\d-\d\dT/);
    expect(listing.stdout).not.toContain('secret-shared-123456');
    expect(await readFile(join(ctx.root, 'lazy.toml'), 'utf8')).toBe(before);
    const scoped = await auth(ctx, ['list', '--set', 'personal']);
    expect(scoped.stdout).toContain('Credentials in set personal');
    const removal = await auth(ctx, ['remove', 'shared-key', '--set', 'personal']);
    expectSuccess(removal);
    expect(removal.stdout).toContain('projects bound to it lose this credential');
    expect(removal.stdout).toContain(ctx.root);
    expectSuccess(await auth(ctx, ['use', '--none']));
    const unbound = await auth(ctx, ['list'], undefined, { ...personEnv, LAZY_CREDENTIAL_SHARED_KEY: 'environment-fallback' });
    expect(unbound.stdout).toContain('Credential set: none; binding changed');
    // No project profile references this credential, so after removing the set
    // there is no reason to list its name. Built-in fallbacks are always shown.
    const builtin = await ctx.lazy(['auth', 'list'], { env: { ...personEnv, OPENAI_API_KEY: 'env-fallback' } });
    expect(builtin.stdout).toContain('environment (OPENAI_API_KEY)');
  });

  test('unknown and malformed bindings are refused without changing the existing one', async () => {
    expectSuccess(await auth(ctx, ['set', 'openai', '--set', 'personal'], 'shared-secret\n'));
    expectSuccess(await auth(ctx, ['use', 'personal']));
    for (const name of ['unknown', '../escape']) {
      const result = await auth(ctx, ['use', name]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(name === 'unknown' ? 'Existing sets: personal' : 'Invalid credential set name');
    }
    expect((await auth(ctx, ['list'])).stdout).toContain('Credential set: personal');
    expect((await auth(ctx, ['use', 'personal', '--none'])).exitCode).not.toBe(0);
  });

  // INVARIANT: a host-process agent has no container boundary. Every CLI
  // mutation of a shared set or binding must refuse its inherited turn marker.
  test('agents cannot set, import, remove, bind or unbind a set', async () => {
    for (const args of [
      ['set', 'openai', '--set', 'personal'], ['import', 'chatgpt', '--set', 'personal'],
      ['remove', 'openai', '--set', 'personal'], ['use', 'personal'], ['use', '--none'],
    ]) {
      const result = await auth(ctx, args, 'never-store-this\n', { ...personEnv, LAZY_MCP_EXPECTED_TASK_ID: 'old-turn' });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('A person must run');
    }
    expect((await auth(ctx, ['list'])).stdout).toContain('Existing sets: (none)');
  });

  test('imports a subscription into a set rather than into the project', async () => {
    const session = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'opaque-access', refresh_token: 'fake-refresh', account_id: 'fake-account' } });
    expectSuccess(await auth(ctx, ['import', 'chatgpt', '--set', 'personal'], session));
    expect((await auth(ctx, ['list', '--set', 'personal'])).stdout).toContain('oauth');
    expect((await auth(ctx, ['list'])).stdout).not.toContain('set personal (file)');
    expectSuccess(await auth(ctx, ['use', 'personal']));
    expect((await auth(ctx, ['list'])).stdout).toContain('set personal (file)');
  });

  // INVARIANT: both credential surfaces name the exported variable that wins
  // over a stored credential, whether it lives in the project or its bound set.
  test('auth list and doctor explain exported variables overriding each stored scope', async () => {
    const context = await project(true);
    const exported = { ...personEnv, ANTHROPIC_API_KEY: 'explicit-export', CLAUDE_CODE_OAUTH_TOKEN: '' };
    expectSuccess(await auth(context, ['set', 'anthropic', '--kind', 'api-key', '--set', 'personal'], 'shared-key\n'));
    expectSuccess(await auth(context, ['use', 'personal']));
    await context.restartDaemon(exported);
    expect((await context.lazy(['doctor'])).stdout).toContain('set personal overridden by ANTHROPIC_API_KEY');
    const list = await auth(context, ['list'], undefined, exported);
    expect(list.stdout).toContain('(overridden by ANTHROPIC_API_KEY)');
    expect(list.stdout).toContain('environment → project → bound set');
    expectSuccess(await auth(context, ['set', 'anthropic', '--kind', 'api-key'], 'project-key\n'));
    const doctor = await context.lazy(['doctor']);
    expect(doctor.stdout).toContain('project credential store overridden by ANTHROPIC_API_KEY');
    expect(doctor.stdout).not.toContain('explicit-export');
    expect(doctor.stdout).not.toContain('project-key');
  }, 60_000);

  test('doctor keeps the loaded Anthropic set and form until the daemon restarts', async () => {
    const context = await project(true);
    const emptyAnthropicEnv = { ...personEnv, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' };
    expectSuccess(await auth(context, ['set', 'anthropic', '--kind', 'api-key', '--set', 'personal'], 'personal-anthropic-key\n'));
    expectSuccess(await auth(context, ['set', 'anthropic', '--kind', 'oauth', '--set', 'work'], 'work-anthropic-token\n'));
    expectSuccess(await auth(context, ['use', 'personal']));
    await context.restartDaemon(emptyAnthropicEnv);
    const loadedLine = 'Anthropic credential present (api-key, set personal (loaded in daemon env: ANTHROPIC_API_KEY)';
    expect((await context.lazy(['doctor'])).stdout).toContain(loadedLine);
    expectSuccess(await auth(context, ['use', 'work']));
    const pendingRestart = await context.lazy(['doctor']);
    expect(pendingRestart.stdout).toContain(loadedLine);
    expect(pendingRestart.stdout).toContain('Credential set: work; binding changed');
    expect(pendingRestart.stdout).not.toContain('personal-anthropic-key');
    expectSuccess(await auth(context, ['use', '--none']));
    expect((await context.lazy(['doctor'])).stdout).toContain(loadedLine);
    expectSuccess(await auth(context, ['use', 'work']));
    await context.restartDaemon(emptyAnthropicEnv);
    const restarted = await context.lazy(['doctor']);
    expect(restarted.stdout).toContain('Anthropic credential present (oauth, set work (loaded in daemon env: CLAUDE_CODE_OAUTH_TOKEN)');
    expect(restarted.stdout).not.toContain('set personal');
  }, 60_000);

  // INVARIANT: the real supervisor and proxy must spend the shared item, not
  // merely report its presence. Each project still has its own override.
  test('two projects launch turns spending one set, and a project override wins', async () => {
    const seen: string[] = [];
    upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      if (new URL(request.url).pathname === '/v1/messages') seen.push(request.headers.get('x-api-key') ?? '');
      return Response.json({ type: 'message', content: [] });
    } });
    const first = await project(true);
    const second = await project(true);
    for (const context of [first, second]) {
      const path = join(context.root, 'lazy.toml');
      await writeFile(path, (await readFile(path, 'utf8')) + `\n[agents.shared]\nharness = "claude-code"\nmodel = "test-model"\nendpoint = "http://127.0.0.1:${upstream.port}"\ncredential = "shared-key"\n`);
    }
    expectSuccess(await auth(first, ['set', 'shared-key', '--set', 'personal'], 'shared-upstream-secret\n'));
    for (const context of [first, second]) {
      expectSuccess(await auth(context, ['use', 'personal']));
      await context.restartDaemon(personEnv);
    }
    async function launch(context: TestContext): Promise<void> {
      await context.setClaudeScenario(credentialSwapScenario());
      const task = await createTask(context, 'Spend the selected credential', 'Do the work');
      expectSuccess(await context.lazy(['start', task, '--agent', 'shared', '--yes']));
      expectSuccess(await context.lazy(['wait', task]));
    }
    await launch(first);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(value => value === 'shared-upstream-secret')).toBe(true);
    seen.length = 0;
    await launch(second);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(value => value === 'shared-upstream-secret')).toBe(true);
    const sharedDoctor = await second.lazy(['doctor']);
    expect(sharedDoctor.stdout).toContain('set personal: file');
    expectSuccess(await auth(first, ['set', 'shared-key'], 'project-upstream-secret\n'));
    await launch(first);
    expect(seen.at(-1)).toBe('project-upstream-secret');
    expect((await auth(first, ['list'])).stdout).toContain('project store (file)');
    expectSuccess(await auth(second, ['use', '--none']));
    await second.restartDaemon({ ...personEnv, LAZY_CREDENTIAL_SHARED_KEY: 'environment-upstream-secret' });
    await launch(second);
    expect(seen.at(-1)).toBe('environment-upstream-secret');
    const doctor = await first.lazy(['doctor']);
    expect(doctor.stdout).toContain('Credential set: personal; binding changed');
    expect(doctor.stdout).toContain('project credential store: file');
  }, 120_000);
  // INVARIANT: a failed read of A must never make a later A binding spend B.
  // Exercise the daemon's hydrated copy through real supervised proxy requests.
  test('after a store failure, A to B to A spends only the current set', async () => {
    const seen: string[] = [];
    upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      if (new URL(request.url).pathname === '/v1/messages') seen.push(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      return Response.json({ type: 'message', content: [] });
    } });
    const context = await project(true);
    const emptyEnv = { ...personEnv, OPENAI_API_KEY: '' };
    const config = join(context.root, 'lazy.toml');
    const original = await readFile(config, 'utf8');
    const patched = original.replace(/^agent_id\s*=\s*"claude-code"/m, 'agent_id = "shared"');
    expect(patched).not.toBe(original); // Startup must hydrate the selected provider.
    await writeFile(config, patched + `\n[agents.shared]\nharness = "claude-code"\nmodel = "test-model"\nendpoint = "http://127.0.0.1:${upstream.port}"\ncredential = "openai"\n`);
    expectSuccess(await auth(context, ['set', 'openai', '--set', 'personal'], 'personal-original\n', emptyEnv));
    expectSuccess(await auth(context, ['set', 'openai', '--set', 'work'], 'work-current\n', emptyEnv));
    expectSuccess(await auth(context, ['use', 'personal'], undefined, emptyEnv));
    await context.restartDaemon(emptyEnv);
    async function spend(expected: string) {
      const before = seen.length;
      await context.setClaudeScenario(credentialSwapScenario());
      const task = await createTask(context, 'Spend current source', 'Do the work');
      expectSuccess(await context.lazy(['start', task, '--agent', 'shared', '--yes']));
      expectSuccess(await context.lazy(['wait', task]));
      expect(seen.length).toBeGreaterThan(before);
      expect(seen.slice(before)).toEqual(Array(seen.length - before).fill(expected));
    }
    await spend('personal-original');
    expectSuccess(await auth(context, ['set', 'openai', '--set', 'personal'], 'personal-rotated\n', emptyEnv));
    const path = credentialSecretsPath({ set: 'personal' });
    const readable = await readFile(path, 'utf8');
    await writeFile(path, '{}');
    await spend('personal-original');
    await writeFile(path, readable);
    expectSuccess(await auth(context, ['use', 'work'], undefined, emptyEnv));
    await spend('work-current');
    expectSuccess(await auth(context, ['use', 'personal'], undefined, emptyEnv));
    await spend('personal-rotated');
    await spend('personal-rotated');
  }, 120_000);

});
