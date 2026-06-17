/**
 * `lazy doctor` — verify installation health and report issues.
 *
 * Runs a series of checks (Docker, auth, git, directory structure, image,
 * locks, containers, disk space) and prints a pass/fail summary with
 * actionable fix instructions for any failures.
 */

import { existsSync, readdirSync, readFileSync, statfsSync } from 'fs';
import { join } from 'path';
import { getHome } from '../../utils/home';
import { findLazyRoot, getDataDir } from '../init';
import { getProjectName } from '../../storage';
import { TERMINAL_STATUSES } from '../../types';
import { createStorage } from '../../storage';
import { theme } from '../theme';
import { shortId, displayId, parseFlags, taskRef } from '../helpers';
import { repoHasCommits } from '../../git/operations';
import { resolveImageName, calculateDockerfileHash } from '../../capture/claude';
import { loadConfig, loadRawConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';
import { findUnknownConfigKeys } from '../../config/schema';
import { getKnownFeatures, getUnknownFlags, isFeatureEnabled } from '../../utils/features';
import { createDriver } from '../../remote';
import type { ResolvedConfig } from '../../config/types';
import type { RepositoryDriver } from '../../remote';
import { getOfflineStatus } from '../../utils/offline';
import { detectShell, getCompletionSetupCommand, getShellConfigFile } from '../../shell/detect';
import type { ShellInfo } from '../../shell/detect';
import { spawnSync } from '../../utils/spawn';
import { runGit } from '../../utils/git';
import { which } from 'bun';

// ── types ────────────────────────────────────────────────────────────────

interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;  // shown on failure
  warning?: string; // shown as yellow warning even when ok
}

// Docker timeout mirrors the one in capture/claude.ts
const DOCKER_TIMEOUT_MS = 10_000;

// Minimum free disk space (1 GB)
const MIN_FREE_BYTES = 1_000_000_000;

// ── individual checks ────────────────────────────────────────────────────

async function checkGit(): Promise<CheckResult> {
  try {
    const result = await runGit(['--version'], {
      stderr: 'ignore',
      timeout: 5_000,
    });
    if (result.exitCode === 0) {
      const version = result.stdout.replace('git version ', '');
      return { ok: true, label: `Git installed (v${version})` };
    }
  } catch { /* fall through */ }
  return { ok: false, label: 'Git installed', detail: 'Git is not installed. Install it: https://git-scm.com/downloads' };
}

async function checkGitHasCommits(): Promise<CheckResult> {
  if (await repoHasCommits()) {
    return { ok: true, label: 'Repository has commits' };
  }
  return {
    ok: false,
    label: 'Repository has commits',
    detail: `Repository has no commits. Lazy requires at least one commit to function.\n  Run: ${theme.command("git commit --allow-empty -m 'Initial commit'")}`,
  };
}

function checkAuth(): CheckResult {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { ok: true, label: 'API auth configured (OAuth token)' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { ok: true, label: 'API auth configured (API key)' };
  }
  return {
    ok: false,
    label: 'API auth configured',
    detail: `No authentication found. Set CLAUDE_CODE_OAUTH_TOKEN (run ${theme.command('claude setup-token')}) or ANTHROPIC_API_KEY.`,
  };
}

async function checkPostgresConnectivity(config: ResolvedConfig): Promise<CheckResult> {
  if (config.storage.backend !== 'postgres') {
    return { ok: true, label: 'PostgreSQL connectivity (not using postgres backend)' };
  }

  // Credentials come from environment variables, never from lazy.toml
  const url = process.env.LAZY_POSTGRES_URL;
  const host = process.env.PGHOST ?? 'localhost';
  const port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
  const database = process.env.PGDATABASE ?? 'lazy';

  if (!url && !process.env.PGHOST) {
    return {
      ok: false,
      label: 'PostgreSQL connectivity',
      detail: 'No PostgreSQL connection configured. Set LAZY_POSTGRES_URL in .env or set PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.',
    };
  }

  try {
    const postgres = await import('postgres');
    const ssl = config.storage.postgres_ssl ? { rejectUnauthorized: true } : undefined;
    const sql = url
      ? postgres.default(url, { max: 1, ssl })
      : postgres.default({
          host,
          port,
          database,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          max: 1,
          ssl,
        });

    try {
      // Test connection with a simple query
      await sql`SELECT 1 as test`;

      // Check schema version
      const [version] = await sql`
        SELECT version FROM schema_version ORDER BY version DESC LIMIT 1
      `.catch(() => [] as { version: number }[]);

      await sql.end();

      const connLabel = url ? 'LAZY_POSTGRES_URL' : `${host}:${port}/${database}`;
      if (version) {
        return {
          ok: true,
          label: `PostgreSQL connected (${connLabel}, schema v${version.version})`
        };
      } else {
        return {
          ok: true,
          label: `PostgreSQL connected (${connLabel}, schema not initialized)`,
          warning: 'Schema not initialized. Run any lazy command to initialize the database schema.'
        };
      }
    } catch (err) {
      await sql.end();
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        label: 'PostgreSQL connectivity',
        detail: `Failed to connect to PostgreSQL: ${message}\n  Check LAZY_POSTGRES_URL in .env or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD env vars.`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      label: 'PostgreSQL connectivity',
      detail: `Failed to load postgres driver: ${message}`,
    };
  }
}

