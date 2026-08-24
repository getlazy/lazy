import { createHash, randomUUID } from 'crypto';
import { readFileSync, existsSync, mkdirSync, chmodSync, unlinkSync, renameSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { tmpdir } from 'os';
import type { AgentResponse, TokenUsage } from '../types';
import { ClaudeCodeAgent } from '../agent/claude-code';
import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { getAgentPackaging } from '../agent/registry';
import { agentSupportsApiKey, resolveAgentApiKey, AGENT_KEY_ENV } from '../agent/credentials';
import { findLazyRoot } from '../cli/init';
import { loadConfig } from '../config/loader';
import type { RoleTarget } from '../config/types';
import { buildMountArgs } from './mounts';
import { buildGitMountArgsFor } from './git-mounts';
import { targetEnvVars, ANTHROPIC_DEFAULT_TARGET, LOCAL_BACKEND_CREDS, type ProxyAuditHints, type LaunchSurface } from '../utils/role-target';
import { cursorLaunchEnvVars } from '../proxy/cursor-route';
import { placeholderizeAuthEnv, type LaunchIdentity } from '../proxy/placeholder-env';
import { mintCredentialGrant } from '../proxy/credential-broker';
import { hasDaemonContext, getDaemonContext } from '../daemon/context';
// Cycle: auth-env imports getAuthEnvVars from this module. Safe — both sides
// are hoisted function declarations, called at request time, never during
// module evaluation.
import { resolveAuthEnvFromDaemon } from '../daemon/auth-env';
import { logger } from '../utils/logger';
import { redactSecrets } from '../utils/redact';
import { isOfflineMode } from '../utils/offline';
import { spawn } from '../utils/spawn';
import { safeArgvPrompt } from '../agent/argv-safety';
import { markMachineOneshotPrompt } from '../import/machine-oneshot';
import DEFAULT_DOCKERFILE from '../docker/base.Dockerfile' with { type: 'text' };

// Re-export so other modules (e.g. `lazy system export-dockerfile`) can use the
// exact same embedded text as the single source of truth — never copy it.
export { DEFAULT_DOCKERFILE };
import { getHome } from '../utils/home';
import { toTurnUsage } from '../utils/usage-recording';
import { VERSION } from '../version';
import { IMAGE_NAME, DOCKERFILE_HASH_LABEL, IMAGE_TAG, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS } from './image-tag';

// Re-exported so callers keep importing the image identity from one place.
export { IMAGE_TAG, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS };

// Embedded at build/compile time — the agent binary is bundled into the lazy executable.
// In dev mode this resolves to the placeholder file on disk (which is empty/tiny).
// In compiled mode it resolves to a $bunfs/ path inside the executable.
// A placeholder lazy-agent file must exist at the project root for this import to resolve.
import embeddedAgentBinaryPath from '../../lazy-agent' with { type: 'file' };

import {
  verifyAgentBinary,
  verifyAgentBinaryBytes,
  formatAgentBinaryError,
  MIN_AGENT_BINARY_SIZE,
} from '../agent/binary-identity';

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

  const proc = spawn([binary, 'info'], { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const name = binary.charAt(0).toUpperCase() + binary.slice(1);
    throw new Error(`${name} is not installed or not running. Install ${name}: https://docs.${binary}.com/get-${binary}/`);
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
 * Resolve the custom Dockerfile path.
 * Returns the absolute path if one is in effect and the file exists, null
 * otherwise (default image).
 *
 * Resolution:
 * 1. `LAZY_DOCKERFILE_LAZY` (env override, same family as LAZY_CONFIG): used
 *    verbatim when absolute, resolved against the project root when relative.
 *    Forces custom-image mode even when [docker].dockerfile is unset. Works
 *    uniformly across every command AND the daemon (spawned daemons inherit
 *    the environment), which is the point: export it, `lazy upgrade`, and the
 *    build and every subsequent launch agree on the file. Intended for
 *    developing lazy itself (testing a branch's Dockerfile before it merges)
 *    and for e2e fixtures.
 * 2. `[docker].dockerfile` from config, joined to the PROJECT ROOT.
 *
 * INVARIANT: a task's worktree must never govern the image. Task branches are
 * agent-writable, and deriving the image from one would let an agent's
 * Dockerfile.lazy edits execute as build steps under the daemon's docker on
 * the HOST (build-time RUN runs outside every container guard). Launch paths
 * therefore never anchor image resolution at the task worktree.
 *
 * Exported for `lazy upgrade`'s image-source announcement.
 */
export async function resolveCustomDockerfile(lazyRoot: string): Promise<string | null> {
  const override = process.env.LAZY_DOCKERFILE_LAZY;
  if (override) {
    const absPath = isAbsolute(override) ? override : join(lazyRoot, override);
    if (!existsSync(absPath)) {
      throw new Error(
        `LAZY_DOCKERFILE_LAZY is set to '${override}' (resolved to ${absPath}) but the file does not exist. ` +
        `Unset it with LAZY_DOCKERFILE_LAZY= or fix the path.`
      );
    }
    return absPath;
  }

  const config = await loadConfig(lazyRoot);
  const configPath = config.docker.dockerfile;
  if (!configPath) return null;

  const absPath = join(lazyRoot, configPath);
  if (!existsSync(absPath)) {
    throw new Error(
      `Custom Dockerfile not found: ${configPath} (resolved to ${absPath}). ` +
      `Check the [docker].dockerfile setting in lazy.toml.`
    );
  }
  return absPath;
}

/**
 * Get the Dockerfile content to use for building the lazy container.
 *
 * Resolution order:
 * 1. Custom Dockerfile from [docker].dockerfile in lazy.toml
 * 2. Embedded default Dockerfile (base image)
 *
 * The project's own Dockerfile is NEVER used automatically — it's for the
 * project, not for agent containers. Use `lazy init` to create a Dockerfile.lazy
 * based on the project's Dockerfile if needed.
 */
/**
 * Resolve which agent an image build should bake in.
 *
 * Explicit override (the task's agent, threaded from the launch path) wins;
 * otherwise the project's configured default agent applies. Returns null when
 * the effective agent needs no extra install: claude-code is already in the
 * base image, and host-only agents never reach a container build.
 */
async function resolveImageAgent(lazyRoot: string, agentId?: string): Promise<string | null> {
  const effective = agentId ?? (await loadConfig(lazyRoot)).agent.agent_id;
  if (effective === 'claude-code') return null;
  try {
    return getAgentPackaging(effective).supportsContainerRunner() ? effective : null;
  } catch {
    // Unknown agent id — validated elsewhere; the image build just uses base.
    return null;
  }
}

async function getDockerfileContent(lazyRoot: string, agentId?: string): Promise<{ content: string; isCustom: boolean }> {
  const customPath = await resolveCustomDockerfile(lazyRoot);
  if (customPath) {
    // Custom Dockerfiles are the user's own — never silently amended. If they
    // run a non-claude agent they add its install line themselves (the install
    // command is printed by `lazy system export-dockerfile` docs).
    return { content: readFileSync(customPath, 'utf-8'), isCustom: true };
  }

  // Agent-aware default image: bake the configured (or task-overridden) agent's
  // CLI into the image on top of the base. The Dockerfile-hash label mechanism
  // then handles rebuilds automatically, since the content differs.
  const imageAgent = await resolveImageAgent(lazyRoot, agentId);
  if (imageAgent) {
    const install = getAgentPackaging(imageAgent).dockerInstallCommand();
    const content =
      `${DEFAULT_DOCKERFILE}\n# Agent CLI for the "${imageAgent}" agent (added by lazy)\n${install}\n`;
    return { content, isCustom: false };
  }

  return { content: DEFAULT_DOCKERFILE, isCustom: false };
}

export async function calculateDockerfileHash(lazyRoot: string, agentId?: string): Promise<string> {
  const { content } = await getDockerfileContent(lazyRoot, agentId);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Determine the Docker image REPOSITORY (name without tag) to use.
 * Default behavior uses 'lazy-runner'. Custom Dockerfiles use 'lazy-custom-{hash}'.
 * Default-plus-agent images use 'lazy-runner-{agentId}' so they never collide
 * with the base runner image of other projects.
 */
export async function resolveImageRepository(lazyRoot: string, agentId?: string): Promise<{ repository: string; isCustom: boolean }> {
  const { isCustom, content } = await getDockerfileContent(lazyRoot, agentId);

  if (isCustom) {
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 12);
    return { repository: `lazy-custom-${hash}`, isCustom: true };
  }

  const imageAgent = await resolveImageAgent(lazyRoot, agentId);
  if (imageAgent) {
    return { repository: `${IMAGE_NAME}-${imageAgent}`, isCustom: false };
  }

  return { repository: IMAGE_NAME, isCustom: false };
}

/**
 * Determine the full Docker image reference to run — always tagged with lazy's
 * major.minor version (see IMAGE_TAG), never `:latest`.
 */
export async function resolveImageName(lazyRoot: string, agentId?: string): Promise<string> {
  const { repository } = await resolveImageRepository(lazyRoot, agentId);
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

/** Image references only — used by the offline fallback below. */
async function listExistingLazyImages(binary: string = 'docker'): Promise<string[]> {
  return (await listLazyImages(binary)).map(image => image.ref);
}

/**
 * Write Dockerfile content to a temp directory so `docker build -f` has a real
 * file to read. Returns the build context directory and the Dockerfile path.
 */
async function writeDockerfileToTempDir(content: string): Promise<{ buildCwd: string; dockerfilePath: string }> {
  const tempDir = join(tmpdir(), 'lazy-docker-build');
  await mkdir(tempDir, { recursive: true });
  const dockerfilePath = join(tempDir, 'Dockerfile');
  await writeFile(dockerfilePath, content);
  return { buildCwd: tempDir, dockerfilePath };
}

/**
 * Run `docker build` with the given parameters. Shared by the config-driven
 * builder (`buildImage`) and the explicit lazy-runner builder
 * (`buildLazyRunnerImage`).
 */
async function runDockerBuild(
  buildCwd: string,
  dockerfilePath: string,
  tags: string[],
  hash: string,
  binary: string,
  noCache: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Container build cancelled before it started');

  const tagArgs = tags.flatMap(tag => ['-t', tag]);
  const proc = spawn(
    [binary, 'build', ...(noCache ? ['--no-cache'] : []), ...tagArgs, '--label', `${DOCKERFILE_HASH_LABEL}=${hash}`, '-f', dockerfilePath, '.'],
    // Image builds download packages (apt, the Claude Code installer, and whatever
    // else the project's Dockerfile fetches) and can legitimately take many
    // minutes. The default 60s subprocess timeout kills
    // the build mid-download, surfacing as "Canceled: context canceled" (exit 130).
    { cwd: buildCwd, stdout: 'pipe', stderr: 'pipe', timeout: 20 * 60_000 }
  );

  // Cancellation (`lazy upgrade` aborted while its background rebuild is still
  // running): kill the client. Layers already built stay in the runtime's build
  // cache, so a later upgrade is warm rather than starting from scratch.
  const onAbort = () => { try { proc.kill(); } catch { /* already exited */ } };
  signal?.addEventListener('abort', onAbort, { once: true });

  const outputPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const [stdout, stderr, exitCode] = await Promise.all([
    outputPromise,
    stderrPromise,
    proc.exited,
  ]).finally(() => signal?.removeEventListener('abort', onAbort));

  if (signal?.aborted) throw new Error('Container build cancelled');

  logger.stream('Container build stdout:\n' + stdout);
  logger.stream('Container build stderr:\n' + stderr);

  if (exitCode !== 0) {
    const stderrLines = stderr.trim().split('\n');
    const lastOutput = stderrLines.slice(-10).join('\n');
    logger.error(`Container build failed with exit code ${exitCode}\n\nLast output:\n${lastOutput}`);
    throw new Error(`Container build failed with exit code ${exitCode}`);
  }

  logger.debug('Container build completed successfully');
}

async function buildImage(lazyRoot: string, repository: string, currentHash: string, binary: string = 'docker', noCache: boolean = false, agentId?: string): Promise<void> {
  await buildImageWithTags(lazyRoot, buildTagsFor(repository), currentHash, binary, noCache, undefined, agentId);
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
  currentHash: string,
  binary: string = 'docker',
  noCache: boolean = false,
  signal?: AbortSignal,
  agentId?: string,
): Promise<void> {
  const customPath = await resolveCustomDockerfile(lazyRoot);

  let buildCwd: string;
  let dockerfileName: string;

  if (customPath) {
    // Name the Dockerfile in the announcement: from a worktree it is genuinely
    // ambiguous which copy governs, and a wrong one once cost a whole session.
    logger.info(`Building ${tags[0]} container image from ${customPath}...`);
    // Custom Dockerfile: build context is project root, Dockerfile path is the custom one
    buildCwd = lazyRoot;
    dockerfileName = customPath;
  } else {
    logger.info(`Building ${tags[0]} container image from the embedded default Dockerfile...`);
    // Write the resolved Dockerfile to a temp directory for the build.
    // Never use the project's own Dockerfile — it's for the project, not agents.
    const { content } = await getDockerfileContent(lazyRoot, agentId);
    const temp = await writeDockerfileToTempDir(content);
    buildCwd = temp.buildCwd;
    dockerfileName = temp.dockerfilePath;
  }

  await runDockerBuild(buildCwd, dockerfileName, tags, currentHash, binary, noCache, signal);
}

/**
 * The canonical tags a build of THIS project's image writes — the version tag,
 * plus the `:latest` alias for the base runner repository.
 *
 * `lazy upgrade` needs these separately from the build itself: it builds to a
 * staging tag first and promotes onto exactly these refs afterwards, so a
 * cancelled upgrade leaves every canonical tag pointing where it did before.
 */
export async function resolveImageBuildTags(lazyRoot: string): Promise<string[]> {
  const { repository } = await resolveImageRepository(lazyRoot);
  return buildTagsFor(repository);
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
  options: { binary?: string; noCache?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const binary = options.binary ?? 'docker';
  await checkDocker(binary);

  const { repository } = await resolveImageRepository(lazyRoot);
  const ref = `${repository}:${tag}`;
  const currentHash = await calculateDockerfileHash(lazyRoot);
  await buildImageWithTags(lazyRoot, [ref], currentHash, binary, options.noCache ?? false, options.signal);
  return ref;
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
export async function buildLazyRunnerImage(options: { binary?: string; noCache?: boolean } = {}): Promise<string[]> {
  const binary = options.binary ?? 'docker';
  const noCache = options.noCache ?? false;

  await checkDocker(binary);

  const tags = buildTagsFor(IMAGE_NAME);
  logger.info(`Building ${tags[0]} container image...`);
  logger.debug('Using embedded default Dockerfile');

  const hash = createHash('sha256').update(DEFAULT_DOCKERFILE).digest('hex');
  const { buildCwd, dockerfilePath } = await writeDockerfileToTempDir(DEFAULT_DOCKERFILE);
  await runDockerBuild(buildCwd, dockerfilePath, tags, hash, binary, noCache);

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
export async function ensureImage(binary: string = 'docker', options?: { noCache?: boolean; agentId?: string }): Promise<string> {
  await checkDocker(binary);

  const lazyRoot = getLazyRoot();
  const { repository } = await resolveImageRepository(lazyRoot, options?.agentId);
  const imageName = `${repository}:${IMAGE_TAG}`;
  const currentHash = await calculateDockerfileHash(lazyRoot, options?.agentId);
  const imageHash = await getImageDockerfileHash(imageName, binary);
  let noCache = options?.noCache ?? false;

  if (imageHash === currentHash) {
    // The Dockerfile text matches — but its text is not what goes stale. What
    // it PULLS is unpinned (apt packages, the Claude Code installer, the base
    // image, and whatever else a project's own Dockerfile fetches), and that
    // drifts with wall-clock time, so an old-enough image is rebuilt regardless.
    const { tooOld, ageDays } = await isImageTooOld(imageName, binary);
    if (!tooOld) {
      logger.debug('Container image is up to date ✓');
      return imageName;
    }
    // --no-cache is not optional on this path: with the Dockerfile text
    // unchanged, every layer is a cache hit, so a cached build would re-fetch
    // nothing AND return the identical image — leaving the created timestamp
    // untouched and re-triggering this same rebuild on every launch forever.
    noCache = true;
    logger.info(
      `Container image ${imageName} is ${ageDays} days old (older than ${IMAGE_MAX_AGE_DAYS} days) — ` +
      `rebuilding it so the agent gets a current Claude Code (this can take several minutes).`
    );
  } else if (imageHash === null) {
    // Image missing. Say WHY in one line: on a host that upgraded lazy this is
    // the first sign that a multi-minute build is happening, and "not found"
    // alone reads like something is broken when in fact an older image is
    // sitting right there as build cache.
    const older = (await listLazyImages(binary))
      .filter(image => image.repository === repository && image.tag !== IMAGE_TAG && image.tag !== LATEST_ALIAS_TAG)
      .map(image => image.tag);
    const olderNote = older.length > 0
      ? ` Older image(s) for ${repository} (${older.join(', ')}) are kept as build cache — run \`lazy doctor\` for details.`
      : '';
    logger.info(`Container image ${imageName} not found — building it for lazy ${VERSION} (this can take several minutes).${olderNote}`);
  } else {
    logger.info(`Dockerfile has changed, rebuilding ${imageName}...`);
  }

  try {
    await buildImage(lazyRoot, repository, currentHash, binary, noCache, options?.agentId);
    return imageName;
  } catch (buildErr) {
    // If not offline, just propagate the build error
    const buildConfig = await loadConfig(lazyRoot);
    if (!(await isOfflineMode(join(lazyRoot, '.lazy'), buildConfig.remote.offline))) {
      throw buildErr;
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
  const destPath = join(destDir, 'lazy-agent');

  // Skip extraction only when the file on disk is BYTE-IDENTICAL to the
  // embedded one.
  //
  // This used to compare sizes alone, on the theory that the embedded binary
  // changes only when lazy is upgraded. Two builds of a ~100MB Bun executable
  // that differ by a few source lines routinely land on the same size, and when
  // they do, the stale extracted binary is kept and bind-mounted into every
  // container — so a freshly upgraded daemon talks to agents running OLD agent
  // code. That is silent and near-impossible to diagnose from inside a
  // container: the daemon reports the new version while the agent-side MCP
  // client behaves like the old one. Hashing costs a few milliseconds and makes
  // the check exact.
  try {
    const existing = await Bun.file(destPath).arrayBuffer();
    if (
      existing.byteLength === embedded.length &&
      Bun.hash(new Uint8Array(existing)) === Bun.hash(embedded)
    ) {
      return destPath;
    }
  } catch {
    // Missing or unreadable — fall through and (re-)extract.
  }

  // Write to a temp file and rename into place. Writing destPath directly would
  // truncate and rewrite the very inode that already-running containers have
  // bind-mounted at /usr/local/bin/lazy-agent, mutating the agent binary of a
  // live builder mid-session. rename() is atomic: existing containers keep the
  // old inode, new ones get the new binary.
  const tmpPath = join(destDir, `.tmp-lazy-agent-${randomUUID()}`);
  try {
    await Bun.write(tmpPath, embedded);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, destPath);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
    throw new Error(
      `Failed to extract the embedded agent binary to ${destPath}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return destPath;
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
 * Resolution order:
 * 1. Embedded binary extracted to ~/.lazy/bin/lazy-agent (compiled mode)
 * 2. Cached binary in ~/.lazy/bin/ (already there from previous extraction)
 * 3. Build from source (dev mode only)
 */
export async function ensureAgentBinary(): Promise<string> {
  const binDir = getUserBinDir();

  // 1. Try to extract embedded binary (compiled mode)
  const extracted = await extractEmbeddedAgentBinary(binDir);
  if (extracted) {
    logger.debug(`Using embedded agent binary: ${extracted}`);
    return extracted;
  }

  // 2. Check for a cached binary in ~/.lazy/bin/
  const binaryPath = join(binDir, 'lazy-agent');

  // 3. Try to build from source (dev mode only)
  const sourceRoot = getLazySourceRoot();
  if (!sourceRoot) {
    // No source available and no embedded binary found
    if (existsSync(binaryPath)) {
      // Verify rather than trust. This path returns a file nobody in this
      // process produced — whatever a previous install, a partial upgrade or a
      // stray copy left behind — straight into a container bind mount.
      const cached = await verifyAgentBinary(binaryPath);
      if (!cached.ok) {
        throw new Error(formatAgentBinaryError(binaryPath, cached.reason, { canRebuild: false }));
      }
      logger.debug('Using cached agent binary (source not available for rebuild)');
      return binaryPath;
    }
    throw new Error(
      'Agent binary not found. This may indicate a corrupted installation. ' +
      'Try reinstalling lazy, or run: lazy upgrade'
    );
  }

  const entryPoint = join(sourceRoot, 'src', 'agent-entry.ts');
  const target = getLinuxTarget();

  // Check if binary needs rebuilding by comparing source hash + target arch
  const hashFile = binaryPath + '.hash';
  const currentHash = calculateSourceHash(sourceRoot) + ':' + target;

  if (existsSync(binaryPath) && existsSync(hashFile)) {
    const storedHash = readFileSync(hashFile, 'utf-8').trim();
    if (storedHash === currentHash) {
      // The hash says the SOURCE has not changed; it says nothing about whether
      // the file on disk is still the binary that hash was recorded for.
      const cached = await verifyAgentBinary(binaryPath);
      if (cached.ok) {
        logger.debug('Agent binary is up to date');
        return binaryPath;
      }
      logger.warn(
        `Cached agent binary at ${binaryPath} failed verification (${cached.reason}). Rebuilding.`,
      );
    }
  }

  mkdirSync(binDir, { recursive: true });

  logger.info(`Building agent binary for Linux (${target})...`);

  // Build to a temp file to avoid disrupting running containers that have
  // the existing binary bind-mounted. On macOS/Linux, rename() is atomic —
  // existing processes holding the old inode continue to work, and new execs
  // get the new binary. No window where the file is missing.
  const tmpPath = join(binDir, `.tmp-lazy-agent-${randomUUID()}`);

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
      `The previous binary at ${binaryPath} was left untouched. ` +
      `Re-run the build; if it keeps happening, clear Bun's cross-compile cache ` +
      `(~/.bun/install/cache) and rebuild.`,
    );
  }

  // Atomically replace the existing binary
  renameSync(tmpPath, binaryPath);

  // Store hash for next comparison
  await Bun.write(hashFile, currentHash);

  logger.debug('Agent binary build completed successfully');
  return binaryPath;
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

export type { OllamaConfig } from '../config/types';

/**
 * Get auth environment variables for a resolved role target.
 *
 * - ollama: synthetic credentials ({@link LOCAL_BACKEND_CREDS}) — the ollama
 *   server ignores auth, and an ollama-only project may hold no real credential
 *   at all, so demanding one here would break it.
 * - anthropic / proxy (or no target): the real Anthropic credential (throws if
 *   absent, via ClaudeCodeAgent.getAuthEnvVars()).
 *
 * The base URL is the proxy's for every backend — where a role's traffic goes
 * upstream is the proxy's routing decision, not the launched process's.
 *
 * `surface` says whether the env is for a container or a host process — see
 * {@link targetEnvVars}. It defaults to `'container'` because every caller in
 * this module builds `docker run` argv; host launch paths pass `'host'`
 * explicitly.
 */
export function getAuthEnvVars(
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
): Array<{ key: string; value: string }> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;
  const creds = resolved.backend === 'ollama'
    ? LOCAL_BACKEND_CREDS
    : _agent.getAuthEnvVars(); // throws, actionably, if genuinely absent
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
 * Every role's traffic reaches lazy's proxy now — including ollama roles and
 * roles pinned at an explicit `endpoint`, which the proxy forwards to on their
 * behalf — so the only remaining condition is that this process is the daemon
 * that runs the proxy. Without a daemon context (the in-container supervisor
 * relaunching its own agent, test/daemonless modes) this process cannot mint
 * against the daemon's grant registry, and in the container case it does not
 * need to: the value it reads out of its own env is already the placeholder the
 * daemon minted.
 *
 * An ollama role is placeholderized like any other, over synthetic credentials
 * ({@link LOCAL_BACKEND_CREDS}) rather than the user's token — the grant is what
 * lets the proxy authenticate the caller and route it to that role's upstream,
 * so skipping the swap would cost the routing, not just the secrecy.
 */
export async function getLaunchAuthEnvVars(
  identity: LaunchIdentity,
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  injectedCreds?: Array<{ key: string; value: string }>,
): Promise<Array<{ key: string; value: string }>> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;
  // injectedCreds: a runner that holds its own agent instance reads the
  // credential from THAT agent rather than the module-level default. The
  // placeholder swap below is identical either way — which is the point of
  // taking it as a parameter instead of letting that caller bypass this.
  const real = resolved.backend === 'ollama'
    ? LOCAL_BACKEND_CREDS
    : (injectedCreds ?? _agent.getAuthEnvVars());
  const proxyPort = hasDaemonContext() ? getDaemonContext().proxyPort : undefined;
  if (!proxyPort) {
    return targetEnvVars(resolved, real, surface, hints);
  }
  const placeholders = await placeholderizeAuthEnv(getLazyRoot(), real, identity);
  return targetEnvVars(resolved, placeholders, surface, hints);
}

/**
 * Container argv for a one-shot agent run.
 *
 * Exported for test/unit/daemon-dir-never-mounted.test.ts, which asserts the
 * mount set never exposes the daemon state dir — see the INVARIANT comment there.
 *
 * `gitMountArgs` carries the split `.git` mount (see src/capture/git-mounts.ts);
 * callers build it with `buildGitMountArgsFor(worktreePath)`.
 */
export function buildDockerArgs(
  sandbox: SandboxConfig,
  claudeArgs: string[],
  agentBinaryPath: string,
  imageName: string,
  binary: string = 'docker',
  repoRoot: string = getLazyRoot(),
  authEnvVars: Array<{ key: string; value: string }> = [],
  gitMountArgs: string[] = [],
): string[] {
  return [
    binary, 'run', '--rm', '--init',
    // Allow container to reach host services (daemon MCP, Ollama, etc.)
    '--add-host=host.docker.internal:host-gateway',
    // Mount repo read-only so agent can read source but not modify the main tree.
    // The worktree is mounted read-write on top (more specific mount wins).
    '-v', `${repoRoot}:${repoRoot}:ro`,
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

  // The caller's decision site resolves the model; for a local backend fall back
  // to the target's authoritative model if no explicit model was passed.
  const effectiveModel =
    model ?? (target && target.backend !== 'anthropic' ? target.model : undefined);

  const claudeArgs = [
    'claude', '-p', safeArgvPrompt(prompt, 'prompt'),
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (effectiveModel) {
    claudeArgs.push('--model', effectiveModel);
  }

  if (effort) {
    claudeArgs.push('--effort', effort);
  }

  logger.debug('Setting up sandbox...');
  // JIT CREDENTIALS: this is a container launch, so it gets a placeholder like
  // every other one — the real credential must not reach the container's env or
  // the docker argv. Resolved through the daemon (the credential's owner) with a
  // builder identity: this runs on behalf of a human at a terminal, not a task.
  const authEnvVars = await resolveAuthEnvFromDaemon(
    target, { role: 'builder' }, 'container', undefined,
    { role: 'builder', taskId: null, label: `oneshot:${getLazyRoot()}` },
  );
  const args = buildDockerArgs(
    sandbox, claudeArgs, agentBinaryPath, imageName, binary,
    getLazyRoot(), authEnvVars,
    await buildGitMountArgsFor(sandbox.worktreePath),
  );

  if (debug) {
    console.log('[DEBUG] Running container command:', redactSecrets(args).join(' '));
  }

  logger.info('Running Claude Code...');

  const proc = spawn(args, {
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
 * Run a one-shot Claude Code prompt directly on the host (no Docker / sandbox).
 *
 * Used by lightweight CLI commands that only need a single LLM call and don't
 * need a worktree, sandbox, or session continuity (e.g. `lazy report`).
 * Authentication comes from the same env vars as the agent runner.
 *
 * Every run here is MACHINE-GENERATED housekeeping — a fidelity summary, a
 * report unit, a memory compaction — never a conversation anyone will read.
 * Claude still writes a session JSONL for it into the shared projects dir, so
 * the prompt is stamped with the one-shot marker (see src/import/machine-oneshot.ts)
 * and conversation capture skips it. This is the ONLY place that stamps: every
 * caller of this function is housekeeping by construction, so marking here means
 * no caller can forget.
 */
export interface OneshotOptions {
  /**
   * Block the write tools for this run (`lazy ask <conversation>`): the agent
   * may Read/Grep while forming its answer but cannot touch the repo.
   */
  readOnly?: boolean;
}

/**
 * Write tools blocked by `readOnly`. Mirrors DISALLOWED_TOOLS_IN_PLAN_MODE in
 * src/agent/claude-code.ts and DISALLOWED_TOOLS in src/cli/commands/chat.ts —
 * the same three tools, kept spelled out here so this module stays free of the
 * agent/runner graph.
 */
const ONESHOT_READ_ONLY_DISALLOWED_TOOLS = 'Bash Write Edit';

/**
 * Compose the argv for a one-shot run. Pure, so the execution-path contract is
 * assertable without spawning: a one-shot is always `claude -p <marked prompt>`,
 * and it NEVER carries `--resume`/`--continue`. Those two flags are what would
 * make housekeeping run inside somebody's existing session instead of its own.
 */
export function buildOneshotArgs(
  prompt: string,
  model?: string,
  opts: OneshotOptions = {},
): string[] {
  const marked = markMachineOneshotPrompt(prompt);
  const args = ['claude', '-p', safeArgvPrompt(marked, 'prompt'), '--output-format', 'json'];
  if (model) {
    args.push('--model', model);
  }
  if (opts.readOnly) {
    // Same lockdown the supervisor's ask turns use, and for the same reason:
    // `--permission-mode plan` triggers an interactive ExitPlanMode prompt that
    // `claude -p` has no human to answer, so writes are blocked with
    // --disallowedTools instead. Read-only tools stay available so the answer
    // can be checked against the code.
    args.push('--disallowedTools', ONESHOT_READ_ONLY_DISALLOWED_TOOLS);
  }
  return args;
}

export async function runClaudeOneshot(
  prompt: string,
  model?: string,
  opts: OneshotOptions = {},
): Promise<AgentResponse> {
  // Validate auth up front so the failure mode is a clean error, not a cryptic
  // Claude CLI exit. Throws if no token / API key is available.
  _agent.getAuthEnvVars();

  const args = buildOneshotArgs(prompt, model, opts);
  // No progress log here — callers fire N+ of these and own the messaging
  // (see e.g. `lazy report`'s map-reduce, which logs per-unit progress).

  const proc = spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 0,
  });

  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const tail = stderr.trim().split('\n').slice(-20).join('\n  ');
    throw new Error(`Claude Code exited with code ${exitCode}${tail ? `\n\nLast output:\n  ${tail}` : ''}`);
  }

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

/**
 * Generate a container name for a task.
 */
export function containerNameForTask(taskShortId: string): string {
  return `lazy-${taskShortId}`;
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
 * Exit code protocol:
 *   0  — turn completed successfully → restart supervisor
 *   42 — stop command received → exit wrapper cleanly
 *   other — unexpected error → exit wrapper with that code
 */
function buildSupervisorWrapperScript(protocolDir: string, worktreePath: string): string {
  // Use single quotes for the sh -c wrapper to avoid escaping issues.
  // The paths are injected directly — they come from our own code, not user input.
  return [
    '#!/bin/sh',
    '# PID 1 wrapper — restarts supervisor between turns to release memory.',
    '# Between turns, kills orphaned processes (MCP servers, node, bash, etc.)',
    '# that survived the supervisor exit. tini (--init) reaps zombies but does',
    '# not kill living orphans — without this they accumulate across turns.',
    'child_pid=""',
    'my_pid=$$',
    'trap \'[ -n "$child_pid" ] && kill $child_pid 2>/dev/null; wait; exit\' TERM INT',
    'while true; do',
    `  lazy-agent --one-shot --protocol-dir "${protocolDir}" --worktree "${worktreePath}" &`,
    '  child_pid=$!',
    '  wait $child_pid',
    '  rc=$?',
    '  child_pid=""',
    '  # Kill orphaned processes from the finished turn.',
    '  for p in /proc/[0-9]*/status; do',
    '    pid=${p#/proc/}; pid=${pid%/status}',
    '    [ "$pid" = "1" ] || [ "$pid" = "$my_pid" ] && continue',
    '    kill "$pid" 2>/dev/null',
    '  done',
    '  sleep 1',
    '  for p in /proc/[0-9]*/status; do',
    '    pid=${p#/proc/}; pid=${pid%/status}',
    '    [ "$pid" = "1" ] || [ "$pid" = "$my_pid" ] && continue',
    '    kill -9 "$pid" 2>/dev/null',
    '  done',
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
  /** Already-built `-v ...` args for user-configured [[mounts]]. */
  customMountArgs: string[];
  /**
   * Already-built `-v ...` args for the split `.git` mount — common dir
   * read-only, only objects + this worktree's gitdir writable.
   * Build with `buildGitMountArgsFor(worktreePath)`; see src/capture/git-mounts.ts.
   */
  gitMountArgs: string[];
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
    agentBinaryPath, authEnvVars, customMountArgs, gitMountArgs, wrapperScript,
    daemonConfigPath,
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
    '-v', `${sandbox.worktreePath}:${sandbox.worktreePath}`,
    // Split .git mount: the shared git dir (refs, packed-refs, config, hooks,
    // sibling worktree gitdirs) is read-only; only objects and this worktree's
    // own gitdir are writable. See src/capture/git-mounts.ts.
    ...gitMountArgs,
    '-v', `${protocolDir}:${protocolDir}`,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    // Cursor's home-config dir, mounted unconditionally (like .claude): the dir
    // always exists (setupSandbox creates it) and non-Cursor agents ignore it.
    '-v', `${sandbox.sandboxPath}/.cursor:/home/user/.cursor`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
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
 * Verify a non-claude agent's binary exists in the image that is about to run.
 *
 * Only applies when the project uses a CUSTOM Dockerfile: the default image is
 * agent-aware (getDockerfileContent appends the install command), but custom
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
  if (!agentId || agentId === 'claude-code') return;
  const lazyRoot = getLazyRoot();
  if (!(await resolveCustomDockerfile(lazyRoot))) return; // default image is agent-aware

  const pkg = getAgentPackaging(agentId);
  const agentBinary = pkg.binaryName();
  const probe = spawn(
    [binary, 'run', '--rm', imageName, 'which', agentBinary],
    { stdout: 'ignore', stderr: 'ignore', timeout: 60_000 },
  );
  if (await probe.exited !== 0) {
    const config = await loadConfig(lazyRoot);
    throw new Error(
      `The custom Dockerfile image "${imageName}" does not contain '${agentBinary}', ` +
      `which the "${agentId}" agent needs. Lazy never amends custom Dockerfiles — ` +
      `add this line to ${config.docker.dockerfile} (in the non-root user section) and relaunch:\n` +
      `  ${pkg.dockerInstallCommand()}\n` +
      `The image rebuilds automatically on the next launch once the file changes.`
    );
  }
}

export async function launchSupervisorAsync(
  sandbox: SandboxConfig,
  containerName: string,
  protocolDir: string,
  debug: boolean = false,
  binary: string = 'docker',
  daemonConfigPath?: string,
  target?: RoleTarget,
  taskId?: string,
  agentId?: string,
): Promise<void> {
  // Image resolution is deliberately NOT anchored at sandbox.worktreePath:
  // a task branch that edits Dockerfile.lazy must never have those edits
  // built and run by the daemon's docker on the host (see
  // resolveCustomDockerfile for the invariant).
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary, { agentId }),
    ensureAgentBinary(),
  ]);

  // Custom Dockerfiles are never amended by lazy, so a non-claude agent's
  // binary may simply not be in the image. Verify it BEFORE launching the
  // supervisor — otherwise the missing binary only surfaces inside the work
  // phase (a cursor task on this repo's own Dockerfile.lazy crash-looped for
  // a whole session this way before the failure was even classified).
  await preflightAgentBinaryInImage(imageName, binary, agentId);

  // Supervisor launches are always the `agent` role; the task turn it runs
  // inherits this env, so proxied traffic is attributed to agent + task.
  let authEnvVars: Array<{ key: string; value: string }>;
  // The launch identity every placeholder minted below is bound to. The proxy
  // derives attribution from the grant rather than from the self-reported
  // x-lazy-* headers, so this is what the audit trail ends up asserting.
  const agentIdentity: LaunchIdentity = { role: 'agent', taskId: taskId ?? null, label: containerName };
  if (agentId && agentId !== 'claude-code') {
    // Non-claude task agent: its own credentials are what the turn needs.
    // Resolved at LAUNCH time (env override → per-project .lazy credentials
    // file), so a key set while the daemon is running takes effect on the
    // next launch — never "restart the daemon". See src/agent/credentials.ts.
    authEnvVars = [];
    if (agentSupportsApiKey(agentId)) {
      const key = await resolveAgentApiKey(getLazyRoot(), agentId);
      if (!key) {
        // A container cannot see the host's login session, so no key from any
        // source means every turn would fail on auth. Refuse the launch with
        // the remedy instead.
        throw new Error(
          `No API key for the "${agentId}" agent. A container cannot use a host login session, ` +
          `so this task needs a key from one of:\n` +
          `  1. lazy system agent set-key ${agentId}   (stored per-project outside the repo — takes effect on the next launch)\n` +
          `  2. the ${AGENT_KEY_ENV[agentId]} environment variable (override)`
        );
      }
      // JIT INJECTION: the container gets a PLACEHOLDER, never the key. The
      // real key is resolved above only to prove one EXISTS (a container has no
      // login session to fall back on) — its value is then dropped on the floor
      // and the proxy re-resolves it per request, upstream.
      const agentEnvKey = AGENT_KEY_ENV[agentId]!;
      const placeholder = await mintCredentialGrant(getLazyRoot(), {
        role: 'agent', taskId: taskId ?? null, label: containerName, envKey: agentEnvKey,
      });
      authEnvVars.push({ key: agentEnvKey, value: placeholder });
      logger.debug(`Resolved ${agentId} API key from ${key.source}; container gets a placeholder`);
    }
    // The Anthropic/proxy env is still forwarded when resolvable — the
    // in-container merge phase shells out to `claude`
    // (src/supervisor/merge.ts) — but its absence must not block a task that
    // never authenticates against Anthropic.
    try {
      authEnvVars = [
        ...(await getLaunchAuthEnvVars(agentIdentity, target, { role: 'agent', taskId })),
        ...authEnvVars,
      ];
    } catch (err) {
      // Distinguish "there is no credential" from "resolving it BROKE". The
      // first is ordinary \u2014 a cursor task need not have an Anthropic key, and
      // only the in-container merge phase would miss it. The second means the
      // grant registry or the proxy wiring is faulty, and letting that log at
      // debug as a missing credential is how a broken security path stays
      // invisible (CLAUDE.md: distinguish not-found from found-but-broken).
      const message = err instanceof Error ? err.message : String(err);
      const merelyAbsent = /no .*credential|not authenticated|setup-token|ANTHROPIC_API_KEY/i.test(message);
      if (merelyAbsent) {
        logger.debug(
          `No Anthropic credential forwarded to ${agentId} task container ` +
          `(merge-conflict turns need one): ${message}`
        );
      } else {
        logger.warn(
          `[proxy] could not build the placeholder auth env for the ${agentId} task container: ` +
          `${message}. The launch continues without Anthropic credentials, so an in-container ` +
          `merge turn will fail on auth. This is not a missing key — it is a failure to mint or ` +
          `resolve one.`
        );
      }
    }
  } else {
    authEnvVars = await getLaunchAuthEnvVars(agentIdentity, target, { role: 'agent', taskId });
  }
  const repoRoot = getLazyRoot();

  // Resolve user-configured custom mounts ([[mounts]]). Validated at load time;
  // here we just expand placeholders and build the `-v` args. Empty by default,
  // so default behavior is completely unchanged when no mounts are configured.
  const config = await loadConfig(repoRoot);

  // Cursor API traffic routes through lazy's proxy exactly like Anthropic's,
  // via cursor-agent's endpoint override. The launch's PLACEHOLDER rides in the
  // URL path rather than a header because cursor's -H flag does not cover every
  // request (see src/proxy/cursor-route.ts); the proxy authenticates it there
  // and swaps in the real CURSOR_API_KEY upstream.
  authEnvVars.push(...cursorLaunchEnvVars({
    agentId,
    // Container surface: `binary` is the container runtime for this launch.
    runnerType: binary === 'podman' ? 'podman' : 'docker',
    proxyPort: hasDaemonContext() ? getDaemonContext().proxyPort : undefined,
    bind: config.proxy.bind,
    token: authEnvVars.find(v => v.key === AGENT_KEY_ENV.cursor)?.value ?? null,
  }));

  const customMountArgs = buildMountArgs(config.mounts, {
    worktreePath: sandbox.worktreePath,
    repoRoot,
  });

  const gitMountArgs = await buildGitMountArgsFor(sandbox.worktreePath);

  const wrapperScript = buildSupervisorWrapperScript(protocolDir, sandbox.worktreePath);

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
    customMountArgs,
    gitMountArgs,
    wrapperScript,
    daemonConfigPath,
  });

  if (debug) {
    console.log('[DEBUG] Running container command:', redactSecrets(args).join(' '));
  }

  logger.info('Launching supervisor container...');

  // Async spawn (not spawnSync) so a wedged `docker run` can never block the
  // daemon event loop. We own the timeout explicitly (wrapper timer disabled via
  // timeout: 0) so a timeout produces an actionable error rather than an opaque
  // signal exit code: on deadline we kill the process, which closes its streams
  // and lets the reads below resolve.
  const proc = spawn(args, { stdout: 'pipe', stderr: 'pipe', timeout: 0 });

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
    throw new Error(`Failed to launch supervisor container: ${errText}`);
  }

  logger.debug(`Supervisor container ${containerName} launched`);
}
