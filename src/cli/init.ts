import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { basename } from 'path';
import { getDefaultConfigTemplate } from '../config/loader';
import { createStorage } from '../storage';
import { isTTY, promptLine, promptChoice, promptYesNo } from './editor';
import { repoHasCommits } from '../git/operations';
import { detectRemote } from '../remote';
import setupDockerfilePrompt from '../prompts/setup-dockerfile.md' with { type: 'text' };
import { detectShell, getCompletionSetupCommand } from '../shell/detect';
import { detectToolchain, isValidToolchain } from '../docker/toolchains';
import { theme } from './theme';

const LAZY_DIR = '.lazy';
const LEGACY_DIR = '.workshop';
const CONFIG_FILENAME = 'lazy.toml';
const LEGACY_CONFIG_FILENAME = 'workshop.toml';

/**
 * Find the git repository root from startDir, walking up the directory tree.
 * Handles worktrees by following the .git file to the main repo path.
 * Returns the main repo path, or null if not in a git repo.
 */
export function findGitRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;

  while (true) {
    const gitPath = join(dir, '.git');

    if (existsSync(gitPath)) {
      // Check if .git is a file (worktree) or directory (main repo)
      try {
        const gitContent = readFileSync(gitPath, 'utf-8');
        if (gitContent.startsWith('gitdir:')) {
          // This is a worktree - extract the main repo path
          const match = gitContent.match(/gitdir:\s*(.+?)\/\.git\/worktrees\//);
          if (match) {
            return match[1];
          }
        }
      } catch {
        // .git is a directory (main repo) - fall through
      }
      return dir;
    }

    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Find the lazy root, which is always in the main git repository (not worktrees).
 * In a worktree, .git is a file containing "gitdir: /path/to/main/.git/worktrees/xxx"
 * We parse this to find the main repository, which is where lazy.toml lives.
 *
 * A repo is considered a lazy project if it has:
 * 1. lazy.toml config file, OR
 * 2. .lazy/ directory (in-repo storage), OR
 * 3. .workshop/ directory (legacy un-migrated repos)
 */
export function findLazyRoot(startDir: string = process.cwd()): string | null {
  const gitRoot = findGitRoot(startDir);
  if (!gitRoot) return null;

  // Check if the git root has lazy.toml, .lazy, or legacy .workshop
  if (existsSync(join(gitRoot, CONFIG_FILENAME))) {
    return gitRoot;
  }
  if (existsSync(join(gitRoot, LAZY_DIR))) {
    return gitRoot;
  }
  if (existsSync(join(gitRoot, LEGACY_DIR))) {
    return gitRoot;
  }
  return null;
}

/**
 * Get the data directory name for a lazy root.
 * Returns '.lazy' if it exists, otherwise '.workshop' for un-migrated repos.
 * Fallback: if .lazy/ does not exist but .workshop/ does, use .workshop/ (un-migrated repos).
 * If neither exists, returns '.lazy' (new projects).
 */
export function getDataDir(lazyRoot: string): string {
  if (existsSync(join(lazyRoot, LAZY_DIR))) {
    return LAZY_DIR;
  }
  if (existsSync(join(lazyRoot, LEGACY_DIR))) {
    return LEGACY_DIR;
  }
  return LAZY_DIR;
}

interface InitOptions {
  skipAuthCheck?: boolean;
  skipRemoteCheck?: boolean;
  /** @deprecated Use skipRemoteCheck instead */
  skipGitHubCheck?: boolean;
  skipCompletionCheck?: boolean;
  /** Allow init to run without a TTY (for CI/testing). Uses defaults for all prompts. */
  nonInteractive?: boolean;
  /** Override auto-detected toolchain (e.g., "rust", "node", "ruby-rails"). */
  toolchain?: string;
}

/**
 * Apply driver-detected TOML overrides to lazy.toml.
 * Handles dotted keys like 'remote.driver' by finding the [remote] section.
 */
function applyTomlOverrides(configPath: string, overrides: Record<string, string>): void {
  let content = readFileSync(configPath, 'utf-8');

  for (const [key, value] of Object.entries(overrides)) {
    // Parse dotted key: "remote.driver" → section="remote", field="driver"
    const dotIdx = key.indexOf('.');
    if (dotIdx === -1) continue;

    const section = key.substring(0, dotIdx);
    const field = key.substring(dotIdx + 1);

    // Replace the field value in the section
    const pattern = new RegExp(
      `^(\\[${section}\\]\\s*\\n(?:.*\\n)*?${field}\\s*=\\s*)"[^"]*"`,
      'm',
    );
    content = content.replace(pattern, `$1"${value}"`);
  }

  writeFileSync(configPath, content);
}

/**
 * Run driver health check after configuration and report results.
 * Non-blocking: prints status but never fails init.
 */
async function checkDriverHealth(driverName: string): Promise<void> {
  try {
    const { loadConfig } = await import('../config/loader');
    const { createDriver } = await import('../remote');

    const config = loadConfig(process.cwd());
    const driver = createDriver(config);
    const checks = await driver.checkHealth();

    const hasFail = checks.some(c => c.state === 'fail');
    if (!hasFail) {
      console.log(`  ${driverName} integration verified.`);
    }
    for (const check of checks) {
      if (check.state === 'fail') {
        console.log(`  Warning: ${check.what}${check.reason ? ` — ${check.reason}` : ''}`);
      } else if (check.state === 'warn') {
        console.log(`  Warning: ${check.what}${check.reason ? ` — ${check.reason}` : ''}`);
      }
    }
  } catch (err) {
    console.log(`  Warning: Could not verify ${driverName} integration: ${err instanceof Error ? err.message : err}`);
  }
}

interface StorageChoice {
  backend: 'in-repo' | 'external' | 'orphan-branch';
  path?: string;
}

/**
 * Extract project name from git remote URL or directory name.
 * Used for external storage default path.
 */
function getProjectName(targetDir: string, remoteName: string = 'origin'): string {
  try {
    // Try to get remote URL
    const result = Bun.spawnSync(['git', 'remote', 'get-url', remoteName], {
      cwd: targetDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (result.exitCode === 0) {
      const url = result.stdout.toString().trim();
      // Extract repo name from various URL formats:
      // - git@github.com:user/repo.git
      // - https://github.com/user/repo.git
      // - https://github.com/user/repo
      const match = url.match(/\/([^/]+?)(\.git)?$/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Ignore errors, fall back to directory name
  }

  // Fallback to directory basename
  return basename(targetDir);
}

/**
 * List all git remotes in the repository.
 * Returns an array of remote names (e.g., ['origin', 'upstream']).
 */
function listGitRemotes(repoDir: string): string[] {
  try {
    const result = Bun.spawnSync(['git', 'remote'], {
      cwd: repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) return [];
    return result.stdout.toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Smart remote detection for init.
 * Picks the git remote to use based on what's available:
 * - No remotes → return 'origin' (default, will be configured later)
 * - Single remote → use it
 * - Multiple with 'origin' → prefer 'origin' (backward compat)
 * - Multiple without 'origin' → prompt user to pick
 */
async function chooseGitRemote(repoDir: string): Promise<string> {
  const remotes = listGitRemotes(repoDir);

  if (remotes.length === 0) {
    // No remotes yet — use the default
    return 'origin';
  }

  if (remotes.length === 1) {
    const remote = remotes[0];
    if (remote !== 'origin') {
      console.log(`\nUsing git remote "${remote}" (only remote configured)`);
    }
    return remote;
  }

  // Multiple remotes
  if (remotes.includes('origin')) {
    return 'origin';
  }

  // Multiple remotes, no 'origin' — prompt user
  if (isTTY()) {
    console.log('');
    const options = remotes.map(r => {
      // Show the URL alongside each remote name for context
      try {
        const result = Bun.spawnSync(['git', 'remote', 'get-url', r], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const url = result.exitCode === 0 ? result.stdout.toString().trim() : '';
        return url ? `${r} (${url})` : r;
      } catch {
        return r;
      }
    });
    const choice = await promptChoice('Multiple git remotes found. Which remote should lazy use?', options);
    return remotes[choice];
  }

  // Non-interactive, multiple remotes, no origin — use the first one
  return remotes[0];
}

/**
 * Prompt user for storage location choice.
 * Returns the chosen backend and path (for external storage).
 */
async function promptStorageChoice(targetDir: string, gitRemote: string = 'origin'): Promise<StorageChoice> {
  const options = [
    'External (recommended): Outside the repo in ~/.lazy/<project-name>\n     Keeps repo completely clean. Not tracked in git.',
    'Orphan branch: Git orphan branch "lazy-state"\n     Keeps code branches clean. Tracked in git separately.',
    'In-repo (not recommended): .lazy/ directory on the default branch\n     Simple but noisy. State files appear in your working tree and commits.',
  ];

  console.log('');
  const choice = await promptChoice('Where would you like to store lazy state?', options);

  switch (choice) {
    case 0: {
      const projectName = getProjectName(targetDir, gitRemote);
      const defaultPath = join(homedir(), '.lazy', projectName);
      console.log('');
      const path = await promptLine('External storage path', defaultPath);
      return { backend: 'external', path };
    }

    case 1:
      return { backend: 'orphan-branch' };

    case 2:
      return { backend: 'in-repo' };

    default:
      // promptChoice defaults to 0 on invalid input, so this shouldn't happen
      return { backend: 'external' };
  }
}

/**
 * Check authentication setup and print guidance.
 * Non-blocking: prints status/guidance but never fails.
 */
function checkAuthSetup(): void {
  console.log('');
  console.log('Checking authentication...');

  // Check for Claude Code CLI installation
  const claudeCheck = Bun.spawnSync(['claude', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const claudeInstalled = claudeCheck.exitCode === 0;

  // Check for auth env vars
  const hasOAuth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  if (hasOAuth) {
    console.log('  Authentication: CLAUDE_CODE_OAUTH_TOKEN detected');
  } else if (hasApiKey) {
    console.log('  Authentication: ANTHROPIC_API_KEY detected');
  } else {
    console.log('  Authentication: not configured');
    console.log('');
    if (claudeInstalled) {
      console.log('  Set up authentication for lazy agents:');
      console.log(`    ${theme.command('claude setup-token')}`);
      console.log('');
      console.log('  This configures CLAUDE_CODE_OAUTH_TOKEN, which lazy agents need to run.');
      console.log(`  For interactive use (builder mode), run ${theme.command('claude login')} instead.`);
    } else {
      console.log('  Install Claude Code and set up authentication:');
      console.log(`    ${theme.command('npm install -g @anthropic-ai/claude-code')}`);
      console.log(`    ${theme.command('claude setup-token')}`);
      console.log('');
      console.log('  This configures CLAUDE_CODE_OAUTH_TOKEN for lazy agents.');
    }
  }

  if (!claudeInstalled) {
    console.log('');
    console.log('  Note: Claude Code CLI not found. Install it:');
    console.log(`    ${theme.command('npm install -g @anthropic-ai/claude-code')}`);
  }
}

export async function init(targetDir: string = process.cwd(), options: InitOptions = {}): Promise<void> {
  const lazyPath = join(targetDir, LAZY_DIR);

  // Check for both new and legacy directories
  if (existsSync(lazyPath)) {
    console.log(`Lazy already initialized in ${targetDir}`);
    return;
  }
  const legacyPath = join(targetDir, LEGACY_DIR);
  if (existsSync(legacyPath)) {
    console.log(`Lazy already initialized in ${targetDir} (legacy .workshop/ directory — run scripts/migrate-to-lazy.ts to migrate)`);
    return;
  }

  // Verify we're in a git repo
  if (!existsSync(join(targetDir, '.git'))) {
    console.error(`Error: not a git repository. Run ${theme.command('git init')} first.`);
    process.exit(1);
  }

  // Verify repo has at least one commit
  if (!repoHasCommits(targetDir)) {
    console.error('Error: this git repository has no commits. Please make an initial commit first:');
    console.error(`  ${theme.command("git commit --allow-empty -m 'Initial commit'")}`);
    process.exit(1);
  }

  // Init requires an interactive terminal to display warnings and instructions.
  // --non-interactive is a hidden flag for CI/testing only.
  if (!isTTY() && !options.nonInteractive) {
    console.error('Error: lazy init requires an interactive terminal.');
    process.exit(1);
  }

  // Detect the git remote to use before storage/config setup
  const gitRemote = await chooseGitRemote(targetDir);

  // Prompt for storage location if interactive
  let storageChoice: StorageChoice = { backend: 'in-repo' };
  if (isTTY()) {
    storageChoice = await promptStorageChoice(targetDir, gitRemote);
  }

  // Always create .lazy directory for worktrees and logs
  mkdirSync(lazyPath, { recursive: true });

  // Ensure ~/.lazy/ exists for per-user operational state (agent binaries, logs)
  const userLazyDir = join(homedir(), '.lazy');
  if (!existsSync(userLazyDir)) {
    mkdirSync(userLazyDir, { recursive: true });
    console.log(`Creating ~/.lazy/ for internal housekeeping (agent binaries, protocol state, logs).`);
  }

  // Determine storage path based on backend choice
  let storagePath: string;
  if (storageChoice.backend === 'external') {
    storagePath = storageChoice.path || join(homedir(), '.lazy', getProjectName(targetDir, gitRemote));
    // Create external directory if it doesn't exist
    mkdirSync(storagePath, { recursive: true });
  } else {
    // in-repo or orphan-branch
    storagePath = lazyPath;
  }

  // Initialize file-based storage
  const storage = await createStorage(targetDir, {
    backend: storageChoice.backend,
    externalPath: storageChoice.path,
  });
  await storage.close();

  // Detect or validate toolchain
  let toolchain: string;
  if (options.toolchain) {
    if (!isValidToolchain(options.toolchain)) {
      console.error(`Error: unknown toolchain "${options.toolchain}".`);
      console.error('Available toolchains: base, bun, node, deno, rust, go, cpp, ruby-rails,');
      console.error('  ruby-rails-rust, dotnet, python, python-ml, java, kotlin, swift');
      process.exit(1);
    }
    toolchain = options.toolchain;
    console.log(`Toolchain: ${toolchain} (from --toolchain flag)`);
  } else {
    toolchain = detectToolchain(targetDir);
    console.log(`Toolchain: ${toolchain} (auto-detected)`);
  }

  // Create default lazy.toml if it doesn't exist
  const configPath = join(targetDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    const template = getDefaultConfigTemplate(storageChoice.backend, storageChoice.path, toolchain, gitRemote);
    writeFileSync(configPath, template);
    console.log(`Created ${CONFIG_FILENAME} with default configuration`);
  }

  // Detect remote driver and offer to configure
  if (!options.skipRemoteCheck && !options.skipGitHubCheck) {
    const detected = detectRemote(targetDir, gitRemote);
    if (detected) {
      console.log(`\nDetected ${detected.name} remote`);

      let shouldConfigure = true;
      if (isTTY()) {
        shouldConfigure = await promptYesNo(`Configure ${detected.name} integration?`, true);
      }

      if (shouldConfigure) {
        applyTomlOverrides(configPath, detected.tomlOverrides);
        for (const [key, value] of Object.entries(detected.tomlOverrides)) {
          console.log(`  Set ${key} = "${value}" in lazy.toml`);
        }
        await checkDriverHealth(detected.name);
        console.log(`\n  ${detected.name} configured. Branches will be pushed and PRs created automatically.`);
      }
    }
  }

  // Update .gitignore
  const gitignorePath = join(targetDir, '.gitignore');
  const ignoreEntries = [
    '.lazy-task-sandbox/',
    '.lazy/worktrees/',
    '.lazy/bin/',
    '.lazy/logs/',
    '.lazy/recovery/',
    '.lazy/tasks/*/*.tmp.*',
    '.lazy/tasks/*/*.backup.*',
    '.lazy/tasks/*/protocol/',
    '.lazy/storage.lock',
    '.lazy/.reconcile-lock',
    '.lazy/tmp',
  ];

  if (existsSync(gitignorePath)) {
    let text = readFileSync(gitignorePath, 'utf-8');
    // Remove old .lazy/ or .workshop/ ignore if present
    text = text.replace(/^\.lazy\/\s*$/gm, '');
    text = text.replace(/^\.workshop\/\s*$/gm, '');
    for (const entry of ignoreEntries) {
      if (!text.includes(entry)) {
        text = text.trimEnd() + '\n' + entry + '\n';
      }
    }
    writeFileSync(gitignorePath, text);
  } else {
    writeFileSync(gitignorePath, ignoreEntries.join('\n') + '\n');
  }
  console.log('Adding lazy entries to .gitignore');

  // Display storage location
  let storageDesc: string;
  if (storageChoice.backend === 'external') {
    storageDesc = `external (${storagePath})`;
  } else if (storageChoice.backend === 'orphan-branch') {
    storageDesc = 'orphan-branch (lazy-state)';
  } else {
    storageDesc = `in-repo (${lazyPath})`;
  }

  console.log(`Initialized lazy in ${targetDir}`);
  console.log(`  Storage: ${storageDesc}`);

  if (!options.skipAuthCheck) {
    checkAuthSetup();
  }

  // Recommend shell completions if not already installed
  if (!options.skipCompletionCheck) {
    const shell = detectShell();
    if (shell.name !== 'unknown') {
      const setupCmd = getCompletionSetupCommand(shell.name);
      if (setupCmd && !shell.completionInstalled) {
        console.log('');
        console.log(`Shell detected: ${shell.name}`);
        console.log('  To enable tab completions, add to your shell config:');
        console.log(`    ${theme.command(setupCmd)}`);
      }
    }
  }

  // Offer to create first task if README.md exists
  if (isTTY() && existsSync(join(targetDir, 'README.md'))) {
    console.log('');
    const createFirstTask = await promptYesNo(
      'Would you like to create your first task? We\'ll analyze your README.md and propose improvements.\n' +
      '  (Nothing will be merged without your explicit approval — this is a safe, read-and-propose operation.)\n' +
      '  Create first task?',
      true,
    );

    if (createFirstTask) {
      const firstTaskStorage = await createStorage(targetDir, {
        backend: storageChoice.backend,
        externalPath: storageChoice.path,
      });
      try {
        const task = await firstTaskStorage.createTask(
          'Analyze README.md and propose improvements',
          undefined,
          undefined,
          'onboarding-lazy',
        );
        const prompt = 'Read the project\'s README.md thoroughly. Analyze it for completeness, clarity, and accuracy. ' +
          'Then propose a new improved draft of the README that better documents the project. ' +
          'Focus on what a new contributor would need to know.';
        await firstTaskStorage.updateTaskPrompt(task.id, prompt);
        console.log(`  Created task ${task.id.substring(0, 8)} (onboarding-lazy): Analyze README.md and propose improvements`);
        console.log(`  To start it: ${theme.command('lazy start onboarding-lazy')}`);
      } finally {
        await firstTaskStorage.close();
      }
    }
  }

  // Offer to create Dockerfile.lazy task if Dockerfile exists
  if (isTTY() && existsSync(join(targetDir, 'Dockerfile'))) {
    console.log('');
    console.log('Found a Dockerfile in your project. Lazy can create a Dockerfile.lazy based on it');
    console.log('that adds Claude Code to your existing environment — so agents work with your');
    console.log("project's dependencies and tools.");
    const createDockerfileTask = await promptYesNo(
      "Would you like to create a task for this? (It won't start automatically — you\n" +
      '  can review and start it when ready.)\n' +
      '  Create Dockerfile.lazy task?',
      true,
    );

    if (createDockerfileTask) {
      const dockerfileTaskStorage = await createStorage(targetDir, {
        backend: storageChoice.backend,
        externalPath: storageChoice.path,
      });
      try {
        const task = await dockerfileTaskStorage.createTask(
          'Create Dockerfile.lazy from project Dockerfile',
          undefined,
          undefined,
          'setup-dockerfile',
        );
        await dockerfileTaskStorage.updateTaskPrompt(task.id, setupDockerfilePrompt);
        console.log(`  Created task ${task.id.substring(0, 8)} (setup-dockerfile): Create Dockerfile.lazy from project Dockerfile`);
        console.log(`  To start it: ${theme.command('lazy start setup-dockerfile')}`);
      } finally {
        await dockerfileTaskStorage.close();
      }
    }
  }

  // Recommend builder as next step
  console.log('');
  console.log(`Get started by running: ${theme.command('lazy builder')}`);
}
