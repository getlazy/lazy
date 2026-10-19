/**
 * ACCEPTANCE (core flow 2, bound-clone half): in a clone bound to Lazy Teams a
 * person creates a task, starts it, sees its turns, reviews its diff and
 * accepts it — then does the same for a cluster and a child under it (the child
 * is created by hand here; a cluster DRIVING its children is proven in the Teams
 * UI half). Real
 * `lazy` subprocesses against a managed daemon behind the Rails-table-faithful
 * RPC relay; only the agent is mocked. The browser half is
 * lazy-teams/test/surface/tasks_and_clusters_flow_surface_test.rb.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { turnProtectionOff } from '../helpers/managed-protection';
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

describe('tasks and clusters from a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lztc-'));
    ctx = await setupTestLazy({ withDaemon: true });
    // No control config here: the managed daemon reads the project's own lazy.toml.
    // Protection is not what this suite tests; see test/helpers/managed-protection.ts.
    await turnProtectionOff(join(ctx.root, 'lazy.toml'));
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MOCK_SHOULD_COMMIT: '1',
    });
    const target = getDaemonTcpTarget(ctx.root)!;
    const shared = readToken(ctx.root)!;
    const rpc = (token: string, command: string, params: Record<string, unknown>) =>
      DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-tc' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-tc' });
    const alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;

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
        project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root,
        usageViews: { controlToken: () => shared, memberEmail: ALICE },
        daemonTarget: () => target, memberToken: () => alice,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
    });
    await writeTeamsLogin(clone, {
      teamsUrl: `http://127.0.0.1:${teams.port}`, token: CLI_TOKEN, project: PROJECT, projectId: '42',
    });
  }, 120_000);

  afterAll(async () => {
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase?.();
    await rm(workDir, { recursive: true, force: true });
  });

  async function lazy(args: string[]): Promise<{ exitCode: number | null; out: string }> {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAZY_')));
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
      cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000, killSignal: 'SIGKILL',
      env: {
        ...inherited, HOME: join(workDir, 'laptop-home'), LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '', LAZY_IS_DAEMON: '', LAZY_FORCE_TTY: '', LAZY_PROMPT_DEFAULTS: '', NO_COLOR: '1',
      },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, out: `${stdout}\n${stderr}` };
  }

  async function ok(args: string[]): Promise<string> {
    const r = await lazy(args);
    expect(r.exitCode, `lazy ${args.join(' ')} failed:\n${r.out}`).toBe(0);
    return r.out;
  }

  test('create, start, watch turns, review and accept a task, then a cluster and its child', async () => {
    // A plain task.
    await ok(['create', '--goal', 'Plain', '--prompt', 'Do it.', '--code', 'tc-plain']);
    await ok(['start', 'tc-plain']);
    await ok(['wait', 'tc-plain']);
    expect(await ok(['show', 'tc-plain'])).toMatch(/blocked/i);
    expect(await ok(['show', 'tc-plain'])).toMatch(/turn/i);
    expect((await ok(['diff', 'tc-plain'])).length).toBeGreaterThan(0);
    await ok(['accept', 'tc-plain', '--yes']);
    expect(await ok(['list', '--all'])).toMatch(/tc-plain\s+accepted/);

    // A cluster with a child: the cluster parks, the child runs under it and
    // is accepted into it, the cluster shows its progress, then is accepted.
    await ok(['create', '--goal', 'Cluster', '--prompt', 'Drive.', '--code', 'tc-cluster', '--type', 'cluster']);
    await ok(['start', 'tc-cluster']);
    await ok(['wait', 'tc-cluster']);
    await ok(['create', '--goal', 'Kid', '--prompt', 'Do it.', '--code', 'tc-kid', '--parent', 'tc-cluster']);
    await ok(['start', 'tc-kid']);
    await ok(['wait', 'tc-kid']);
    await ok(['accept', 'tc-kid', '--yes']);
    // Adding a child woke the blocked cluster; let that turn finish before reading or accepting it.
    await ok(['wait', 'tc-cluster']);
    expect(await ok(['show', 'tc-cluster'])).toMatch(/1\/1|1 of 1/);
    await ok(['accept', 'tc-cluster', '--yes']);
  }, 240_000);
});