async function checkDataDir(root: string): Promise<CheckResult> {
  const dataDir = getDataDir(root);
  const dataPath = join(root, dataDir);

  if (!existsSync(dataPath)) {
    return { ok: false, label: 'Data directory exists', detail: `${dataDir}/ directory not found. Run ${theme.command('lazy init')}.` };
  }

  // Resolve the actual tasks directory based on storage backend config
  const config = await loadConfig(root);
  let tasksDir: string;
  let displayPath: string;

  switch (config.storage.backend) {
    case 'postgres':
      // PostgreSQL backend doesn't use local directories
      return { ok: true, label: 'Data storage valid (PostgreSQL)' };
    case 'external': {
      let externalPath = config.storage.external_path;
      if (!externalPath || externalPath === '') {
        const projectName = await getProjectName(root, config.remote.git_remote);
        externalPath = join(getHome(), '.lazy', projectName);
      }
      tasksDir = join(externalPath, 'tasks');
      displayPath = externalPath;
      break;
    }
    default:
      throw new Error(`Unknown storage backend: "${config.storage.backend}". Valid backends are "external" and "postgres".`);
  }

  if (!existsSync(tasksDir)) {
    return { ok: false, label: 'Data directory valid', detail: `${displayPath}/tasks/ directory missing. Storage may be corrupted.` };
  }

  return { ok: true, label: `Data directory valid (${displayPath})` };
}

