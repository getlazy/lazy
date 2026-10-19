import { requireLaunchModel } from '../agent/launch-model';
import type { AgentExecArgs } from '../agent/interface';
import { createHash, randomUUID } from 'crypto';
import { throttleNotes, type PhaseNotify } from '../daemon/progress';
import { currentBuildObserver, trackContainerBuild } from './build-observer';
import { readFileSync, existsSync, mkdirSync, chmodSync, unlinkSync, writeFileSync, renameSync } from 'fs';
import { access, mkdir, mkdtemp, writeFile, readFile, realpath, lstat } from 'fs/promises';
import { join, isAbsolute, dirname, basename, relative } from 'path';
import { networkInterfaces, tmpdir } from 'os';
import { AsyncLocalStorage } from 'async_hooks';
import type { AgentResponse, TokenUsage } from '../types';
import { ClaudeCodeAgent } from '../agent/claude-code';
import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { getAgentPackaging, listAgents } from '../agent/registry';
import { agentSupportsApiKey, resolveProfileCredential, alternativeCredentialHint, AGENT_KEY_ENV } from '../agent/credentials';
import { findLazyRoot } from '../project-paths';
import { dataDirOfWorktree, lazyDataDirMaskArgs } from './lazy-dir-mask';
import { loadConfig } from '../config/loader';
import {
  BUILDER_PROFILE_NAME,
  profileNameForAgent,
  harnessForAgentName,
  profileForAgentName,
  NO_CREDENTIAL,
} from '../config/agent-profiles';
import { envVarsFor, credentialSetupCommand, resolveCredentialTarget } from '../credentials/providers';
import type { RoleTarget } from '../config/types';
import { buildMountArgs } from './mounts';
import { buildPublishArgs } from '../serve/ports';
// Leaf module: task-env only reaches daemon/paths → utils/home, so this adds no
// cycle between the capture and daemon layers.
import { getTaskEnv, planTaskEnvLaunchFile, recordTaskEnvLaunched } from '../daemon/task-env';
import { sessionCredentialEnvFor } from '../daemon/turn-credentials';
import { isSessionPlaceholderToken, lookupSessionBinding, setSessionBindingOrigin } from '../daemon/session-credentials';
import { isBuildProgressLine, splitLines, formatDuration, buildTimeoutMessage } from './docker-build-output';
import { buildTaskGitMounts } from './git-mounts';
import {
  targetEnvVars,
  ANTHROPIC_DEFAULT_TARGET,
  LOCAL_BACKEND_CREDS,
  teamModeLaunchCreds,
  resolveProfileLaunchCreds,
  usesSyntheticCreds,
  type ProxyAuditHints,
  type LaunchSurface,
} from '../utils/role-target';
import { cursorLaunchEnvVars } from '../proxy/cursor-route';
import { piLaunchEnvVars, piCredentialMirror } from '../agent/pi-turn-config';
import { DEFAULT_UPSTREAM_TIMEOUT_SECONDS } from '../proxy/upstream-defaults';
import { codexLaunchEnvVars } from '../proxy/codex-route';
import { placeholderizeAuthEnv, type LaunchIdentity } from '../proxy/placeholder-env';
import { mintCredentialGrant, pinGrantsToAddresses } from '../proxy/credential-broker';
import { hasDaemonContext, getDaemonContext } from '../daemon/context';
import { targetCredentialRefusal } from '../daemon/credential-gate';
import { RpcError } from '../daemon/rpc-error';
// Cycle: auth-env imports getAuthEnvVars from this module. Safe — both sides
// are hoisted function declarations, called at request time, never during
// module evaluation.
import { resolveAuthEnvFromDaemon } from '../daemon/auth-env';
import { logger } from '../utils/logger';
import { isManagedMode } from '../config/managed-mode';
import { guestDockerdSupervised, recoverGuestDockerd, managedDockerDownMessage } from '../daemon/guest-dockerd';
import { diagnoseLostBuildConnection, isBuildConnectionLost, LOST_CONNECTION_HEADLINE } from '../daemon/build-connection-lost';
import { redactSecrets } from '../utils/redact';
import { isOfflineMode } from '../utils/offline';
import { spawn } from '../utils/spawn';
import { assertArgvBounded } from '../agent/argv-safety';
import { composeRunnerDockerfile, PUBLISHED_RUNNER_REF } from '../docker/runner-dockerfile';

// The default runner Dockerfile — base text plus every agent CLI. Exported so
// other modules (e.g. `lazy system export-dockerfile`) use the exact same text
// as the single source of truth — never copy it.
export const DEFAULT_DOCKERFILE = composeRunnerDockerfile();
import { getHome } from '../utils/home';
import { toTurnUsage } from '../utils/usage-recording';
import { VERSION } from '../version';
import {
  IMAGE_NAME,
  DOCKERFILE_HASH_LABEL,
  IMAGE_INPUTS_LABEL,
  DOCKERFILE_INPUT_KEY,
  IMAGE_TAG,
  IMAGE_MAX_AGE_DAYS,
  IMAGE_MAX_AGE_MS,
  consentedBuildIdentity,
  BASE_SOURCE_LABEL,
  shortHash,
  hashManifest,
  type ImageInputManifest,
} from './image-tag';
import { pathExists } from '../utils/fs';
import { TaskMutex } from '../utils/task-mutex';
import { analyzeLazyBaseUsage, type LazyBaseUsage } from './dockerfile-base';
import { adoptedBuildContextRoot } from '../daemon/adopted-image';
import { customImageGate, RunnerImageNotReadyError, DEFAULT_RUNNER_IMAGE_PIN, READONLY_DEFAULT_RUNNER_IMAGE_PIN, recordLaunchImage } from './custom-image-gate';
import { DamagedImageError, isDamagedLayerError, withDamagedImageRepair, type DamagedImageRepairDeps } from '../docker/damaged-image';

/**
 * Serializes `ensureImage` per resolved image name, so a fan-out of task starts
 * after a lockfile bump triggers ONE build instead of `max_concurrent_agents`
 * of them. The second caller waits, then finds the label hash current and
 * returns without building.
 *
 * In-process only, and that is the fan-out that matters: every task launch goes
 * through the daemon. A cross-PROCESS race remains — a human running
 * `lazy upgrade` or starting a builder from the CLI while the daemon fans out —
 * and it is left open deliberately: it is rare, and the loser just rebuilds an
 * image that is already correct. If it ever needs closing, the file-lock
 * pattern in src/utils/storage-lock.ts is the tool.
 */
const imageBuildMutex = new TaskMutex();

// Re-exported so callers keep importing the image identity from one place.
export { IMAGE_TAG, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS };

// Embedded at build/compile time — the agent binary is bundled into the lazy executable.
// In dev mode this resolves to the placeholder file on disk (which is empty/tiny).
// In compiled mode it resolves to a $bunfs/ path inside the executable.
//
// A `lazy-agent` file MUST exist at the project root for ANY bun build/run of
// src/ to resolve this import — it is gitignored (.gitignore), so nothing
// checked in provides it. Two things CREATE it: package.json's `prepare` hook
// (`ensure:agent-placeholder`, run by `bun install`) writes a tiny placeholder,
// and `scripts/build.ts` overwrites it with the real cross-compiled agent
// binary during a release build. One thing DESTROYS it: `install:local` moves
// the binary out to ~/.lazy/bin, then re-runs `ensure:agent-placeholder` to put
// a fresh placeholder back — if that step is ever removed, a dev checkout goes
// unbuildable with "Could not resolve: ../../lazy-agent" until the next
// `bun install`. See `scripts/release.sh`'s sanity-build guard for the same
// contract applied to release builds.
import embeddedAgentBinaryPath from '../../lazy-agent' with { type: 'file' };

import {
  verifyAgentBinary,
  verifyAgentBinaryBytes,
  formatAgentBinaryError,
  MIN_AGENT_BINARY_SIZE,
  verifyAgentBinarySelfcheckExec,
  assertAgentBinarySelfcheckForImage,
} from '../agent/binary-identity';
import {
  AGENT_BINARY_TMP_PREFIX,
  adoptLegacyAgentBinary,
  adoptVersionedAgentBinary,
  agentBinaryContentId,
  agentBinaryContentIdOfFile,
  agentBinaryPointerPath,
  installVersionedAgentBinary,
  listContainerMountSources,
  pruneAgentBinaries,
  resolveInstalledAgentBinary,
  updateAgentBinaryPointer,
  versionedAgentBinaryName,
  versionedAgentBinaryPath,
} from '../agent/binary-install';
import {
  captureBuildProvenance,
  restingBuildInfoContent,
  formatBuildInfoContent,
  formatSourceProvenanceLine,
  type BuildInfoValues,
} from '../utils/build-provenance';

/** Provenance of the most recent source compile in this process, if any. */
let lastSourceBuildProvenance: BuildInfoValues | null = null;

/** Serializes dev-mode source compiles — they briefly mutate src/build-info.ts. */
let sourceAgentBinaryBuild: Promise<string> | null = null;

/** Returns provenance when ensureAgentBinary last compiled from a source checkout. */
export function getLastSourceBuildProvenance(): BuildInfoValues | null {
  return lastSourceBuildProvenance;
}

export interface SandboxConfig {
  worktreePath: string;
  sandboxPath: string;
}



/**
 * `lazy-runner:latest` is still written on every base-image build, as an alias
 * for the version tag. Nothing lazy runs resolves through it — but custom
 * Dockerfiles do (`FROM lazy-runner`, documented in the README and in
 * src/prompts/setup-dockerfile.md), and those would break outright if the tag
 * disappeared. Keeping it pointed at the newest build preserves that contract
 * and keeps it fresh rather than frozen.
 */
const LATEST_ALIAS_TAG = 'latest';

// Timeout for Docker inspection commands (ms). Prevents process hangs if Docker daemon is unresponsive.
const DOCKER_TIMEOUT_MS = 10_000;

/**
 * Bounded timeout for launching a supervisor container (`docker run`).
 *
 * `launchSupervisorAsync` runs on the daemon's hottest paths (launch / unblock /
 * resume / auto-deliver). A wedged `docker run` (hung container runtime, stuck
 * image pull) must NEVER freeze the daemon event loop indefinitely, so the launch
 * is bounded. The value is generous — the image is normally already built by
 * `ensureImage` before launch, so `docker run -d` is sub-second, but a first-run
 * environment may still pull layers — yet finite so a hang surfaces as an
 * actionable error instead of a frozen daemon.
 */
const CONTAINER_LAUNCH_TIMEOUT_MS = 5 * 60_000; // 5 minutes

// Singleton agent instances for delegation. Functions in this file that were
// previously hard-coded now delegate to the agent abstraction.
const _agent = new ClaudeCodeAgent();
const _packaging = new ClaudeCodePackaging();


export async function checkDocker(binary: string = 'docker'): Promise<void> {
  logger.debug(`Checking ${binary}...`);

  const answers = async () =>
    (await spawn([binary, 'info'], { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }).exited) === 0;
  if (!(await answers())) {
    // A Teams machine's dockerd is the project's own: it did not need
    // installing, it stopped. Try once to bring it back, then name that.
    if (binary === 'docker' && guestDockerdSupervised()) {
      const report = await recoverGuestDockerd('a build or launch');
      if (report.ready && (await answers())) {
        logger.debug(`${binary} is running again ✓`);
        return;
      }
      throw new Error(managedDockerDownMessage(report));
    }
    if (isManagedMode()) throw new Error(managedDockerDownMessage(null));

    const name = binary.charAt(0).toUpperCase() + binary.slice(1);
    const installUrl = binary === 'podman'
      ? 'https://podman.io/docs/installation'
      : `https://docs.${binary}.com/get-${binary}/`;
    throw new Error(`${name} is not installed or not running. Install ${name}: ${installUrl}`);
  }

  logger.debug(`${binary} is running ✓`);
}

function getLazyRoot(): string {
  const root = findLazyRoot();
  if (!root) {
    throw new Error('Not in a lazy project. Run `lazy init` first.');
  }
  return root;
}

/**
 * Whether THIS process is an explicit upgrade image build.
 *
 * Off by default, and opt-in per process — never per call site. Only
 * `lazy upgrade` (incl. `--images`) turns it on at command entry; the daemon,
 * `lazy supervise`, and every launch path leave it off.
 *
 * WHY IT EXISTS (and is NOT an env var): Part 2's soft-pin / path-resolve split
 * needs an upgrade-vs-launch signal. Soft-pin when this is off (launches use
 * `adopted.imageName` and never rebuild from the worktree path). Path-resolve
 * when it is on (the upgrade build may return `adopted.dockerfilePath`). A
 * process-wide latch keeps hash, content-addressed image name, and build in
 * agreement — same shape as the old env-override latch, without the env var
 * that wedged daemons when a worktree path went missing.
 */
let upgradeImageBuildEnabled = false;

/**
 * Opt this process into upgrade-build image resolution. Called ONLY by
 * `lazy upgrade` (incl. `--images`) at command entry, before anything resolves
 * an image. Nothing in the daemon or a supervisor may call it.
 */
export function enableUpgradeImageBuild(): void {
  upgradeImageBuildEnabled = true;
}

/** Undo `enableUpgradeImageBuild` — for tests, which share one process. */
export function resetUpgradeImageBuild(): void {
  upgradeImageBuildEnabled = false;
}

/** Whether this process opted into an upgrade image build. */
export function isUpgradeImageBuild(): boolean {
  return upgradeImageBuildEnabled;
}

/**
 * Resolve the custom Dockerfile path.
 * Returns the absolute path if one is in effect and the file exists, null
 * otherwise (default image).
 *
 * Resolution order:
 * 1. Daemon-adopted worktree Dockerfile (`adopted-image.json`) when valid —
 *    ONLY while the upgrade-build latch is on (upgrade that just wrote
 *    adoption). Routine launches must NOT resolve via this path: they
 *    soft-pin `imageName` in `ensureImage` instead, so a post-consent agent
 *    edit of the worktree Dockerfile cannot become a host docker rebuild.
 * 2. `[docker].dockerfile` from config, joined to the PROJECT ROOT.
 * 3. With that key unset: `Dockerfile.lazy` in the PROJECT ROOT, if present.
 *
 * INVARIANT: a task's worktree must never *automatically* govern the image.
 * Task branches are agent-writable, and deriving the image from one without
 * human consent would let an agent's Dockerfile.lazy edits execute as build
 * steps under the daemon's docker on the HOST. Launch paths therefore never
 * anchor image resolution at the task worktree. Human-consented paths:
 *   - Part 1: CLI TTY create/start/edit → task metadata pin (ensureImage
 *     honors `pinnedImage` before this function runs)
 *   - Part 2: CLI TTY `lazy upgrade` → daemon adoption; launches soft-pin
 *     `imageName`, upgrade builds may resolve the path here while the latch
 *     is on
 *
 * Exported for `lazy upgrade`'s image-source announcement.
 */
/** The root-level Dockerfile lazy builds when `[docker].dockerfile` is unset. */
export const CONVENTIONAL_DOCKERFILE = 'Dockerfile.lazy';

/**
/**
 * What the root `Dockerfile.lazy` convention decides, with `[docker].dockerfile`
 * unset. `used` is the only state that builds it; the two skipped states are
 * treated exactly as an absent file (the default image) and are reported by
 * `lazy doctor`, the launch narration and (on a backend that never builds it) a
 * system message — never silently.
 */
export type ConventionalDockerfileState =
  | { kind: 'absent' }
  /** On disk but not committed on the root's branch: nobody reviewed or accepted it. */
  | { kind: 'untracked'; path: string }
  /** Committed, but this Teams backend would build it on a shared host dockerd. */
  | { kind: 'not-built-on-backend'; branch: string; blob: string }
  /**
   * Committed and built. `path` is a private SNAPSHOT of the committed blob —
   * never the working-tree file — so the identity hash and the build read the
   * exact bytes that were accepted.
   */
  | { kind: 'used'; branch: string; blob: string; path: string };

/** The one line agents and Teams are shown when the backend skips the file. */
export const ROOT_DOCKERFILE_SKIPPED_ON_BACKEND =
  `this project's ${CONVENTIONAL_DOCKERFILE} is not built on this install's backend ` +
  `(builds there would run on the shared host); tasks use the base image`;

/**
 * Decide the root `Dockerfile.lazy` convention for this project root.
 *
 * INVARIANT: the convention NEVER reads the working tree. The root checkout is
 * a directory anything on the host can write to — an uncommitted edit, a
 * symlink swapped in over a committed file (pointing into a task worktree
 * inside `.lazy/worktrees`, which containment alone would pass), or a task
 * branch the root has checked out for the length of an accept. So:
 *   - ONE pinned ref: the branch the root has checked out, refused when that is
 *     a task branch (an accept is mid-flight) or HEAD is detached;
 *   - the tree entry must be a REGULAR file (mode 100644/100755), never a
 *     symlink or submodule;
 *   - the bytes are read with `git cat-file blob`, and exactly those bytes are
 *     hashed for the image identity and handed to `docker build`.
 * The file on disk is consulted for one thing only: telling an uncommitted
 * file apart from no file, so `lazy doctor` can say "commit it".
 *
 * INVARIANT: on Lazy Teams' local-docker backend the convention does not apply
 * (see `autoBuildsRootDockerfile`); an owner-configured `[docker].dockerfile`
 * is unaffected, because an owner who set it has already chosen.
 */
export async function inspectConventionalDockerfile(lazyRoot: string): Promise<ConventionalDockerfileState> {
  const onDisk = join(lazyRoot, CONVENTIONAL_DOCKERFILE);
  // Nothing at that path (not even a dangling symlink): the default image, with
  // no git call — the common case for every project without the file, on every
  // launch. Safe in the direction it errs: it can only choose the DEFAULT image,
  // never build bytes from disk (a committed file deleted from the root
  // checkout means the default image until it is restored).
  try {
    await lstat(onDisk);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw new Error(`failed to check ${onDisk}: ${(err as Error).message}`, { cause: err });
  }
  const branch = await rootIntegrationBranch(lazyRoot);
  const entry = branch ? await committedTreeEntry(lazyRoot, branch, CONVENTIONAL_DOCKERFILE) : null;
  if (!branch || !entry) {
    return { kind: 'untracked', path: onDisk };
  }

  const { autoBuildsRootDockerfile } = await import('../config/managed-mode');
  if (!autoBuildsRootDockerfile()) return { kind: 'not-built-on-backend', branch, blob: entry.sha };

  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
    throw new Error(
      `Refusing to build from ${CONVENTIONAL_DOCKERFILE}: on ${branch} it is committed as ` +
      `${entry.mode === '120000' ? 'a symlink' : `a ${entry.type} (mode ${entry.mode})`}, not a regular file. ` +
      `Commit the Dockerfile itself at the repository root.`,
    );
  }
  return { kind: 'used', branch, blob: entry.sha, path: await snapshotCommittedBlob(lazyRoot, entry.sha) };
}

/**
 * One human line when a root Dockerfile.lazy exists but the convention skipped
 * it, or null. Consulted only with `[docker].dockerfile` unset.
 */
export async function describeSkippedRootDockerfile(lazyRoot: string): Promise<string | null> {
  const config = await loadConfig(lazyRoot);
  if (config.docker.dockerfile) return null;
  const state = await inspectConventionalDockerfile(lazyRoot);
  if (state.kind === 'untracked') {
    return `${CONVENTIONAL_DOCKERFILE} at the project root is not committed, so it is not used — ` +
      `tasks use the base image. Commit it to make it the task image.`;
  }
  if (state.kind === 'not-built-on-backend') return ROOT_DOCKERFILE_SKIPPED_ON_BACKEND;
  return null;
}

/** `timeoutMs`: 15s suits a ref/blob lookup; a whole-tree `git archive` passes its own. */
export async function gitInRoot(
  lazyRoot: string,
  args: string[],
  timeoutMs: number = 15_000,
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: string }> {
  const proc = spawn(['git', ...args], { cwd: lazyRoot, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout: Buffer.from(stdout), stderr };
}

function gitFailure(lazyRoot: string, what: string, result: { exitCode: number | null; stderr: string }): Error {
  return new Error(`git could not ${what} in ${lazyRoot} (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

/**
 * The branch the project root has checked out — the ONE ref the convention
 * reads — or null when it has no commits yet. Decided from exit codes and
 * output, never git's (localized) messages: `symbolic-ref -q` exits 1 for a
 * detached HEAD, `rev-parse --verify -q` exits 1 for an unborn branch; any
 * other failure is a broken repository and throws.
 */
export async function rootIntegrationBranch(lazyRoot: string): Promise<string | null> {
  const head = await gitInRoot(lazyRoot, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (head.exitCode === 1) {
    throw new Error(
      `Refusing to use ${CONVENTIONAL_DOCKERFILE}: the project root (${lazyRoot}) has a detached HEAD, ` +
      `so there is no branch to read the accepted file from. Check out the project's branch there and relaunch.`,
    );
  }
  if (head.exitCode !== 0) throw gitFailure(lazyRoot, 'read HEAD', head);
  const branch = head.stdout.toString().trim();

  const { looksLikeTaskBranch } = await import('../git/branch-prefix');
  if (looksLikeTaskBranch(branch)) {
    throw new Error(
      `Refusing to use ${CONVENTIONAL_DOCKERFILE}: the project root has the task branch ${branch} checked out ` +
      `(an accept is probably in progress), and a task branch never chooses the image. Relaunch once the root ` +
      `is back on the project's branch.`,
    );
  }

  const commit = await gitInRoot(lazyRoot, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  if (commit.exitCode === 1) return null; // unborn: nothing is committed yet
  if (commit.exitCode !== 0) throw gitFailure(lazyRoot, `resolve ${branch}`, commit);
  return branch;
}

/** The tree entry for `relPath` on `branch`, or null when it is not committed there. */
export async function committedTreeEntry(
  lazyRoot: string,
  branch: string,
  relPath: string,
): Promise<{ mode: string; type: string; sha: string } | null> {
  const tree = await gitInRoot(lazyRoot, ['ls-tree', '-z', `refs/heads/${branch}`, '--', relPath]);
  if (tree.exitCode !== 0) throw gitFailure(lazyRoot, `list ${relPath} on ${branch}`, tree);
  const line = tree.stdout.toString().split('\0')[0];
  if (!line) return null;
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(line);
  if (!match) throw new Error(`unexpected git ls-tree output for ${relPath} in ${lazyRoot}: ${line}`);
  return { mode: match[1], type: match[2], sha: match[3] };
}

/**
 * Write the committed blob to a snapshot only this process can write, and
 * return its path. Content-addressed by blob sha inside a per-process mkdtemp
 * directory (mode 0700): never a predictable shared path another local user
 * could plant, and never the working-tree file.
 */
let committedSnapshotDir: Promise<string> | null = null;
const committedSnapshotLabels = new Map<string, string>();

async function snapshotCommittedBlob(lazyRoot: string, blob: string): Promise<string> {
  // A failed mkdtemp is not cached, and a directory a tmp cleaner removed is
  // recreated by a NEW mkdtemp (0700), never by a plain mkdir of the old path.
  if (committedSnapshotDir) {
    const existing = await committedSnapshotDir.catch(() => null);
    if (!existing || !(await pathExists(existing))) committedSnapshotDir = null;
  }
  committedSnapshotDir ??= mkdtemp(join(tmpdir(), 'lazy-committed-dockerfile-'));
  const base = await committedSnapshotDir.catch((err: Error) => {
    committedSnapshotDir = null;
    throw new Error(`could not create a private directory for the committed ${CONVENTIONAL_DOCKERFILE}: ${err.message}`, { cause: err });
  });
  const dir = join(base, blob);
  const path = join(dir, CONVENTIONAL_DOCKERFILE);
  if (!(await pathExists(path))) {
    const bytes = await gitInRoot(lazyRoot, ['cat-file', 'blob', blob]);
    if (bytes.exitCode !== 0) throw gitFailure(lazyRoot, `read ${CONVENTIONAL_DOCKERFILE} (${blob})`, bytes);
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes.stdout);
    const { rename } = await import('fs/promises');
    await rename(tmp, path);
  }
  committedSnapshotLabels.set(path, `${CONVENTIONAL_DOCKERFILE} as committed (${blob.substring(0, 12)}) in ${lazyRoot}`);
  return path;
}

