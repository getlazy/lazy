/**
 * E2E: SSH into a task (docs/design/task-sessions-and-ssh.md §5) on a shared
 * (managed) daemon — the Lazy Teams posture — end to end with a REAL OpenSSH
 * client and a REAL `sshd -i`.
 *
 * What is real: the daemon in managed mode, the per-member actor token, the
 * `attachSession` / `sshHostKey` RPCs, the attach route's `?mode=ssh` upgrade,
 * the member's own container's `docker run` argv, the `ExecStream` relay
 * (no TTY, demultiplexed), the wrapper script and `sshd -i` itself, the
 * `ssh` / `scp` client, the ProxyCommand pump (src/ssh/stdio-pump.ts), and the
 * task-service forward: the in-container forwarder (lazy-agent
 * `service-forward`) and the daemon's grant-checked route to the task's
 * published port. What is fake: the container runtime — the CLI half is
 * test/helpers/fake-docker.ts, and the Engine API half RUNS a non-TTY exec on
 * this machine (`runExecs`), standing in for the member's container. Lazy
 * Teams is stood in for by the ProxyCommand sending the member's keys header,
 * exactly what its relay adds (it never comes from the SSH client).
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor, readSessionJson, writeSessionJson, findFullTaskId, setTaskStatus } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { IMAGE_TAG, calculateImageInputManifest, calculateImageInputsHash } from '../../src/capture/claude';
import type { AttachSessionInfo, SshHostKeyInfo } from '../../src/daemon/session-attach';
import { seedAgentBinaryStamp, startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';
import { generateEd25519KeyPair } from '../../src/ssh/keys';
import { sshdSuiteSkipped } from '../helpers/sshd-deps';
import { Glob } from 'bun';
import { existsSync } from 'fs';

// INVARIANT: fixtures supply their own Lazy environment, independent of the
// outer task's managed mode, credentials and launch settings.
const outerLazyEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LAZY_')));
beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('LAZY_')) delete process.env[key];
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('LAZY_')) delete process.env[key];
  Object.assign(process.env, outerLazyEnv);
});

const ALICE_EMAIL = 'alice@example.com';
const REPO_ROOT = join(import.meta.dir, '..', '..');
const ALIAS = 'lazy-ssh-e2e.project';

/**
 * Who this test runs as, by name, as sshd resolves it (the `lazy` login alias
 * goes into the stand-in container's own passwd file, which sshd here never
 * reads — so the suite logs in under the account it runs as).
 */
function loginName(): string {
  return Bun.spawnSync(['id', '-un']).stdout.toString().trim();
}

async function run(argv: string[], env: Record<string, string> = {}, timeoutMs = 60_000) {
  const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { stdout, stderr, code };
}

