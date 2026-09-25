/**
 * Runtime guard for the host file-tool boundary.
 *
 * WHAT THIS DEFENDS AGAINST
 * -------------------------
 * Under `permission_mode = "sandbox"` a headless host agent is confined by TWO
 * mechanisms (see host-sandbox.ts): the OS sandbox governs Bash, and
 * `permissions.deny` governs the Read/Edit/Write file tools, which bypass the OS
 * sandbox entirely. That second half is a Claude Code behavior lazy depends on
 * but does not control. If a CC upgrade stops honoring deny rules under
 * `--dangerously-skip-permissions`, nothing errors and nothing logs — every host
 * agent just quietly gains the ability to read ~/.ssh and write outside its
 * worktree. That is the exact failure mode this module makes loud.
 *
 * HOW
 * ---
 * By running the committed evidence script — `scripts/host-sandbox-probe.sh
 * --guard`, embedded here as text so it also works from the compiled binary —
 * against real headless sessions, and passing it the settings lazy ACTUALLY
 * emits (via `LAZY_PROBE_DENY_SETTINGS`). One script, one boundary definition:
 * a second TypeScript reimplementation of the same vectors would be free to
 * drift from the one CI runs.
 *
 * WHY IT IS OPT-IN, AND WHY THE DEFAULT IS "off"
 * ----------------------------------------------
 * The guard spends three real headless Claude sessions (~1-2 min, billed) and
 * needs an interactively logged-in `claude`. Paying that on every task launch
 * would be indefensible, and paying it on *first* launch still stalls a launch
 * for minutes on a machine that may have no interactive auth at all (a CI box, a
 * daemon started at boot). So `[runner] verify_sandbox_boundary` defaults to
 * `"off"`, and the standing signal is the CI workflow
 * (.github/workflows/host-sandbox-guard.yml) plus `lazy system
 * verify-host-boundary` on demand. `"once-per-version"` is for operators who
 * want the machine itself to refuse to launch agents on an unverified Claude
 * Code — it pays the cost once per (CC version + platform + posture) and caches
 * the verdict.
 *
 * VERDICTS ARE THREE-VALUED ON PURPOSE
 * ------------------------------------
 *   intact       → the boundary holds. Cached.
 *   violation    → a deny rule was violated. Cached, and launches REFUSE.
 *   inconclusive → the guard could not answer (no auth, sandbox would not start,
 *                  a session hung). NOT cached and NOT a pass; it warns loudly
 *                  and allows the launch.
 *
 * That last one is a deliberate, narrow exception to "fail hard". An
 * inconclusive result says nothing about the boundary — it says this machine
 * cannot run the probe. Refusing every launch on it would let a missing
 * interactive login brick an otherwise healthy daemon, and would do it in the
 * name of a check the operator only asked to be *informed* by. A violation is
 * different in kind: that is positive evidence of a broken boundary, and it
 * blocks.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import PROBE_SCRIPT from '../../scripts/host-sandbox-probe.sh' with { type: 'text' };
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { getHome } from '../utils/home';
import { buildAgentSandboxArgs, type HostPermissionConfig } from './host-sandbox';
import type { SandboxBoundaryVerification } from '../config/types';
import type { HealthCheck } from './types';

/** Three-valued verdict, mirroring the probe's exit codes 0 / 1 / 2. */
export type BoundaryVerdict = 'intact' | 'violation' | 'inconclusive';

export interface BoundaryGuardResult {
  verdict: BoundaryVerdict;
  /** Human-readable why, straight from the probe when it supplied one. */
  reason: string;
  /** `claude --version` output the verdict applies to. */
  claudeVersion: string;
  platform: string;
  /** Cache key: CC version + platform + the exact posture that was probed. */
  fingerprint: string;
  /** ISO timestamp of the run. */
  checkedAt: string;
}

interface CacheFile {
  /** Keyed by fingerprint. Only decisive verdicts are stored. */
  entries: Record<string, BoundaryGuardResult>;
}

