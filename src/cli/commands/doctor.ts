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
import { resolveOfflineStatus, formatOfflineExpiry } from '../../utils/offline';
import { detectShell, getCompletionSetupCommand, getShellConfigFile } from '../../shell/detect';
import type { ShellInfo } from '../../shell/detect';
import { spawnSync } from '../../utils/spawn';
import { runGit } from '../../utils/git';
import { which } from 'bun';
import {
  listMissingConversations,
  classifyMissingConversations,
} from '../../import/reimport-conversations';
import {
  countImportableMemories,
  importHarnessMemory,
  formatLongDescriptionNotice,
} from '../../import/import-harness-memory';
import { findHousekeepingConversations } from '../../import/housekeeping-conversation';
import { runReimportBulk } from './import-conversation';
import { requireStorage, tryRemoteStorage } from '../helpers';
import { unresolvedAuthRejection } from '../../proxy/auth-verdict';
import { fetchDaemonCredentialState, ProxyUnavailableError } from '../../daemon/auth-env';
import { credentialFromEnv } from '../../daemon/credential-gate';
import {
  assembleMemorySection,
  formatBytes,
  isLiveMemory,
  recordsNewerThanCompact,
  namesRemovedSinceCompact,
} from '../../memory';
import { isTTY, promptYesNo } from '../editor';
import type { Storage } from '../../storage/interface';
import { classifyProtectedTasks } from '../../protection/edge-gate';

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

const AUTH_PRESENT_LABEL = 'Model credential present';

const NO_CREDENTIAL_REMEDY =
  `Set one in the DAEMON's environment and restart it:\n` +
  `    ${theme.command('claude setup-token')}\n` +
  `    ${theme.command('export CLAUDE_CODE_OAUTH_TOKEN=…')}   (or ANTHROPIC_API_KEY)\n` +
  `    ${theme.command('lazy daemon restart')}`;

/**
 * Is a model credential present — in the environment that actually matters?
 *
 * That environment is the DAEMON's, not this CLI process's. The daemon is the
 * single credential owner (credential-gate.ts) and every agent it launches
 * inherits its env, so reading `process.env` here answered a different question
 * and got it wrong in both directions: in a deployment where the token is
 * exported only for the daemon, doctor reported "not authenticated" while
 * everything worked; a stale token left in the user's shell made doctor report
 * healthy auth the daemon never had.
 *
 * The daemon reports presence + source label only — the token itself never
 * travels to the CLI just so we can print a checkmark (see
 * `handleGetCredentialState`).
 *
 * Degraded mode: when the daemon cannot be reached we still answer, from this
 * process's env, but the check output NAMES the environment consulted so the
 * answer is never mistaken for the daemon's. Same shape as the other
 * daemon-preferring checks here — a diagnostics hiccup must not masquerade as
 * a verdict.
 *
 * PRESENCE, NOT VALIDITY. This check and `checkCredentialAccepted` are
 * deliberately different questions: "a credential is present" vs "upstream
 * accepts it". An expired token passes this one and fails that one — which is
 * exactly the gap that made the builder /login loop unfindable.
 */
async function checkAuth(config: ResolvedConfig | null): Promise<CheckResult> {
  let daemonReason = '';
  try {
    const state = await fetchDaemonCredentialState();
    if (state) {
      if (state.ollama) {
        return { ok: true, label: `${AUTH_PRESENT_LABEL} (Ollama backend — no Anthropic credential needed)` };
      }
      if (state.present) {
        return { ok: true, label: `${AUTH_PRESENT_LABEL} (daemon env: ${state.source})` };
      }
      // Practically unreachable: the gate refuses to start a daemon without a
      // credential. Report it plainly rather than assuming it can't happen.
      return {
        ok: false,
        label: AUTH_PRESENT_LABEL,
        detail:
          `The daemon is running but holds no model credential — every agent it launches will fail to reach the model API.\n  ` +
          NO_CREDENTIAL_REMEDY,
      };
    }
    // null = the daemon RPC is bypassed by design (test / daemon-self mode).
    daemonReason = 'the daemon was not consulted';
  } catch (err) {
    // tryRpc's message is already actionable; keep its first line as the reason.
    const msg = err instanceof Error ? err.message : String(err);
    // Trailing period stripped: the reason is interpolated mid-sentence, in
    // parentheses, and "(Daemon is not running.)" reads as a typo.
    daemonReason = msg.split('\n')[0]!.trim().replace(/\.$/, '');
  }

  // Degraded: answer from THIS process's env, and say so.
  const caveat =
    `Read from this shell's environment, not the daemon's (${daemonReason}). ` +
    `The daemon is the credential owner — agents inherit ITS environment, so this may not be what lazy actually uses. ` +
    `Check it with ${theme.command('lazy daemon status')} and re-run.`;

  if (config?.ollama.enabled) {
    return { ok: true, label: `${AUTH_PRESENT_LABEL} (Ollama backend — no Anthropic credential needed)` };
  }
  const source = credentialFromEnv();
  if (source) {
    return { ok: true, label: `${AUTH_PRESENT_LABEL} (shell env: ${source})`, warning: caveat };
  }
  return {
    ok: false,
    label: AUTH_PRESENT_LABEL,
    detail:
      `No model credential found in this shell's environment, and the daemon could not be asked (${daemonReason}).\n  ` +
      NO_CREDENTIAL_REMEDY,
  };
}