describe.skipIf(sshdSuiteSkipped('ssh-into-task'))('SSH into a task on a shared daemon', () => {
  let ctx: TestContext;
  let workDir: string;
  let docker: FakeDocker;
  let engine: FakeEngine;
  let target: string;
  let sharedToken: string;
  let taskId: string;
  let fullTaskId: string;
  let sessionId: string;
  let taskContainer: string;
  let servicePort: number;
  let service: ReturnType<typeof Bun.serve>;
  let keyPath: string;
  let publicKey: string;
  let proxyScript: string;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /** ssh/scp options for one connection: what `--ssh-config --install` writes, against a stand-in Teams relay. */
  async function sshOptions(token: string, keysHeader: string, identity = keyPath): Promise<{ opts: string[]; env: Record<string, string> }> {
    const hostKey = (await rpc(token, 'sshHostKey', { id: sessionId }) as SshHostKeyInfo).hostKey;
    const knownHosts = join(workDir, `known_hosts-${Math.random().toString(36).slice(2)}`);
    await writeFile(knownHosts, `${ALIAS} ${hostKey}\n`);
    return {
      opts: [
        '-F', '/dev/null',
        '-o', `ProxyCommand=${process.execPath} ${proxyScript}`,
        '-o', `HostKeyAlias=${ALIAS}`,
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'LogLevel=ERROR',
        '-i', identity,
      ],
      env: {
        SSH_E2E_URL: `${target.replace(/^http/, 'ws')}/rpc/sessions/${sessionId}/attach/ws?mode=ssh`,
        SSH_E2E_TOKEN: token,
        SSH_E2E_ROOT: ctx.root,
        SSH_E2E_KEYS: keysHeader,
      },
    };
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzssh-'));
    docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'), { allowExec: true, runExecs: { shimDir: join(workDir, 'container') } });

    // The task's one service, published on the daemon host's loopback the way
    // a task container's `[serve]` port is.
    service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('hello from the task service') });
    servicePort = 30000 + Math.floor(Math.random() * 20000);

    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'SSH target', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-ssh' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    fullTaskId = findFullTaskId(ctx.root, taskId);

    const session = readSessionJson(ctx.root, taskId)!;
    session.runner_type = 'docker';
    session.container_name = session.container_name ?? `lazy-${taskId}`;
    writeSessionJson(ctx.root, taskId, session);
    sessionId = session.id;
    taskContainer = session.container_name;
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (patched === before) throw new Error('could not set [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, `${patched}\n[serve.services]\nweb = ${servicePort}\n`);

    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    sharedToken = readToken(ctx.root)!;
    await rpc(sharedToken, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-alice-member' });
    await rpc(sharedToken, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-service-member' });
    await docker.seedContainer(taskContainer, { state: 'running', project: ctx.root });
    await docker.seedPortBindings(taskContainer, [{ containerPort: servicePort, hostAddress: '127.0.0.1', hostPort: service.port! }]);

    const pair = generateEd25519KeyPair('alice@laptop');
    keyPath = join(workDir, 'id_alice');
    await writeFile(keyPath, pair.privateKey);
    await chmod(keyPath, 0o600);
    publicKey = pair.publicKey;

    // The stand-in for Lazy Teams' relay: the ProxyCommand pump, with the
    // member's registered keys added server-side.
    proxyScript = join(workDir, 'proxy.ts');
    await writeFile(proxyScript, [
      `import { runSshStdioPump } from ${JSON.stringify(join(REPO_ROOT, 'src', 'ssh', 'stdio-pump.ts'))};`,
      'const e = process.env;',
      'const headers: Record<string, string> = { Authorization: `Bearer ${e.SSH_E2E_TOKEN}`, "X-Lazy-Project": e.SSH_E2E_ROOT! };',
      'if (e.SSH_E2E_KEYS) headers["x-lazy-ssh-authorized-keys"] = e.SSH_E2E_KEYS;',
      'process.exit(await runSshStdioPump({ url: e.SSH_E2E_URL!, headers }));',
    ].join('\n'));
  }, 180_000);

  afterEach(async () => {
    await ctx.cleanup();
    engine.stop();
    service.stop(true);
    await rm(workDir, { recursive: true, force: true });
  });

  const keysHeader = (lines: string[]) => Buffer.from(lines.join('\n') + '\n').toString('base64');

  // INVARIANT: a member SSHes into THEIR OWN environment for the task — the
  // member container a Shell opens, never the task's — with their own key, and
  // a running turn refuses nobody (engineer, 2026-10-21: sessions and turns
  // never block each other). Commands start in the task's worktree, scp lands
  // there, and `-L` reaches the TASK's service through the daemon.
  test('a member logs in, copies files both ways with scp and sftp and forwards a port to the task service while a turn runs', async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    expect(info.modes).toContain('ssh');
    expect(info.refusals?.ssh).toBeUndefined();

    // A turn is running on the task.
    setTaskStatus(ctx.root, taskId, 'working');

    const { opts, env } = await sshOptions(alice, keysHeader([publicKey]));
    const me = loginName();
    const login = await run(['ssh', ...opts, `${me}@${ALIAS}`, 'echo hello-over-ssh; sleep 0.2; echo still-connected-after-silence; pwd'], env);
    expect(login.stderr).not.toContain("Permission denied");
    if (login.code !== 0) throw new Error(`ssh failed (${login.code}): ${login.stderr}`);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain('hello-over-ssh');
    // INVARIANT: silence on a connection does not end it or prevent later output.
    expect(login.stdout).toContain('still-connected-after-silence');
    expect(login.stdout).toContain(join(ctx.root, '.lazy', 'worktrees'));

    // It ran in her own container, not the task's.
    const runs = (await docker.invocations()).filter((l) => l.startsWith('run -d') && l.includes('lazymember-'));
    expect(runs).toHaveLength(1);
    const memberName = /--name (lazymember-\S+)/.exec(runs[0]!)![1]!;
    expect(engine.execCreates).toContain(memberName);
    expect(engine.execCreates).not.toContain(taskContainer);

    // INVARIANT: an interactive login is told who else is in the task — built
    // by the daemon and handed to her shell session as an argument. (That the
    // person entering is left out is pinned in test/unit/task-sessions.test.ts:
    // here she holds nothing yet when the notice is built.)
    const sessionScripts = engine.execEnvs.flat()
      .filter((e) => e.startsWith('LAZY_SSH_SESSION_SCRIPT='))
      .map((e) => Buffer.from(e.slice('LAZY_SSH_SESSION_SCRIPT='.length), 'base64').toString('utf-8'));
    expect(sessionScripts.length).toBeGreaterThan(0);
    const interactive = sessionScripts[0]!.split('\n').find((l) => l.includes('exec sh -c') && l.includes('display-message'));
    expect(interactive).toBeDefined();
    expect(interactive).toMatch(/'lazy-shell' 'In \S+ with you: agent: working/);

    // scp lands in the worktree.
    const local = join(workDir, 'notes.txt');
    const bytes = Buffer.from([0, 1, 127, 128, 255, 10, 13, 34, 92]);
    await writeFile(local, bytes);
    const scp = await run(['scp', ...opts, local, `${me}@${ALIAS}:notes-from-scp.txt`], env);
    expect(scp.code).toBe(0);
    const worktree = login.stdout.trim().split('\n').pop()!;
    expect(await readFile(join(worktree, 'notes-from-scp.txt'))).toEqual(bytes);

    // INVARIANT: transfers preserve binary bytes in both directions through
    // the member SSH route used by Teams.
    const downloaded = join(workDir, 'scp-downloaded.bin');
    const download = await run(['scp', ...opts, `${me}@${ALIAS}:notes-from-scp.txt`, downloaded], env);
    if (download.code !== 0) throw new Error(`scp download failed (${download.code}): ${download.stderr}`);
    expect(await readFile(downloaded)).toEqual(bytes);

    const sftpDownloaded = join(workDir, 'sftp-downloaded.bin');
    const batch = join(workDir, 'sftp-batch');
    await writeFile(batch, `put "${local}" notes-from-sftp.bin\nget notes-from-sftp.bin "${sftpDownloaded}"\n`);
    const sftp = await run(['sftp', ...opts, '-b', batch, `${me}@${ALIAS}`], env);
    if (sftp.code !== 0) throw new Error(`sftp round trip failed (${sftp.code}): ${sftp.stderr}`);
    expect(await readFile(join(worktree, 'notes-from-sftp.bin'))).toEqual(bytes);
    expect(await readFile(sftpDownloaded)).toEqual(bytes);

    // -L to the task's service: the forwarder answers at 127.0.1.1 on the
    // declared port, and the connection's hosts line names it `web`.
    const localPort = 40000 + Math.floor(Math.random() * 20000);
    const fwd = Bun.spawn(['ssh', ...opts, '-N', '-L', `${localPort}:127.0.1.1:${servicePort}`, `${me}@${ALIAS}`], {
      env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
    });
    let body = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !body) {
      try {
        const res = await fetch(`http://127.0.0.1:${localPort}/`);
        body = await res.text();
      } catch {
        // The forward (or the forwarder behind it) is not up yet.
        await Bun.sleep(250);
      }
    }
    fwd.kill();
    await fwd.exited;
    expect(body).toBe('hello from the task service');
    expect(await readFile(join(workDir, 'container', 'hosts'), 'utf-8'))
      .toContain('127.0.1.1 services web lazy-ssh-services');
    // Reaching the service never started (or recreated) the task's container.
    expect((await docker.invocations()).filter((l) => /^(run|start|create)\b/.test(l) && l.includes(taskContainer))).toEqual([]);
  }, 180_000);

  // INVARIANT: only a key the member registered logs in. A key Teams does not
  // hold for her — another person's, or one she never registered — is refused
  // by sshd, and the connection never reaches a shell.
  test('a wrong key is refused', async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const stranger = generateEd25519KeyPair('stranger');
    const strangerKey = join(workDir, 'id_stranger');
    await writeFile(strangerKey, stranger.privateKey);
    await chmod(strangerKey, 0o600);
    const { opts, env } = await sshOptions(alice, keysHeader([publicKey]), strangerKey);
    const res = await run(['ssh', ...opts, `${loginName()}@${ALIAS}`, 'echo should-not-run'], env);
    expect(res.code).toBe(255);
    expect(res.stdout).not.toContain('should-not-run');
    expect(res.stderr).toContain('Permission denied');
  }, 120_000);

  // INVARIANT: SSH is opened as a NAMED member, with keys from Teams. No keys
  // is a refusal naming the fix; a credential naming nobody (the control
  // token) is refused outright; and a member whose access was withdrawn —
  // which takes her credential off the daemon when she leaves the team — is
  // refused like her Shell.
  test('no keys, no member and a departed member are refused before any exec', async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const url = `${target.replace(/^http/, 'ws')}/rpc/sessions/${sessionId}/attach/ws?mode=ssh`;
    const upgrade = async (headers: Record<string, string>) => {
      const res = await fetch(url.replace(/^ws/, 'http'), {
        headers: { ...headers, 'X-Lazy-Project': ctx.root, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      });
      return { status: res.status, text: await res.text() };
    };
    const noKeys = await upgrade({ Authorization: `Bearer ${alice}` });
    expect(noKeys.status).toBe(400);
    expect(noKeys.text).toContain('no SSH keys registered');

    const nobody = await upgrade({ Authorization: `Bearer ${sharedToken}`, 'x-lazy-ssh-authorized-keys': keysHeader([publicKey]) });
    expect(nobody.status).toBe(403);

    await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL });
    const departedInfo = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    expect(departedInfo.refusals?.ssh).toBeTruthy();
    const { opts, env } = await sshOptions(alice, keysHeader([publicKey]));
    const res = await run(['ssh', ...opts, `${loginName()}@${ALIAS}`, 'echo should-not-run'], env);
    expect(res.code).not.toBe(0);
    expect(res.stdout).not.toContain('should-not-run');
    expect(engine.execCreates).toEqual([]);
  }, 120_000);
});


