/**
 * E2E: what a daemon-owned builder session guarantees AFTER it has started —
 * that it can be handed back (resume), and that it belongs to exactly one
 * member (isolation).
 *
 * THE RESUME ROUND TRIP, and which links are real here
 * ----------------------------------------------------
 * The handshake has four links, and the interesting failure is that any one of
 * them silently degrades to "a fresh conversation" rather than erroring:
 *
 *   1. the daemon ARMS an empty resume intent before signalling the container
 *      — REAL (stopBuilderSession → stopSessionContainer → armResumeIntent);
 *   2. the in-container supervisor STAMPS the live Claude session id onto that
 *      intent during the SIGTERM window — the real
 *      `stampSessionIdOnStorage` (src/supervisor/builder.ts) against the real
 *      daemon storage RPC, run from the fake runtime's stop hook. STUBBED: that
 *      it is a supervisor process INSIDE the container, reached by SIGTERM, and
 *      that the session id comes from the capture monitor's own detection.
 *      Those two are covered by test/unit/builder-stamp-session-id.test.ts and
 *      the capture-monitor suites, which is why this one does not re-fake them;
 *   3. the daemon CAPTURES the stamped id onto the registry row — REAL;
 *   4. the next start RESUMES it — REAL, cross-checked against the argv the
 *      relaunched container was actually given.
 *
 * Link 1 is load-bearing and was missing: the stamp deliberately never CREATES
 * an intent (an invented one makes the host wrapper relaunch after an ordinary
 * quit), and its only producer used to be `lazy upgrade`, which no longer stops
 * builders at all. So nothing armed the handshake, the stamp took its
 * no-intent branch on every stop, and every "resume" opened a new conversation
 * with no error anywhere. A test that writes the intent itself — as the first
 * version of this suite's neighbour did — proves the reading half and cannot
 * see that at all.
 *
 * The daemon RESTART between stop and resume is real: the daemon process is
 * torn down and a new one started against the same store, which is what makes
 * this "hand back after a restart" rather than "hand back".
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, chmod, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor, writeConversationFile } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import {
  IMAGE_TAG,
  calculateImageInputManifest,
  calculateImageInputsHash,
} from '../../src/capture/claude';
import { agentBinaryContentIdOfFile, versionedAgentBinaryName } from '../../src/agent/binary-install';
import type { BuilderSession } from '../../src/storage/types';
import { builderClaudeConfigPath, builderSessionLaunchDir, resolveBuilderSessionHomeDir } from '../../src/builder/claude-home';
import { builderSupervisorLogHostPath } from '../../src/builder/supervisor-log-path';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { BUILDER_CONTAINER_PATHS } from '../../src/runner/docker-runner';

const ALICE_EMAIL = 'alice@example.com';
const ALICE_OAUTH = 'sk-ant-oat01-alice-real-secret-for-resume-proof';
const BOB_EMAIL = 'bob@example.com';
const BOB_OAUTH = 'sk-ant-oat01-bob-real-secret-for-resume-proof';
const SERVICE_OAUTH = 'sk-ant-oat01-service-real-secret-for-resume-proof';

/** The id the stand-in supervisor stamps — what a resumed launch must carry. */
const CLAUDE_SESSION_ID = '7b3f1a90-cafe-4d21-9f00-5ee5510bbadc';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Mirror of the private `calculateSourceHash` (src/capture/claude.ts) — see
 * the identical helper in builder-session-start-proof.test.ts for the full
 * note, including HOW IT FAILS: on drift the seeded binary is rejected, the
 * launch falls back to a real source compile, and this suite silently becomes
 * minutes slower rather than failing.
 */
function mirrorSourceHash(sourceRoot: string): string {
  const hash = createHash('sha256');
  const packageJson = join(sourceRoot, 'package.json');
  if (existsSync(packageJson)) hash.update(readFileSync(packageJson, 'utf-8'));
  const srcDir = join(sourceRoot, 'src');
  const files = Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: srcDir, absolute: true })).sort();
  for (const file of files) hash.update(readFileSync(file, 'utf-8'));
  return hash.digest('hex');
}

/** Seed the dev-mode agent-binary stamp so no source compile runs. */
async function seedAgentBinaryStamp(agentHome: string): Promise<void> {
  const binDir = join(agentHome, '.lazy', 'bin');
  await mkdir(binDir, { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(2048, 0x2a),
    Buffer.from('lazy-agent ok'),
    Buffer.alloc(2048, 0x21),
  ]);
  const seedPath = join(binDir, 'stamp-seed-elf');
  await writeFile(seedPath, bytes);
  const installName = versionedAgentBinaryName(await agentBinaryContentIdOfFile(seedPath));
  await rename(seedPath, join(binDir, installName));
  const stamp = `${mirrorSourceHash(REPO_ROOT)}:${process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'}`;
  await writeFile(join(binDir, 'lazy-agent.hash'), `${stamp}\n${installName}\n`);
}

