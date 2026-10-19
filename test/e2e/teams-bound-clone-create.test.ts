/**
 * Creating a task from a clone bound to Lazy Teams is ONE daemon operation:
 * it lands whole or leaves nothing. Real `lazy` subprocesses in a bound clone,
 * through the Rails-table-faithful RPC relay, against a managed daemon whose
 * origin is a bare repository standing in for the install's hosted git; only
 * the agent is mocked.
 *
 * The scenario that broke (engineer's Mac run, 2026-10-09): a person pushed a
 * branch to the team's repository and ran `lazy create --parent <branch>`. The
 * CLI created the row, then had its branch target refused, and left a backlog
 * task with no prompt — and the daemon could not have resolved a branch that
 * existed only on its origin anyway.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
const CLI_TOKEN = 'lz_cli_alice_create';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe('creating tasks from a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let hosted: string;
  let clone: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;
  const proxied: string[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzbc-create-'));
    ctx = await setupTestLazy({ withDaemon: true });

    // The install's hosted repository is the daemon's origin.
    hosted = join(workDir, 'hosted.git');
    await git(workDir, 'init', '-q', '--bare', '-b', 'main', hosted);
    const rootBranch = await git(ctx.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    await git(ctx.root, 'remote', 'add', 'origin', hosted);
    await git(ctx.root, 'push', '-q', 'origin', `${rootBranch}:main`);

    const controlConfig = join(workDir, 'lazy.toml');
    await writeFile(controlConfig, await readFile(join(ctx.root, 'lazy.toml'), 'utf8'));
    // Protection is not what this suite tests; see test/helpers/managed-protection.ts.
    await turnProtectionOff(controlConfig);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlConfig,
      LAZY_MOCK_SHOULD_COMMIT: '1',
    });
    const target = getDaemonTcpTarget(ctx.root)!;
    const shared = readToken(ctx.root)!;
    const rpc = (token: string, command: string, params: Record<string, unknown>) =>
      DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-cr' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-cr' });
    const alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;

    // The person's own clone of the team's repository.
    clone = join(workDir, 'clone');
    await git(workDir, 'clone', '-q', hosted, clone);
    await git(clone, 'config', 'user.email', ALICE);
    await git(clone, 'config', 'user.name', 'Alice');

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

  // INVARIANT: a person who pushed a branch to the team's repository can create
  // and start a task on it from their bound clone, exactly as the browser can
  // move a task under a branch. The task's base is that pushed branch.
  test('a task whose parent is a branch that exists only in hosted git is created whole and starts on it', async () => {
    await writeFile(join(clone, 'BASE.md'), 'pushed base\n');
    await git(clone, 'checkout', '-q', '-b', 'mcheck/1-base');
    await git(clone, 'add', 'BASE.md');
    await git(clone, 'commit', '-q', '-m', 'Base work');
    const pushed = await git(clone, 'rev-parse', 'HEAD');
    await git(clone, 'push', '-q', 'origin', 'mcheck/1-base');
    await git(clone, 'checkout', '-q', 'main');

    proxied.length = 0;
    const out = await ok(['create', '--goal', 'On the pushed base', '--prompt', 'Build on it.', '--code', 'bc-branch', '--parent', 'mcheck/1-base']);
    expect(out).toContain('Target: branch mcheck/1-base');
    // One create, no storage create followed by separate writes.
    expect(proxied.filter((c) => c === 'createTask')).toHaveLength(1);
    expect(proxied.filter((c) => c.startsWith('storage:') && !c.startsWith('storage:get') && !c.startsWith('storage:resolve') && !c.startsWith('storage:list'))).toEqual([]);

    const shown = await ok(['show', 'bc-branch']);
    expect(shown).toContain('Build on it.');

    await ok(['start', 'bc-branch']);
    await ok(['wait', 'bc-branch']);
    expect((await runGit(['merge-base', '--is-ancestor', pushed, 'lazy/bc-branch'], { cwd: ctx.root })).exitCode).toBe(0);
  }, 180_000);

  // INVARIANT: a refused create leaves NO task behind.
  test('a refused create leaves nothing behind', async () => {
    const before = await ok(['list', '--all']);
    const missing = await lazy(['create', '--goal', 'Nowhere', '--prompt', 'x', '--code', 'bc-nowhere', '--parent', 'no-such/branch']);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.out).toContain('No task was created.');
    const cluster = await lazy(['create', '--goal', 'Cl', '--prompt', 'x', '--code', 'bc-cluster-refused', '--type', 'cluster', '--review', 'separate']);
    expect(cluster.exitCode).not.toBe(0);
    expect(cluster.out).toContain('No task was created.');
    const after = await ok(['list', '--all']);
    expect(after).not.toContain('bc-nowhere');
    expect(after).not.toContain('bc-cluster-refused');
    expect(after.split('\n').length).toBe(before.split('\n').length);
  }, 120_000);

  test('a cluster and the fix shortcut are created whole, prompt included', async () => {
    await ok(['create', '--goal', 'Cluster', '--prompt', 'Drive.', '--code', 'bc-cluster', '--type', 'cluster']);
    expect(await ok(['show', 'bc-cluster'])).toContain('Drive.');
    await ok(['fix', '--goal', 'Fix it', '--prompt', 'Broken thing.', '--code', 'bc-fix', '--parent', 'bc-cluster']);
    const fix = await ok(['show', 'bc-fix']);
    expect(fix).toContain('Broken thing.');
    expect(fix).toMatch(/bc-cluster/);
  }, 120_000);

  // INVARIANT: a create a bound clone cannot finish is refused BEFORE any write.
  // `lazy rework` records `rework_of`, which Teams does not let a member set;
  // it used to create the task and prompt first and leave them behind.
  test('lazy rework is refused before it creates anything', async () => {
    await ok(['create', '--goal', 'Done', '--prompt', 'Do it.', '--code', 'bc-done']);
    await ok(['start', 'bc-done']);
    await ok(['wait', 'bc-done']);
    await ok(['accept', 'bc-done', '--yes']);
    const before = await ok(['list', '--all']);
    const rework = await lazy(['rework', 'bc-done', '--prompt', 'Again.']);
    expect(rework.exitCode).not.toBe(0);
    expect(rework.out).toContain('No task was created.');
    expect((await ok(['list', '--all'])).split('\n').length).toBe(before.split('\n').length);
  }, 180_000);
});
