import { createHash, randomUUID } from 'crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { AgentResponse, ModelName, TokenUsage } from '../types';
import { ClaudeCodeAgent } from '../agent/claude-code';
import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { findLazyRoot } from '../cli/init';
import { loadConfig } from '../config/loader';
import { logger } from '../utils/logger';
import { isValidToolchain, getToolchainDockerfileContent } from '../docker/toolchains';
import type { ToolchainName } from '../docker/toolchains';

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

export interface DockerRunOptions {
  dockerAgentRoot?: boolean;
  dockerAgentNoNetwork?: boolean;
}

const IMAGE_NAME = 'lazy-runner';
const DOCKERFILE_HASH_LABEL = 'lazy.dockerfile.hash';
// Timeout for Docker inspection commands (ms). Prevents process hangs if Docker daemon is unresponsive.
const DOCKER_TIMEOUT_MS = 10_000;

// Singleton agent instances for delegation. Functions in this file that were
// previously hard-coded now delegate to the agent abstraction.
const _agent = new ClaudeCodeAgent();
const _packaging = new ClaudeCodePackaging();

/**
 * Default Dockerfile uses the base toolchain — no duplication.
 */
const DEFAULT_DOCKERFILE = getToolchainDockerfileContent('base');

/**
 * Map model names (universal monikers or legacy aliases) to Claude model IDs.
 * Delegates to ClaudeCodeAgent.resolveModelId().
 */
export function getModelId(modelName: ModelName): string {
  return _agent.resolveModelId(modelName);
}