/**
 * Name a lazy-owned Dockerfile snapshot for build announcements and status
 * surfaces. A ref adoption's snapshot path (src/daemon/image-adoption.ts)
 * tells a person nothing about which branch it came from.
 */
export function labelDockerfileSource(path: string, label: string): void {
  committedSnapshotLabels.set(path, label);
}

/** A human name for a snapshot path the convention returned, for build announcements. */
export function describeDockerfileSource(path: string): string {
  return committedSnapshotLabels.get(path) ?? path;
}

/**
 * Within one `ensureImage` call, the FIRST resolution is reused by every later
 * one (identity hash, build, preflight), so the image is tagged and built from
 * the same bytes even if the root moves mid-launch. Keyed by project root.
 */
const dockerfilePin = new AsyncLocalStorage<{ resolved: { root: string; path: string | null } | null }>();

export async function resolveCustomDockerfile(lazyRoot: string): Promise<string | null> {
  const pin = dockerfilePin.getStore();
  if (pin?.resolved && pin.resolved.root === lazyRoot) return pin.resolved.path;
  const path = await resolveCustomDockerfileFresh(lazyRoot);
  if (pin) pin.resolved = { root: lazyRoot, path };
  return path;
}

async function resolveCustomDockerfileFresh(lazyRoot: string): Promise<string | null> {
  // A Dockerfile ADOPTED FROM A GIT REF by a project admin (Teams' recovery
  // from a failing Dockerfile.lazy) governs the whole project ahead of the
  // root file, for launches and builds alike. Unlike a worktree adoption it is
  // resolved here on every launch rather than soft-pinned: its snapshot and
  // build context are lazy-owned copies of a COMMITTED tree under the daemon
  // dir that no agent can write, so building from them builds exactly what the
  // admin confirmed — and it lets the daemon's boot build own the image,
  // rebuild it after a version bump or a VM replacement, and report a failure
  // the way it reports the root file's.
  const { resolveRefAdoptedDockerfileSnapshot } = await import('../daemon/adopted-image');
  const refSnapshot = await resolveRefAdoptedDockerfileSnapshot(lazyRoot);
  if (refSnapshot) return refSnapshot;

  // Adoption path is ONLY for the explicit upgrade build (latch on). Launches
  // soft-pin via ensureImage and must not re-hash the worktree file here.
  // Returns the consented SNAPSHOT (outside any worktree), never the live
  // worktree path — closes hash/build TOCTOU on agent edits after consent.
  if (upgradeImageBuildEnabled) {
    const { resolveAdoptedDockerfileSnapshot } = await import('../daemon/adopted-image');
    const snapshot = await resolveAdoptedDockerfileSnapshot(lazyRoot);
    if (snapshot) return snapshot;
  }

  const config = await loadConfig(lazyRoot);
  const configPath = config.docker.dockerfile;
  if (!configPath) {
    const state = await inspectConventionalDockerfile(lazyRoot);
    return state.kind === 'used' ? state.path : null;
  }

  const absPath = join(lazyRoot, configPath);
  try {
    await access(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Custom Dockerfile not found: ${configPath} (resolved to ${absPath}). ` +
        `Check the [docker].dockerfile setting in lazy.toml.`
      );
    }
    throw new Error(
      `failed to access custom Dockerfile at ${absPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  await assertInsideProject(lazyRoot, absPath, configPath);
  return absPath;
}

/**
 * Refuse a Dockerfile whose real path leaves the project. `docker build` runs on
 * the HOST and its error output reaches whoever sees launch failures, so a
 * committed symlink (`Dockerfile.lazy -> /proc/self/environ`) must not turn
 * the image build into a way of reading host files.
 */
async function assertInsideProject(lazyRoot: string, absPath: string, label: string): Promise<void> {
  const [realRoot, realFile] = await Promise.all([realpath(lazyRoot), realpath(absPath)]);
  const rel = relative(realRoot, realFile);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Refusing to build from ${label}: it resolves to ${realFile}, outside the project (${realRoot}). ` +
      `Replace the symlink with a regular file inside the repository.`,
    );
  }
}

/**
 * Resolve the extra `docker run` arguments for TASK containers
 * (`[docker] run_args`).
 *
 * INVARIANT: like the image (see resolveCustomDockerfile above), run args must
 * come from the PROJECT ROOT's lazy.toml, never from a task worktree's copy.
 * Task branches are agent-writable, and honouring a worktree lazy.toml here
 * would let an agent grant its own next container `--privileged` or a host
 * bind mount. `loadConfig` now anchors every read at the project root (see
 * findConfigDir in src/config/loader.ts), so this is anchoring by construction
 * rather than by call-site discipline; the wrapper stays because the key's
 * anchoring is asserted directly (test/unit/docker-run-args.test.ts).
 */
export async function resolveDockerRunArgs(lazyRoot: string): Promise<string[]> {
  const config = await loadConfig(lazyRoot);
  return config.docker.run_args;
}

/**
 * Whether the path returned by resolveCustomDockerfile came from daemon
 * adoption (vs [docker].dockerfile). Used by upgrade's image-source
 * announcement — only meaningful while the upgrade-build latch is on.
 */
export async function isAdoptedDockerfile(
  lazyRoot: string,
  dockerfilePath: string | null,
): Promise<boolean> {
  if (!dockerfilePath) return false;
  // Adoption path resolution requires the upgrade latch; without it this
  // function never returns an adopted path.
  if (!upgradeImageBuildEnabled) return false;
  const { getAdoptedDockerfilePath } = await import('../daemon/paths');
  const { loadValidAdoptedImage } = await import('../daemon/adopted-image');
  const adopted = await loadValidAdoptedImage(lazyRoot);
  if (!adopted) return false;
  // resolveCustomDockerfile returns the snapshot path, not the worktree path.
  return dockerfilePath === getAdoptedDockerfilePath(lazyRoot);
}

/**
 * Repository name (no tag) of a valid daemon-adopted image, or null.
 *
 * The adoption prompt names the image from the consented Dockerfile bytes AND
 * the commit whose tree is its build context, so the name cannot be re-derived
 * from content alone. Gated on the upgrade-build latch for the same reason
 * `resolveCustomDockerfile`'s adoption branch is: routine launches soft-pin
 * `imageName` in `ensureImage` and must not resolve adoption here.
 */
async function adoptedImageRepository(lazyRoot: string): Promise<string | null> {
  if (!upgradeImageBuildEnabled) return null;
  const { loadValidAdoptedImage } = await import('../daemon/adopted-image');
  const adopted = await loadValidAdoptedImage(lazyRoot);
  if (!adopted) return null;
  const colon = adopted.imageName.lastIndexOf(':');
  return colon > 0 ? adopted.imageName.substring(0, colon) : adopted.imageName;
}

/**
 * Get the Dockerfile content to use for building the lazy container.
 *
 * Resolution order:
 * 1. The custom Dockerfile `resolveCustomDockerfile` returns: [docker].dockerfile,
 *    or with that unset a Dockerfile.lazy in the project root
 * 2. Embedded default Dockerfile (base image)
 *
 * The project's own Dockerfile is NEVER used automatically — it's for the
 * project, not for agent containers. Use `lazy init` to create a Dockerfile.lazy
 * based on the project's Dockerfile if needed.
 */
async function getDockerfileContent(lazyRoot: string, forceDefault: boolean = false): Promise<{ content: string; isCustom: boolean }> {
  const customPath = forceDefault ? null : await resolveCustomDockerfile(lazyRoot);
  if (customPath) {
    // Custom Dockerfiles are the user's own — never silently amended. Building
    // `FROM lazy-runner` gives them every agent CLI; a Dockerfile on another
    // base adds its agent's install line itself.
    return { content: await readFile(customPath, 'utf-8'), isCustom: true };
  }

  // The default image carries EVERY container-capable agent's CLI, so there is
  // one default image whatever agent a project or task runs
  // (docs/design/published-runner-image.md).
  return { content: DEFAULT_DOCKERFILE, isCustom: false };
}

export type { ImageInputManifest };

/**
 * Resolve `[docker] build_inputs` to absolute paths, in a stable sorted order.
 *
 * A declared file that does NOT exist is a hard error, not a warning, and not
 * "hashes as absent". The alternatives both fail silently in the case that
 * actually happens: a typo (`Gemfille.lock`) would hash as permanently absent,
 * so the image would never rebuild on a lockfile bump and the user would get
 * exactly the silent drift this feature exists to remove — with no signal
 * anywhere. Erroring matches how a missing `[docker] dockerfile` already fails
 * (`resolveCustomDockerfile` above), and the fix is a one-line lazy.toml edit
 * named in the message.
 */
async function resolveBuildInputs(lazyRoot: string): Promise<{ relative: string; absolute: string }[]> {
  const config = await loadConfig(lazyRoot);
  const declared = config.docker.build_inputs;
  if (declared.length === 0) return [];

  const resolved = [...declared]
    .sort()
    .map(relative => ({ relative, absolute: join(lazyRoot, relative) }));

  const missing: string[] = [];
  for (const input of resolved) {
    if (!(await pathExists(input.absolute))) missing.push(input.relative);
  }
  if (missing.length > 0) {
    throw new Error(
      `[docker] build_inputs file(s) not found: ${missing.join(', ')} ` +
      `(resolved against ${lazyRoot}). ` +
      `Remove them from the build_inputs setting in lazy.toml, or create the files.`
    );
  }

  return resolved;
}

/**
 * Everything the image identity is derived from: the Dockerfile text plus the
 * contents of every declared build input.
 *
 * Files are hashed as `path + content` (not content alone) so that renaming a
 * declared input — same bytes, different name — is a change: the Dockerfile
 * COPYs it by name, so the built image genuinely differs.
 */
export async function calculateImageInputManifest(lazyRoot: string, forceDefault: boolean = false): Promise<ImageInputManifest> {
  const { content } = await getDockerfileContent(lazyRoot, forceDefault);
  return manifestForDockerfileContent(lazyRoot, content);
}

/** The input manifest of an image built from `content` with this project's `build_inputs`. */
async function manifestForDockerfileContent(lazyRoot: string, content: string): Promise<ImageInputManifest> {
  const manifest: ImageInputManifest = { [DOCKERFILE_INPUT_KEY]: shortHash(content) };

  for (const input of await resolveBuildInputs(lazyRoot)) {
    const bytes = await readFile(input.absolute);
    manifest[input.relative] = shortHash(Buffer.concat([Buffer.from(`${input.relative}\0`), bytes]));
  }

  return manifest;
}

/**
 * The image's identity hash — what goes in DOCKERFILE_HASH_LABEL and what
 * `ensureImage` compares to decide whether to rebuild.
 *
 * Deliberately NOT folded into `resolveImageRepository`: the repository stays
 * `lazy-custom-<dockerfile-hash>`, so a lockfile bump rebuilds the image IN
 * PLACE rather than minting a new image name per bump and leaving a trail of
 * orphaned images behind.
 *
 * With no `build_inputs` configured the manifest holds one entry and this is
 * NOT the bare sha256 of the Dockerfile text it used to be — so every existing
 * image looks stale exactly once, rebuilds, and is stable from then on. That
 * one-off is the cost of having a single identity mechanism instead of two.
 */
export async function calculateImageInputsHash(lazyRoot: string, forceDefault: boolean = false): Promise<string> {
  return (await resolveImageIdentity(lazyRoot, forceDefault)).hash;
}

/** The identity hash and the manifest it was derived from, always in step. */
export interface ImageIdentity {
  hash: string;
  manifest: ImageInputManifest;
}

/**
 * Resolved once per build/check so the label pair written to an image can never
 * disagree with each other.
 */
async function resolveImageIdentity(lazyRoot: string, forceDefault: boolean = false): Promise<ImageIdentity> {
  const manifest = await calculateImageInputManifest(lazyRoot, forceDefault);
  return { hash: hashManifest(manifest), manifest };
}


/**
 * Human-readable reason a rebuild is happening, by diffing the manifest an
 * image was built from against the current one.
 *
 * Best-effort by construction: `previous` is null for any image built before
 * the manifest label existed, and the caller falls back to a generic message.
 */
export function describeInputChanges(
  previous: ImageInputManifest | null,
  current: ImageInputManifest,
): string | null {
  if (!previous) return null;

  const changes: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    if (!(path in previous)) changes.push(`${path} added`);
    else if (previous[path] !== hash) changes.push(`${path} changed`);
  }
  for (const path of Object.keys(previous)) {
    if (!(path in current)) changes.push(`${path} no longer a build input`);
  }

  return changes.length > 0 ? changes.join(', ') : null;
}

/**
 * Determine the Docker image REPOSITORY (name without tag) to use.
 * Default behavior uses 'lazy-runner'. Custom Dockerfiles use 'lazy-custom-{hash}'.
 * There is no per-agent variant: the default image carries every agent CLI.
 */
export async function resolveImageRepository(lazyRoot: string, forceDefault: boolean = false): Promise<{ repository: string; isCustom: boolean }> {
  const { isCustom, content } = await getDockerfileContent(lazyRoot, forceDefault);

  if (isCustom) {
    // An adopted worktree Dockerfile was NAMED at the consent prompt, from its
    // content AND the commit that froze its build context. Re-deriving a name
    // from content alone here would answer a different question than the build
    // did, so the two could drift apart — read the consented name instead.
    const adoptedRepository = await adoptedImageRepository(lazyRoot);
    if (adoptedRepository) {
      return { repository: adoptedRepository, isCustom: true };
    }
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 12);
    return { repository: `lazy-custom-${hash}`, isCustom: true };
  }

  return { repository: IMAGE_NAME, isCustom: false };
}

/**
 * Determine the full Docker image reference to run — always tagged with lazy's
 * major.minor version (see IMAGE_TAG), never `:latest`.
 */
export async function resolveImageName(lazyRoot: string): Promise<string> {
  const { repository } = await resolveImageRepository(lazyRoot);
  return `${repository}:${IMAGE_TAG}`;
}

/**
 * Tags written by a build of `repository`. The base runner image also gets the
 * `:latest` alias so `FROM lazy-runner` in custom Dockerfiles keeps resolving;
 * a custom image's repository name is already content-addressed by its
 * Dockerfile hash, so an alias there would only add clutter nothing reads.
 */
function buildTagsFor(repository: string): string[] {
  const versioned = `${repository}:${IMAGE_TAG}`;
  return repository === IMAGE_NAME ? [versioned, `${repository}:${LATEST_ALIAS_TAG}`] : [versioned];
}

/**
 * Tags a LOCAL build of `repository` writes. A local build of the default
 * runner is also tagged with the published ref this lazy would have pulled, so a
 * FROM that names the published image resolves whether it was pulled or built
 * (docs/design/published-runner-image.md §2).
 */
function localBuildTagsFor(repository: string): string[] {
  const tags = buildTagsFor(repository);
  return repository === IMAGE_NAME ? [...tags, PUBLISHED_RUNNER_REF] : tags;
}

/** Labels a LOCAL build of the default runner carries (see {@link BASE_SOURCE_LABEL}). */
const LOCAL_BASE_LABELS: Record<string, string> = { [BASE_SOURCE_LABEL]: 'local' };

/** The identity of the default runner image: the composed Dockerfile alone. */
function defaultRunnerIdentity(): ImageIdentity {
  const manifest: ImageInputManifest = { [DOCKERFILE_INPUT_KEY]: shortHash(DEFAULT_DOCKERFILE) };
  return { hash: hashManifest(manifest), manifest };
}

/** One label off a local image, or null when the image or the label is absent. */
async function getImageLabel(imageName: string, label: string, binary: string): Promise<string | null> {
  const inspect = spawn(
    [binary, 'image', 'inspect', imageName, '--format', `{{index .Config.Labels "${label}"}}`],
    { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
  );
  const [stdout, exitCode] = await Promise.all([new Response(inspect.stdout).text(), inspect.exited]);
  if (exitCode !== 0) return null;
  const value = stdout.trim();
  return value && value !== '<no value>' ? value : null;
}

/** Was this image pulled from the release rather than built on this host? */
async function isPublishedImage(imageName: string, binary: string): Promise<boolean> {
  return (await getImageLabel(imageName, BASE_SOURCE_LABEL, binary)) === 'published';
}

/** How long a pull of the runner may take — it is well over a gigabyte. */
const RUNNER_PULL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Why a pull of the published runner failed, and whether that is the ordinary
 * "nothing was published for this runner" fallback (quiet) or a real problem the
 * human can fix (warned, with the remedy). Exported for its unit test.
 */
export function classifyRunnerPullFailure(detail: string, exitCode: number | null): { quiet: boolean; why: string } {
  const text = detail || `exit code ${exitCode}`;
  if (/manifest unknown|manifest for \S+ not found/i.test(detail)) {
    return { quiet: true, why: `no runner image ${PUBLISHED_RUNNER_REF} was published (lazy ${VERSION} composes a runner no release built)` };
  }
  let remedy: string;
  if (/unauthorized|denied|authentication required|403 forbidden/i.test(detail)) {
    remedy = 'if you are logged in to ghcr.io, stale credentials are the usual cause — run `docker logout ghcr.io` and retry; otherwise the image may not be published or public yet';
  } else if (/x509|certificate|tls/i.test(detail)) {
    remedy = 'a TLS-intercepting proxy or missing CA certificate is the usual cause — trust its CA in your container runtime';
  } else if (/no such host|lookup |dial tcp|i\/o timeout|timeout|connection refused|network is unreachable|temporary failure/i.test(detail)
    || exitCode === null) {
    remedy = 'the registry could not be reached — check your network, or run `lazy system offline` to stop trying';
  } else {
    remedy = 'run the same `docker pull` by hand to see the full error';
  }
  return { quiet: false, why: `the pull of ${PUBLISHED_RUNNER_REF} failed: ${text} — ${remedy}` };
}

/** What {@link pullPublishedRunner} did: pulled, or why not (null = not attempted by design). */
type RunnerPullOutcome = { pulled: true } | { pulled: false; why: string | null };

/** A fallback build that failed also carries the reason the pull did not happen. */
function withPullReason(err: unknown, outcome: RunnerPullOutcome): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (outcome.pulled || !outcome.why) return error;
  error.message = `${error.message}\n(Built locally because ${outcome.why}.)`;
  return error;
}

/**
 * Pull the release's runner image and tag it onto `targets`. Returns false
 * (never throws) when the caller should build locally instead, after saying why
 * once: offline, an identity no published image can have, a version that was
 * never published, a failed pull, or a published image whose identity label does
 * not match what this binary composes (a publishing bug, never used).
 *
 * See docs/design/published-runner-image.md §4.
 */
async function pullPublishedRunner(
  lazyRoot: string | null,
  identity: ImageIdentity,
  targets: string[],
  binary: string,
  notify?: PhaseNotify,
): Promise<RunnerPullOutcome> {
  const expected = defaultRunnerIdentity();
  if (identity.hash !== expected.hash) {
    // Only [docker] build_inputs on the default Dockerfile get here: those
    // files are part of the identity, so no published image can match it.
    logger.debug(`Not pulling ${PUBLISHED_RUNNER_REF}: this project's image identity includes build inputs`);
    return { pulled: false, why: null };
  }
  if (lazyRoot) {
    const config = await loadConfig(lazyRoot);
    if (await isOfflineMode(join(lazyRoot, '.lazy'), config.remote.offline)) {
      logger.info(`Offline mode: building ${targets[0]} locally instead of pulling ${PUBLISHED_RUNNER_REF}.`);
      return { pulled: false, why: 'offline mode is on' };
    }
  }

  notify?.(`pulling ${PUBLISHED_RUNNER_REF}`);
  logger.info(`Pulling ${PUBLISHED_RUNNER_REF} (the published runner image lazy ${VERSION} composes)...`);
  const proc = spawn([binary, 'pull', PUBLISHED_RUNNER_REF], { stdout: 'ignore', stderr: 'pipe', timeout: RUNNER_PULL_TIMEOUT_MS });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    const { quiet, why } = classifyRunnerPullFailure(stderr.trim(), exitCode);
    if (quiet) logger.info(`Building ${targets[0]} locally — ${why}.`);
    else logger.warn(`Building ${targets[0]} locally — ${why}.`);
    notify?.(`building locally — ${why}`);
    return { pulled: false, why };
  }

  const pulledHash = await getImageDockerfileHash(PUBLISHED_RUNNER_REF, binary);
  if (pulledHash !== expected.hash) {
    logger.warn(
      `${PUBLISHED_RUNNER_REF} carries identity ${pulledHash ?? '(none)'}, but lazy ${VERSION} composes ${expected.hash}. ` +
      `The release published a different Dockerfile than this binary builds — not using it; building locally.`,
    );
    return { pulled: false, why: `the published ${PUBLISHED_RUNNER_REF} was built from a different Dockerfile than lazy ${VERSION} composes` };
  }

  await selfcheckImage(PUBLISHED_RUNNER_REF, binary);
  await tagImage(PUBLISHED_RUNNER_REF, targets, binary);
  notify?.(`using published image ${PUBLISHED_RUNNER_REF}`);
  return { pulled: true };
}

/**
 * Async (not spawnSync) because this sits on the daemon's task-launch hot path:
 * ensureImage() runs on every container start, and `docker image inspect` can
 * take seconds under a loaded Docker daemon. A sync spawn there freezes the
 * daemon's event loop — no HTTP handler, no reconciler tick — which is exactly
 * the class of stall that made RPCs time out while turns were being launched.
 */
async function getImageDockerfileHash(imageName: string, binary: string = 'docker'): Promise<string | null> {
  const inspect = spawn(
    [binary, 'image', 'inspect', imageName, '--format', `{{index .Config.Labels "${DOCKERFILE_HASH_LABEL}"}}`],
    { stdout: 'pipe', stderr: 'ignore' }
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(inspect.stdout).text(),
    inspect.exited,
  ]);

  if (exitCode !== 0) {
    return null;
  }

  const hash = stdout.trim();
  return hash || null;
}

/**
 * The input manifest an existing image was built from, or null when it cannot
 * be read (image missing, label absent because the image predates the label,
 * unparseable JSON). Null means "no opinion" — the caller degrades to a generic
 * "image inputs changed" message and never to a wrong one.
 */
async function getImageInputManifest(imageName: string, binary: string = 'docker'): Promise<ImageInputManifest | null> {
  const inspect = spawn(
    [binary, 'image', 'inspect', imageName, '--format', `{{index .Config.Labels "${IMAGE_INPUTS_LABEL}"}}`],
    { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(inspect.stdout).text(),
    inspect.exited,
  ]);
  if (exitCode !== 0) return null;

  const raw = stdout.trim();
  if (!raw || raw === '<no value>') return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ImageInputManifest;
  } catch {
    // The label is explanatory only — a malformed one must never fail a launch,
    // it just costs us the ability to name the file that changed.
    logger.debug(`Ignoring unparseable ${IMAGE_INPUTS_LABEL} label on ${imageName}`);
    return null;
  }
}

