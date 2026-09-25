/**
 * Doctor sweep — the checks and the runner that produces a structured report.
 *
 * Presentation (colours, prompts, process.exit) stays in the CLI. This module
 * decides what is true and returns a JSON-able report the CLI, the daemon RPC
 * and the inbox alert all consume.
 *
 * Checks that used to be sync (statfs, docker inspect, directory scans) are
 * async or run in a Worker so they cannot pin the daemon event loop.
 */

import { access, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tryRemoteStorage } from '../preconditions';
import { shortId, displayId, taskRef } from '../task/identity';
import { checkHolder, describeDeadReason, type HolderVerdict } from '../utils/process-identity';
import {
  probeHeldStorageLock,
  STORAGE_LOCK_FILENAME,
  type HeldLockReport,
} from '../utils/storage-lock';
import { getHome } from '../utils/home';
import { verifyAgentBinary, formatAgentBinaryError } from '../agent/binary-identity';
import { agentBinaryPointerPath, resolveInstalledAgentBinary } from '../agent/binary-install';
import { getDataDir } from '../project-paths';
import { createStorage, getProjectName } from '../storage';
import { theme } from '../render/theme';
import { repoHasCommits } from '../git/operations';
import { describeIdentity } from '../identity';
import { attributionLabel } from '../actor-ref';
import { resolveImageName, calculateImageInputsHash } from '../capture/claude';
import {
  loadConfig,
  loadRawConfig,
  usesDeprecatedChecksSection,
  usesDeprecatedLoopSection,
  usesDeprecatedLowHighKeys,
  usesDeprecatedByTypeLoop,
  LOOP_DEPRECATED_KEYS,
  CHECKS_DEPRECATED_KEYS,
} from '../config/loader';
import { createRunner } from '../runner';
import type { Runner } from '../runner';
import {
  findUnknownConfigKeys,
  findRemovedConfigKeys,
  findDeprecatedConfigSections,
  DEPRECATED_SECTION_KEYS,
  DEPRECATED_SECTIONS,
} from '../config/schema';
import { openDoctorStorage, withDoctorStorage } from './storage';
import {
  measureContextBudget,
  contextBudgetRemedy,
  type ContextBudgetReport,
  type RoleContextBudget,
} from '../context-budget';
import { isManagedMode, evaluateManagedConfig, flattenConfigAsks } from '../config/managed';
import { getKnownFeatures, getUnknownFlags, isFeatureEnabled } from '../utils/features';
import { createDriver } from '../remote';
import type { ResolvedConfig } from '../config/types';
import type { RepositoryDriver } from '../remote';
import { resolveOfflineStatus, formatOfflineExpiry } from '../utils/offline';
import { detectShell, getCompletionSetupCommand, getShellConfigFile } from '../shell/detect';
import type { ShellInfo } from '../shell/detect';
import { spawn } from '../utils/spawn';
import { runGit } from '../utils/git';
import { which } from 'bun';
import {
  listMissingConversationsByImportability,
  classifyMissingConversations,
} from '../import/reimport-conversations';
import {
  countScaffoldingSummaries,
  describeWorktreeReclaim,
  findOrphanedContainers,
  findStaleLazyImages,
  findTerminalTaskWorktrees,
  findTrackedTaskBranches,
  formatDiskBytes,
  StaleImageScanError,
  type OrphanedContainer,
  type TerminalWorktree,
  type TrackedTaskBranch,
} from './findings';
import { countImportableMemories } from '../import/import-harness-memory';
import { builderScratchDir, scratchDirSize, formatScratchBytes } from '../builder/scratch';
import { unresolvedAuthRejection } from '../proxy/auth-verdict';
import { describeOverage, describeReadingsStoreError, describeUsagePause } from '../usage-pause/policy';
import { describeNoReading, describeUsagePauseState, type UsagePauseState } from '../daemon/usage-pause';
import { tryRpc, DaemonNotRunningError } from '../daemon/client';
import {
  readAuditRecords,
  legacyAuditLogInfo,
  formatSize,
  AUDIT_LOG_FILENAME,
  AUDIT_LOG_SUBDIR,
} from '../proxy/audit-log';
import {
  fetchDaemonCredentialState,
  ProxyUnavailableError,
  type DaemonCredentialEntry,
  type DaemonCredentialState,
} from '../daemon/auth-env';
import { inspectDaemonStateFiles } from '../daemon/state-files';
import { getDaemonDir, PID_FILE } from '../daemon/paths';
import { readDaemonLockPid, readPid, checkDaemonHealth, isDaemonRunning, type DaemonStatus } from '../daemon/lifecycle';
import { requestDaemonHealth, DaemonPredatesHealthError } from '../daemon/daemon-health-client';
import { BUILD_MATCH_ROW_ID, summarizeRows, type DaemonHealthReport } from '../daemon/daemon-health-rows';
import { getSourceIdentity } from '../utils/source-id';
import { resolveDashboardUrl } from '../daemon/dashboard-url';
import { compareDashboardAddress, misplacedDashboardUrlTables } from '../daemon/dashboard-address';
import { credentialInEnv, getStoredCredential, readCredentialIndex } from '../credentials/store';
import {
  credentialHowToGet,
  credentialLabel,
  credentialSelfRefreshing,
  credentialSetupCommand,
  credentialHoldsChatGptSession,
  profilesBilling,
  defaultRequiredCredentials,
  envVarsFor,
  requiredCredentials,
} from '../credentials/providers';
import { locateProfileCredential } from '../agent/credentials';
import { parseChatGptTokens } from '../credentials/chatgpt-tokens';
import { agentProfilesFor } from '../config/agent-profiles';
import {
  assembleMemorySection,
  formatBytes,
  isLiveMemory,
  recordsNewerThanCompact,
  namesRemovedSinceCompact,
} from '../memory';
import type { Storage } from '../storage/interface';
import { classifyProtectedTasks } from '../protection/edge-gate';
import {
  readPassphraseEnrollment,
  legacyPassphraseFileExists,
  legacyPassphrasePath,
} from '../protection/passphrase-store';
import { inspectLfsEnvironment, type LfsEnvironmentReport } from '../git/lfs';
import { statfsOffThread } from './worker';
import { buildReport, toStructuredCheck } from './registry';
import type { DoctorCheckFamily } from './check-families';
import type {
  CheckResult,
  DoctorReport,
  DoctorRunOptions,
} from './types';

export type { CheckResult };

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Storage the current sweep should reuse (daemon handle), if any. */
let sweepStorage: Storage | undefined;
/** Project root for the current sweep — used by checks that used to call findLazyRoot(). */
let sweepRoot: string | null = null;

function withSweepStorage<T>(root: string, fn: (storage: Storage) => Promise<T>): Promise<T> {
  return withDoctorStorage(root, fn, sweepStorage);
}

// Docker timeout mirrors the one in capture/claude.ts
const DOCKER_TIMEOUT_MS = 10_000;
/**
 * How long doctor waits for the daemon's health report before calling it
 * unanswered. Above the report's slowest check (the runner's own 35 s deadline
 * for a busy container runtime), so a slow Docker reads as a slow Docker in the
 * report rather than as a daemon that never answered.
 */
const DOCTOR_DAEMON_HEALTH_TIMEOUT_MS = 45_000;

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

/**
 * WHO LAZY WILL SAY DID IT — and, when it cannot say, the only place that
 * explains at length.
 *
 * The single-warning-surface rule: the point of occurrence (a refused unblock,
 * a refused create) prints git's own refusal and one line pointing here; the
 * diagnosis lives in doctor. So this check names the resolved person when there
 * is one, and carries the whole remedy when there is not.
 *
 * Resolved locally rather than through the daemon, deliberately: doctor runs
 * when the daemon may be down, and a check that cannot run is worse than one
 * answering from this process's own git config — which, on a laptop, is the
 * same config the daemon reads.
 */
