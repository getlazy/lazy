import { createHash, randomUUID } from 'crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, renameSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentResponse, TokenUsage } from '../types';
import { ClaudeCodeAgent } from '../agent/claude-code';
import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { findLazyRoot } from '../cli/init';
import { loadConfig } from '../config/loader';
import type { RoleTarget } from '../config/types';
import { buildMountArgs } from './mounts';
import { targetEnvVars, ANTHROPIC_DEFAULT_TARGET } from '../utils/role-target';
import { logger } from '../utils/logger';
import { isOfflineMode } from '../utils/offline';
import { spawn, spawnSync } from '../utils/spawn';
import DEFAULT_DOCKERFILE from '../docker/base.Dockerfile' with { type: 'text' };

// Re-export so other modules (e.g. `lazy system export-dockerfile`) can use the
// exact same embedded text as the single source of truth — never copy it.
export { DEFAULT_DOCKERFILE };
import { getHome } from '../utils/home';

// Embedded at build/compile time — the agent binary is bundled into the lazy executable.
// In dev mode this resolves to the placeholder file on disk (which is empty/tiny).
// In compiled mode it resolves to a $bunfs/ path inside the executable.
// A placeholder lazy-agent file must exist at the project root for this import to resolve.
import embeddedAgentBinaryPath from '../../lazy-agent' with { type: 'file' };

// Minimum size for a valid agent binary (real binaries are several MB).
// The placeholder file is intentionally small so we can distinguish it.
const MIN_AGENT_BINARY_SIZE = 1024;

export interface SandboxConfig {
  worktreePath: string;
  sandboxPath: string;
}



const IMAGE_NAME = 'lazy-runner';
const DOCKERFILE_HASH_LABEL = 'lazy.dockerfile.hash';
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
 * Resolve the custom Dockerfile path from config.
 * Returns the absolute path if configured and the file exists, null otherwise.
 */