/**
 * When the image was built, per the container runtime, or null if it cannot be
 * determined (image missing, runtime hiccup, unparseable timestamp).
 *
 * Null means "no opinion" everywhere it is used: an unreadable timestamp must
 * never be treated as "infinitely old" and trigger a multi-minute rebuild on
 * every single container launch.
 *
 * Note this is the BUILD time of the underlying image, not of the tag —
 * `docker tag` does not touch it. That is what makes it usable as the freshness
 * signal: `lazy upgrade` promotes a freshly-BUILT image onto the tag, so the
 * timestamp genuinely advances there, while a re-tag of an old image does not
 * pretend to be fresh.
 */
async function getImageCreatedAt(imageName: string, binary: string = 'docker'): Promise<Date | null> {
  const inspect = spawn(
    [binary, 'image', 'inspect', imageName, '--format', '{{.Created}}'],
    { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(inspect.stdout).text(),
    inspect.exited,
  ]);
  if (exitCode !== 0) return null;

  const raw = stdout.trim();
  if (!raw) return null;
  const created = new Date(raw);
  return Number.isNaN(created.getTime()) ? null : created;
}

/**
 * Is a built image past its freshness window? See src/capture/image-tag.ts for
 * why age — not the version tag — is the axis that matters.
 */
export async function isImageTooOld(
  imageName: string,
  binary: string = 'docker',
): Promise<{ tooOld: boolean; ageDays: number | null }> {
  const created = await getImageCreatedAt(imageName, binary);
  if (!created) return { tooOld: false, ageDays: null };
  const ageMs = Date.now() - created.getTime();
  return { tooOld: ageMs > IMAGE_MAX_AGE_MS, ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)) };
}

/** What `lazy upgrade` should do about the container image. */
export interface UpgradeRebuildEvaluation {
  /**
   * `rebuild` — something about the image genuinely changed (or could not be
   * read), so there is nothing to ask about.
   * `ask` — the image on this host was built from exactly these inputs already.
   * Rebuilding would only re-resolve unpinned contents, which is a judgement
   * call, so the caller puts it to the human (and rebuilds when it cannot ask).
   */
  verdict: 'rebuild' | 'ask';
  /** Why, in words a human can act on. Printed either way. */
  reason: string;
  imageName: string;
  /** For `ask`: how long ago that identical build finished ("6 minutes"). */
  builtAgo?: string;
}

/**
 * Decide whether `lazy upgrade` has a REASON to rebuild the container image, or
 * only a judgement call to put to the human.
 *
 * `lazy upgrade --images` is the documented force-refresh and never comes here.
 *
 * There is deliberately no timer. An earlier revision skipped the rebuild when
 * an identical image had been built within the last hour, and an hour is an
 * arbitrary number that neither the output nor the docs could justify: an
 * upgrade minutes after `lazy upgrade --images` repeats a pointless multi-minute
 * build, while the same image at three days old may be exactly what you want
 * refreshed. Whether re-resolving the unpinned contents (the agent CLI, apt
 * packages, anything else the Dockerfile fetches) is worth the wait is the
 * human's call, and `ask` is how they get to make it — the age goes in the
 * question rather than into a threshold nobody can see.
 *
 * The age itself comes from the image's BUILD time (see getImageCreatedAt): a
 * `docker tag` does not advance it, so promoting an old image onto the tag can
 * never masquerade as a fresh build. Anything unreadable (image absent, runtime
 * hiccup, no identity label) answers `rebuild` — the safe direction, and the
 * same "null means no opinion" posture as the rest of this file.
 */
export async function evaluateUpgradeRebuild(
  lazyRoot: string,
  binary: string = 'docker',
): Promise<UpgradeRebuildEvaluation> {
  const imageName = await resolveImageName(lazyRoot);

  const builtHash = await getImageDockerfileHash(imageName, binary);
  if (!builtHash) {
    return { verdict: 'rebuild', reason: `${imageName} is not built on this host`, imageName };
  }

  const identity = await resolveImageIdentity(lazyRoot);
  if (builtHash !== identity.hash) {
    const previous = await getImageInputManifest(imageName, binary);
    const changed = describeInputChanges(previous, identity.manifest) ?? 'image inputs have changed';
    return { verdict: 'rebuild', reason: changed, imageName };
  }

  const created = await getImageCreatedAt(imageName, binary);
  if (!created) {
    return { verdict: 'rebuild', reason: 'the image build time could not be read', imageName };
  }

  const builtAgo = formatBuildAge(Date.now() - created.getTime());
  return {
    verdict: 'ask',
    reason:
      `${imageName} was built ${builtAgo} ago from these exact inputs — ` +
      `its Dockerfile and build inputs are unchanged since`,
    imageName,
    builtAgo,
  };
}

/** Coarse "N minutes/hours/days" for build-age messages. */
function formatBuildAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** One image built by lazy, as reported by `docker images`. */
export interface LazyImageInfo {
  /** Full reference, e.g. `lazy-runner:0.21`. */
  ref: string;
  repository: string;
  tag: string;
  /** Image ID — two refs with the same ID are two tags on one image. */
  id: string;
  /** Human-readable size string from the container runtime, e.g. `2.31GB`. */
  size: string;
}

/**
 * List existing Docker images with the lazy Dockerfile hash label.
 * Returns them sorted by creation date (most recent first), as docker does.
 */
export async function listLazyImages(binary: string = 'docker'): Promise<LazyImageInfo[]> {
  const proc = spawn(
    [binary, 'images', '--filter', `label=${DOCKERFILE_HASH_LABEL}`, '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}'],
    { stdout: 'pipe', stderr: 'ignore' }
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return [];

  const images: LazyImageInfo[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const [repository, tag, id, size] = line.split('\t');
    if (!repository || !tag || repository === '<none>' || tag === '<none>') continue;
    images.push({ ref: `${repository}:${tag}`, repository, tag, id: id ?? '', size: size ?? '' });
  }
  return images;
}

/**
 * Remove one lazy-built image by reference.
 *
 * Lives here, beside listLazyImages, so the only code that speaks `docker
 * image` for lazy's own images is this module — `lazy doctor
 * --clean-docker-images` calls this rather than composing its own runtime
 * command line. Returns the runtime's own message on failure (an image another
 * image depends on, or one a stopped container still references, cannot be
 * removed) so the caller can report WHICH image refused and why.
 */
export async function removeLazyImage(
  ref: string,
  binary: string = 'docker',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const proc = spawn([binary, 'image', 'rm', ref], { stdout: 'pipe', stderr: 'pipe' });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode === 0) return { ok: true };
  return { ok: false, error: stderr.trim() || `${binary} image rm exited ${exitCode}` };
}

/** Image references only — used by the offline fallback below. */
async function listExistingLazyImages(binary: string = 'docker'): Promise<string[]> {
  return (await listLazyImages(binary)).map(image => image.ref);
}

/**
 * Write Dockerfile content to a UNIQUE temp directory so `docker build -f`
 * has a real file to read. Unique per call (mkdtemp) so concurrent builds
 * cannot clobber each other's Dockerfile. Returns the temp dir and path;
 * callers that use project root as build context should pass only
 * `dockerfilePath` to docker and clean up `tempDir` themselves.
 */
async function writeDockerfileToTempDir(content: string): Promise<{ buildCwd: string; dockerfilePath: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'lazy-docker-build-'));
  const dockerfilePath = join(tempDir, 'Dockerfile');
  await writeFile(dockerfilePath, content);
  return { buildCwd: tempDir, dockerfilePath, tempDir };
}

/** How often to reassure the human that a quiet build is still running. */
const BUILD_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Consume a piped stream, echoing structural progress lines to the console and
 * everything to the log file. Returns the full text for error reporting.
 */
async function pumpBuildStream(
  stream: ReadableStream<Uint8Array>,
  label: string,
  onProgress: (line: string) => void,
  /** Every line, unfiltered — the daemon's per-build log (see ./build-observer.ts). */
  onEveryLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  let full = '';

  for await (const chunk of stream) {
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    full += text;
    buffered += text;
    const { lines, remainder } = splitLines(buffered);
    buffered = remainder;
    for (const line of lines) {
      logger.stream(`[build ${label}] ${line}`);
      onEveryLine?.(line);
      if (isBuildProgressLine(line)) onProgress(line.trim());
    }
  }

  if (buffered.length > 0) {
    logger.stream(`[build ${label}] ${buffered}`);
    onEveryLine?.(buffered);
    if (isBuildProgressLine(buffered)) onProgress(buffered.trim());
  }

  return full;
}

/**
 * Run `docker build` with the given parameters. Shared by the config-driven
 * builder (`buildImage`) and the explicit lazy-runner builder
 * (`buildLazyRunnerImage`).
 *
 * TIMEOUT POLICY — unbounded unless the caller explicitly asks for a bound.
 *
 * `docker build` has no timeout of its own, and neither should lazy. A build
 * killed on a timer wasted every second it ran and produced nothing, which is
 * strictly worse than one that runs long and succeeds. This chokepoint used to
 * hardcode 20 minutes (originally to escape the 60s `spawn` default), and that
 * cliff cost a real afternoon: the kill surfaced as a bare non-zero exit and
 * looked like Docker Desktop failing. Do not reinstate a default bound.
 *
 * `timeoutMs` is therefore 0 (unbounded) by default and only ever set from an
 * explicit `--timeout` flag. The timer is owned HERE rather than handed to
 * `spawn`, so that when it does fire we know for certain that lazy killed the
 * build and can say so instead of reporting an exit code.
 */
interface DockerBuildRequest {
  buildCwd: string;
  /** The `-f` path handed to docker — usually a temp snapshot, not human-meaningful. */
  dockerfilePath: string;
  tags: string[];
  identity: ImageIdentity;
  binary: string;
  noCache: boolean;
  /**
   * Where the Dockerfile really came from, in words a human can act on: an
   * absolute path, or "the embedded default Dockerfile". This is what the
   * announcement names — `dockerfilePath` is a temp copy and tells nobody
   * which Dockerfile governs.
   */
  source: string;
  /** Why this build is happening, when the caller knows. Named in the announcement. */
  reason?: string;
  /**
   * True when `source` is the PROJECT's Dockerfile (configured or the root
   * Dockerfile.lazy): only then does a failure tell the user to fix it.
   */
  projectDockerfile?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Mirrors build progress to whoever asked for this build (turn-launch display). */
  notify?: PhaseNotify;
  /** Extra image labels, e.g. {@link BASE_SOURCE_LABEL} on a default-image build. */
  labels?: Record<string, string>;
}

/** Lines of the failing step's own output shown on a build failure. */
const BUILD_FAILURE_STEP_LINES = 40;

/**
 * The part of a failed build's output the human needs. BuildKit (plain
 * progress, which it selects itself when stderr is not a TTY — as here, where
 * it is piped) prefixes every line with its step number
 * (`#50 12.3 error[E0308]: ...`) and ends with a Dockerfile excerpt and a
 * "failed to solve" line, so a plain tail shows only that boilerplate. Find the
 * step that ERRORed and return its last lines plus the ERROR line. Output with
 * no such step (the classic builder, or anything unparseable) falls back to
 * the plain last 10 lines.
 */
export function extractBuildFailureOutput(output: string): string {
  const lines = output.split('\n');
  const fallback = () => lines.slice(-10).join('\n');
  let errorIdx = -1;
  let step = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^#(\d+) ERROR\b/.exec(lines[i]);
    if (m) { errorIdx = i; step = m[1]; break; }
  }
  if (errorIdx < 0) return fallback();
  const prefix = `#${step} `;
  const stepLines = lines
    .slice(0, errorIdx)
    .filter(l => l.startsWith(prefix))
    .map(l => l.slice(prefix.length))
    // BuildKit's own status lines, not the step's output.
    .filter(l => !/^(\d+(\.\d+)?\s+)?(DONE|CACHED)\b/.test(l));
  if (stepLines.length === 0) return fallback();
  return [...stepLines.slice(-BUILD_FAILURE_STEP_LINES), lines[errorIdx]].join('\n');
}

/**
 * `source` is the human-meaningful Dockerfile description runDockerBuild
 * already holds (never the temp snapshot); for an adopted or consented worktree
 * Dockerfile it already carries the build context. The message reaches the
 * Teams "could not be started" page verbatim.
 */
export function buildFailureMessage(exitCode: number, stdout: string, stderr: string, source?: string): string {
  const output = stderr.trim() || stdout.trim();
  const detail = output ? extractBuildFailureOutput(output).trim() : 'The container builder produced no output.';
  const what = source ? `\nBuilding: ${source}` : '';
  return `Container build failed with exit code ${exitCode}${what}\n\nLast output:\n${detail}`;
}

/**
 * A build docker ran to a non-zero exit. `output` is what it printed; `message`
 * carries the "fix that Dockerfile" pointer, `bare` does not (a lost connection
 * is never the Dockerfile's fault).
 */
class ContainerBuildFailed extends Error {
  constructor(message: string, readonly bare: string, readonly output: string) { super(message); }
}

/**
 * Every container build in lazy. On a Teams microVM a build whose client lost
 * its connection to BuildKit (`error reading from server: EOF`) is diagnosed —
 * dockerd brought back if it died, what the machine recorded read — and retried
 * ONCE when dockerd answers again; a final failure leads with the likely cause
 * instead of only BuildKit's EOF (src/daemon/build-connection-lost.ts).
 */
async function runDockerBuild(request: DockerBuildRequest): Promise<{ output: string }> {
  const lostConnection = (err: unknown): err is ContainerBuildFailed =>
    err instanceof ContainerBuildFailed && isBuildConnectionLost(err.output);
  const diagnose = async (err: ContainerBuildFailed, since: Date) => {
    try {
      return await diagnoseLostBuildConnection(since, undefined, request.signal ?? currentBuildObserver()?.signal);
    } catch (diagErr) {
      // The check failing must never replace the build's own error.
      const why = diagErr instanceof Error ? diagErr.message : String(diagErr);
      throw new Error(`${LOST_CONNECTION_HEADLINE}; lazy could not check what happened: ${why}\n\n${err.bare}`);
    }
  };
  const startedAt = new Date();
  try {
    return await runDockerBuildOnce(request);
  } catch (err) {
    if (!lostConnection(err) || request.binary !== 'docker' || !guestDockerdSupervised()) throw err;
    const first = await diagnose(err, startedAt);
    if (!first.retryable) throw new Error(`${first.headline}\n\n${first.explanation}\n\n${err.bare}`);
    const note = `${first.headline} ${first.explanation} Docker answers again; retrying the build once.`;
    logger.warn(note);
    // The image-build job's log reads narration through notify; a build with
    // no notify still shows the retry in the job log through its observer.
    if (request.notify) request.notify(note);
    else currentBuildObserver()?.onLine(request.tags[0], note);
    const retryStartedAt = new Date();
    try {
      return await runDockerBuildOnce(request);
    } catch (again) {
      if (!lostConnection(again)) throw again;
      const second = await diagnose(again, retryStartedAt);
      throw new Error(
        `${second.headline} It happened twice in a row (lazy retried once).\n\n${second.explanation}\n\n${again.bare}`,
      );
    }
  }
}

/** Every container build lazy runs passes here: counted while it runs, reported when it succeeds (src/capture/build-observer.ts). */
function runDockerBuildOnce(request: DockerBuildRequest): Promise<{ output: string }> {
  return trackContainerBuild(request.tags[0], () => runDockerBuildUntracked(request));
}

async function runDockerBuildUntracked(request: DockerBuildRequest): Promise<{ output: string }> {
  const { buildCwd, dockerfilePath, tags, identity, binary, noCache, source, reason, notify } = request;
  // A daemon image build (src/daemon/image-build-job.ts) watches every build in
  // its async context: it gets every line, and its signal is how Cancel stops
  // the docker client. An explicit request signal still wins.
  const observer = currentBuildObserver();
  const signal = request.signal ?? observer?.signal;
  const timeoutMs = request.timeoutMs ?? 0;
  if (signal?.aborted) throw new Error('Container build cancelled before it started');
  observer?.onBuildStart?.(tags[0], source);
  const observe = observer ? (line: string) => observer.onLine(tags[0], line) : undefined;

  const startedAt = Date.now();

  // ONE announcement for every container build in lazy, at the layer that
  // actually runs docker — callers used to each print their own, which is how a
  // daemon log ended up streaming hundreds of build lines with nothing saying
  // what was being built. Info level: a multi-minute build is never debug noise.
  const extraTags = tags.slice(1);
  logger.info(
    `Building container image ${tags[0]} from ${source}` +
    (reason ? ` — ${reason}` : '') +
    (noCache ? ' [--no-cache]' : '') +
    ' (this can take several minutes).' +
    (extraTags.length > 0 ? ` Also tagged ${extraTags.join(', ')}.` : ''),
  );
  const tagArgs = tags.flatMap(tag => ['-t', tag]);
  const proc = spawn(
    [
      binary, 'build', ...(noCache ? ['--no-cache'] : []), ...tagArgs,
      '--label', `${DOCKERFILE_HASH_LABEL}=${identity.hash}`,
      '--label', `${IMAGE_INPUTS_LABEL}=${JSON.stringify(identity.manifest)}`,
      ...Object.entries(request.labels ?? {}).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      '-f', dockerfilePath, '.',
    ],
    // timeout: 0 disables spawn()'s own kill timer. Any bound is armed below.
    { cwd: buildCwd, stdout: 'pipe', stderr: 'pipe', timeout: 0 }
  );

  // Cancellation (`lazy upgrade` aborted while its background rebuild is still
  // running): kill the client. Layers already built stay in the runtime's build
  // cache, so a later upgrade is warm rather than starting from scratch.
  const onAbort = () => { try { proc.kill(); } catch { /* already exited */ } };
  signal?.addEventListener('abort', onAbort, { once: true });

  let timedOut = false;
  const killTimer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch { /* already exited */ }
      }, timeoutMs)
    : null;

  // Progress. Docker writes BuildKit progress to stderr and the classic
  // builder writes steps to stdout, so both are echoed. A heartbeat covers the
  // long silent stretches inside a single step (a big apt or npm download).
  let lastOutputAt = Date.now();
  // The same lines the daemon log gets, mirrored to whoever asked for this
  // build. Throttled: BuildKit emits a line per layer step and the caller is a
  // network connection, not a log file. See throttleNotes.
  const noteBuild = throttleNotes(notify);
  const echo = (line: string) => {
    lastOutputAt = Date.now();
    logger.info(`  ${line}`);
    noteBuild(`building ${tags[0]}: ${line}`);
  };
  const heartbeat = setInterval(() => {
    if (Date.now() - lastOutputAt >= BUILD_HEARTBEAT_INTERVAL_MS) {
      lastOutputAt = Date.now();
      const still = `still building ${tags[0]}... (${formatDuration(Date.now() - startedAt)} elapsed)`;
      logger.info(`  ${still}`);
      // Forced: a heartbeat exists precisely because nothing else is arriving,
      // so it must never be the thing the throttle drops.
      noteBuild(still, true);
    }
  }, BUILD_HEARTBEAT_INTERVAL_MS);

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      // Both streams carry the SAME build's progress (BuildKit writes to
      // stderr, the classic builder to stdout), so both are labelled with the
      // image ref rather than 'out'/'err' — `[build err]` read as an error
      // stream and told nobody which image the lines belonged to.
      pumpBuildStream(proc.stdout as ReadableStream<Uint8Array>, tags[0], echo, observe),
      pumpBuildStream(proc.stderr as ReadableStream<Uint8Array>, tags[0], echo, observe),
      proc.exited,
    ]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
    clearInterval(heartbeat);
  }

  if (signal?.aborted) {
    observer?.onBuildEnd?.(tags[0], 'cancelled');
    throw new Error('Container build cancelled');
  }
  const ended = !timedOut && exitCode === 0 ? 'succeeded'
    : !timedOut && isBuildConnectionLost(`${stdout}\n${stderr}`) ? 'connection-lost' : 'failed';
  observer?.onBuildEnd?.(tags[0], ended);

  if (timedOut) {
    const message = buildTimeoutMessage(Date.now() - startedAt, timeoutMs);
    logger.error(message);
    throw new Error(message);
  }

  if (exitCode !== 0) {
    const output = `${stdout}\n${stderr}`;
    const bare = buildFailureMessage(exitCode, stdout, stderr, source);
    // Only a PROJECT Dockerfile gets "fix it" — never lazy's own default, and
    // never a build that lost its connection to Docker, which no Dockerfile edit fixes.
    const pointer = request.projectDockerfile && !isBuildConnectionLost(output) ? '\n\nFix that Dockerfile and relaunch.' : '';
    const message = bare + pointer;
    logger.error(message);
    throw new ContainerBuildFailed(message, bare, output);
  }

  logger.info(
    `Built container image ${tags[0]} from ${source} in ${formatDuration(Date.now() - startedAt)}.`,
  );
  return { output: `${stdout}${stderr}` };
}

async function buildImage(lazyRoot: string, repository: string, identity: ImageIdentity, binary: string = 'docker', noCache: boolean = false, timeoutMs: number = 0, reason?: string, notify?: PhaseNotify, forceDefault: boolean = false): Promise<void> {
  await buildImageWithTags(lazyRoot, localBuildTagsFor(repository), identity, binary, noCache, undefined, timeoutMs, reason, notify, forceDefault);
}