/**
 * Machine-scoped, not project-scoped: the verdict is a property of this host's
 * Claude Code install, so two projects on one machine share it. Bounded by
 * {@link MAX_CACHE_ENTRIES} and disposable — losing it costs one re-run.
 */
export function boundaryCachePath(): string {
  return join(getHome(), '.lazy', 'host-boundary-guard.json');
}

const MAX_CACHE_ENTRIES = 20;

/**
 * The guard runs three headless sessions, each with a 90s alarm inside the
 * probe. 8 minutes leaves room for slow model responses without letting a wedged
 * probe hold a launch forever.
 */
const GUARD_TIMEOUT_MS = 8 * 60_000;
/** --check is a single session. */
const CHECK_TIMEOUT_MS = 3 * 60_000;

/**
 * The `--settings` JSON lazy passes to a headless agent under `cfg`. This is the
 * posture the guard probes, so the guard can never verify settings that differ
 * from the ones actually shipped.
 */
export function agentSettingsJson(cfg: HostPermissionConfig): string | null {
  const args = buildAgentSandboxArgs(cfg);
  const i = args.indexOf('--settings');
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

export function boundaryFingerprint(
  claudeVersion: string,
  platform: string,
  settingsJson: string,
): string {
  return createHash('sha256')
    .update(`${claudeVersion}\0${platform}\0${settingsJson}`)
    .digest('hex')
    .slice(0, 16);
}

/** `claude --version`, or null when it cannot be determined. */
export async function detectClaudeVersion(): Promise<string | null> {
  try {
    const proc = spawn(['claude', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const first = out.split('\n')[0]?.trim();
    return first ? first : null;
  } catch (err) {
    // Not fatal here: the caller downgrades to "cannot key the cache" and warns.
    // checkAvailability() already fails hard when the CLI is missing outright.
    logger.debug(`claude --version failed while fingerprinting the boundary guard: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function readCache(): Promise<CacheFile> {
  const path = boundaryCachePath();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as CacheFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
      throw new Error('missing an "entries" object');
    }
    return { entries: parsed.entries ?? {} };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { entries: {} };
    // A corrupt cache must not block launches — it holds nothing we can't
    // recompute — but the operator should know we discarded it.
    logger.warn(`Discarding unreadable host boundary guard cache at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return { entries: {} };
  }
}

/** The cached verdict for `fingerprint`, or null. */
export async function readCachedVerdict(fingerprint: string): Promise<BoundaryGuardResult | null> {
  const cache = await readCache();
  return cache.entries[fingerprint] ?? null;
}

/**
 * Persist a verdict, if it is one worth persisting.
 *
 * Two rules live here, in one place, so every caller (preflight and the CLI)
 * gets them identically:
 *
 *   - Inconclusive is never cached. It describes this machine's state right now
 *     (no auth, sandbox refused to start), not the Claude Code version, and a
 *     cached inconclusive would silence the guard on a host that simply cannot
 *     run it.
 *   - A cache that cannot be written is not a launch failure. The cache holds
 *     nothing that cannot be recomputed, so an unwritable one (EACCES, a
 *     read-only home, a full disk) costs a re-probe next time — the same stance
 *     readCache() already takes on a corrupt file. Warn and proceed.
 *
 * Returns whether the verdict was actually stored.
 */
export async function cacheBoundaryVerdict(result: BoundaryGuardResult): Promise<boolean> {
  if (result.verdict === 'inconclusive') return false;
  try {
    await writeCachedVerdict(result);
    return true;
  } catch (err) {
    logger.warn(
      `Could not write the host boundary guard cache at ${boundaryCachePath()}: ` +
      `${err instanceof Error ? err.message : String(err)}. The verdict (${result.verdict}) still ` +
      `stands for this run; it will simply be re-probed next time.`,
    );
    return false;
  }
}

async function writeCachedVerdict(result: BoundaryGuardResult): Promise<void> {
  const path = boundaryCachePath();
  const cache = await readCache();
  cache.entries[result.fingerprint] = result;
  // Bounded by construction: keep the newest N verdicts (one per CC version the
  // host has seen) so an upgrade treadmill cannot grow the file without limit.
  const keys = Object.keys(cache.entries).sort(
    (a, b) => Date.parse(cache.entries[b]!.checkedAt) - Date.parse(cache.entries[a]!.checkedAt),
  );
  const trimmed: Record<string, BoundaryGuardResult> = {};
  for (const k of keys.slice(0, MAX_CACHE_ENTRIES)) trimmed[k] = cache.entries[k]!;
  await mkdir(join(getHome(), '.lazy'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ entries: trimmed }, null, 2)}\n`, 'utf-8');
}

export interface BoundaryProbeOptions {
  mode: 'guard' | 'check';
  settingsJson: string;
  extraEnv?: Record<string, string>;
  claudeVersion?: string | null;
}

/**
 * The seam {@link ensureHostBoundaryVerified} probes through.
 *
 * It exists so the decision logic around the probe — what gets cached, what
 * refuses a launch, what the cache bound is — can be tested without three real
 * headless Claude sessions. Those are exactly the lines whose failure mode is
 * silence, so "holds by inspection" is not good enough for them.
 */
export type BoundaryProbeRunner = (opts: BoundaryProbeOptions) => Promise<BoundaryGuardResult>;

/**
 * Injection points for {@link ensureHostBoundaryVerified}. Production passes
 * nothing; both default to the real thing.
 *
 * `detectVersion` is a seam for the same reason `runProbe` is: without it, every
 * test of the decision logic would silently become a no-op on a machine with no
 * `claude` on PATH — the guard returns early there — and a test that quietly
 * stops testing is the failure mode this whole module exists to prevent.
 */
export interface BoundaryGuardSeams {
  runProbe?: BoundaryProbeRunner;
  detectVersion?: () => Promise<string | null>;
}

interface ProbeVerdictFile {
  verdict?: string;
  reason?: string;
  claude_version?: string;
}

/**
 * Run the embedded probe. `mode: 'check'` answers only "can this host run the
 * guard at all?" (one session); `mode: 'guard'` is the blocking boundary run.
 *
 * `extraEnv` carries the auth env vars the runner would give an agent, so the
 * probe's sessions authenticate the same way real turns do.
 */
export async function runBoundaryProbe(opts: BoundaryProbeOptions): Promise<BoundaryGuardResult> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-boundary-'));
  const scriptPath = join(dir, 'host-sandbox-probe.sh');
  const settingsPath = join(dir, 'settings.json');
  const verdictPath = join(dir, 'verdict.json');
  try {
    await writeFile(scriptPath, PROBE_SCRIPT, { encoding: 'utf-8', mode: 0o700 });
    await writeFile(settingsPath, settingsJson(opts.settingsJson), 'utf-8');

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...(opts.extraEnv ?? {}),
      HOME: getHome(),
      LAZY_PROBE_DENY_SETTINGS: settingsPath,
    };
    // The probe launches `claude` itself. If we inherited CLAUDECODE from a
    // session that is running lazy, those launches would look like nested
    // sessions rather than the fresh headless ones the runner performs.
    delete env.CLAUDECODE;

    const proc = spawn(
      ['bash', scriptPath, opts.mode === 'guard' ? '--guard' : '--check', '--json', verdictPath],
      {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: opts.mode === 'guard' ? GUARD_TIMEOUT_MS : CHECK_TIMEOUT_MS,
        env,
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    logger.debug(`host boundary probe (${opts.mode}) exited ${code}\n${stdout}\n${stderr}`);

    let fromFile: ProbeVerdictFile = {};
    try {
      fromFile = JSON.parse(await readFile(verdictPath, 'utf-8')) as ProbeVerdictFile;
    } catch {
      // The probe writes the verdict file best-effort; the exit code below is
      // authoritative either way, so a missing file only costs us the reason text.
      logger.debug('host boundary probe wrote no verdict file; classifying on exit code alone');
    }

    // Exit code is authoritative — a truncated or missing verdict file must never
    // turn a violation into a pass.
    const verdict: BoundaryVerdict =
      code === 0 ? 'intact' : code === 1 ? 'violation' : 'inconclusive';
    const reason =
      fromFile.reason?.trim() ||
      (verdict === 'intact'
        ? ''
        : lastMeaningfulLine(stderr) || lastMeaningfulLine(stdout) || `probe exited ${code}`);

    const claudeVersion = opts.claudeVersion ?? fromFile.claude_version ?? 'unknown';
    return {
      verdict,
      reason,
      claudeVersion,
      platform: process.platform,
      fingerprint: boundaryFingerprint(claudeVersion, process.platform, opts.settingsJson),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pass the settings through unchanged, but fail loudly if they are not JSON. */
function settingsJson(raw: string): string {
  try {
    JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to probe the host boundary with malformed settings JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return raw;
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '';
}

/** Message used both by the preflight refusal and by the CLI surface. */
export function violationMessage(result: BoundaryGuardResult): string {
  return (
    `Host file-tool boundary is BROKEN on ${result.claudeVersion} (${result.platform}).\n` +
    `  ${result.reason || 'a permissions.deny rule did not stop a file tool'}\n` +
    `A Read/Edit/Write tool escaped the permissions.deny rules lazy emits, so a host agent\n` +
    `under permission_mode = "sandbox" can read credential stores and write outside its\n` +
    `worktree — the OS sandbox does not cover the file tools.\n` +
    `Refusing to launch. Options:\n` +
    `  - run 'scripts/host-sandbox-probe.sh' for the full matrix and report the regression\n` +
    `  - pin or downgrade Claude Code to a version where the guard passes\n` +
    `  - switch to [runner] type = "docker" (container isolation does not rely on this)\n` +
    `  - set [runner] verify_sandbox_boundary = "off" to launch anyway (NOT recommended —\n` +
    `    the boundary is broken whether or not lazy checks for it)`
  );
}

/**
 * `lazy doctor` line for the file-tool half of the boundary. READ-ONLY: reports
 * the cached verdict and never spends three headless sessions of its own — doctor
 * is a diagnosis surface, not a place to silently bill the user for a probe.
 */
export async function diagnoseBoundaryVerdict(
  cfg: HostPermissionConfig,
  verification: SandboxBoundaryVerification,
): Promise<HealthCheck> {
  const what = 'File-tool deny boundary (permissions.deny)';
  const settings = agentSettingsJson(cfg);
  if (!settings) {
    return { state: 'warn', what, reason: 'no --settings posture is emitted for this mode; nothing to verify' };
  }
  const claudeVersion = await detectClaudeVersion();
  if (!claudeVersion) {
    return { state: 'warn', what, reason: 'cannot read `claude --version`, so no verdict can be looked up' };
  }
  const cached = await readCachedVerdict(boundaryFingerprint(claudeVersion, process.platform, settings));
  if (cached?.verdict === 'violation') {
    return {
      state: 'fail',
      what,
      reason:
        `a deny rule was VIOLATED on ${cached.claudeVersion} (checked ${cached.checkedAt})` +
        `${cached.reason ? `: ${cached.reason}` : ''} — host agents are porous on this Claude Code version. ` +
        `Run 'lazy system verify-host-boundary --refresh' after upgrading or downgrading Claude Code.`,
    };
  }
  if (cached?.verdict === 'intact') {
    return { state: 'ok', what: `${what}: verified intact on ${cached.claudeVersion} (${cached.checkedAt})` };
  }
  if (verification === 'off') {
    return {
      state: 'ok',
      what: `${what}: not verified on this host (verify_sandbox_boundary = "off")`,
      reason: `Run 'lazy system verify-host-boundary' to check it, or set [runner] verify_sandbox_boundary = "once-per-version" to check before launches.`,
    };
  }
  return {
    state: 'warn',
    what,
    reason: `no cached verdict for ${claudeVersion} yet — the next host launch will verify it (verify_sandbox_boundary = "${verification}")`,
  };
}

/** Thrown to refuse a launch when the boundary is provably broken. */
export class HostBoundaryBrokenError extends Error {
  constructor(readonly result: BoundaryGuardResult) {
    super(violationMessage(result));
    this.name = 'HostBoundaryBrokenError';
  }
}

// Single-flight per fingerprint: several tasks can enter checkAvailability() at
// once, and three headless sessions each is both slow and pointless.
const inFlight = new Map<string, Promise<BoundaryGuardResult>>();

/**
 * Preflight for host launches. Returns the verdict it acted on, or null when the
 * guard did not apply (bypass mode, verification off, or CC version unknown).
 *
 * Throws {@link HostBoundaryBrokenError} on a violation — cached or fresh.
 *
 * `seams` defaults to the real probe and the real version detector; only tests
 * pass anything.
 */
export async function ensureHostBoundaryVerified(
  cfg: HostPermissionConfig,
  verification: SandboxBoundaryVerification,
  extraEnv?: Record<string, string>,
  seams: BoundaryGuardSeams = {},
): Promise<BoundaryGuardResult | null> {
  const runProbe = seams.runProbe ?? runBoundaryProbe;
  const detectVersion = seams.detectVersion ?? detectClaudeVersion;
  if (verification === 'off') return null;
  // Nothing to verify under bypass: that mode has no file-tool boundary at all
  // (by definition), and the builder already warns about it at launch.
  if (cfg.mode !== 'sandbox') return null;

  const settings = agentSettingsJson(cfg);
  if (!settings) return null;

  const claudeVersion = await detectVersion();
  if (!claudeVersion) {
    logger.warn(
      'Cannot determine the Claude Code version, so the host file-tool boundary guard ' +
      '(verify_sandbox_boundary) was skipped — the boundary is UNVERIFIED on this launch.',
    );
    return null;
  }

  const fingerprint = boundaryFingerprint(claudeVersion, process.platform, settings);
  const cached = await readCachedVerdict(fingerprint);
  if (cached) {
    if (cached.verdict === 'violation') throw new HostBoundaryBrokenError(cached);
    logger.debug(`Host file-tool boundary verified ${cached.checkedAt} for ${claudeVersion} (cached).`);
    return cached;
  }

  const existing = inFlight.get(fingerprint);
  const run =
    existing ??
    (async () => {
      logger.info(
        `Verifying the host file-tool boundary on ${claudeVersion} — first launch on this ` +
        `Claude Code version and posture. Runs 3 real headless sessions (~1-2 min); the ` +
        `verdict is then cached per version.`,
      );
      const result = await runProbe({ mode: 'guard', settingsJson: settings, extraEnv, claudeVersion });
      const stored = await cacheBoundaryVerdict(result);
      if (result.verdict === 'intact') {
        // Only claim the caching that actually happened — cacheBoundaryVerdict
        // degrades to a warning when the cache cannot be written.
        logger.info(
          `Host file-tool boundary intact on ${claudeVersion}.` +
          (stored ? ' Verdict cached.' : ' Verdict NOT cached, so the next launch re-probes.'),
        );
      }
      return result;
    })();
  inFlight.set(fingerprint, run);
  try {
    const result = await run;
    if (result.verdict === 'violation') throw new HostBoundaryBrokenError(result);
    if (result.verdict === 'inconclusive') {
      logger.warn(
        `Host file-tool boundary UNVERIFIED on ${claudeVersion}: ${result.reason || 'the guard reached no verdict'}. ` +
        `Launching anyway — an inconclusive run is evidence about this machine (auth, sandbox deps), ` +
        `not about the boundary. Fix it and re-run 'lazy system verify-host-boundary'.`,
      );
      return result;
    }
    // The intact line is logged by the probing closure above, which is the only
    // place that knows whether the verdict actually reached the cache.
    return result;
  } finally {
    inFlight.delete(fingerprint);
  }
}
