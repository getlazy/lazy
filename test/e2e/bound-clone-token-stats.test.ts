/**
 * E2E: `lazy stats tokens` / `lazy stats tools` from a clone bound to Lazy Teams.
 * The proxy admits the `tokenStats` token modes and relays them on the member's
 * own token; the daemon narrows to that member — their own tasks in detail,
 * project-wide model aggregates — so another member's tasks never appear.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join, dirname } from 'path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { auditLogPath } from '../../src/proxy/audit-log';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

function record(i: number, taskId: string, model: string, tokens: number): string {
  return JSON.stringify({
    id: `rec-${i}`, seq: i, ts: Date.now() - 1000 * i, role: 'agent', taskId, backend: 'proxy',
    upstream: 'https://api.anthropic.com', method: 'POST', path: '/v1/messages', endpoint: 'messages',
    model, tier: 'opus', stream: true, requestShape: null, toolUses: [], toolResults: [],
    status: 200, usage: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    stopReason: null, error: null, durationMs: 5, reroute: null, enforcement: null,
  });
}

describe('lazy stats tokens|tools in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let target: string;
  let shared: string;
  let alice: string;
  let bob: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;
  const proxied: string[] = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

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

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lztks-'));
    ctx = await setupTestLazy({ withDaemon: true });
    await ctx.restartDaemon({ LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root) });
    target = getDaemonTcpTarget(ctx.root)!;
    shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-tks' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-tks' });
    alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;
    bob = (await rpc(shared, 'mintActorToken', { kind: 'user', email: BOB }) as { token: string }).token;

    const mine = await rpc(alice, 'createTask', { goal: 'alice work', prompt: 'x', code: 'tks-alice' });
    const theirs = await rpc(bob, 'createTask', { goal: 'bob work', prompt: 'x', code: 'tks-bob' });
    const aliceId = (mine as { taskId?: string; id?: string }).taskId ?? (mine as { id?: string }).id;
    const bobId = (theirs as { taskId?: string; id?: string }).taskId ?? (theirs as { id?: string }).id;
    expect(aliceId).toBeTruthy();
    expect(bobId).toBeTruthy();
    if (!aliceId || !bobId) throw new Error(`createTask returned no task id (alice=${aliceId}, bob=${bobId})`);
    const path = auditLogPath(join(ctx.root, '.lazy'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      record(1, aliceId, 'claude-alice-model', 111),
      record(2, bobId, 'claude-bob-model', 222222),
    ].join('\n') + '\n', 'utf-8');

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
        daemonTarget: () => target, memberToken: () => alice,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
    });
    await writeTeamsLogin(clone, { teamsUrl: `http://127.0.0.1:${teams.port}`, token: CLI_TOKEN, project: PROJECT, projectId: '42' });
  }, 120_000);

  afterAll(async () => {
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase();
    await rm(workDir, { recursive: true, force: true });
  });

  // INVARIANT: a bound clone reads its own tasks' token rows and the project-wide model aggregates,
  // and nothing of another member's task. The totals and per-task rows are the member's own.
  test('lazy stats tokens returns the member\'s own rows and no other member\'s task', async () => {
    const res = await runLazy(['stats', 'tokens', '--json']);
    expect(res.exitCode).toBe(0);
    expect(proxied).toContain('tokenStats');
    const report = JSON.parse(res.stdout);
    expect(report.totals.totalTokens).toBe(111);
    expect(report.byTask).toHaveLength(1);
    expect(JSON.stringify(report.byTask)).not.toContain('222222');
    const models = report.byModel.map((m: { key: string }) => m.key);
    expect(models).toContain('claude-alice-model');
    expect(models).toContain('claude-bob-model');
  }, 120_000);

  test('lazy stats tools answers for the member\'s own task and refuses another member\'s as unknown', async () => {
    const own = await runLazy(['stats', 'tools', 'tks-alice', '--json']);
    expect(own.exitCode).toBe(0);
    const other = await runLazy(['stats', 'tools', 'tks-bob', '--json']);
    expect(other.exitCode).not.toBe(0);
    expect(`${other.stderr}${other.stdout}`).toMatch(/not found/i);
  }, 120_000);

  // INVARIANT: a member token reads token detail only for its own task: no subtree (it would fold in
  // other members' children), no planning mode, no tools without a task.
  test('a member token is refused the broader token modes', async () => {
    for (const params of [
      { mode: 'tools-cli', task: 'tks-alice', subtree: true },
      { mode: 'tools-cli' },
      { mode: 'planning' },
    ]) {
      await expect(rpc(alice, 'tokenStats', params)).rejects.toThrow(/403|own tasks|own task/);
    }
  }, 60_000);
});