/** Does the container runtime have this image locally? */
async function imageExists(ref: string, binary: string = 'docker'): Promise<boolean> {
  const proc = spawn(
    [binary, 'image', 'inspect', ref, '--format', '{{.Id}}'],
    { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
  );
  return (await proc.exited) === 0;
}

/**
 * Public alias of the local-image probe — used by the worktree-image offer to
 * decide whether an existing pin is still present (skip re-prompt) or was
 * pruned (offer rebuild).
 */
export async function localImageExists(ref: string, binary: string = 'docker'): Promise<boolean> {
  return imageExists(ref, binary);
}

/**
 * Build a content-addressed `lazy-custom-<hash>` image from an absolute
 * Dockerfile path — without going through `resolveCustomDockerfile` / the
 * upgrade-build latch.
 *
 * Used when a human consents (TTY prompt) to pin a worktree Dockerfile on a
 * task. The build context is THAT DOCKERFILE'S OWN DIRECTORY — the worktree the
 * human was standing in — never the project root, whose tree belongs to a
 * different branch and would resolve the Dockerfile's COPY paths against the
 * wrong files. `.dockerignore`, submodules and LFS behave exactly as they do in
 * that checkout; lazy does nothing special with any of them.
 *
 * The consented bytes are read ONCE, hashed, and built from a temp copy that
 * `-f` points at, so a write to the worktree file between hash and build cannot
 * change what docker reads (hash/build TOCTOU). The rest of the context is the
 * live directory, which is what "build this worktree" means.
 *
 * The image name covers the Dockerfile bytes AND the context directory, so the
 * same Dockerfile in two worktrees cannot share one image — see
 * {@link consentedBuildIdentity}.
 *
 * Do NOT use this to auto-resolve from a worktree — that would let agent-writable
 * branches drive host docker builds. The caller must have already gotten
 * human consent.
 */
export async function buildImageFromDockerfilePath(
  lazyRoot: string,
  dockerfilePath: string,
  options: {
    binary?: string;
    noCache?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ imageName: string; contentHash: string; contextDir: string }> {
  const binary = options.binary ?? 'docker';
  await checkDocker(binary);

  const absPath = isAbsolute(dockerfilePath) ? dockerfilePath : join(lazyRoot, dockerfilePath);
  if (!existsSync(absPath)) {
    throw new Error(
      `Cannot build custom image: Dockerfile not found at ${absPath}.`,
    );
  }

  // Capture consented bytes once — hash and build must agree on the same text.
  const content = await readFile(absPath, 'utf-8');
  const contentHash = createHash('sha256').update(content).digest('hex');

  const contextDir = dirname(absPath);
  // Content alone is not the identity: the same Dockerfile against a different
  // tree is a different image.
  const shortHash = consentedBuildIdentity(contentHash, contextDir).substring(0, 12);
  const repository = `lazy-custom-${shortHash}`;
  const imageName = `${repository}:${IMAGE_TAG}`;
  const tags = buildTagsFor(repository);

  // A consented worktree Dockerfile bypasses lazy.toml entirely, so its image
  // identity is that Dockerfile alone — never the project's `build_inputs`,
  // which belong to the root image. Same shape as `buildLazyRunnerImage`.
  const manifest: ImageInputManifest = { [DOCKERFILE_INPUT_KEY]: contentHash.substring(0, 16) };
  const identity: ImageIdentity = { hash: hashManifest(manifest), manifest };

  // Same FROM-lazy-runner preflight as the root custom-image path.
  const baseUsage = analyzeLazyBaseUsage(content, IMAGE_NAME, buildTagsFor(IMAGE_NAME));
  await ensureLazyBaseImage(lazyRoot, baseUsage, absPath, binary, options.timeoutMs ?? 0);

  // Build from a temp copy of the consented bytes, with the worktree as context.
  const snap = await writeDockerfileToTempDir(content);
  try {
    await runDockerBuild({
      // The context is the worktree directory holding the consented Dockerfile
      // — never the project root, whose tree is a different branch and would
      // resolve the Dockerfile's COPY paths against the wrong files.
      buildCwd: contextDir,
      dockerfilePath: snap.dockerfilePath,
      tags,
      identity,
      binary,
      noCache: options.noCache ?? false,
      // Names the context in the one build announcement runDockerBuild makes,
      // rather than logging a second line here.
      source: `${absPath} (consented Dockerfile, context ${contextDir})`,
      reason: 'building the image you consented to pin',
      timeoutMs: options.timeoutMs ?? 0,
    });
  } catch (err) {
    if (baseUsage.unbuildable.length > 0) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${detail}\n${unbuildableBaseRemedy(absPath, baseUsage.unbuildable)}`);
    }
    throw err;
  }

  return { imageName, contentHash, contextDir };
}

/**
 * The remedy for a custom build that died on a lazy base ref lazy cannot supply.
 * A per-agent `lazy-runner-<agent>` ref gets its own line: those images are no
 * longer produced, because `lazy-runner` now carries every agent CLI.
 */
function unbuildableBaseRemedy(dockerfile: string, unbuildable: string[]): string {
  const agentVariants = unbuildable.filter(ref => ref.startsWith(`${IMAGE_NAME}-`));
  if (agentVariants.length > 0) {
    return (
      `${dockerfile} builds FROM ${agentVariants.join(', ')} — per-agent runner images are no longer produced: ` +
      `${IMAGE_NAME} now carries every agent CLI. Change the FROM line to \`FROM ${IMAGE_NAME}\`.`
    );
  }
  return (
    `${dockerfile} builds FROM ${unbuildable.join(', ')} — a lazy base image tag that no lazy build writes. ` +
    `Use \`FROM ${IMAGE_NAME}\`, or build the base first: \`lazy system build lazy-runner\`.`
  );
}

/**
 * Build the base runner image first when a custom Dockerfile builds FROM it and
 * it is missing locally.
 *
 * The bare name `lazy-runner` resolves on no registry, so it has to be put in
 * the local store: pulled from the release (`ghcr.io/getlazy/lazy-runner`) and
 * re-tagged, or built here when there is nothing to pull. Without this, `docker build` on a `FROM lazy-runner` Dockerfile with no local base
 * treats the name as a Docker Hub repository and dies with "pull access denied,
 * repository does not exist", which points at nothing. That is the exact failure
 * a fresh install hits: the version tag (src/capture/image-tag.ts) forces a
 * custom-image rebuild after a minor bump, and on a machine that never built the
 * base — or pruned it — the rebuild has nothing to layer on.
 *
 * ONLY-WHEN-MISSING, deliberately. This is not a second freshness mechanism:
 * `ensureImage`'s own triggers (upgrade / age / Dockerfile hash) govern how
 * fresh the base image stays for the projects that run it directly. Rebuilding
 * an existing base here would add a multi-minute build to a path whose job is to
 * build something else.
 */
async function ensureLazyBaseImage(
  lazyRoot: string,
  usage: LazyBaseUsage,
  dockerfilePath: string,
  binary: string,
  timeoutMs: number,
  notify?: PhaseNotify,
): Promise<void> {
  if (usage.buildable.length === 0) return;
  // Under the same per-image lock `ensureImage` takes for the default image, and
  // re-checked inside it: the daemon's boot build prepares the default image
  // and the custom one at once, and without the lock both would build
  // lazy-runner side by side.
  await imageBuildMutex.withLock(`${IMAGE_NAME}:${IMAGE_TAG}`, () =>
    ensureLazyBaseImageLocked(lazyRoot, usage, dockerfilePath, binary, timeoutMs, notify));
}

async function ensureLazyBaseImageLocked(
  lazyRoot: string,
  usage: LazyBaseUsage,
  dockerfilePath: string,
  binary: string,
  timeoutMs: number,
  notify?: PhaseNotify,
): Promise<void> {
  const missing: string[] = [];
  for (const ref of usage.buildable) {
    if (!(await imageExists(ref, binary))) missing.push(ref);
  }
  if (missing.length === 0) return;

  // Pull the release's image first; building is the fallback.
  const pull = await pullPublishedRunner(lazyRoot, defaultRunnerIdentity(), buildTagsFor(IMAGE_NAME), binary, notify);
  if (pull.pulled) return;

  logger.info(
    `Base image ${missing.join(', ')} not found — building it first, because ${dockerfilePath} builds FROM it ` +
    `(this can take several minutes).`
  );

  try {
    // No --no-cache: the image is absent, so there is nothing stale to bust, and
    // a warm build cache is the difference between seconds and minutes here.
    notify?.(`building the base image ${IMAGE_NAME} first`);
    await buildLazyRunnerImage({ binary, timeoutMs, notify });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to build the base image ${IMAGE_NAME}, which ${dockerfilePath} builds FROM: ${detail}\n` +
      `Build it on its own to see the full output, then retry: \`lazy system build lazy-runner\`` +
      (pull.why ? `\n(Built locally because ${pull.why}.)` : '')
    );
  }
}

/**
 * Build the project's resolved image (custom Dockerfile or the embedded
 * default) and write it under the given tags.
 *
 * Split out of `buildImage` so a caller can build the SAME image content under
 * a tag that is not the canonical one — `lazy upgrade` builds to a staging tag
 * while the human is still deciding, and only moves the canonical tag once they
 * have said go (see src/upgrade/background-image-build.ts).
 */
async function buildImageWithTags(
  lazyRoot: string,
  tags: string[],
  identity: ImageIdentity,
  binary: string = 'docker',
  noCache: boolean = false,
  signal?: AbortSignal,
  timeoutMs: number = 0,
  reason?: string,
  notify?: PhaseNotify,
  /** Build lazy's default runner image even though a custom one is configured. */
  forceDefault: boolean = false,
): Promise<void> {
  const customPath = forceDefault ? null : await resolveCustomDockerfile(lazyRoot);

  let buildCwd: string;
  let dockerfileName: string;
  let source: string;
  let baseUsage: LazyBaseUsage | null = null;
  let labels: Record<string, string> | undefined;

  if (customPath) {
    // Name the Dockerfile in the announcement: from a worktree it is genuinely
    // ambiguous which copy governs, and a wrong one once cost a whole session.
    // The log line for this is emitted once, by runDockerBuild. The phase note
    // is not a log line — it goes to whoever is watching this turn launch.
    notify?.(`building ${tags[0]} from ${describeDockerfileSource(customPath)}`);
    // Read once and build from a temp copy so a concurrent write to customPath
    // cannot change what docker sees after we hashed (hash/build TOCTOU). For
    // adoption, customPath is already the daemon snapshot; the extra copy is
    // still correct.
    const content = await readFile(customPath, 'utf-8');

    // An ADOPTED worktree Dockerfile builds against the WORKTREE the human
    // consented to — its COPY paths name files on that branch, which the
    // project root does not have. The plain `[docker].dockerfile` path keeps
    // the project root as its context: it lives at the root and describes the
    // root's tree.
    const adoptedContext = await adoptedBuildContextRoot(lazyRoot, customPath);
    buildCwd = adoptedContext ?? lazyRoot;
    // The single build announcement runDockerBuild makes names `source`, so the
    // context rides along there rather than in a second log line of our own.
    source = adoptedContext
      ? `${customPath} (context ${adoptedContext})`
      : describeDockerfileSource(customPath);
    // Temp dirs are unique (mkdtemp) under the OS temp dir — outside every
    // worktree — and left in place so the `-f` path stays inspectable.
    const snap = await writeDockerfileToTempDir(content);
    dockerfileName = snap.dockerfilePath;

    // A custom Dockerfile is the only thing that can build FROM lazy's own base
    // image; the default one IS the base. Make sure that base exists before
    // docker tries — and fails — to pull it from a registry.
    baseUsage = analyzeLazyBaseUsage(
      content,
      IMAGE_NAME,
      buildTagsFor(IMAGE_NAME),
    );
    await ensureLazyBaseImage(lazyRoot, baseUsage, describeDockerfileSource(customPath), binary, timeoutMs, notify);
  } else {
    source = 'the embedded default Dockerfile';
    notify?.(`building ${tags[0]} from the default Dockerfile`);
    // Write the resolved Dockerfile to a temp directory for the build.
    // Never use the project's own Dockerfile — it's for the project, not agents.
    const { content } = await getDockerfileContent(lazyRoot, forceDefault);
    const temp = await writeDockerfileToTempDir(content);
    buildCwd = temp.buildCwd;
    dockerfileName = temp.dockerfilePath;
    labels = LOCAL_BASE_LABELS;
  }

  try {
    await runDockerBuild({
      buildCwd,
      dockerfilePath: dockerfileName,
      tags,
      identity,
      binary,
      noCache,
      source,
      projectDockerfile: customPath !== null,
      reason,
      signal,
      timeoutMs,
      notify,
      labels,
    });
    await selfcheckImage(tags[0], binary);
  } catch (err) {
    // The base refs lazy could NOT supply itself (an agent-suffixed repository,
    // or a base pinned to a tag no base build writes — see
    // src/capture/dockerfile-base.ts). If the build died on one of those, docker
    // reported a registry error for an image that lives on no registry, so name
    // the real remedy rather than leaving that as the last word.
    if (baseUsage && baseUsage.unbuildable.length > 0) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${detail}\n${unbuildableBaseRemedy(dockerfileName, baseUsage.unbuildable)}`);
    }
    throw err;
  }
}

/**
 * The image does not embed lazy-agent — it is bind-mounted at launch from a
 * content-addressed install in ~/.lazy/bin. When that file is a bare Bun
 * runtime, tagging a fresh image still strands every builder; prove the mount
 * works before a tag moves (skipped when no verified agent binary exists yet).
 */
async function selfcheckImage(ref: string, binary: string): Promise<void> {
  const binDir = join(getHome(), '.lazy', 'bin');
  const agentBinaryPath = (await resolveInstalledAgentBinary(binDir)) ?? agentBinaryPointerPath(binDir);
  await assertAgentBinarySelfcheckForImage(ref, agentBinaryPath, binary);
}

/**
 * The canonical tags a build of THIS project's image writes — the version tag,
 * plus, for the base runner repository, the `:latest` alias and the published
 * content ref (so an upgrade whose pull missed still leaves the local build
 * wearing the ref a `FROM ghcr.io/getlazy/lazy-runner:sha-…` names).
 *
 * `lazy upgrade` needs these separately from the build itself: it builds to a
 * staging tag first and promotes onto exactly these refs afterwards, so a
 * cancelled upgrade leaves every canonical tag pointing where it did before.
 */
export async function resolveImageBuildTags(lazyRoot: string): Promise<string[]> {
  const { repository } = await resolveImageRepository(lazyRoot);
  return localBuildTagsFor(repository);
}

/**
 * Build the project's image under a caller-chosen TAG of its own repository
 * (e.g. `lazy-runner:0.21-upgrade`), leaving the canonical tags untouched.
 *
 * Always builds — no hash short-circuit — because the only caller is an
 * explicit force-rebuild. Returns the full ref that was written.
 */
export async function buildProjectImageToTag(
  lazyRoot: string,
  tag: string,
  options: { binary?: string; noCache?: boolean; signal?: AbortSignal; timeoutMs?: number; reason?: string } = {},
): Promise<string> {
  const binary = options.binary ?? 'docker';
  await checkDocker(binary);

  const { repository } = await resolveImageRepository(lazyRoot);
  const ref = `${repository}:${tag}`;
  const identity = await resolveImageIdentity(lazyRoot);
  // An upgrade to a release promotes that release's published image rather than
  // building one (docs/design/published-runner-image.md §4). The upgrade always
  // asks for --no-cache, but that exists to re-fetch unpinned CLIs in a LOCAL
  // build. A published image pins them to its release (engineer decision
  // 2026-09-27), so the pull comes first and --no-cache applies only to the
  // local fallback.
  const pull: RunnerPullOutcome = repository === IMAGE_NAME
    ? await pullPublishedRunner(lazyRoot, identity, [ref], binary)
    : { pulled: false, why: null };
  if (pull.pulled) return ref;
  try {
    await buildImageWithTags(
    lazyRoot,
    [ref],
    identity,
    binary,
    options.noCache ?? false,
    options.signal,
    options.timeoutMs ?? 0,
    options.reason ?? '`lazy upgrade` refreshing the image',
    );
  } catch (err) {
    throw withPullReason(err, pull);
  }
  return ref;
}

/**
 * Build a Dockerfile that is NOT (yet) the project's — a candidate a person
 * has asked about — from a lazy-owned snapshot with an explicit build context.
 * One caller today:
 *
 * - a ref ADOPTION (src/daemon/image-adoption.ts) builds under the canonical
 *   `lazy-custom-<hash>` tag the project will resolve once the adoption is
 *   recorded, with the identity labels `ensureImage` checks, so the image is
 *   current the moment it becomes the project's;
 * - (the TRY-BUILD tool deliberately does NOT use this: it must never touch
 *   the daemon's default builder or its cache — src/daemon/image-try-build.ts.)
 *
 * Returns the first tag and the build's combined output.
 */
export async function buildDockerfileCandidate(
  lazyRoot: string,
  options: {
    dockerfilePath: string;
    contextDir: string;
    source: string;
    binary?: string;
    tags?: string[];
    timeoutMs?: number;
    notify?: PhaseNotify;
    /** Prove the image can run lazy's agent before reporting success (adoption). */
    selfcheck?: boolean;
  },
): Promise<{ imageName: string; output: string }> {
  const binary = options.binary ?? 'docker';
  await checkDocker(binary);
  const content = await readFile(options.dockerfilePath, 'utf-8');
  const repository = `lazy-custom-${createHash('sha256').update(content).digest('hex').substring(0, 12)}`;
  const tags = options.tags ?? buildTagsFor(repository);
  const manifest = await manifestForDockerfileContent(lazyRoot, content);
  const identity: ImageIdentity = { hash: hashManifest(manifest), manifest };
  const baseUsage = analyzeLazyBaseUsage(content, IMAGE_NAME, buildTagsFor(IMAGE_NAME));
  await ensureLazyBaseImage(lazyRoot, baseUsage, options.source, binary, options.timeoutMs ?? 0, options.notify);
  const snap = await writeDockerfileToTempDir(content);
  return imageBuildMutex.withLock(tags[0], async () => {
    const { output } = await runDockerBuild({
      buildCwd: options.contextDir,
      dockerfilePath: snap.dockerfilePath,
      tags,
      identity,
      binary,
      noCache: false,
      source: options.source,
      projectDockerfile: true,
      timeoutMs: options.timeoutMs ?? 0,
      notify: options.notify,
    });
    if (options.selfcheck) {
      const binDir = join(getHome(), '.lazy', 'bin');
      const agentBinaryPath = (await resolveInstalledAgentBinary(binDir)) ?? agentBinaryPointerPath(binDir);
      await assertAgentBinarySelfcheckForImage(tags[0], agentBinaryPath, binary);
    }
    return { imageName: tags[0], output };
  });
}

/**
 * The lazy base images (`FROM lazy-runner…`) a Dockerfile builds from, made
 * present in the local image store first — lazy's own images, built by lazy.
 * Returns the refs, so an ISOLATED builder (the try-build's, which cannot see
 * the local image store) can be handed them as named build contexts.
 */
export async function prepareLazyBaseRefs(
  lazyRoot: string,
  content: string,
  source: string,
  binary: string,
  notify?: PhaseNotify,
): Promise<{ buildable: string[]; unbuildable: string[] }> {
  const usage = analyzeLazyBaseUsage(content, IMAGE_NAME, buildTagsFor(IMAGE_NAME));
  await ensureLazyBaseImage(lazyRoot, usage, source, binary, 0, notify);
  return { buildable: usage.buildable, unbuildable: usage.unbuildable };
}

/** Point additional refs at an existing image. Fails hard — no silent skip. */
export async function tagImage(sourceRef: string, targetRefs: string[], binary: string = 'docker'): Promise<void> {
  for (const target of targetRefs) {
    if (target === sourceRef) continue;
    const proc = spawn([binary, 'tag', sourceRef, target], { stdout: 'ignore', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      throw new Error(`Failed to tag ${sourceRef} as ${target}: ${stderr.trim() || `exit code ${exitCode}`}`);
    }
  }
}

/**
 * Drop a tag from an image. Best-effort by design: this only ever removes a
 * staging alias whose layers are also reachable through the canonical tag or
 * the build cache, so a failure here is cosmetic and must not fail an upgrade
 * that has otherwise succeeded. Returns whether the tag is gone.
 */
export async function removeImageTag(ref: string, binary: string = 'docker'): Promise<boolean> {
  const proc = spawn([binary, 'rmi', ref], { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS });
  return (await proc.exited) === 0;
}

/**
 * Build the base lazy-runner image explicitly, bypassing all lazy.toml
 * configuration. Used by `lazy system build lazy-runner` so custom Dockerfiles
 * that layer on top of the base image (`FROM lazy-runner`) have something to
 * build from on a fresh machine.
 *
 * Unlike `ensureImage`, this always builds — it does not check whether the
 * image already exists or whether the Dockerfile hash has changed.
 *
 * Returns every tag written: the version tag first, then the `:latest` alias.
 */
export async function buildLazyRunnerImage(options: { binary?: string; noCache?: boolean; timeoutMs?: number; notify?: PhaseNotify } = {}): Promise<string[]> {
  const binary = options.binary ?? 'docker';
  const noCache = options.noCache ?? false;

  await checkDocker(binary);

  const tags = localBuildTagsFor(IMAGE_NAME);

  // The BASE image bypasses lazy.toml entirely (that is this function's whole
  // point), so its identity is the embedded Dockerfile alone — never the
  // project's `build_inputs`, which belong to the custom image layered on top.
  const { buildCwd, dockerfilePath } = await writeDockerfileToTempDir(DEFAULT_DOCKERFILE);
  await runDockerBuild({
    buildCwd,
    dockerfilePath,
    tags,
    identity: defaultRunnerIdentity(),
    labels: LOCAL_BASE_LABELS,
    binary,
    noCache,
    source: 'the embedded default Dockerfile',
    reason: `base image ${IMAGE_NAME} requested explicitly`,
    timeoutMs: options.timeoutMs ?? 0,
    notify: options.notify,
  });

  return tags;
}

/**
 * Ensure the Docker image is built and up to date.
 * Returns the image name to use for container creation.
 *
 * When offline and the build fails (e.g., can't pull base images), falls back
 * to an existing lazy image if one is available. This lets users work offline
 * with a previously-built image even if the Dockerfile has changed.
 */
export async function ensureImage(
  binary: string = 'docker',
  options?: EnsureImageOptions,
): Promise<string> {
  // ONE resolution per launch: the identity hash and the build below both ask
  // resolveCustomDockerfile, and without the pin an accept landing between the
  // two could tag one committed version's hash on an image built from another.
  if (dockerfilePin.getStore()) return ensureImageResolved(binary, options);
  return dockerfilePin.run({ resolved: null }, () => ensureImageResolved(binary, options));
}

type EnsureImageOptions = {
    noCache?: boolean;
    timeoutMs?: number;
    /**
     * Task-pinned image (metadata.custom_image). When set, use it if present
     * locally; if missing, FAIL LOUDLY — never fall back to root or adoption.
     * `DEFAULT_RUNNER_IMAGE_PIN` (a person's recorded default-image choice)
     * sits at this same level: lazy's default image, ahead of any adoption.
     * Resolution order: (1) this pin, (2) daemon-adopted imageName soft-pin
     * on launches, (3) root [docker].dockerfile (or adopted path during an
     * explicit upgrade build with the upgrade-build latch on).
     */
    pinnedImage?: string;
    /**
     * Narration sink. Image resolution is the slowest thing a turn launch does
     * — a cold `docker build` is minutes — and until this existed all of it
     * went to the daemon log, where the human waiting on the CLI never saw it.
     */
    notify?: PhaseNotify;
    /**
     * Run on lazy's DEFAULT runner image even though the project configures a
     * custom one. Only ever set from an explicit, recorded choice (a person
     * confirmed it for a task, or a builder started while the custom image was
     * not ready and says so in a banner) — never as a silent fallback.
     */
    useDefaultImage?: boolean;
    /**
     * The daemon's own boot build of the custom image. Every other caller in
     * the daemon goes through the custom-image gate.
     */
    bypassGate?: boolean;
    /**
     * Build even when the image is up to date — a project admin's explicit
     * Rebuild (src/daemon/runner-image.ts). Only ever with `bypassGate`, or with
     * `useDefaultImage` for a Rebuild of lazy's default image.
     */
    rebuild?: boolean;
};

async function ensureImageResolved(binary: string, options?: EnsureImageOptions): Promise<string> {
  const notify = options?.notify;
  notify?.('resolving container image');
  await checkDocker(binary);

  // Resolution order: task pin (a consented custom_image, or the person's
  // recorded default-image choice) → daemon adoption soft-pin (launches) →
  // root. A missing pin must not silently degrade mid-task.
  if (options?.pinnedImage === DEFAULT_RUNNER_IMAGE_PIN || options?.pinnedImage === READONLY_DEFAULT_RUNNER_IMAGE_PIN) {
    return ensureImage(binary, { ...options, pinnedImage: undefined, useDefaultImage: true });
  }
  if (options?.pinnedImage) {
    if (await imageExists(options.pinnedImage, binary)) {
      logger.debug(`Using task-pinned container image ${options.pinnedImage}`);
      notify?.(`using task-pinned image ${options.pinnedImage}`);
      return options.pinnedImage;
    }
    // Lazy import avoids a load-time cycle (worktree-image imports this module).
    const { missingPinnedImageMessage } = await import('../docker/worktree-image');
    throw new Error(missingPinnedImageMessage(options.pinnedImage));
  }

  const lazyRoot = getLazyRoot();

  // Part 2 soft-pin: on routine launches (upgrade-build latch OFF), use the
  // consented imageName directly — never re-hash / rebuild from dockerfilePath,
  // or a post-consent agent edit of the worktree Dockerfile would become host
  // docker build steps. Upgrade builds leave the latch ON and fall through
  // to resolveCustomDockerfile, which may return the adopted path.
  // A person's explicit choice of lazy's DEFAULT image (the default-image pin)
  // is not overridden by an adoption either: it means the default image.
  if (!upgradeImageBuildEnabled && !options?.useDefaultImage) {
    const { loadValidAdoptedImage, missingAdoptedImageMessage } = await import('../daemon/adopted-image');
    const adopted = await loadValidAdoptedImage(lazyRoot);
    // A ref adoption is not soft-pinned: it resolves as the project's custom
    // Dockerfile (resolveCustomDockerfile) and goes through the boot build's
    // gate below exactly like the root file.
    if (adopted && adopted.source?.kind !== 'ref') {
      if (await imageExists(adopted.imageName, binary)) {
        logger.debug(`Using daemon-adopted container image ${adopted.imageName}`);
        notify?.(`using adopted image ${adopted.imageName}`);
        return adopted.imageName;
      }
      throw new Error(missingAdoptedImageMessage(adopted.imageName));
    }
  }

  const useDefault = options?.useDefaultImage ?? false;
  let resolvedRepository: { repository: string; isCustom: boolean };
  try {
    resolvedRepository = await resolveImageRepository(lazyRoot, useDefault);
  } catch (err) {
    // An adoption whose context cannot be rebuilt (its commit is gone) is the
    // project's image NOT BEING READY — inside the daemon that is the refusal
    // the launching surfaces turn into "run on the default image, or wait?",
    // exactly like a failed build, never a hard launch failure.
    const { RefAdoptionUnavailableError } = await import('../daemon/image-adoption');
    if (err instanceof RefAdoptionUnavailableError && !options?.bypassGate && customImageGate()) {
      throw new RunnerImageNotReadyError(err.message);
    }
    throw err;
  }
  const { repository, isCustom } = resolvedRepository;
  const imageName = `${repository}:${IMAGE_TAG}`;
  // A root Dockerfile.lazy the convention skipped is never silent: whoever is
  // watching this launch (a Teams page, a terminal) is told why the base image
  // is used instead. `lazy doctor` names the same states with their remedy.
  if (!isCustom && !useDefault) {
    const skipped = await describeSkippedRootDockerfile(lazyRoot);
    if (skipped) {
      logger.warn(skipped);
      notify?.(skipped);
    }
  }

  // Inside the daemon, the custom image belongs to the daemon's boot build
  // (src/daemon/runner-image.ts): a launch never inspects-and-builds it itself,
  // so it can never start a build behind the user's back while that one runs
  // or after it failed. Ready means use it; anything else is a refusal the
  // launching surface turns into "run on the default image, or wait?".
  const gate = isCustom && !options?.bypassGate ? customImageGate() : null;
  if (gate) {
    const verdict = gate.check(imageName);
    if (!verdict.ready) throw new RunnerImageNotReadyError(verdict.message);
    if (await imageExists(imageName, binary)) {
      // Same name, different inputs: a `build_inputs` file (a lockfile) changed.
      // The daemon rebuilds it in the background; this launch keeps the
      // current image, as it would during any in-place refresh.
      const builtFrom = await getImageDockerfileHash(imageName, binary);
      if (builtFrom !== null && builtFrom !== (await resolveImageIdentity(lazyRoot)).hash) {
        gate.stale(imageName);
        notify?.(`image ${imageName} is ready; its inputs changed, so the daemon is rebuilding it in the background`);
      } else {
        notify?.(`image ${imageName} is ready`);
      }
      return imageName;
    }
    gate.invalidate(imageName);
    throw new RunnerImageNotReadyError(gate.check(imageName).message);
  }

  // Everything from here on is inspect-then-build, which is a race: without the
  // lock, a fan-out of task starts after a lockfile bump has every one of them
  // inspect a stale image and start its own multi-minute build, each holding an
  // agent slot. Serialized, the first builds and the rest fall straight through
  // the hash check below. See `imageBuildMutex` for the residual cross-process
  // race, which is left open deliberately.
  // Waiting on another caller's build is as long as the build itself, and it
  // must not look dead to whoever is watching this launch: say so, and keep a
  // forced heartbeat until the lock is ours (after an upgrade the resumed
  // turns usually start the build, and a member's terminal waits behind it).
  let waitHeartbeat: ReturnType<typeof setInterval> | null = null;
  if (notify && imageBuildMutex.isLocked(imageName)) {
    const waitStarted = Date.now();
    const noteWait = throttleNotes(notify);
    notify(`waiting for ${imageName} to finish building`);
    waitHeartbeat = setInterval(() => {
      noteWait(`still waiting for ${imageName} to finish building... (${formatDuration(Date.now() - waitStarted)} elapsed)`, true);
    }, BUILD_HEARTBEAT_INTERVAL_MS);
  }
  const stopWaiting = () => {
    if (waitHeartbeat) clearInterval(waitHeartbeat);
    waitHeartbeat = null;
  };
  try {
    return await imageBuildMutex.withLock(imageName, () => {
      stopWaiting();
      return ensureImageLocked(lazyRoot, repository, imageName, binary, options?.noCache ?? false, options?.timeoutMs ?? 0, notify, useDefault, options?.rebuild ?? false);
    });
  } finally {
    stopWaiting();
  }
}

/**
 * Failure memory for builds a launch starts itself (the default image, or any
 * image outside the daemon's custom-image gate). Without it every task start
 * re-ran a build that had just failed — and a build that fails by exhausting
 * the guest dockerd's memory takes the machine with it each time. Process-local
 * on purpose: a restart is covered by the daemon's own attempt record for the
 * project image. An explicit rebuild or --no-cache build ignores it.
 */
const buildFailures = new Map<string, { failures: number; retryAtMs: number; error: string }>();

class BuildBackoffError extends Error {}

export function buildFailureBackoffMs(failures: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, failures - 1));
}

export function forgetBuildFailure(imageName: string): void {
  for (const key of [...buildFailures.keys()]) if (key.endsWith(`\0${imageName}`)) buildFailures.delete(key);
}

export function resetBuildFailuresForTests(): void {
  buildFailures.clear();
}

async function ensureImageLocked(
  lazyRoot: string,
  repository: string,
  imageName: string,
  binary: string,
  requestedNoCache: boolean,
  timeoutMs: number = 0,
  notify?: PhaseNotify,
  forceDefault: boolean = false,
  rebuild: boolean = false,
): Promise<string> {
  const identity = await resolveImageIdentity(lazyRoot, forceDefault);
  const currentHash = identity.hash;
  const imageHash = await getImageDockerfileHash(imageName, binary);
  let noCache = requestedNoCache;
  // Handed to the build so its single announcement says WHY it is running.
  let reason: string;

  if (imageHash === currentHash && rebuild) {
    // Somebody asked for this build (a project admin's Rebuild): up to date or
    // not, it runs. Docker moves the tag only when it succeeds, so the
    // current image stays usable the whole time.
    reason = requestedNoCache ? 'rebuild requested, without the build cache' : 'rebuild requested';
    notify?.(`rebuilding ${imageName} — ${reason}`);
  } else if (imageHash === currentHash) {
    // The Dockerfile text matches — but its text is not what goes stale. What
    // it PULLS is unpinned (apt packages, the Claude Code installer, the base
    // image, and whatever else a project's own Dockerfile fetches), and that
    // drifts with wall-clock time, so an old-enough image is rebuilt regardless.
    //
    // Except a PUBLISHED image: it pins its agent CLIs to its release, and newer
    // ones come by upgrading lazy (engineer decision 2026-09-27,
    // docs/design/published-runner-image.md §5). Age never rebuilds it.
    if (repository === IMAGE_NAME && (await isPublishedImage(imageName, binary))) {
      logger.debug('Container image is the published one for this release ✓');
      notify?.(`image ${imageName} is up to date`);
      return imageName;
    }
    const { tooOld, ageDays } = await isImageTooOld(imageName, binary);
    if (!tooOld) {
      logger.debug('Container image is up to date ✓');
      notify?.(`image ${imageName} is up to date`);
      return imageName;
    }
    // --no-cache is not optional on this path: with the Dockerfile text
    // unchanged, every layer is a cache hit, so a cached build would re-fetch
    // nothing AND return the identical image — leaving the created timestamp
    // untouched and re-triggering this same rebuild on every launch forever.
    noCache = true;
    reason =
      `too old: built ${ageDays} days ago (limit ${IMAGE_MAX_AGE_DAYS} days), ` +
      `rebuilding so the agent gets a current agent CLI`;
    notify?.(`rebuilding ${imageName} — image is ${ageDays} days old (older than ${IMAGE_MAX_AGE_DAYS} days)`);
  } else if (imageHash === null) {
    // Image missing. Say WHY in one line: on a host that upgraded lazy this is
    // the first sign that a multi-minute build is happening, and "not found"
    // alone reads like something is broken when in fact an older image is
    // sitting right there as build cache.
    const older = (await listLazyImages(binary))
      .filter(image => image.repository === repository && image.tag !== IMAGE_TAG && image.tag !== LATEST_ALIAS_TAG)
      .map(image => image.tag);
    if (older.length > 0) {
      logger.info(
        `Older image(s) for ${repository} (${older.join(', ')}) are kept as build cache — ` +
        `run \`lazy doctor\` for details.`,
      );
    }
    reason = `missing on this host — first build for lazy ${VERSION}`;
    notify?.(`building ${imageName} — no image for lazy ${VERSION} exists yet`);
  } else {
    // Name the file that changed rather than saying "something did" — with
    // build_inputs the trigger is usually a lockfile someone else bumped, and
    // "rebuilding" with no reason reads like lazy being arbitrary about a
    // multi-minute wait. Falls back to the generic line for images built before
    // the manifest label existed.
    const previous = await getImageInputManifest(imageName, binary);
    reason = describeInputChanges(previous, identity.manifest) ?? 'image inputs have changed';
    notify?.(`rebuilding ${imageName} — ${reason}`);
  }

  // Missing, mismatched or aged-out LOCAL default runner: pull the release's
  // image first. The age path included: a host that first launched offline, or
  // whose runner was published after it built, switches to the published image
  // instead of rebuilding every 14 days. Only an explicit --no-cache from the
  // caller skips the pull — that is an ask for a local rebuild.
  let pull: RunnerPullOutcome = { pulled: false, why: null };
  if (repository === IMAGE_NAME && !requestedNoCache) {
    pull = await pullPublishedRunner(lazyRoot, identity, buildTagsFor(repository), binary, notify);
    if (pull.pulled) return imageName;
  }

  const explicitBuild = rebuild || requestedNoCache;
  const failureKey = `${binary}\0${imageName}`;
  const remembered = buildFailures.get(failureKey);
  const inBackoff = !explicitBuild && remembered && Date.now() < remembered.retryAtMs;

  try {
    if (inBackoff) throw new BuildBackoffError(
      `Not rebuilding ${imageName}: the last ${remembered.failures} attempt(s) failed, so no new attempt starts before ` +
      `${new Date(remembered.retryAtMs).toISOString()}. Last error: ${remembered.error}`,
    );
    // No timeout unless the caller passed one. The implicit path — a task
    // starting when the image hash has changed — always passes nothing, so a
    // build nobody is watching can never be killed on a timer.
    await buildImage(lazyRoot, repository, identity, binary, noCache, timeoutMs, reason, notify, forceDefault);
    buildFailures.delete(failureKey);
    return imageName;
  } catch (buildErr) {
    // A refusal by the memory is not a new failure: it must not extend the backoff.
    if (!(buildErr instanceof BuildBackoffError)) {
    const failures = (buildFailures.get(failureKey)?.failures ?? 0) + 1;
    buildFailures.set(failureKey, {
      failures,
      retryAtMs: Date.now() + buildFailureBackoffMs(failures),
      error: buildErr instanceof Error ? buildErr.message : String(buildErr),
    });
    }
    // If not offline, just propagate the build error
    const buildConfig = await loadConfig(lazyRoot);
    if (!(await isOfflineMode(join(lazyRoot, '.lazy'), buildConfig.remote.offline))) {
      throw withPullReason(buildErr, pull);
    }

    // Offline mode: try to fall back to an existing image
    logger.warn(`Image build failed in offline mode: ${buildErr instanceof Error ? buildErr.message : buildErr}`);

    // If the target image exists (just outdated), use it as-is
    if (imageHash !== null) {
      logger.warn(`Using existing image "${imageName}" (a rebuild was wanted — image may be outdated).`);
      return imageName;
    }

    // No target image — check for any other lazy images
    const existing = await listExistingLazyImages(binary);
    if (existing.length > 0) {
      const fallback = existing[0]; // most recent
      logger.warn(`Using fallback image "${fallback}" (originally wanted "${imageName}").`);
      if (existing.length > 1) {
        logger.info(`Other available lazy images: ${existing.slice(1).join(', ')}`);
      }
      return fallback;
    }

    // No images at all — actionable error
    throw new Error(
      `Cannot build Docker image while offline (no network access to pull base images), ` +
      `and no existing lazy images found. Build the image while online first: ` +
      `run \`lazy system online\`, then start a task to trigger the image build.`
    );
  }
}