// spawnSync (sync) is acceptable throughout this function: `lazy doctor` is a
// one-shot CLI health check, not a daemon path — blocking here is fine.
function checkContainerImage(imageName: string, binary: string = 'docker'): CheckResult {
  try {
    const result = spawnSync(
      [binary, 'image', 'inspect', imageName, '--format', '{{.Id}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
    if (result.exitCode === 0 && result.stdout.toString().trim().length > 0) {
      return { ok: true, label: `Container image exists (${imageName})` };
    }
  } catch { /* fall through */ }
  return {
    ok: false,
    label: 'Container image exists',
    detail: `${imageName} image not found. It will be built automatically on first \`lazy start\`.`,
  };
}

async function checkImageUpToDate(root: string, imageName: string, binary: string = 'docker'): Promise<CheckResult> {
  // Use the same Dockerfile hash logic as the build code in capture/claude.ts.
  // This hashes the custom Dockerfile if configured, or the embedded default
  // Dockerfile — never the project's own Dockerfile at the repo root.
  let currentHash: string;
  try {
    currentHash = await calculateDockerfileHash(root);
  } catch (err) {
    // calculateDockerfileHash throws if a custom Dockerfile is configured but missing
    return {
      ok: false,
      label: 'Container image up to date',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    // spawnSync (sync) is acceptable: `lazy doctor` is a one-shot CLI health
    // check, not a daemon path — blocking here is fine.
    const inspect = spawnSync(
      [binary, 'image', 'inspect', imageName, '--format', '{{index .Config.Labels "lazy.dockerfile.hash"}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
    if (inspect.exitCode === 0) {
      const imageHash = inspect.stdout.toString().trim();
      if (imageHash === currentHash) {
        return { ok: true, label: 'Container image up to date' };
      }
      return {
        ok: false,
        label: 'Container image up to date',
        detail: `Dockerfile has changed since the image was built. Run ${theme.command('lazy upgrade')} to rebuild.`,
      };
    }
  } catch { /* fall through */ }

  // Image doesn't exist — already reported by checkContainerImage
  return { ok: true, label: 'Container image up to date' };
}

function checkStaleLocks(root: string): CheckResult {
  const dataDir = getDataDir(root);
  const worktreesDir = join(root, dataDir, 'worktrees');
  if (!existsSync(worktreesDir)) {
    return { ok: true, label: 'No stale locks' };
  }

  const stale: string[] = [];
  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lockPath = join(worktreesDir, entry.name, '.lazy-lock');
      if (!existsSync(lockPath)) continue;
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        if (lockData.pid) {
          try {
            process.kill(lockData.pid, 0);
            // Process alive — lock is valid
          } catch {
            // Process dead — stale lock
            stale.push(entry.name);
          }
        }
      } catch {
        stale.push(entry.name);
      }
    }
  } catch { /* fall through */ }

  if (stale.length === 0) {
    return { ok: true, label: 'No stale locks' };
  }
  return {
    ok: false,
    label: 'No stale locks',
    detail: `${stale.length} stale lock(s) found in worktrees: ${stale.join(', ')}. ` +
            `Remove with: ${theme.command(`rm ${stale.map(s => join(worktreesDir, s, '.lazy-lock')).join(' ')}`)}`,
  };
}

function checkStorageLock(root: string): CheckResult {
  const dataDir = getDataDir(root);
  const lockPath = join(root, dataDir, '.storage-lock');
  if (!existsSync(lockPath)) {
    return { ok: true, label: 'No stale storage lock' };
  }

  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (lockData.pid) {
      try {
        process.kill(lockData.pid, 0);
        // Process alive — lock is valid
        return { ok: true, label: 'No stale storage lock' };
      } catch {
        return {
          ok: false,
          label: 'No stale storage lock',
          detail: `Storage lock held by dead process (pid ${lockData.pid}). Remove with: ${theme.command(`rm ${lockPath}`)}`,
        };
      }
    }
  } catch { /* fall through */ }

  return { ok: true, label: 'No stale storage lock' };
}

// ── exit code explanations ───────────────────────────────────────────────

export function explainExitCode(code: number): string {
  switch (code) {
    case 0: return 'clean exit';
    case 137: return 'killed (OOM or manual stop)';
    case 139: return 'segfault (possibly Docker daemon restart)';
    case 255: return 'Docker daemon error';
    default:
      if (code > 128) return `signal ${code - 128}`;
      return `exit code ${code}`;
  }
}

function formatTimeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── crashed run detection ────────────────────────────────────────────────

interface CrashedTask {
  taskCode: string;
  taskId: string;
  taskStatus: string;
  runName: string;
  exitCode: number;
  finishedAt: string | null;
  explanation: string;
}

/**
 * Find non-terminal tasks whose containers have crashed (stopped unexpectedly).
 * Returns info about each crashed task for display and optional auto-resume.
 */
async function findCrashedTasks(root: string, runner: Runner): Promise<CrashedTask[]> {
  const crashed: CrashedTask[] = [];
  let storage;
  try {
    storage = await createStorage(root);
    // Check interrupted tasks — these are the ones most likely to have crashed runs
    // Also check working/blocked tasks whose runs may have died without reconciliation
    const tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });

    for (const task of tasks) {
      // Only check tasks that have sessions (i.e., have been started)
      const session = await storage.getSessionByTaskId(task.id);
      if (!session) continue;

      const tRef = taskRef(task);
      const runName = session.container_name ?? runner.runNameForTask(tRef);

      const info = await runner.getRunInfo(runName);
      if (!info) continue; // Run doesn't exist or runner unavailable

      // We're looking for stopped runs with non-zero exit codes
      // (or any stopped run for a non-interrupted task — that's unexpected)
      if (info.running) continue;

      // For interrupted tasks: report if run still exists (not yet cleaned up)
      // For working/blocked tasks: run died but reconciler hasn't caught it yet
      if (task.status === 'interrupted' || task.status === 'working' || task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted' || task.status === 'merging') {
        crashed.push({
          taskCode: displayId(task),
          taskId: task.id,
          taskStatus: task.status,
          runName,
          exitCode: info.exitCode,
          finishedAt: info.finishedAt,
          explanation: explainExitCode(info.exitCode),
        });
      }
    }
  } catch {
    // Storage unavailable — skip
  } finally {
    if (storage) await storage.close();
  }
  return crashed;
}