describe('daemon-owned builder session: resume and member isolation', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;
  let docker: FakeDocker;
  let proofDir: string;
  let homesBase: string;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function rpcStatus(token: string, command: string, params: Record<string, unknown> = {}) {
    try {
      await rpc(token, command, params);
      return { status: 200, message: '' };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, message: err.message };
    }
  }

  async function mintUserToken(email: string, name?: string): Promise<string> {
    const result = await rpc(sharedToken, 'mintActorToken', { kind: 'user', email, name }) as { token: string };
    return result.token;
  }

  async function putCredential(userId: string, kind: 'oauth' | 'api-key', token: string): Promise<void> {
    await rpc(sharedToken, 'putUserCredential', { userId, kind, token });
  }

  /** Detached builder launches so far, in order, as joined argv strings. */
  async function detachedLaunches(): Promise<string[]> {
    return (await docker.invocations()).filter(l => l.includes('--name lazy-builder-') && l.includes(' -d '));
  }

  /**
   * Install the stand-in for the in-container supervisor's SIGTERM handler.
   *
   * The fake runtime's stop hook runs this on `docker stop <name>`, i.e. inside
   * the graceful window the real supervisor stamps in. It calls the REAL
   * `stampSessionIdOnStorage` against the daemon's own storage RPC through the
   * REAL RemoteStorage the supervisor uses — so the arming half is genuinely
   * under test: with no intent armed, that function takes its "nothing to
   * resume" branch and writes nothing, exactly as it would in a container.
   */
  async function installSupervisorStandIn(memberToken: string): Promise<void> {
    const script = join(proofDir, 'stamp-on-stop.ts');
    await writeFile(script, `
import { DaemonClient } from ${JSON.stringify(join(REPO_ROOT, 'src/daemon/client.ts'))};
import { RemoteStorage } from ${JSON.stringify(join(REPO_ROOT, 'src/storage/remote-storage.ts'))};
import { stampSessionIdOnStorage } from ${JSON.stringify(join(REPO_ROOT, 'src/supervisor/builder.ts'))};

const [containerName, target, token, projectRoot, sessionId] = process.argv.slice(2);
// The supervisor knows its own --builder-id; here it is recovered from the
// container name the runtime is stopping, which is the same derivation.
const builderId = containerName.replace(/^lazy-builder-/, '');
const storage = new RemoteStorage(DaemonClient.fromTarget(target!, token!), projectRoot!, '');
await stampSessionIdOnStorage(storage, builderId, projectRoot!, sessionId!);
`);
    const hook = join(proofDir, 'stop-hook.sh');
    await writeFile(hook, `#!/usr/bin/env bash
# \$1 is the container being stopped. Failures are printed, never fatal: a
# supervisor that cannot stamp must not make \`docker stop\` fail.
${JSON.stringify(process.execPath)} run ${JSON.stringify(script)} "\$1" ${JSON.stringify(target)} ${JSON.stringify(memberToken)} ${JSON.stringify(ctx.root)} ${JSON.stringify(CLAUDE_SESSION_ID)} 2>&1 || true
`);
    await chmod(hook, 0o755);
    await docker.onStop(`bash ${JSON.stringify(hook)} "$1"`);
  }

  /**
   * What a real builder container leaves behind: Claude Code writes its
   * conversation as `<projects dir>/<encoded cwd>/<id>.jsonl`, in the projects
   * dir that launch mounted. The fake runtime runs no Claude, so a test that
   * resumes a conversation writes it here, where the container would have.
   */
  async function writeSessionFileAsContainer(launchArgv: string, sessionId: string): Promise<void> {
    const mount = launchArgv.split(' ').find(t => t.endsWith(':/home/user/.claude/projects'));
    if (!mount) throw new Error(`launch mounted no projects dir: ${launchArgv}`);
    const dir = join(mount.slice(0, -':/home/user/.claude/projects'.length), encodeProjectPath(ctx.root));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), '{"type":"user","sessionId":"' + sessionId + '"}\n');
  }

  /** Everything a launch needs to succeed against the fake runtime. */
  async function armLaunchEnvironment(): Promise<void> {
    const manifest = await calculateImageInputManifest(ctx.root);
    const hash = await calculateImageInputsHash(ctx.root);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, { dockerfileHash: hash, inputs: manifest });
    const agentHome = ctx.agentHome;
    if (!agentHome) throw new Error('fake-agent setup did not expose the daemon HOME');
    await seedAgentBinaryStamp(agentHome);
  }

  async function startDaemonWithFakes(): Promise<void> {
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_BUILDER_HOMES_BASE_DIR: homesBase,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) throw new Error('test daemon did not record a TCP target and token');
    target = resolvedTarget;
    sharedToken = resolvedToken;
  }

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-builder-resume-proof-'));
    docker = await installFakeDocker(proofDir);
    homesBase = join(proofDir, 'builder-homes');
    process.env.LAZY_BUILDER_HOMES_BASE_DIR = homesBase;

    ctx = await setupTestLazy({ fakeClaude: true });

    // The fake-binary seam switches the runner to host-process; this suite
    // needs the real container launch path. Checked replace (harness rule).
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace(
      'type = "dangerously-host-process-without-any-isolation"',
      'type = "docker"',
    );
    if (patched === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);

    // Seeded BEFORE the managed daemon starts: its launch warmup prepares the
    // image and agent binary at once, and unseeded it would compile a real one.
    await armLaunchEnvironment();
    await startDaemonWithFakes();
  });

  afterEach(async () => {
    delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  test('a stopped session resumes the SAME conversation after a daemon restart', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    await installSupervisorStandIn(alice);

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(started.state).toBe('running');
    expect(started.agentSessionId).toBeNull();
    const firstContainer = started.containerName;
    expect(firstContainer).not.toBeNull();
    // The conversation the live container writes (the fake runs no Claude).
    await writeSessionFileAsContainer((await detachedLaunches())[0]!, CLAUDE_SESSION_ID);
    // The runtime really has it running — so the stop below is a real state
    // change and its graceful window is a real window.
    expect(await docker.containers()).toContain(firstContainer!);

    // STOP (not end): the container goes, the session stays resumable. This is
    // where links 1-3 run — arm, stamp (the stand-in, during the stop), capture.
    const stopped = await rpc(alice, 'stopBuilderSession', { id: started.id }) as BuilderSession;
    expect(stopped.state).toBe('stopped');
    expect(stopped.containerName).toBeNull();
    // THE CAPTURE. Null here is the silent degradation this suite exists for:
    // it means no intent was armed (or the stamp never ran), and the resume
    // below would open a brand-new conversation without erroring.
    expect(stopped.agentSessionId).toBe(CLAUDE_SESSION_ID);
    // Consumed, not left behind for a later stop to re-capture stale.
    const leftovers = await rpc(alice, 'storage', {
      method: 'listBuilderResumeIntents', args: { projectRoot: ctx.root },
    }) as unknown[];
    expect(leftovers).toEqual([]);

    // THE RESTART. Everything the resume needs must come from the store, not
    // from this daemon's memory.
    await startDaemonWithFakes();
    await installSupervisorStandIn(await mintUserToken(ALICE_EMAIL, 'Alice'));

    const resumed = await rpc(await mintUserToken(ALICE_EMAIL, 'Alice'), 'startBuilderSession', { id: started.id }) as BuilderSession;

    // Same SESSION (the durable identity), new container and new builder id
    // (every launch gets its own — see BuilderSession.builderId).
    expect(resumed.id).toBe(started.id);
    expect(resumed.state).toBe('running');
    expect(resumed.agentSessionId).toBe(CLAUDE_SESSION_ID);
    expect(resumed.containerName).not.toBe(firstContainer);

    // (4) THE RESUME ITSELF, read off the argv the relaunched container was
    // actually given — not off the row, which is the handler's own account of
    // what it did.
    const launches = await detachedLaunches();
    expect(launches.length).toBe(2);
    expect(launches[0]).not.toContain('--resume');
    // Claude's own argv is everything after lazy-agent's ` -- `; the resume
    // must be there, wherever the other Claude flags put it.
    const sep = launches[1]!.lastIndexOf(' -- ');
    expect(sep).toBeGreaterThan(-1);
    const claudeArgv = launches[1]!.slice(sep + 4).split(' ');
    expect(claudeArgv.slice(claudeArgv.indexOf('--resume'), claudeArgv.indexOf('--resume') + 2))
      .toEqual(['--resume', CLAUDE_SESSION_ID]);
    expect(launches[1]).toContain(`--name ${resumed.containerName}`);
  }, 180_000);

  // INVARIANT: a builder whose container died on its own is never reported
  // "running". Every read of the registry asks the runtime first and records
  // the death — stopped, resumable, with how it ended — so the badge, the
  // terminal refusal and the next start all give one answer. Before this, the
  // row said "running" forever while the terminal said "not running any more".
  test('a builder container that dies on its own reads as stopped, says how it ended, and resumes', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(started.state).toBe('running');
    await docker.crash(started.containerName!, 137, 'claude: fatal: cannot open /home/member/.claude.json');

    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(list.map(s => s.state)).toEqual(['stopped']);
    expect(list[0]!.containerName).toBeNull();
    expect(list[0]!.lastExit).toContain('exit code 137');
    expect(list[0]!.lastExit).toContain('cannot open /home/member/.claude.json');
    // The dead container was cleaned up with the row.
    expect(await docker.containers()).not.toContain(started.containerName!);

    // The attach answer agrees with the listing.
    const refusal = await rpcStatus(alice, 'attachSession', { id: started.id });
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('Your builder is stopped');
    expect(refusal.message).toContain('Resume');

    // Resuming it launches again and clears the recorded death.
    const resumed = await rpc(alice, 'startBuilderSession', { id: started.id }) as BuilderSession;
    expect(resumed.id).toBe(started.id);
    expect(resumed.state).toBe('running');
    expect(resumed.lastExit ?? null).toBeNull();

    // Dying again, with the terminal asked FIRST: the refusal says how it
    // ended, and the listing read afterwards already agrees.
    await docker.crash(resumed.containerName!, 1, 'boom');
    const second = await rpcStatus(alice, 'attachSession', { id: started.id });
    expect(second.status).toBe(409);
    expect(second.message).toContain('not running any more');
    expect(second.message).toContain('exit code 1');
    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: started.id } }) as BuilderSession;
    expect(row.state).toBe('stopped');
  }, 180_000);

  // INVARIANT: a builder that dies in its first minute is recorded by the
  // daemon ITSELF, with nobody reading anything. The dead-builder recovery used
  // to run only when a page or command next read the registry, so a start that
  // failed while nobody looked left no line in the daemon log and removed
  // nothing; the launch watch settles it within seconds. Proven here without a
  // single registry read between the crash and the check: the container is
  // removed and the row already says how it ended.
  test('a builder that dies right after launch is settled by the daemon without anyone reading', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await docker.crash(started.containerName!, 1, 'Builder preflight failed: nope');

    const deadline = Date.now() + 20_000;
    while ((await docker.containers()).includes(started.containerName!) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await docker.containers()).not.toContain(started.containerName!);
    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: started.id } }) as BuilderSession;
    expect(row.state).toBe('stopped');
    expect(row.lastExit).toContain('exit code 1');
    expect(row.lastExit).toContain('Builder preflight failed: nope');
  }, 180_000);

  // INVARIANT: a start's timeline is recorded on its run row — every step with
  // its duration and the outcome — so the run's page can show where a start got
  // to without a log search. It is the daemon's record, never a client's.
  test('a start records its timeline on the run', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: started.id } }) as BuilderSession;
    const timeline = row.startTimeline ?? [];
    const steps = timeline.filter((e) => e.kind === 'step').map((e) => e.step);
    expect(steps).toContain('container image');
    expect(steps).toContain('docker run');
    expect(timeline.at(-1)?.kind).toBe('done');
    expect(timeline.every((e) => typeof e.offsetMs === 'number' && e.at)).toBe(true);
  }, 180_000);

  // INVARIANT: one RPC answers everything about a builder run — its row with
  // the start timeline, the warmup, and the container's current state and
  // output — for the control plane only: it quotes the daemon's own log, so a
  // member's token is refused.
  test('a run report answers the control token and refuses a member', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const report = await rpc(sharedToken, 'builderRunReport', { id: started.id }) as {
      run: BuilderSession; warmup: { state: string }; container: { name: string; evidence: string } | null; log: { lines: string[] };
    };
    expect(report.run.id).toBe(started.id);
    expect(report.run.startTimeline?.length).toBeGreaterThan(0);
    expect(report.container?.name).toBe(started.containerName!);
    expect(report.container?.evidence).toContain('Container:');
    expect(Array.isArray(report.log.lines)).toBe(true);
    expect(typeof report.warmup.state).toBe('string');

    const refused = await rpcStatus(alice, 'builderRunReport', { id: started.id });
    expect(refused.status).toBe(403);
  }, 180_000);

  // INVARIANT: the supervisor's log survives its container. It is written to a
  // file on the project's persistent disk, so a builder whose container is
  // already gone (a replaced machine) still leaves its supervisor log on the run.
  test('a dead builder\'s supervisor log is read from the persistent copy', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const hostLog = builderSupervisorLogHostPath(
      builderSessionLaunchDir(resolveBuilderSessionHomeDir(ctx.root, ALICE_EMAIL), started.builderId),
      started.builderId,
    );
    await writeFile(hostLog, '[builder] Launching Claude Code interactively...\n[builder] KEPT-ON-DISK marker\n');
    await docker.crash(started.containerName!, 1, '');

    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(list[0]!.lastExit).toContain('kept on the project disk');
    expect(list[0]!.lastExit).toContain('KEPT-ON-DISK marker');
  }, 180_000);

  // INVARIANT: the launch watch never turns a member's own Stop into a crash
  // record: a builder stopped in its first seconds stays a clean stop, with no
  // "stopped unexpectedly", after the watch's first checks have run. (The
  // watch's log wording for this case is not observable here — a LAZY_TEST
  // daemon writes no log file — so this guards the row only.)
  test('a builder its member stops right after launch is not recorded as a crash', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await rpc(alice, 'stopBuilderSession', { id: started.id });
    await new Promise((r) => setTimeout(r, 6_000));

    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: started.id } }) as BuilderSession;
    expect(row.state).toBe('stopped');
    expect(row.lastExit ?? null).toBeNull();
  }, 180_000);

  // INVARIANT: a start's launch watch writes only its OWN start's timeline. A
  // member who stops and starts again within the watch window keeps the new
  // start's timeline on the run; the first watch, finding its container gone,
  // must not overwrite it.
  test('a restart within the watch window keeps the new start\'s timeline', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const first = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await rpc(alice, 'stopBuilderSession', { id: first.id });
    const second = await rpc(alice, 'startBuilderSession', { id: first.id }) as BuilderSession;
    expect(second.builderId).not.toBe(first.builderId);
    // Past the first watch's 2s and 5s checks.
    await new Promise((r) => setTimeout(r, 6_000));

    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: first.id } }) as BuilderSession;
    const timeline = row.startTimeline ?? [];
    expect(timeline.some((e) => e.step.includes(`builder ${second.builderId}`))).toBe(true);
    // The first start's watch found its container gone; its note must not be here.
    expect(timeline.some((e) => e.step.includes('not a crash'))).toBe(false);
  }, 180_000);

  // INVARIANT: a builder that dies printing NOTHING still leaves evidence on
  // its row: the runtime's state record, an explicit "printed nothing" (never
  // a silent gap a failed log read also produces), and the in-container
  // supervisor's own log file, copied out before the container is removed.
  // The engineer's builders died with exit 1 and no output at all; that log
  // is where the supervisor writes what it did.
  test('a builder that dies silently still records its state and its supervisor log', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await docker.crash(started.containerName!, 1, '', '[builder] Launching Claude Code interactively...\n[builder] Claude Code exited with code 1\n');

    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(list[0]!.state).toBe('stopped');
    const lastExit = list[0]!.lastExit ?? '';
    expect(lastExit).toStartWith('The builder stopped unexpectedly (exit code 1).');
    expect(lastExit).toContain('Container: exit code 1, started 2026-09-27T12:00:00Z, finished 2026-09-27T12:00:02Z');
    expect(lastExit).toContain('It printed nothing.');
    expect(lastExit).toContain('[builder] Claude Code exited with code 1');
  }, 180_000);

  // INVARIANT: the dead builder's supervisor log is read as ONE regular file.
  // The container decides what sits at that path; a symlink there must never
  // make the daemon read a file of its own host into a row the member can read.
  test('a supervisor log that is a symlink to a host file is refused, not followed', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    const secret = join(proofDir, 'host-secret.txt');
    await writeFile(secret, 'HOST-SECRET-MARKER\n');

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await docker.crash(started.containerName!, 1, 'boom', { symlinkTo: secret });

    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    const lastExit = list[0]!.lastExit ?? '';
    expect(lastExit).not.toContain('HOST-SECRET-MARKER');
    expect(lastExit).toContain('is not a regular file; not read.');
    expect(lastExit).toContain('boom');
  }, 180_000);

  // INVARIANT: an error printed before a screen full of escape codes survives.
  // A TTY program's last lines can be pure control sequences; a short raw tail
  // stripped to nothing and read as "no output".
  test('an error followed by terminal-only lines is still recorded', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const screen = Array.from({ length: 60 }, () => '\u001b[2K\u001b[1A').join('\n');
    await docker.crash(started.containerName!, 1, `Error: the real reason\n${screen}\n`);

    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    const lastExit = list[0]!.lastExit ?? '';
    expect(lastExit).toContain('Error: the real reason');
    expect(lastExit).toContain('It left no supervisor log');
  }, 180_000);

  // INVARIANT: starting a builder opens a LIVE builder, even when the
  // conversation its row names cannot be resumed. Start on a stopped session
  // passes `--resume <id>`; when the projects dir the container sees does not
  // hold <id>.jsonl, Claude prints "No conversation found" and exits, so the
  // container is dead seconds after launch and the terminal is refused — on
  // every later start too, because the row kept the id. (One candidate cause
  // of the member's failed "new builder" terminal; not confirmed on hardware.) A
  // resume whose conversation is not there starts a fresh conversation instead
  // (the old one stays readable under Builders) and forgets the id.
  test('a resume whose conversation file is missing starts a live builder instead of one that dies at once', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    await installSupervisorStandIn(alice);

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    // Stopped with a captured id, but no conversation file anywhere — what a
    // builder stopped before its conversation reached disk (or whose dir was
    // pruned) leaves behind.
    const stopped = await rpc(alice, 'stopBuilderSession', { id: started.id }) as BuilderSession;
    expect(stopped.agentSessionId).toBe(CLAUDE_SESSION_ID);

    const again = await rpc(alice, 'startBuilderSession', { id: started.id }) as BuilderSession;
    expect(again.id).toBe(started.id);
    // The terminal opens: the container is alive and the listing agrees.
    const attach = await rpcStatus(alice, 'attachSession', { id: started.id });
    expect(attach).toEqual({ status: 200, message: '' });
    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(list.map(s => s.state)).toEqual(['running']);
    expect(list[0]!.agentSessionId).toBeNull();
    expect((await detachedLaunches())[1]).not.toContain('--resume');
  }, 180_000);

  // INVARIANT: the resume check follows the mount the container really gets.
  // A failed write probe drops the per-builder overlay, so the container sees
  // the member home's projects dir; a conversation that lives only in the
  // overlay cannot be resumed there, and the launch must start fresh rather
  // than pass `--resume` into a container that dies at once.
  test('a resume whose overlay is not mounted starts fresh and stays alive', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    await installSupervisorStandIn(alice);

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const firstLaunch = (await detachedLaunches())[0]!;
    await writeSessionFileAsContainer(firstLaunch, CLAUDE_SESSION_ID);
    await rpc(alice, 'stopBuilderSession', { id: started.id });
    // A dir with no seed manifest (written before manifests existed) carries no
    // proof it is writable, so the launch probes it — and the probe fails.
    const overlay = firstLaunch.split(' ').find(t => t.endsWith(':/home/user/.claude/projects'))!
      .slice(0, -':/home/user/.claude/projects'.length);
    await rm(join(overlay, '.lazy-seeded.json'), { force: true });
    await docker.failWriteProbe();

    await rpc(alice, 'startBuilderSession', { id: started.id });
    const relaunch = (await detachedLaunches())[1]!;
    expect(relaunch).not.toContain(':/home/user/.claude/projects');
    expect(relaunch).not.toContain('--resume');
    const attach = await rpcStatus(alice, 'attachSession', { id: started.id });
    expect(attach).toEqual({ status: 200, message: '' });
    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: started.id } }) as BuilderSession;
    expect(row.state).toBe('running');
    expect(row.agentSessionId).toBeNull();
  }, 180_000);

  // INVARIANT: a runtime that does not ANSWER is not a dead builder. A read
  // while `docker inspect`/`ps` fail leaves a live builder's row, container
  // and resources exactly as they were, and the terminal says it could not
  // check rather than "not running any more". Treating "no answer" as "dead"
  // would stop a member's live builder because one probe was slow.
  test('a runtime that does not answer leaves a live builder alone', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await docker.failInspect();
    const list = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(list.map(s => s.state)).toEqual(['running']);
    const refusal = await rpcStatus(alice, 'attachSession', { id: started.id });
    expect(refusal.status).toBe(503);
    expect(refusal.message).toContain('Could not check whether your builder is running');
    // Start asks the same question: no answer is a refusal, not a relaunch
    // over a live container.
    const start = await rpcStatus(alice, 'startBuilderSession', { id: started.id });
    expect(start.status).toBe(503);
    expect(start.message).toContain('Could not check whether your builder is running');
    // Stop too: no answer is not "already gone", so the row is not recorded
    // stopped over a builder that may be live (with no conversation captured).
    const stop = await rpcStatus(alice, 'stopBuilderSession', { id: started.id });
    expect(stop.status).toBe(502);
    expect(stop.message).toContain('could not determine whether the container is running');
    await docker.failInspect(false);

    const after = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: started.id } }) as BuilderSession;
    expect(after.state).toBe('running');
    expect(after.containerName).toBe(started.containerName);
    expect(await docker.containers()).toContain(started.containerName!);
    expect((await docker.invocations()).filter(l => l.startsWith('stop ') || l.startsWith('rm '))).toEqual([]);
  }, 180_000);

  // INVARIANT: a Teams member runs several builders at once. Each start is a
  // NEW run with its own container, its own credential binding (the member's
  // credential, bound under that launch's own builder id) and its own MCP
  // token; stopping one leaves the other running and reachable. With no id,
  // attach is the member's one running builder, and a question when there are
  // several — never a pick made for them.
  test('a member runs two builders at once, each with its own binding, and stopping one leaves the other', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const one = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const two = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(two.id).not.toBe(one.id);
    expect(two.builderId).not.toBe(one.builderId);
    expect([one.memberEmail, two.memberEmail]).toEqual([ALICE_EMAIL, ALICE_EMAIL]);
    expect(await docker.containers()).toEqual(expect.arrayContaining([one.containerName!, two.containerName!]));

    const launches = await detachedLaunches();
    expect(launches).toHaveLength(2);
    const credentialOf = (launch: string) => launch.match(/-e (?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=(\S+)/)?.[1];
    const mcpConfigOf = (launch: string) => /-v (\S+):\/lazy-builder\/daemon-mcp\.json:ro/.exec(launch)?.[1];
    expect(credentialOf(launches[0]!)).toBeTruthy();
    expect(credentialOf(launches[0]!)).not.toBe(credentialOf(launches[1]!));
    expect(mcpConfigOf(launches[0]!)).not.toBe(mcpConfigOf(launches[1]!));
    const secondMcp = await readFile(mcpConfigOf(launches[1]!)!, 'utf-8');
    expect(await readFile(mcpConfigOf(launches[0]!)!, 'utf-8')).not.toBe(secondMcp);

    const ambiguous = await rpcStatus(alice, 'attachSession', {});
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.message).toContain('name the one to attach to');

    await rpc(alice, 'stopBuilderSession', { id: one.id });
    expect(await docker.containers()).toContain(two.containerName!);
    expect(await docker.containers()).not.toContain(one.containerName!);
    const after = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: two.id } }) as BuilderSession;
    expect(after.state).toBe('running');
    expect(after.builderId).toBe(two.builderId);
    expect(await readFile(mcpConfigOf(launches[1]!)!, 'utf-8')).toBe(secondMcp);
    expect(await rpcStatus(alice, 'attachSession', { id: two.id })).toEqual({ status: 200, message: '' });
    // One running now: no id finds it.
    expect(await rpc(alice, 'attachSession', {})).toMatchObject({ sessionId: two.id });

    // The stopped one is rejoined by id, on its own run; the other is untouched.
    const rejoined = await rpc(alice, 'startBuilderSession', { id: one.id }) as BuilderSession;
    expect(rejoined.id).toBe(one.id);
    expect(rejoined.state).toBe('running');
    expect(await detachedLaunches()).toHaveLength(3);
    expect(await docker.containers()).toContain(two.containerName!);
  }, 180_000);

  // INVARIANT: a read landing inside a member's Stop (container already gone,
  // row not yet written) does not take the stop over: the stop succeeds, and
  // the row does not claim the builder "stopped unexpectedly".
  test('a listing read during a stop leaves the stop to finish as a clean stop', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;

    // During the stop's `docker rm` (after the container has exited), read the
    // registry through the real RPC, as a page load would.
    const script = join(proofDir, 'read-during-rm.ts');
    await writeFile(script, `
import { DaemonClient } from ${JSON.stringify(join(REPO_ROOT, 'src/daemon/client.ts'))};
await DaemonClient.fromTarget(${JSON.stringify(target)}, ${JSON.stringify(alice)})
  .rpc('storage', ${JSON.stringify(ctx.root)}, { method: 'listBuilderSessions', args: { projectRoot: ${JSON.stringify(ctx.root)} } });
`);
    await docker.onRm(`${JSON.stringify(process.execPath)} run ${JSON.stringify(script)} || true`);

    const stopped = await rpc(alice, 'stopBuilderSession', { id: started.id }) as BuilderSession;
    expect(stopped.state).toBe('stopped');
    expect(stopped.lastExit ?? null).toBeNull();
  }, 180_000);

  test('a member cannot stop or end another member\'s session, and the victim keeps running', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(BOB_EMAIL, 'oauth', BOB_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    const bob = await mintUserToken(BOB_EMAIL, 'Bob');
    await armLaunchEnvironment();

    const aliceSession = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(aliceSession.state).toBe('running');
    const aliceContainer = aliceSession.containerName!;

    // BOB knows the id (he could have had it from anywhere) and tries both
    // verbs. Both are refused as 403 — and the refusal is not the point on its
    // own: what matters is that ALICE's container is untouched afterwards.
    for (const command of ['endBuilderSession', 'stopBuilderSession']) {
      const refusal = await rpcStatus(bob, command, { id: aliceSession.id });
      expect(refusal.status).toBe(403);
      expect(refusal.message).toContain(ALICE_EMAIL);
    }

    // STILL RUNNING — in the registry AND in the runtime. A refusal that had
    // already signalled the container would pass the status check above and
    // fail here.
    const afterRefusal = await rpc(alice, 'storage', {
      method: 'getBuilderSession', args: { id: aliceSession.id },
    }) as BuilderSession | null;
    expect(afterRefusal?.state).toBe('running');
    expect(afterRefusal?.containerName).toBe(aliceContainer);
    const running = (await docker.invocations()).filter(l => l.startsWith('stop '));
    expect(running).toEqual([]);
    expect(await docker.containers()).toContain(aliceContainer);

    // The scoped reads: with BOTH members holding a live session, each token
    // sees only its own rows. Without the scoping every member reads every
    // member's session ids, container names and conversation ids.
    const bobSession = await rpc(bob, 'startBuilderSession', {}) as BuilderSession;
    expect(bobSession.memberEmail).toBe(BOB_EMAIL);
    expect(bobSession.id).not.toBe(aliceSession.id);

    const bobList = await rpc(bob, 'storage', { method: 'listBuilderSessions' }) as BuilderSession[];
    expect(bobList.map(s => s.id)).toEqual([bobSession.id]);
    const aliceList = await rpc(alice, 'storage', { method: 'listBuilderSessions' }) as BuilderSession[];
    expect(aliceList.map(s => s.id)).toEqual([aliceSession.id]);

    // A direct read of the other member's row reads as "not found" — existence
    // is not revealed to a non-owner.
    const bobPeeking = await rpc(bob, 'storage', {
      method: 'getBuilderSession', args: { id: aliceSession.id },
    }) as BuilderSession | null;
    expect(bobPeeking).toBeNull();
  }, 180_000);
  test('a member cannot create or update any builder-session row through the storage proxy', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const aliceSession = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const readAlice = async () => await rpc(alice, 'storage', {
      method: 'getBuilderSession', args: { id: aliceSession.id },
    }) as BuilderSession | null;
    const before = await readAlice();
    expect(before?.state).toBe('running');

    // Her OWN row, with the exact exploit patch: a traversal builder id the
    // daemon would later hand to `rm -rf`. And a benign-looking one. Both are
    // refused — no member writes these rows; the daemon does.
    for (const patch of [
      { state: 'running', builderId: '../../..', containerName: null },
      { agentSessionId: 'anything' },
    ]) {
      const refusal = await rpcStatus(alice, 'storage', {
        method: 'updateBuilderSession', args: { id: aliceSession.id, patch },
      });
      expect(refusal.status).toBe(403);
      expect(refusal.message).toContain('written by the daemon');
    }
    expect(await readAlice()).toEqual(before);

    // Create is refused the same way, even naming herself.
    const now = new Date().toISOString();
    const forged = await rpcStatus(alice, 'storage', {
      method: 'createBuilderSession',
      args: { session: {
        id: 'forged-row', projectRoot: ctx.root, memberEmail: ALICE_EMAIL, kind: 'interactive',
        state: 'stopped', containerName: null, builderId: 'f0f0f0f0', agentSessionId: null,
        createdAt: now, updatedAt: now, endedAt: null,
      } },
    });
    expect(forged.status).toBe(403);
    expect((await rpc(alice, 'storage', { method: 'listBuilderSessions' }) as BuilderSession[]).map(s => s.id))
      .toEqual([aliceSession.id]);
  }, 180_000);

  /**
   * Plant a row the daemon did not produce. No client can: on a managed host the
   * storage proxy refuses builder-session writes from member AND control
   * tokens. So this writes the store file itself — the stand-in for a row that
   * got in some other way (a restored backup, a hand repair, a future writer),
   * which is exactly the case the use-site validation exists for. The daemon
   * reads this file fresh on every call.
   */
  async function plantRow(overrides: Partial<BuilderSession>): Promise<BuilderSession> {
    const now = new Date().toISOString();
    const row: BuilderSession = {
      id: `planted-${Math.random().toString(16).slice(2, 10)}`, projectRoot: ctx.root, memberEmail: ALICE_EMAIL,
      kind: 'interactive', state: 'running', containerName: null, builderId: 'a0a0a0a0',
      agentSessionId: null, createdAt: now, updatedAt: now, endedAt: null, ...overrides,
    };
    const file = join(storageDirFor(ctx.root), 'builder-sessions.json');
    const current = existsSync(file) ? JSON.parse(await readFile(file, 'utf-8')) as { sessions: BuilderSession[] } : { sessions: [] };
    await writeFile(file, JSON.stringify({ sessions: [...current.sessions, row] }, null, 2));
    return row;
  }

  // INVARIANT: the daemon never deletes a path or stops a container named by a
  // session row it did not produce, whatever wrote the row. Holds independently
  // of the storage-proxy refusal above, so removing that one check cannot turn
  // a bad row into `rm -rf` or `docker stop`.
  test('a row with a traversal builder id is refused where it would be acted on, and nothing is deleted', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');

    // `<home>/launches/../../..` is the builder-homes base itself: every
    // member's home, every project. A canary there must survive.
    await mkdir(homesBase, { recursive: true });
    const canary = join(homesBase, 'canary-other-members-data');
    await writeFile(canary, 'must survive');
    expect(join(resolveBuilderSessionHomeDir(ctx.root, ALICE_EMAIL), 'launches', '../../..')).toBe(homesBase);

    const row = await plantRow({ builderId: '../../..', containerName: null });
    for (const command of ['stopBuilderSession', 'endBuilderSession']) {
      const refusal = await rpcStatus(alice, command, { id: row.id });
      expect(refusal.status).toBe(409);
      expect(refusal.message).toContain('invalid builder id');
    }
    expect(existsSync(canary)).toBe(true);
  }, 180_000);

  test('a row naming another launch\'s container is refused, and that container is never stopped', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(BOB_EMAIL, 'oauth', BOB_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    const bob = await mintUserToken(BOB_EMAIL, 'Bob');
    await armLaunchEnvironment();

    const victim = await rpc(bob, 'startBuilderSession', {}) as BuilderSession;
    // Well-formed builder id, but the container is BOB's.
    const row = await plantRow({ builderId: 'a0a0a0a0', containerName: victim.containerName });
    const refusal = await rpcStatus(alice, 'stopBuilderSession', { id: row.id });
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('did not launch');

    expect((await docker.invocations()).filter(l => l.startsWith('stop ') || l.startsWith('rm '))).toEqual([]);
    expect(await docker.containers()).toContain(victim.containerName!);
  }, 180_000);
  test('a member session is never seeded from the daemon host user\'s Claude config', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    // The daemon process user's own ~/.claude.json — on a Teams server, the
    // fleet operator's. Every field a real one carries that must not travel:
    // the account, the user id, project history, and an MCP server with an
    // env secret.
    const HOST_SENTINEL = 'host-operator-sentinel-5c1e';
    await writeFile(join(ctx.agentHome!, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: `${HOST_SENTINEL}@operator.example` },
      userID: HOST_SENTINEL,
      projects: { '/srv/secret-project': { history: [{ display: HOST_SENTINEL }] } },
      mcpServers: { opsdb: { command: 'x', env: { DB_PASSWORD: HOST_SENTINEL } } },
    }));

    await rpc(alice, 'startBuilderSession', {});
    const [launch] = await detachedLaunches();
    const merged = launch!.match(/-v (\S+):\/home\/user\/\.claude\.json/);
    expect(merged).not.toBeNull();
    const content = await readFile(merged![1]!, 'utf-8');
    // The launch's own lazy MCP entry is there — this IS the file the session got…
    expect(JSON.parse(content).mcpServers?.lazy).toBeDefined();
    // …and nothing of the operator's is.
    expect(content).not.toContain(HOST_SENTINEL);
    // INVARIANT: a first launch answers Claude Code's first-run prompts itself
    // (never identity). Seeding from `{}` opened the theme picker in Teams.
    const doc = JSON.parse(content);
    expect(doc.hasCompletedOnboarding).toBe(true);
    expect(doc.theme).toBeDefined();
    const trusted = Object.entries(doc.projects ?? {}) as Array<[string, { hasTrustDialogAccepted?: boolean }]>;
    expect(trusted.length).toBe(1);
    expect(trusted[0]![1].hasTrustDialogAccepted).toBe(true);
    expect(launch).toContain(`-w ${trusted[0]![0]}`);
    for (const key of ['oauthAccount', 'userID', 'primaryApiKey']) expect(doc[key]).toBeUndefined();
  }, 180_000);
  test('what the session wrote into its Claude config survives a stop and resume', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    const mountedConfig = (launch: string) => launch.match(/-v (\S+):\/home\/user\/\.claude\.json/)![1]!;

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    // Stand in for Claude Code inside the container: it writes onboarding, a
    // folder-trust answer and a model choice into the MOUNTED copy.
    const firstPath = mountedConfig((await detachedLaunches())[0]!);
    const live = JSON.parse(await readFile(firstPath, 'utf-8'));
    await writeFile(firstPath, JSON.stringify({
      ...live,
      hasCompletedOnboarding: true,
      model: 'member-chosen-model-7d2',
      projects: { [ctx.root]: { hasTrustDialogAccepted: true } },
    }));

    await rpc(alice, 'stopBuilderSession', { id: started.id });
    await rpc(alice, 'startBuilderSession', { id: started.id });

    // The RESUMED launch's mounted config — a different file, seeded from the
    // member's persisted state — still carries all three answers.
    const launches = await detachedLaunches();
    expect(launches.length).toBe(2);
    const resumed = JSON.parse(await readFile(mountedConfig(launches[1]!), 'utf-8'));
    expect(resumed.model).toBe('member-chosen-model-7d2');
    expect(resumed.hasCompletedOnboarding).toBe(true);
    expect(resumed.projects?.[ctx.root]?.hasTrustDialogAccepted).toBe(true);
    // …and a lazy entry naming the fixed CONTAINER paths each launch mounts
    // its own files at — never a host path, which a root daemon puts under
    // the image's closed /root (see BUILDER_CONTAINER_DIR).
    expect(resumed.mcpServers.lazy.command).toBe(BUILDER_CONTAINER_PATHS.mcpWrapper);
    expect(resumed.mcpServers.lazy.args).toContain(BUILDER_CONTAINER_PATHS.daemonConfig);
  }, 180_000);
  test('a stop that fails does not persist the still-running session\'s config', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await docker.failStops();
    const refusal = await rpcStatus(alice, 'stopBuilderSession', { id: started.id });
    expect(refusal.status).toBe(502);

    // The container is still running and still writing its config: folding a
    // mid-session snapshot into the seed would be persisting a moving target.
    const persisted = builderClaudeConfigPath(resolveBuilderSessionHomeDir(ctx.root, ALICE_EMAIL));
    expect(existsSync(persisted)).toBe(false);
  }, 180_000);
  test('a session\'s per-launch files live outside the shared data-dir mount and are gone after end', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    const [launch] = await detachedLaunches();
    const one = (re: RegExp) => launch!.match(re)![1]!;
    const perLaunch = {
      // Host sources: the container sees each at its fixed container path.
      prompt: one(/-v (\S+):\/lazy-builder\/builder-prompt\.txt:ro/),
      containerConfig: one(/-v (\S+):\/lazy-builder\/builder-container\.json:ro/),
      claudeJson: one(/-v (\S+):\/home\/user\/\.claude\.json/),
      credentialStore: one(/-v (\S+):\/home\/user\/\.claude\/\.credentials\.json/),
      mcpWrapper: one(/-v (\S+lazy-mcp-wrapper\S+?):\S+:ro/),
    };

    // The data dir EVERY builder container mounts read-write — so anything in
    // it is readable and writable by every other member's session.
    const sharedMount = one(/-v (\S+):\S+ -v \S+:\S+ -e LAZY_SCRATCH_DIR/).split(':')[0]!;
    expect(sharedMount).toBe(join(ctx.root, '.lazy'));
    for (const [what, path] of Object.entries(perLaunch)) {
      expect({ what, underSharedMount: path.startsWith(sharedMount + '/') }).toEqual({ what, underSharedMount: false });
      expect({ what, exists: existsSync(path) }).toEqual({ what, exists: true });
      // Each is mounted into the container on its own — it has to be, since
      // nothing else puts it there.
      expect(launch).toContain(`-v ${path}:`);
    }

    // INVARIANT: the container user may not be the daemon's uid (a root daemon
    // on native Linux), so what it reads is 0644 / 0755 whatever the daemon's
    // umask, never writable by others; the dir holding tokens stays 0700.
    const modeOf = async (p: string) => (await stat(p)).mode & 0o777;
    expect(await modeOf(join(perLaunch.prompt, '..'))).toBe(0o700);
    for (const what of ['prompt', 'containerConfig', 'claudeJson', 'credentialStore'] as const) {
      expect({ what, mode: await modeOf(perLaunch[what]) }).toEqual({ what, mode: 0o644 });
    }
    expect(await modeOf(perLaunch.mcpWrapper)).toBe(0o755);

    await rpc(alice, 'endBuilderSession', { id: started.id });
    for (const [what, path] of Object.entries(perLaunch)) {
      expect({ what, existsAfterEnd: existsSync(path) }).toEqual({ what, existsAfterEnd: false });
    }
  }, 180_000);
  test('a member\'s end that lands during dead-container recovery stays ended and is never relaunched', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    // A 'running' row whose container is already gone — what a reaped
    // container leaves behind. The next start takes the recovery branch.
    const row = await plantRow({ builderId: 'c0ffee00', containerName: 'lazy-builder-c0ffee00' });

    // The race, made deterministic: the recovery branch's `docker rm` of the
    // dead container sits between its liveness check and its 'stopped' write.
    // During it, ALICE ends the session — which succeeds, the container being
    // gone. Once only: the end's own `docker rm` must not re-enter.
    const endScript = join(proofDir, 'end-during-rm.ts');
    await writeFile(endScript, `
import { DaemonClient } from ${JSON.stringify(join(REPO_ROOT, 'src/daemon/client.ts'))};
await DaemonClient.fromTarget(${JSON.stringify(target)}, ${JSON.stringify(alice)})
  .rpc('endBuilderSession', ${JSON.stringify(ctx.root)}, { id: ${JSON.stringify(row.id)} });
`);
    const once = join(proofDir, 'end-fired');
    await docker.onRm(`[ -f ${JSON.stringify(once)} ] && exit 0; touch ${JSON.stringify(once)}; ${JSON.stringify(process.execPath)} run ${JSON.stringify(endScript)}`);

    const start = await rpcStatus(alice, 'startBuilderSession', { id: row.id });

    // The end ran inside the window (the hook fired), and it WON: the start is
    // refused rather than resurrecting the session, and nothing was launched.
    expect(existsSync(once)).toBe(true);
    expect(start.status).toBe(409);
    expect(start.message).toContain('was ended while this start');
    const after = await rpc(alice, 'storage', {
      method: 'getBuilderSession', args: { id: row.id },
    }) as BuilderSession | null;
    expect(after?.state).toBe('ended');
    expect(await detachedLaunches()).toEqual([]);
  }, 180_000);
  // --- Resume from the Builders page (resumeBuilder) ---------------------

  /**
   * Capture a conversation as a member's builder did, so it is a listed Builder
   * owned by `memberEmail`. Written straight into the store: the real capture
   * stamps the owner from the RUN's own token on the builder storage surface,
   * and every human-token route deliberately clears it.
   */
  function captureBuilder(sessionId: string, memberEmail: string): void {
    writeConversationFile(ctx.root, {
      memberEmail,
      sessionId,
      projectPath: ctx.root,
      cwd: ctx.root,
      version: null,
      gitBranch: null,
      summary: 'Plan the release',
      startedAt: '2026-10-01T10:00:00Z',
      endedAt: '2026-10-01T10:05:00Z',
      importedAt: Date.now(),
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      subagents: [],
      messages: [
        { uuid: `${sessionId}-u`, parentUuid: null, role: 'user', text: 'Plan the release', timestamp: '2026-10-01T10:00:00Z', model: null, usage: null },
        { uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, role: 'assistant', text: 'Here is a plan.', timestamp: '2026-10-01T10:01:00Z', model: null, usage: null },
      ],
      stats: { messageCount: 2, userMessageCount: 1, assistantMessageCount: 1, subagentCount: 0, totalTokens: 0 },
    });
  }

  function claudeArgvOf(launch: string): string[] {
    return launch.slice(launch.lastIndexOf(' -- ') + 4).split(' ');
  }

  // INVARIANT: an ENDED builder's conversation is still the member's to resume
  // from the Builders list, in a builder run of theirs, continuing the same
  // Claude session. "Ended" ends the run, not the conversation.
  test('your own ended builder resumes from the Builders list, continuing its conversation', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const started = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await writeSessionFileAsContainer((await detachedLaunches())[0]!, CLAUDE_SESSION_ID);
    await rpc(alice, 'endBuilderSession', { id: started.id });
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);

    const resumed = await rpc(alice, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(resumed.state).toBe('running');
    expect(resumed.memberEmail).toBe(ALICE_EMAIL);
    expect(resumed.agentSessionId).toBe(CLAUDE_SESSION_ID);
    expect(resumed.id).not.toBe(started.id);

    const launches = await detachedLaunches();
    expect(launches.length).toBe(2);
    const argv = claudeArgvOf(launches[1]!);
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', CLAUDE_SESSION_ID]);
  }, 180_000);

  // INVARIANT: a resume whose session file is gone is REFUSED, saying so, and
  // starts nothing — never a fresh, empty conversation in its place.
  test('a builder whose session file is gone is refused plainly and nothing starts', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);

    const refusal = await rpcStatus(alice, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID });
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('no longer on this server');
    expect(await detachedLaunches()).toEqual([]);
    const rows = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(rows).toEqual([]);
  }, 180_000);

  // INVARIANT: a member runs as many builders as they start, as `lazy builder`
  // allows on a laptop. Resuming a Builder while another of theirs runs ADDS a
  // run and never stops the running one; resuming a Builder that already runs
  // in one of their runs returns that run, so one conversation never runs in
  // two containers.
  test('resuming while a builder runs gives two running builders, and resuming the same one again joins it', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const first = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    await writeSessionFileAsContainer((await detachedLaunches())[0]!, CLAUDE_SESSION_ID);
    await rpc(alice, 'endBuilderSession', { id: first.id });
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);
    const live = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(live.state).toBe('running');

    const resumed = await rpc(alice, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(resumed.state).toBe('running');
    expect(resumed.id).not.toBe(live.id);
    expect(resumed.builderId).not.toBe(live.builderId);
    expect(resumed.agentSessionId).toBe(CLAUDE_SESSION_ID);
    const containers = await docker.containers();
    expect(containers).toContain(live.containerName!);
    expect(containers).toContain(resumed.containerName!);
    const launches = await detachedLaunches();
    expect(launches.length).toBe(3);
    expect(claudeArgvOf(launches[2]!)).toContain(CLAUDE_SESSION_ID);

    const rows = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(rows.filter((r) => r.state === 'running').map((r) => r.id).sort()).toEqual([live.id, resumed.id].sort());

    // The same Builder again: its run is the answer, nothing new launches.
    const again = await rpc(alice, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(again.id).toBe(resumed.id);
    expect(await detachedLaunches()).toHaveLength(3);
  }, 180_000);

  // INVARIANT: a FRESH run that has never stopped is joined to its conversation
  // as soon as its capture names it. Its Builder is listed (and offered Resume)
  // within about half a minute of starting; Resume must find this run then, or
  // one conversation runs in two containers.
  test('resuming the Builder a never-stopped run is capturing returns that run and launches nothing', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();

    const fresh = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(fresh.agentSessionId ?? null).toBeNull();
    const mcpConfig = /-v (\S+):\/lazy-builder\/daemon-mcp\.json:ro/.exec((await detachedLaunches())[0]!)![1]!;
    await writeSessionFileAsContainer((await detachedLaunches())[0]!, CLAUDE_SESSION_ID);

    // The capture the running supervisor makes, on its own builder token.
    const builderToken = (JSON.parse(await readFile(mcpConfig, 'utf-8')) as { token: string }).token;
    const builderClient = DaemonClient.fromTarget(target, builderToken, undefined, 'builder');
    await builderClient.rpc('storage', ctx.root, { method: 'saveConversation', args: { conversation: {
      memberEmail: null, sessionId: CLAUDE_SESSION_ID, projectPath: ctx.root, cwd: ctx.root,
      version: null, gitBranch: null, summary: 'Plan the release',
      startedAt: '2026-10-01T10:00:00Z', endedAt: null, importedAt: Date.now(),
      totalUsage: { input_tokens: 0, output_tokens: 0 }, subagents: [],
      messages: [{ uuid: 'u1', parentUuid: null, role: 'user', text: 'Plan the release', timestamp: '2026-10-01T10:00:00Z', model: null, usage: null }],
      stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
    } } });

    const row = await rpc(alice, 'storage', { method: 'getBuilderSession', args: { id: fresh.id } }) as BuilderSession;
    expect(row.state).toBe('running');
    expect(row.agentSessionId).toBe(CLAUDE_SESSION_ID);

    const resumed = await rpc(alice, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(resumed.id).toBe(fresh.id);
    expect(await detachedLaunches()).toHaveLength(1);
  }, 180_000);

  // INVARIANT: a teammate's builder is never resumed as yours, and its file is
  // never touched: the refusal names whose it is, and nothing launches.
  test("a teammate's builder is refused, naming whose it is, and nothing launches", async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(BOB_EMAIL, 'oauth', BOB_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    const bob = await mintUserToken(BOB_EMAIL, 'Bob');
    await armLaunchEnvironment();
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);

    const refusal = await rpcStatus(bob, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID });
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain(ALICE_EMAIL);
    expect(await detachedLaunches()).toEqual([]);
  }, 180_000);

  // INVARIANT: a resume refused for MONEY changes nothing — no run row is
  // registered or re-pointed and nothing launches (MONEY BEFORE INFRASTRUCTURE).
  test('a resume refused for a missing credential registers no run and launches nothing', async () => {
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const alice = await mintUserToken(ALICE_EMAIL, 'Alice');
    await armLaunchEnvironment();
    // The session file where a run without its overlay left it.
    const dir = join(resolveBuilderSessionHomeDir(ctx.root, ALICE_EMAIL), '.claude', 'projects', encodeProjectPath(ctx.root));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${CLAUDE_SESSION_ID}.jsonl`), '{"type":"user"}\n');
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);

    const refusal = await rpcStatus(alice, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID });
    expect(refusal.status).toBeGreaterThanOrEqual(400);
    expect(refusal.message).not.toContain('no longer on this server');
    expect(await detachedLaunches()).toEqual([]);
    const rows = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(rows).toEqual([]);
  }, 180_000);

  // --- Continue from a summary (continueBuilderFromSummary) ---------------

  // INVARIANT: any member may continue a TEAMMATE's builder from a summary of
  // its readable transcript: a NEW builder of their own, seeded with the summary
  // and the source named, recorded as continued from it — while the teammate's
  // raw session is never resumed or copied for them.
  test("a teammate's builder is continued from a summary as a new builder of yours", async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(BOB_EMAIL, 'oauth', BOB_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const bob = await mintUserToken(BOB_EMAIL, 'Bob');
    await armLaunchEnvironment();
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);
    // Offline: the summary is an excerpt made with no model, so the suite
    // needs no model run; the model path is the same handler minus this branch.
    await writeFile(join(ctx.root, '.lazy', 'offline.json'), JSON.stringify({ enabled: true }));

    // Full-fidelity resume stays refused for anyone else.
    expect((await rpcStatus(bob, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID })).status).toBe(403);

    const run = await rpc(bob, 'continueBuilderFromSummary', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(run.state).toBe('running');
    expect(run.memberEmail).toBe(BOB_EMAIL);
    expect(run.agentSessionId).toBeNull();
    expect(run.continuedFrom).toEqual({
      builderId: CLAUDE_SESSION_ID, title: 'Plan the release', memberEmail: ALICE_EMAIL, method: 'excerpt',
    });

    const launches = await detachedLaunches();
    expect(launches.length).toBe(1);
    // A fresh conversation, never Alice's session.
    expect(claudeArgvOf(launches[0]!)).not.toContain('--resume');
    expect(launches[0]!).not.toContain(CLAUDE_SESSION_ID);
    // The seed is in the builder's system prompt: the source named, whose it
    // was, and the readable text.
    const prompt = await readFile(join(
      builderSessionLaunchDir(resolveBuilderSessionHomeDir(ctx.root, BOB_EMAIL), run.builderId),
      `builder-prompt-${run.builderId}.txt`,
    ), 'utf-8');
    expect(prompt).toContain(`(builder ${CLAUDE_SESSION_ID}), which ${ALICE_EMAIL} had`);
    expect(prompt).toContain('Here is a plan.');

    // A second continue ADDS a builder; the running one keeps running.
    const second = await rpc(bob, 'continueBuilderFromSummary', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(second.id).not.toBe(run.id);
    expect(second.state).toBe('running');
    expect(await detachedLaunches()).toHaveLength(2);
    expect(await docker.containers()).toContain(run.containerName!);
  }, 180_000);

  // INVARIANT: a continued builder keeps its seed and its "continued from" link
  // after it is ended and resumed from the list — the continuation belongs to
  // the conversation, not to the run row that first carried it.
  test('a continued builder ended and resumed keeps its summary and its link', async () => {
    const SOURCE_ID = '0a1b2c3d-0000-4000-8000-00000000a11c';
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(BOB_EMAIL, 'oauth', BOB_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const bob = await mintUserToken(BOB_EMAIL, 'Bob');
    await armLaunchEnvironment();
    captureBuilder(SOURCE_ID, ALICE_EMAIL);
    await writeFile(join(ctx.root, '.lazy', 'offline.json'), JSON.stringify({ enabled: true }));
    // Bob's continued conversation is stamped CLAUDE_SESSION_ID when it stops.
    await installSupervisorStandIn(bob);

    const run = await rpc(bob, 'continueBuilderFromSummary', { builderId: SOURCE_ID }) as BuilderSession;
    await writeSessionFileAsContainer((await detachedLaunches())[0]!, CLAUDE_SESSION_ID);
    const ended = await rpc(bob, 'endBuilderSession', { id: run.id }) as BuilderSession;
    expect(ended.agentSessionId).toBe(CLAUDE_SESSION_ID);
    captureBuilder(CLAUDE_SESSION_ID, BOB_EMAIL);

    const resumed = await rpc(bob, 'resumeBuilder', { builderId: CLAUDE_SESSION_ID }) as BuilderSession;
    expect(resumed.id).not.toBe(run.id);
    expect(resumed.continuedFrom?.builderId).toBe(SOURCE_ID);
    const prompt = await readFile(join(
      builderSessionLaunchDir(resolveBuilderSessionHomeDir(ctx.root, BOB_EMAIL), resumed.builderId),
      `builder-prompt-${resumed.builderId}.txt`,
    ), 'utf-8');
    expect(prompt).toContain(`(builder ${SOURCE_ID}), which ${ALICE_EMAIL} had`);

    const listed = await rpc(bob, 'builderTranscript', { id: CLAUDE_SESSION_ID }) as { builder: { continuedFrom?: { builderId: string } } };
    expect(listed.builder.continuedFrom?.builderId).toBe(SOURCE_ID);
  }, 180_000);

  // INVARIANT: a continue refused for MONEY happens before any summary is made
  // or any run is registered.
  test('a continue refused for a missing credential registers no run and launches nothing', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const bob = await mintUserToken(BOB_EMAIL, 'Bob');
    await armLaunchEnvironment();
    captureBuilder(CLAUDE_SESSION_ID, ALICE_EMAIL);

    const refusal = await rpcStatus(bob, 'continueBuilderFromSummary', { builderId: CLAUDE_SESSION_ID });
    expect(refusal.status).toBe(400);
    expect(refusal.message).toContain('billed to you');
    expect(await detachedLaunches()).toEqual([]);
    const rows = await rpc(bob, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(rows).toEqual([]);
  }, 180_000);
});
