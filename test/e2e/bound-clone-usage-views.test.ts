/**
 * E2E: the usage views a clone bound to Lazy Teams asks for — `usagePause`,
 * `usageLimits`, `tokenBudget` — are answered by Teams narrowed to the member
 * (the stand-in mirrors `Api::Cli::UsageViewsController`; the Rails suite owns
 * the narrowing itself), so `lazy stats limits|budget` work and `lazy report` / `lazy ask
 * <conversation>` get past their usage-pause admission to a relayed one-shot.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';

const ALICE = 'alice@example.com';
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

describe('usage views in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let target: string;
  let alice: string;
  let shared: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;
  let teamsUrl: string;
  const proxied: string[] = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzusg-'));
    ctx = await setupTestLazy({ withDaemon: true });
    await ctx.restartDaemon({ LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root) });
    target = getDaemonTcpTarget(ctx.root)!;
    shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-usg' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-usg' });
    alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;

    clone = join(workDir, 'clone');
    await runGit(['init', '-b', 'main', clone], { cwd: workDir });
    await runGit(['config', 'user.email', ALICE], { cwd: clone });
    await runGit(['config', 'user.name', 'Alice'], { cwd: clone });
    await writeFile(join(clone, 'README.md'), '# lazy-toy\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'Initial commit'], { cwd: clone });
    unpinBase = pinDaemonBaseDir(join(workDir, 'laptop-daemon'));
    teams = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => (await relayTeamsRpc(req, {
        project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root, proxied,
        usageViews: { controlToken: () => shared, memberEmail: ALICE },
        daemonTarget: () => target, memberToken: () => alice,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
    });
    teamsUrl = `http://127.0.0.1:${teams.port}`;
    await writeTeamsLogin(clone, { teamsUrl, token: CLI_TOKEN, project: PROJECT, projectId: '42' });
  }, 120_000);

  afterAll(async () => {
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase();
    await rm(workDir, { recursive: true, force: true });
  });

  async function runLazy(args: string[]) {
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
      cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000, killSignal: 'SIGKILL',
      env: {
        ...process.env, HOME: join(workDir, 'laptop-home'), LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '', LAZY_IS_DAEMON: '', LAZY_FORCE_TTY: '', LAZY_PROMPT_DEFAULTS: '', NO_COLOR: '1',
      },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  }

  test('lazy stats limits and budget work, each asking Teams for its member-narrowed view', async () => {
    proxied.length = 0;
    const limits = await runLazy(['stats', 'limits', '--json']);
    expect(limits.exitCode).toBe(0);
    const budget = await runLazy(['stats', 'budget', '--json']);
    expect(budget.exitCode).toBe(0);
    expect(JSON.parse(budget.stdout)).toHaveProperty('credentials');
    expect(proxied).toContain('usageLimits');
    expect(proxied).toContain('tokenBudget');
    expect(proxied).toContain('usagePause');
  }, 120_000);

  test('lazy report gets past its usage pre-flight and its one-shots reach the daemon through Teams', async () => {
    proxied.length = 0;
    const report = await runLazy(['report']);
    const text = `${report.stderr}${report.stdout}`;
    // INVARIANT: the usage-pause admission goes through Teams, narrowed to the member, and the
    // model call is relayed (`runOneshot`, paid by the member) — neither is refused by Teams.
    expect(text).not.toContain("'usagePause'");
    expect(text).not.toContain("'runOneshot'");
    expect(proxied).toContain('usagePause');
    expect(proxied).toContain('runOneshot');
  }, 180_000);

  test('lazy chat attaches through Teams instead of reading the raw transcript locally', async () => {
    const task = await runLazy(['create', '--goal', 'usage task', '--prompt', 'x', '--code', 'usg-1']);
    expect(task.exitCode).toBe(0);
    proxied.length = 0;
    const chat = await runLazy(['chat', 'usg-1']);
    const text = `${chat.stderr}${chat.stdout}`;
    expect(text).not.toContain('raw agent transcript');
    expect(proxied).not.toContain('storage:getAgentSessionLog');
    // The seed task has no session yet: the server's domain answer, as for `lazy pair`.
    expect(text).toContain('has no session on the server yet');
  }, 120_000);

  test('lazy ask on a stored conversation relays its model call through Teams', async () => {
    const now = new Date().toISOString();
    const conversation = {
      sessionId: 'usg-conv-0001-aaaa', projectPath: '-repo', cwd: ctx.root, version: null, gitBranch: null,
      startedAt: now, endedAt: now, importedAt: Date.now(), summary: 'A stored question',
      stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      messages: [{ uuid: 'm1', parentUuid: null, timestamp: now, role: 'user', text: 'A stored question', model: null, usage: null }],
      subagents: [],
    };
    await rpc(alice, 'storage', { method: 'saveConversation', args: { conversation } });
    proxied.length = 0;
    const ask = await runLazy(['ask', 'usg-conv-', '--message', 'what was asked?']);
    expect(`${ask.stderr}${ask.stdout}`).not.toContain("'runOneshot'");
    expect(proxied).toContain('runOneshot');
  }, 120_000);

  test('an action that changes the pause is not offered to a member, by name', async () => {
    const res = await fetch(`${teamsUrl}/api/projects/${PROJECT}/rpc/usagePause`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLI_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', value: 'off' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/from a clone logged in to Lazy Teams/);
  });
});