/**
 * Get the Bun cross-compilation target for Linux containers.
 * Matches the host architecture so the binary runs in Docker containers
 * (which default to the host's architecture).
 */
function getLinuxTarget(): string {
  const arch = process.arch; // 'x64', 'arm64', etc.
  if (arch === 'arm64') {
    return 'bun-linux-arm64';
  }
  return 'bun-linux-x64';
}

/**
 * Get the lazy source root directory.
 *
 * In dev mode (running via `bun run src/index.ts`), this is the directory
 * containing the source files — derived from this file's location.
 *
 * In compiled mode, there is no source directory — we return null and
 * the caller must use a pre-built agent binary.
 */
function getLazySourceRoot(): string | null {
  // import.meta.dir gives us the directory of this source file.
  // In dev mode: /path/to/lazy/src/capture
  // In compiled mode: a virtual path inside the binary (not on disk)
  const thisDir = import.meta.dir;
  const candidateRoot = join(thisDir, '..', '..');

  // Verify this looks like the lazy source by checking for agent-entry.ts
  if (existsSync(join(candidateRoot, 'src', 'agent-entry.ts'))) {
    return candidateRoot;
  }

  return null;
}

/**
 * Extract the embedded agent binary from the compiled lazy executable.
 * Returns the path to the extracted binary, or null if not in compiled mode
 * or the embedded binary is not available (e.g. dev mode placeholder).
 *
 * The returned path is a content-addressed, immutable install
 * (`<destDir>/lazy-agent-<id>`), never the `lazy-agent` pointer — see
 * src/agent/binary-install.ts for why nothing may write to a mounted path.
 */
export async function extractEmbeddedAgentBinary(
  destDir: string,
  // Parameterised so tests can drive the real function with a stand-in for the
  // $bunfs-embedded binary, which only exists in a compiled build.
  embeddedPath: string = embeddedAgentBinaryPath,
): Promise<string | null> {
  // The embedded path starts with $bunfs/ when running as a compiled binary.
  // In dev mode it's a regular file path pointing to the placeholder.
  if (!embeddedPath || !existsSync(embeddedPath)) {
    return null;
  }

  // Read the embedded binary up front: every decision below needs its bytes,
  // and it lives in the $bunfs virtual filesystem, so OS-level copy syscalls
  // (copyFile) cannot touch it. ~100MB reads in tens of milliseconds, once per
  // container launch, against a docker run that takes seconds.
  let embedded: Buffer;
  try {
    embedded = readFileSync(embeddedPath);
  } catch {
    return null;
  }

  // Verify the bytes are actually the compiled agent before they become the
  // file every container bind-mounts.
  //
  // A size floor alone is not enough: in DEV mode this import resolves to the
  // repo's own ./lazy-agent, which is a 12-byte placeholder after `bun install`
  // but can also be a bare Bun runtime or a stale build left by an interrupted
  // `bun run build`. Any such file over 1KB used to be copied to
  // ~/.lazy/bin/lazy-agent and mounted into every container — the exact failure
  // reported in the field ('Script not found "builder"' / an empty selfcheck).
  const verdict = verifyAgentBinaryBytes(embedded);
  if (!verdict.ok) {
    if (embedded.length < MIN_AGENT_BINARY_SIZE) {
      // The ordinary dev-mode placeholder. Silent: the caller builds from source.
      return null;
    }
    if (embeddedPath.startsWith('/$bunfs') || embeddedPath.startsWith('$bunfs')) {
      // Compiled mode: the binary embedded at build time is wrong. Nothing
      // downstream can recover from this, so fail loud rather than mount it.
      throw new Error(formatAgentBinaryError(embeddedPath, verdict.reason, { canRebuild: false }));
    }
    // Dev mode with a real-looking but wrong ./lazy-agent. Say so, then let the
    // caller rebuild from source rather than installing this file.
    logger.warn(
      `Ignoring ${embeddedPath}: ${verdict.reason}. Rebuilding the agent binary from source.`,
    );
    return null;
  }

  await mkdir(destDir, { recursive: true });

  // The install path IS the identity of the bytes: `lazy-agent-<content-id>`.
  //
  // This subsumes the byte-identity check that used to guard a single shared
  // path. That check existed because a size-only comparison kept a stale binary
  // whenever two ~100MB Bun builds happened to match in length, so a freshly
  // upgraded daemon talked to agents running OLD agent code. Content addressing
  // makes staleness unrepresentable: different bytes are a different file name,
  // and identical bytes are the same install, which is returned untouched.
  const contentId = agentBinaryContentId(embedded);
  const result = await installVersionedAgentBinary(destDir, embedded, contentId);
  // Only a process that actually installed bytes claims the pointer. An OLD
  // lazy re-extracting its own embedded agent must not drag the pointer back to
  // its version on every relaunch while the upgraded daemon flips it forward.
  await updateAgentBinaryPointer(destDir, result.path, { force: result.installed });
  if (result.installed) {
    await collectStaleAgentBinaries(destDir, result.path);
  }
  return result.path;
}

/**
 * Best-effort GC of superseded agent binaries.
 *
 * Immutable installs never overwrite each other, so old versions accumulate at
 * ~100MB apiece. Anything a running container mounts is kept, as is anything
 * installed recently (a container being created right now is not in `docker ps`
 * yet). A failure here costs disk, never a launch — so it is logged, not thrown.
 */
