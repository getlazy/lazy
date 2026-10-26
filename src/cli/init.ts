import { setupStorageText, setupGitignoreText, setupRemoteText, LAZY_IGNORE_ENTRIES } from '../git/setup-edits';
import { initializeManagedCheckout } from '../git/managed-setup';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { ensureLazyExcludeBestEffort } from '../git/lazy-exclude';
import { isAbsolute, join, resolve } from 'path';
import {
  LAZY_DIR,
  LEGACY_DIR,
  CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  getDataDir,
  findLazyRoot,
} from '../project-paths';
import { basename } from 'path';
import { getHome } from '../utils/home';
import { DEFAULT_CONFIG, getDefaultConfigTemplate, resolveStoragePath } from '../config/loader';
import { createStorage } from '../storage';
import { isTTY, promptLine, promptChoice, promptYesNo } from './editor';
import { repoHasCommits } from '../git/operations';
import { detectRemote } from '../remote';
import { renderSetupDockerfilePrompt } from './setup-dockerfile-prompt';
import { agentDisplayName } from '../agent/registry';
import { harnessForAgentName } from '../config/agent-profiles';
import { detectShell, getCompletionSetupCommand } from '../shell/detect';
import { theme } from '../render/theme';
import { setSectionBoolean, setSectionNumber, setSectionString } from '../config/toml-edit';
import { enrollAtInit } from './commands/system-passphrase';
import { runGit } from '../utils/git';
import { spawnSyncUnsupervised } from '../utils/spawn';
import { loadConfig } from '../config/loader';
import { isManagedMode } from '../config/managed';
import { withholdRefused } from '../config/managed-withhold';
import { withheldSettingKey } from '../config/agent-profile-advice';
import { discoverCandidateSessions, reimportConversations } from '../import/reimport-conversations';
import {
  countImportableMemories,
  discoverHarnessMemoryFiles,
  importHarnessMemory,
  formatLongDescriptionNotice,
} from '../import/import-harness-memory';
import { refuseIfBoundClone } from './helpers';


interface InitOptions {
  skipAuthCheck?: boolean;
  skipRemoteCheck?: boolean;
  /** @deprecated Use skipRemoteCheck instead */
  skipGitHubCheck?: boolean;
  skipCompletionCheck?: boolean;
  /** Allow init to run without a TTY (for CI/testing). Uses defaults for all prompts. */
  nonInteractive?: boolean;
  /**
   * Place the external store at this path instead of the derived default
   * (`~/.lazy/<project-name>`). This is the seam a provisioning system needs:
   * without a TTY there is no storage prompt, so the store path was previously
   * unreachable from outside and a supervisor had to hand-edit lazy.toml
   * afterwards. Applies whether or not lazy.toml already exists — a flag that
   * silently did nothing on a repo shipping its own config would be worse than
   * no flag at all.
   */
  externalPath?: string;
  /**
   * The runner to configure. Unset: ask on a TTY (docker by default), and
   * leave the config's runner alone without one — never auto-detected.
   */
  runner?: InitRunner;
}

/** Runners `lazy init --runner` can set up. */
export const INIT_RUNNERS = ['docker', 'smolvm'] as const;
export type InitRunner = typeof INIT_RUNNERS[number];

/**
 * Point lazy.toml at the smolvm runner: `[runner] type = "smolvm"` and a
 * `[smolvm]` section with what init can fill in (the binary from
 * `$LAZY_SMOLVM_BINARY` when set, and the machine's default size). Returns
 * the new content and what the user still has to provide.
 */