/**
 * How far back to look for auth evidence. Enough to span a working day of
 * traffic without paging the whole trail — the verdict only needs the tail.
 */
const AUTH_VERDICT_RECORDS = 200;

/**
 * Has the model API actually ACCEPTED lazy's credential lately?
 *
 * checkAuth above answers "is a credential set", which is all the daemon gate
 * claims to know (credential-gate.ts: presence, not validity). That gap is what
 * made the builder /login loop unfindable — an expired token is present, so
 * every surface reported healthy while every request 401'd. The proxy records
 * each upstream status, so the honest answer is already on disk; this reads it.
 *
 * Self-clearing by construction: a rejection only counts while no later request
 * succeeded (see unresolvedAuthRejection), so re-exporting a good token and
 * restarting the daemon silences it with no state to reset.
 *
 * Mirrors checkReimportableConversations: prefer the daemon's storage, fall back
 * to a direct read-only handle, and degrade to a skipped check on any error —
 * a diagnostics hiccup must not become a health failure.
 */
async function checkCredentialAccepted(root: string): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    storage = await tryRemoteStorage(root);
    if (!storage) {
      storage = await createStorage(root);
      ownsStorage = true;
    }
    const records = await storage.listAuditRecords({ limit: AUTH_VERDICT_RECORDS });
    const rejection = unresolvedAuthRejection(records);
    if (!rejection) {
      return { ok: true, label: 'Model API accepts lazy credential' };
    }
    const minutesAgo = Math.round((Date.now() - rejection.ts) / 60_000);
    const who = rejection.role ? `${rejection.role} traffic` : 'lazy traffic';
    return {
      ok: false,
      label: 'Model API accepts lazy credential',
      detail:
        `The model API rejected ${who} with HTTP ${rejection.status} ${minutesAgo}m ago and nothing has ` +
        `succeeded since — lazy's credential is present but not valid.` +
        (rejection.error ? `\n  Upstream said: ${rejection.error}` : '') +
        `\n  Mint a new one and give it to the daemon:\n` +
        `    ${theme.command('claude setup-token')}\n` +
        `    ${theme.command('export CLAUDE_CODE_OAUTH_TOKEN=…')}\n` +
        `    ${theme.command('lazy daemon restart')}\n` +
        `  A ${theme.command('/login')} inside a builder fixes only that one session — the daemon keeps ` +
        `handing out its own credential to everything else.`,
    };
  } catch {
    return { ok: true, label: 'Model API accepts lazy credential (check skipped)' };
  } finally {
    if (storage && ownsStorage) await storage.close();
  }
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

/**
 * Detect conversations whose raw JSONL is on disk (shared dir or a per-builder
 * isolation dir) but which never reached the store, and — crucially — tell
 * ROT from HISTORY:
 *
 *   - RECENT misses (modified in the last CAPTURE_ROT_WINDOW_MS, settled for at
 *     least CAPTURE_SETTLE_MS) mean capture is broken RIGHT NOW. This is a
 *     FAILING check: conversation capture has now silently rotted twice, and
 *     both times it was found months later by accident. Failing loudly here is
 *     the whole point.
 *   - OLDER misses are recoverable history (the capture bug fixed in
 *     `fix-conversation-capture`) — a warning, recovered on demand with
 *     `lazy doctor --reimport-conversations`.
 *
 * A session modified within the settle window is ignored: it is probably still
 * being written, and the daemon's capture sweep runs on its own timer.
 *
 * Report-only either way — recovery is never a silent write.
 *
 * Uses a direct read-only Storage (like the crashed-run check) so it works even
 * when the daemon is down; degrades to "no issue" on any storage error rather
 * than failing the health check.
 */