async function collectStaleAgentBinaries(binDir: string, currentPath: string): Promise<void> {
  try {
    const referenced = await listContainerMountSources();
    const removed = await pruneAgentBinaries(binDir, { keep: [currentPath], referenced });
    if (removed.length > 0) {
      logger.debug(`Removed ${removed.length} superseded agent binary file(s) from ${binDir}`);
    }
  } catch (err) {
    logger.debug(
      `Could not collect superseded agent binaries in ${binDir}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Get the per-user lazy bin directory (~/.lazy/bin/).
 * Agent binaries are per-user operational state, not per-project.
 */
function getUserBinDir(): string {
  return join(getHome(), '.lazy', 'bin');
}

/**
 * Ensure the agent binary is available for use in Docker containers.
 *
 * Returns a content-addressed, immutable install — `~/.lazy/bin/lazy-agent-<id>`
 * — which is what every launch bind-mounts. `~/.lazy/bin/lazy-agent-current` is
 * only a pointer symlink for humans; mounting a name a later writer can replace
 * would reintroduce the swap-under-a-live-mount failure this layout exists to
 * prevent (see binary-install.ts). The legacy `~/.lazy/bin/lazy-agent` path is
 * never written to at all — pre-migration containers still mount it.
 *
 * Resolution order:
 * 1. Embedded binary installed content-addressed (compiled mode)
 * 2. A previous install already in ~/.lazy/bin/ (incl. a legacy single-path one)
 * 3. Build from source (dev mode only)
 */
export async function ensureAgentBinary(): Promise<string> {
  const binDir = getUserBinDir();
  lastSourceBuildProvenance = null;

  // 1. Try to extract embedded binary (compiled mode)
  const extracted = await extractEmbeddedAgentBinary(binDir);
  if (extracted) {
    logger.debug(`Using embedded agent binary: ${extracted}`);
    return extracted;
  }

  // 3. Try to build from source (dev mode only)
  const sourceRoot = getLazySourceRoot();
  if (!sourceRoot) {
    // 2. No source available and no embedded binary found: fall back to whatever
    // install is already here — including a pre-content-addressing
    // ~/.lazy/bin/lazy-agent regular file, which is copied into the immutable
    // layout rather than mounted where a writer could later land on it.
    const adopted = await adoptLegacyAgentBinary(binDir);
    if (adopted) {
      await updateAgentBinaryPointer(binDir, adopted.path, { force: adopted.installed });
      logger.debug('Adopted the legacy agent binary into a content-addressed install');
      return adopted.path;
    }
    const installed = await resolveInstalledAgentBinary(binDir);
    if (installed) {
      // Verify rather than trust. This path returns a file nobody in this
      // process produced — whatever a previous install, a partial upgrade or a
      // stray copy left behind — straight into a container bind mount.
      const cached = await verifyAgentBinary(installed);
      if (!cached.ok) {
        throw new Error(formatAgentBinaryError(installed, cached.reason, { canRebuild: false }));
      }
      logger.debug('Using cached agent binary (source not available for rebuild)');
      return installed;
    }
    throw new Error(
      'Agent binary not found. This may indicate a corrupted installation. ' +
      'Try reinstalling lazy, or run: lazy upgrade'
    );
  }

  const entryPoint = join(sourceRoot, 'src', 'agent-entry.ts');
  const target = getLinuxTarget();

  // Check if binary needs rebuilding by comparing source hash + target arch.
  // The stamp records BOTH the source hash and the install the last build
  // produced, because the install path is no longer a fixed name.
  const hashFile = agentBinaryStampPath(binDir);
  const currentHash = calculateSourceHash(sourceRoot) + ':' + target;

  const stamp = await readAgentBinaryStamp(hashFile);
  if (stamp && stamp.sourceHash === currentHash && stamp.installName) {
    const stampedPath = join(binDir, stamp.installName);
    // The hash says the SOURCE has not changed; it says nothing about whether
    // the file on disk is still the binary that hash was recorded for.
    const cached = await verifyAgentBinary(stampedPath);
    if (cached.ok) {
      logger.debug('Agent binary is up to date');
      await updateAgentBinaryPointer(binDir, stampedPath);
      return stampedPath;
    }
    logger.warn(
      `Cached agent binary at ${stampedPath} failed verification (${cached.reason}). Rebuilding.`,
    );
  }

  mkdirSync(binDir, { recursive: true });

  if (sourceAgentBinaryBuild) {
    return sourceAgentBinaryBuild;
  }

  sourceAgentBinaryBuild = buildAgentBinaryFromSourceCheckout(
    sourceRoot,
    entryPoint,
    target,
    hashFile,
    currentHash,
    binDir,
  ).finally(() => {
    sourceAgentBinaryBuild = null;
  });

  return sourceAgentBinaryBuild;
}

/** Where the dev-mode build records its source hash and resulting install. */
export function agentBinaryStampPath(binDir: string): string {
  return join(binDir, 'lazy-agent.hash');
}

interface AgentBinaryStamp {
  sourceHash: string;
  /** File name of the install that build produced; absent on a legacy stamp. */
  installName: string | null;
}

/**
 * Read the dev-build stamp. Line 1 is the source hash (unchanged from the
 * single-path layout, so `lazy upgrade` deleting this file still forces a
 * rebuild); line 2 names the content-addressed install it produced. A legacy
 * one-line stamp yields a null install name, which forces one rebuild.
 */
async function readAgentBinaryStamp(hashFile: string): Promise<AgentBinaryStamp | null> {
  try {
    const raw = await readFile(hashFile, 'utf-8');
    const [sourceHash, installName] = raw.split('\n').map((l) => l.trim());
    if (!sourceHash) return null;
    return { sourceHash, installName: installName || null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Failed to read the agent binary build stamp at ${hashFile}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Dev-mode compile: stamp build-info.ts, run `bun build --compile`, restore dev defaults.
 *
 * Checkout mutation window — same accepted trade as scripts/build.ts: overwrite
 * src/build-info.ts so bun embeds compile-time git identity, restore dev defaults
 * in `finally`. SIGKILL mid-build skips `finally` and leaves the file stamped
 * until the next `generate:version` or rebuild restore. Callers serialize on
 * sourceAgentBinaryBuild so concurrent compiles do not interleave writes.
 */
async function buildAgentBinaryFromSourceCheckout(
  sourceRoot: string,
  entryPoint: string,
  target: string,
  hashFile: string,
  currentHash: string,
  binDir: string,
): Promise<string> {
  // Stamp compile-time metadata into the binary so `lazy-agent selfcheck` and
  // `lazy --version` can answer which checkout produced it hours later.
  const provenance = captureBuildProvenance(sourceRoot);
  lastSourceBuildProvenance = provenance;
  const buildInfoPath = join(sourceRoot, 'src', 'build-info.ts');
  writeFileSync(buildInfoPath, formatBuildInfoContent(provenance));

  try {
    logger.info(`Building agent binary for Linux (${target}) — ${formatSourceProvenanceLine(provenance)}`);

    // Build to a temp file, then adopt it under its content-addressed name.
    // Nothing a running container has mounted is ever the target of a write:
    // a Docker Desktop file bind mount re-resolves the HOST PATH on access, so
    // renaming onto a mounted path IS visible inside live containers (see
    // src/agent/binary-install.ts for the verified evidence).
    const tmpPath = join(binDir, `${AGENT_BINARY_TMP_PREFIX}${randomUUID()}`);

    // Build with cwd set to the OUTPUT directory, not the source root.
    //
    // `bun build --compile` writes a `.<hash>.bun-build` temp file in its cwd and
    // renames it onto --outfile. That rename fails across filesystems (ENOENT),
    // and bun leaves the ~190MB temp file behind in the cwd — so building from the
    // source root both fails and litters the repo whenever ~/.lazy sits on another
    // volume (a bind-mounted worktree, a separate $HOME volume). Same-directory
    // cwd + outfile makes the rename intra-filesystem. scripts/build.ts works
    // around the same bug the same way. Module resolution is unaffected: the entry
    // point is absolute and bun resolves from the entry file, not from cwd.
    const proc = spawn(
      ['bun', 'build', '--compile', `--target=${target}`, entryPoint, '--outfile', tmpPath],
      { cwd: binDir, stdout: 'pipe', stderr: 'pipe' }
    );

    const outputPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    const [stdout, stderr, exitCode] = await Promise.all([
      outputPromise,
      stderrPromise,
      proc.exited,
    ]);

    logger.stream('Agent binary build stdout:\n' + stdout);
    logger.stream('Agent binary build stderr:\n' + stderr);

    if (exitCode !== 0) {
      // Clean up temp file on failure
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Best effort cleanup
      }

      const stderrLines = stderr.trim().split('\n');
      const lastOutput = stderrLines.slice(-10).join('\n');
      logger.error(`Agent binary build failed with exit code ${exitCode}\n\nLast output:\n${lastOutput}`);
      throw new Error(`Agent binary build failed with exit code ${exitCode}`);
    }

    // Verify BEFORE the rename. `bun build --compile` writes the target runtime
    // first and appends the bundle last, so an interrupted or partial compile can
    // leave an output that is a plain Bun runtime — and Bun does not always report
    // that with a non-zero exit. Renaming it into place would replace a working
    // binary with one that answers every subcommand `Script not found "<sub>"`.
    const built = await verifyAgentBinary(tmpPath);
    if (!built.ok) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
      throw new Error(
        `Agent binary build produced an invalid binary (${built.reason}). ` +
        `The previously installed binary in ${binDir} was left untouched. ` +
        `Re-run the build; if it keeps happening, clear Bun's cross-compile cache ` +
        `(~/.bun/install/cache) and rebuild.`,
      );
    }

    // On Linux, also run the live selfcheck the builder preflight uses. Content
    // checks alone cannot catch every bad artifact bun can write with exit 0.
    if (process.platform === 'linux') {
      const execVerdict = verifyAgentBinarySelfcheckExec(tmpPath);
      if (!execVerdict.ok) {
        try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
        throw new Error(
          `Agent binary build failed selfcheck (${execVerdict.reason}). ` +
          `The previously installed binary in ${binDir} was left untouched.`,
        );
      }
    }

    // Adopt the verified temp file under its content-addressed name. If that
    // exact content is already installed and still verifies, the existing file
    // is kept and the temp file is discarded — an install is never rewritten.
    const contentId = await agentBinaryContentIdOfFile(tmpPath);
    const adopted = await adoptVersionedAgentBinary(binDir, tmpPath, contentId);
    await updateAgentBinaryPointer(binDir, adopted.path, { force: adopted.installed });

    // Store the source hash AND the install it produced, for the next
    // staleness comparison.
    await Bun.write(hashFile, `${currentHash}\n${versionedAgentBinaryName(contentId)}\n`);

    if (adopted.installed) {
      await collectStaleAgentBinaries(binDir, adopted.path);
    }

    logger.debug('Agent binary build completed successfully');
    return adopted.path;
  } finally {
    // Restore dev defaults so a dev checkout's build-info.ts does not stay dirty
    // with compile-time values after the binary is already stamped.
    // Back to the checkout's RESTING content, not always the dev defaults: an
    // image checkout (no .git) rests on its source stamp, and 'dev' there would
    // make the daemon forget which commit it runs after its first agent compile.
    writeFileSync(buildInfoPath, restingBuildInfoContent(sourceRoot));
  }
}

/**
 * Calculate a hash of the lazy source files to detect changes
 */
function calculateSourceHash(lazyRoot: string): string {
  const hash = createHash('sha256');
  const srcDir = join(lazyRoot, 'src');

  // Hash package.json (dependency changes) and all .ts source files
  const packageJson = join(lazyRoot, 'package.json');
  if (existsSync(packageJson)) {
    hash.update(readFileSync(packageJson, 'utf-8'));
  }

  // Use a simple recursive glob via Bun to find all .ts files
  const glob = new Bun.Glob('**/*.ts');
  const files = Array.from(glob.scanSync({ cwd: srcDir, absolute: true })).sort();
  for (const file of files) {
    hash.update(readFileSync(file, 'utf-8'));
  }

  return hash.digest('hex');
}

/**
 * Check whether an API auth token is available in the environment.
 * Delegates to ClaudeCodeAgent.hasAuthEnv().
 */
export function hasAuthEnv(): boolean {
  return _agent.hasAuthEnv();
}

/**
 * Get auth environment variables for a resolved role target.
 *
 * - credential `none` (a local model server): synthetic credentials
 *   ({@link LOCAL_BACKEND_CREDS})
 * - credential `anthropic` (or no target): the real Anthropic credential (throws
 *   if absent, via ClaudeCodeAgent.getAuthEnvVars()).
 * - any other slot (ollama.com, openai, openrouter, a named credential): resolved
 *   from the credential STORE, which is async — so this function refuses and
 *   names {@link getLaunchAuthEnvVars} instead of guessing.
 *
 * The base URL is the proxy's for every profile — where a profile's traffic goes
 * upstream is the proxy's routing decision, not the launched process's.
 *
 * `surface` says whether the env is for a container or a host process — see
 * {@link targetEnvVars}. It defaults to `'container'` because every caller in
 * this module builds `docker run` argv; host launch paths pass `'host'`
 * explicitly.
 *
 * `credentialOverride` replaces the daemon's own credential with a caller-supplied
 * one. Team mode passes the task's placeholder session token here, in the env var
 * mirroring its owner's credential kind, so the container never holds a real
 * secret. Omitted everywhere else, which is the single-user default: the daemon's
 * credential, exactly as before.
 */
export function getAuthEnvVars(
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  credentialOverride?: Array<{ key: string; value: string }> | null,
): Array<{ key: string; value: string }> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;
  if (usesSyntheticCreds(resolved)) {
    return targetEnvVars(resolved, LOCAL_BACKEND_CREDS, surface, hints);
  }
  if (resolved.credential !== 'anthropic' && !credentialOverride) {
    throw new Error(
      `Agent profile "${resolved.profile}" bills the "${resolved.credential}" credential, which ` +
      'is read from the credential store asynchronously — use getLaunchAuthEnvVars instead of ' +
      'getAuthEnvVars. This is a lazy bug — please report it.',
    );
  }
  const creds =
    // throws, actionably, if genuinely absent — unless the caller supplied a
    // credential to use in its place (team mode's per-session token).
    credentialOverride ?? _agent.getAuthEnvVars();
  return targetEnvVars(resolved, creds, surface, hints);
}

/**
 * Launch-time auth env with the credential swapped for a per-launch PLACEHOLDER.
 *
 * This is what makes a task container credential-free. {@link getAuthEnvVars}
 * still returns the REAL credential and is still what the proxy resolves
 * against inside the daemon — but nothing that hands env to a launched process
 * should call it any more. Use this.
 *
 * Every profile's traffic reaches lazy's proxy now — including profiles pinned
 * at an explicit `endpoint`, which the proxy forwards to on their behalf — so
 * the only remaining condition is that this process is the daemon that runs the
 * proxy. Without a daemon context (the in-container supervisor relaunching its
 * own agent, test/daemonless modes) this process cannot mint against the
 * daemon's grant registry, and in the container case it does not need to: the
 * value it reads out of its own env is already the placeholder the daemon
 * minted.
 *
 * A profile whose credential is `none` is placeholderized like any other, over
 * synthetic credentials ({@link LOCAL_BACKEND_CREDS}) rather than the user's
 * token — the grant is what lets the proxy authenticate the caller and route it
 * to that profile's upstream, so skipping the swap would cost the routing, not
 * just the secrecy.
 */
/**
 * Fill `[proxy] upstream` on a target that already has a proxy address but
 * was built by a path that never went through `applyLiveProxyUrl`.
 *
 * The first-party flag in `targetEnvVars` needs to know where an unpinned
 * profile's traffic lands. Callers that stamp `proxyUrl` through
 * `applyLiveProxyUrl` already carry `primaryUpstream`; this is the safety net
 * for remaining in-daemon launches that pass a role target with only the
 * address.
 */
async function withPrimaryUpstream(target: RoleTarget): Promise<RoleTarget> {
  if (!target.proxyUrl || target.primaryUpstream) return target;
  const config = await loadConfig(getLazyRoot());
  return { ...target, primaryUpstream: config.proxy.upstream };
}

export async function getLaunchAuthEnvVars(
  identity: LaunchIdentity,
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  injectedCreds?: Array<{ key: string; value: string }>,
): Promise<Array<{ key: string; value: string }>> {
  const resolved = await withPrimaryUpstream(target ?? ANTHROPIC_DEFAULT_TARGET);
  // THE TURN CREDENTIAL GATE, for every in-daemon launch paid by the daemon's
  // own credential (nothing injected): a builder session, a review-conversation
  // builder, a one-shot. The daemon may be running with no credential at all,
  // so this is where such a launch loads one stored since startup — or is
  // refused naming its profile. See src/daemon/credential-gate.ts. Asked even
  // when the target itself takes no credential: on a TIERED profile that is
  // only tier 0, and the gate checks every tier (a `none` slot answers null).
  if (!injectedCreds?.length && hasDaemonContext()) {
    const refusal = await targetCredentialRefusal(getLazyRoot(), resolved);
    if (refusal) throw new RpcError(400, refusal);
  }
  // injectedCreds: either team-mode session placeholders (`lazy-sess-…`, passed
  // through unchanged below) or real credential vars from the host runner's
  // agent — which still need JIT placeholderization. When absent, the profile's
  // own credential slot decides the source: the store for a named/provider slot,
  // the module-level default agent reader for Anthropic.
  //
  // TEAM MODE (session placeholders injected) never reads the project's store:
  // every turn is paid by its principal's own credential for the profile. An
  // Anthropic-wire profile the owner's Claude credential pays on the primary
  // upstream keeps the session placeholder; any other claude-code or pi profile
  // gets a stand-in that becomes a GRANT, so the proxy can route it to the
  // profile's upstream and pay it with the member's credential for that
  // profile. Another harness (codex, cursor) gets no Anthropic credential at
  // all — nothing in its turn uses one (see teamModeLaunchCreds).
  const teamMode = !!injectedCreds?.some((v) => isSessionPlaceholderToken(v.value));
  // A team-mode launch BESIDE a task (a member's builder, a one-shot) is paid
  // through the session binding its injected placeholder belongs to: every
  // grant it mints names that binding, so the proxy bills its owner with their
  // own credential for the grant's profile — never the project's credentials.
  // A task's own turn (role `agent`) is found by its task UUID instead.
  if (teamMode && identity.role !== 'agent' && !identity.bindingKey) {
    const sessionToken = injectedCreds!.find((v) => isSessionPlaceholderToken(v.value))!.value;
    const binding = await lookupSessionBinding(identity.projectRoot ?? getLazyRoot(), sessionToken);
    if (binding) identity = { ...identity, bindingKey: binding.taskId };
  }
  const real = teamMode
    ? teamModeLaunchCreds(resolved, injectedCreds!)
    : (await resolveProfileLaunchCreds(getLazyRoot(), resolved))
      ?? injectedCreds
      ?? _agent.getAuthEnvVars();
  const proxyPort = hasDaemonContext() ? getDaemonContext().proxyPort : undefined;
  if (!proxyPort) {
    return targetEnvVars(resolved, real, surface, hints);
  }
  // Team-mode session credentials (`lazy-sess-…`) are already placeholders bound
  // to a turn owner. Running them through JIT placeholderizeAuthEnv would replace
  // that token with an unrelated grant the per-user swap path cannot resolve.
  // Judged on the creds actually USED: a named-credential profile resolves its
  // own real key ahead of `injectedCreds`, and that key must still be
  // placeholderized even when session placeholders were injected.
  const usesSessionPlaceholders = real.some((v) => isSessionPlaceholderToken(v.value));
  const creds = usesSessionPlaceholders
    ? real
    : await placeholderizeAuthEnv(identity.projectRoot ?? getLazyRoot(), real, identity);
  // A key-capable harness (codex, cursor) launched beside a task in team mode
  // carries its OWN key's placeholder, bound like the rest to the member who
  // pays — the Anthropic session placeholder means nothing to it.
  const agentKeyEnv = AGENT_KEY_ENV[resolved.harness];
  if (teamMode && identity.bindingKey && agentKeyEnv && agentSupportsApiKey(resolved.harness)
      && resolved.credential !== NO_CREDENTIAL) {
    const { projectRoot, ...grantIdentity } = identity;
    creds.push({
      key: agentKeyEnv,
      value: await mintCredentialGrant(projectRoot ?? getLazyRoot(), { ...grantIdentity, envKey: agentKeyEnv }),
    });
  }
  return targetEnvVars(resolved, creds, surface, hints);
}

/**
 * Container argv for a one-shot agent run.
 *
 * Exported for test/unit/daemon-dir-never-mounted.test.ts, which asserts the
 * mount set never exposes the daemon state dir — see the INVARIANT comment there.
 *
 * `gitMountArgs` carries the split `.git` mount (see src/capture/git-mounts.ts);
 * callers build it with `buildTaskGitMounts(root, worktreePath)`.
 */
export function buildDockerArgs(
  sandbox: SandboxConfig,
  claudeArgs: AgentExecArgs,
  agentBinaryPath: string,
  imageName: string,
  binary: string = 'docker',
  repoRoot: string = getLazyRoot(),
  authEnvVars: Array<{ key: string; value: string }> = [],
  gitMountArgs: string[] = [],
): string[] {
  return [
    binary, 'run', '--rm', '--init',
    // Keep stdin open when the agent reads its prompt from it.
    ...(claudeArgs.stdinInput === undefined ? [] : ['-i']),
    // Allow container to reach host services (daemon MCP, Ollama, etc.)
    '--add-host=host.docker.internal:host-gateway',
    // Mount repo read-only so agent can read source but not modify the main tree.
    // The worktree is mounted read-write on top (more specific mount wins).
    '-v', `${repoRoot}:${repoRoot}:ro`,
    // Hide .lazy/ (builder config, audit log, sibling worktrees) — see src/capture/lazy-dir-mask.ts.
    ...lazyDataDirMaskArgs(dataDirOfWorktree(repoRoot, sandbox.worktreePath)),
    '-v', `${sandbox.worktreePath}:${sandbox.worktreePath}`,
    // Split .git mount: common dir read-only, only objects + this worktree's
    // gitdir writable. See src/capture/git-mounts.ts.
    ...gitMountArgs,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    ...authEnvVars.flatMap(v => ['-e', `${v.key}=${v.value}`]),
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    imageName,
    ...claudeArgs,
  ];
}

export async function runClaude(
  prompt: string,
  sandbox: SandboxConfig,
  verbose: boolean = false,
  debug: boolean = false,
  model?: string,
  binary: string = 'docker',
  target?: RoleTarget,
  effort?: string,
): Promise<AgentResponse> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  // The caller's decision site resolves the model; for a profile pinned at its
  // own endpoint fall back to that profile's authoritative model if no explicit
  // model was passed — the upstream serves what it serves, and lazy's usual
  // model chain names Anthropic models it has never heard of.
  const effectiveModel = model || (target?.pinned ? target.model : '') || undefined;

  // The prompt rides stdin, never argv (src/agent/argv-safety.ts).
  const claudeArgs: AgentExecArgs = Object.assign([
    'claude', '-p',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    // Always: see requireLaunchModel (src/agent/launch-model.ts).
    '--model', requireLaunchModel('claude-code', effectiveModel),
  ], { stdinInput: prompt });

  if (effort) {
    claudeArgs.push('--effort', effort);
  }

  logger.debug('Setting up sandbox...');
  // JIT CREDENTIALS: this is a container launch, so it gets a placeholder like
  // every other one — the real credential must not reach the container's env or
  // the docker argv. Resolved through the daemon (the credential's owner) with a
  // builder identity: this runs on behalf of a human at a terminal, not a task.
  // The identity's profile is the proxy's routing key, so it is the profile of
  // the target this one-shot actually runs on. It falls back to the built-in
  // name only when the caller passed no target at all.
  const authEnvVars = await resolveAuthEnvFromDaemon(
    target, { role: 'builder' }, 'container', undefined,
    {
      role: 'builder', taskId: null, label: `oneshot:${getLazyRoot()}`,
      profile: target?.profile || BUILDER_PROFILE_NAME,
    },
  );
  const args = buildDockerArgs(
    sandbox, claudeArgs, agentBinaryPath, imageName, binary,
    getLazyRoot(), authEnvVars,
    (await buildTaskGitMounts(getLazyRoot(), sandbox.worktreePath)).args,
  );

  if (debug) {
    console.log('[DEBUG] Running container command:', redactSecrets(args).join(' '));
  }

  logger.info('Running Claude Code...');

  assertArgvBounded(args, 'Claude Code');
  const proc = spawn(args, {
    stdin: new Blob([prompt]),
    stdout: 'pipe',
    stderr: verbose || debug ? 'inherit' : 'pipe',
  });

  const outputPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const [output, stderr, exitCode] = await Promise.all([
    outputPromise,
    stderrPromise,
    proc.exited,
  ]);

  logger.stream('Claude stdout:\n' + output);
  logger.stream('Claude stderr:\n' + stderr);

  if (exitCode !== 0) {
    if (!(verbose || debug) && stderr) {
      const stderrLines = stderr.trim().split('\n');
      const lastOutput = stderrLines.slice(-20).join('\n  ');
      logger.error(`Claude Code exited with code ${exitCode}\n\nLast output:\n  ${lastOutput}`);
    } else {
      logger.error(`Claude Code exited with code ${exitCode}`);
    }
    throw new Error(`Claude exited with code ${exitCode}`);
  }

  logger.debug('Parsing Claude response...');
  return JSON.parse(output) as AgentResponse;
}

/**
 * Extract TokenUsage from an AgentResponse
 */