async function checkActorIdentity(root: string | null): Promise<CheckResult> {
  // Outside a lazy project there is no project root to anchor on, and git's own
  // precedence answers the same question from the current directory.
  const identity = await describeIdentity(root ?? process.cwd());
  if (identity.mode === 'teams') {
    return {
      ok: true,
      id: 'actor-identity',
      label: 'Actor identity (managed mode: each request carries its own)',
    };
  }
  if (identity.configured) {
    return {
      ok: true,
      id: 'actor-identity',
      label: `Actor identity: ${attributionLabel('human', identity.email, identity.name)}`,
    };
  }
  return {
    ok: false,
    id: 'actor-identity',
    label: 'Actor identity',
    detail:
      `${identity.refusal}\n\n` +
      `  Until this is set, lazy refuses anything that writes to its store — creating, unblocking,\n` +
      `  commenting, accepting, closing. Reading (${theme.command('lazy list')}, ${theme.command('lazy show')}, ` +
      `${theme.command('lazy diff')}) keeps working.\n` +
      `  lazy asks git for this every minute, so a fix takes effect immediately — no daemon restart.`,
    remedy: 'Set git user.email and user.name (git config --global user.email "you@example.com").',
    docs: 'identity',
  };
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

/**
 * The runner's and the remote driver's own diagnostics carry labels the sweep
 * does not choose, so they are classified here rather than by label
 * (`./check-families.ts`). A sick container runtime stops every turn; a sick
 * forge stops pushes and PRs, which is almost always an auth problem.
 */
const RUNNER_DIAGNOSTIC_CLASS: DoctorCheckFamily = { family: 'runner-health', remedyKind: 'host', impact: 'work' };
const REMOTE_DRIVER_DIAGNOSTIC_CLASS: DoctorCheckFamily = { family: 'remote-driver', remedyKind: 'credential', impact: 'work' };

/**
 * Said when no configured profile bills any credential — every upstream the
 * project talks to authenticates nobody (`credential = "none"`, the default for
 * a local model server). A project that needs none is healthy, not
 * unauthenticated, so the check passes and says why.
 */
const NO_CREDENTIAL_NEEDED =
  `${AUTH_PRESENT_LABEL} (none needed — every configured profile uses an upstream that takes no credential)`;

/**
 * The only thing a daemon that predates per-credential reporting can say about
 * a project whose role defaults bill no Anthropic credential.
 */
const NO_ANTHROPIC_NEEDED = 'no Anthropic credential needed for this project';

/** One credential's finding, as the daemon or the local fallback reported it. */
interface CredentialReport {
  name: string;
  label: string;
  requiredBy: string[];
  present: boolean;
  source: 'env' | 'store' | 'file' | null;
  via: string | null;
  /** Credential FORM when the store records one; see credentialLabelLine. */
  kind?: 'oauth' | 'api-key' | null;
  /** The store cannot be read and the daemon's startup copy is standing in. */
  stale?: boolean;
  error?: string;
}

/** "the claude-code profile" / "the openai-pi and work-codex profiles". */
function profilesPhrase(requiredBy: string[]): string {
  if (requiredBy.length <= 1) return `the ${requiredBy[0] ?? 'default'} profile`;
  const last = requiredBy[requiredBy.length - 1]!;
  return `the ${requiredBy.slice(0, -1).join(', ')} and ${last} profiles`;
}

/** Where a present credential came from, in the words a human uses. */
function credentialSourceWord(source: 'env' | 'store' | 'file', envWord: string): string {
  switch (source) {
    case 'env': return envWord;
    case 'store': return 'credential store';
    case 'file': return 'agent key file';
  }
}

/**
 * `<Label> credential present (…)` — the label of one credential's line. Says
 * where it was found and which profiles need it, or only the latter when it is
 * missing. `envWord` names WHOSE environment was read: the daemon's, or — in
 * degraded mode — this shell's.
 */
function credentialLabelLine(report: CredentialReport, envWord: 'daemon env' | 'shell env'): string {
  const needed = `needed by ${report.requiredBy.join(', ')}`;
  // The KIND, when the store knows it. On a provider that issues both forms this
  // is the difference between spending a subscription already paid for and
  // spending metered credit, and doctor is where a user looks BEFORE launching —
  // "oauth" vs "api-key" is the only place that answer appears in this report.
  const kind = report.kind ? `${report.kind}, ` : '';
  if (!report.present || !report.source) return `${report.label} credential present (${needed})`;
  // DEGRADED beats the plain source word. Saying "credential store: keychain"
  // while every request is served the daemon's startup copy would send someone
  // debugging a rotation that has not taken to look anywhere but at the
  // keychain they actually need to unlock.
  const where = report.stale
    ? 'store UNREADABLE — using the copy loaded at daemon startup'
    : `${credentialSourceWord(report.source, envWord)}: ${report.via}`;
  return `${report.label} credential present (${kind}${where}; ${needed})`;
}

/**
 * How to get a missing credential to the daemon: obtain it, store it (the
 * durable fix — no shell has to carry it), or export it where the daemon starts.
 * Every piece comes from the credentials module, so a named credential
 * (`work-openai`) gets its own store command and its own env var.
 */
function missingCredentialRemedy(name: string): string {
  return (
    `${credentialLabel(name)} — ${credentialHowToGet(name)}\n  ` +
    // Not always `auth set`: a ChatGPT subscription is stored from the file
    // `codex login` wrote, so naming `set` there would send the user pasting a
    // JSON session at a masked prompt. One helper, so doctor and every other
    // surface name the command that actually works.
    `Store it (preferred — no shell has to carry it): ` +
    `${theme.command(`lazy ${credentialSetupCommand(name)}`)}` +
    // A self-refreshing credential is never hydrated into the daemon's env — the
    // proxy reads it from the store per request — so telling the user to restart
    // interrupts every running task for nothing, and teaches the opposite of how
    // the credential works.
    `${credentialSelfRefreshing(name) ? '' : `, then ${theme.command('lazy daemon restart')}`}\n  ` +
    `Or export ${envVarsFor(name).join(' or ')} in the DAEMON's environment and restart it.`
  );
}

/**
 * Are the model credentials this project needs present — in the environment
 * that actually matters?
 *
 * That environment is the DAEMON's, not this CLI process's. The daemon is the
 * single credential owner (credential-gate.ts) and every agent it launches
 * inherits its env, so reading `process.env` here answered a different question
 * and got it wrong in both directions: in a deployment where the token is
 * exported only for the daemon, doctor reported "not authenticated" while
 * everything worked; a stale token left in the user's shell made doctor report
 * healthy auth the daemon never had.
 *
 * PER CREDENTIAL. What to check comes from the credentials module — every
 * credential the configured agent profiles bill (`requiredCredentials`), never
 * a rule re-derived here — and each gets its own line: label, presence, where
 * it was found, and which profiles need it. A missing one fails by name with
 * the command that stores it. A project whose profiles all use upstreams that
 * take no credential passes with one line saying so. This is wider than the
 * daemon's startup gate on purpose: the gate reads the role defaults so that a
 * declared-but-unselected profile never refuses a daemon, but a task that
 * selects it WILL refuse to launch, and doctor is where that should show first.
 *
 * The daemon reports presence + source labels only — no token travels to the
 * CLI just so we can print a checkmark (see `handleGetCredentialState`).
 *
 * Degraded mode: when the daemon cannot be reached we still answer, from this
 * process's env and the credential store, but every line NAMES the environment
 * consulted so the answer is never mistaken for the daemon's. Same shape as the
 * other daemon-preferring checks here — a diagnostics hiccup must not
 * masquerade as a verdict.
 *
 * PRESENCE, NOT VALIDITY. This check and `checkCredentialAccepted` are
 * deliberately different questions: "a credential is present" vs "upstream
 * accepts it". An expired token passes this one and fails that one — which is
 * exactly the gap that made the builder /login loop unfindable.
 */
async function checkAuth(config: ResolvedConfig | null): Promise<CheckResult[]> {
  let daemonReason = '';
  try {
    const state = await fetchDaemonCredentialState();
    if (state) {
      // The per-credential answer is AUTHORITATIVE when the daemon gives one:
      // the same requiredCredentials resolution this CLI would make, reported
      // against the environment that actually launches agents.
      if (Array.isArray(state.providers)) return reportDaemonCredentials(state.providers);
      return asModelCredential([legacyDaemonAnswer(state)]);
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
  return asModelCredential(await reportLocalCredentials(config, daemonReason));
}

/**
 * Credential lines are labelled per provider ("<Provider> credential present
 * (needed by …)"), so no label prefix can classify them. Every one answers the
 * same question — can turns reach a model — so they share one family.
 */
const MODEL_CREDENTIAL_CLASS: DoctorCheckFamily = { family: 'model-credential', remedyKind: 'credential', impact: 'work' };

function asModelCredential(results: CheckResult[]): CheckResult[] {
  return results.map(result => ({ classification: MODEL_CREDENTIAL_CLASS, ...result }));
}

/**
 * Does every stored credential lazy knows the SHAPE of actually parse?
 *
 * checkAuth above is presence-only, deliberately — it asks the daemon, which
 * answers from the non-secret index so a detached start never blocks on a
 * keychain unlock. That leaves a real gap: a CORRUPT stored credential is
 * present by every measure and fails only when a turn presents it. One did,
 * hours later, as `401 … JSON Parse error: Unterminated string` — a truncated
 * write that every surface reported as a healthy credential right up until the
 * agent died on it.
 *
 * Only the ChatGPT session is checked, because it is the only stored credential
 * whose shape lazy defines; an API key is an opaque string and there is nothing
 * to validate. Reads the secret, which is why this lives in `lazy doctor` (a
 * human at a terminal who can answer a keychain prompt) and not in the gate or
 * in `lazy auth list`.
 */
async function checkStoredCredentialsParse(
  root: string,
  config: ResolvedConfig | null,
): Promise<CheckResult[]> {
  const label = 'Stored credentials are readable';
  let stored: Awaited<ReturnType<typeof readCredentialIndex>>;
  try {
    stored = await readCredentialIndex(root);
  } catch {
    // The index itself is unreadable — checkAuth already reports that, with the
    // file named. One cause, one failed check.
    return [];
  }

  const sessions = stored.filter(e => credentialHoldsChatGptSession(config, e.provider));
  if (sessions.length === 0) return [];

  const results: CheckResult[] = [];
  for (const entry of sessions) {
    try {
      const secret = await getStoredCredential(root, entry.provider);
      if (!secret) continue;
      parseChatGptTokens(secret.value, `the stored "${entry.provider}" credential`);
      results.push({ ok: true, label: `${label} (${entry.provider})` });
    } catch (err) {
      const suggested = profilesBilling(config, entry.provider)[0] ?? entry.provider;
      results.push({
        ok: false,
        label: `${label} (${entry.provider})`,
        detail:
          `The stored "${entry.provider}" credential is present but cannot be used: ` +
          `${err instanceof Error ? err.message : String(err)}\n  ` +
          `Every task on it fails with a 401 naming this. Replace it:\n    ` +
          `${theme.command('codex login')}\n    ` +
          `${theme.command(`lazy auth import ${suggested}`)}`,
        docs: 'troubleshooting-credential',
      });
    }
  }
  return results;
}

/**
 * One line per credential, from the daemon's own answer.
 *
 * Exported for tests: this is a pure projection of the `getCredentialState`
 * WIRE SHAPE onto doctor's lines, which is the boundary worth pinning — a field
 * the daemon sends and this drops (or never declares) is invisible until a user
 * reads a line that describes the wrong thing.
 */
export function reportDaemonCredentials(entries: DaemonCredentialEntry[]): CheckResult[] {
  if (entries.length === 0) return asModelCredential([{ ok: true, label: NO_CREDENTIAL_NEEDED }]);
  return asModelCredential(entries.map((entry): CheckResult => {
    if (entry.error) {
      // The daemon could not read the store's index (or the agent key file)
      // for this one credential. Its message names the file and the fix; the
      // other credentials were answered normally.
      return {
        ok: false,
        label: credentialLabelLine(entry, 'daemon env'),
        detail:
          `The daemon could not tell whether a ${entry.label} credential is available ` +
          `(${profilesPhrase(entry.requiredBy)} bills it): ${entry.error}`,
        docs: 'troubleshooting-credential',
      };
    }
    if (entry.present) return { ok: true, label: credentialLabelLine(entry, 'daemon env') };
    // Reachable: the gate guards only the ROLE DEFAULTS at startup, and config
    // can change under a running daemon — a declared profile's credential can
    // be missing while the daemon runs happily. Report it plainly.
    return {
      ok: false,
      label: credentialLabelLine(entry, 'daemon env'),
      detail:
        `The daemon holds no ${entry.label} credential — every launch of ${profilesPhrase(entry.requiredBy)} ` +
        `fails to reach its model API.\n  ${missingCredentialRemedy(entry.name)}`,
      docs: 'troubleshooting-credential',
    };
  }));
}

/**
 * A daemon that predates per-credential reporting: presence of the Anthropic
 * env credential is all it can say. Say so rather than passing that off as the
 * whole picture — a restart puts the current binary in charge.
 */
function legacyDaemonAnswer(state: DaemonCredentialState): CheckResult {
  const skew =
    `The running daemon predates per-credential reporting, so it could only answer for Anthropic — ` +
    `run ${theme.command('lazy daemon restart')} and re-run to check every profile's credential.`;
  if (!state.anthropicRequired) {
    return { ok: true, label: `${AUTH_PRESENT_LABEL} (${NO_ANTHROPIC_NEEDED})`, warning: skew };
  }
  if (state.present) {
    return { ok: true, label: `${AUTH_PRESENT_LABEL} (daemon env: ${state.source})`, warning: skew };
  }
  return {
    ok: false,
    label: AUTH_PRESENT_LABEL,
    detail:
      `The daemon is running but holds no Anthropic credential — every launch of an Anthropic-billed ` +
      `profile fails to reach the model API.\n  ${missingCredentialRemedy('anthropic')}`,
    docs: 'troubleshooting-credential',
  };
}

/**
 * Degraded: answer from THIS process's env and the credential store, and say so
 * on every line.
 *
 * The store (and the agent key file) is consulted only inside a lazy project:
 * both live in the PROJECT's daemon dir, and resolving that dir from an
 * arbitrary cwd would read some other project's index — or invent a path for
 * one — and report it as this project's credentials. Outside a project the
 * answer is env-only, and the line says so.
 */
async function reportLocalCredentials(
  config: ResolvedConfig | null,
  daemonReason: string,
): Promise<CheckResult[]> {
  // A config that will not load falls back to the built-in defaults — the same
  // fallback a daemon started against that file would make.
  const required = config ? requiredCredentials(config) : defaultRequiredCredentials();
  if (required.length === 0) return [{ ok: true, label: NO_CREDENTIAL_NEEDED }];

  const root = sweepRoot;
  const consulted = root
    ? "this shell's environment and the credential store"
    : "this shell's environment only (not inside a lazy project, so the credential store was not consulted)";
  const caveat =
    `Read from ${consulted}, not the daemon's (${daemonReason}). ` +
    `Agents inherit the DAEMON's environment, so this may not be what lazy actually uses — ` +
    `check it with ${theme.command('lazy daemon status')} and re-run.`;
  const profiles = config ? agentProfilesFor(config) : null;

  const results: CheckResult[] = [];
  for (const { name, requiredBy } of required) {
    const report: CredentialReport = {
      name, label: credentialLabel(name), requiredBy, present: false, source: null, via: null,
    };
    try {
      if (root) {
        // Which harnesses bill it decides whether the agent key file counts —
        // the same rule the launch path applies (locateProfileCredential).
        const harnesses = profiles ? requiredBy.map((p) => profiles.get(p)?.harness ?? '') : [];
        Object.assign(report, await locateProfileCredential(root, name, harnesses));
      } else {
        const envVar = credentialInEnv(name);
        if (envVar) Object.assign(report, { present: true, source: 'env', via: envVar });
      }
    } catch (err) {
      // A broken index must not turn a diagnostic into a crash — but it must
      // not vanish either: it is this credential's finding.
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        ok: false,
        label: credentialLabelLine(report, 'shell env'),
        detail:
          `Could not tell whether a ${report.label} credential is available, and the daemon could not ` +
          `be asked (${daemonReason}): ${msg}`,
        docs: 'troubleshooting-credential',
      });
      continue;
    }
    if (report.present) {
      results.push({ ok: true, label: credentialLabelLine(report, 'shell env'), warning: caveat });
      continue;
    }
    results.push({
      ok: false,
      label: credentialLabelLine(report, 'shell env'),
      detail:
        `No ${report.label} credential in ${consulted}, and the daemon could not be asked (${daemonReason}). ` +
        `Every launch of ${profilesPhrase(requiredBy)} needs one.\n  ${missingCredentialRemedy(name)}`,
      docs: 'troubleshooting-credential',
    });
  }
  return results;
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
 * [usage_pause]: is any credential paused, is the pause able to act at all, and
 * what is waiting on it?
 *
 * The one surface that EXPLAINS a pause in full (the launch refusal and the
 * pause notice each say it once and point here). Answered from the daemon's own
 * state — the readings the launch gate decides on (seeded from Storage and the
 * audit log) and the pending override — through the same functions the gate
 * uses, so the two cannot disagree.
 *
 * A pause is the feature working, so it is a warning on a passing check.
 * "Armed, NO READING" is NOT the feature working: pausing is on and cannot
 * engage for a credential lazy is spending, which is a warning too — never an
 * OK, because an OK there is exactly how the feature silently did nothing.
 * Degrades to a skipped check when the state cannot be read.
 */
/**
 * The [usage_pause] state doctor explains — the DAEMON's, whenever there is a
 * daemon to ask.
 *
 * INVARIANT: `lazy doctor` runs its sweep in the CLI process, and the state
 * that matters lives in the daemon: the readings it seeded from Storage (this
 * process has no store to seed from, only the bounded audit log — gone during
 * a long pause), and the pending one-shot override (daemon memory). Computed
 * locally, doctor said "OK" about a paused credential whose reading had rotated
 * out of the log, and never showed a pending override. So it asks the daemon,
 * and computes locally ONLY when no daemon is running (or inside the daemon
 * itself, and under the in-process test harness, where the RPC is bypassed).
 */
async function usagePauseStateForDoctor(root: string, now: number): Promise<UsagePauseState> {
  const local = () => withSweepStorage(root, (storage) => describeUsagePauseState(root, storage, undefined, undefined, now));
  let fromDaemon: UsagePauseState | null;
  try {
    fromDaemon = await tryRpc<UsagePauseState>('usagePause', {});
  } catch (err) {
    if (err instanceof DaemonNotRunningError) return local();
    throw new Error(`could not ask the daemon for the usage-pause state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return fromDaemon ?? local();
}

/**
 * What doctor says a person can do about a pause. The override command is
 * named only when `offerOverride` (a person at their own terminal): doctor is
 * where every refusal points, including the builder's and an agent's, and
 * spelling the escape hatch out to them undid the daemon's refusal.
 */
export function usagePauseAdvice(offerOverride: boolean): string[] {
  return [
    'New turns on a paused credential are not started; turns already running continue. ' +
      'Work lazy started by itself goes ahead when the window resets.',
    offerOverride
      ? `To let ONE turn start anyway: ${theme.command('lazy daemon config set usage_pause_threshold off')}, ` +
        'then start, unblock, resume, review or ask.'
      : 'Starts, unblocks, resumes, reviews and asks go ahead again once the window resets.',
  ];
}

async function checkUsagePause(root: string, config: ResolvedConfig, offerOverride: boolean): Promise<CheckResult> {
  const { threshold_percent: global, credentials } = config.usage_pause;
  if (global <= 0 && !Object.values(credentials).some((v) => v > 0)) {
    return { ok: true, label: 'Usage pause (off)' };
  }
  const label = global > 0 ? `Usage pause (threshold ${global}%)` : 'Usage pause (per-credential thresholds)';
  try {
    const now = Date.now();
    const state = await usagePauseStateForDoctor(root, now);
    // An older daemon answers without the newer fields; a missing list is empty,
    // a missing time unknown — never a crash of the check.
    const coverage = state.coverage ?? [];
    const paused = state.paused ?? [];
    const held = state.held ?? [];
    const override = state.override ?? null;
    const overrideSetAt = state.overrideSetAt ?? null;
    const noReading = coverage.filter((c) => c.coverage === 'none');
    const lines: string[] = [];
    // INVARIANT: unreadable saved readings are never "OK, nothing paused" —
    // the gate refuses every launch it judges until a person fixes the file.
    const storeError = state.storeError ?? null;
    if (storeError) lines.push(describeReadingsStoreError(storeError));
    for (const c of noReading) lines.push(describeNoReading(c));
    // Paid overage ON is the thing the pause exists for: said as a warning, so it
    // is never missed. Overage OFF is stated in the label — nothing to act on.
    const overageOn = coverage.filter((c) => c.overage?.status === 'allowed');
    const overageOff = coverage.filter((c) => c.overage && c.overage.status !== 'allowed');
    for (const c of overageOn) lines.push(describeOverage(c.credential, c.overage!));
    for (const v of paused) lines.push(describeUsagePause(v, now));
    for (const h of held) lines.push(`${h.task}: its ${h.hold.held} is waiting on ${h.hold.credential}.`);
    if (override !== null) {
      lines.push(
        `A one-shot override is pending: ${override > 0 ? `threshold ${override}%` : 'off'}` +
          `${overrideSetAt ? `, set ${new Date(overrideSetAt).toISOString()}` : ''}. The next ` +
          `paused turn you start goes ahead on it. Clear it: ${theme.command('lazy daemon config reset usage_pause_threshold')}`,
      );
    }
    const overageLabel = overageOff.length > 0
      ? `${label} — overage off on ${overageOff.map((c) => `${c.credential} (${c.overage!.reason ?? c.overage!.status})`).join(', ')}`
      : label;
    if (lines.length === 0) return { ok: true, label: overageLabel };
    if (paused.length > 0 || held.length > 0) lines.push(...usagePauseAdvice(offerOverride));
    const armedLabel = storeError
      ? `${overageLabel} — saved readings UNREADABLE, launches refused`
      : noReading.length > 0
        ? `${overageLabel} — armed, NO READING for ${noReading.length} credential${noReading.length === 1 ? '' : 's'}`
        : overageLabel;
    return { ok: true, label: armedLabel, warning: lines.join('\n  ') };
  } catch (err) {
    return {
      ok: true,
      label: 'Usage pause (check skipped)',
      warning: `Could not read the usage-pause state: ${err instanceof Error ? err.message : String(err)}`,
    };
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

async function checkDataDir(root: string): Promise<CheckResult> {
  const dataDir = getDataDir(root);
  const dataPath = join(root, dataDir);

  if (!(await pathExists(dataPath))) {
    return { ok: false, label: 'Data directory exists', detail: `${dataDir}/ directory not found. Run ${theme.command('lazy init')}.` };
  }

  // Resolve the actual tasks directory based on storage backend config
  const config = await loadConfig(root);
  let tasksDir: string;
  let displayPath: string;

  switch (config.storage.backend) {
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
      throw new Error(`Unknown storage backend: "${config.storage.backend}". Valid backend is "external".`);
  }

  if (!(await pathExists(tasksDir))) {
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
 * One line summarising `lazy daemon health` — never its rows. The daemon's
 * moving parts (loops, sweeps, proxy, store, runner, stuck tasks) are
 * diagnosed there, with a remedy per row; doctor only says whether anything is
 * wrong and points at it, so the same finding is never explained in two places.
 */
export async function checkDaemonHealthSummary(
  root: string,
  provider: (() => Promise<DaemonHealthReport>) | undefined,
): Promise<CheckResult> {
  const pointer = `run ${theme.command('lazy daemon health')} for each check and its remedy`;
  let report: DaemonHealthReport;
  try {
    if (provider) {
      report = await provider();
    } else {
      if (!isDaemonRunning(root)) {
        return { ok: true, label: 'Daemon health (skipped — no daemon is running)' };
      }
      // No client identity: doctor's own "Daemon runs current code" check
      // answers the build question, so the daemon need not compare builds.
      report = await requestDaemonHealth(root, {
        timeoutMs: DOCTOR_DAEMON_HEALTH_TIMEOUT_MS,
        sendClientIdentity: false,
      });
    }
  } catch (err) {
    // An old daemon is one cause, and doctor's own "Daemon runs current code"
    // check reports it with the restart remedy — say only that this was skipped.
    if (err instanceof DaemonPredatesHealthError) {
      return { ok: true, label: 'Daemon health (skipped — the running daemon predates this check; see "Daemon runs current code")' };
    }
    return {
      ok: false,
      label: 'Daemon health',
      detail: `The daemon did not return its health report: ${(err instanceof Error ? err.message.split('\n')[0]! : String(err)).replace(/\.$/, '')}.\n  ${pointer[0]!.toUpperCase()}${pointer.slice(1)}.`,
      remedy: 'Run lazy daemon health; if the daemon is hung, lazy daemon restart clears it.',
    };
  }
  // The build-match row is left out whatever it says: doctor's own "Daemon
  // runs current code" check reports a stale daemon build, and one finding is
  // explained in one place (doctor-single-warning-surface).
  const rows = report.rows.filter(r => r.id !== BUILD_MATCH_ROW_ID);
  const { counts } = summarizeRows(rows);
  const failing = rows.filter(r => r.state === 'fail').map(r => r.name);
  const warning = rows.filter(r => r.state === 'warn').map(r => r.name);
  if (failing.length > 0) {
    return {
      ok: false,
      label: 'Daemon health',
      detail: `${counts.fail} failing: ${failing.join(', ')}${warning.length ? ` (and ${counts.warn} warning)` : ''} — ${pointer}.`,
      remedy: 'Run lazy daemon health for each failing check and its remedy.',
    };
  }
  if (warning.length > 0) {
    return {
      ok: true,
      label: `Daemon health: ${counts.ok} OK, ${counts.warn} warning`,
      warning: `${warning.join(', ')} — ${pointer}.`,
    };
  }
  return { ok: true, label: `Daemon health: all ${counts.ok} checks OK` };
}

/**
 * Recognise a daemon whose state files were deleted underneath it.
 *
 * The signature is unmistakable and, before this check existed, completely
 * opaque: the daemon holds its `daemon.lock` (so it is definitely alive and
 * definitely owns this directory) and usually still answers on its recorded web
 * port, but `lazy.pid` is gone. Commands that fall back to the file-based
 * liveness signals then reported "Daemon is not running." against a daemon
 * that was running fine, and `lazy daemon start` failed because the live
 * daemon held the storage lock — with no non-destructive way out.
 *
 * Report-only: the daemon repairs its own files within seconds (see
 * src/daemon/state-files.ts), so the remedy here is "wait, or restart if the
 * daemon predates that repair" — not something doctor should do behind the
 * user's back.
 */
/**
 * Is the running daemon serving the code that is on disk right now?
 *
 * The failure is silent by construction: a daemon serves whatever it was started
 * with and never hot-reloads, so a merged fix, a new handler or a whole feature
 * that exists only on the checked-out branch simply does not happen — with
 * nothing anywhere saying why. That is the `monolithic-versioning` incident,
 * where a review feature present only on a release branch read as lost because
 * the daemon had been built from main.
 *
 * Compares CONTENT identities (src/utils/source-id.ts), not git SHAs, so it is
 * also right on a dirty working tree — the state a checkout spends most of a
 * development day in, and the one a SHA comparison calls "up to date".
 *
 * Says nothing at all when the two sides are not comparable: no daemon running,
 * a daemon too old to report an id, or a compiled binary with no tree to hash.
 * A warning derived from incomparable values would be worse than silence.
 */
async function checkDaemonCodeCurrent(root: string): Promise<CheckResult | null> {
  let status: DaemonStatus;
  try {
    status = await checkDaemonHealth(root);
  } catch {
    return null;
  }
  if (!status.running || !status.sourceId) return null;

  let identity;
  try {
    identity = await getSourceIdentity();
  } catch {
    return null;
  }
  if (identity.kind === 'build') return null;

  if (identity.id === status.sourceId) {
    return { ok: true, label: `Daemon runs current code (${identity.id})` };
  }

  return {
    ok: false,
    label: 'Daemon runs current code',
    detail:
      `The daemon is running source ${status.sourceId}, but this checkout is ${identity.id}. ` +
      `Anything you changed, merged or checked out since it started is NOT in force — the daemon ` +
      `serves the code it was launched with and never reloads.\n` +
      `  Restart it to pick the current code up: ${theme.command('lazy daemon restart')}\n` +
      `  That interrupts running agent and pair sessions; each agent turn resumes against the new daemon.`,
  };
}

/**
 * Which origin dashboard links and sign-in use, when `[server] dashboard_url`
 * is set — and whether the running daemon is actually using it.
 *
 * The setting changes three things at once (the URL every surface prints, the
 * only Host the dashboard answers on, the only Origin a state-changing request
 * may come from) and it takes effect only on a daemon START. So the two
 * questions a person asks after setting it — "what is in effect?" and "why is
 * nothing different?" — are both answered here. The comparison is
 * `compareDashboardAddress` (src/daemon/dashboard-address.ts), the same one
 * `lazy dashboard` and `lazy daemon dashboard-url` use for their one-line
 * pointer here, so the two cannot disagree.
 *
 * Returns null when there is nothing to say: no `dashboard_url` anywhere, and
 * no running daemon still serving one that was removed. Managed daemons have
 * no dashboard (they report `dashboardUrl: null`), and the managed policy
 * blanks the key.
 */
export function describeDashboardAddress(
  configuredOrigin: string,
  status: Pick<DaemonStatus, 'running' | 'webPort' | 'bindHost' | 'dashboardUrl'> | null,
  misplacedTables: string[] = [],
): CheckResult | null {
  const problem = compareDashboardAddress(configuredOrigin, misplacedTables, status);

  if (problem?.kind === 'misplaced') {
    return {
      ok: false,
      label: 'Dashboard address',
      detail:
        `lazy.toml has dashboard_url under ${problem.tables.join(', ')}, where lazy never reads it, so the ` +
        `dashboard is still served at its default address. Move the line under [server]:\n` +
        `    [server]\n` +
        `    dashboard_url = "https://lazy.example.com"\n` +
        `  then restart the daemon: ${theme.command('lazy daemon restart')}`,
      remedy: 'Move dashboard_url under [server] in lazy.toml, then restart the daemon (lazy daemon restart).',
    };
  }

  if (problem?.kind === 'drift') {
    const asked = problem.configured
      ? `lazy.toml sets [server] dashboard_url = "${problem.configured}"`
      : 'lazy.toml no longer sets [server] dashboard_url';
    return {
      ok: false,
      label: 'Dashboard address',
      detail:
        `${asked}, but the running daemon still serves the dashboard at ${problem.served} — links, ` +
        `\`lazy dashboard\` and sign-in all use that. The setting is read only when the daemon starts.\n` +
        `  Restart it to apply lazy.toml: ${theme.command('lazy daemon restart')}\n` +
        `  That interrupts running agent and pair sessions; each agent turn resumes against the new daemon.`,
      remedy: 'Restart the daemon (lazy daemon restart) so it picks up [server] dashboard_url.',
    };
  }

  if (!configuredOrigin) return null;

  // A correct, applied setting is plain OK: the origin in effect and what it
  // shuts out go in the label, never in `warning` — yellow on a working setup
  // teaches people to skim past the colour that matters.
  const pending = status?.running ? '' : '; takes effect when the daemon starts';
  const refused = status?.running && status.webPort
    ? resolveDashboardUrl(status.bindHost, status.webPort)
    : 'http://lazy.localhost:<port>';
  return {
    ok: true,
    label:
      `Dashboard address: ${configuredOrigin} ([server] dashboard_url${pending}) — ` +
      `links and sign-in use it; ${refused} is refused`,
  };
}

async function checkDashboardAddress(root: string, config: ResolvedConfig): Promise<CheckResult | null> {
  if (isManagedMode()) return null;
  let status: DaemonStatus | null = null;
  try {
    status = await checkDaemonHealth(root);
  } catch (err) {
    // No answer from the daemon is "not running" for this check's purpose: it
    // then reports only what lazy.toml asks for. The daemon's own health is
    // other checks' business.
    void err;
  }
  return describeDashboardAddress(
    config.server.dashboard_url,
    status,
    misplacedDashboardUrlTables(await loadRawConfig(root)),
  );
}

async function checkDaemonStateFiles(root: string): Promise<CheckResult> {
  const report = await inspectDaemonStateFiles(root);

  if (!report.filesDeletedUnderLiveDaemon) {
    return { ok: true, label: 'Daemon state files consistent' };
  }

  const who = report.lockPid !== null ? ` (PID ${report.lockPid})` : '';
  const web = report.webPortListening && report.webPort !== null
    ? ` It is still answering on its web port (${report.webPort}).`
    : '';

  return {
    ok: false,
    label: 'Daemon state files consistent',
    detail:
      `A daemon${who} is running and owns ${getDaemonDir(root)}, but ${PID_FILE} ` +
      `is missing — something deleted its state files while it was ` +
      `running.${web} Commands that fall back to file-based liveness will report it as not running ` +
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
/**
 * Report daemon worktree-image adoption state (Part 2 of the worktree-image
 * flow). Silent when nothing is adopted — a green line for the common case
 * would be noise. Surfaces valid, expired, missing-dockerfile, and
 * content-drifted states so the human can see what the daemon will (or will
 * not) launch with.
 */
export async function checkAdoptedImage(root: string): Promise<CheckResult | null> {
  const { inspectAdoptedImage, clearAdoptedImage } = await import('../daemon/adopted-image');
  const { dirname } = await import('path');
  const { VERSION } = await import('../version');
  const { IMAGE_TAG, imageTagFor } = await import('../capture/image-tag');
  const result = await inspectAdoptedImage(root);

  if (result.status === 'none') return null;

  if (result.status === 'valid') {
    // Name the directory the image was built from, not just the Dockerfile:
    // those two coming from different trees is the bug this reporting exists
    // for. The HEAD is provenance only — the build read that directory live.
    const head = result.state.contextCommit
      ? ` (HEAD ${result.state.contextCommit.slice(0, 12)} when adopted)`
      : '';
    return {
      ok: true,
      label: 'Worktree image adopted',
      detail:
        `${result.state.imageName} from ${result.state.dockerfilePath}, ` +
        `build context ${dirname(result.state.dockerfilePath)}${head} ` +
        `(lazy ${result.state.lazyVersion}, adopted ${result.state.adoptedAt}). ` +
        `Applies to the daemon and launches without a per-task pin until the next \`lazy upgrade\` rebuild.`,
    };
  }

  if (result.status === 'expired') {
    // Expire in place so doctor both diagnoses and cleans — same lifecycle as
    // daemon startup / resolveCustomDockerfile.
    await clearAdoptedImage(root);
    return {
      ok: true,
      label: 'Worktree image adoption expired',
      warning:
        `Adoption was for lazy ${result.state.lazyVersion} (image tag ${imageTagFor(result.state.lazyVersion)}) ` +
        `but this binary is ${VERSION} (image tag ${IMAGE_TAG}) — cleared. ` +
        `Re-run \`lazy upgrade\` from a worktree TTY to adopt again.`,
    };
  }

  if (result.status === 'content-drifted') {
    await clearAdoptedImage(root);
    return {
      ok: true,
      label: 'Worktree image adoption cleared',
      warning:
        `Adopted Dockerfile at ${result.state.dockerfilePath} changed after consent — cleared so ` +
        `launches do not rebuild from post-consent edits. Re-run \`lazy upgrade\` from a worktree TTY to adopt again.`,
    };
  }

  // missing-dockerfile
  await clearAdoptedImage(root);
  return {
    ok: true,
    label: 'Worktree image adoption cleared',
    warning:
      `Adopted Dockerfile was missing at ${result.state.dockerfilePath} — cleared so launches ` +
      `are not wedged. Re-run \`lazy upgrade\` from a worktree TTY to adopt again.`,
  };
}

export async function checkContainerImage(imageName: string, binary: string = 'docker'): Promise<CheckResult> {
  try {
    const proc = spawn(
      [binary, 'image', 'inspect', imageName, '--format', '{{.Id}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode === 0 && stdout.trim().length > 0) {
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
  // Use the same image-identity hash logic as the build code in capture/claude.ts.
  // This hashes the custom Dockerfile if configured, or the embedded default
  // Dockerfile — never the project's own Dockerfile at the repo root — plus the
  // contents of every `[docker] build_inputs` file.
  let currentHash: string;
  try {
    currentHash = await calculateImageInputsHash(root);
  } catch (err) {
    // Throws if a custom Dockerfile or a declared build_input is configured but missing
    return {
      ok: false,
      label: 'Container image up to date',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const inspect = spawn(
      [binary, 'image', 'inspect', imageName, '--format', '{{index .Config.Labels "lazy.dockerfile.hash"}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
    );
    const [inspectStdout, inspectCode] = await Promise.all([
      new Response(inspect.stdout).text(),
      inspect.exited,
    ]);
    if (inspectCode === 0) {
      const imageHash = inspectStdout.trim();
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
 *
 * Detection is `findStaleLazyImages`, shared with `--clean-docker-images`, so the
 * report and the remedy can never disagree — and so an image a launch still
 * needs (the daemon-adopted one, any task-pinned one) is excluded from both.
 * Doctor used to name the just-adopted image as reclaimable unless a container
 * happened to be running on it.
 */
export async function checkStaleLazyImages(
  imageName: string,
  binary: string = 'docker',
  root?: string | null,
): Promise<CheckResult> {
  let stale: Awaited<ReturnType<typeof findStaleLazyImages>>;
  try {
    stale = root
      ? await withSweepStorage(root, handle => findStaleLazyImages(imageName, binary, root, handle))
      : await findStaleLazyImages(imageName, binary, root);
  } catch (err) {
    // A scan that could not run is a reported SKIP, never "no stale images" and
    // never a failed check: nothing here is unhealthy, we just cannot say.
    // An unreachable runtime is already reported by the runtime checks, so this
    // one stays quiet about it — one warning per problem.
    const runtime = err instanceof StaleImageScanError && err.kind === 'runtime';
    return {
      ok: true,
      label: `No stale runner images (skipped — ${runtime ? 'runtime unavailable' : 'cannot tell which images are in use'})`,
      ...(runtime ? {} : { warning: err instanceof Error ? err.message : String(err) }),
    };
  }

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
      `Reclaim the space with: ${theme.command('lazy doctor --clean-docker-images')}`,
    remedyFlag: 'clean-docker-images',
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
 * A content-addressed install in ~/.lazy/bin (lazy-agent-<id>) is mounted at
 * /usr/local/bin/lazy-agent in every container; ~/.lazy/bin/lazy-agent-current is
 * a pointer symlink to the current one. When the installed file is the wrong file
 * — a bare Bun runtime is the case seen in the field — the container fails far
 * from the cause, as `Script not found "builder"` or a silent MCP -32000 with no
 * lazy_* tools. Doctor is where that gets diagnosed by name, on the host, before
 * a launch — and it reports the RESOLVED install, not the pointer.
 */
async function checkAgentBinary(): Promise<CheckResult> {
  const binDir = join(getHome(), '.lazy', 'bin');
  const binaryPath = (await resolveInstalledAgentBinary(binDir)) ?? agentBinaryPointerPath(binDir);
  if (!(await pathExists(binaryPath))) {
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
  if (!(await pathExists(worktreesDir))) {
    return { ok: true, label: 'No stale locks' };
  }

  const stale: string[] = [];
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lockPath = join(worktreesDir, entry.name, '.lazy-lock');
      if (!(await pathExists(lockPath))) continue;
      try {
        const lockData = JSON.parse(await readFile(lockPath, 'utf-8'));
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
export async function resolveStorageLockDir(root: string, config: ResolvedConfig): Promise<string | null> {
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
  if (!(await pathExists(lockPath))) return { result: { ok: true, label }, stalePath: null };

  let lockData: { pid?: unknown };
  try {
    lockData = JSON.parse(await readFile(lockPath, 'utf-8'));
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
      // Any failure — no reachable address, a 500 from a daemon that cannot reach its own
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

export function formatTimeSince(isoDate: string): string {
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
  const { storage, ownsStorage } = await openDoctorStorage(root, sweepStorage);
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

/**
 * Report lazy containers of THIS project that nothing needs any more.
 *
 * Detection is `findOrphanedContainers`, shared with
 * `--clean-orphaned-containers`, so what is reported is exactly what the remedy
 * removes. The report used to end in a pasted `docker rm ... && docker rm -f ...`
 * line — unreviewable at a dozen containers, and the `-f` half was a
 * force-remove nobody read before pressing return.
 */
async function checkOrphanedContainers(
  root: string | null,
  binary: 'docker' | 'podman' = 'docker',
): Promise<CheckResult> {
  if (!root) return { ok: true, label: 'No orphaned containers' };

  // Through the daemon when there is one: it holds the storage lock for its
  // whole lifetime, so a private FileStorage here queues on it and then
  // silently reports every container as "not ours".
  let storage: Storage;
  let ownsStorage: boolean;
  try {
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));
  } catch (err) {
    // Cannot read task state, so "is this container ours" is unanswerable.
    // Report that instead of the green check the old swallow used to print.
    return {
      ok: true,
      label: 'No orphaned containers (skipped — could not read task state)',
      warning: err instanceof Error ? err.message : String(err),
    };
  }

  let orphans: OrphanedContainer[];
  try {
    orphans = await findOrphanedContainers(root, storage, binary);
  } catch (err) {
    return {
      ok: true,
      label: 'No orphaned containers (skipped — could not list containers)',
      warning: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (ownsStorage) await storage.close();
  }

  if (orphans.length === 0) return { ok: true, label: 'No orphaned containers' };

  const stopped = orphans.filter(o => !o.running).map(o => o.name);
  const running = orphans.filter(o => o.running).map(o => o.name);
  const parts: string[] = [];
  if (stopped.length > 0) parts.push(`${stopped.length} stopped: ${stopped.join(', ')}`);
  if (running.length > 0) {
    parts.push(`${running.length} running for finished tasks: ${running.join(', ')}`);
  }

  return {
    ok: false,
    label: 'No orphaned containers',
    detail: `${orphans.length} orphaned lazy container(s): ${parts.join('; ')}. ` +
            `Remove with: ${theme.command('lazy doctor --clean-orphaned-containers')}`,
    remedyFlag: 'clean-orphaned-containers',
  };
}

/**
 * Report worktrees still on disk for tasks that are finished with.
 *
 * Pure disk cost — the task is complete or abandoned, and nothing will run in
 * the tree again — but the cost is large: each tree can carry a full
 * `node_modules` or Rust `target`, and 169 GB of them was found in one project
 * in the wild. That is why the size is measured, not just the count.
 */
async function checkTerminalTaskWorktrees(root: string): Promise<CheckResult> {
  let storage: Storage;
  let ownsStorage: boolean;
  try {
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));
  } catch (err) {
    return {
      ok: true,
      label: 'No worktrees left for finished tasks (skipped — could not read task state)',
      warning: err instanceof Error ? err.message : String(err),
    };
  }

  let worktrees: TerminalWorktree[];
  try {
    worktrees = await findTerminalTaskWorktrees(root, storage);
  } finally {
    if (ownsStorage) await storage.close();
  }

  if (worktrees.length === 0) {
    return { ok: true, label: 'No worktrees left for finished tasks' };
  }

  const shown = worktrees
    .slice(0, 5)
    .map(w => `${w.taskCode} (${formatDiskBytes(w.sizeBytes)})`);
  const more = worktrees.length > 5 ? `, +${worktrees.length - 5} more` : '';
  return {
    ok: true,
    label: 'No worktrees left for finished tasks',
    warning:
      `${describeWorktreeReclaim(worktrees)} still on disk for finished tasks: ` +
      `${shown.join(', ')}${more}. Branches are kept either way. ` +
      `Reclaim the space with: ${theme.command('lazy doctor --clean-worktrees')}`,
    remedyFlag: 'clean-worktrees',
  };
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

/**
 * On a managed (fleet) host, report every key of the repository's lazy.toml
 * that is not being honored, and what is used instead.
 *
 * THIS IS THE ONE PLACE THAT EXPLAINS IT. Managed mode overrides silently by
 * design — a daemon that printed a warning per key on every load would print
 * them into every agent turn's output. Per the single-warning-surface rule, the
 * point of occurrence carries one generic pointer and the full per-key
 * diagnosis lives here.
 *
 * Returns NOTHING when managed mode is off, so unmanaged `lazy doctor` output
 * is byte-identical to what it was before this feature existed.
 */
function checkManagedConfig(raw: Record<string, unknown> | null): CheckResult[] {
  if (!isManagedMode()) return [];

  let evaluation;
  try {
    evaluation = evaluateManagedConfig(raw ?? {});
  } catch (err) {
    // readFleetValues failed: the daemon was armed as managed without being
    // told which store/runner it manages. Nothing else here can be trusted.
    return [{
      ok: false,
      label: 'Managed mode',
      detail: err instanceof Error ? err.message : String(err),
      docs: 'managed-config',
    }];
  }

  const results: CheckResult[] = [{
    ok: true,
    label: 'Managed mode: on (this host is shared — parts of lazy.toml are set by the fleet)',
  }];

  for (const refusal of evaluation.refusals) {
    results.push({
      ok: false,
      label: `lazy.toml '${refusal.key}'`,
      detail: `This project's lazy.toml asks for ${refusal.key} = ${JSON.stringify(refusal.asked)}, ` +
        `which a managed host refuses: ${refusal.why} Remove the key — the project will not start until you do.`,
      docs: 'managed-config',
    });
  }

  // Only the keys the repository actually stated: a project that never asked
  // for a runner does not need to be told which one it got.
  const asked = new Set(flattenConfigAsks(raw ?? {}).keys());
  const stated = evaluation.overrides.filter((o) => asked.has(o.key));
  if (stated.length === 0 && evaluation.refusals.length === 0) {
    results.push({ ok: true, label: 'No lazy.toml setting is being overridden' });
  }
  for (const override of stated) {
    results.push({
      ok: true,
      label: `lazy.toml '${override.key}'`,
      warning: `This repository's lazy.toml asks for ${JSON.stringify(override.asked)}; ` +
        `managed mode uses ${JSON.stringify(override.effective)}. ${override.why}`,
    });
  }

  return results;
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

  // [checks] was folded into [automation]. The loader still honors the old
  // spelling — it is never silently ignored — but this is the surface that
  // carries the full diagnosis and remedy (one generic line is printed at the
  // point of occurrence; everything else lives here).
  const hasDeprecatedChecks = usesDeprecatedChecksSection(raw);
  if (hasDeprecatedChecks) {
    const section = raw.checks as Record<string, unknown>;
    const present = CHECKS_DEPRECATED_KEYS.filter(k => section[k] !== undefined);
    const moved = present
      .map(k => `  ${k} = ${JSON.stringify(section[k])}   →   [automation] ${k} = ${JSON.stringify(section[k])}`)
      .join('\n');
    results.push({
      ok: true,
      label: 'Config section [checks]',
      warning:
        '[checks] is deprecated — every declarative hook now lives in [automation]. ' +
        'Your setting is still honored, but move it:\n' +
        `${moved}\n` +
        'Then delete the [checks] section. If a key is set in BOTH sections with different ' +
        'values, lazy refuses to load the config rather than guess which one you meant.',
    });
  }

  // [loop] was renamed [cluster] when the `loop` task type became `cluster`. Same
  // shape as [checks] above: the loader honors the old spelling, and this is the
  // surface that carries the diagnosis and the remedy.
  const hasDeprecatedLoop = usesDeprecatedLoopSection(raw);
  if (hasDeprecatedLoop) {
    const section = raw.loop as Record<string, unknown>;
    const moved = LOOP_DEPRECATED_KEYS
      .filter(k => section[k] !== undefined)
      .map(k => `  ${k} = ${JSON.stringify(section[k])}   →   [cluster] ${k} = ${JSON.stringify(section[k])}`)
      .join('\n');
    results.push({
      ok: true,
      label: 'Config section [loop]',
      warning:
        '[loop] is deprecated — the `loop` task type was renamed `cluster`, and this section ' +
        'with it. Your setting is still honored, but move it:\n' +
        `${moved}\n` +
        'Then delete the [loop] section. If a key is set in BOTH sections with different ' +
        'values, lazy refuses to load the config rather than guess which one you meant.',
    });
  }

  // [agent.by_type] loop → cluster. The third surface of the same rename, and
  // the one that used to take the whole project down: by_type keys are task
  // type names, validated by throwing, so a routing line naming the retired
  // type made every command fail at loadConfig. The loader now aliases it; this
  // is where the diagnosis and the remedy live.
  if (usesDeprecatedByTypeLoop(raw)) {
    const byType = (raw.agent as Record<string, unknown> | undefined)?.by_type as
      | Record<string, unknown>
      | undefined;
    const profile = JSON.stringify(byType?.loop);
    results.push({
      ok: true,
      label: 'Config key [agent.by_type] loop',
      warning:
        'The `loop` task type was renamed `cluster`, and this routing key with it. Your ' +
        'setting is still honored, but rename it:\n' +
        `  loop = ${profile}   →   cluster = ${profile}\n` +
        'Then delete the `loop` entry. If BOTH names route the same type to different ' +
        'profiles, lazy refuses to load the config rather than guess which one you meant.',
    });
  }

  // [agent] low_high_loop* → [review]. Same shape as [loop] above: the loader
  // honors the old spellings, so these must NOT appear under the "obsolete and
  // is IGNORED" heading below — a human told their setting is dead leaves it in
  // place while it keeps deciding how their tasks are reviewed.
  if (usesDeprecatedLowHighKeys(raw)) {
    const agent = raw.agent as Record<string, unknown>;
    const lines: string[] = [];
    if (agent.low_high_loop !== undefined) {
      const mode = agent.low_high_loop ? 'low_high' : 'separate';
      lines.push(
        `  low_high_loop = ${JSON.stringify(agent.low_high_loop)}   →   [review] mode = "${mode}"`,
      );
    }
    for (const key of ['low_high_loop_draft_effort', 'low_high_loop_review_effort'] as const) {
      if (agent[key] === undefined) continue;
      const newKey = key === 'low_high_loop_draft_effort' ? 'draft_effort' : 'review_effort';
      lines.push(`  ${key} = ${JSON.stringify(agent[key])}   →   [review] ${newKey} = ${JSON.stringify(agent[key])}`);
    }
    results.push({
      ok: true,
      label: 'Config keys [agent] low_high_loop*',
      warning:
        'The low-high loop is no longer an experiment under [agent] — it is the DEFAULT review ' +
        'mode, and its settings moved to [review]. Your settings are still honored, but move ' +
        'them:\n' +
        `${lines.join('\n')}\n` +
        'Note `low_high_loop = false` becomes mode = "separate", not the new default: false ' +
        'meant "no in-session loop, the daemon dispatches its own reviewer", and that is what ' +
        'separate is. Then delete the [agent] keys. If both spellings set the same thing to ' +
        'different values, lazy refuses to load the config rather than guess which you meant.',
    });
  }

  // Keys lazy REMOVED outright (DEPRECATED_SECTION_KEYS). Unlike [checks],
  // these have no honored old spelling — the key is ignored — so the migration
  // sentence matters more, not less. The loader prints one line at load time
  // and points here for this.
  const removedKeys = findRemovedConfigKeys(raw);
  for (const dotted of removedKeys) {
    results.push({
      ok: true,
      label: `Config option '${dotted}'`,
      warning: `'${dotted}' is obsolete and is IGNORED. ${DEPRECATED_SECTION_KEYS[dotted]!()}`,
    });
  }

  // Whole sections lazy removed. Unlike the keys above these are not ignored —
  // a section with settings in it REFUSES the load — so this finding is what a
  // user whose lazy.toml no longer loads reads to find out what to write
  // instead. `lazy doctor` reads the raw file, so it still runs for a config
  // the loader would not accept, which is exactly when it is needed.
  for (const section of findDeprecatedConfigSections(raw)) {
    results.push({
      ok: true,
      label: `Config section '[${section}]'`,
      warning: `The [${section}] section has been REMOVED. ${DEPRECATED_SECTIONS[section]!()}`,
    });
  }

  // Check for deprecated remote keys in [remote] section
  const remoteSection = raw.remote;
  const hasDeprecated = driverOpts.deprecated.some(dep => {
    if (typeof remoteSection !== 'object' || remoteSection === null) return false;
    return dep.key in remoteSection;
  });

  if (!hasDeprecated && !hasDeprecatedChecks && !hasDeprecatedLoop) {
    results.push({ ok: true, label: 'No deprecated config options' });
  }
  if (hasDeprecated) {
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
      const classification = REMOTE_DRIVER_DIAGNOSTIC_CLASS;
      switch (check.state) {
        case 'ok':
          driverResults.push({ ok: true, label: check.what, classification });
          break;
        case 'warn':
          driverResults.push({ ok: true, label: check.what, warning: check.reason, classification });
          break;
        case 'fail':
          driverResults.push({ ok: false, label: check.what, detail: check.reason, classification });
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
  if (!(await pathExists(inRepoTasksDir))) {
    return { ok: true, label: 'No split storage (external storage clean)' };
  }

  try {
    const entries = await readdir(inRepoTasksDir, { withFileTypes: true });
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

/**
 * Report `lazy/...` branches carrying upstream tracking config, and say what is
 * actually true about them.
 *
 * The old warning claimed this "can cause 'git pull' to merge task branches into
 * main". It cannot: `git pull` consults only the CURRENT branch's upstream, so
 * tracking on a task branch has no effect at all while you are on main. Tracking
 * that points a task branch at its own remote counterpart is ordinary git config
 * and is reported as leftover state, not a hazard. Tracking whose `.merge` names
 * a DIFFERENT branch is the one genuinely surprising shape — a `git pull` on
 * that task branch merges the other branch in — and only that escalates.
 */
async function checkTaskBranchUpstreamTracking(root: string): Promise<CheckResult> {
  const label = 'No task branches with upstream tracking';
  let tracked: TrackedTaskBranch[];
  try {
    tracked = await findTrackedTaskBranches(root);
  } catch (err) {
    return {
      ok: true,
      label: `${label} (check skipped)`,
      warning: err instanceof Error ? err.message : String(err),
    };
  }

  if (tracked.length === 0) return { ok: true, label };

  const mismatched = tracked.filter(t => t.mismatched);
  const remedy = `Unset it with: ${theme.command('lazy doctor --unset-upstream-tracking')}`;

  if (mismatched.length > 0) {
    return {
      ok: false,
      label,
      detail:
        `${mismatched.length} task branch(es) track a DIFFERENT branch, so ${theme.command('git pull')} ` +
        `on them merges that branch in: ` +
        `${mismatched.map(t => `${t.branch} → ${t.merge}`).join(', ')}. ${remedy}`,
      remedyFlag: 'unset-upstream-tracking',
    };
  }

  return {
    ok: true,
    label,
    warning:
      `${tracked.length} task branch(es) have leftover upstream tracking: ` +
      `${tracked.map(t => t.branch).join(', ')}. Harmless — ${theme.command('git pull')} only ever ` +
      `follows the branch you are on — but lazy does not need it. ${remedy}`,
    remedyFlag: 'unset-upstream-tracking',
  };
}

async function checkDiskSpace(root: string): Promise<CheckResult> {
  try {
    const stats = await statfsOffThread(root);
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
    // statfs is not available on all platforms; a Worker crash is the same skip.
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
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));
    // Split by what the reimport itself would do with each session, using the
    // reimport's OWN predicate. A session whose JSONL holds no parseable
    // messages is not recoverable — the reimport skips it as empty — and doctor
    // used to point at `--reimport-conversations` for exactly those, forever:
    // warn, skip, warn again, with nothing a human could do to clear it.
    const { recoverable, unimportable } = await listMissingConversationsByImportability({
      lazyRoot: root,
      dataDirAbs,
      storage,
    });
    const { rotted, historical } = classifyMissingConversations(recoverable, Date.now());

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
        remedyFlag: 'reimport-conversations',
      };
    }

    if (historical.length > 0) {
      return {
        ok: true,
        label: 'Conversation capture is live',
        warning:
          `${historical.length} older conversation(s) found on disk but missing from the store, ` +
          `recoverable from an earlier capture bug. ` +
          `Recover with: ${theme.command('lazy doctor --reimport-conversations')}`,
        remedyFlag: 'reimport-conversations',
      };
    }

    if (unimportable.length > 0) {
      // Stated as a green fact with no remedy attached: these files hold no
      // conversation to import, so there is nothing for a human to run. A yellow
      // warning pointing at a reimport that then skips them is the loop this
      // check no longer has.
      return {
        ok: true,
        label:
          `All importable conversations captured ` +
          `(${unimportable.length} empty session file(s) on disk, nothing to import)`,
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
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));
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
      remedyFlag: 'import-memory',
    };
  } catch {
    return { ok: true, label: 'Shared memory (check skipped)' };
  } finally {
    if (storage && ownsStorage) await storage.close();
  }
}

/**
 * Report stored conversations that still LIST as Claude Code local-command
 * scaffolding — the caveat block, a built-in slash command, its output.
 *
 * Ingest stopped storing that material (src/import/local-command-messages.ts),
 * but nothing rewrites what was stored before: re-import skips sessions already
 * in the store, and the capture sweep only re-saves a session whose file
 * changed. So the noise stays visible in every conversation listing until a
 * human runs the remedy, which is exactly what a doctor warning is for.
 *
 * Counted off the conversation INDEX, not the transcripts: a routine sweep must
 * not parse every stored conversation to produce one line. That makes this a
 * strict UNDER-count of what the remedy cleans (a row whose scaffolding sits
 * further down lists fine and is not counted) — the safe direction, since a
 * check pointing at a remedy with nothing to do is the failure worth avoiding.
 *
 * Report-only, like every other check: the rewrite is an explicit
 * `lazy doctor --clean-local-command-conversations`.
 */
async function checkLocalCommandConversations(root: string): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));
    const { affected, total } = await countScaffoldingSummaries(storage);
    if (affected === 0) return { ok: true, label: 'Conversation listings are clean' };
    return {
      ok: true,
      label: 'Conversation listings',
      warning:
        `${affected} of ${total} stored conversation(s) list Claude Code local-command scaffolding ` +
        `instead of what was actually said. New ones are no longer stored that way; these predate ` +
        `that. Clean with: ${theme.command('lazy doctor --clean-local-command-conversations')}`,
      remedyFlag: 'clean-local-command-conversations',
    };
  } catch {
    // Same posture as every storage-backed check: a store we cannot read
    // degrades one line to a skip, never fails the sweep.
    return { ok: true, label: 'Conversation listings (check skipped)' };
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
 * The daemon now RESUMES a dead accept (marker present) on its own, so a task
 * showing up here means the daemon is not running, its resumes keep failing, or
 * the merge is legitimately pending on a forge. The remedies differ, so the
 * detail says which. Report-only, like every other doctor check.
 */
async function checkStrandedMerging(root: string): Promise<CheckResult> {
  let storage: Storage | null = null;
  let ownsStorage = false;
  try {
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));
    const merging = await storage.listTasksWithOptions({ mergingOnly: true });
    if (merging.length === 0) return { ok: true, label: 'No tasks stranded in merging' };
    const names = merging.map(t => displayId(t)).join(', ');
    const { ACCEPT_IN_FLIGHT_KEY } = await import('../daemon/stranded-merge');
    const dead = merging.filter(t => !!t.metadata?.[ACCEPT_IN_FLIGHT_KEY]);
    const forge = merging.filter(t => !t.metadata?.[ACCEPT_IN_FLIGHT_KEY]);
    const parts = [`${merging.length} task(s) in 'merging': ${names}.`];
    if (dead.length > 0) {
      parts.push(
        `${dead.map(t => displayId(t)).join(', ')}: an accept died mid-way. The daemon resumes it on its own — ` +
        `start it with ${theme.command('lazy daemon start')} if it is down — or run ${theme.command('lazy accept <task>')} ` +
        `to resume it now and see any error. Reject/close refuse until the daemon's resumes are exhausted.`,
      );
    }
    if (forge.length > 0) {
      parts.push(
        `${forge.map(t => displayId(t)).join(', ')}: the merge is pending on the forge. ` +
        `${theme.command('lazy unblock')}, ${theme.command('lazy reject')} or ${theme.command('lazy close')} ` +
        `return the task to a real status first if you want out.`,
      );
    }
    return {
      ok: false,
      label: 'No tasks stranded in merging',
      detail: parts.join(' '),
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
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));

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
 * Measure the context lazy injects into a builder and into a task agent.
 *
 * Report-only, and never a failure: none of it is truncated or blocked, and a
 * project is entitled to a big CLAUDE.md. The point is that the numbers exist
 * somewhere a human already looks, instead of only on the agent's own
 * `/context` screen after a session has started behaving oddly.
 *
 * Returns null when there is nothing to measure against (no runner, or the
 * store is locked) — the section is then skipped rather than half-printed.
 */
async function collectContextBudget(
  root: string,
  config: ResolvedConfig,
  runner: Runner,
): Promise<ContextBudgetReport | null> {
  try {
    return await withSweepStorage(root, storage =>
      measureContextBudget({
        lazyRoot: root,
        config,
        storage,
        runner,
        home: getHome(),
      }),
    );
  } catch (err) {
    // Same rule as the checks above: a diagnostics hiccup is reported, not
    // swallowed, and never becomes a health failure.
    return { roles: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Right-align a number in a fixed column so the lines read as a table. */
function padNumber(value: string, width: number): string {
  return value.padStart(width);
}

/** A context window the way the harness's own `/context` screen spells it. */
function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`;
}

/** Print one role's block of the context budget section. */
function printContextBudgetRole(role: RoleContextBudget): void {
  const title = role.role === 'builder' ? 'Builder session' : 'Task agent session';
  console.log(`  ${theme.header(title)}`);

  // "≥" not "≈": the offline tokenizer's error is documented as one-directional
  // (it undercounts Claude), so these are bounds, not estimates. The character
  // column is exact and is the one to act on.
  const marker = role.method === 'bpe' ? '≥' : '~';
  const widths = role.contributors.reduce(
    (max, c) => ({
      tokens: Math.max(max.tokens, `${marker}${c.tokens.toLocaleString('en-US')}`.length),
      chars: Math.max(max.chars, `${c.chars.toLocaleString('en-US')}`.length),
    }),
    { tokens: 0, chars: 0 },
  );

  for (const c of role.contributors) {
    const tokens = padNumber(`${marker}${c.tokens.toLocaleString('en-US')}`, widths.tokens);
    const chars = padNumber(c.chars.toLocaleString('en-US'), widths.chars);
    const indent = c.nested ? '      ' : '    ';
    console.log(`${indent}${tokens} tok  ${chars} chars  ${c.label}`);
    if (c.note) console.log(`${indent}  ${c.note}`);
    if (c.warning) console.log(theme.warning(`${indent}  ! ${c.warning}`));
    if (c.remedy) console.log(`${indent}    ${c.remedy}`);
  }

  const percent = Math.floor((role.totalTokens / role.windowTokens) * 100);
  const total =
    `${role.totalChars.toLocaleString('en-US')} chars, ${marker}${role.totalTokens.toLocaleString('en-US')} ` +
    `tokens before the first message (${marker}${percent}% of a ` +
    `${formatWindow(role.windowTokens)}-token window)`;
  console.log(`    ${role.overAdvisory ? theme.warning(total) : total}`);
  if (role.overAdvisory) {
    console.log(`      ${contextBudgetRemedy(role)}`);
  }

  // The denominator, said out loud. It is the one number here the human cannot
  // check anywhere else without opening the agent's own /context screen mid-
  // session, and it is not a constant: it depends on the model this role runs
  // and on whether its traffic reaches Anthropic's own API. When lazy is the
  // reason it is smaller than the model's maximum, `remedy` says so.
  const window = role.window;
  const suffix = window.known ? '' : ' (unverified)';
  console.log(`    Context window: ${formatWindow(window.tokens)} tokens — ${window.reason}${suffix}`);
  if (window.remedy) {
    console.log(theme.warning(`      ! ${window.remedy}`));
  }
}

/**
 * Print the context budget section.
 *
 * A dedicated section rather than a `CheckResult` because it is a table of
 * numbers, not a pass/fail: it prints the same lines whether or not anything is
 * over a threshold, so the human can see what a session costs and where the
 * cost sits before it becomes a problem.
 */
export function printContextBudget(report: ContextBudgetReport): void {
  console.log('');
  console.log(theme.header('Context budget (injected into every session, before the first message):'));

  if (report.error || report.roles.length === 0) {
    console.log(
      `  Could not measure: ${report.error ?? 'no roles measured'}`,
    );
    return;
  }

  for (const role of report.roles) printContextBudgetRole(role);

  console.log('');
  console.log(
    `  This is what lazy costs a session, plus the CLAUDE.md files the agent loads — not ` +
    `the agent's own system prompt and built-in tools, so it is smaller than its /context screen.`,
  );
  if (report.roles.every(role => role.method === 'bpe')) {
    // No source paths in this text: it is read by people using lazy on their
    // own project, for whom a pointer into lazy's own tree means nothing. The
    // provenance of the 15-20% figure lives next to the estimator itself.
    console.log(
      `  Character counts are exact. Token figures are a floor, not an estimate: they come from an ` +
      `offline tokenizer that undercounts Claude's own by roughly 15-20% on prose and more on code`,
    );
    console.log(
      `  (a documented bias, not measured against the real tokenizer — that needs an API credential). ` +
      `The real numbers are higher, so the advisory at a fifth of each role's window under-fires ` +
      `rather than over-fires.`,
    );
  } else {
    console.log(
      `  Character counts are exact. The offline tokenizer could not be loaded, so token figures ` +
      `fall back to the chars/4 heuristic and can land either side of the truth — read the ` +
      `character column, not the token one.`,
    );
  }
  console.log('  Nothing here is ever truncated.');
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
    ({ storage, ownsStorage } = await openDoctorStorage(root, sweepStorage));

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
 * - Not enrolled WHILE protection is on: gated accepts fail closed on this
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


export interface DoctorSweepResult {
  report: DoctorReport;
  results: CheckResult[];
  notes: string[];
}

export async function runDoctorReport(options: DoctorRunOptions): Promise<DoctorSweepResult> {
  sweepStorage = options.storage;
  sweepRoot = options.root;
  const notes: string[] = [];
  try {
  const results: CheckResult[] = [];

  // Always run these regardless of lazy root
  results.push(await checkGit());
  results.push(await checkGitHasCommits());
  results.push(await checkActorIdentity(options.root));

  // Checks that require a lazy root
  const root = options.root;
  let crashedTasks: CrashedTask[] = [];
  /** Measured during the sweep, printed as its own section after the checks. */
  let contextBudget: ContextBudgetReport | null = null;
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
    // Interactive half is the CLI's: it prints the failure, asks, and unlinks.
    // The daemon never passes a callback, so a wedged lock is reported and left.
    if (staleStorageLockPath) {
      await options.onStaleStorageLock?.(staleStorageLockPath, storageLockResult.detail);
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
      const classification = RUNNER_DIAGNOSTIC_CLASS;
      switch (check.state) {
        case 'ok':
          results.push({ ok: true, label: check.what, classification });
          break;
        case 'warn':
          results.push({ ok: true, label: check.what, warning: check.reason, classification });
          break;
        case 'fail':
          results.push({ ok: false, label: check.what, detail: check.reason, docs: 'agent-container', classification });
          break;
      }
    }
  }

  // Only container runners bind-mount the agent binary; in host-process mode the
  // supervisor IS lazy itself and no such file is involved.
  if (isContainerRunner) {
    results.push(await checkAgentBinary());
  }

  // Credentials are a CONFIG-DEPENDENT question: which credentials a project
  // needs comes from its agent profiles. With a config that will not parse the
  // check used to answer from the built-in defaults and, worse, quote the
  // loader's own refusal back — the whole role→profile migration paragraph,
  // printed a second time, under a credential heading. One failed check, one
  // cause, one remedy: say the config is stale in one line and stop.
  if (root && configError) {
    results.push({ ok: true, label: 'Credentials (skipped — lazy.toml is stale; fix it first)' });
  } else {
    results.push(...(await checkAuth(config ?? null)));
    // Presence is not validity: a stored session that will not parse passes
    // every check above and kills the turn that first presents it.
    if (root) results.push(...(await checkStoredCredentialsParse(root, config ?? null)));
  }

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
    notes.push(
      "Note: lazy.toml could not be parsed — every config-dependent check is skipped. " +
      "See the 'lazy.toml parses' result below.",
    );
  } else if (root) {
    results.push(await checkDataDir(root));
    results.push(await checkBuilderScratch(root));
    results.push(await checkDaemonStateFiles(root));

    // Only when a daemon is up AND both sides can answer — see the function.
    const codeCurrent = await checkDaemonCodeCurrent(root);
    if (codeCurrent) results.push(codeCurrent);

    results.push(await checkDaemonHealthSummary(root, options.daemonHealth));

    const dashboardAddress = await checkDashboardAddress(root, config!);
    if (dashboardAddress) results.push(dashboardAddress);

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

    // Deliberately OUTSIDE the runtime-healthy gate below: a lingering
    // adoption is most confusing precisely when image things are already
    // going wrong, so it must not be suppressed by a sick runtime.
    if (isContainerRunner) {
      const adoptedResult = await checkAdoptedImage(root);
      if (adoptedResult) results.push(adoptedResult);

      // Extra `docker run` args ([docker] run_args) are deliberately loud here:
      // they widen every task container's privileges, so anyone reading a
      // doctor sweep should see them without opening lazy.toml.
      const runArgs = config!.docker.run_args;
      if (runArgs.length > 0) {
        results.push({
          ok: true,
          label: 'Extra container run args ([docker] run_args)',
          warning: `${runArgs.join(' ')} — applied verbatim to every task container; these can widen its privileges`,
        });
      }
    }

    // Container-dependent checks (Docker or Podman) — only if runtime is healthy
    if (isContainerRunner && runnerDiagnosticsOk) {
      const imageName = await resolveImageName(root);
      results.push(await checkContainerImage(imageName, runnerType));
      results.push(await checkImageUpToDate(root, imageName, runnerType));
      // Passing `root` is what keeps the adopted and task-pinned images out of
      // the stale list; it reads tasks, so with the lock held it is skipped.
      results.push(
        lockBlocks
          ? skippedForLock('No stale runner images')
          : await checkStaleLazyImages(imageName, runnerType, root),
      );
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
      results.push(skippedForLock('No missing task runs'));
    } else if (runner) {
      try {
        crashedTasks = await findCrashedTasks(root, runner);
        if (crashedTasks.length === 0) {
          results.push({ ok: true, label: 'No missing task runs' });
        } else {
          const interrupted = crashedTasks.filter(c => c.taskStatus === 'interrupted');
          const other = crashedTasks.filter(c => c.taskStatus !== 'interrupted');
          const parts: string[] = [];
          if (interrupted.length > 0) {
            parts.push(`${interrupted.length} interrupted (resumable)`);
          }
          if (other.length > 0) {
            parts.push(`${other.length} with dead run`);
          }
          results.push({
            ok: false,
            label: 'No missing task runs',
            detail: `${crashedTasks.length} task(s) whose run is no longer there: ${parts.join(', ')}`,
          });
        }
      } catch (err) {
        // Say what could not be checked, rather than printing a green check for
        // a question that was never asked.
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          ok: true,
          label: 'No missing task runs (skipped — could not read task state)',
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
      results.push(skippedForLock('No worktrees left for finished tasks'));
      // The section reads shared memory through Storage, so it would queue on
      // the lock like everything else here. It says so rather than vanishing:
      // a section that is simply absent reads as "lazy injects nothing".
      contextBudget = { roles: [], error: `${heldLockSummary} — shared memory could not be read` };
    } else {
      results.push(await checkStrandedMerging(root));
      results.push(await checkReimportableConversations(root, join(root, config!.data.path)));
      results.push(await checkLocalCommandConversations(root));
      results.push(await checkImportableMemories(root, join(root, config!.data.path)));
      results.push(await checkMemoryContext(root, config!));
      // The memory check above owns the memory ADVISORY (threshold, compact
      // staleness, remedy); the section below shows what that memory costs
      // alongside everything else a launch injects, so the two are one surface
      // rather than two competing ones.
      // The builder's prompt embeds the runner's own instructions, so there is
      // no faithful measurement without a runner. Say which it is: with the
      // daemon down (the common case — createRunner fails loud on the proxy)
      // an absent section would read as "lazy injects nothing", on the one
      // command people run precisely when their setup is broken.
      // The reason itself is NOT repeated here — it is already printed in full
      // as the failed "Runner available" check above, and one message must not
      // appear at two layers.
      contextBudget = runner
        ? await collectContextBudget(root, config!, runner)
        : { roles: [], error: 'the runner is unavailable — see the "Runner available" check above' };
      results.push(await checkCredentialAccepted(join(root, config!.data.path)));
      results.push(await checkLegacyProxyAuditLog(root));
      results.push(await checkUsagePause(root, config!, options.offerUsagePauseOverride === true));
      results.push(await checkProtectedTasksResolvable(root, config!));
      results.push(await checkTerminalTaskWorktrees(root));
    }
    results.push(await checkDefaultBranchProtectionResolvable(root, config!));
    results.push(...(await checkPassphraseEnrollment(root, config!)));
    results.push(await checkTaskBranchUpstreamTracking(root));
    results.push(await checkLfsEnvironment(root, config));
    results.push(await checkDiskSpace(root));

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
    // Managed (fleet) hosts only — a strict no-op otherwise.
    results.push(...checkManagedConfig(rawConfig));

    // Feature flags status
    results.push(checkFeatureFlags(config!));
  } else {
    notes.push('Note: Not in a lazy project. Skipping project-specific checks.');
  }
    return {
      report: buildReport({
        root,
        checks: results.map(r => toStructuredCheck(r)),
        contextBudget,
        missingRuns: crashedTasks,
        staleStorageLockPath,
        configError,
        notes,
      }),
      results,
      notes,
    };
  } finally {
    sweepStorage = undefined;
    sweepRoot = null;
  }
}