async function checkReimportableConversations(root: string, dataDirAbs: string): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    // Prefer the daemon (it owns storage) so we never open a second FileStorage
    // that contends on the storage lock. Only when there's no daemon (or in
    // test mode) do we fall back to a direct read-only handle we must close.
    storage = await tryRemoteStorage(root);
    if (!storage) {
      storage = await createStorage(root);
      ownsStorage = true;
    }
    const missing = await listMissingConversations({ lazyRoot: root, dataDirAbs, storage });
    const { rotted, historical } = classifyMissingConversations(missing, Date.now());

    if (rotted.length > 0) {
      const newest = Math.max(...rotted.map(m => m.mtimeMs));
      const minutesAgo = Math.round((Date.now() - newest) / 60_000);
      return {
        ok: false,
        label: 'Conversation capture is live',
        detail:
          `${rotted.length} conversation(s) written in the last 24h (most recent ${minutesAgo}m ago) ` +
          `are on disk but never reached the store — live capture is not running. ` +
          `Check the daemon is up (${theme.command('lazy daemon status')}); it runs the capture sweep. ` +
          `Recover the missing ones with: ${theme.command('lazy doctor --reimport-conversations')}`,
      };
    }

    if (historical.length > 0) {
      return {
        ok: true,
        label: 'Conversation capture is live',
        warning:
          `${historical.length} older conversation(s) found on disk but missing from the store ` +
          `(recoverable capture from before ${theme.command('fix-conversation-capture')}). ` +
          `Recover with: ${theme.command('lazy doctor --reimport-conversations')}`,
      };
    }

    return { ok: true, label: 'All conversations captured' };
  } catch {
    // Storage or disk scan unavailable — don't turn a diagnostics hiccup into a
    // health failure. Recovery is opt-in anyway.
    return { ok: true, label: 'Builder conversations captured (check skipped)' };
  } finally {
    // Only close a handle we opened; the daemon-backed RemoteStorage is shared.
    if (storage && ownsStorage) await storage.close();
  }
}

/**
 * Detect harness memory files on disk (shared dir or a per-builder isolation
 * dir) that lazy's shared memory has no record for — the fallout of memory
 * having lived in the Claude Code harness memory dir, inside a per-builder
 * overlay that is never shared and eventually pruned. Report-only: the import
 * is an explicit `lazy doctor --import-memory`, never a silent write.
 *
 * Mirrors checkReimportableConversations: prefers the daemon's storage, falls
 * back to a direct read-only handle, and degrades to "no issue" on any error
 * rather than failing the health check.
 */
async function checkImportableMemories(root: string, dataDirAbs: string): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    storage = await tryRemoteStorage(root);
    if (!storage) {
      storage = await createStorage(root);
      ownsStorage = true;
    }
    const missing = await countImportableMemories({ lazyRoot: root, dataDirAbs, storage });
    if (missing === 0) {
      return { ok: true, label: 'Shared memory up to date' };
    }
    return {
      ok: true,
      label: 'Shared memory',
      warning:
        `${missing} Claude Code harness memory record(s) found on disk with no lazy counterpart. ` +
        `They live in per-builder overlays: unshared, invisible to agents, and pruned over time. ` +
        `Import with: ${theme.command('lazy doctor --import-memory')}`,
    };
  } catch {
    return { ok: true, label: 'Shared memory (check skipped)' };
  } finally {
    if (storage && ownsStorage) await storage.close();
  }
}

/**
 * Report the size of the shared-memory context injected into every builder and
 * agent launch, against `[memory] warn_bytes`.
 *
 * This is the ONLY place the memory-size advisory is spelled out. A launch that
 * finds the context over the threshold prints one generic line pointing here
 * (`MEMORY_CONTEXT_CTA`) — doctor is the single "check engine light" surface, so
 * the diagnosis and the remedy live together here instead of every launch site
 * growing its own bespoke warning.
 *
 * Report-only and never a hard failure, because the threshold itself is
 * advisory: memory past it is still knowledge, so lazy never truncates it and
 * never blocks a launch over it.
 *
 * Mirrors checkImportableMemories: prefers the daemon's storage, falls back to a
 * direct read-only handle, and degrades to a skipped check on any error.
 */
