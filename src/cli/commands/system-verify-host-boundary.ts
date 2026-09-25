/**
 * `lazy system verify-host-boundary` — run the host file-tool boundary guard on
 * demand and report the verdict.
 *
 * This is the human surface for the check described in
 * src/runner/host-boundary-guard.ts: does `permissions.deny` still stop the
 * Read/Edit/Write tools under `--dangerously-skip-permissions`? The OS sandbox
 * does not cover those tools, so that upstream Claude Code behavior is the only
 * thing holding them back — and lazy does not control it.
 *
 * It probes the EXACT `--settings` posture this project would give a host agent,
 * so a verdict here is about the configuration actually in use, not a generic one.
 *
 * Exit codes mirror the probe, so this composes in scripts:
 *   0  intact (or, with --check, "this host can run the guard")
 *   1  VIOLATION — a deny rule was violated
 *   2  INCONCLUSIVE — no verdict reached (no auth, missing sandbox deps, a hang)
 */

import { writeFile } from 'fs/promises';
import { requireLazyRoot, parseFlags } from '../helpers';
import { loadConfig } from '../../config/loader';
import { theme } from '../../render/theme';
import {
  agentSettingsJson,
  boundaryCachePath,
  cacheBoundaryVerdict,
  detectClaudeVersion,
  readCachedVerdict,
  runBoundaryProbe,
  boundaryFingerprint,
  violationMessage,
} from '../../runner/host-boundary-guard';

export async function commandSystemVerifyHostBoundary(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'refresh', takesValue: false },
    { name: 'check', takesValue: false },
    { name: 'json', takesValue: true },
  ], 'system verify-host-boundary');

  const refresh = parsed.flags.get('refresh') === true;
  const checkOnly = parsed.flags.get('check') === true;
  const jsonPath = parsed.flags.get('json') as string | undefined;

  const root = requireLazyRoot();
  const config = await loadConfig(root);

  // Probe the posture this project's agents would actually get. `permission_mode
  // = "bypass"` has no file-tool boundary to verify by definition, so say that
  // rather than probing something meaningless.
  const settings = agentSettingsJson({
    mode: config.runner.permission_mode,
    allowedDomains: config.runner.sandbox_allowed_domains,
    allowWeakerNested: config.runner.sandbox_allow_weaker_nested,
    denyRead: config.runner.sandbox_deny_read,
    denyWrite: config.runner.sandbox_deny_write,
  });
  if (config.runner.permission_mode !== 'sandbox' || !settings) {
    console.error(
      `[runner] permission_mode = "${config.runner.permission_mode}" — there is no file-tool deny\n` +
      `boundary to verify in this posture. Set permission_mode = "sandbox" to get one.`,
    );
    process.exit(2);
  }

  const claudeVersion = await detectClaudeVersion();
  const fingerprint = claudeVersion
    ? boundaryFingerprint(claudeVersion, process.platform, settings)
    : null;

  if (!refresh && !checkOnly && fingerprint) {
    const cached = await readCachedVerdict(fingerprint);
    if (cached) {
      console.log(
        `Cached verdict for ${cached.claudeVersion} on ${cached.platform}, checked ${cached.checkedAt}.\n` +
        `Cache: ${boundaryCachePath()} — re-run with --refresh to probe again.`,
      );
      if (cached.verdict === 'violation') {
        console.error(`\n${theme.error('VIOLATION')} ${violationMessage(cached)}`);
        process.exit(1);
      }
      console.log(`${theme.success('intact')} — permissions.deny still governs the file tools.`);
      return;
    }
  }

  console.log(
    checkOnly
      ? 'Checking whether this host can run the boundary guard (1 real headless session)…'
      : 'Verifying the host file-tool deny boundary (3 real headless sessions, ~1-2 min)…',
  );
  console.log(`Claude Code: ${claudeVersion ?? 'unknown'}`);

  const result = await runBoundaryProbe({
    mode: checkOnly ? 'check' : 'guard',
    settingsJson: settings,
    claudeVersion,
  });

  if (jsonPath) {
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
    console.log(`Verdict written to ${jsonPath}`);
  }

  // A guard-mode verdict from here is the same measurement the preflight makes,
  // so it belongs in the same cache — that is what makes --refresh actually
  // REPLACE the stale entry, lets `lazy doctor` reflect a verdict obtained here,
  // and lets an operator pre-warm the cache before turning on
  // verify_sandbox_boundary. --check is excluded on purpose: it answers "can
  // this host run the guard", which is not a verdict about the boundary.
  // cacheBoundaryVerdict drops inconclusive results and never throws.
  if (!checkOnly && (await cacheBoundaryVerdict(result))) {
    console.log(`Verdict cached in ${boundaryCachePath()}.`);
  }

  if (result.verdict === 'violation') {
    console.error(`\n${theme.error('VIOLATION')} ${violationMessage(result)}`);
    process.exit(1);
  }
  if (result.verdict === 'inconclusive') {
    // Never dressed up as a pass: an inconclusive run means the question was not
    // answered, which is exactly the failure mode this whole guard exists to avoid.
    console.error(
      `\n${theme.warning('INCONCLUSIVE')} the guard reached no verdict, so the boundary is UNVERIFIED — not confirmed intact.\n` +
      `  ${result.reason || 'see the probe output above'}\n` +
      `A logged-in \`claude\`, jq, and a working OS sandbox (bubblewrap + socat on Linux) are all required.`,
    );
    process.exit(2);
  }
  console.log(
    checkOnly
      ? `\n${theme.success('RUNNABLE')} this host can run the guard. Re-run without --check for the verdict.`
      : `\n${theme.success('intact')} permissions.deny still governs the file tools under bypass on ${result.claudeVersion}.`,
  );
}

export function systemVerifyHostBoundaryUsage(): void {
  console.log(`Usage: lazy system verify-host-boundary [options]

Verify that Claude Code's permissions.deny rules still confine the Read/Edit/Write
FILE TOOLS for host agents. The OS sandbox only covers Bash — those deny rules are
the only thing holding the file tools back, and they are upstream behavior lazy
depends on but does not control. A Claude Code upgrade could regress them silently.

Probes the exact --settings posture this project gives its host agents, using real
headless sessions (~1-2 min, billed). Needs a logged-in \`claude\`, jq, and a working
OS sandbox.

Options:
  --refresh        Re-probe even when a cached verdict exists for this version
  --check          Only ask whether this host CAN run the guard (1 session)
  --json <path>    Also write the verdict as JSON to <path>

Exit codes:
  0  boundary intact (with --check: this host can run the guard)
  1  VIOLATION — a deny rule was violated; host agents are porous
  2  INCONCLUSIVE — no verdict reached (no auth, missing deps, or a hang)

Verdicts are cached per Claude Code version + platform + deny posture in
~/.lazy/host-boundary-guard.json. Inconclusive runs are never cached.

Set [runner] verify_sandbox_boundary = "once-per-version" in lazy.toml to have host
launches run this automatically and refuse to launch on a violation.

Examples:
  lazy system verify-host-boundary                 # verdict for this project's posture
  lazy system verify-host-boundary --check          # can this host run the guard at all?
  lazy system verify-host-boundary --refresh        # re-probe after a Claude Code upgrade`);
}
