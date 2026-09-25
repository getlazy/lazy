/**
 * E2E: the daemon-owned builder session start, end to end.
 *
 * The daemon-owned-builder-sessions design (docs/design/actor-identity-and-remote-clients.md
 * §5.5) moves builder sessions off the CLI's ad-hoc `docker run` and onto a
 * daemon-owned registry row: the start RPC claims the row BEFORE the container
 * launch, launches the detached container into a per-MEMBER home, and only then
 * reconciles the row to 'running'. Everything between the RPC call and the
 * container launch — managed-mode credential planning, the claim write, the
 * launch argv — is real here: a scripted `docker` on the daemon's PATH stands
 * in for the container runtime, and the fake-binary seam stands in for the
 * in-container agent, which no assertion needs.
 *
 * PROVEN here, each observable at the single startBuilderSession call:
 *   1. a row exists for the member, ends in 'running', and names the container
 *      the launch actually created (argv `--name` cross-checked);
 *   2. the row passed through 'starting' WITH the container name while the RPC
 *      was still in flight — claim-before-launch, which end-state-only code
 *      (launch first, write after) can never satisfy;
 *   3. the launch env carries the member's session placeholder AND the proxy
 *      base URL, and neither real credential appears anywhere in the argv;
 *   4. tool permissions land in the MEMBER's home, never the daemon process
 *      user's;
 *   5. the projects-isolation dir lives under the member's home, not the
 *      project data dir a builder container mounts read-write.
 *
 * NOT proven here, deliberately: that a real detached container OUTLIVES the
 * process that launched it. The fake docker exits; no assertion on lifetime
 * would be anything but a flag-string check dressed up as proof. That item
 * needs real Docker and belongs to the release checklist.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';
import { isSessionPlaceholderToken } from '../../src/daemon/session-credentials';
import {
  IMAGE_TAG,
  calculateImageInputManifest,
  calculateImageInputsHash,
} from '../../src/capture/claude';
import { resolveBuilderSessionHomeDir } from '../../src/builder/claude-home';
import { builderRunName } from '../../src/builder/relaunch';
import { agentBinaryContentIdOfFile, versionedAgentBinaryName } from '../../src/agent/binary-install';
import type { BuilderSession } from '../../src/storage/types';

const ALICE_EMAIL = 'alice@example.com';
const ALICE_OAUTH = 'sk-ant-oat01-alice-real-secret-for-start-proof';
const BOB_EMAIL = 'bob@example.com';
const BOB_OAUTH = 'sk-ant-oat01-bob-real-secret-for-start-proof';
const SERVICE_OAUTH = 'sk-ant-oat01-service-real-secret-for-start-proof';

/**
 * Mirror of the private `calculateSourceHash` (src/capture/claude.ts): the
 * dev-mode agent-binary stamp is checked against exactly this hash. Same
 * inputs, same order — package.json bytes, then every .ts file under src/,
 * sorted.
 *
 * HOW THIS FAILS, since it is a copy and nothing keeps the two in step: if the
 * real function's inputs or order change, this mirror computes a stamp the
 * daemon does not recognise, the seeded binary is rejected as stale, and the
 * launch falls back to a real ~30-60s source compile. The suite still PASSES —
 * every assertion is about the launch, not about how the binary got there — it
 * just becomes mysteriously slow. A suite here that suddenly takes a minute per
 * test is this drift, not a flaky daemon.
 */
function mirrorSourceHash(sourceRoot: string): string {
  const hash = createHash('sha256');
  const packageJson = join(sourceRoot, 'package.json');
  if (existsSync(packageJson)) {
    hash.update(readFileSync(packageJson, 'utf-8'));
  }
  const srcDir = join(sourceRoot, 'src');
  const files = Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: srcDir, absolute: true })).sort();
  for (const file of files) {
    hash.update(readFileSync(file, 'utf-8'));
  }
  return hash.digest('hex');
}

/** Mirror of the private `getLinuxTarget` (src/capture/claude.ts). */
function linuxTarget(): string {
  return process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64';
}

/**
 * Seed the agent-binary stamp the daemon's `ensureAgentBinary` dev path reads:
 * a synthetic Linux ELF (never executed, but it must pass `verifyAgentBinary`
 * — regular file, >=1024 bytes, ELF magic, selfcheck sentinel inside) plus the
 * hash stamp naming it, so the launch adopts this install instead of running a
 * ~30-60s source compile. Returns the install path the argv must mount.
 */
async function seedAgentBinaryStamp(agentHome: string): Promise<string> {
  const binDir = join(agentHome, '.lazy', 'bin');
  await mkdir(binDir, { recursive: true });

  const bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF magic
    Buffer.alloc(2048, 0x2a),
    Buffer.from('lazy-agent ok'), // AGENT_SELFCHECK_SENTINEL
    Buffer.alloc(2048, 0x21),
  ]);
  const seedPath = join(binDir, 'stamp-seed-elf');
  await writeFile(seedPath, bytes);

  // The same content-addressed naming the real install uses, so the stamp's
  // line 2 names a file that exists and verifies.
  const contentId = await agentBinaryContentIdOfFile(seedPath);
  const installName = versionedAgentBinaryName(contentId);
  const installPath = join(binDir, installName);
  await rename(seedPath, installPath);

  const sourceRoot = join(import.meta.dir, '..', '..'); // the worktree the daemon runs from
  const stamp = `${mirrorSourceHash(sourceRoot)}:${process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'}`;
  await writeFile(join(binDir, 'lazy-agent.hash'), `${stamp}\n${installName}\n`);
  return installPath;
}