async function checkMemoryContext(root: string, config: ResolvedConfig): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    storage = await tryRemoteStorage(root);
    if (!storage) {
      storage = await createStorage(root);
      ownsStorage = true;
    }

    const records = await storage.listMemories();
    const liveCount = records.filter(isLiveMemory).length;
    if (liveCount === 0) {
      return { ok: true, label: 'Injected memory context (no records)' };
    }

    const compact = await storage.getMemoryCompact();
    const warnBytes = config.memory.warn_bytes;

    // Measure BOTH launch surfaces and report the worst. The builder and agent
    // templates differ in size, so a context can be over the threshold for one
    // and under for the other; reporting a single surface could tell the human
    // "all clear" while the other surface's launches keep warning.
    const builder = assembleMemorySection(records, 'builder', { compact, warnBytes }).measured;
    const agent = assembleMemorySection(records, 'agent', { compact, warnBytes }).measured;
    const measured = builder.bytes >= agent.bytes ? builder : agent;

    const written = compact ? recordsNewerThanCompact(records, compact).length : 0;
    const removed = compact ? namesRemovedSinceCompact(records, compact).length : 0;
    const compactState = compact
      ? `Compact generated ${formatTimeSince(new Date(compact.generated_at).toISOString())} ` +
        `(${compact.method}, covering ${compact.covered.length} record(s)); ` +
        `${written} written since, ${removed} removed since`
      : 'No compact — the full record index is injected';

    if (!measured.overThreshold) {
      const compactSummary = compact ? `${compact.method} compact` : 'no compact';
      return {
        ok: true,
        label:
          `Injected memory context ${formatBytes(measured.bytes)} of ${formatBytes(warnBytes)} ` +
          `(${liveCount} record(s), ${compactSummary})`,
      };
    }

    // Over the threshold: recompacting only helps if the compact is actually
    // behind the records. A CURRENT compact that is still too big means the
    // records themselves need curating — saying "run lazy memory compact" there
    // would send the human in a circle.
    const stale = compact ? written > 0 || removed > 0 : true;
    const remedy = stale
      ? `Regenerate it from the current records with: ${theme.command('lazy memory compact')} (records are never modified)`
      : `The compact is already current, so recompacting will not shrink this — curate the records ` +
        `(${theme.command('lazy memory save')} / ${theme.command('lazy memory rm')}) or raise [memory] warn_bytes`;

    return {
      ok: true,
      label: 'Injected memory context',
      warning:
        `${formatBytes(measured.bytes)} injected into every launch, over the ` +
        `${formatBytes(warnBytes)} advisory threshold ([memory] warn_bytes in lazy.toml). ` +
        `Nothing is blocked or truncated.\n` +
        `  ${liveCount} live record(s). ${compactState}.\n` +
        `  ${remedy}`,
    };
  } catch (err) {
    // A diagnostics hiccup must not become a health failure (same rule as the
    // checks above) — but it is not silent either: the reason is surfaced.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: true,
      label: 'Injected memory context (check skipped)',
      warning: `Could not measure the memory context: ${message}`,
    };
  } finally {
    if (storage && ownsStorage) await storage.close();
  }
}

/**
 * Detect `[protection].protected_tasks` entries that resolve to no branch —
 * the task was deleted, its code changed, the identifier became ambiguous, or
 * it has never been started.
 *
 * Such an entry gates NOTHING: the accept path fails open rather than blocking
 * every accept on a config typo. That is the dangerous half of the trade —
 * the human believes a gate is armed when it is not — so doctor names each
 * stale code and its fix. Report-only and never a hard failure (mirrors the
 * reimportable-conversations check): the repo is healthy, the config is stale.
 *
 * Skipped entirely when protection is off or the list is empty, so the common
 * case costs no storage access at all.
 */
async function checkProtectedTasksResolvable(root: string, config: ResolvedConfig): Promise<CheckResult> {
  const listed = config.protection.protected_tasks;
  if (listed.length === 0) {
    return { ok: true, label: 'Protected tasks resolvable (none configured)' };
  }

  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    // Prefer the daemon (it owns storage) so we never open a second FileStorage
    // that contends on the storage lock — same rule as the checks above.
    storage = await tryRemoteStorage(root);
    if (!storage) {
      storage = await createStorage(root);
      ownsStorage = true;
    }

    const { stale } = await classifyProtectedTasks(storage, listed);
    if (stale.length === 0) {
      return { ok: true, label: `Protected tasks resolvable (${listed.length})` };
    }

    const lines = stale.map((s) => `  - "${s.listedAs}" ${s.detail}`).join('\n');
    return {
      ok: true,
      label: 'Protected tasks resolvable',
      warning:
        `${stale.length} of ${listed.length} entr${stale.length === 1 ? 'y' : 'ies'} in ` +
        `[protection].protected_tasks gate nothing:\n${lines}\n` +
        `  Remove each with: ${theme.command('lazy protect <code> off')}` +
        `${config.protection.enabled ? '' : ' (protection is also globally disabled)'}`,
    };
  } catch {
    // Storage unavailable — a diagnostics hiccup must not become a health
    // failure, and the accept path warns about the same entries anyway.
    return { ok: true, label: 'Protected tasks resolvable (check skipped)' };
  } finally {
    if (storage && ownsStorage) await storage.close();
  }
}

/**
 * Verify the IMPLICIT default-branch protection entry actually names the repo's
 * default branch.
 *
 * `[protection].gate_default_branch` (on by default) protects a branch nobody
 * ever typed: it is resolved at accept time from `refs/remotes/<remote>/HEAD`.
 * When that ref is missing, `getRemoteDefaultBranch` falls back to the literal
 * `"main"` — so on a `master` repo the human believes their default branch is
 * gated while accepts into it sail straight through. Same failure mode as a
 * stale `protected_tasks` entry (a gate believed armed but isn't), so it gets
 * the same treatment: named, with its one-line fix, and never a hard failure.
 *
 * Skipped when protection is off or default-branch gating is off, so the
 * common case costs no git call at all.
 */