// `lazy shell <task> --ssh-config` on a laptop: the same Host block as in a
// bound clone, anchored to this clone, landing in the task's own container.
describe('lazy shell --ssh-config, solo', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: the block is the ProxyCommand route through `lazy shell --stdio`,
  // anchored to its clone by absolute path, with the host key pinned and agent
  // and X11 forwarding off — and plain `--ssh-config` writes nothing.
  test('prints a Host block that anchors this clone and pins the host key', async () => {
    const { MOCK_CLAUDE_SUCCESS } = await import('../helpers/fixtures');
    const taskId = await createTask(ctx, 'Solo SSH', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const res = await ctx.lazy(['shell', taskId, '--ssh-config']);
    expectSuccess(res);
    const name = ctx.root.split('/').pop()!.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    expect(res.stdout).toContain(`Host ${taskId.slice(0, 8).toLowerCase()}`);
    expect(res.stdout).toContain(`.${name}.lazy\n`);
    expect(res.stdout).toMatch(new RegExp(`ProxyCommand \\S+ .*shell \\S+ --stdio --root ${ctx.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    expect(res.stdout).toContain('StrictHostKeyChecking yes');
    expect(res.stdout).toContain('ForwardAgent no');
    expect(res.stderr).toContain('--install');
  }, 120_000);

  test('--install without --ssh-config is refused', async () => {
    const res = await ctx.lazy(['shell', 'anything', '--stdio', '--install']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('--install goes with --ssh-config');
  });
});

/** libnss-wrapper, which lets the stand-in container's passwd file be the one its programs read. */
const NSS_WRAPPER_LIB = [...new Glob('/usr/lib/*/libnss_wrapper.so').scanSync('/')].map((f) => `/${f}`)[0]
  ?? (existsSync('/usr/lib/libnss_wrapper.so') ? '/usr/lib/libnss_wrapper.so' : undefined);

if (!NSS_WRAPPER_LIB) console.log('skipped: ssh test "--install config login" — missing libnss-wrapper; install with: sudo apt-get install -y libnss-wrapper');

// Solo: `ssh` on the laptop, with `lazy shell <task> --stdio` as its
// ProxyCommand, reaching the local daemon and an sshd in the TASK's container
// (one person, so no member container), with the key the daemon reads from its
// own user's ~/.lazy/ssh — exactly the block `--ssh-config` prints.
describe.skipIf(sshdSuiteSkipped('ssh-into-task solo'))('SSH into a task, solo', () => {
  let ctx: TestContext;
  let workDir: string;
  let docker: FakeDocker;
  let engine: FakeEngine;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzssh-solo-'));
    docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'), { allowExec: true, runExecs: { shimDir: join(workDir, 'container'), nssWrapperLib: NSS_WRAPPER_LIB } });
    ctx = await setupTestLazy({ fakeClaude: true });
  }, 180_000);

  afterEach(async () => {
    await ctx.cleanup();
    engine.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  /** A started task whose environment is the fake container, with the daemon restarted onto the fake runtime. */
  async function startSoloTask(): Promise<{ taskId: string; session: NonNullable<ReturnType<typeof readSessionJson>> & { container_name: string } }> {
    const taskId = await createTask(ctx, 'Solo SSH target', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-ssh-solo' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const session = readSessionJson(ctx.root, taskId)!;
    session.runner_type = 'docker';
    session.container_name = session.container_name ?? `lazy-${taskId}`;
    writeSessionJson(ctx.root, taskId, session);
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (patched === before) throw new Error('could not set [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}`, DOCKER_HOST: `unix://${engine.socketPath}` });
    await docker.seedContainer(session.container_name!, { state: 'running', project: ctx.root });
    return { taskId, session: session as never };
  }

  // INVARIANT: SSH setup edits personal config only with consent and saves its exact prior content.
  for (const choice of ['yes', 'no', '--yes', 'no terminal'] as const) {
    test(`--install Include consent: ${choice}`, async () => {
      const { taskId } = await startSoloTask();
      const home = ctx.agentHome!;
      const config = join(home, '.ssh', 'config');
      await mkdir(join(home, '.ssh'), { recursive: true });
      const original = 'Include /other/config # ~/.lazy/ssh/config\nHost personal\n  User me\n';
      await writeFile(config, original);
      const env = choice === 'yes' || choice === 'no'
        ? { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: choice === 'yes' ? 'accept' : 'decline' }
        : { LAZY_FORCE_TTY: '', LAZY_PROMPT_DEFAULTS: '' };
      const res = await ctx.lazy(['shell', taskId, '--ssh-config', '--install', ...(choice === '--yes' ? ['--yes'] : [])], { env });
      expectSuccess(res);
      expect(res.stdout).toContain('is a name for ssh only');
      expect(res.stdout).toContain('no DNS');
      if (choice === 'yes' || choice === '--yes') {
        expect(await readFile(config, 'utf8')).toBe('Include ~/.lazy/ssh/config\n' + original);
        expect(await readFile(config + '.lazy-backup', 'utf8')).toBe(original);
        expect(res.stdout).toContain('Saved the old file');
        const again = await ctx.lazy(['shell', taskId, '--ssh-config', '--install', '--yes']);
        expectSuccess(again);
        expect(await readFile(config + '.lazy-backup', 'utf8')).toBe(original);
      } else {
        expect(await readFile(config, 'utf8')).toBe(original);
        expect(res.stdout).toContain('An Include after a Host block applies only to that block');
        expect(existsSync(config + '.lazy-backup')).toBe(false);
      }
    }, 120_000);
  }

  // INVARIANT: an existing Include in any supported spelling is left byte-for-byte
  // intact, along with the person's other Includes, and does not replace a backup.
  test('existing tilde, HOME, absolute and glob Includes report already set up', async () => {
    const { taskId } = await startSoloTask();
    const home = ctx.agentHome!;
    const config = join(home, '.ssh', 'config');
    await mkdir(join(home, '.ssh'), { recursive: true });
    for (const spelling of ['~/.lazy/ssh/config', '${HOME}/.lazy/ssh/config',
      join(home, '.lazy', 'ssh', 'config'), '~/.lazy/ssh/con*']) {
      const original = `Include "${spelling}"\nInclude ~/.colima/ssh_config\nInclude ~/.orbstack/ssh/config\n`;
      await writeFile(config, original);
      const res = await ctx.lazy(['shell', taskId, '--ssh-config', '--install', '--yes']);
      expectSuccess(res);
      expect(res.stdout).toContain('already set up');
      expect(await readFile(config, 'utf8')).toBe(original);
      expect(existsSync(config + '.lazy-backup')).toBe(false);
      if (process.env.SSH_SETUP_SCREENSHOTS) await writeFile(join(process.env.SSH_SETUP_SCREENSHOTS, 'ssh-setup-already.txt'), res.stdout);
    }
  }, 120_000);

  // INVARIANT: moving a scoped Include has the same consent and backup as adding
  // one; unrelated Includes and comments survive, and a refusal changes nothing.
  test('a scoped Include is explained and moves only with consent', async () => {
    const { taskId } = await startSoloTask();
    const config = join(ctx.agentHome!, '.ssh', 'config');
    await mkdir(join(ctx.agentHome!, '.ssh'), { recursive: true });
    const others = 'Include ~/.ssh/config.d/*\nInclude ~/.colima/ssh_config\nInclude ~/.orbstack/ssh/config\n';
    const original = others + 'Host personal\n  Include ~/.lazy/ssh/config # keep this note\n  User me\n';
    for (const choice of ['yes', 'no', '--yes', 'no terminal'] as const) {
      await writeFile(config, original);
      await rm(config + '.lazy-backup', { force: true });
      const env = choice === 'yes' || choice === 'no'
        ? { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: choice === 'yes' ? 'accept' : 'decline' }
        : { LAZY_FORCE_TTY: '', LAZY_PROMPT_DEFAULTS: '' };
      const res = await ctx.lazy(['shell', taskId, '--ssh-config', '--install', ...(choice === '--yes' ? ['--yes'] : [])], { env });
      expectSuccess(res);
      expect(res.stdout).toContain('below a Host or Match block');
      if (choice === 'yes' || choice === '--yes') {
        expect(res.stdout).toContain('Moved Include ~/.lazy/ssh/config to the top');
        expect(await readFile(config, 'utf8')).toBe('Include ~/.lazy/ssh/config\n' + others + 'Host personal\n  # keep this note\n  User me\n');
        expect(await readFile(config + '.lazy-backup', 'utf8')).toBe(original);
        if (process.env.SSH_SETUP_SCREENSHOTS && choice === 'yes') await writeFile(join(process.env.SSH_SETUP_SCREENSHOTS, 'ssh-setup-move.txt'), res.stdout);
      } else {
        expect(await readFile(config, 'utf8')).toBe(original);
        expect(existsSync(config + '.lazy-backup')).toBe(false);
        expect(res.stdout).toContain('One-time step');
      }
    }
  }, 120_000);

  // INVARIANT: first-time setup creates a private SSH config containing only the
  // global Include, rather than requiring a pre-existing file or manual steps.
  test('no personal config creates just the Include with mode 600', async () => {
    const { taskId } = await startSoloTask();
    const config = join(ctx.agentHome!, '.ssh', 'config');
    await rm(config, { force: true });
    const res = await ctx.lazy(['shell', taskId, '--ssh-config', '--install', '--yes']);
    expectSuccess(res);
    expect(await readFile(config, 'utf8')).toBe('Include ~/.lazy/ssh/config\n');
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect(existsSync(config + '.lazy-backup')).toBe(false);
  }, 120_000);

  // INVARIANT: a bare $HOME Include is not called installed when OpenSSH treats
  // it literally. Fixing that spelling requires the same consent and backup.
  test('bare HOME Includes are explained and replaced only with consent', async () => {
    const { taskId } = await startSoloTask();
    const config = join(ctx.agentHome!, '.ssh', 'config');
    await mkdir(join(ctx.agentHome!, '.ssh'), { recursive: true });
    const original = 'Include $HOME/.lazy/ssh/config\nInclude ~/.colima/ssh_config\n';
    for (const choice of ['yes', 'no', '--yes', 'no terminal'] as const) {
      await writeFile(config, original);
      await rm(config + '.lazy-backup', { force: true });
      const env = choice === 'yes' || choice === 'no'
        ? { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: choice === 'yes' ? 'accept' : 'decline' }
        : { LAZY_FORCE_TTY: '', LAZY_PROMPT_DEFAULTS: '' };
      const res = await ctx.lazy(['shell', taskId, '--ssh-config', '--install', ...(choice === '--yes' ? ['--yes'] : [])], { env });
      expectSuccess(res);
      expect(res.stdout).toContain('does not expand bare $HOME');
      expect(res.stdout).not.toContain('already set up');
      if (choice === 'yes' || choice === '--yes') {
        expect(await readFile(config, 'utf8')).toBe('Include ~/.lazy/ssh/config\nInclude ~/.colima/ssh_config\n');
        expect(await readFile(config + '.lazy-backup', 'utf8')).toBe(original);
      } else {
        expect(await readFile(config, 'utf8')).toBe(original);
        expect(existsSync(config + '.lazy-backup')).toBe(false);
      }
    }
  }, 120_000);

  // INVARIANT: solo, `ssh … pwd` through `lazy shell <task> --stdio` lands in
  // the task's own container, in its worktree, authorized by the daemon
  // user's own lazy key — no Teams, no member container, no keys header.
  test('ssh through lazy shell --stdio lands in the task container, in its worktree', async () => {
    const { taskId, session } = await startSoloTask();

    // The daemon user's own lazy key — what `--install` makes on a laptop.
    const sshDir = join(ctx.agentHome!, '.lazy', 'ssh');
    await mkdir(sshDir, { recursive: true });
    const pair = generateEd25519KeyPair('me@laptop');
    await writeFile(join(sshDir, 'id_ed25519'), pair.privateKey, { mode: 0o600 });
    await writeFile(join(sshDir, 'id_ed25519.pub'), `${pair.publicKey}\n`);

    // ssh runs under `lazy shell --host --`, so it and its ProxyCommand get
    // this context's environment (its HOME and daemon base dir).
    const proxy = `${process.execPath} run ${join(REPO_ROOT, 'src', 'index.ts')} shell ${taskId} --stdio --root ${ctx.root}`;
    const res = await ctx.lazy(['shell', taskId, '--host', '--', 'ssh', '-n',
      '-F', '/dev/null',
      '-o', `ProxyCommand=${proxy}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${join(workDir, 'known_hosts')}`,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'LogLevel=ERROR',
      '-i', join(sshDir, 'id_ed25519'),
      `${loginName()}@lazy-solo`, 'echo solo-over-ssh; pwd']);
    if (res.exitCode !== 0) throw new Error(`ssh failed (${res.exitCode}): ${res.stderr}`);
    expect(res.stdout).toContain('solo-over-ssh');
    expect(res.stdout).toContain(join(ctx.root, '.lazy', 'worktrees'));
    // Solo lands in the TASK's container, never a member container.
    expect(engine.execCreates).toContain(session.container_name);
    expect((await docker.invocations()).filter((l) => l.startsWith('run ') && l.includes('lazymember-'))).toEqual([]);
  }, 180_000);

  // INVARIANT: the SSH setup people actually get works. `--ssh-config --install`
  // writes ~/.lazy/ssh/config, and `ssh -F` of ONLY that file — login name
  // `lazy`, strict host-key checking against the pinned key — reaches the
  // task's worktree. The container's passwd file is the one its sshd READS
  // (nss_wrapper), so the same-uid `lazy` alias the wrapper adds is exercised:
  // without it sshd refuses the account.
  test.skipIf(!NSS_WRAPPER_LIB)('ssh -F of only the --install config logs in as lazy with strict host-key checking', async () => {
    const { taskId, session } = await startSoloTask();
    const home = ctx.agentHome!;
    const install = await ctx.lazy(['shell', taskId, '--ssh-config', '--install']);
    expectSuccess(install);
    const alias = /Connect with:\s+ssh (\S+)/.exec(install.stdout)?.[1];
    if (!alias) throw new Error(`no alias in --install output: ${install.stdout}`);
    const cfg = join(home, '.lazy', 'ssh', 'config');
    const written = await readFile(cfg, 'utf-8');
    expect(written).toContain('User lazy');
    expect(written).toContain('StrictHostKeyChecking yes');
    // The host key was pinned by --install, which is what strict checking verifies against.
    expect(await readFile(join(home, '.lazy', 'ssh', 'known_hosts'), 'utf-8')).toContain(`${alias} ssh-ed25519 `);

    // ssh resolves "~" from the passwd database, not $HOME: give the client a
    // passwd whose home for this user is the test's HOME.
    const me = loginName();
    const clientPasswd = join(workDir, 'client-passwd');
    await writeFile(clientPasswd, `${me}:x:${process.getuid!()}:${process.getgid!()}::${home}:/bin/sh\n`);
    const res = await ctx.lazy(['shell', taskId, '--host', '--', 'env',
      `LD_PRELOAD=${NSS_WRAPPER_LIB}`, `NSS_WRAPPER_PASSWD=${clientPasswd}`, `NSS_WRAPPER_GROUP=${join(workDir, 'container', 'group')}`,
      'ssh', '-n', '-F', cfg, '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', alias, 'pwd']);
    if (res.exitCode !== 0) throw new Error(`ssh failed (${res.exitCode}): ${res.stderr}`);
    const lines = res.stdout.trim().split('\n');
    expect(lines.at(-1)).toContain(join(ctx.root, '.lazy', 'worktrees'));
    // The alias line really landed in the container's passwd file, and the login ran under it.
    expect(await readFile(join(workDir, 'container', 'passwd'), 'utf-8')).toMatch(/^lazy:x:/m);
    // sshd's own log: the key was accepted for the login name `lazy`.
    expect(await readFile(join(workDir, 'container', 'exec-stderr.log'), 'utf-8')).toMatch(/Accepted publickey for lazy from/);
    expect(engine.execCreates).toContain(session.container_name);
  }, 180_000);
});
