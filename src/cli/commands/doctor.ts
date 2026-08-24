/**
 * `lazy doctor` — verify installation health and report issues.
 *
 * Runs a series of checks (Docker, auth, git, directory structure, image,
 * locks, containers, disk space) and prints a pass/fail summary with
 * actionable fix instructions for any failures.
 */

import { existsSync, readdirSync, readFileSync, statfsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { checkHolder, describeDeadReason, type HolderVerdict } from '../../utils/process-identity';
import {
  probeHeldStorageLock,
  STORAGE_LOCK_FILENAME,
  type HeldLockReport,
} from '../../utils/storage-lock';
import { getHome } from '../../utils/home';
import { verifyAgentBinary, formatAgentBinaryError } from '../../agent/binary-identity';
import { findLazyRoot, getDataDir } from '../init';
import { getProjectName } from '../../storage';
import { TERMINAL_STATUSES } from '../../types';
import { createStorage } from '../../storage';
import { theme } from '../theme';
import { shortId, displayId, parseFlags, taskRef } from '../helpers';
import { repoHasCommits } from '../../git/operations';
import { resolveImageName, calculateDockerfileHash, listLazyImages, type LazyImageInfo } from '../../capture/claude';
import { loadConfig, loadRawConfig } from '../../config/loader';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';
import { findUnknownConfigKeys, findDeprecatedConfigKeys, DEPRECATED_SECTION_KEYS } from '../../config/schema';
import { getKnownFeatures, getUnknownFlags, isFeatureEnabled } from '../../utils/features';
import { createDriver } from '../../remote';
import type { ResolvedConfig } from '../../config/types';
import type { RepositoryDriver } from '../../remote';
import { resolveOfflineStatus, formatOfflineExpiry } from '../../utils/offline';
import { detectShell, getCompletionSetupCommand, getShellConfigFile } from '../../shell/detect';
import type { ShellInfo } from '../../shell/detect';
import { spawnSyncUnsupervised } from '../../utils/spawn';
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
import { builderScratchDir, scratchDirSize, formatScratchBytes } from '../../builder/scratch';
import { findHousekeepingConversations } from '../../import/housekeeping-conversation';
import { runReimportBulk } from './import-conversation';
import { requireStorage, tryRemoteStorage } from '../helpers';
import { unresolvedAuthRejection } from '../../proxy/auth-verdict';
import {
  readAuditRecords,
  legacyAuditLogInfo,
  formatSize,
  AUDIT_LOG_FILENAME,
  AUDIT_LOG_SUBDIR,
} from '../../proxy/audit-log';
import { fetchDaemonCredentialState, ProxyUnavailableError } from '../../daemon/auth-env';
import { inspectDaemonStateFiles } from '../../daemon/state-files';
import { getDaemonDir, PID_FILE, SOCKET_FILE } from '../../daemon/paths';
import { readDaemonLockPid, readPid } from '../../daemon/lifecycle';
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
import {
  readPassphraseEnrollment,
  legacyPassphraseFileExists,
  legacyPassphrasePath,
} from '../../protection/passphrase-store';
import { docsFooter, docsSuffix, type DocsPage } from '../../docs/links';
import { inspectLfsEnvironment, type LfsEnvironmentReport } from '../../git/lfs';

// ── types ────────────────────────────────────────────────────────────────

interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;  // shown on failure
  warning?: string; // shown as yellow warning even when ok
  /**
   * Documentation page for this check, printed under a FAILURE as
   * "Check documentation at <url>". A supplement only: `detail` still carries
   * the whole remedy, and the pointer is omitted entirely when a project has
   * disabled doc links.
   */
  docs?: DocsPage;
}

// Docker timeout mirrors the one in capture/claude.ts
const DOCKER_TIMEOUT_MS = 10_000;

/**
 * How long a doctor storage call may wait for the storage lock before failing.
 *
 * Doctor only ever READS through these handles, and a check it cannot run is a
 * reported skip — so waiting is pure loss. The default retry loop stays exactly
 * as it is for every command that has real work to do; this override is
 * doctor-only on purpose (see StorageLockOptions).
 *
 * Two seconds is well past a healthy write (FileStorage holds the lock for the
 * duration of one operation, milliseconds) and well short of the default loop.
 */
const DOCTOR_LOCK_TIMEOUT_MS = 2_000;

/**
 * How long the up-front probe watches the lock before calling it held.
 *
 * Same reasoning in the other direction: long enough that an ordinary daemon
 * write is over before the window closes, short enough that a wedged store
 * costs the report a second and a half rather than the whole sweep.
 */
const DOCTOR_LOCK_PROBE_MS = 1_500;

/**
 * A lock held this long by one acquire is not work in progress.
 *
 * FileStorage takes the lock per operation, so `acquired_at` is the start of a
 * single read-modify-write. A minute of that is not a slow store, it is a
 * process that will never let go — the only signal doctor has that separates a
 * wedge from a busy moment, and the only one worth failing the sweep over.
 */
const WEDGED_LOCK_AGE_MS = 60_000;

/**
 * How long the daemon has to answer ONE storage read before doctor stops
 * believing it is serving storage.
 *
 * This is the probe that separates "the daemon holds the lock, as it always
 * does" from "the daemon holds the lock and is stuck": doctor reads task state
 * THROUGH the daemon, so a daemon that answers is not an obstruction no matter
 * how long it has held the file lock. Bounded because a hung daemon must cost
 * the report a few seconds, not the whole sweep — blocking is the one thing a
 * diagnostic may not do.
 */
const DOCTOR_DAEMON_READ_PROBE_MS = 3_000;

/**
 * The task id {@link daemonAnswersStorageRead} asks the daemon for.
 *
 * The nil UUID, and it must keep the canonical UUID shape: FileStorage treats a
 * UUID-shaped id as already resolved and goes straight to a single file read,
 * whereas any other input makes it list the tasks directory and — when nothing
 * matches the prefix — read every task.json looking for a matching code. The
 * probe would then get slower as the store grew, which is the one thing it must
 * not do. Nothing is expected to be found; the read answering at all is the
 * signal.
 */