async function checkDefaultBranchProtectionResolvable(
  root: string,
  config: ResolvedConfig,
): Promise<CheckResult> {
  const p = config.protection;
  if (!p.enabled || !p.gate_default_branch) {
    return { ok: true, label: 'Default-branch protection (not enabled)' };
  }

  const remote = config.remote.git_remote;
  const result = await runGit(['symbolic-ref', `refs/remotes/${remote}/HEAD`], { cwd: root });
  if (result.exitCode === 0) {
    const branch = result.stdout.trim().replace(`refs/remotes/${remote}/`, '');
    return { ok: true, label: `Default-branch protection resolvable (\`${branch}\`)` };
  }

  return {
    ok: true,
    label: 'Default-branch protection resolvable',
    warning:
      `[protection].gate_default_branch is on, but the default branch of remote '${remote}' ` +
      `cannot be resolved — accept falls back to the literal "main". If this repo's default ` +
      `branch is not \`main\`, that gate protects nothing.\n` +
      `  Fix with: ${theme.command(`git remote set-head ${remote} --auto`)}\n` +
      `  Or name the branch outright: ${theme.command('lazy protect --branch <branch> on')}`,
  };
}

/**
 * Detect the one combination that is likely a mistake: `[protection]` keys
 * that configure gates (`protected_branches`, `protected_tasks`, …) while the
 * master switch is off — because it was never set to true, or was explicitly
 * set to false. Those keys are inert, and the human who typed them believes
 * they are armed.
 *
 * Protection is OPT-IN, so an untouched project (and a bare `enabled = false`)
 * is a normal, deliberate state and gets NO warning — nagging every project
 * about a feature it never asked for is exactly the noise this check must not
 * become. Report-only, never a hard failure.
 *
 * Reads the RAW config, not the resolved one: the point is which keys the
 * human actually typed, not what defaults filled in.
 */
function checkProtectionConfigInert(rawConfig: Record<string, unknown>): CheckResult {
  const section = rawConfig.protection as Record<string, unknown> | undefined;
  if (!section || section.enabled === true) {
    return { ok: true, label: 'Protection config coherent' };
  }

  const inert = Object.keys(section).filter((k) => k !== 'enabled');
  if (inert.length === 0) {
    // Nothing configured beyond (at most) the switch itself — the plain
    // opt-in default, or a deliberate explicit opt-out. Both are fine.
    return { ok: true, label: 'Protection off (opt-in; nothing configured)' };
  }

  const explicitOptOut = section.enabled === false;
  return {
    ok: true,
    label: 'Protection config coherent',
    warning:
      `[protection] is ${explicitOptOut ? 'explicitly disabled (enabled = false)' : 'off (enabled is never set to true)'}, ` +
      `so these keys have no effect: ${inert.map((k) => `\`${k}\``).join(', ')}.\n` +
      `  Engage them with: ${theme.command('lazy protect <branch|task> on')} ` +
      `(or set ${theme.command('enabled = true')} under [protection]), ` +
      `or delete the inert keys if protection is meant to stay off.`,
  };
}

/**
 * `lazy doctor --import-memory`: the one-time migration from harness memory
 * files into lazy-owned shared memory. Previews, confirms (unless --yes), then
 * imports every record missing from the store. Idempotent — already-imported
 * names are skipped, so re-running is safe.
 */
async function commandDoctorImportMemory(root: string, opts: { yes: boolean }): Promise<void> {
  const config = await loadConfig(root);
  const dataDirAbs = join(root, config.data.path);

  // Writes go through the daemon (RemoteStorage) — the daemon owns storage.
  const storage = await requireStorage();
  try {
    const missing = await countImportableMemories({ lazyRoot: root, dataDirAbs, storage });
    if (missing === 0) {
      console.log('No harness memory records found on disk that lazy is missing — nothing to import.');
      return;
    }

    console.log(`Found ${missing} harness memory record(s) not yet in lazy's shared memory.`);
    if (!opts.yes) {
      if (!isTTY()) {
        console.log(`Re-run with ${theme.command('--yes')} to import them (non-interactive).`);
        return;
      }
      const proceed = await promptYesNo(`Import ${missing} memory record(s)?`, true);
      if (!proceed) {
        console.log('Aborted — nothing was imported.');
        return;
      }
    }

    const report = await importHarnessMemory({
      lazyRoot: root,
      dataDirAbs,
      storage,
      onImported: (info) => {
        console.log(theme.success(`  Imported ${info.name}`) + `  (${info.type}) ${info.description}`);
      },
    });

    console.log('');
    console.log(
      `Import complete: ${report.imported.length} imported, ` +
      `${report.skippedExisting.length} already present, ` +
      `${report.skippedEmpty.length} empty skipped.`,
    );
    // Curation hint, not a failure: over-long descriptions ARE imported.
    const longNotice = formatLongDescriptionNotice(report);
    if (longNotice) {
      console.log(theme.warning(`  ${longNotice}`));
    }
    if (report.errors.length > 0) {
      console.log(theme.error(`  ${report.errors.length} record(s) failed to import:`));
      for (const { name, error } of report.errors) {
        console.log(theme.error(`    ${name}: ${error.message}`));
      }
      process.exit(1);
    }
    console.log(`Review them with: ${theme.command('lazy memory list')}`);
  } finally {
    await storage.close();
  }
}