// TERMINAL_STATUSES imported from ../../types

// spawnSync (sync) is acceptable here: `lazy doctor` is a one-shot CLI health
// check, not a daemon path — blocking the (otherwise idle) loop is fine.
async function checkOrphanedContainers(root: string | null, binary: string = 'docker'): Promise<CheckResult> {
  try {
    const result = spawnSync(
      [binary, 'ps', '-a', '--filter', 'name=^lazy-', '--format', '{{.Names}} {{.Status}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      return { ok: true, label: 'No orphaned containers' };
    }

    const output = result.stdout.toString().trim();
    if (!output) {
      return { ok: true, label: 'No orphaned containers' };
    }

    const lines = output.split('\n');

    // Extract stopped and running container names
    const exitedNames = lines
      .filter(l => l.includes('Exited'))
      .map(l => l.split(' ')[0]);

    const runningNames = lines
      .filter(l => l.includes('Up'))
      .map(l => l.split(' ')[0]);

    // Filter containers to only those belonging to the current project
    const exitedOrphans: string[] = [];
    const runningOrphans: string[] = [];

    if (root) {
      let storage;
      try {
        storage = await createStorage(root);

        // Check stopped containers - orphaned if task belongs to this project
        for (const name of exitedNames) {
          const taskShortId = name.replace(/^lazy-/, '');
          if (!taskShortId) continue;
          const task = await storage.getTask(taskShortId);
          // Only report if task exists in this project (meaning container belongs here)
          if (task) {
            exitedOrphans.push(name);
          }
        }

        // Check running containers - orphaned if task is in terminal state in this project
        for (const name of runningNames) {
          const taskShortId = name.replace(/^lazy-/, '');
          if (!taskShortId) continue;
          const task = await storage.getTask(taskShortId);
          // Only report if task exists in this project AND is in terminal status
          if (task && TERMINAL_STATUSES.has(task.status)) {
            runningOrphans.push(name);
          }
        }
      } catch {
        // Storage unavailable — skip checks
      } finally {
        if (storage) await storage.close();
      }
    }

    const allOrphans = [...exitedOrphans, ...runningOrphans];
    if (allOrphans.length === 0) {
      return { ok: true, label: 'No orphaned containers' };
    }

    const parts: string[] = [];
    if (exitedOrphans.length > 0) {
      parts.push(`${exitedOrphans.length} stopped: ${exitedOrphans.join(', ')}`);
    }
    if (runningOrphans.length > 0) {
      parts.push(`${runningOrphans.length} running for completed tasks: ${runningOrphans.join(', ')}`);
    }

    // Stopped containers need rm; running orphans need rm -f
    const cleanupParts: string[] = [];
    if (exitedOrphans.length > 0) {
      cleanupParts.push(`${binary} rm ${exitedOrphans.join(' ')}`);
    }
    if (runningOrphans.length > 0) {
      cleanupParts.push(`${binary} rm -f ${runningOrphans.join(' ')}`);
    }

    return {
      ok: false,
      label: 'No orphaned containers',
      detail: `${allOrphans.length} orphaned lazy container(s): ${parts.join('; ')}. ` +
              `Remove with: ${theme.command(cleanupParts.join(' && '))}`,
    };
  } catch { /* fall through */ }
  return { ok: true, label: 'No orphaned containers' };
}

async function checkShellDetected(): Promise<{ result: CheckResult; shell: ShellInfo }> {
  const shell = await detectShell();

  if (shell.name === 'unknown') {
    return {
      result: {
        ok: true,
        label: 'Shell detected: unknown',
        warning: '$SHELL is not set or unrecognized. Completion checks skipped.',
      },
      shell,
    };
  }

  const versionSuffix = shell.version ? ` v${shell.version}` : '';
  return {
    result: { ok: true, label: `Shell detected: ${shell.name}${versionSuffix} (${shell.path})` },
    shell,
  };
}

function checkCompletionsInstalled(shell: ShellInfo): CheckResult {
  if (shell.name === 'unknown') {
    return { ok: true, label: 'Completions installed (skipped — unknown shell)' };
  }

  // fish doesn't have a completion flag in lazy yet
  if (shell.name === 'fish') {
    return {
      ok: true,
      label: 'Completions installed (fish)',
      warning: 'lazy completion does not support fish yet. Bash and zsh are supported.',
    };
  }

  if (shell.completionInstalled) {
    return { ok: true, label: `Completions installed (${shell.name})` };
  }

  const setupCmd = getCompletionSetupCommand(shell.name);
  const configFile = getShellConfigFile(shell.name);
  const hint = setupCmd
    ? `Add to ${configFile}:\n    ${setupCmd}`
    : `Run: lazy completion --${shell.name}`;

  return {
    ok: true,
    label: `Completions installed (${shell.name})`,
    warning: `Tab completions not detected for ${shell.name}. ${hint}`,
  };
}

function checkTmux(): CheckResult {
  if (which('tmux')) {
    return { ok: true, label: 'tmux installed' };
  }
  return {
    ok: true,
    label: 'tmux (optional)',
    warning: 'tmux not installed. Recommended for terminal multiplexing.',
  };
}

function checkFeatureFlags(config: ResolvedConfig): CheckResult {
  const vanilla = process.env.LAZY_VANILLA === '1';
  const allEnabled = config.features.all === true;
  const knownFeatures = getKnownFeatures();
  const unknownFlags = getUnknownFlags(config);

  // Build status summary
  const parts: string[] = [];

  if (vanilla) {
    parts.push('LAZY_VANILLA=1');
  } else if (allEnabled) {
    parts.push('all = true');
  }

  // Show individual known flag states (getKnownFeatures() guarantees
  // alphabetical order for prompt caching stability)
  for (const flag of knownFeatures) {
    const enabled = isFeatureEnabled(flag, config);
    parts.push(`${flag}: ${enabled ? 'on' : 'off'}`);
  }

  const label = parts.length > 0
    ? `Feature flags (${parts.join(', ')})`
    : 'Feature flags (none configured)';

  const warning = unknownFlags.length > 0
    ? `Unknown feature flag(s) in config: ${unknownFlags.join(', ')}. These may be stale flags from graduated features.`
    : undefined;

  return { ok: true, label, warning };
}

function checkConfigKeys(raw: Record<string, unknown>, driver: RepositoryDriver): CheckResult[] {
  const results: CheckResult[] = [];
  const driverOpts = driver.getConfigOptions();

  // Check for unknown keys (using driver-provided valid keys for [remote])
  const deprecatedKeys = driverOpts.deprecated.map(d => d.key);
  const unknownWarnings = findUnknownConfigKeys(raw, driverOpts.valid, deprecatedKeys);

  if (unknownWarnings.length === 0) {
    results.push({ ok: true, label: 'No unknown config options' });
  }
  for (const w of unknownWarnings) {
    results.push({ ok: true, label: 'Config option', warning: w });
  }

  // Check for deprecated remote keys in [remote] section
  const remoteSection = raw.remote;
  const hasDeprecated = driverOpts.deprecated.some(dep => {
    if (typeof remoteSection !== 'object' || remoteSection === null) return false;
    return dep.key in remoteSection;
  });

  if (!hasDeprecated) {
    results.push({ ok: true, label: 'No deprecated config options' });
  } else {
    for (const dep of driverOpts.deprecated) {
      if (typeof remoteSection === 'object' && remoteSection !== null && dep.key in remoteSection) {
        results.push({
          ok: true,
          label: `Config option 'remote.${dep.key}'`,
          warning: `'remote.${dep.key}' is obsolete. ${dep.alternative}. Remove it from [remote].`,
        });
      }
    }
  }

  return results;
}

async function checkRemoteDriver(config: ResolvedConfig): Promise<{ driver: RepositoryDriver | null; driverResults: CheckResult[] }> {
  const driverResults: CheckResult[] = [];
  const driverName = config.remote.driver;
  let driver: RepositoryDriver | null = null;

  // Show which driver is configured
  driverResults.push({ ok: true, label: `Remote driver: ${driverName}` });

  // Create the driver and render its health checks
  try {
    driver = createDriver(config);
    const checks = await driver.checkHealth();

    for (const check of checks) {
      switch (check.state) {
        case 'ok':
          driverResults.push({ ok: true, label: check.what });
          break;
        case 'warn':
          driverResults.push({ ok: true, label: check.what, warning: check.reason });
          break;
        case 'fail':
          driverResults.push({ ok: false, label: check.what, detail: check.reason });
          break;
      }
    }
  } catch (err) {
    driverResults.push({
      ok: false,
      label: 'Remote driver health',
      detail: `Failed to check driver "${driverName}": ${err instanceof Error ? err.message : err}`,
    });
  }

  return { driver, driverResults };
}

async function checkSplitStorage(root: string): Promise<CheckResult> {
  const config = await loadConfig(root);

  // External storage: check if .lazy/tasks/ also has stale task data
  const dataDir = getDataDir(root);
  const inRepoTasksDir = join(root, dataDir, 'tasks');
  if (!existsSync(inRepoTasksDir)) {
    return { ok: true, label: 'No split storage (external storage clean)' };
  }

  try {
    const entries = readdirSync(inRepoTasksDir, { withFileTypes: true });
    const taskDirs = entries.filter(e => e.isDirectory() && e.name.length === 36);
    if (taskDirs.length === 0) {
      return { ok: true, label: 'No split storage' };
    }

    return {
      ok: false,
      label: 'No split storage',
      detail: `Storage backend is "${config.storage.backend}" but ${dataDir}/tasks/ in the repo ` +
              `contains ${taskDirs.length} task director${taskDirs.length === 1 ? 'y' : 'ies'}. ` +
              `This is stale data from before external storage was configured. ` +
              `Remove with: ${theme.command(`rm -rf ${join(root, dataDir, 'tasks')}`)}`,
    };
  } catch {
    return { ok: true, label: 'No split storage' };
  }
}

async function checkTaskBranchUpstreamTracking(): Promise<CheckResult> {
  try {
    // Get list of all local branches
    const result = await runGit(['branch', '--format=%(refname:short)'], {
      stderr: 'ignore',
      timeout: 5_000,
    });

    if (result.exitCode !== 0) {
      return { ok: true, label: 'No task branches with upstream tracking' };
    }

    const branches = result.stdout.split('\n').filter((b: string) => b.trim() && b.startsWith('lazy/'));
    if (branches.length === 0) {
      return { ok: true, label: 'No task branches with upstream tracking' };
    }

    const tracked: string[] = [];
    for (const branch of branches) {
      const remoteResult = await runGit(['config', `branch.${branch}.remote`], {
        stderr: 'ignore',
        timeout: 1_000,
      });
      if (remoteResult.exitCode === 0 && remoteResult.stdout.trim()) {
        tracked.push(branch);
      }
    }

    if (tracked.length === 0) {
      return { ok: true, label: 'No task branches with upstream tracking' };
    }

    // Build unset commands
    const unsetCommands = tracked.map(branch =>
      `git config --unset branch.${branch}.remote; git config --unset branch.${branch}.merge || true`
    ).join(' && ');

    return {
      ok: true,
      label: 'No task branches with upstream tracking',
      warning: `${tracked.length} task branch(es) have upstream tracking: ${tracked.join(', ')}. ` +
               `This can cause 'git pull' to merge task branches into main. ` +
               `Clean up with: ${theme.command(unsetCommands)}`,
    };
  } catch {
    return { ok: true, label: 'No task branches with upstream tracking' };
  }
}

function checkDiskSpace(root: string): CheckResult {
  try {
    const stats = statfsSync(root);
    const freeBytes = stats.bsize * stats.bavail;
    const freeGB = (freeBytes / 1_000_000_000).toFixed(1);

    if (freeBytes >= MIN_FREE_BYTES) {
      return { ok: true, label: `Disk space adequate (${freeGB} GB free)` };
    }
    return {
      ok: false,
      label: 'Disk space adequate',
      detail: `Only ${freeGB} GB free. Lazy needs at least 1 GB for Docker images and worktrees.`,
    };
  } catch {
    // statfsSync not available on all platforms
    return { ok: true, label: 'Disk space (check skipped)' };
  }
}

// ── main ─────────────────────────────────────────────────────────────────

export async function commandDoctor(args: string[]): Promise<void> {
  // Parse flags
  const parsed = parseFlags(args, [
    { name: 'no-resume', takesValue: false },
    { name: 'dry-run', takesValue: false },
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'doctor');

  const noResume = parsed.flags.get('no-resume') === true;
  const dryRun = parsed.flags.get('dry-run') === true;
  const yes = parsed.flags.get('yes') === true;

  // If a positional argument is provided, run task-specific diagnostics
  if (parsed.positional.length > 0) {
    const { commandDoctorTask } = await import('./doctor-task');
    await commandDoctorTask(parsed.positional[0], { dryRun, yes });
    return;
  }

  const results: CheckResult[] = [];

  // Always run these regardless of lazy root
  results.push(await checkGit());
  results.push(await checkGitHasCommits());

  // Checks that require a lazy root
  const root = findLazyRoot();
  let crashedTasks: CrashedTask[] = [];

  // Determine runner type for conditional checks
  const config = root ? await loadConfig(root) : null;
  const runnerType = config?.runner?.type ?? 'docker';
  const runner = root ? await createRunner(root) : null;

  const isContainerRunner = runnerType === 'docker' || runnerType === 'podman';

  // Runner-specific health checks — each runner knows what it needs.
  // DockerRunner checks Docker; PodmanRunner checks Podman; HostProcessRunner checks claude CLI.
  const diag = runner ? await runner.diagnose() : [];
  if (runner) {
    for (const check of diag) {
      switch (check.state) {
        case 'ok':
          results.push({ ok: true, label: check.what });
          break;
        case 'warn':
          results.push({ ok: true, label: check.what, warning: check.reason });
          break;
        case 'fail':
          results.push({ ok: false, label: check.what, detail: check.reason });
          break;
      }
    }
  }

  results.push(checkAuth());

  // Shell and completion checks
  const { result: shellResult, shell } = await checkShellDetected();
  results.push(shellResult);
  results.push(checkCompletionsInstalled(shell));
  results.push(checkTmux());

  // Container-dependent checks only run if the runner's own diagnostics all passed
  const runnerDiagnosticsOk = runner
    ? diag.every(c => c.state !== 'fail')
    : false;

  if (root) {
    results.push(await checkDataDir(root));

    // Offline mode status
    const offlineStatus = await getOfflineStatus(join(root, '.lazy'));
    if (offlineStatus.enabled) {
      results.push({
        ok: true,
        label: 'Offline mode',
        warning: `ENABLED since ${offlineStatus.enabled_at ?? 'unknown'}${offlineStatus.configured_driver ? ` (${offlineStatus.configured_driver} driver suspended)` : ''}. Run 'lazy system online' to restore remote operations.`,
      });
    } else {
      results.push({ ok: true, label: 'Offline mode: off' });
    }

    results.push(await checkPostgresConnectivity(config!));

    // Container-dependent checks (Docker or Podman) — only if runtime is healthy
    if (isContainerRunner && runnerDiagnosticsOk) {
      const imageName = await resolveImageName(root);
      results.push(checkContainerImage(imageName, runnerType));
      results.push(await checkImageUpToDate(root, imageName, runnerType));
      if (runnerType === 'docker') {
        results.push(await checkOrphanedContainers(root));
      } else {
        results.push(await checkOrphanedContainers(root, 'podman'));
      }
    }

    // Detect crashed runs for non-terminal tasks (works for both runner types)
    if (runner) {
      crashedTasks = await findCrashedTasks(root, runner);
      if (crashedTasks.length === 0) {
        results.push({ ok: true, label: 'No crashed task runs' });
      } else {
        const interrupted = crashedTasks.filter(c => c.taskStatus === 'interrupted');
        const other = crashedTasks.filter(c => c.taskStatus !== 'interrupted');
        const parts: string[] = [];
        if (interrupted.length > 0) {
          parts.push(`${interrupted.length} interrupted`);
        }
        if (other.length > 0) {
          parts.push(`${other.length} with dead run`);
        }
        results.push({
          ok: false,
          label: 'No crashed task runs',
          detail: `${crashedTasks.length} task(s) with crashed runs (${parts.join(', ')})`,
        });
      }
    }

    results.push(checkStaleLocks(root));
    results.push(checkStorageLock(root));
    results.push(await checkSplitStorage(root));
    results.push(await checkTaskBranchUpstreamTracking());
    results.push(checkDiskSpace(root));

    // Remote driver checks and config validation
    const rawConfig = await loadRawConfig(root);
    const { driver, driverResults } = await checkRemoteDriver(config!);
    results.push(...driverResults);

    // Config validation (uses driver to know valid/deprecated remote keys)
    if (rawConfig && driver) {
      results.push(...checkConfigKeys(rawConfig, driver));
    }

    // Feature flags status
    results.push(checkFeatureFlags(config!));
  } else {
    console.log('Note: Not in a lazy project. Skipping project-specific checks.\n');
  }

  // Print results
  for (const r of results) {
    if (r.ok) {
      console.log(theme.success(`\u2713 ${r.label}`));
      if (r.warning) {
        console.log(theme.warning(`  ! ${r.warning}`));
      }
    } else {
      console.log(theme.error(`\u2717 ${r.label}`));
      if (r.detail) {
        console.log(`  ${r.detail}`);
      }
    }
  }

  // Print crashed run details and auto-resume
  if (crashedTasks.length > 0) {
    console.log('');
    console.log(theme.header('Crashed runs:'));
    for (const c of crashedTasks) {
      const timePart = c.finishedAt ? `, died ${formatTimeSince(c.finishedAt)}` : '';
      console.log(`  ${theme.taskId(c.taskCode)} ${theme.status(c.taskStatus)} — ${c.runName} (${c.explanation}${timePart})`);
    }

    // Auto-resume interrupted tasks (default behavior per design)
    const resumable = crashedTasks.filter(c => c.taskStatus === 'interrupted');
    if (resumable.length > 0 && !noResume) {
      console.log('');
      console.log(`Resuming ${resumable.length} interrupted task(s)...`);
      for (const c of resumable) {
        const code = c.taskCode;
        console.log(`  Resuming ${theme.taskId(code)}...`);
        try {
          const proc = spawnSync(
            [process.argv[0], process.argv[1], 'resume', code],
            {
              stdout: 'pipe',
              stderr: 'pipe',
              cwd: root!,
              env: process.env,
              timeout: 60_000,
            }
          );
          if (proc.exitCode === 0) {
            console.log(theme.success(`    Resumed ${code}`));
          } else {
            const stderr = proc.stderr.toString().trim();
            console.log(theme.error(`    Failed to resume ${code}: ${stderr || `exit ${proc.exitCode}`}`));
          }
        } catch (err) {
          console.log(theme.error(`    Failed to resume ${code}: ${err instanceof Error ? err.message : err}`));
        }
      }
    } else if (resumable.length > 0 && noResume) {
      console.log('');
      console.log(`${resumable.length} task(s) can be resumed. Run without --no-resume or use: lazy resume <task_id>`);
    }
  }

  // Summary
  const failures = results.filter(r => !r.ok);
  console.log('');
  if (failures.length === 0) {
    console.log(theme.success('All good! Lazy is ready to use.'));
  } else {
    console.log(theme.error(`${failures.length} issue${failures.length > 1 ? 's' : ''} found.`));
    process.exit(1);
  }
}

export function doctorUsage(): void {
  console.log(`Usage: lazy doctor [--no-resume]
       lazy doctor <task-id> [--dry-run] [--yes]

Check the health of your lazy installation, or diagnose a specific task.

Options:
  --no-resume   Report crashed containers without auto-resuming interrupted tasks
  --dry-run     Show task issues without offering fixes (task mode only)
  --yes, -y     Apply all fixes without prompting (task mode only)

Project-level checks (no task ID):
  - Git installed and functional
  - Repository has at least one commit
  - Docker installed and daemon running
  - Anthropic API key or OAuth token configured
  - Shell detected and completions installed
  - tmux installed (soft recommendation)
  - Data directory structure valid
  - Container image exists and up to date
  - No stale locks or orphaned containers
  - No split storage (when external storage is configured)
  - Crashed task containers (auto-resumes interrupted tasks by default)
  - No task branches with upstream tracking (prevents git pull pollution)
  - Adequate disk space
  - Unknown or deprecated config options in lazy.toml
  - Remote driver health checks
  - Feature flags status and unknown flag warnings

Task-level checks (with task ID):
  - Stale parent (parent task is complete but child still points to it)
  - Missing local branch (session has a branch but it's gone locally)
  - Missing worktree (non-terminal task with no worktree directory)
  - Local/remote branch divergence
  - Status mismatch (task has work but status is still backlog)
  - Orphaned worktree (directory exists but not registered in git)

Exit code is 0 if all checks pass, 1 if any issues are found.`);
}