describe('daemon-owned builder session start proof', () => {
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
    expect(typeof result.token).toBe('string');
    return result.token;
  }

  async function putCredential(userId: string, kind: 'oauth' | 'api-key', token: string): Promise<void> {
    await rpc(sharedToken, 'putUserCredential', { userId, kind, token });
  }

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-builder-start-proof-'));
    docker = await installFakeDocker(proofDir);
    homesBase = join(proofDir, 'builder-homes');
    // The member-home seam must resolve identically in the TEST process (these
    // assertions) and in the daemon (the launch). claude-home reads the env at
    // call time, so both sides see the same value.
    process.env.LAZY_BUILDER_HOMES_BASE_DIR = homesBase;

    ctx = await setupTestLazy({ fakeClaude: true });

    // The fake-binary seam patches the generated `[runner] type = "docker"` to
    // the host-process runner; this proof needs the REAL container launch path
    // (launchBuilderDetached), so patch it back. Checked replace per the
    // harness rules — a silent no-op would launch nothing and fail nowhere.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace(
      'type = "dangerously-host-process-without-any-isolation"',
      'type = "docker"',
    );
    if (patched === before) {
      throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    }
    await writeFile(configPath, patched);

    // Restart so the daemon runs the real capture/claude.ts against the fake
    // docker, in managed mode, with per-member homes redirected into the
    // proof dir. Managed mode requires an explicit storage path.
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_BUILDER_HOMES_BASE_DIR: homesBase,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    sharedToken = resolvedToken;
  });

  afterEach(async () => {
    delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  test('a member start claims the row before the launch and launches into the member home', async () => {
    // Managed-mode arming: the member's credential (the payer), the service
    // credential, and a user token that identifies ALICE to the daemon.
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const userToken = await mintUserToken(ALICE_EMAIL, 'Alice');

    // Seed the image the launch will find — identity computed from the same
    // files the daemon hashes, so no build runs and no selfcheck fires — and
    // hold every detached run so the claim window is observable.
    const manifest = await calculateImageInputManifest(ctx.root);
    const hash = await calculateImageInputsHash(ctx.root);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, { dockerfileHash: hash, inputs: manifest });
    await docker.slowDetachedRuns(3);

    const agentHome = ctx.agentHome;
    if (!agentHome) throw new Error('fake-agent setup did not expose the daemon HOME');
    const agentBinary = await seedAgentBinaryStamp(agentHome);

    // The member home the daemon must resolve for ALICE (same seam value in
    // both processes — set above before any launch).
    const memberHome = resolveBuilderSessionHomeDir(ctx.root, ALICE_EMAIL);

    // Fire the start without awaiting it. The proof is what happens DURING
    // the launch, which the hold keeps in flight for 3s.
    let startSettled = false;
    const startPromise = rpc(userToken, 'startBuilderSession', {}).then(
      (row) => { startSettled = true; return row; },
      (err) => { startSettled = true; throw err; },
    );

    // Poll the row THROUGH THE MEMBER TOKEN (which is also the scoped-read
    // exercise) until the claim is visible: state 'starting' with the
    // container name already written. The row id is unknowable before the
    // claim, so the member's active-session read is the handle.
    const readRow = async (): Promise<BuilderSession | null> => {
      return await rpc(userToken, 'storage', {
        method: 'getActiveBuilderSessionForMember',
        args: { projectRoot: ctx.root },
      }) as BuilderSession | null;
    };
    const deadline = Date.now() + 8_000;
    let claimedRow: BuilderSession | null = null;
    while (Date.now() < deadline) {
      const row = await readRow();
      if (row && row.state === 'starting' && row.containerName) {
        claimedRow = row;
        break;
      }
      await Bun.sleep(25);
    }

    // (2) The claim was observable while the launch was still in flight —
    // the ordering half of the proof. Launch-then-write code (the old shape)
    // never shows a container-named row before the RPC settles, so this line
    // goes red against it.
    expect(claimedRow).not.toBeNull();
    expect(claimedRow!.containerName).toBe(builderRunName(claimedRow!.containerName ?? ''));
    expect(startSettled).toBe(false);

    const row = await startPromise as BuilderSession;

    // (1) The row exists for the member, ends in 'running', and names the
    // container the launch actually created — cross-checked against the
    // detached run's own `--name`, not just against the handler's derivation.
    expect(row.projectRoot).toBe(ctx.root);
    expect(row.memberEmail).toBe(ALICE_EMAIL);
    expect(row.state).toBe('running');
    const invocations = await docker.invocations();
    const launchLine = invocations.find(l => l.includes('--name lazy-builder-') && l.includes(' -d '));
    expect(launchLine).toBeDefined();
    const nameMatch = launchLine!.match(/--name (lazy-builder-\S+)/);
    expect(nameMatch).not.toBeNull();
    const launchedContainer = nameMatch![1];
    expect(row.containerName).toBe(launchedContainer);
    // Same session through the whole call: the claim and the final row are
    // the same id, and a fresh read through the scoped read agrees.
    expect(claimedRow!.id).toBe(row.id);
    const finalRow = await readRow();
    expect(finalRow).not.toBeNull();
    expect(finalRow!.state).toBe('running');
    expect(finalRow!.containerName).toBe(launchedContainer);

    // (3) The launch env carries the member's session placeholder (never a
    // real credential) and the proxy base URL the container needs.
    const envMatch = launchLine!.match(/-e CLAUDE_CODE_OAUTH_TOKEN=(\S+)/);
    expect(envMatch).not.toBeNull();
    const placeholder = envMatch![1];
    expect(isSessionPlaceholderToken(placeholder)).toBe(true);
    expect(placeholder.startsWith('lazy-sess-')).toBe(true);
    expect(JSON.stringify(invocations)).not.toContain(ALICE_OAUTH);
    expect(JSON.stringify(invocations)).not.toContain(SERVICE_OAUTH);
    const baseMatch = launchLine!.match(/-e ANTHROPIC_BASE_URL=http:\/\/host\.docker\.internal:(\d+)/);
    expect(baseMatch).not.toBeNull();

    // (4) Tool permissions land in the MEMBER's home, never the daemon
    // process user's.
    expect(launchLine).toContain(`-v ${memberHome}/.claude:/home/user/.claude`);
    const memberSettings = JSON.parse(
      await readFile(join(memberHome, '.claude', 'settings.json'), 'utf-8'),
    ) as { permissions?: { allow?: string[] } };
    expect((memberSettings.permissions?.allow ?? []).some(e => e.startsWith('mcp__lazy__'))).toBe(true);
    const agentSettingsPath = join(agentHome, '.claude', 'settings.json');
    if (existsSync(agentSettingsPath)) {
      const agentSettings = await readFile(agentSettingsPath, 'utf-8');
      expect(agentSettings.includes('mcp__lazy__')).toBe(false);
    }

    // (5) The projects-isolation dir lives under the member's home — not the
    // shared data dir, which the same container mounts READ-WRITE.
    const projectsMatch = launchLine!.match(/-v (\S+):\/home\/user\/\.claude\/projects/);
    expect(projectsMatch).not.toBeNull();
    const projectsSource = projectsMatch![1];
    expect(projectsSource.startsWith(join(memberHome, 'builder-projects'))).toBe(true);
    expect(projectsSource.startsWith(ctx.root)).toBe(false);
    // The write probe validated THIS dir — the same one the launch mounts.
    const probeLine = invocations.find(l => l.startsWith('run --rm') && l.includes(':/home/user/.claude/projects'));
    expect(probeLine).toBeDefined();
    const probeSource = probeLine!.match(/-v (\S+):\/home\/user\/\.claude\/projects/)![1];
    expect(probeSource).toBe(projectsSource);

    // The agent binary the launch mounts is a content-addressed install under
    // the daemon's bin dir — whichever dev-mode path resolved it (the repo's
    // `./lazy-agent` real build when one exists, else the seeded stamp, else a
    // source compile). Never the placeholder, never a mutable pointer name.
    const agentMount = launchLine!.match(/-v (\S+):\/usr\/local\/bin\/lazy-agent:ro/);
    expect(agentMount).not.toBeNull();
    expect(agentMount![1].startsWith(join(agentHome, '.lazy', 'bin', 'lazy-agent-'))).toBe(true);
    expect(existsSync(agentMount![1])).toBe(true);
    expect((await stat(agentMount![1])).size).toBeGreaterThanOrEqual(1024);
  }, 120_000);

  test('a member with no stored credential is refused before any row exists', async () => {
    // Team mode ON via a DIFFERENT member's credential (the service credential
    // alone never flips it); ALICE herself has none. MONEY BEFORE
    // INFRASTRUCTURE: the policy refusal is not a launch attempt, so no
    // registry row may be left behind.
    await putCredential(BOB_EMAIL, 'oauth', BOB_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);
    const userToken = await mintUserToken(ALICE_EMAIL, 'Alice');

    const status = await rpcStatus(userToken, 'startBuilderSession', {});
    expect(status.status).toBe(400);
    expect(status.message).toContain(NO_OWNER_CREDENTIAL_MARKER);

    // No row AT ALL — not merely no active one. The active-session read is
    // filtered to non-ended rows, but a failed launch's claim is demoted to
    // 'ended' by the failure path, so only the raw list can see a row a
    // claim-before-refusal left behind. listBuilderSessions is the scoped
    // read: forced to this RPC's project root and the caller's own member.
    const all = await rpc(userToken, 'storage', { method: 'listBuilderSessions' }) as BuilderSession[];
    expect(all).toEqual([]);
  }, 60_000);
});