export function extractTokenUsage(response: AgentResponse): TokenUsage {
  // A backend that reports no usage at all is a real possibility (the agent
  // interface does not require one), and this used to dereference
  // `response.usage.*` straight through — a TypeError that took the whole ask
  // down over bookkeeping. Validate, warn, and report zeros instead.
  return toTurnUsage(response.usage, 'token usage')
    ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/**
 * Check if a Docker container is currently running.
 * Returns false if Docker is not available.
 */
export async function isContainerRunning(containerName: string, binary: string = 'docker'): Promise<boolean> {
  try {
    const proc = spawn(
      [binary, 'ps', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 && stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a Docker container exists (running or stopped).
 * Returns false if Docker is not available.
 */
export async function containerExists(containerName: string, binary: string = 'docker'): Promise<boolean> {
  try {
    const proc = spawn(
      [binary, 'ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 && stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the exit code of a stopped container, or null if still running.
 * Returns null if Docker is not available.
 */
export async function getContainerExitCode(containerName: string, binary: string = 'docker'): Promise<number | null> {
  try {
    const proc = spawn(
      [binary, 'inspect', containerName, '--format', '{{.State.Running}} {{.State.ExitCode}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    const [stdout, procExit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (procExit !== 0) return null;

    const output = stdout.trim();
    const [running, exitCode] = output.split(' ');
    if (running === 'true') return null; // Still running
    return parseInt(exitCode, 10);
  } catch {
    return null;
  }
}

/**
 * Get the last N lines of container logs (stdout + stderr combined).
 * Returns null if Docker is not available or container doesn't exist.
 */
export async function getContainerLogs(containerName: string, tailLines: number = 50, binary: string = 'docker'): Promise<string | null> {
  try {
    const proc = spawn(
      [binary, 'logs', '--tail', String(tailLines), containerName],
      { stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    // Combine stdout and stderr since docker logs splits them
    return (stdout + stderr).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Remove a Docker container. Logs a warning on failure but does not throw.
 * No-op if Docker is not available.
 */
export async function removeContainer(containerName: string, binary: string = 'docker'): Promise<void> {
  try {
    const proc = spawn(
      [binary, 'rm', '-f', containerName],
      { stdout: 'ignore', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS }
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      logger.warn(`Failed to remove container ${containerName} (exit ${exitCode}): ${stderr.trim()}`);
    }
  } catch {
    // Docker not available — nothing to remove
  }
}

export interface ContainerInfo {
  running: boolean;
  exitCode: number;
  finishedAt: string | null; // ISO timestamp or null if still running
}

/**
 * Get detailed info about a container: running state, exit code, and finished time.
 * Returns null if the container doesn't exist or Docker is unavailable.
 */
export async function getContainerInfo(containerName: string, binary: string = 'docker'): Promise<ContainerInfo | null> {
  try {
    const proc = spawn(
      [binary, 'inspect', containerName, '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.FinishedAt}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;

    const output = stdout.trim();
    const parts = output.split(' ');
    if (parts.length < 3) return null;

    const running = parts[0] === 'true';
    const containerExitCode = parseInt(parts[1], 10);
    // FinishedAt is "0001-01-01T00:00:00Z" when never finished (still running or never started)
    const finishedAt = parts.slice(2).join(' ');
    const isZeroTime = finishedAt.startsWith('0001-01-01');

    return {
      running,
      exitCode: containerExitCode,
      finishedAt: isZeroTime ? null : finishedAt,
    };
  } catch {
    return null;
  }
}

/** What a container lookup found — and whether the runtime answered at all. */
export type ContainerProbe =
  /** The runtime answered: the container's state, or null for "no such container". */
  | { kind: 'answered'; info: ContainerInfo | null }
  /** The runtime did not answer (timed out, killed, could not connect, could not start). */
  | { kind: 'no-answer'; reason: string };

/**
 * `getContainerInfo`, but saying WHY there is no info.
 *
 * `getContainerInfo` returns null alike for "no such container" and for a
 * runtime that never answered — right for its callers, which only ask "is
 * there a run I can use". A health check asks something else: "is this run
 * confirmed dead?", and only the first case confirms it. A busy Docker Desktop
 * timing out every lookup must not read as every task's container being gone.
 *
 * So stderr is kept and read: a non-zero exit whose stderr says "no such
 * object/container" is an ANSWER (the container does not exist); any other
 * non-zero exit (cannot connect to the daemon, permission denied), a lookup
 * killed at the deadline, or a binary that cannot be started is NO ANSWER.
 * Never throws.
 */
export async function probeContainerInfo(
  containerName: string,
  binary: string = 'docker',
  timeoutMs: number = DOCKER_TIMEOUT_MS,
): Promise<ContainerProbe> {
  const lookup = `${binary.split('/').pop()} inspect`;
  let proc;
  try {
    proc = spawn(
      [binary, 'inspect', containerName, '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.FinishedAt}}'],
      { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs },
    );
  } catch (err) {
    return { kind: 'no-answer', reason: `${lookup} could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    // Reads start at once (a full pipe must never stall the child), but are
    // only awaited for a normal exit: a killed wrapper script can leave a
    // grandchild holding the pipe open long after the deadline.
    const stdoutRead = new Response(proc.stdout).text();
    const stderrRead = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    // Killed by a signal: the spawn wrapper's deadline, or someone else's kill.
    // Either way the runtime never said anything about the container.
    if (proc.signalCode) {
      // The abandoned reads settle whenever the pipe closes; nothing awaits them.
      stdoutRead.catch(() => '');
      stderrRead.catch(() => '');
      return { kind: 'no-answer', reason: `${lookup} did not answer within ${Math.round(timeoutMs / 1000)}s` };
    }
    const [stdout, stderr] = await Promise.all([stdoutRead, stderrRead]);
    if (exitCode !== 0) {
      if (/no such (object|container)/i.test(stderr)) return { kind: 'answered', info: null };
      const said = stderr.split('\n').map(l => l.trim()).find(Boolean) ?? `exit code ${exitCode}`;
      return { kind: 'no-answer', reason: `${lookup} failed: ${said}` };
    }
    const parts = stdout.trim().split(' ');
    if (parts.length < 3) {
      return { kind: 'no-answer', reason: `${lookup} printed something unexpected: ${stdout.trim() || '(nothing)'}` };
    }
    const finishedAt = parts.slice(2).join(' ');
    return {
      kind: 'answered',
      info: {
        running: parts[0] === 'true',
        exitCode: parseInt(parts[1]!, 10),
        // "0001-01-01T00:00:00Z" means never finished (still running or never started).
        finishedAt: finishedAt.startsWith('0001-01-01') ? null : finishedAt,
      },
    };
  } catch (err) {
    return { kind: 'no-answer', reason: `${lookup} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Generate a container name for a task.
 */
export function containerNameForTask(taskShortId: string): string {
  return `lazy-${taskShortId}`;
}

/**
 * Ephemeral run name for `lazy review` — never the work agent's container.
 *
 * Review mounts the same worktree but must not reuse or restamp the work
 * container: credential/harness env is fixed at create time, and sharing the
 * work run name made review clear `session.container_agent_id` (via
 * removeTaskRun) or leave a mismatched stamp. The review command also uses a
 * sibling protocol mailbox (`reviewProtocolDir`) so a live work supervisor
 * cannot consume it. The review container is torn down when the review ends;
 * the work session's container_name / container_agent_id stay untouched.
 */
export function reviewContainerNameForTask(taskShortId: string): string {
  return `lazy-review-${taskShortId}`;
}

/**
 * Ephemeral run name for the MECHANICAL acceptance gate — never the work
 * agent's container. The gate mounts the same worktree but runs NO agent: it
 * exists only to execute the configured check commands in the task's
 * environment. Its own name keeps teardown (which always happens — the gate
 * is ephemeral) from ever touching the work run, and its own protocol mailbox
 * (`acceptGateProtocolDir`) keeps the gate's response away from every other
 * reader.
 */
export function acceptGateContainerNameForTask(taskShortId: string): string {
  return `lazy-gate-${taskShortId}`;
}

/**
 * Build the PID-1 wrapper script that restarts the supervisor between turns.
 *
 * The supervisor runs in --one-shot mode: it processes exactly one command
 * then exits. The wrapper restarts it, which causes Bun (and mimalloc) to
 * release all memory back to the OS. This prevents the ~2GB RSS bloat that
 * accumulates after each turn with the long-lived process model.
 *
 * The wrapper also naturally reaps zombie processes because it is PID 1 and
 * calls `wait` on its children.
 *
 * The wrapper deliberately does NOT kill other processes between turns (the
 * old between-turn sweep was removed — remove-reaper-cap-sweep): anything the
 * agent starts (dev servers, databases, stray orphans) survives turn
 * boundaries. The container is the boundary — everything dies with the
 * container when the task reaches a terminal state (accept/reject/close) or
 * is stopped.
 *
 * Exit code protocol:
 *   0  — turn completed successfully → restart supervisor
 *   42 — stop command received → exit wrapper cleanly
 *   other — unexpected error → exit wrapper with that code
 */
/**
 * Where the task's protocol dir is mounted INSIDE the supervisor container.
 *
 * Never the host path. The host path is `~/.lazy/protocol/<task>` of whoever
 * runs the daemon, and when that is root — a Linux self-host, the lazy daemon
 * image inside a fleet microVM — it sits under `/root`, which is mode 0700 in
 * the runner image. The container runs as the unprivileged `user`, so a
 * same-path mount under `/root` is a directory it cannot even traverse:
 * `command.json` was on the other side of the mount and the supervisor logged
 * "Waiting for command..." for ever (fleet demo runs 5 and 6, 2026-09-21). A
 * Mac never showed it because a user's home is traversable. A fixed
 * top-level path has no ancestor that can be closed to the container user.
 */
export function containerProtocolDir(protocolDir: string): string {
  return `/lazy-protocol/${basename(protocolDir)}`;
}

/**
 * The mounted paths a turn must be able to WRITE, as the container sees them.
 *
 * On native Linux docker a bind mount keeps host ownership, so when the daemon
 * runs as root (a Linux self-host, the daemon image inside a fleet microVM)
 * every one of these is root-owned and the runner image's unprivileged
 * `user` cannot write it: the sandbox's `.claude.json` (fleet demo run 8,
 * "Could not register the lazy MCP tools … EACCES"), the worktree, the
 * worktree's gitdir, the shared objects dir. Docker Desktop maps ownership,
 * which is why no Mac ever saw it. The wrapper takes ownership of what is not
 * writable before each turn (see the `adopt` step); `find -writable` asks the
 * kernel, so on a Mac nothing matches and nothing is changed.
 */
export function supervisorWritablePaths(opts: {
  protocolDir: string;
  worktreePath: string;
  objectsDir?: string;
  worktreeGitDir?: string;
}): string[] {
  return [
    opts.protocolDir,
    opts.worktreePath,
    ...(opts.worktreeGitDir ? [opts.worktreeGitDir] : []),
    ...(opts.objectsDir ? [opts.objectsDir] : []),
    '/home/user/.claude.json',
    '/home/user/.claude',
    '/home/user/.pi',
    '/home/user/.codex',
    '/home/user/.cursor',
  ];
}

export function buildSupervisorWrapperScript(
  protocolDir: string,
  worktreePath: string,
  writablePaths: string[] = [],
  /**
   * Paths inside `writablePaths` that are read-only BY DESIGN — the git
   * pointer copies (src/git/worktree-pointers.ts). Left out of the adopt probe
   * and the chown, which would otherwise fire on every turn and fail on them.
   */
  readOnlyPaths: string[] = [],
): string {
  // Use single quotes for the sh -c wrapper to avoid escaping issues.
  // The paths are injected directly — they come from our own code, not user input.
  const adoptArgs = writablePaths.map((p) => `"${p}"`).join(' ');
  const excl = readOnlyPaths.map((p) => `! -path "${p}"`).join(' ');
  const probe = excl
    ? `    find "$p" ! -writable ${excl} -print -quit 2>/dev/null | grep -q . || continue`
    : '    find "$p" ! -writable -print -quit 2>/dev/null | grep -q . || continue';
  const chown = excl
    ? `sudo -n find "$p" ${excl} -exec chown -h "$(id -u):$(id -g)" {} +`
    : 'sudo -n chown -R "$(id -u):$(id -g)" "$p"';
  return [
    '#!/bin/sh',
    '# PID 1 wrapper — restarts supervisor between turns to release memory.',
    '# Processes the agent leaves running (dev servers, databases) survive turn',
    '# boundaries on purpose; the container is the cleanup boundary.',
    '# adopt: take ownership of a mounted path the container user cannot write.',
    '# A daemon running as root on native Linux leaves every mount root-owned;',
    '# the runner image gives its user sudo for exactly this kind of thing.',
    'adopt() {',
    '  for p in "$@"; do',
    '    [ -e "$p" ] || continue',
    probe,
    '    if command -v sudo >/dev/null 2>&1; then',
    `      ${chown} || echo "lazy: could not take ownership of $p (a root-run daemon on Linux needs this to be writable)" >&2`,
    '    else',
    '      echo "lazy: $p is not writable by $(id -un) and sudo is unavailable — writes there will fail" >&2',
    '    fi',
    '  done',
    '}',
    'child_pid=""',
    'trap \'[ -n "$child_pid" ] && kill $child_pid 2>/dev/null; wait; exit\' TERM INT',
    'while true; do',
    ...(adoptArgs ? [`  adopt ${adoptArgs}`] : []),
    `  lazy-agent --one-shot --protocol-dir "${protocolDir}" --worktree "${worktreePath}" &`,
    '  child_pid=$!',
    '  wait $child_pid',
    '  rc=$?',
    '  child_pid=""',
    '  # 0 = turn done, restart. 42 = stop command, exit. Other = error, exit.',
    '  if [ $rc -ne 0 ] && [ $rc -ne 42 ]; then exit $rc; fi',
    '  if [ $rc -eq 42 ]; then exit 0; fi',
    'done',
  ].join('\n');
}

export interface SupervisorDockerArgsParams {
  binary: string;
  containerName: string;
  imageName: string;
  repoRoot: string;
  sandbox: SandboxConfig;
  protocolDir: string;
  agentBinaryPath: string;
  authEnvVars: Array<{ key: string; value: string }>;
  /**
   * Already-built `-e KEY=VALUE` args for this task's own environment
   * variables (`lazy env set`). Empty for every task that has none.
   * Build with `buildTaskEnvArgs`; see src/daemon/task-env.ts.
   */
  taskEnvArgs: string[];
  /** Already-built `-v ...` args for user-configured [[mounts]]. */
  customMountArgs: string[];
  /**
   * Already-built `-v ...` args for the split `.git` mount — common dir
   * read-only, only objects + this worktree's gitdir writable.
   * Build with `buildTaskGitMounts(root, worktreePath)`; see src/capture/git-mounts.ts.
   */
  gitMountArgs: string[];
  /**
   * Already-built `-p 127.0.0.1:0:<port>` args for the project's `[serve]`
   * ports. Empty when the project declares none, so the argv of every existing
   * task is byte-identical to before. Build with `buildPublishArgs`; see
   * src/serve/ports.ts.
   */
  publishArgs: string[];
  /**
   * Extra `docker run` args from the PROJECT ROOT's `[docker] run_args`,
   * verbatim and in order. Resolve with `resolveDockerRunArgs` — never from a
   * task worktree's lazy.toml (agent-writable; see the INVARIANT there).
   * Empty by default, so the argv is byte-identical when unconfigured.
   */
  runArgs: string[];
  wrapperScript: string;
  /** Path to this container's daemon MCP config, when the daemon minted one. */
  daemonConfigPath?: string;
}

/**
 * Container argv for a detached agent supervisor.
 *
 * Split out of launchSupervisorAsync so the mount set is inspectable without
 * running Docker: test/unit/daemon-dir-never-mounted.test.ts asserts that no
 * mount source exposes the daemon state dir — see the INVARIANT comment there.
 */
export function buildSupervisorDockerArgs(params: SupervisorDockerArgsParams): string[] {
  const {
    binary, containerName, imageName, repoRoot, sandbox, protocolDir,
    agentBinaryPath, authEnvVars, taskEnvArgs, customMountArgs, gitMountArgs,
    publishArgs, runArgs, wrapperScript, daemonConfigPath,
  } = params;

  return [
    binary, 'run', '-d', '--init',
    '--name', containerName,
    // Scope this container to the project so cross-project commands
    // (e.g. `lazy upgrade`) can filter on the label. Kept in sync with
    // PROJECT_LABEL in src/runner/docker-runner.ts.
    '--label', `lazy.project=${repoRoot}`,
    // Allow container to reach host services (daemon MCP, Ollama, etc.)
    '--add-host=host.docker.internal:host-gateway',
    // Mount repo read-only; worktree and protocol dir are mounted read-write on top.
    '-v', `${repoRoot}:${repoRoot}:ro`,
    // Hide .lazy/ (builder config, audit log, sibling worktrees) — see src/capture/lazy-dir-mask.ts.
    ...lazyDataDirMaskArgs(dataDirOfWorktree(repoRoot, sandbox.worktreePath)),
    '-v', `${sandbox.worktreePath}:${sandbox.worktreePath}`,
    // Split .git mount: the shared git dir (refs, packed-refs, config, hooks,
    // sibling worktree gitdirs) is read-only; only objects and this worktree's
    // own gitdir are writable. See src/capture/git-mounts.ts.
    ...gitMountArgs,
    // At a path the container USER can reach — see containerProtocolDir.
    '-v', `${protocolDir}:${containerProtocolDir(protocolDir)}`,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    // Onboarding, theme, folder trust, and MCP discovery — persisted per task in
    // the sandbox so pair and later turns do not replay the first-run wizard.
    // See src/task/claude-home.ts. NOT the human's host ~/.claude.json.
    '-v', `${sandbox.sandboxPath}/.claude.json:/home/user/.claude.json`,
    // Cursor's home-config dir, mounted unconditionally (like .claude): the dir
    // always exists (setupSandbox creates it) and non-Cursor agents ignore it.
    '-v', `${sandbox.sandboxPath}/.cursor:/home/user/.cursor`,
    // pi's home-config dir (sessions, models.json, the lazy MCP bridge) —
    // same unconditional mount rationale as .cursor.
    '-v', `${sandbox.sandboxPath}/.pi:/home/user/.pi`,
    // Codex's home-config dir, same arrangement — config.toml, auth state and
    // session rollouts persist per task in the sandbox.
    '-v', `${sandbox.sandboxPath}/.codex:/home/user/.codex`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    // This task's own env vars (`lazy env set`), FIRST — docker resolves a
    // repeated -e by last-one-wins, so placing these ahead of everything lazy
    // sets makes them strictly lower precedence: they can only ever ADD to the
    // environment, never redirect lazy's auth, model routing, daemon connection
    // or GIT_SSH_COMMAND. Reserved names are already refused at intake; this is
    // the second line of defense, and it matches the host-process runner, which
    // spreads the task env before its own auth vars for the same reason.
    // Empty by default. The order is pinned by test/unit/task-env.test.ts.
    ...taskEnvArgs,
    ...authEnvVars.flatMap(v => ['-e', `${v.key}=${v.value}`]),
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    // Pass daemon config to container for MCP proxy mode. The config file is the
    // ONLY thing from the daemon state dir a container may ever see: a single
    // file, read-only, holding just this container's own token.
    ...(daemonConfigPath ? [
      '-v', `${daemonConfigPath}:${daemonConfigPath}:ro`,
      '-e', `LAZY_DAEMON_CONFIG=${daemonConfigPath}`,
    ] : []),
    // User-configured custom mounts. Appended after the standard worktree mount
    // so a {worktree}/node_modules volume clearly shadows it (Docker resolves
    // overlapping mounts by longest container-path match regardless of order).
    ...customMountArgs,
    // [serve] ports, published to ephemeral loopback host ports. Published
    // ports are fixed at container CREATE time — editing [serve] takes effect
    // the next time this task's container is created.
    ...publishArgs,
    // User-configured extra `docker run` args ([docker] run_args) — verbatim,
    // in order, last before the image name so they can only be docker flags,
    // never rewrite the image or the command. Root-config only; see
    // resolveDockerRunArgs.
    ...runArgs,
    imageName,
    'sh', '-c', wrapperScript,
  ];
}

/**
 * Launch the supervisor in a detached Docker container.
 * The supervisor watches for commands from the host via the protocol directory.
 * Returns immediately after the container starts.
 *
 * Uses a PID-1 wrapper script that restarts the supervisor between turns
 * so that memory is released back to the OS after each turn.
 */
/**
 * Classify the outcome of `docker run --entrypoint which <image> <binary>`.
 *
 * Only exit code 1 means "binary genuinely absent" (`which` found nothing).
 * Docker-level failures and probe infrastructure failures must not be reported
 * as a missing agent binary — that was the misreporting bug this hardening fixes.
 *
 * Exported for direct unit coverage.
 */
export type AgentBinaryProbeContext = {
  imageName: string;
  agentId: string;
  agentBinary: string;
  dockerfileRelativePath: string;
  installCommand: string;
};

export type AgentBinaryProbeClassification =
  | { kind: 'ok' }
  | { kind: 'missing-binary' }
  | { kind: 'error'; message: string };

export function classifyAgentBinaryProbeResult(
  exitCode: number | null,
  signalCode: string | null,
  stderr: string,
  ctx: Pick<AgentBinaryProbeContext, 'imageName' | 'agentId' | 'agentBinary'>,
): AgentBinaryProbeClassification {
  const target =
    `image "${ctx.imageName}" for '${ctx.agentBinary}' (agent "${ctx.agentId}")`;

  if (exitCode === 0) {
    return { kind: 'ok' };
  }

  const stderrTrimmed = stderr.trim();
  const stderrSuffix = stderrTrimmed ? `\nDocker stderr:\n${stderrTrimmed}` : '';

  if (exitCode === null && signalCode === 'SIGTERM') {
    return {
      kind: 'error',
      message:
        `Timed out probing ${target} after 60s.` +
        stderrSuffix,
    };
  }

  // Exit 1 is `which`'s documented not-found code (see `which(1)`); it is the
  // ONLY outcome that may claim the agent binary is absent from the image.
  if (exitCode === 1) {
    return { kind: 'missing-binary' };
  }

  if (exitCode === 125) {
    return {
      kind: 'error',
      message:
        `Failed to start a probe container for ${target} (docker exit 125).` +
        stderrSuffix,
    };
  }

  if (exitCode === 126) {
    return {
      kind: 'error',
      message:
        `Probe container for ${target} could not execute 'which' (docker exit 126).` +
        stderrSuffix,
    };
  }

  if (exitCode === 127) {
    return {
      kind: 'error',
      message:
        `Probe container for ${target} has no 'which' command (docker exit 127). ` +
        `The agent-binary preflight requires 'which' in the image.` +
        stderrSuffix,
    };
  }

  return {
    kind: 'error',
    message:
      `Unexpected result probing ${target} ` +
      `(exit ${exitCode ?? 'null'}${signalCode ? `, signal ${signalCode}` : ''}).` +
      stderrSuffix,
  };
}

function missingAgentBinaryMessage(ctx: AgentBinaryProbeContext): string {
  return (
    `The custom Dockerfile image "${ctx.imageName}" does not contain '${ctx.agentBinary}', ` +
    `which the "${ctx.agentId}" agent needs. Lazy never amends custom Dockerfiles — ` +
    `add this line to ${ctx.dockerfileRelativePath} (in the non-root user section) and relaunch:\n` +
    `  ${ctx.installCommand}\n` +
    `The image rebuilds automatically on the next launch once the file changes.`
  );
}

/**
 * Verify a non-claude agent's binary exists in the image that is about to run.
 *
 * Only applies when the project uses a CUSTOM Dockerfile: the default image
 * carries every agent CLI (src/docker/runner-dockerfile.ts), but custom
 * Dockerfiles are deliberately never amended, so the human must add the
 * install line themselves — and the failure mode without this check is a
 * supervisor whose work phase can never succeed. The probe is a throwaway
 * `docker run --rm <image> which <binary>` (same pattern as
 * probeProjectsDirWritable): accurate even when the binary comes from a base
 * image rather than a visible RUN line.
 *
 * Exported for direct unit coverage.
 */
export async function preflightAgentBinaryInImage(
  imageName: string,
  binary: string,
  agentId?: string,
): Promise<void> {
  if (!agentId) return;
  const lazyRoot = getLazyRoot();
  if (!(await resolveCustomDockerfile(lazyRoot))) return; // the default image carries every agent CLI

  // `agentId` names a PROFILE; the binary that has to exist in the image is its
  // HARNESS. Resolved after the check above so the default-image path — every
  // project that has not written its own Dockerfile — still costs no config
  // read. Lenient (an unset profile falls back to the name itself) so an
  // unregistered name still reaches getAgentPackaging and throws there.
  const config = await loadConfig(lazyRoot);
  const harness = harnessForAgentName(config, agentId) ?? agentId;
  if (harness === 'claude-code') return;

  const pkg = getAgentPackaging(harness);
  const agentBinary = pkg.binaryName();
  const probeCtx: AgentBinaryProbeContext = {
    imageName,
    agentId: harness,
    agentBinary,
    dockerfileRelativePath: config.docker.dockerfile || CONVENTIONAL_DOCKERFILE,
    installCommand: pkg.dockerInstallCommand(),
  };

  // Pin --entrypoint to `which` so a custom image's own ENTRYPOINT cannot
  // receive `which <binary>` as arguments and pass/fail for the wrong reason.
  // --network none: the probe needs no network and must not inherit one.
  const probe = spawn(
    [binary, 'run', '--rm', '--network', 'none', '--entrypoint', 'which', imageName, agentBinary],
    { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
  );
  const [, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stderr).text(),
  ]);
  const classification = classifyAgentBinaryProbeResult(
    probe.exitCode,
    probe.signalCode ?? null,
    stderr,
    probeCtx,
  );

  if (classification.kind === 'ok') return;
  if (classification.kind === 'missing-binary') {
    throw new Error(missingAgentBinaryMessage(probeCtx));
  }
  // The probe is the first container made from the image, so a torn layer
  // surfaces here before the launch itself: typed, so the launch repairs it.
  if (isDamagedLayerError(stderr)) throw new DamagedImageError(imageName, classification.message);
  throw new Error(classification.message);
}

/**
 * Which `ensureImage` call rebuilds `imageName`, or null when lazy must not
 * rebuild it by itself: lazy's DEFAULT image, or the project's OWN image (the
 * root Dockerfile or a ref adoption — the daemon's boot build owns it, hence
 * `bypassGate`, exactly as an admin's Rebuild runs it). A task-pinned image or
 * a worktree adoption's soft-pinned image is a person's choice: never rebuilt
 * from a launch (see AGENTS.md, "Task worktrees never auto-govern container
 * images").
 */
async function runnerImageRebuildOptions(imageName: string): Promise<EnsureImageOptions | null> {
  const lazyRoot = getLazyRoot();
  const defaultRepo = await resolveImageRepository(lazyRoot, true);
  if (imageName === `${defaultRepo.repository}:${IMAGE_TAG}`) return { useDefaultImage: true };
  const { loadValidAdoptedImage } = await import('../daemon/adopted-image');
  const adopted = await loadValidAdoptedImage(lazyRoot);
  if (adopted && adopted.source?.kind !== 'ref' && adopted.imageName === imageName) return null;
  const project = await resolveImageRepository(lazyRoot);
  if (project.isCustom && imageName === `${project.repository}:${IMAGE_TAG}`) return { bypassGate: true };
  return null;
}

/**
 * The docker and build steps of a damaged-image repair (src/docker/damaged-image.ts):
 * a forced rebuild without the cache — the same build an admin's Rebuild runs,
 * so neither the build cache nor the published image can hand back the torn
 * layer. Inside the daemon the image's own build does it (the gate's
 * `repair`: visible on the build page, cancellable, tracked state kept true);
 * only outside the daemon does the launch build inline.
 */
export function runnerImageRepairDeps(binary: string): DamagedImageRepairDeps {
  return {
    binary,
    canRebuild: async (imageName) => (await runnerImageRebuildOptions(imageName)) !== null,
    rebuild: async (imageName) => {
      const options = await runnerImageRebuildOptions(imageName);
      if (!options) throw new Error(`${imageName} is not an image lazy rebuilds by itself`);
      const gate = customImageGate();
      if (gate?.repair) return gate.repair(imageName);
      return ensureImage(binary, { ...options, rebuild: true, noCache: true });
    },
    collectEvidence: async (imageName, dockerMessage) => {
      const { collectDamagedImageEvidence } = await import('../docker/damaged-image-evidence');
      return collectDamagedImageEvidence({ binary, imageName, dockerMessage });
    },
  };
}

/**
 * Launch a task's supervisor container. A launch that fails because the
 * runner image's layers cannot be extracted (a damaged image store) removes
 * that image, rebuilds it and is retried once, narrated through `notify` —
 * see src/docker/damaged-image.ts.
 */
export async function launchSupervisorAsync(
  ...args: Parameters<typeof launchSupervisorOnce>
): Promise<void> {
  const binary = args[4] ?? 'docker';
  return withDamagedImageRepair(
    { ...runnerImageRepairDeps(binary), subject: 'task', ...(args[7] ? { taskId: args[7] } : {}), ...(args[11] ? { notify: args[11] } : {}) },
    () => launchSupervisorOnce(...args),
  );
}

async function launchSupervisorOnce(
  sandbox: SandboxConfig,
  containerName: string,
  protocolDir: string,
  debug: boolean = false,
  binary: string = 'docker',
  daemonConfigPath?: string,
  target?: RoleTarget,
  taskId?: string,
  taskUuid?: string,
  /**
   * The task's agent PROFILE name (`[agents.<name>]`), not a harness. The
   * harness it runs is resolved from config below; everything downstream that
   * asks "is this codex / cursor / pi" must ask the harness, and the launch
   * grant carries this name so the proxy can route per profile.
   */
  agentId?: string,
  /**
   * Task-pinned image from metadata.custom_image. Threaded from the daemon
   * launch path — never resolved from the worktree here.
   */
  pinnedImage?: string,
  /**
   * Narration sink for the caller's open phase. See RunnerInterface.launchSupervisor.
   */
  notify?: PhaseNotify,
): Promise<void> {
  // Image resolution is deliberately NOT anchored at sandbox.worktreePath:
  // a task branch that edits Dockerfile.lazy must never auto-govern the image.
  // Human-consented pins arrive as pinnedImage from task metadata only.
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary, { pinnedImage, notify }),
    ensureAgentBinary(),
  ]);
  notify?.(`image ${imageName} ready — starting container ${containerName}`);

  // Custom Dockerfiles are never amended by lazy, so a non-claude agent's
  // binary may simply not be in the image. Verify it BEFORE launching the
  // supervisor — otherwise the missing binary only surfaces inside the work
  // phase (a cursor task on this repo's own Dockerfile.lazy crash-looped for
  // a whole session this way before the failure was even classified).
  await preflightAgentBinaryInImage(imageName, binary, agentId);

  const repoRoot = getLazyRoot();

  // `agentId` names a PROFILE (`[agents.<name>]`). Everything below that used to
  // compare it against a harness name — which credential to mint, which proxy
  // env to build — needs the HARNESS this launch actually runs, so resolve the
  // profile ONCE, here. The daemon owns config: a container must never
  // re-derive this from the task worktree's lazy.toml, which its own agent can
  // edit (same governance rule as Dockerfile.lazy).
  //
  // Strict — it throws naming the available profiles — because every fallback
  // available to a launch that cannot say what it is running is a direct-egress
  // path: a cursor or codex turn treated as "some other agent" gets no
  // CURSOR_API_ENDPOINT / LAZY_CODEX_API_BASE and dials the vendor's servers
  // with nothing audited.
  //
  // This is also the config `buildMountArgs` and the proxy env below read; one
  // load serves all of them.
  const config = await loadConfig(repoRoot);
  const profile = profileForAgentName(config, agentId, taskId ? `task ${taskId}` : 'this launch');
  const harness = profile.harness;
  // Named only when it adds information: when the profile and the harness are
  // the same word (`codex`, `cursor`), "(profile "codex")" is noise. Keyed on
  // the NAMES rather than on `builtin`, because the built-in set now includes
  // profiles whose name is not their harness — `codex-subscription` runs codex,
  // and a refusal saying "the codex agent" sends a user looking for something
  // they did not start.
  const profileNote = profile.name === harness ? '' : ` (agent profile "${profile.name}")`;

  // In team mode the task has a session binding (made by the launcher, which
  // decided whose credential this turn runs on), and the launch placeholderizes
  // THAT credential instead of the daemon's own — in the env var mirroring the
  // owner's credential kind. Null for every single-user install, where this
  // falls through to the daemon's own credential exactly as before.
  const sessionCredential = taskUuid ? await sessionCredentialEnvFor(repoRoot, taskUuid) : null;

  // Supervisor launches are always the `agent` role; the task turn it runs
  // inherits this env, so proxied traffic is attributed to agent + task.
  let authEnvVars: Array<{ key: string; value: string }>;
  // The launch identity every placeholder minted below is bound to. The proxy
  // derives attribution from the grant rather than from the self-reported
  // x-lazy-* headers, so this is what the audit trail ends up asserting.
  // The task's agent IS its profile name, so the grant carries where this
  // turn's traffic should be forwarded (src/proxy/agent-upstreams.ts).
  const agentIdentity: LaunchIdentity = {
    role: 'agent',
    taskId: taskId ?? null,
    label: containerName,
    profile: profileNameForAgent(agentId),
    // What a team-mode proxy finds the turn's principal by — never the code.
    ...(taskUuid ? { taskUuid } : {}),
  };
  // pi deliberately takes the claude-code path below: it has no credential of
  // its own — its turns RUN ON lazy's Anthropic/Ollama credentials via the
  // proxy — so a missing credential must fail the launch, not degrade to the
  // best-effort merge-phase forwarding of the non-claude branch.
  //
  // Branching on the HARNESS, not on the profile name: `[agents.work-codex]`
  // runs codex and must take the codex path.
  if (harness !== 'claude-code' && harness !== 'pi') {
    // Non-claude task agent: its own credentials are what the turn needs.
    // Resolved at LAUNCH time (env override → per-project .lazy credentials
    // file), so a key set while the daemon is running takes effect on the
    // next launch — never "restart the daemon". See src/agent/credentials.ts.
    authEnvVars = [];
    // `none` is a profile pointed at a server that authenticates nobody: there
    // is no key to require, and requiring one would make a local codex upstream
    // unreachable. Every other slot must resolve, or this launch 401s mid-turn.
    if (agentSupportsApiKey(harness) && profile.credential !== NO_CREDENTIAL) {
      // Keyed by the PROFILE's credential, not by the harness: two profiles on
      // the same harness can bill different keys, and the proxy resolves the
      // profile's slot per request — so a check keyed by harness could pass on
      // a key the request is never sent with.
      //
      // TEAM MODE (a session binding exists) never reads the project's store:
      // the proxy pays this turn with its principal's own credential for the
      // profile, which planTurnCredential already required before this launch.
      // The placeholder is still minted — its grant is what the proxy resolves.
      const key = sessionCredential
        ? { source: 'the turn principal\'s own credential for the profile' }
        : await resolveProfileCredential(getLazyRoot(), profile);
      if (!key) {
        // Name the command after the PROFILE the user chose when that says more
        // than the credential does — `lazy auth` resolves an agent name to the
        // credential it bills, so `lazy auth import codex-subscription` is a
        // command they can paste without first learning a second vocabulary.
        // Only when the profile's name is not simply the harness (where the two
        // are the same word), and only when `lazy auth` really would resolve it
        // back to this same credential — a config that names a profile after
        // some other profile's credential must not be handed a wrong command.
        const namedByProfile =
          profile.name !== harness &&
          resolveCredentialTarget(config, profile.name).credential === profile.credential;
        const setupCommand = credentialSetupCommand(
          profile.credential,
          namedByProfile ? profile.name : undefined,
        );
        // A container cannot see the host's login session, so no key from any
        // source means every turn would fail on auth. Refuse the launch with
        // the remedy instead.
        throw new Error(
          // Named by the AGENT the task actually selected, with the harness in
          // brackets when it differs: a `codex-subscription` task refused with
          // "the codex agent" sends a user looking for something they did not
          // start, which is exactly how this refusal was first read.
          `No ${profile.credential} credential for the "${profile.name}" agent` +
          `${profile.name === harness ? '' : ` (${harness})`}. A container ` +
          `cannot use a host login session, so this task needs a credential from one of:\n` +
          `  1. lazy ${setupCommand}   (OS secure storage, outside the repo — takes effect on the next launch)\n` +
          `  2. the ${envVarsFor(profile.credential).join(' or ')} environment variable (override)` +
          alternativeCredentialHint(harness, profile.credential)
        );
      }
      // JIT INJECTION: the container gets a PLACEHOLDER, never the key. The
      // real key is resolved above only to prove one EXISTS (a container has no
      // login session to fall back on) — its value is then dropped on the floor
      // and the proxy re-resolves it per request, upstream.
      const agentEnvKey = AGENT_KEY_ENV[harness]!;
      const placeholder = await mintCredentialGrant(getLazyRoot(), {
        ...agentIdentity, envKey: agentEnvKey,
      });
      authEnvVars.push({ key: agentEnvKey, value: placeholder });
      logger.debug(`Resolved ${harness} API key from ${key.source}; container gets a placeholder`);
    }
    // The proxy address (ANTHROPIC_BASE_URL and friends) is still assembled
    // here. A credential rides along only on a single-user install, where it
    // is the user's own; in TEAM MODE a codex or cursor turn carries none at
    // all (teamModeLaunchCreds) — the merge phase runs the task's own harness
    // (src/supervisor/merge.ts), so nothing in the turn needs the owner's
    // Claude credential, and holding it would let the agent spend it. Its
    // absence must not block a task that never authenticates against Anthropic.
    try {
      authEnvVars = [
        ...(await getLaunchAuthEnvVars(
          agentIdentity, target, { role: 'agent', taskId }, 'container', sessionCredential ?? undefined
        )),
        ...authEnvVars,
      ];
    } catch (err) {
      // Distinguish "there is no credential" from "resolving it BROKE". The
      // first is ordinary \u2014 a cursor task need not have an Anthropic key. The
      // second means the
      // grant registry or the proxy wiring is faulty, and letting that log at
      // debug as a missing credential is how a broken security path stays
      // invisible (AGENTS.md: distinguish not-found from found-but-broken).
      const message = err instanceof Error ? err.message : String(err);
      const merelyAbsent = /no .*credential|not authenticated|setup-token|ANTHROPIC_API_KEY/i.test(message);
      if (merelyAbsent) {
        logger.debug(
          `No Anthropic credential forwarded to ${harness} task container${profileNote} ` +
          `(its own harness does not use one): ${message}`
        );
      } else {
        logger.warn(
          `[proxy] could not build the placeholder auth env for the ${harness} task container${profileNote}: ` +
          `${message}. The launch continues without an Anthropic placeholder. This is not a ` +
          `missing key — it is a failure to mint or resolve one.`
        );
      }
    }
  } else {
    authEnvVars = await getLaunchAuthEnvVars(
      agentIdentity, target, { role: 'agent', taskId }, 'container', sessionCredential ?? undefined
    );
  }

  // Cursor API traffic routes through lazy's proxy exactly like Anthropic's,
  // via cursor-agent's endpoint override. The launch's PLACEHOLDER rides in the
  // URL path rather than a header because cursor's -H flag does not cover every
  // request (see src/proxy/cursor-route.ts); the proxy authenticates it there
  // and swaps in the real CURSOR_API_KEY upstream.
  authEnvVars.push(...cursorLaunchEnvVars({
    harness,
    // Container surface: `binary` is the container runtime for this launch.
    runnerType: binary === 'podman' ? 'podman' : 'docker',
    proxyPort: hasDaemonContext() ? getDaemonContext().proxyPort : undefined,
    bind: config.proxy.bind,
    token: authEnvVars.find(v => v.key === AGENT_KEY_ENV.cursor)?.value ?? null,
  }));

  // pi launch env: provider selection + no-startup-egress flags, and a mirror
  // of a claude-shaped OAuth placeholder into an env var pi actually reads.
  // The PROFILE decides which of pi's providers the turn runs and which model
  // that provider declares — the supervisor holds no config and cannot resolve
  // a profile itself, so this env is how the daemon states the answer.
  // No-ops for every other harness. See src/agent/pi-turn-config.ts.
  if (harness === 'pi') {
    authEnvVars.push(...piLaunchEnvVars({
      harness,
      profile,
      upstreamTimeoutMs: (config.proxy.upstreamTimeoutSeconds ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS) * 1000,
    }));
    authEnvVars.push(...piCredentialMirror(authEnvVars));
  }

  // Codex API traffic routes through the proxy's OpenAI-compatible route. No
  // token in the URL: codex bearers the OPENAI_API_KEY placeholder (minted
  // above) on every provider request, which is what the proxy authenticates.
  // The env var carries the route base into the supervisor, which writes it
  // into ~/.codex/config.toml each turn — see src/proxy/codex-route.ts.
  authEnvVars.push(...codexLaunchEnvVars({
    harness,
    runnerType: binary === 'podman' ? 'podman' : 'docker',
    proxyPort: hasDaemonContext() ? getDaemonContext().proxyPort : undefined,
    bind: config.proxy.bind,
    endpoint: profile.endpoint,
  }));

  // Resolve user-configured custom mounts ([[mounts]]). Validated at load time;
  // here we just expand placeholders and build the `-v` args. Empty by default,
  // so default behavior is completely unchanged when no mounts are configured.
  const customMountArgs = buildMountArgs(config.mounts, {
    worktreePath: sandbox.worktreePath,
    repoRoot,
  });

  // This task's own environment variables (`lazy env set`). Read from the
  // daemon state dir — never from the repo, which is mounted into every
  // container. See src/daemon/task-env.ts. Empty unless the user set one, so
  // the argv is byte-identical to before for every other task. Keyed by the
  // task UUID, not the ref — see RunnerInterface.launchSupervisor.
  //
  // Delivered through a 0600 --env-file deleted once `docker run` exits, so the
  // values never sit in the host process table (`docker inspect` still shows
  // them — see writeTaskEnvLaunchFile).
  const taskEnv = taskUuid ? await getTaskEnv(repoRoot, taskUuid) : {};
  // What this container is created with, so a later reuse can tell whether
  // `lazy env set` has changed it since (mustRecreateForTaskEnv).
  if (taskUuid) await recordTaskEnvLaunched(repoRoot, taskUuid, containerName, taskEnv);
  const taskEnvLaunch = planTaskEnvLaunchFile(repoRoot, containerName, taskEnv);
  const taskEnvArgs = taskEnvLaunch.args;

  // Split .git mount plus read-only pointer copies — see buildTaskGitMounts.
  const { paths: gitMountPaths, args: gitMountArgs, pointerTargets } = await buildTaskGitMounts(repoRoot, sandbox.worktreePath);

  // [serve] ports. Resolved and validated at config load time; here we only
  // turn them into publish args. Empty for a project with no [serve] section.
  const publishArgs = buildPublishArgs(config.serve.services);

  // Extra `docker run` args ([docker] run_args) — root-anchored on purpose:
  // never resolved from the task worktree's lazy.toml (see resolveDockerRunArgs).
  const runArgs = await resolveDockerRunArgs(repoRoot);
  if (runArgs.length > 0) {
    logger.info(`Applying extra docker run args from [docker] run_args: ${runArgs.join(' ')}`);
  }

  const wrapperScript = buildSupervisorWrapperScript(
    containerProtocolDir(protocolDir),
    sandbox.worktreePath,
    supervisorWritablePaths({
      protocolDir: containerProtocolDir(protocolDir),
      worktreePath: sandbox.worktreePath,
      objectsDir: gitMountPaths.objectsDir,
      worktreeGitDir: gitMountPaths.worktreeGitDir,
    }),
    pointerTargets,
  );

  // Daemon MCP config is provided by the caller (daemon task launcher).
  // The daemon always provides this when launching containers — it knows
  // its own webPort and token, so there's no fallback or race condition.

  const args = buildSupervisorDockerArgs({
    binary,
    containerName,
    imageName,
    repoRoot,
    sandbox,
    protocolDir,
    agentBinaryPath,
    authEnvVars,
    taskEnvArgs,
    customMountArgs,
    gitMountArgs,
    publishArgs,
    runArgs,
    wrapperScript,
    daemonConfigPath,
  });

  if (debug) {
    // Per-task values are secret whatever their key is named — the user set
    // them here precisely because they are.
    console.log('[DEBUG] Running container command:', redactSecrets(args, Object.keys(taskEnv)).join(' '));
  }

  logger.info('Launching supervisor container...');
  notify?.(`starting supervisor container ${containerName}`);

  // Async spawn (not spawnSync) so a wedged `docker run` can never block the
  // daemon event loop. We own the timeout explicitly (wrapper timer disabled via
  // timeout: 0) so a timeout produces an actionable error rather than an opaque
  // signal exit code: on deadline we kill the process, which closes its streams
  // and lets the reads below resolve.
  //
  // This launch's grants are reused from earlier turns, pinned to an earlier
  // container's address. Unpin them before the new container exists, or its
  // first request would be refused; they are pinned to it once it is up.
  await pinGrantsToAddresses(getLazyRoot(), containerName, null);

  // The task env file exists only for the life of `docker run`: written here,
  // removed in the finally below (docker has read it by the time run exits).
  await taskEnvLaunch.write();
  const proc = await (async () => {
    try {
      return spawn(args, { stdout: 'pipe', stderr: 'pipe', timeout: 0 });
    } catch (err) {
      await taskEnvLaunch.cleanup();
      throw err;
    }
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process may have already exited — nothing to kill.
    }
  }, CONTAINER_LAUNCH_TIMEOUT_MS);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    await taskEnvLaunch.cleanup();
  }

  if (timedOut) {
    const msg =
      `Timed out after ${CONTAINER_LAUNCH_TIMEOUT_MS / 60_000}m launching supervisor container ${containerName}. ` +
      `The container runtime (${binary}) may be unresponsive or stuck pulling an image — ` +
      `check \`${binary} info\` and \`${binary} ps\`, then retry.`;
    logger.error(msg);
    throw new Error(msg);
  }

  if (exitCode !== 0) {
    const errText = stderr.trim();
    logger.error(`Failed to launch supervisor container: ${errText}`);
    if (isDamagedLayerError(errText)) throw new DamagedImageError(imageName, `Failed to launch supervisor container: ${errText}`);
    throw new Error(`Failed to launch supervisor container: ${errText}`);
  }

  logger.debug(`Supervisor container ${containerName} launched`);

  await pinLaunchGrantsToContainer(binary, containerName, sessionCredential && taskUuid ? taskUuid : undefined);

  // Recorded once the container is actually up, so every surface DERIVES which
  // image a task runs on (the default-image banner and its "restart with the
  // project's image" action) rather than guessing. Best-effort: the turn is
  // already running, and a lost record only costs the banner its accuracy.
  await recordLaunchImage(
    taskId, imageName,
    pinnedImage === DEFAULT_RUNNER_IMAGE_PIN ? 'default'
      : pinnedImage === READONLY_DEFAULT_RUNNER_IMAGE_PIN ? 'readonly-default'
      : pinnedImage ? 'pinned' : 'project',
    containerName,
  ).catch((err: unknown) => {
    logger.warn(`Could not record which image ${containerName} runs on (${imageName}): ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Pin the launch's credential grants to the container's own addresses, so a
 * placeholder that leaks out of it cannot be spent from a sibling container
 * (src/proxy/credential-broker.ts, grantAcceptsPeer).
 *
 * Linux docker only, exactly like member terminals' pins
 * (src/daemon/member-container.ts): there the proxy sees each container's own
 * bridge address — decided by {@link containerGatewayIsLocal}, since Docker
 * Desktop (any OS), rootless runtimes and a remote DOCKER_HOST present every
 * container from one other address, where a pin would refuse the container's
 * own traffic. Best-effort: the turn is already
 * running, and an unpinned grant is what every launch had before — so a
 * failed read is a warning, never a failed launch.
 */
async function containerGatewayIsLocal(binary: string, containerName: string): Promise<boolean> {
  const proc = spawn(
    [binary, 'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}', containerName],
    { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return false;
  const gateways = stdout.split(/\s+/).filter(Boolean);
  if (gateways.length === 0) return false;
  const local = new Set(Object.values(networkInterfaces()).flatMap(list => (list ?? []).map(i => i.address)));
  return gateways.every(g => local.has(g));
}

async function pinLaunchGrantsToContainer(
  binary: string,
  containerName: string,
  /** Team mode: the task whose turn-session placeholder this container holds. */
  sessionBindingTaskId?: string,
): Promise<void> {
  if (process.platform !== 'linux' || binary !== 'docker') return;
  try {
    // Only where the proxy really sees the container's own address: the
    // container's network gateway must be an address of THIS host. That holds
    // for native rootful dockerd and is false for Docker Desktop for Linux (a
    // VM), rootless Docker (traffic leaves from the host's address) and a
    // remote DOCKER_HOST — where a pin would refuse every request of the turn.
    if (!(await containerGatewayIsLocal(binary, containerName))) {
      logger.debug(`${containerName}: the container's gateway is not on this host; its proxy credential is not pinned.`);
      return;
    }
    const proc = spawn(
      [binary, 'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', containerName],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || `${binary} inspect exited ${code}`);
    const addresses = stdout.split(/\s+/).filter(Boolean);
    if (addresses.length === 0) {
      logger.warn(`${containerName} has no network address (host networking?); its proxy credential is not pinned to it.`);
      return;
    }
    await pinGrantsToAddresses(getLazyRoot(), containerName, addresses);
    // The team-mode turn placeholder pins the same way member terminals' do —
    // to ONE address, which a container on a single network has.
    if (sessionBindingTaskId && addresses.length === 1) {
      await setSessionBindingOrigin(getLazyRoot(), sessionBindingTaskId, addresses[0]!);
    }
  } catch (err) {
    logger.warn(
      `Could not pin ${containerName}'s proxy credential to its address: ` +
      `${err instanceof Error ? err.message : String(err)}. It is accepted from any address this turn.`,
    );
  }
}
