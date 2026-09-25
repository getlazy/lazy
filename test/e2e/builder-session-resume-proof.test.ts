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
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor } from '../helpers/storage';
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
import { builderClaudeConfigPath, resolveBuilderSessionHomeDir } from '../../src/builder/claude-home';

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

    const resumed = await rpc(await mintUserToken(ALICE_EMAIL, 'Alice'), 'startBuilderSession', {}) as BuilderSession;

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
    expect(launches[1]).toContain(`-- --resume ${CLAUDE_SESSION_ID}`);
    expect(launches[1]).toContain(`--name ${resumed.containerName}`);
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
    await rpc(alice, 'startBuilderSession', {});

    // The RESUMED launch's mounted config — a different file, seeded from the
    // member's persisted state — still carries all three answers.
    const launches = await detachedLaunches();
    expect(launches.length).toBe(2);
    const resumed = JSON.parse(await readFile(mountedConfig(launches[1]!), 'utf-8'));
    expect(resumed.model).toBe('member-chosen-model-7d2');
    expect(resumed.hasCompletedOnboarding).toBe(true);
    expect(resumed.projects?.[ctx.root]?.hasTrustDialogAccepted).toBe(true);
    // …and this launch's own lazy entry, not the previous launch's.
    expect(resumed.mcpServers.lazy.command).not.toBe(live.mcpServers.lazy.command);
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
      prompt: one(/--system-prompt-file (\S+)/),
      containerConfig: one(/--builder-config (\S+)/),
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

    const start = await rpcStatus(alice, 'startBuilderSession', {});

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
});