const STORAGE_PROBE_TASK_ID = '00000000-0000-0000-0000-000000000000';

/**
 * How far in the future an `acquired_at` may sit before we stop believing it.
 *
 * The holder and this process share one clock, so the honest skew is zero; a
 * small grace only absorbs sub-second rounding rather than admitting a real
 * discrepancy. Anything beyond it is a timestamp we cannot reason about, and is
 * treated the same as a missing one.
 */
const LOCK_CLOCK_SKEW_GRACE_MS = 5_000;

/**
 * Open storage for a doctor check.
 *
 * Prefers the daemon (it owns storage) so we never open a second FileStorage
 * that contends on the storage lock; falls back to a direct handle that FAILS
 * FAST rather than queueing. Callers must close only what they own.
 */
async function openDoctorStorage(root: string): Promise<{ storage: Storage; ownsStorage: boolean }> {
  const remote = await tryRemoteStorage(root);
  if (remote) return { storage: remote, ownsStorage: false };
  return {
    storage: await createStorage(root, { lockTimeoutMs: DOCTOR_LOCK_TIMEOUT_MS }),
    ownsStorage: true,
  };
}

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
        docs: 'troubleshooting-credential',
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
    docs: 'troubleshooting-credential',
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
 * Reads the project-local audit log directly — it is a plain, size-capped file
 * under `.lazy/logs/` (bind-mounted read-write into builder containers at the
 * same path, so this works inside one too), not storage state. This is the
 * deliberate carve-out from the "never read `.lazy/` directly" rule in
 * CLAUDE.md: disposable telemetry is explicitly not storage state. Degrades to a skipped
 * check on any error: a diagnostics hiccup must not become a health failure.
 */
async function checkCredentialAccepted(dataDir: string): Promise<CheckResult> {
  try {
    const records = await readAuditRecords(dataDir, { limit: AUTH_VERDICT_RECORDS });
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
  }
}

/**
 * Is a pre-move proxy audit log still sitting at the store root?
 *
 * Older versions appended the audit stream there with no cap; one real store
 * grew a 677 MiB blob that broke a push. The daemon deletes it on startup, so
 * this only fires when the daemon has not been restarted since the upgrade —
 * and it is the one place that spells out the part lazy cannot fix: the blob is
 * already in that store repo's git history.
 */
