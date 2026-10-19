/**
 * E2E: `lazy report` and `lazy ask <conversation>` in a clone bound to Lazy
 * Teams run their one-shots INSIDE the project's daemon, paid for by the
 * member who asked — with their own credential, exactly as the browser's
 * equivalent (asking an agent a question) spends it — and never by anyone
 * else's.
 *
 * What is real: the lazy CLI subprocess in a freshly bound clone (no `lazy
 * init`), the Teams RPC proxy's tables (read off the Ruby source by
 * `relayTeamsRpc`), a MANAGED daemon with per-member actor tokens and
 * credentials, and its real one-shot path (`runOneshotWithRunner` →
 * the docker runner). The container runtime is the fake docker CLI, which
 * records the argv lazy composed and answers with a canned one-shot result.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { IMAGE_TAG } from '../../src/capture/claude';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const ALICE_SECRET = 'sk-ant-oat01-alice-oneshot';
const SERVICE_SECRET = 'sk-ant-oat01-svc-oneshot';
const CLI_TOKEN = 'lz_cli_member';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');
const SESSION_ID = '7c1d2e3f-0000-4000-8000-00000000c0de';

describe('one-shot commands in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let docker: FakeDocker;
  let target: string;
  let shared: string;
  let memberToken: string;
  let memberEmail = ALICE;
  let teams: ReturnType<typeof Bun.serve> | undefined;
  let unpinBase: () => void;
  const proxied: string[] = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /** Bind the clone to Teams as `email`: the proxy relays on that member's own actor token. */
  async function actAs(email: string): Promise<void> {
    memberToken = (await rpc(shared, 'mintActorToken', { kind: 'user', email }) as { token: string }).token;
    memberEmail = email;
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzbco-'));
    docker = await installFakeDocker(workDir);
    await docker.setOneshotResponse('ANSWER-FROM-THE-SERVER');

    // fakeClaude: the real one-shot path in the daemon (the default preload
    // mocks src/oneshot wholesale, which would hide who pays).
    ctx = await setupTestLazy({ fakeClaude: true });
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: ALICE_SECRET });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: SERVICE_SECRET });
    await actAs(ALICE);

    await rpc(memberToken, 'storage', {
      method: 'saveConversation',
      args: {
        conversation: {
          sessionId: SESSION_ID,
          projectPath: ctx.root,
          summary: 'Deciding the retry policy',
          startedAt: '2026-10-01T10:00:00Z',
          endedAt: '2026-10-01T10:05:00Z',
          messages: [
            { role: 'user', text: 'How many retries?', timestamp: '2026-10-01T10:00:00Z' },
            { role: 'assistant', text: 'Three, with backoff.', timestamp: '2026-10-01T10:01:00Z' },
          ],
          stats: { messageCount: 2, userMessageCount: 1, assistantMessageCount: 1 },
        },
      },
    });

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
        // A getter: Teams narrows and attributes as whichever member the token names.
        usageViews: { controlToken: () => shared, get memberEmail() { return memberEmail; } },
        daemonTarget: () => target, memberToken: () => memberToken,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
    });
    await writeTeamsLogin(clone, {
      teamsUrl: `http://127.0.0.1:${teams.port}`, token: CLI_TOKEN, project: PROJECT, projectId: '42',
    });
    proxied.length = 0;
  }, 120_000);

  afterEach(async () => {
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase?.();
    await rm(workDir, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAZY_')));
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
      cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...inherited,
        HOME: join(workDir, 'laptop-home'),
        LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        NO_COLOR: '1',
        // Nothing may run on the laptop: no docker on its PATH at all.
        PATH: (process.env.PATH ?? '').split(':').filter((p) => p !== docker.binDir).join(':'),
      },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  async function oneshotRuns(): Promise<string[]> {
    return (await docker.invocations()).filter((l) => l.startsWith('run ') && l.includes('lazy.oneshot=1'));
  }

  // INVARIANT: a bound clone's one-shot runs in the DAEMON, on the asking
  // member's own credential, which reaches the container only as a placeholder.
  // No other credential concept, and the secret never leaves the daemon.
  function expectPaidByPlaceholder(runs: string[]): void {
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) {
      expect(line).toMatch(/-e CLAUDE_CODE_OAUTH_TOKEN=lazy-sess-\S+/);
      expect(line).not.toContain(ALICE_SECRET);
      expect(line).not.toContain(SERVICE_SECRET);
    }
  }

  test('lazy ask <conversation> answers from the server', async () => {
    const r = await run(['ask', SESSION_ID.substring(0, 8), '-m', 'What did we decide?']);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: expect.any(String) });
    expect(r.stdout).toContain('ANSWER-FROM-THE-SERVER');
    expect(proxied).toContain('runOneshot');
    expectPaidByPlaceholder(await oneshotRuns());
  }, 120_000);

  test('lazy report runs its model calls on the server', async () => {
    const r = await run(['report', '--start', '-1h']);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: expect.any(String) });
    expect(r.stdout).toContain('ANSWER-FROM-THE-SERVER');
    expect(proxied).toContain('runOneshot');
    expectPaidByPlaceholder(await oneshotRuns());
  }, 120_000);

  // INVARIANT: no fallback to anyone else's credential. A member who has not
  // connected one is refused by name — even though the project's service
  // credential is there to spend — and nothing runs.
  test('a member with no credential of their own is refused, and nothing runs', async () => {
    await actAs(BOB);
    const before = (await oneshotRuns()).length;
    const r = await run(['ask', SESSION_ID.substring(0, 8), '-m', 'What did we decide?']);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(BOB);
    expect(r.stdout).not.toContain('ANSWER-FROM-THE-SERVER');
    expect(r.stdout + r.stderr).toContain('Connect');

    // `lazy report` is refused the same way, at its admission, before collecting anything.
    proxied.length = 0;
    const rep = await run(['report', '--start', '-1h']);
    expect(rep.code).not.toBe(0);
    expect(rep.stdout + rep.stderr).toContain(BOB);
    expect(proxied).not.toContain('runOneshot');
    expect((await oneshotRuns()).length).toBe(before);
  }, 120_000);
});