async function resolveCustomDockerfile(lazyRoot: string): Promise<string | null> {
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
async function getDockerfileContent(lazyRoot: string): Promise<{ content: string; isCustom: boolean }> {
  const customPath = await resolveCustomDockerfile(lazyRoot);
  if (customPath) {
    return { content: readFileSync(customPath, 'utf-8'), isCustom: true };
  }

  return { content: DEFAULT_DOCKERFILE, isCustom: false };
}

export async function calculateDockerfileHash(lazyRoot: string): Promise<string> {
  const { content } = await getDockerfileContent(lazyRoot);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Determine the Docker image name to use.
 * Default behavior uses 'lazy-runner'. Custom Dockerfiles use 'lazy-custom-{hash}'.
 */
export async function resolveImageName(lazyRoot: string): Promise<string> {
  const { isCustom, content } = await getDockerfileContent(lazyRoot);

  if (isCustom) {
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 12);
    return `lazy-custom-${hash}`;
  }

  return IMAGE_NAME;
}

function getImageDockerfileHash(imageName: string, binary: string = 'docker'): string | null {
  const inspect = spawnSync(
    [binary, 'image', 'inspect', imageName, '--format', `{{index .Config.Labels "${DOCKERFILE_HASH_LABEL}"}}`],
    { stdout: 'pipe', stderr: 'ignore' }
  );

  if (inspect.exitCode !== 0) {
    return null;
  }

  const hash = inspect.stdout.toString().trim();
  return hash || null;
}

/**
 * List existing Docker images with the lazy Dockerfile hash label.
 * Returns image names sorted by creation date (most recent first).
 */
async function listExistingLazyImages(binary: string = 'docker'): Promise<string[]> {
  const proc = spawn(
    [binary, 'images', '--filter', `label=${DOCKERFILE_HASH_LABEL}`, '--format', '{{.Repository}}:{{.Tag}}'],
    { stdout: 'pipe', stderr: 'ignore' }
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return [];
  return stdout.trim().split('\n').filter(line => line && line !== '<none>:<none>');
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
  imageName: string,
  hash: string,
  binary: string,
  noCache: boolean,
): Promise<void> {
  const proc = spawn(
    [binary, 'build', ...(noCache ? ['--no-cache'] : []), '-t', imageName, '--label', `${DOCKERFILE_HASH_LABEL}=${hash}`, '-f', dockerfilePath, '.'],
    // Image builds download toolchains (bun, Claude Code, Playwright+Chromium) and
    // can legitimately take many minutes. The default 60s subprocess timeout kills
    // the build mid-download, surfacing as "Canceled: context canceled" (exit 130).
    { cwd: buildCwd, stdout: 'pipe', stderr: 'pipe', timeout: 20 * 60_000 }
  );

  const outputPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const [stdout, stderr, exitCode] = await Promise.all([
    outputPromise,
    stderrPromise,
    proc.exited,
  ]);

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

async function buildImage(lazyRoot: string, imageName: string, currentHash: string, binary: string = 'docker', noCache: boolean = false): Promise<void> {
  logger.info(`Building ${imageName} container image...`);

  const customPath = await resolveCustomDockerfile(lazyRoot);

  let buildCwd: string;
  let dockerfileName: string;

  if (customPath) {
    // Custom Dockerfile: build context is project root, Dockerfile path is the custom one
    buildCwd = lazyRoot;
    dockerfileName = customPath;
    logger.debug(`Using custom Dockerfile: ${customPath}`);
  } else {
    // Write the resolved Dockerfile to a temp directory for the build.
    // Never use the project's own Dockerfile — it's for the project, not agents.
    const { content } = await getDockerfileContent(lazyRoot);
    const temp = await writeDockerfileToTempDir(content);
    buildCwd = temp.buildCwd;
    dockerfileName = temp.dockerfilePath;
    logger.debug('Using embedded default Dockerfile');
  }

  await runDockerBuild(buildCwd, dockerfileName, imageName, currentHash, binary, noCache);
}

/**
 * Build the base lazy-runner image explicitly, bypassing all lazy.toml
 * configuration. Used by `lazy system build lazy-runner` so custom Dockerfiles
 * that layer on top of the base image (`FROM lazy-runner`) have something to
 * build from on a fresh machine.
 *
 * Unlike `ensureImage`, this always builds — it does not check whether the
 * image already exists or whether the Dockerfile hash has changed.
 */
export async function buildLazyRunnerImage(options: { binary?: string; noCache?: boolean } = {}): Promise<string> {
  const binary = options.binary ?? 'docker';
  const noCache = options.noCache ?? false;

  await checkDocker(binary);

  logger.info(`Building ${IMAGE_NAME} container image...`);
  logger.debug('Using embedded default Dockerfile');

  const hash = createHash('sha256').update(DEFAULT_DOCKERFILE).digest('hex');
  const { buildCwd, dockerfilePath } = await writeDockerfileToTempDir(DEFAULT_DOCKERFILE);
  await runDockerBuild(buildCwd, dockerfilePath, IMAGE_NAME, hash, binary, noCache);

  return IMAGE_NAME;
}

/**
 * Ensure the Docker image is built and up to date.
 * Returns the image name to use for container creation.
 *
 * When offline and the build fails (e.g., can't pull base images), falls back
 * to an existing lazy image if one is available. This lets users work offline
 * with a previously-built image even if the Dockerfile has changed.
 */
export async function ensureImage(binary: string = 'docker', options?: { noCache?: boolean }): Promise<string> {
  await checkDocker(binary);

  const lazyRoot = getLazyRoot();
  const imageName = await resolveImageName(lazyRoot);
  const currentHash = await calculateDockerfileHash(lazyRoot);
  const imageHash = getImageDockerfileHash(imageName, binary);
  const noCache = options?.noCache ?? false;

  if (imageHash === currentHash) {
    logger.debug('Container image is up to date ✓');
    return imageName;
  }

  // Image needs building (missing or outdated)
  const buildReason = imageHash === null ? 'Container image not found.' : 'Dockerfile has changed, rebuilding image...';
  logger.info(buildReason);

  try {
    await buildImage(lazyRoot, imageName, currentHash, binary, noCache);
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
      logger.warn(`Using existing image "${imageName}" (Dockerfile hash differs — image may be outdated).`);
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
function extractEmbeddedAgentBinary(destDir: string): string | null {
  // The embedded path starts with $bunfs/ when running as a compiled binary.
  // In dev mode it's a regular file path pointing to the placeholder.
  if (!embeddedAgentBinaryPath || !existsSync(embeddedAgentBinaryPath)) {
    return null;
  }

  // In dev mode, the import resolves to a tiny placeholder file.
  // Only proceed if the embedded file is a real binary (> MIN_AGENT_BINARY_SIZE).
  try {
    const embeddedSize = Bun.file(embeddedAgentBinaryPath).size;
    if (embeddedSize < MIN_AGENT_BINARY_SIZE) {
      return null;
    }
  } catch {
    return null;
  }

  mkdirSync(destDir, { recursive: true });
  const destPath = join(destDir, 'lazy-agent');

  // Skip extraction if the binary is already there and matches
  if (existsSync(destPath)) {
    // Compare sizes as a quick check — if they match, assume it's current.
    // The embedded binary changes only when lazy itself is upgraded.
    try {
      const embeddedSize = Bun.file(embeddedAgentBinaryPath).size;
      const destSize = Bun.file(destPath).size;
      if (embeddedSize === destSize) {
        return destPath;
      }
    } catch {
      // Fall through to re-extract
    }
  }

  // Use readFileSync/writeFileSync instead of copyFileSync because the embedded
  // path is a $bunfs virtual filesystem path that OS-level copy syscalls can't access.
  writeFileSync(destPath, readFileSync(embeddedAgentBinaryPath));
  chmodSync(destPath, 0o755);
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
  const extracted = extractEmbeddedAgentBinary(binDir);
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
      logger.debug('Agent binary is up to date');
      return binaryPath;
    }
  }

  mkdirSync(binDir, { recursive: true });

  logger.info(`Building agent binary for Linux (${target})...`);

  // Build to a temp file to avoid disrupting running containers that have
  // the existing binary bind-mounted. On macOS/Linux, rename() is atomic —
  // existing processes holding the old inode continue to work, and new execs
  // get the new binary. No window where the file is missing.
  const tmpPath = join(binDir, `.tmp-lazy-agent-${randomUUID()}`);

  const proc = spawn(
    ['bun', 'build', '--compile', `--target=${target}`, entryPoint, '--outfile', tmpPath],
    { cwd: sourceRoot, stdout: 'pipe', stderr: 'pipe' }
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
 * - ollama: self-contained dummy credentials + base URL + stability flags.
 * - proxy:  base URL override forwarded with the real Anthropic credential.
 * - anthropic (or no target): the real Anthropic credential (throws if absent,
 *   via ClaudeCodeAgent.getAuthEnvVars()).
 */
export function getAuthEnvVars(target?: RoleTarget): Array<{ key: string; value: string }> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;
  if (resolved.backend === 'ollama') {
    // Ollama is self-contained — no real credential needed.
    return targetEnvVars(resolved, []);
  }
  // anthropic / proxy: forward the real credential (throwing if absent).
  return targetEnvVars(resolved, _agent.getAuthEnvVars());
}

function buildDockerArgs(sandbox: SandboxConfig, claudeArgs: string[], agentBinaryPath: string, imageName: string, binary: string = 'docker', target?: RoleTarget): string[] {
  const authEnvVars = getAuthEnvVars(target);
  const repoRoot = getLazyRoot();

  return [
    binary, 'run', '--rm', '--init',
    // Allow container to reach host services (daemon MCP, Ollama, etc.)
    '--add-host=host.docker.internal:host-gateway',
    // Mount repo read-only so agent can read source but not modify the main tree.
    // The worktree and .git dir are mounted read-write on top (more specific mount wins).
    '-v', `${repoRoot}:${repoRoot}:ro`,
    '-v', `${sandbox.worktreePath}:${sandbox.worktreePath}`,
    // Git worktrees need write access to <repoRoot>/.git for commits, refs, etc.
    '-v', `${join(repoRoot, '.git')}:${join(repoRoot, '.git')}`,
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
    'claude', '-p', prompt,
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
  const args = buildDockerArgs(sandbox, claudeArgs, agentBinaryPath, imageName, binary, target);

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
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
 */
export async function runClaudeOneshot(
  prompt: string,
  model?: string,
): Promise<AgentResponse> {
  // Validate auth up front so the failure mode is a clean error, not a cryptic
  // Claude CLI exit. Throws if no token / API key is available.
  _agent.getAuthEnvVars();

  const args = ['claude', '-p', prompt, '--output-format', 'json'];
  if (model) {
    args.push('--model', model);
  }
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
  return {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };
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
 * Get the stdout output of a stopped container.
 * Returns null if Docker is not available.
 */
export function getContainerOutput(containerName: string, binary: string = 'docker'): string | null {
  try {
    const result = spawnSync(
      [binary, 'logs', containerName],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) return null;
    return result.stdout.toString();
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

/**
 * Launch the supervisor in a detached Docker container.
 * The supervisor watches for commands from the host via the protocol directory.
 * Returns immediately after the container starts.
 *
 * Uses a PID-1 wrapper script that restarts the supervisor between turns
 * so that memory is released back to the OS after each turn.
 */
export async function launchSupervisorAsync(
  sandbox: SandboxConfig,
  containerName: string,
  protocolDir: string,
  debug: boolean = false,
  binary: string = 'docker',
  daemonConfigPath?: string,
  target?: RoleTarget,
): Promise<void> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  const authEnvVars = getAuthEnvVars(target);
  const repoRoot = getLazyRoot();

  // Resolve user-configured custom mounts ([[mounts]]). Validated at load time;
  // here we just expand placeholders and build the `-v` args. Empty by default,
  // so default behavior is completely unchanged when no mounts are configured.
  const config = await loadConfig(repoRoot);
  const customMountArgs = buildMountArgs(config.mounts, {
    worktreePath: sandbox.worktreePath,
    repoRoot,
  });

  const wrapperScript = buildSupervisorWrapperScript(protocolDir, sandbox.worktreePath);

  // Daemon MCP config is provided by the caller (daemon task launcher).
  // The daemon always provides this when launching containers — it knows
  // its own webPort and token, so there's no fallback or race condition.

  const args = [
    binary, 'run', '-d', '--init',
    '--name', containerName,
    // Scope this container to the project so cross-project commands
    // (e.g. `lazy upgrade`) can filter on the label. Kept in sync with
    // PROJECT_LABEL in src/runner/docker-runner.ts.
    '--label', `lazy.project=${repoRoot}`,
    // Allow container to reach host services (daemon MCP, Ollama, etc.)
    '--add-host=host.docker.internal:host-gateway',
    // Mount repo read-only; worktree, .git, and protocol dir are mounted read-write on top.
    '-v', `${repoRoot}:${repoRoot}:ro`,
    '-v', `${sandbox.worktreePath}:${sandbox.worktreePath}`,
    '-v', `${join(repoRoot, '.git')}:${join(repoRoot, '.git')}`,
    '-v', `${protocolDir}:${protocolDir}`,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    ...authEnvVars.flatMap(v => ['-e', `${v.key}=${v.value}`]),
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    // Pass daemon config to container for MCP proxy mode
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

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
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