export function applySmolvmRunner(content: string, env: Record<string, string | undefined> = process.env): { content: string; missing: string[] } {
  // A repository's own lazy.toml may already carry [smolvm] values: keep them.
  let parsed: Record<string, unknown>;
  try { parsed = Bun.TOML.parse(content) as Record<string, unknown>; }
  catch (err) {
    throw new Error(`lazy.toml does not parse, so init cannot set the smolvm runner in it: ${err instanceof Error ? err.message : String(err)}. Fix the file and run \`lazy init --runner smolvm\` again.`);
  }
  const existing = (parsed.smolvm ?? {}) as Record<string, unknown>;
  const has = (key: string) => existing[key] !== undefined && existing[key] !== '';
  let out = setSectionString(content, 'runner', 'type', 'smolvm');
  const missing: string[] = [];
  const envBinary = env.LAZY_SMOLVM_BINARY?.trim() ?? '';
  if (!has('binary')) {
    if (envBinary && isAbsolute(envBinary)) out = setSectionString(out, 'smolvm', 'binary', envBinary);
    else {
      out = setSectionString(out, 'smolvm', 'binary', '');
      missing.push('[smolvm] binary — the absolute path to a vendored smolvm launcher (run lazy system smolvm-install to download, verify and set it)');
    }
  }
  if (!has('image')) {
    out = setSectionString(out, 'smolvm', 'image', '');
    missing.push('[smolvm] image — a lazy daemon image tar the machine boots (build one with lazy system smolvm-build-image)');
  }
  for (const key of ['cpus', 'memory_mib', 'storage_gib'] as const) {
    if (!has(key)) out = setSectionNumber(out, 'smolvm', key, DEFAULT_CONFIG.smolvm[key]);
  }
  return { content: out, missing };
}

/**
 * Apply driver-detected TOML overrides to lazy.toml.
 * Handles dotted keys like 'remote.driver' by finding the [remote] section.
 */
function applyTomlOverrides(configPath: string, overrides: Record<string, string>): void {
  writeFileSync(configPath, setupRemoteText(readFileSync(configPath, 'utf-8'), overrides));
}

/**
 * Point an EXISTING lazy.toml at an external store at `externalPath`.
 *
 * Deliberately not applyTomlOverrides: that helper only rewrites a key that is
 * already there, so on a repo whose committed lazy.toml has no `[storage]`
 * section — or has one without `external_path` — it is a silent no-op. For a
 * provisioning caller that means the daemon quietly opens the wrong store,
 * which is the failure mode this whole flag exists to prevent. So this one
 * upserts: replace the key, else insert into the section, else append the
 * section.
 */
export function setExternalStoragePath(configPath: string, externalPath: string): void {
  writeFileSync(configPath, setupStorageText(readFileSync(configPath, 'utf-8'), externalPath));
}

/**
 * Run driver health check after configuration and report results.
 * Non-blocking: prints status but never fails init.
 */