/**
 * `lazy doctor --reimport-conversations`: the built-in recovery. An alias for
 * the bulk path of `lazy import-conversation` — scans every candidate Claude
 * projects dir (shared + per-builder isolation dirs), dedupes sessions, and
 * re-imports any missing from the store through the daemon. Report-only preview
 * unless the user confirms (or passes --yes).
 */
/**
 * `lazy doctor --purge-housekeeping-conversations`: the one-time cleanup of
 * machine-generated `claude -p` one-shots that were captured before lazy
 * started excluding them at the source.
 *
 * INVARIANT: this NEVER runs as part of a routine `lazy doctor` sweep, and
 * never deletes without explicit human confirmation. It is the only caller of
 * `Storage.deleteConversation`, and it is the only place in lazy that
 * classifies a conversation by sniffing prompt wording — see the docblock in
 * src/import/housekeeping-conversation.ts for why that trade is acceptable
 * here and nowhere else.
 *
 * Without `--yes` the classified list is printed and NOTHING is deleted: a TTY
 * is then asked to confirm (defaulting to NO, because deletion is not
 * recoverable from lazy alone), and a non-TTY is told to re-run with `--yes`.
 */
async function commandDoctorPurgeHousekeeping(opts: { yes: boolean }): Promise<void> {
  // Reads and writes both go through the daemon (RemoteStorage) — the daemon
  // owns storage, and it is also the process running the capture sweep.
  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversations();
    const matches = findHousekeepingConversations(conversations);

    if (matches.length === 0) {
      console.log(
        `No machine-generated housekeeping conversations found among ${conversations.length} stored conversation(s).`,
      );
      return;
    }

    console.log(
      `Found ${matches.length} of ${conversations.length} stored conversation(s) that look like ` +
      `machine-generated lazy housekeeping:`,
    );
    console.log('');
    for (const { conversation, kind, reason } of matches) {
      const started = conversation.startedAt
        ? conversation.startedAt.replace('T', ' ').substring(0, 16)
        : 'unknown         ';
      const firstLine = (conversation.summary ?? '').split('\n')[0].trim();
      const elided = firstLine.length > 60 ? `${firstLine.substring(0, 57)}...` : firstLine;
      console.log(
        `  ${theme.taskId(conversation.sessionId.substring(0, 8))}  ${started}  ` +
        `${kind.padEnd(16)}  ${elided}`,
      );
      console.log(`    ${theme.label('why:')} ${reason}`);
    }
    console.log('');

    const byKind = new Map<string, number>();
    for (const m of matches) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    console.log(
      `By kind: ${[...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}.`,
    );

    if (!opts.yes) {
      if (!isTTY()) {
        console.log('');
        console.log(`Nothing was deleted. Re-run with ${theme.command('--yes')} to delete them (non-interactive).`);
        return;
      }
      console.log('');
      console.log(theme.warning('Deleting a conversation is permanent — lazy cannot restore it.'));
      const proceed = await promptYesNo(`Delete ${matches.length} conversation(s) from the store?`, false);
      if (!proceed) {
        console.log('Aborted — nothing was deleted.');
        return;
      }
    }

    let deleted = 0;
    let alreadyGone = 0;
    const errors: { sessionId: string; error: Error }[] = [];
    for (const { conversation } of matches) {
      try {
        if (await storage.deleteConversation(conversation.sessionId)) {
          deleted++;
        } else {
          // Idempotent re-run, or something else purged it concurrently.
          alreadyGone++;
        }
      } catch (err) {
        errors.push({ sessionId: conversation.sessionId, error: err as Error });
      }
    }

    console.log('');
    console.log(
      `Purge complete: ${deleted} deleted` +
      (alreadyGone > 0 ? `, ${alreadyGone} already gone` : '') +
      (errors.length > 0 ? `, ${errors.length} failed` : '') + '.',
    );
    if (errors.length > 0) {
      for (const { sessionId, error } of errors) {
        console.log(theme.error(`  ${sessionId.substring(0, 8)}: ${error.message}`));
      }
      process.exit(1);
    }
    console.log(
      'This is a one-time cleanup: new housekeeping one-shots are marked at the source and never enter the store.',
    );
    // Least surprise: these conversations predate the on-disk marker, so the
    // recovery path cannot tell them apart from real history. Say so here
    // rather than letting the next `lazy doctor` quietly offer to undo this.
    console.log(
      theme.warning(
        `  Note: purged conversations whose raw Claude JSONL is still on disk carry no marker, so ` +
        `${theme.command('lazy doctor --reimport-conversations')} would bring them back.`,
      ),
    );
  } finally {
    await storage.close();
  }
}