async function checkLegacyProxyAuditLog(root: string): Promise<CheckResult> {
  const label = 'No legacy proxy audit log in the store';
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    storage = await tryRemoteStorage(root);
    if (!storage) {
      storage = await createStorage(root);
      ownsStorage = true;
    }
    const legacy = await legacyAuditLogInfo(storage.getStoragePath());
    if (!legacy) return { ok: true, label };
    return {
      ok: false,
      label,
      detail:
        `${legacy.path} (${formatSize(legacy.bytes)}) is left over from when the proxy audit trail ` +
        `was written into the store uncapped. It is disposable telemetry — audit records now live in ` +
        `the project-local, size-capped ${join(AUDIT_LOG_SUBDIR, AUDIT_LOG_FILENAME)} under your data dir.\n` +
        `  Restart the daemon to remove it:\n` +
        `    ${theme.command('lazy daemon restart')}\n` +
        `  Or delete it by hand. If your store is a git repo, the blob is also in its HISTORY — ` +
        `lazy cannot rewrite that for you; use ${theme.command('git filter-repo')} in the store repo.`,
    };
  } catch {
    return { ok: true, label: `${label} (check skipped)` };
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

/**
 * Report the builder scratch dir: where it is, how much is in it, and how to
 * clear it. Nothing in lazy ever prunes it — the whole point is that artifacts
 * survive for a human who may read them days later — so `lazy doctor` is the
 * one place that says so and hands over the remedy. Never a failure: a big
 * scratch dir is the feature working, not a fault.
 */
async function checkBuilderScratch(root: string): Promise<CheckResult> {
  const dir = builderScratchDir(root);
  const { bytes, entries } = await scratchDirSize(dir);
  if (entries === 0) {
    return { ok: true, label: `Builder scratch dir empty (${dir})` };
  }
  return {
    ok: true,
    label: `Builder scratch dir: ${entries} item(s), ${formatScratchBytes(bytes)} (${dir})`,
    warning: bytes >= SCRATCH_LARGE_BYTES
      ? `Builder artifacts are never pruned automatically. Delete what you no longer need: rm -rf ${dir}/*`
      : undefined,
  };
}

/**
 * Recognise a daemon whose state files were deleted underneath it.
 *
 * The signature is unmistakable and, before this check existed, completely
 * opaque: the daemon holds its `daemon.lock` (so it is definitely alive and
 * definitely owns this directory) and usually still answers on its recorded web
 * port, but `lazy.pid` and/or `lazy.sock` are gone. Every socket-based command
 * then reported "Daemon is not running." against a daemon that was running
 * fine, and `lazy daemon start` failed because the live daemon held the storage
 * lock — with no non-destructive way out.
 *
 * Report-only: the daemon repairs its own files within seconds (see
 * src/daemon/state-files.ts), so the remedy here is "wait, or restart if the
 * daemon predates that repair" — not something doctor should do behind the
 * user's back.
 */
async function checkDaemonStateFiles(root: string): Promise<CheckResult> {
  const report = await inspectDaemonStateFiles(root);

  if (!report.filesDeletedUnderLiveDaemon) {
    return { ok: true, label: 'Daemon state files consistent' };
  }

  const missing = [
    report.pidFilePresent ? null : PID_FILE,
    report.socketFilePresent ? null : SOCKET_FILE,
  ].filter((f): f is string => f !== null);

  const who = report.lockPid !== null ? ` (PID ${report.lockPid})` : '';
  const web = report.webPortListening && report.webPort !== null
    ? ` It is still answering on its web port (${report.webPort}).`
    : '';

  return {
    ok: false,
    label: 'Daemon state files consistent',
    detail:
      `A daemon${who} is running and owns ${getDaemonDir(root)}, but ${missing.join(' and ')} ` +
      `${missing.length > 1 ? 'are' : 'is'} missing — something deleted its state files while it was ` +
      `running.${web} Commands that reach the daemon over its socket will report it as not running ` +
      `until the file is back.\n` +
      `  The daemon puts these files back itself within a few seconds — re-run ${theme.command('lazy doctor')} to confirm.\n` +
      `  If it persists, that daemon predates the self-repair: ${theme.command('lazy daemon restart')} clears it. ` +
      `Note that restarting interrupts running agent and pair sessions.`,
  };
}

/** Size at which doctor starts nudging about manual cleanup (100 MB). */
const SCRATCH_LARGE_BYTES = 100 * 1024 * 1024;

// A sync spawn is acceptable throughout this function: `lazy doctor` is a
// one-shot CLI health check, not a daemon path — blocking here is fine.
function checkContainerImage(imageName: string, binary: string = 'docker'): CheckResult {
  try {
    const result = spawnSyncUnsupervised(
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
    // A sync spawn is acceptable: `lazy doctor` is a one-shot CLI health
    // check, not a daemon path — blocking here is fine.
    const inspect = spawnSyncUnsupervised(
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

/**
 * Report lazy-built container images that are NOT the one this lazy runs.
 *
 * Images are tagged with the lazy release version, so every upgrade leaves the
 * previous version's image behind. That is deliberate — it is Docker build
 * cache for the next build, and it is what an older lazy on the same host still
 * runs — so this is a reclaimable-disk report, not a failure. Doctor is the one
 * place that names them; nothing else nags about them.
 */
export async function checkStaleLazyImages(imageName: string, binary: string = 'docker'): Promise<CheckResult> {
  let images: LazyImageInfo[];
  try {
    images = await listLazyImages(binary);
  } catch {
    // Runtime hiccup listing images is not a health signal of its own — the
    // container-runtime checks above already cover an unavailable runtime.
    return { ok: true, label: 'No stale runner images' };
  }

  // Anything sharing the current image's ID is the SAME image under another tag
  // (the `:latest` alias), not a stale one.
  const currentId = images.find(image => image.ref === imageName)?.id;
  const stale = images.filter(image => image.ref !== imageName && (!currentId || image.id !== currentId));

  if (stale.length === 0) {
    return { ok: true, label: 'No stale runner images' };
  }

  const shown = stale.slice(0, 5).map(image => `${image.ref} (${image.size})`);
  const more = stale.length > 5 ? `, +${stale.length - 5} more` : '';
  return {
    ok: true,
    label: 'No stale runner images',
    warning:
      `${stale.length} older lazy image(s) still on disk: ${shown.join(', ')}${more}. ` +
      `They are kept as build cache and for older lazy versions on this host. ` +
      `Reclaim the space with: ${binary} image rm ${stale.map(image => image.ref).join(' ')}`,
  };
}

/**
 * Is the holder recorded in a pid-based lock file still the process at that pid?
 *
 * Never asks the bare "does this pid exist" question: pids get recycled, and a
 * lock whose holder died without releasing it looks permanently held once the
 * OS hands its number to an unrelated program. See src/utils/process-identity.
 */
async function lockHolderVerdict(lockData: {
  pid?: unknown;
  acquired_at?: unknown;
  started_at?: unknown;
  holder_started_at?: unknown;
  holder_start_source?: unknown;
}): Promise<HolderVerdict | null> {
  if (typeof lockData.pid !== 'number') return null;
  const acquiredAt =
    typeof lockData.acquired_at === 'string'
      ? lockData.acquired_at
      : typeof lockData.started_at === 'string'
        ? lockData.started_at
        : null;
  return checkHolder({
    pid: lockData.pid,
    started: typeof lockData.holder_started_at === 'string' ? lockData.holder_started_at : null,
    startedSource:
      lockData.holder_start_source === 'proc' || lockData.holder_start_source === 'ps'
        ? lockData.holder_start_source
        : null,
    acquiredAt,
  });
}

/**
 * Verify the agent binary containers bind-mount is really the compiled agent.
 *
 * ~/.lazy/bin/lazy-agent is mounted at /usr/local/bin/lazy-agent in every
 * container. When it is the wrong file — a bare Bun runtime is the case seen in
 * the field — the container fails far from the cause, as `Script not found
 * "builder"` or a silent MCP -32000 with no lazy_* tools. Doctor is where that
 * gets diagnosed by name, on the host, before a launch.
 */
async function checkAgentBinary(): Promise<CheckResult> {
  const binaryPath = join(getHome(), '.lazy', 'bin', 'lazy-agent');
  if (!existsSync(binaryPath)) {
    // Not an error: it is created on the next container launch or `lazy upgrade`.
    return {
      ok: true,
      label: 'Agent binary',
      warning: `not present at ${binaryPath} yet — it is built on the next container launch`,
    };
  }
  const verdict = await verifyAgentBinary(binaryPath);
  if (verdict.ok) return { ok: true, label: 'Agent binary' };
  return {
    ok: false,
    label: 'Agent binary',
    detail: formatAgentBinaryError(binaryPath, verdict.reason, { canRebuild: false }),
    docs: 'agent-container',
  };
}

async function checkStaleLocks(root: string): Promise<CheckResult> {
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
        const verdict = await lockHolderVerdict(lockData);
        if (verdict && !verdict.alive) stale.push(entry.name);
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

/**
 * Where the storage lock actually lives.
 *
 * NOT `<root>/.lazy` — task state lives in the external store, so that is where
 * FileStorage puts its lock. Checking the repo-local path meant doctor happily
 * reported "no stale storage lock" while the real one, under the external path,
 * was wedging every command. Postgres stores have no file lock at all.
 */
async function resolveStorageLockDir(root: string, config: ResolvedConfig): Promise<string | null> {
  if (config.storage.backend !== 'external') return null;
  if (config.storage.external_path) return config.storage.external_path;
  // Same default createStorage() derives: ~/.lazy/<project-name>.
  return join(getHome(), '.lazy', await getProjectName(root, config.remote.git_remote));
}

/**
 * Detect a storage lock nobody will ever release.
 *
 * This is THE recovery surface for the wedged-lock failure: a user hitting it
 * on a released binary has no other way out than `rm` on a path they have to
 * read out of a stack trace. Returns the lock path alongside the result so the
 * caller can offer to clear it.
 */
async function checkStorageLock(lockDir: string | null): Promise<{ result: CheckResult; stalePath: string | null }> {
  const label = 'No stale storage lock';
  if (!lockDir) return { result: { ok: true, label }, stalePath: null };

  const lockPath = join(lockDir, STORAGE_LOCK_FILENAME);
  if (!existsSync(lockPath)) return { result: { ok: true, label }, stalePath: null };

  let lockData: { pid?: unknown };
  try {
    lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return {
      result: {
        ok: false,
        label,
        detail: `Storage lock file is unreadable and nothing will ever release it: ${lockPath}`,
        docs: 'troubleshooting-storage-lock',
      },
      stalePath: lockPath,
    };
  }

  const verdict = await lockHolderVerdict(lockData);
  if (!verdict || verdict.alive) return { result: { ok: true, label }, stalePath: null };

  return {
    result: {
      ok: false,
      label,
      detail:
        `Storage lock at ${lockPath} is stale — ${describeDeadReason(verdict.reason)} ` +
        `(pid ${(lockData as { pid: number }).pid}). Every lazy command will fail to acquire it until it is removed. ` +
        `Remove with: ${theme.command(`rm ${lockPath}`)}`,
      docs: 'troubleshooting-storage-lock',
    },
    stalePath: lockPath,
  };
}

/**
 * What a held storage lock MEANS for the rest of the report.
 *
 *   - `daemon-serving`   — the holder is this project's daemon and it answered a
 *                          storage read. Not an obstruction: doctor reads task
 *                          state through the daemon, not through the file lock.
 *   - `daemon-stuck`     — the holder is this project's daemon and it did NOT
 *                          answer in bounded time. Nothing can read task state.
 *   - `foreign`          — somebody else is sitting on the lock.
 */
type HeldLockAssessment = 'daemon-serving' | 'daemon-stuck' | 'foreign';

/**
 * Can doctor still read task state while this lock is held?
 *
 * THE DAEMON HOLDS THE STORAGE LOCK FOR ITS ENTIRE LIFETIME. It takes it once
 * at startup and never releases it (`getOrCreateStorage` in
 * daemon/rpc-handlers.ts) — that is what makes it the store's single writer, and
 * it is what a HEALTHY lazy install looks like. Treating that as "the store is
 * busy" made every doctor run on a machine with a running daemon skip every
 * check that reads task state, and — once the daemon had been up for a minute —
 * fail the sweep with "storage lock is wedged".
 *
 * So the question is not "is the lock free" but "is anything serving storage".
 * Two signals, in order, because the cheap one bounds the cost of the other:
 *
 *   1. Is the holder pid the daemon's? `daemon.lock` is written only by the
 *      process that won the daemon lock, so it is the trustworthy record of who
 *      owns this daemon dir; `lazy.pid` is the fallback for daemons started
 *      without the flock (LAZY_TEST) or by an older build.
 *   2. Does that daemon answer a real storage read, within a bounded window?
 *      Evidence beats identity — a daemon whose event loop is wedged would
 *      otherwise leave every subsequent check hanging on an RPC that never
 *      returns.
 *
 * A foreign holder is never probed: the daemon's own reads would queue behind
 * that lock, so the probe would buy nothing but its own timeout.
 */
async function assessHeldLock(root: string, held: HeldLockReport): Promise<HeldLockAssessment> {
  const daemonPid = readDaemonLockPid(root) ?? readPid(root);
  if (daemonPid === null || daemonPid !== held.pid) return 'foreign';
  return (await daemonAnswersStorageRead(root)) ? 'daemon-serving' : 'daemon-stuck';
}

/** One bounded storage read through the daemon. Never throws, never blocks. */
async function daemonAnswersStorageRead(root: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), DOCTOR_DAEMON_READ_PROBE_MS);
  });
  const read = (async () => {
    try {
      const storage = await tryRemoteStorage(root);
      if (!storage) return false;
      // A real read, not just a handshake: the daemon serves it under the same
      // lock it is holding, so answering proves the lock is not an obstruction.
      //
      // Deliberately the CHEAPEST read in the interface, because the probe's
      // cost is charged against a fixed timeout and a slow answer here would be
      // misreported as a dead daemon — reintroducing the bug this fixes, just
      // triggered by store size instead. A UUID-shaped id short circuits
      // FileStorage's id resolution before it lists the tasks dir, so
      // this is one failed file read on the daemon side no matter how many
      // tasks exist; listTasks(), by contrast, reads and parses every task.json
      // serially. A miss returns null rather than throwing, and null is the
      // answer we want: we are probing liveness, not looking for a task.
      await storage.getTask(STORAGE_PROBE_TASK_ID);
      return true;
    } catch {
      // Any failure — no socket, a 500 from a daemon that cannot reach its own
      // store, a transport error — means doctor cannot read through the daemon.
      // The verdict is reported by the lock check itself, which names the
      // holder and the remedy; re-throwing here would kill the whole sweep.
      return false;
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report a storage lock that a LIVE, verified holder is sitting on.
 *
 * Deliberately two verdicts, because doctor cannot prove which one it is
 * looking at without waiting forever — and waiting is exactly what it must not
 * do:
 *
 *   - Held for LESS than a minute → a warning. A store can be genuinely busy,
 *     and failing the sweep over a daemon that happened to be mid-write would
 *     make `lazy doctor` unreliable in precisely the healthy case. The human is
 *     told what was skipped and that re-running is likely enough.
 *   - Held for MORE than a minute → a failure. FileStorage takes this lock per
 *     operation, so one acquire outliving a minute is not slow work, it is a
 *     process that will never release it. That blocks every lazy command in the
 *     project, so it earns a non-zero exit.
 *
 * Neither verdict offers to remove the file. The holder is verifiably the
 * process that took it (that is what makes this case different from a stale
 * lock), and deleting a live process's lock corrupts the store — so the remedy
 * is aimed at the PROCESS.
 *
 * Both of those are about a FOREIGN holder. When the holder is this project's
 * own daemon, neither applies: it holds the lock from startup to shutdown by
 * design, so the age of the lock says nothing at all and the only question that
 * matters is whether it is still serving storage (see assessHeldLock).
 */
function describeHeldStorageLock(
  held: HeldLockReport | null,
  lockDir: string,
  assessment: HeldLockAssessment,
): CheckResult {
  const label = 'Storage lock available';
  if (!held) return { ok: true, label };

  const lockPath = join(lockDir, STORAGE_LOCK_FILENAME);

  if (assessment === 'daemon-serving') {
    return {
      ok: true,
      label: `Storage lock held by the daemon (pid ${held.pid}, as designed)`,
    };
  }

  if (assessment === 'daemon-stuck') {
    return {
      ok: false,
      label: 'Daemon holds the storage lock but is not serving storage',
      detail:
        `The lazy daemon (pid ${held.pid}) holds the storage lock — it takes it at startup and ` +
        `holds it for its whole lifetime, which is normal — but it did not answer a storage read ` +
        `within ${DOCTOR_DAEMON_READ_PROBE_MS}ms. Nothing can read or write task state while that ` +
        `is true, so every lazy command in this project will hang or fail.\n` +
        `  The checks that read task state were skipped — everything else in this report ran normally.\n` +
        `  Check it with ${theme.command('lazy daemon status')}; if it is hung, ` +
        `${theme.command('lazy daemon restart')} clears it (that interrupts running agent and pair ` +
        `sessions). Do NOT delete ${lockPath} — the daemon is alive and removing its lock admits a ` +
        `second writer, which corrupts the store.`,
      docs: 'troubleshooting-storage-lock',
    };
  }

  const rawAgeMs = held.acquiredAt ? Date.now() - new Date(held.acquiredAt).getTime() : NaN;
  // An age we cannot read is not an age of zero. `acquired_at` is absent when
  // the lock file was truncated mid-write or written by a lazy old enough not
  // to record it; unparseable or implausibly future values are the same class
  // of damage. Either way we cannot tell "busy for 3ms" from "wedged for an
  // hour", and the probe has already established the harder half of the
  // question: ONE holder, identity verified, unchanged for the whole window.
  const ageKnown = Number.isFinite(rawAgeMs) && rawAgeMs >= -LOCK_CLOCK_SKEW_GRACE_MS;
  const heldForMs = ageKnown ? Math.max(0, rawAgeMs) : NaN;
  const heldFor = ageKnown ? `, taken ${formatTimeSince(held.acquiredAt!)}` : '';
  const who = `pid ${held.pid}${held.command ? ` (${held.command})` : ''}`;
  const skipped =
    `The checks that read task state were skipped rather than queued behind it — ` +
    `everything else in this report ran normally.`;
  const remedy =
    `Find out what that process is doing (${theme.command('lazy daemon status')}, ` +
    `${theme.command(`ps -p ${held.pid}`)}). If it is hung, stop it and re-run ` +
    `${theme.command('lazy doctor')} — do NOT delete ${lockPath} while it is alive, ` +
    `that is a live holder and removing its lock corrupts the store.`;

  // FAIL rather than warn when the age is unreadable. The soft warning says
  // "come back and look again if this repeats", which is only useful advice
  // when a re-run could produce a different answer — and here it cannot: the
  // damaged timestamp is on disk, so every future doctor run reads the same
  // unreadable value and downgrades itself the same way. A warning would make
  // an indefinitely-held lock permanently invisible. The lock file lazy writes
  // ALWAYS records acquired_at, so its absence is itself a defect worth a human
  // looking at, independent of how long the lock has been held.
  //
  // The cost we are accepting: on a genuinely busy store whose lock file also
  // has a damaged timestamp, a user gets a hard ✗ and a non-zero doctor exit
  // for a lock that was only held milliseconds. The separate label keeps that
  // honest — it says the age is unreadable, not that the store is wedged — but
  // it is still a failing check on a healthy store. We take that trade because
  // the remedy text tells them not to delete a live holder's lock, so the false
  // positive costs a look at `ps`, not a corrupted store; and because the
  // alternative silently hides real wedges forever.
  if (!ageKnown) {
    return {
      ok: false,
      label: 'Storage lock age is unreadable',
      detail:
        `The storage lock is held by ${who}, unchanged for the whole ${held.observedForMs}ms ` +
        `probe, but ${lockPath} does not record a readable acquired_at — so there is no way ` +
        `to tell a busy store from a wedged one, and this cannot resolve itself on a re-run. ` +
        `Every lazy command in this project will block on that lock until the process ` +
        `releases it or dies.\n  ${skipped}\n  ${remedy}`,
      docs: 'troubleshooting-storage-lock',
    };
  }

  if (heldForMs >= WEDGED_LOCK_AGE_MS) {
    return {
      ok: false,
      label: 'Storage lock is wedged',
      detail:
        `The storage lock has been held by ${who}${heldFor} — one storage operation, ` +
        `for longer than any real one takes. Every lazy command in this project will ` +
        `block on it until that process releases it or dies.\n  ${skipped}\n  ${remedy}`,
      docs: 'troubleshooting-storage-lock',
    };
  }

  return {
    ok: true,
    label,
    warning:
      `The storage lock is held by ${who}${heldFor} and was still held after ` +
      `${held.observedForMs}ms of watching — the store is busy. ${skipped}\n` +
      `  If a re-run reports the same holder, it is not busy, it is stuck: ${remedy}`,
  };
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
 *
 * THROWS when storage cannot be read. It used to swallow that and return an
 * empty list, which doctor printed as "✓ No crashed task runs" — a green check
 * for a question nobody answered. Under a running daemon that was the normal
 * outcome, because this opened its OWN FileStorage and queued on the lock the
 * daemon holds for life. It now reads through the daemon like every other
 * storage-backed check, and the caller reports a failure to read as a skip.
 */
async function findCrashedTasks(root: string, runner: Runner): Promise<CrashedTask[]> {
  const crashed: CrashedTask[] = [];
  const { storage, ownsStorage } = await openDoctorStorage(root);
  try {
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
  } finally {
    if (ownsStorage) await storage.close();
  }
  return crashed;
}

// TERMINAL_STATUSES imported from ../../types

// A sync spawn is acceptable here: `lazy doctor` is a one-shot CLI health
// check, not a daemon path — blocking the (otherwise idle) loop is fine.
async function checkOrphanedContainers(root: string | null, binary: string = 'docker'): Promise<CheckResult> {
  try {
    const result = spawnSyncUnsupervised(
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
      // Through the daemon when there is one: it holds the storage lock for its
      // whole lifetime, so a private FileStorage here queues on it and then
      // silently reports every container as "not ours".
      let storage: Storage;
      let ownsStorage: boolean;
      try {
        ({ storage, ownsStorage } = await openDoctorStorage(root));
      } catch (err) {
        // Cannot read task state, so "is this container ours" is unanswerable.
        // Report that instead of the green check the swallow used to print.
        return {
          ok: true,
          label: 'No orphaned containers (skipped — could not read task state)',
          warning: err instanceof Error ? err.message : String(err),
        };
      }
      try {
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
      } finally {
        if (ownsStorage) await storage.close();
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

  // Keys lazy REMOVED outright (DEPRECATED_SECTION_KEYS). These have no
  // honored old spelling — the key is ignored — so the migration sentence
  // matters more, not less. The loader prints one line at load time and points
  // here for this.
  const removedKeys = findDeprecatedConfigKeys(raw);
  for (const dotted of removedKeys) {
    results.push({
      ok: true,
      label: `Config option '${dotted}'`,
      warning: `'${dotted}' is obsolete and is IGNORED. ${DEPRECATED_SECTION_KEYS[dotted]}`,
    });
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

/**
 * Would a commit made in this repository store LFS content correctly?
 *
 * THE single surface for the full LFS diagnosis. `lazy start` refuses on a
 * broken environment with one generic line plus "Run `lazy doctor` for
 * details" — the remedies live here and nowhere else (project convention:
 * one warning surface).
 *
 * Report-only: doctor never runs `git lfs install`. Repairing a user's git
 * config as a side effect of a diagnostic is the hidden side effect CLAUDE.md
 * forbids; the human runs the printed command deliberately.
 */
async function checkLfsEnvironment(root: string, config: ResolvedConfig | null): Promise<CheckResult> {
  const label = 'Git LFS filter configured';
  let report: LfsEnvironmentReport;
  try {
    report = await inspectLfsEnvironment(root);
  } catch (err) {
    // A measurement failure is not a verdict — say the check could not run
    // rather than reporting a healthy repo we never actually inspected.
    return {
      ok: true,
      label,
      warning: `Could not determine git LFS status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!report.usesLfs) {
    return { ok: true, label: 'Git LFS not used by this repository' };
  }

  const version = report.binaryVersion ? ` (${report.binaryVersion})` : '';
  if (report.problems.length === 0) {
    return { ok: true, label: `${label}${version}` };
  }

  const mode = config?.git.lfs_check ?? 'refuse';
  const consequence = mode === 'refuse'
    ? 'Lazy will REFUSE to start tasks in this repository until this is fixed.'
    : mode === 'warn'
      ? 'Tasks still start ([git] lfs_check = "warn"), but their commits may be corrupt.'
      : 'The start-time check is disabled ([git] lfs_check = "off"), so nothing will stop it.';

  const detail =
    `This repository tracks files with git LFS, but a commit made here would store raw file ` +
    `content instead of an LFS pointer — silently, because git only errors on a broken LFS ` +
    `filter when filter.lfs.required is true.\n\n` +
    report.problems.map((p) => `  • ${p.message}\n    Fix: ${theme.command(p.remedy)}`).join('\n') +
    `\n\n  ${consequence}`;

  return { ok: false, label, detail, docs: 'lfs-guard' };
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
    ({ storage, ownsStorage } = await openDoctorStorage(root));
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
        docs: 'conversation-import',
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
    ({ storage, ownsStorage } = await openDoctorStorage(root));
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
 * Report tasks sitting in `merging`.
 *
 * `merging` is transient: an accept is either merging the task locally right now
 * (seconds to minutes) or a forge holds the merge and remote-sync is polling it.
 * A task that stays there is neither — its accept died — and until
 * fix-stranded-merging that was invisible AND inescapable, so one task sat wedged
 * for two weeks while reject, close and submit all refused it.
 *
 * The daemon's reconciler now recovers these on its own, so a task showing up
 * here means either the daemon is not running to do that, or the merge is
 * legitimately pending on a forge. Both are worth a human's eye, and both have
 * the same escape. Report-only, like every other doctor check.
 */
async function checkStrandedMerging(root: string): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    ({ storage, ownsStorage } = await openDoctorStorage(root));
    const merging = await storage.listTasksWithOptions({ mergingOnly: true });
    if (merging.length === 0) return { ok: true, label: 'No tasks stranded in merging' };
    const names = merging.map(t => displayId(t)).join(', ');
    return {
      ok: false,
      label: 'No tasks stranded in merging',
      detail:
        `${merging.length} task(s) in 'merging': ${names}. ` +
        `That state is transient — an accept holds it for the length of the merge, or a forge holds ` +
        `the PR. A task that stays there has no owner; the daemon recovers it on its next reconcile ` +
        `tick, so start it with ${theme.command('lazy daemon start')} if it is down. To act now, ` +
        `${theme.command('lazy unblock')}, ${theme.command('lazy reject')} or ${theme.command('lazy close')} ` +
        `the task — each returns it to a real status first.`,
    };
  } catch {
    return { ok: true, label: 'No tasks stranded in merging (check skipped)' };
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
    ({ storage, ownsStorage } = await openDoctorStorage(root));

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
    ({ storage, ownsStorage } = await openDoctorStorage(root));

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
 * Report whether an approval passphrase is enrolled on THIS machine, and flag
 * a leftover pre-v0.23 plaintext passphrase file in the project.
 *
 * Two distinct findings, deliberately in one check because they are two halves
 * of the same question ("can a protected merge be approved here, and is the
 * old secret gone?"):
 *
 * - Not enrolled WHILE protection is on: gated approvals fail closed on this
 *   machine. Report-only — the repository is healthy and the config is right;
 *   it is this machine that is not set up. (A fresh clone of a protected repo
 *   is SUPPOSED to be protected before anyone enrolls, which is why the gate
 *   itself never consults enrollment.)
 * - Leftover `.lazy/approve-passphrase`: never consulted any more, but it is a
 *   passphrase in the clear inside a tree every task agent can read. Flagged
 *   whether or not protection is on, because the exposure does not depend on
 *   the config.
 */
async function checkPassphraseEnrollment(root: string, config: ResolvedConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  let enrollment: Awaited<ReturnType<typeof readPassphraseEnrollment>> | null = null;
  try {
    enrollment = await readPassphraseEnrollment();
  } catch (err) {
    // A store that exists but is unusable (bad mode, corrupt JSON) is exactly
    // what doctor is for — surface the store's own message, which carries the
    // fix, rather than reducing it to "check skipped".
    results.push({
      ok: false,
      label: 'Approval passphrase store',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (enrollment) {
    if (enrollment.enrolled) {
      results.push({ ok: true, label: 'Approval passphrase enrolled (this machine)' });
    } else if (config.protection.enabled) {
      results.push({
        ok: true,
        label: 'Approval passphrase enrolled',
        warning:
          'Protection is on, but no approval passphrase is enrolled on this machine — ' +
          'gated merges will refuse here.\n' +
          `  Enroll once (covers every lazy project): ${theme.command('lazy system passphrase set')}`,
      });
    } else {
      results.push({ ok: true, label: 'Approval passphrase (not needed — protection is off)' });
    }
  }

  if (await legacyPassphraseFileExists(root)) {
    results.push({
      ok: true,
      label: 'Legacy plaintext passphrase file',
      warning:
        `${legacyPassphrasePath(root)} still exists. It is NO LONGER CONSULTED, but it holds a ` +
        `passphrase in the clear inside a repository every task agent can read.\n` +
        `  Delete it: ${theme.command(`rm ${legacyPassphrasePath(root)}`)}\n` +
        `  Then enroll the machine-global one if you have not: ${theme.command('lazy system passphrase set')}`,
    });
  }

  return results;
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
    { name: 'probe-agent', takesValue: false },
  ], 'doctor');

  const noResume = parsed.flags.get('no-resume') === true;
  const dryRun = parsed.flags.get('dry-run') === true;
  const yes = parsed.flags.get('yes') === true;
  const reimportConversationsFlag = parsed.flags.get('reimport-conversations') === true;
  const purgeHousekeepingFlag = parsed.flags.get('purge-housekeeping-conversations') === true;
  const importMemoryFlag = parsed.flags.get('import-memory') === true;
  const probeAgent = parsed.flags.get('probe-agent') === true;

  // If a positional argument is provided, run task-specific diagnostics
  if (parsed.positional.length > 0) {
    const { commandDoctorTask } = await import('./doctor-task');
    await commandDoctorTask(parsed.positional[0], { dryRun, yes, probeAgent });
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
  /** Set when the sweep found a storage lock nobody will ever release. */
  let staleStorageLockPath: string | null = null;

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
        ? { ok: false, label: 'lazy.toml parses', detail: configError, docs: 'troubleshooting-config' }
        : { ok: true, label: 'lazy.toml parses' },
    );
  }

  // Detect — and clear — a wedged storage lock BEFORE anything else touches
  // storage.
  //
  // Two reasons this cannot wait until its slot in the sweep below. A lock
  // nobody will ever release fails every storage operation, doctor's own
  // included, so a check that runs after them never runs at all: the command
  // dies with the very error it exists to explain. And StorageLock now reclaims
  // locks it can prove are stale, which would quietly consume the evidence
  // before the check could report it. What survives to here is precisely the
  // wedge the automatic path cannot resolve on its own.
  let storageLockResult: CheckResult | null = null;
  const storageLockDir = root && !configError ? await resolveStorageLockDir(root, config!) : null;
  if (root && !configError) {
    const storageLock = await checkStorageLock(storageLockDir);
    storageLockResult = storageLock.result;
    staleStorageLockPath = storageLock.stalePath;
    if (staleStorageLockPath) {
      if (storageLockResult.detail) console.log(`${theme.error('✗')} ${storageLockResult.detail}\n`);
      if (dryRun) {
        console.log(`Would remove stale storage lock: ${staleStorageLockPath}\n`);
      } else {
        const proceed = yes || !isTTY()
          ? yes
          : await promptYesNo(`Remove the stale storage lock at ${staleStorageLockPath}?`, true);
        if (proceed) {
          try {
            await unlink(staleStorageLockPath);
            console.log(theme.success(`Removed stale storage lock: ${staleStorageLockPath}\n`));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(theme.error(`Could not remove ${staleStorageLockPath}: ${message}\n`));
          }
        } else {
          console.log(`Left in place. Remove it yourself with: ${theme.command(`rm ${staleStorageLockPath}`)}\n`);
        }
      }
    }
  }

  // The other half of the lock problem, and the one the automatic paths cannot
  // touch: a holder whose identity VERIFIES. Nothing may reclaim that lock —
  // the process at that pid really is the one that took it — so doctor's only
  // options are to queue behind it or to work around it. Queueing is how doctor
  // used to spend the whole retry loop, per storage call, and arrive at a report
  // full of unexplained "(check skipped)" lines. So: look once, in bounded time,
  // and if something is sitting there, say who and skip the checks that would
  // block. A report that names its own gaps beats a report that never prints.
  //
  // Only reached when the lock is NOT stale — a stale lock was just offered for
  // removal above, and the probe deliberately returns nothing for one.
  let heldLock: HeldLockReport | null = null;
  if (storageLockDir && !staleStorageLockPath) {
    heldLock = await probeHeldStorageLock(join(storageLockDir, STORAGE_LOCK_FILENAME), {
      windowMs: DOCTOR_LOCK_PROBE_MS,
    });
  }
  // A held lock is only an obstruction when nothing is serving storage. The
  // daemon holds this lock for its entire lifetime by design, and doctor reads
  // task state THROUGH the daemon — so the normal, healthy case must run the
  // full sweep rather than skip half of it. See assessHeldLock.
  const lockAssessment: HeldLockAssessment = heldLock && root
    ? await assessHeldLock(root, heldLock)
    : 'foreign';
  const lockBlocks = heldLock !== null && lockAssessment !== 'daemon-serving';
  const heldLockSummary = heldLock
    ? lockAssessment === 'daemon-stuck'
      ? `daemon pid ${heldLock.pid} is not serving storage`
      : `storage lock held by pid ${heldLock.pid}`
    : '';
  /** Report a check that was not run because it would have queued on the lock. */
  const skippedForLock = (label: string): CheckResult => ({
    ok: true,
    label: `${label} (skipped — ${heldLockSummary})`,
  });

  const runnerType = config?.runner?.type ?? 'docker';
  // createRunner loads config itself, so it throws on the same broken file.
  //
  // It also RESOLVES the live proxy address up front and fails loud when it
  // cannot (ProxyUnavailableError) — which, the proxy being always on, is
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
    results.push({ ok: false, label: 'Runner available', detail: runnerError, docs: 'troubleshooting-daemon' });
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
          results.push({ ok: false, label: check.what, detail: check.reason, docs: 'agent-container' });
          break;
      }
    }
  }

  // Only container runners bind-mount the agent binary; in host-process mode the
  // supervisor IS lazy itself and no such file is involved.
  if (isContainerRunner) {
    results.push(await checkAgentBinary());
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
    results.push(await checkBuilderScratch(root));
    results.push(await checkDaemonStateFiles(root));

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
      results.push(await checkStaleLazyImages(imageName, runnerType));
      // The orphan check reads every candidate container's task out of storage;
      // with the lock held it would queue once per container.
      if (lockBlocks) {
        results.push(skippedForLock('No orphaned containers'));
      } else if (runnerType === 'docker') {
        results.push(await checkOrphanedContainers(root));
      } else {
        results.push(await checkOrphanedContainers(root, 'podman'));
      }
    }

    // Detect crashed runs for non-terminal tasks (works for both runner types)
    if (runner && lockBlocks) {
      results.push(skippedForLock('No crashed task runs'));
    } else if (runner) {
      try {
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
      } catch (err) {
        // Say what could not be checked, rather than printing a green check for
        // a question that was never asked.
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          ok: true,
          label: 'No crashed task runs (skipped — could not read task state)',
          warning: message,
        });
      }
    }

    results.push(await checkStaleLocks(root));
    // Result computed up front (see the storage-lock block near the top), but
    // reported here so the sweep's output keeps its usual order.
    if (storageLockResult) results.push(storageLockResult);
    if (storageLockDir) results.push(describeHeldStorageLock(heldLock, storageLockDir, lockAssessment));
    results.push(await checkSplitStorage(root));
    if (lockBlocks) {
      // Every check in this block reads through Storage EXCEPT the credential
      // one, which now reads the project-local audit log instead. Each of the
      // rest would spend the acquire timeout and then report itself skipped
      // with no reason given; naming the holder once, up front, is the whole
      // point of the probe.
      results.push(skippedForLock('No tasks stranded in merging'));
      results.push(skippedForLock('Conversation capture is live'));
      results.push(skippedForLock('Shared memory up to date'));
      results.push(skippedForLock('Injected memory context'));
      results.push(await checkCredentialAccepted(join(root, config!.data.path)));
      results.push(skippedForLock('No legacy proxy audit log in the store'));
      results.push(skippedForLock('Protected tasks resolvable'));
    } else {
      results.push(await checkStrandedMerging(root));
      results.push(await checkReimportableConversations(root, join(root, config!.data.path)));
      results.push(await checkImportableMemories(root, join(root, config!.data.path)));
      results.push(await checkMemoryContext(root, config!));
      results.push(await checkCredentialAccepted(join(root, config!.data.path)));
      results.push(await checkLegacyProxyAuditLog(root));
      results.push(await checkProtectedTasksResolvable(root, config!));
    }
    results.push(await checkDefaultBranchProtectionResolvable(root, config!));
    results.push(...(await checkPassphraseEnrollment(root, config!)));
    results.push(await checkTaskBranchUpstreamTracking());
    results.push(await checkLfsEnvironment(root, config));
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
      if (r.docs) {
        const pointer = docsSuffix(r.docs, '');
        if (pointer) console.log(`  ${pointer}`);
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
          const proc = spawnSyncUnsupervised(
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
       lazy doctor <task-id> [--dry-run] [--yes] [--probe-agent]

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
  --probe-agent              Task mode only: have the in-container doctor start a real
                             claude process to confirm the agent itself sees the lazy
                             tools. Off by default because it bills a model request
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
  - Approval passphrase enrollment on this machine, and any leftover plaintext
    .lazy/approve-passphrase file from before it moved out of the repo
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
  - Agent MCP wiring, by running "lazy-agent doctor" inside the task's container and
    passing its output through (skipped, not failed, when there is no live container)

Exit code is 0 if all checks pass, 1 if any issues are found.${docsFooter('troubleshooting')}`);
}