async function checkDriverHealth(driverName: string): Promise<void> {
  try {
    const { loadConfig } = await import('../config/loader');
    const { createDriver } = await import('../remote');

    const config = await loadConfig(process.cwd());
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
  path?: string;
}

/**
 * Extract project name from git remote URL or directory name.
 * Used for external storage default path.
 */
async function getProjectName(targetDir: string, remoteName: string = 'origin'): Promise<string> {
  try {
    // Try to get remote URL
    const result = await runGit(['remote', 'get-url', remoteName], { cwd: targetDir });

    if (result.exitCode === 0) {
      const url = result.stdout;
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
async function listGitRemotes(repoDir: string): Promise<string[]> {
  try {
    const result = await runGit(['remote'], { cwd: repoDir });
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n').filter(Boolean);
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
  const remotes = await listGitRemotes(repoDir);

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
    const options = await Promise.all(remotes.map(async r => {
      // Show the URL alongside each remote name for context
      try {
        const result = await runGit(['remote', 'get-url', r], { cwd: repoDir });
        const url = result.exitCode === 0 ? result.stdout : '';
        return url ? `${r} (${url})` : r;
      } catch {
        return r;
      }
    }));
    const choice = await promptChoice('Multiple git remotes found. Which remote should lazy use?', options);
    return remotes[choice];
  }

  // Non-interactive, multiple remotes, no origin — use the first one
  return remotes[0];
}

/**
 * Prompt user for external storage path.
 */
async function promptStorageChoice(targetDir: string, gitRemote: string = 'origin'): Promise<StorageChoice> {
  const projectName = await getProjectName(targetDir, gitRemote);
  const defaultPath = join(getHome(), '.lazy', projectName);
  console.log('');
  console.log('Lazy stores task state outside the repo by default (~/.lazy/<project-name>).');
  const path = await promptLine('External storage path', defaultPath);
  return { path };
}

/**
 * Check authentication setup and print guidance.
 * Non-blocking: prints status/guidance but never fails.
 */
function checkAuthSetup(): void {
  console.log('');
  console.log('Checking authentication...');

  // Check for Claude Code CLI installation.
  // A sync spawn is acceptable: `lazy init` is one-shot CLI startup that
  // runs once before any event loop matters.
  const claudeCheck = spawnSyncUnsupervised(['claude', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    // Bounded at 10s: a wedged `claude` must not hang init forever, and the
    // default backstop is far longer than a `--version` should take.
    timeout: 10_000,
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

/**
 * Ignore entries `lazy init` ensures are present in the project's .gitignore.
 *
 * `.lazy/` is deliberately a single blanket rule rather than an enumeration of
 * the paths lazy writes: nothing lazy puts in a project's `.lazy/` is meant to
 * be tracked, and every enumerated list goes stale the moment lazy learns to
 * write a new file there (each staleness being a fresh chance to leak runtime
 * state into someone's commit).
 *
 * `.lazy-task-sandbox/` and `.lazy-lock` are NOT covered by `.lazy/`: gitignore
 * matches whole path components, so `.lazy/` matches a directory named exactly
 * `.lazy` and never these sibling prefixes. They need their own entries.
 */
export { LAZY_IGNORE_ENTRIES } from '../git/setup-edits';
export async function updateGitignore(targetDir: string): Promise<boolean> {
  const path = join(targetDir, '.gitignore');
  const before = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const after = before === null ? LAZY_IGNORE_ENTRIES.join('\n') + '\n' : setupGitignoreText(before);
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

/**
 * A .gitignore entry does nothing for files git already tracks. Projects set up
 * under the old in-repo storage backend may still have `.lazy/**` committed, so
 * adding `.lazy/` silently changes nothing for them.
 *
 * Tell the human and hand them the command — do NOT run it. That state may be
 * the only copy of their task history, and untracking it as an init side effect
 * would be exactly the kind of hidden side effect AGENTS.md forbids.
 */
export async function warnAboutTrackedLazyFiles(targetDir: string): Promise<void> {
  // Nothing can be tracked outside a git repo — no check to run, nothing to say.
  if (!existsSync(join(targetDir, '.git'))) return;

  const result = await runGit(['ls-files', '-z', '--', LAZY_DIR], { cwd: targetDir });
  if (result.exitCode !== 0) {
    // Not fatal: the ignore rule is written either way. Say so rather than
    // pretending we checked.
    console.log('');
    console.log(`Note: could not check for tracked files under ${LAZY_DIR}/ (git: ${result.stderr || 'failed'}).`);
    return;
  }

  const tracked = result.stdout.split('\0').filter(Boolean);
  if (tracked.length === 0) return;

  console.log('');
  console.log(`Warning: git is already tracking ${tracked.length} file(s) under ${LAZY_DIR}/`);
  console.log(`  The new ${LAZY_DIR}/ ignore rule does NOT untrack files git already knows about,`);
  console.log('  so they will keep showing up in commits until you untrack them yourself.');
  console.log('');
  console.log('  To stop tracking them (files stay on disk, nothing is deleted):');
  console.log(`    ${theme.command(`git rm -r --cached ${LAZY_DIR}`)}`);
  console.log('');
  console.log('  Then commit that change. Back the directory up first if it holds task');
  console.log('  history you care about — lazy will not do it for you.');
}

/**
 * On a managed (fleet) host, SAY which settings of the repository's lazy.toml
 * this installation will not use — never refuse the init over them.
 *
 * Engineer, 2026-10-08: "Importing must never refuse anything: start, keep
 * refused settings unused, and report them." A refused setting is withheld at
 * every load (src/config/managed-withhold.ts), so the project provisions, the
 * control plane imports the file verbatim, and its Configuration page and
 * `lazy doctor` keep naming what is not used. This only says so at init time
 * too, so the provisioning log is not silent about it.
 *
 * A STRICT NO-OP when managed mode is off.
 */
async function reportUnmanageableConfig(targetDir: string): Promise<void> {
  if (!isManagedMode()) return;

  const configPath = join(targetDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) return;

  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // A lazy.toml that does not parse is not this report's problem — the next
    // config load reports the parse error with the offending line.
    return;
  }

  const { withheld } = withholdRefused(raw, process.env, 'repository');
  if (withheld.length === 0) return;
  console.warn(`${configPath}: ${withheld.length} setting(s) are kept but not used on this managed host:`);
  for (const item of withheld) console.warn(`  ${withheldSettingKey(item)} — ${item.reason}`);
  console.warn('Run `lazy doctor` for details.');
}

export async function init(targetDir: string = process.cwd(), options: InitOptions = {}): Promise<void> {
  const lazyPath = join(targetDir, LAZY_DIR);

  // Before every other check: a bound clone has no local daemon or store to
  // initialize (design doc §4.4, §4.7). `lazy login` deliberately runs before
  // `lazy init` (it anchors at the git root, not a lazy root), so a directory
  // can be bound with no `.lazy/` here yet — the "already initialized"
  // short-circuit below would never catch this case.
  await refuseIfBoundClone('init', targetDir);

  await reportUnmanageableConfig(targetDir);

  if (isManagedMode()) {
    await initializeManagedCheckout(targetDir);
    return;
  }

  // Check for both new and legacy directories
  if (existsSync(lazyPath)) {
    console.log(`Lazy already initialized in ${targetDir}`);
    if (options.runner) {
      console.log(`  --runner ${options.runner} was not applied: init only sets the runner of a new project. ` +
        `Switch it by editing [runner] type in ${CONFIG_FILENAME}.`);
    }
    // Still reconcile .gitignore. Without this, a project initialized before
    // the blanket `.lazy/` rule can never converge onto it — the enumerated
    // entries were written by init, so init is the thing that must retire them.
    // Silent when nothing changes.
    await ensureLazyExcludeBestEffort(targetDir);
    if (await updateGitignore(targetDir)) {
      console.log(`Updated .gitignore: lazy now ignores ${LAZY_DIR}/ wholesale`);
      await warnAboutTrackedLazyFiles(targetDir);
    }
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
  if (!(await repoHasCommits(targetDir))) {
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

  // A managed host runs agents on its own runner and withholds smolvm.
  // Refused before anything is written.
  if (options.runner === 'smolvm' && isManagedMode()) {
    console.error('Error: --runner smolvm is not available on a managed (Lazy Teams) host; it runs agents on its own container runner.');
    process.exit(1);
  }

  // Detect the git remote to use before storage/config setup
  const gitRemote = await chooseGitRemote(targetDir);

  // Prompt for storage location if interactive (and not --non-interactive).
  // An explicit --external-path is the answer to that prompt, so it replaces
  // it rather than being asked on top of it: the caller already decided.
  let storageChoice: StorageChoice = {};
  if (options.externalPath) {
    storageChoice = { path: options.externalPath };
  } else if (isTTY() && !options.nonInteractive) {
    storageChoice = await promptStorageChoice(targetDir, gitRemote);
  }

  // Always create .lazy directory for worktrees and logs
  mkdirSync(lazyPath, { recursive: true });

  // Ensure ~/.lazy/ exists for per-user operational state (agent binaries, logs)
  const userLazyDir = join(getHome(), '.lazy');
  if (!existsSync(userLazyDir)) {
    mkdirSync(userLazyDir, { recursive: true });
    console.log(`Creating ~/.lazy/ for internal housekeeping (agent binaries, protocol state, logs).`);
  }

  // Preserve the configured spelling; filesystem operations use the absolute path.
  const storagePath = storageChoice.path || join(getHome(), '.lazy', await getProjectName(targetDir, gitRemote));
  const resolvedStoragePath = resolveStoragePath(targetDir, storagePath);
  try {
    mkdirSync(resolvedStoragePath, { recursive: true });
  } catch (err: any) {
    throw new Error(`Cannot create storage directory "${storagePath}" (resolved to "${resolvedStoragePath}"): ${err.message}`);
  }

  // Initialize file-based storage — pass the RESOLVED path, not the user input.
  const storage = await createStorage(targetDir, {
    backend: 'external',
    externalPath: resolvedStoragePath,
    configuredPath: storagePath,
  });
  await storage.close();

  // Create default lazy.toml if it doesn't exist
  const configPath = join(targetDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    const template = getDefaultConfigTemplate('external', storagePath, gitRemote);
    writeFileSync(configPath, template);
    console.log(`Created ${CONFIG_FILENAME} with default configuration`);
  } else if (options.externalPath) {
    // The repo ships its own lazy.toml. Its committed `external_path` points
    // wherever its authors' machines keep their store, so leaving it alone
    // would send the daemon to a store the caller never asked for.
    setExternalStoragePath(configPath, storagePath);
    console.log(`Set storage.external_path = "${storagePath}" in ${CONFIG_FILENAME}`);
  }

  // The runner: an explicit --runner, else a question on a TTY. Without
  // either, the config's runner is left as it is — smolvm is never chosen
  // for anyone silently.
  let runnerChoice = options.runner;
  if (!runnerChoice && isTTY() && !options.nonInteractive && !isManagedMode()) {
    // smolvm-solo-guest-uid-mounts (next-release-20261021) brings smolvm back
    // to this prompt once the hardware suite passes.
    await promptChoice('Which runner should run task containers?', [
      'docker — Docker Desktop or a local Docker engine (default)',
    ]);
    runnerChoice = 'docker';
  }
  if (runnerChoice === 'smolvm') {
    const { content, missing } = applySmolvmRunner(readFileSync(configPath, 'utf-8'));
    writeFileSync(configPath, content);
    console.log(`Set [runner] type = "smolvm" and added a [smolvm] section to ${CONFIG_FILENAME}`);
    if (missing.length) {
      console.log('  Still needed before a task can run:');
      for (const line of missing) console.log(`    ${line}`);
    }
    console.log(`  Then check the setup with: ${theme.command('lazy doctor')}`);
  } else if (runnerChoice === 'docker') {
    const content = readFileSync(configPath, 'utf-8');
    const updated = setSectionString(content, 'runner', 'type', 'docker');
    if (updated !== content) {
      writeFileSync(configPath, updated);
      console.log(`Set [runner] type = "docker" in ${CONFIG_FILENAME}`);
    }
  }

  // Detect remote driver and offer to configure
  if (!options.skipRemoteCheck && !options.skipGitHubCheck) {
    const detected = detectRemote(targetDir, gitRemote);
    if (detected) {
      console.log(`\nDetected ${detected.name} remote`);

      let shouldConfigure = true;
      if (isTTY() && !options.nonInteractive) {
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

  // Update .gitignore, and the repository-wide info/exclude that every task
  // worktree sees even when that .gitignore is never committed.
  await ensureLazyExcludeBestEffort(targetDir);
  await updateGitignore(targetDir);
  console.log('Adding lazy entries to .gitignore');
  await warnAboutTrackedLazyFiles(targetDir);

  console.log(`Initialized lazy in ${targetDir}`);
  console.log(`  Storage: external (${storagePath})`);

  if (!options.skipAuthCheck) {
    checkAuthSetup();
  }

  // Recommend shell completions if not already installed
  if (!options.skipCompletionCheck) {
    const shell = await detectShell();
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
  if (isTTY() && !options.nonInteractive && existsSync(join(targetDir, 'README.md'))) {
    console.log('');
    const createFirstTask = await promptYesNo(
      'Would you like to create your first task? We\'ll analyze your README.md and propose improvements.\n' +
      '  (Nothing will be merged without your explicit approval — this is a safe, read-and-propose operation.)\n' +
      '  Create first task?',
      true,
    );

    if (createFirstTask) {
      const firstTaskStorage = await createStorage(targetDir, {
        backend: 'external',
        externalPath: resolvedStoragePath,
        configuredPath: storagePath,
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
  if (isTTY() && !options.nonInteractive && existsSync(join(targetDir, 'Dockerfile'))) {
    // The seeded prompt features the project's OWN agent CLI — lazy init runs
    // for cursor projects too, and a hardcoded Claude Code install would bake
    // the wrong agent into their image.
    //
    // `[agent] agent_id` names a PROFILE; what gets installed into the image is
    // its HARNESS. Lenient: seeding a task is best-effort context and must never
    // be the thing that fails an init, so a name no profile defines falls back
    // to itself and the prompt renderer degrades from there.
    const dockerfileTaskConfig = await loadConfig(targetDir);
    const dockerfileTaskProfile = dockerfileTaskConfig.agent.agent_id;
    const dockerfileTaskHarness =
      harnessForAgentName(dockerfileTaskConfig, dockerfileTaskProfile) ?? dockerfileTaskProfile;
    const dockerfileTaskAgentName = agentDisplayName(dockerfileTaskHarness);
    console.log('');
    console.log('Found a Dockerfile in your project. Lazy can create a Dockerfile.lazy based on it');
    console.log(`that adds ${dockerfileTaskAgentName} to your existing environment — so agents work with your`);
    console.log("project's dependencies and tools.");
    const createDockerfileTask = await promptYesNo(
      "Would you like to create a task for this? (It won't start automatically — you\n" +
      '  can review and start it when ready.)\n' +
      '  Create Dockerfile.lazy task?',
      true,
    );

    if (createDockerfileTask) {
      const dockerfileTaskStorage = await createStorage(targetDir, {
        backend: 'external',
        externalPath: resolvedStoragePath,
        configuredPath: storagePath,
      });
      try {
        const task = await dockerfileTaskStorage.createTask(
          'Create Dockerfile.lazy from project Dockerfile',
          undefined,
          undefined,
          'setup-dockerfile',
        );
        await dockerfileTaskStorage.updateTaskPrompt(
          task.id,
          renderSetupDockerfilePrompt(dockerfileTaskHarness),
        );
        console.log(`  Created task ${task.id.substring(0, 8)} (setup-dockerfile): Create Dockerfile.lazy from project Dockerfile`);
        console.log(`  To start it: ${theme.command('lazy start setup-dockerfile')}`);
      } finally {
        await dockerfileTaskStorage.close();
      }
    }
  }

  // Offer to inherit everything this repo already accumulated under the Claude
  // Code harness: past conversations (→ builder memory) and harness memory files
  // (→ lazy shared memory). Adopting lazy on a repo with existing history should
  // mean inheriting that history — not starting from scratch — and it should read
  // as ONE "inherit your history?" step, not two disjoint prompt blocks.
  //
  // Detection is cheap for both: a readdir of ~/.claude/projects for dirs
  // matching this repo (the per-builder isolation dirs don't exist yet at init),
  // plus a readdir of each match's memory/ subdir. Nothing slows init down.
  if (isTTY() && !options.nonInteractive) {
    try {
      const config = await loadConfig(targetDir);
      const dataDirAbs = join(targetDir, config.data.path);
      const importOpts = { lazyRoot: targetDir, dataDirAbs };

      const [candidates, memoryFiles] = await Promise.all([
        discoverCandidateSessions(importOpts),
        discoverHarnessMemoryFiles(importOpts),
      ]);

      if (candidates.length > 0 || memoryFiles.length > 0) {
        // No daemon exists yet at init, so a direct FileStorage is the storage
        // owner here (init already opens one for first-task creation). Opened
        // once for the whole block so both offers share one handle.
        const importStorage = await createStorage(targetDir, {
          backend: 'external',
          externalPath: resolvedStoragePath,
          configuredPath: storagePath,
        });
        try {
          // Re-running init on a repo that already imported memory must not
          // re-offer records lazy already holds. countImportableMemories is the
          // same discovery pass filtered by the store, so the count in the offer
          // is exactly what an import would add.
          const memoryMissing = memoryFiles.length > 0
            ? await countImportableMemories({ ...importOpts, storage: importStorage })
            : 0;

          if (candidates.length > 0 || memoryMissing > 0) {
            console.log('');
            console.log('This repo already has Claude Code history from before lazy.');
            if (candidates.length > 0) {
              console.log(`  Found ${candidates.length} existing Claude Code session(s) for this repo.`);
            }
            if (memoryMissing > 0) {
              console.log(`  Found ${memoryMissing} Claude Code harness memory record(s) with no lazy counterpart.`);
            }
            console.log('  Lazy can import both, so you inherit your project\'s history instead of');
            console.log('  starting from scratch.');
          }

          if (candidates.length > 0) {
            const doImport = await promptYesNo(`  Import ${candidates.length} conversation(s) as builder memory?`, true);
            if (doImport) {
              const report = await reimportConversations({
                ...importOpts,
                storage: importStorage,
                onImported: (info) => {
                  const short = info.sessionId.substring(0, 8);
                  console.log(`  Imported ${short}  ${info.messageCount} msgs, ${info.totalTokens} tokens`);
                },
              });
              console.log(`  Imported ${report.imported.length} conversation(s) as builder memory.`);
              if (report.skippedEmpty.length > 0) {
                console.log(`  Skipped ${report.skippedEmpty.length} empty/unparseable session(s).`);
              }
            } else {
              console.log(`  You can import later with: ${theme.command('lazy import-conversation')}`);
            }
          }

          if (memoryMissing > 0) {
            const doImport = await promptYesNo(`  Import ${memoryMissing} memory record(s) into lazy shared memory?`, true);
            if (doImport) {
              const report = await importHarnessMemory({
                ...importOpts,
                storage: importStorage,
                onImported: (info) => {
                  console.log(`  Imported memory ${info.name}  (${info.type})`);
                },
              });
              console.log(`  Imported ${report.imported.length} memory record(s) into lazy shared memory.`);
              if (report.skippedEmpty.length > 0) {
                console.log(`  Skipped ${report.skippedEmpty.length} empty memory file(s).`);
              }
              // Curation hint, not a failure: these records were imported.
              const longNotice = formatLongDescriptionNotice(report);
              if (longNotice) {
                console.log(`  ${longNotice}`);
              }
              // Per-record failures are surfaced, never swallowed — the rest of
              // the import still landed.
              for (const { name, error } of report.errors) {
                console.log(`  Could not import memory ${name}: ${error.message}`);
              }
            } else {
              console.log(`  You can import later with: ${theme.command('lazy doctor --import-memory')}`);
            }
          }
        } finally {
          await importStorage.close();
        }
      }
    } catch (err) {
      // Onboarding import is best-effort — a detection/import hiccup must never
      // fail init. Surface it so it isn't silently swallowed, then continue.
      console.log(`  (Skipped Claude Code history import: ${err instanceof Error ? err.message : err})`);
    }
  }

  // Offer branch protection.
  //
  // Protection stays OPT-IN and OFF by default — the offer defaults to "no"
  // and is skipped in silence under --non-interactive/CI, so nothing here
  // changes what a scripted init produces. What it fixes is discovery: a gate
  // nobody knows exists protects nothing.
  //
  // Accepting walks straight into passphrase enrollment, which only works
  // because the passphrase is machine-global: enroll once and every later
  // `lazy init` on this machine skips that half (enrollAtInit returns
  // 'already' without prompting).
  if (isTTY() && !options.nonInteractive) {
    console.log('');
    console.log('Branch protection makes merges into your default branch require a human:');
    console.log('  accepting a task into it asks for an approval passphrase you type yourself,');
    console.log('  so an agent cannot merge its own work there. Off unless you turn it on.');
    const wantProtection = await promptYesNo('  Protect this repo\'s default branch?', false);
    if (wantProtection) {
      try {
        // Same comment-preserving editor `lazy protect` uses, so the template's
        // explanatory [protection] comments survive.
        writeFileSync(
          configPath,
          setSectionBoolean(readFileSync(configPath, 'utf-8'), 'protection', 'enabled', true),
        );
        console.log(`  Set enabled = true under [protection] in ${CONFIG_FILENAME}`);
        const outcome = await enrollAtInit();
        if (outcome === 'already') {
          console.log('  An approval passphrase is already enrolled on this machine — reusing it.');
        } else if (outcome === 'failed') {
          console.log(theme.warning(
            '  Protection is ON but no passphrase is enrolled — gated merges will refuse here.',
          ));
          console.log(`  Enroll when ready: ${theme.command('lazy system passphrase set')}`);
        }
      } catch (err) {
        // Never fail init over the optional offer — say what went wrong and
        // name the two commands that finish the job by hand.
        console.log(theme.warning(
          `  Could not finish protection setup: ${err instanceof Error ? err.message : err}`,
        ));
        console.log(`  Finish by hand: ${theme.command('lazy protect main on')} and ` +
          `${theme.command('lazy system passphrase set')}`);
      }
    } else {
      console.log(theme.separator(`  Left off. Turn it on later with: lazy protect <branch> on`));
    }
  }

  // Recommend builder as next step
  console.log('');
  console.log(`Get started by running: ${theme.command('lazy builder')}`);
}