async function commandDoctorReimport(root: string, opts: { yes: boolean }): Promise<void> {
  const config = await loadConfig(root);
  const dataDirAbs = join(root, config.data.path);

  // Writes go through the daemon (RemoteStorage) — the daemon owns storage.
  const storage = await requireStorage();
  try {
    const { ok } = await runReimportBulk({ lazyRoot: root, dataDirAbs, storage, yes: opts.yes });
    if (!ok) process.exit(1);
  } finally {
    await storage.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────

export async function commandDoctor(args: string[]): Promise<void> {
  // Parse flags
  const parsed = parseFlags(args, [
    { name: 'no-resume', takesValue: false },
    { name: 'dry-run', takesValue: false },
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'reimport-conversations', takesValue: false },
    { name: 'purge-housekeeping-conversations', takesValue: false },
    { name: 'import-memory', takesValue: false },
  ], 'doctor');

  const noResume = parsed.flags.get('no-resume') === true;
  const dryRun = parsed.flags.get('dry-run') === true;
  const yes = parsed.flags.get('yes') === true;
  const reimportConversationsFlag = parsed.flags.get('reimport-conversations') === true;
  const purgeHousekeepingFlag = parsed.flags.get('purge-housekeeping-conversations') === true;
  const importMemoryFlag = parsed.flags.get('import-memory') === true;

  // If a positional argument is provided, run task-specific diagnostics
  if (parsed.positional.length > 0) {
    const { commandDoctorTask } = await import('./doctor-task');
    await commandDoctorTask(parsed.positional[0], { dryRun, yes });
    return;
  }

  // `--reimport-conversations` is a dedicated recovery flow, not part of the
  // health-check sweep: it scans every candidate Claude projects dir and
  // re-imports missing builder conversations into the store.
  if (reimportConversationsFlag) {
    const reimportRoot = findLazyRoot();
    if (!reimportRoot) {
      console.error('Not in a lazy project. Run `lazy init` first.');
      process.exit(1);
    }
    await commandDoctorReimport(reimportRoot, { yes });
    return;
  }

  // `--purge-housekeeping-conversations` is a one-time cleanup flow, never part
  // of the health-check sweep: it deletes already-stored machine-generated
  // one-shots that predate the capture-time exclusion.
  if (purgeHousekeepingFlag) {
    const purgeRoot = findLazyRoot();
    if (!purgeRoot) {
      console.error('Not in a lazy project. Run `lazy init` first.');
      process.exit(1);
    }
    await commandDoctorPurgeHousekeeping({ yes });
    return;
  }

  // `--import-memory` is likewise a dedicated migration flow, not part of the
  // health-check sweep: it imports harness memory files into shared memory.
  if (importMemoryFlag) {
    const importRoot = findLazyRoot();
    if (!importRoot) {
      console.error('Not in a lazy project. Run `lazy init` first.');
      process.exit(1);
    }
    await commandDoctorImportMemory(importRoot, { yes });
    return;
  }

  const results: CheckResult[] = [];

  // Always run these regardless of lazy root
  results.push(await checkGit());
  results.push(await checkGitHasCommits());

  // Checks that require a lazy root
  const root = findLazyRoot();
  let crashedTasks: CrashedTask[] = [];

  // Determine runner type for conditional checks.
  //
  // loadConfig() throws when lazy.toml exists but does not parse. `lazy doctor`
  // is THE surface for "my setup is broken", so it must not be the command that
  // dies on a broken config — it catches the failure, reports it as a failed
  // check with the parser's own message, and skips every check downstream of
  // config (they would each report defaults as if the user had chosen them,
  // which is precisely the misdiagnosis this whole change removes).
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  let configError: string | null = null;
  if (root) {
    try {
      config = await loadConfig(root);
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
  }
  if (root) {
    results.push(
      configError
        ? { ok: false, label: 'lazy.toml parses', detail: configError }
        : { ok: true, label: 'lazy.toml parses' },
    );
  }

  const runnerType = config?.runner?.type ?? 'docker';
  // createRunner loads config itself, so it throws on the same broken file.
  //
  // It also RESOLVES the live proxy address up front and fails loud when it
  // cannot (ProxyUnavailableError) — which, with the proxy on by default, is
  // what a daemon that is down (or that lost its proxy) looks like. `lazy
  // doctor` is THE surface for "my setup is broken", so it must not be the one
  // command that dies in that state: that ONE error becomes a reported check
  // (carrying the error's own actionable text) and the runner-dependent checks
  // below are skipped, the same way a broken lazy.toml is handled just above.
  //
  // Deliberately narrow. Every other createRunner failure — an unknown runner
  // type, an agent/runner mismatch — still aborts the command, because those
  // are configuration errors the user must fix before any check means anything
  // (see 'invalid runner config fails with error' in test/e2e/runner-config).
  let runner: Runner | null = null;
  let runnerError: string | null = null;
  if (root && !configError) {
    try {
      runner = await createRunner(root);
    } catch (err) {
      if (!(err instanceof ProxyUnavailableError)) throw err;
      runnerError = err.message;
    }
  }
  if (runnerError) {
    results.push({ ok: false, label: 'Runner available', detail: runnerError });
  }

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

  results.push(await checkAuth(configError ? null : config ?? null));

  // Shell and completion checks
  const { result: shellResult, shell } = await checkShellDetected();
  results.push(shellResult);
  results.push(checkCompletionsInstalled(shell));
  results.push(checkTmux());

  // Container-dependent checks only run if the runner's own diagnostics all passed
  const runnerDiagnosticsOk = runner
    ? diag.every(c => c.state !== 'fail')
    : false;

  if (root && configError) {
    // Everything below needs a parsed config. Reporting those checks against
    // defaults would be worse than skipping them: the user would read a green
    // sweep as "my configured setup is healthy" when none of their settings
    // were in force. One failed check, one cause, one remedy.
    console.log(
      "Note: lazy.toml could not be parsed — every config-dependent check is skipped. " +
      "See the 'lazy.toml parses' result below.\n",
    );
  } else if (root) {
    results.push(await checkDataDir(root));

    // Offline mode status — always surface when it expires (or that it won't).
    const offlineStatus = await resolveOfflineStatus(join(root, '.lazy'), config!.remote.offline);
    if (offlineStatus.offline) {
      const suspended = offlineStatus.configuredDriver ? ` (${offlineStatus.configuredDriver} driver suspended)` : '';
      const restore = offlineStatus.permanent
        ? `Remove [remote] offline from lazy.toml to go back online.`
        : `Run 'lazy system online' to restore remote operations now.`;
      results.push({
        ok: true,
        label: 'Offline mode',
        warning: `ENABLED — ${formatOfflineExpiry(offlineStatus)}${suspended}. ${restore}`,
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
    results.push(await checkReimportableConversations(root, join(root, config!.data.path)));
    results.push(await checkImportableMemories(root, join(root, config!.data.path)));
    results.push(await checkMemoryContext(root, config!));
    results.push(await checkCredentialAccepted(root));
    results.push(await checkProtectedTasksResolvable(root, config!));
    results.push(await checkDefaultBranchProtectionResolvable(root, config!));
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
    if (rawConfig) {
      results.push(checkProtectionConfigInert(rawConfig));
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
       lazy doctor --reimport-conversations [--yes]
       lazy doctor --purge-housekeeping-conversations [--yes]
       lazy doctor --import-memory [--yes]
       lazy doctor <task-id> [--dry-run] [--yes]

Check the health of your lazy installation, or diagnose a specific task.

Options:
  --no-resume                Report crashed containers without auto-resuming interrupted tasks
  --reimport-conversations   Recover builder conversations whose raw Claude logs are on
                             disk (shared ~/.claude/projects + per-builder isolation dirs)
                             but never reached the store; skips ones already imported
  --purge-housekeeping-conversations
                             Delete already-stored machine-generated lazy one-shots
                             (accept fidelity summaries, 'lazy report', memory
                             compaction, pairing summaries) from the conversation
                             store. Lists what it classified and deletes nothing
                             without --yes or an interactive confirmation. A ONE-TIME
                             cleanup: newer one-shots are marked at the source and
                             never reach the store
  --import-memory            Import Claude Code harness memory files (shared ~/.claude/projects
                             + per-builder isolation dirs) into lazy-owned shared memory;
                             skips records already present
  --dry-run                  Show task issues without offering fixes (task mode only)
  --yes, -y                  Apply all fixes / skip the re-import, import-memory, or
                             purge confirmation prompt

Project-level checks (no task ID):
  - Git installed and functional
  - Repository has at least one commit
  - Docker installed and daemon running
  - Anthropic API key or OAuth token present in the DAEMON's environment
    (falls back to this shell's, saying so, when the daemon can't be asked)
  - Shell detected and completions installed
  - tmux installed (soft recommendation)
  - Data directory structure valid
  - Container image exists and up to date
  - No stale locks or orphaned containers
  - No split storage (when external storage is configured)
  - Recoverable builder conversations on disk but missing from the store
  - Harness memory files on disk with no lazy shared-memory record
  - Injected memory context size vs [memory] warn_bytes (compact staleness + remedy)
  - Stale [protection].protected_tasks entries that gate nothing
  - Default-branch protection resolves to a real branch (not the "main" fallback)
  - [protection] gate keys configured while the master switch is off (inert)
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