export function checkDocker(binary: string = 'docker'): void {
  logger.debug(`Checking ${binary}...`);

  const result = Bun.spawnSync([binary, 'info'], { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    const name = binary.charAt(0).toUpperCase() + binary.slice(1);
    logger.error(`${name} is not installed or not running. Install ${name}: https://docs.${binary}.com/get-${binary}/`);
    process.exit(1);
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
function resolveCustomDockerfile(lazyRoot: string): string | null {
  const config = loadConfig(lazyRoot);
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
 * 2. Toolchain Dockerfile from [docker].toolchain in lazy.toml
 * 3. Embedded default Dockerfile
 *
 * The project's own Dockerfile is NEVER used automatically — it's for the
 * project, not for agent containers. Use `lazy init` to create a Dockerfile.lazy
 * based on the project's Dockerfile if needed.
 */
function getDockerfileContent(lazyRoot: string): { content: string; isCustom: boolean; toolchain?: string } {
  const customPath = resolveCustomDockerfile(lazyRoot);
  if (customPath) {
    return { content: readFileSync(customPath, 'utf-8'), isCustom: true };
  }

  // Check for toolchain config
  const config = loadConfig(lazyRoot);
  const toolchainName = config.docker.toolchain;
  if (toolchainName && isValidToolchain(toolchainName)) {
    return {
      content: getToolchainDockerfileContent(toolchainName as ToolchainName),
      isCustom: false,
      toolchain: toolchainName,
    };
  }

  return { content: DEFAULT_DOCKERFILE, isCustom: false };
}

export function calculateDockerfileHash(lazyRoot: string): string {
  const { content } = getDockerfileContent(lazyRoot);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Determine the Docker image name to use.
 * Default behavior uses 'lazy-runner'. Custom Dockerfiles use 'lazy-custom-{hash}'.
 * Toolchain Dockerfiles use 'lazy-{toolchain}' to avoid conflicts.
 */
export function resolveImageName(lazyRoot: string): string {
  const { isCustom, content, toolchain } = getDockerfileContent(lazyRoot);

  if (isCustom) {
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 12);
    return `lazy-custom-${hash}`;
  }

  if (toolchain) {
    return `lazy-${toolchain}`;
  }

  return IMAGE_NAME;
}

function getImageDockerfileHash(imageName: string, binary: string = 'docker'): string | null {
  const inspect = Bun.spawnSync(
    [binary, 'image', 'inspect', imageName, '--format', `{{index .Config.Labels "${DOCKERFILE_HASH_LABEL}"}}`],
    { stdout: 'pipe', stderr: 'ignore' }
  );

  if (inspect.exitCode !== 0) {
    return null;
  }

  const hash = inspect.stdout.toString().trim();
  return hash || null;
}

async function buildImage(lazyRoot: string, imageName: string, currentHash: string, binary: string = 'docker'): Promise<void> {
  logger.info(`Building ${imageName} container image...`);

  const customPath = resolveCustomDockerfile(lazyRoot);

  let buildCwd: string;
  let dockerfileName: string;

  if (customPath) {
    // Custom Dockerfile: build context is project root, Dockerfile path is the custom one
    buildCwd = lazyRoot;
    dockerfileName = customPath;
    logger.debug(`Using custom Dockerfile: ${customPath}`);
  } else {
    // Write the resolved Dockerfile (toolchain or default) to a temp directory for the build.
    // Never use the project's own Dockerfile — it's for the project, not agents.
    const { content, toolchain } = getDockerfileContent(lazyRoot);
    const tempDir = join(tmpdir(), 'lazy-docker-build');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'Dockerfile'), content);
    buildCwd = tempDir;
    dockerfileName = join(tempDir, 'Dockerfile');
    if (toolchain) {
      logger.debug(`Using toolchain Dockerfile: ${toolchain}`);
    } else {
      logger.debug('Using embedded default Dockerfile');
    }
  }

  const proc = Bun.spawn(
    [binary, 'build', '-t', imageName, '--label', `${DOCKERFILE_HASH_LABEL}=${currentHash}`, '-f', dockerfileName, '.'],
    { cwd: buildCwd, stdout: 'pipe', stderr: 'pipe' }
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

/**
 * Ensure the Docker image is built and up to date.
 * Returns the image name to use for container creation.
 */
export async function ensureImage(binary: string = 'docker'): Promise<string> {
  checkDocker(binary);

  const lazyRoot = getLazyRoot();
  const imageName = resolveImageName(lazyRoot);
  const currentHash = calculateDockerfileHash(lazyRoot);
  const imageHash = getImageDockerfileHash(imageName, binary);

  if (imageHash === null) {
    logger.info('Container image not found.');
    await buildImage(lazyRoot, imageName, currentHash, binary);
  } else if (imageHash !== currentHash) {
    logger.info('Dockerfile has changed, rebuilding image...');
    await buildImage(lazyRoot, imageName, currentHash, binary);
  } else {
    logger.debug('Container image is up to date ✓');
  }

  return imageName;
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
  return join(homedir(), '.lazy', 'bin');
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

  const proc = Bun.spawn(
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

/**
 * Get auth environment variables.
 * Delegates to ClaudeCodeAgent.getAuthEnv().
 */
export function getAuthEnv(): { key: string; value: string } {
  return _agent.getAuthEnv();
}

function buildDockerArgs(sandbox: SandboxConfig, claudeArgs: string[], agentBinaryPath: string, imageName: string, binary: string = 'docker', options?: DockerRunOptions): string[] {
  const auth = getAuthEnv();
  const repoRoot = getLazyRoot();

  return [
    binary, 'run', '--rm', '--init',
    ...(options?.dockerAgentRoot ? ['--user', 'root'] : []),
    ...(options?.dockerAgentNoNetwork ? ['--network', 'none'] : []),
    '-v', `${repoRoot}:${repoRoot}`,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    '-e', `${auth.key}=${auth.value}`,
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
  dockerOptions?: DockerRunOptions,
): Promise<AgentResponse> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  const claudeArgs = [
    'claude', '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (model) {
    claudeArgs.push('--model', model);
  }

  logger.debug('Setting up sandbox...');
  const args = buildDockerArgs(sandbox, claudeArgs, agentBinaryPath, imageName, binary, dockerOptions);

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
  }

  logger.info('Running Claude Code...');

  const proc = Bun.spawn(args, {
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

export async function resumeClaude(
  claudeSessionId: string,
  prompt: string,
  sandbox: SandboxConfig,
  verbose: boolean = false,
  debug: boolean = false,
  model?: string,
  binary: string = 'docker',
): Promise<AgentResponse> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  const claudeArgs = [
    'claude', '-p', prompt,
    '--resume', claudeSessionId,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (model) {
    claudeArgs.push('--model', model);
  }

  logger.info('Resuming Claude Code session...');
  logger.debug(`Claude session ID: ${claudeSessionId}`);

  const args = buildDockerArgs(sandbox, claudeArgs, agentBinaryPath, imageName, binary);

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
  }

  const proc = Bun.spawn(args, {
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
  return {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Build Docker args for async (detached) execution.
 * No --rm flag, adds --name for status tracking, runs detached (-d).
 */
function buildDockerArgsAsync(
  containerName: string,
  sandbox: SandboxConfig,
  claudeArgs: string[],
  agentBinaryPath: string,
  imageName: string,
  binary: string = 'docker',
  options?: DockerRunOptions,
): string[] {
  const auth = getAuthEnv();
  const repoRoot = getLazyRoot();

  return [
    binary, 'run', '-d', '--init',
    ...(options?.dockerAgentRoot ? ['--user', 'root'] : []),
    ...(options?.dockerAgentNoNetwork ? ['--network', 'none'] : []),
    '--name', containerName,
    '-v', `${repoRoot}:${repoRoot}`,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    '-e', `${auth.key}=${auth.value}`,
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    imageName,
    ...claudeArgs,
  ];
}

/**
 * Launch Claude Code in a detached Docker container.
 * Returns immediately after the container starts.
 */
export async function launchClaudeAsync(
  prompt: string,
  sandbox: SandboxConfig,
  containerName: string,
  debug: boolean = false,
  model?: string,
  binary: string = 'docker',
): Promise<void> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  const claudeArgs = [
    'claude', '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (model) {
    claudeArgs.push('--model', model);
  }

  logger.debug('Setting up sandbox for async launch...');
  const args = buildDockerArgsAsync(containerName, sandbox, claudeArgs, agentBinaryPath, imageName, binary);

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
  }

  logger.info('Launching Claude Code (async)...');

  const result = Bun.spawnSync(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    logger.error(`Failed to launch container: ${stderr}`);
    throw new Error(`Failed to launch container: ${stderr}`);
  }

  logger.debug(`Container ${containerName} launched`);
}

/**
 * Resume Claude Code in a detached Docker container.
 * Returns immediately after the container starts.
 */
export async function resumeClaudeAsync(
  claudeSessionId: string,
  prompt: string,
  sandbox: SandboxConfig,
  containerName: string,
  debug: boolean = false,
  model?: string,
  binary: string = 'docker',
): Promise<void> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  const claudeArgs = [
    'claude', '-p', prompt,
    '--resume', claudeSessionId,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  if (model) {
    claudeArgs.push('--model', model);
  }

  logger.info('Launching Claude Code resume (async)...');
  logger.debug(`Claude session ID: ${claudeSessionId}`);

  const args = buildDockerArgsAsync(containerName, sandbox, claudeArgs, agentBinaryPath, imageName, binary);

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
  }

  const result = Bun.spawnSync(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    logger.error(`Failed to launch container: ${stderr}`);
    throw new Error(`Failed to launch container: ${stderr}`);
  }

  logger.debug(`Container ${containerName} launched for resume`);
}

/**
 * Check if a Docker container is currently running.
 * Returns false if Docker is not available.
 */
export function isContainerRunning(containerName: string, binary: string = 'docker'): boolean {
  try {
    const result = Bun.spawnSync(
      [binary, 'ps', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a Docker container exists (running or stopped).
 * Returns false if Docker is not available.
 */
export function containerExists(containerName: string, binary: string = 'docker'): boolean {
  try {
    const result = Bun.spawnSync(
      [binary, 'ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the exit code of a stopped container, or null if still running.
 * Returns null if Docker is not available.
 */
export function getContainerExitCode(containerName: string, binary: string = 'docker'): number | null {
  try {
    const result = Bun.spawnSync(
      [binary, 'inspect', containerName, '--format', '{{.State.Running}} {{.State.ExitCode}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) return null;

    const output = result.stdout.toString().trim();
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
    const result = Bun.spawnSync(
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
export function getContainerLogs(containerName: string, tailLines: number = 50, binary: string = 'docker'): string | null {
  try {
    const result = Bun.spawnSync(
      [binary, 'logs', '--tail', String(tailLines), containerName],
      { stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) return null;
    // Combine stdout and stderr since docker logs splits them
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    return (stdout + stderr).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Remove a Docker container. Logs a warning on failure but does not throw.
 * No-op if Docker is not available.
 */
export function removeContainer(containerName: string, binary: string = 'docker'): void {
  try {
    const result = Bun.spawnSync(
      [binary, 'rm', '-f', containerName],
      { stdout: 'ignore', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      logger.warn(`Failed to remove container ${containerName} (exit ${result.exitCode}): ${stderr}`);
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
export function getContainerInfo(containerName: string, binary: string = 'docker'): ContainerInfo | null {
  try {
    const result = Bun.spawnSync(
      [binary, 'inspect', containerName, '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.FinishedAt}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) return null;

    const output = result.stdout.toString().trim();
    const parts = output.split(' ');
    if (parts.length < 3) return null;

    const running = parts[0] === 'true';
    const exitCode = parseInt(parts[1], 10);
    // FinishedAt is "0001-01-01T00:00:00Z" when never finished (still running or never started)
    const finishedAt = parts.slice(2).join(' ');
    const isZeroTime = finishedAt.startsWith('0001-01-01');

    return {
      running,
      exitCode,
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
    'child_pid=""',
    'trap \'[ -n "$child_pid" ] && kill $child_pid 2>/dev/null; wait; exit\' TERM INT',
    'while true; do',
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
  dockerOptions?: DockerRunOptions,
): Promise<void> {
  const [imageName, agentBinaryPath] = await Promise.all([
    ensureImage(binary),
    ensureAgentBinary(),
  ]);

  const auth = getAuthEnv();
  const repoRoot = getLazyRoot();

  const wrapperScript = buildSupervisorWrapperScript(protocolDir, sandbox.worktreePath);

  const args = [
    binary, 'run', '-d', '--init',
    ...(dockerOptions?.dockerAgentRoot ? ['--user', 'root'] : []),
    ...(dockerOptions?.dockerAgentNoNetwork ? ['--network', 'none'] : []),
    '--name', containerName,
    '-v', `${repoRoot}:${repoRoot}`,
    '-v', `${protocolDir}:${protocolDir}`,
    '-w', sandbox.worktreePath,
    '-v', `${sandbox.sandboxPath}/.claude:/home/user/.claude`,
    '-v', `${sandbox.sandboxPath}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    '-e', `${auth.key}=${auth.value}`,
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    imageName,
    'sh', '-c', wrapperScript,
  ];

  if (debug) {
    console.log('[DEBUG] Running container command:', args.join(' '));
  }

  logger.info('Launching supervisor container...');

  const result = Bun.spawnSync(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    logger.error(`Failed to launch supervisor container: ${stderr}`);
    throw new Error(`Failed to launch supervisor container: ${stderr}`);
  }

  logger.debug(`Supervisor container ${containerName} launched`);
}
