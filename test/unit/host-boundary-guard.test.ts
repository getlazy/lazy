/**
 * Unit tests for the host file-tool boundary guard.
 *
 * The subject here is the DECISION logic — what gets cached, what refuses a
 * launch, what is honestly reported as "we don't know". The probe itself needs
 * real headless Claude sessions and lives in CI
 * (.github/workflows/host-sandbox-guard.yml) plus
 * `lazy system verify-host-boundary`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import PROBE_SCRIPT from '../../scripts/host-sandbox-probe.sh' with { type: 'text' };
import {
  agentSettingsJson,
  boundaryFingerprint,
  boundaryCachePath,
  cacheBoundaryVerdict,
  readCachedVerdict,
  ensureHostBoundaryVerified,
  diagnoseBoundaryVerdict,
  violationMessage,
  HostBoundaryBrokenError,
  type BoundaryGuardResult,
  type BoundaryProbeOptions,
  type BoundaryProbeRunner,
} from '../../src/runner/host-boundary-guard';
import { buildAgentSandboxArgs, type HostPermissionConfig } from '../../src/runner/host-sandbox';

const SANDBOX: HostPermissionConfig = {
  mode: 'sandbox',
  allowedDomains: ['*.anthropic.com'],
  allowWeakerNested: false,
  denyRead: [],
  denyWrite: [],
};

function result(over: Partial<BoundaryGuardResult> = {}): BoundaryGuardResult {
  return {
    verdict: 'intact',
    reason: '',
    claudeVersion: '9.9.9 (Claude Code)',
    platform: process.platform,
    fingerprint: 'deadbeefdeadbeef',
    checkedAt: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

describe('host boundary guard — posture under test', () => {
  // INVARIANT: the guard must probe the settings lazy ACTUALLY emits. A second,
  // hand-maintained copy of the deny posture would be free to drift from the one
  // agents run under, and a guard that verifies the wrong posture is worse than
  // none — it reports confidence it has not earned.
  test('probes the exact --settings JSON buildAgentSandboxArgs emits', () => {
    const args = buildAgentSandboxArgs(SANDBOX);
    expect(agentSettingsJson(SANDBOX)).toBe(args[args.indexOf('--settings') + 1]);
  });

  test('deny rules are present in the probed posture', () => {
    const parsed = JSON.parse(agentSettingsJson(SANDBOX)!);
    expect(parsed.permissions.deny.length).toBeGreaterThan(0);
  });
});

describe('host boundary guard — fingerprint', () => {
  // The cached verdict is only meaningful for the exact combination it was
  // measured on: a Claude Code upgrade is precisely the event that can regress
  // the boundary, and a changed deny posture was never tested at all.
  test('changes with the Claude Code version', () => {
    const s = agentSettingsJson(SANDBOX)!;
    expect(boundaryFingerprint('1.0.0', 'linux', s)).not.toBe(boundaryFingerprint('1.0.1', 'linux', s));
  });

  test('changes with the platform', () => {
    const s = agentSettingsJson(SANDBOX)!;
    expect(boundaryFingerprint('1.0.0', 'linux', s)).not.toBe(boundaryFingerprint('1.0.0', 'darwin', s));
  });

  test('changes when the deny posture changes', () => {
    const a = agentSettingsJson(SANDBOX)!;
    const b = agentSettingsJson({ ...SANDBOX, denyRead: ['~/.kube'] })!;
    expect(boundaryFingerprint('1.0.0', 'linux', a)).not.toBe(boundaryFingerprint('1.0.0', 'linux', b));
  });

  test('is stable for the same inputs', () => {
    const s = agentSettingsJson(SANDBOX)!;
    expect(boundaryFingerprint('1.0.0', 'linux', s)).toBe(boundaryFingerprint('1.0.0', 'linux', s));
  });
});

describe('host boundary guard — cache and launch decisions', () => {
  let home: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-guard-home-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    await mkdir(join(home, '.lazy'), { recursive: true });
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
  });

  async function seed(entries: Record<string, BoundaryGuardResult>): Promise<void> {
    await writeFile(boundaryCachePath(), JSON.stringify({ entries }), 'utf-8');
  }

  test('the cache lives under ~/.lazy, machine-scoped', () => {
    // The verdict is a property of this host's Claude Code install, not of one
    // project, so it must not land in a repo's .lazy.
    expect(boundaryCachePath()).toBe(join(home, '.lazy', 'host-boundary-guard.json'));
  });

  test('reads back a seeded verdict', async () => {
    await seed({ abc: result({ fingerprint: 'abc' }) });
    expect((await readCachedVerdict('abc'))?.verdict).toBe('intact');
    expect(await readCachedVerdict('other')).toBeNull();
  });

  test('a missing cache file is not an error', async () => {
    await rm(boundaryCachePath(), { force: true });
    expect(await readCachedVerdict('abc')).toBeNull();
  });

  test('a corrupt cache file is discarded, not fatal', async () => {
    // It holds nothing that cannot be recomputed; blocking launches over it
    // would be a worse failure than re-probing.
    await writeFile(boundaryCachePath(), '{not json', 'utf-8');
    expect(await readCachedVerdict('abc')).toBeNull();
  });

  // INVARIANT: verify_sandbox_boundary = "off" must not spend a single session.
  // It is the default, and the default must not silently bill every user for
  // three headless Claude runs on their first host launch.
  test('does nothing when verification is off', async () => {
    expect(await ensureHostBoundaryVerified(SANDBOX, 'off')).toBeNull();
  });

  // INVARIANT: bypass mode has no file-tool boundary by definition, so there is
  // nothing to verify — running the probe there would produce a meaningless
  // verdict and imply protection that does not exist.
  test('does nothing under permission_mode = "bypass"', async () => {
    expect(await ensureHostBoundaryVerified({ ...SANDBOX, mode: 'bypass' }, 'once-per-version')).toBeNull();
  });

  test('a cached violation refuses the launch without re-probing', async () => {
    const claudeVersion = await currentClaudeVersion();
    if (!claudeVersion) return; // see the note in currentClaudeVersion()
    const fp = boundaryFingerprint(claudeVersion, process.platform, agentSettingsJson(SANDBOX)!);
    await seed({ [fp]: result({ fingerprint: fp, verdict: 'violation', claudeVersion, reason: 'Read(//~/.ssh) leaked' }) });

    // If this did NOT throw it would have started a real 3-session probe, so a
    // pass here also proves the cache short-circuit works.
    await expect(ensureHostBoundaryVerified(SANDBOX, 'once-per-version')).rejects.toThrow(HostBoundaryBrokenError);
  });

  test('a cached intact verdict allows the launch and is returned as-is', async () => {
    const claudeVersion = await currentClaudeVersion();
    if (!claudeVersion) return;
    const fp = boundaryFingerprint(claudeVersion, process.platform, agentSettingsJson(SANDBOX)!);
    await seed({ [fp]: result({ fingerprint: fp, claudeVersion }) });
    const got = await ensureHostBoundaryVerified(SANDBOX, 'once-per-version');
    expect(got?.verdict).toBe('intact');
    expect(got?.checkedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  test('a cached verdict for a DIFFERENT version does not answer for this one', async () => {
    // Otherwise an upgrade — the event most likely to break the boundary — would
    // inherit the old version's clean bill of health.
    await seed({ stale: result({ fingerprint: 'stale', verdict: 'violation', claudeVersion: '0.0.1' }) });
    // No throw: the stale entry is simply not a hit. (Verification then proceeds,
    // which we don't drive here — see the CI guard for the probe itself.)
    expect(await readCachedVerdict('stale')).not.toBeNull();
    const fp = boundaryFingerprint('1.2.3', process.platform, agentSettingsJson(SANDBOX)!);
    expect(await readCachedVerdict(fp)).toBeNull();
  });

  test('doctor reports a cached violation as a failure, read-only', async () => {
    const claudeVersion = await currentClaudeVersion();
    if (!claudeVersion) return;
    const fp = boundaryFingerprint(claudeVersion, process.platform, agentSettingsJson(SANDBOX)!);
    await seed({ [fp]: result({ fingerprint: fp, verdict: 'violation', claudeVersion, reason: 'escape written' }) });
    const check = await diagnoseBoundaryVerdict(SANDBOX, 'off');
    expect(check.state).toBe('fail');
    expect(check.reason).toContain('escape written');
    // Read-only: the cache is untouched by a diagnosis.
    expect(JSON.parse(await readFile(boundaryCachePath(), 'utf-8')).entries[fp].verdict).toBe('violation');
  });

  test('doctor does not claim verification when there is none', async () => {
    const check = await diagnoseBoundaryVerdict(SANDBOX, 'off');
    expect(check.state).not.toBe('fail');
    expect(`${check.what} ${check.reason ?? ''}`).toContain('verify-host-boundary');
    expect(check.what).not.toContain('verified intact');
  });
});

/**
 * The fresh-probe half of the decision logic, driven through the injected probe
 * seam. Everything here was previously true only by inspection — the probe needs
 * three real headless Claude sessions, so no test could reach the lines that
 * decide what gets written to the cache. Those are precisely the lines whose
 * failure mode is silence.
 */
describe('host boundary guard — fresh verdicts', () => {
  const VERSION = '9.9.9 (Claude Code)';
  let home: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-guard-fresh-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    await mkdir(join(home, '.lazy'), { recursive: true });
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
  });

  /** A probe that returns `verdict` and records that it ran. */
  function fakeProbe(verdict: BoundaryGuardResult['verdict'], calls: BoundaryProbeOptions[] = []): BoundaryProbeRunner {
    return async (opts) => {
      calls.push(opts);
      return result({
        verdict,
        reason: verdict === 'intact' ? '' : `synthetic ${verdict}`,
        claudeVersion: VERSION,
        fingerprint: boundaryFingerprint(VERSION, process.platform, opts.settingsJson),
        checkedAt: new Date().toISOString(),
      });
    };
  }

  const seams = (probe: BoundaryProbeRunner) => ({ runProbe: probe, detectVersion: async () => VERSION });

  async function entries(): Promise<Record<string, BoundaryGuardResult>> {
    return JSON.parse(await readFile(boundaryCachePath(), 'utf-8')).entries;
  }

  const fp = () => boundaryFingerprint(VERSION, process.platform, agentSettingsJson(SANDBOX)!);

  test('a fresh intact verdict is probed in guard mode and cached', async () => {
    const calls: BoundaryProbeOptions[] = [];
    const got = await ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(fakeProbe('intact', calls)));
    expect(got?.verdict).toBe('intact');
    // 'check' only answers "can this host run the guard" — it must never be what
    // a launch decision is made on.
    expect(calls.map((c) => c.mode)).toEqual(['guard']);
    // And the posture probed is the one the agent would actually get.
    expect(calls[0]!.settingsJson).toBe(agentSettingsJson(SANDBOX)!);
    expect((await entries())[fp()]!.verdict).toBe('intact');
  });

  // INVARIANT: an inconclusive run is NEVER cached. It describes this machine
  // (no auth, missing sandbox deps), not the Claude Code version — caching it
  // would silence the guard permanently on a host that merely cannot run it,
  // which is the exact "silently porous" outcome this module exists to prevent.
  test('an inconclusive verdict is never cached, and does not block the launch', async () => {
    const got = await ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(fakeProbe('inconclusive')));
    expect(got?.verdict).toBe('inconclusive');
    expect(await readCachedVerdict(fp())).toBeNull();
  });

  // INVARIANT: the refusal is on the VERDICT, not on the cache. A fresh
  // violation must block the very launch that discovered it.
  test('a fresh violation refuses the launch and is cached', async () => {
    await expect(
      ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(fakeProbe('violation'))),
    ).rejects.toThrow(HostBoundaryBrokenError);
    // Cached, so the next launch refuses without spending three more sessions —
    // and so `lazy doctor` can report it.
    expect((await entries())[fp()]!.verdict).toBe('violation');
  });

  test('the probe runs once per fingerprint, not once per launch', async () => {
    const calls: BoundaryProbeOptions[] = [];
    const probe = fakeProbe('intact', calls);
    await ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(probe));
    await ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(probe));
    expect(calls).toHaveLength(1);
  });

  test('concurrent launches share one probe (single-flight)', async () => {
    const calls: BoundaryProbeOptions[] = [];
    const probe = fakeProbe('intact', calls);
    const s = seams(probe);
    await Promise.all([
      ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, s),
      ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, s),
      ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, s),
    ]);
    expect(calls).toHaveLength(1);
  });

  // INVARIANT: an unwritable cache costs a re-probe, not a launch. Same stance
  // the module already takes on a corrupt cache — it holds nothing that cannot
  // be recomputed, so failing the launch over it would be the worse failure.
  test('an unwritable cache warns and lets the launch proceed', async () => {
    // A directory where the file belongs: writeFile fails for everyone, root
    // included, unlike a chmod-based EACCES.
    await rm(boundaryCachePath(), { force: true });
    await mkdir(boundaryCachePath(), { recursive: true });
    const got = await ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(fakeProbe('intact')));
    expect(got?.verdict).toBe('intact');
  });

  // ... but an unwritable cache must NOT turn a violation into a launch.
  test('a violation still refuses when the cache cannot be written', async () => {
    await rm(boundaryCachePath(), { force: true });
    await mkdir(boundaryCachePath(), { recursive: true });
    await expect(
      ensureHostBoundaryVerified(SANDBOX, 'once-per-version', undefined, seams(fakeProbe('violation'))),
    ).rejects.toThrow(HostBoundaryBrokenError);
  });

  test('cacheBoundaryVerdict reports whether it stored the verdict', async () => {
    expect(await cacheBoundaryVerdict(result({ verdict: 'inconclusive', fingerprint: 'x' }))).toBe(false);
    expect(await cacheBoundaryVerdict(result({ fingerprint: 'x' }))).toBe(true);
    expect((await entries())['x']!.verdict).toBe('intact');
  });

  // The cache is machine-scoped and long-lived, so it must be bounded by
  // construction — a Claude Code upgrade treadmill must not grow it forever.
  test('the cache keeps only the newest 20 verdicts', async () => {
    for (let i = 0; i < 25; i++) {
      await cacheBoundaryVerdict(result({
        fingerprint: `fp${i}`,
        // Ascending timestamps: the highest i is the newest.
        checkedAt: new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 60_000).toISOString(),
      }));
    }
    const kept = await entries();
    expect(Object.keys(kept)).toHaveLength(20);
    expect(kept['fp24']).toBeDefined();  // newest kept
    expect(kept['fp4']).toBeUndefined(); // oldest evicted
    expect(kept['fp5']).toBeDefined();   // 25 - 20 = first survivor
  });
});

describe('host boundary guard — refusal message', () => {
  test('names the version, the consequence, and the ways out', () => {
    const msg = violationMessage(result({ verdict: 'violation', reason: 'Read(//~/.ssh) leaked' }));
    expect(msg).toContain('9.9.9 (Claude Code)');
    expect(msg).toContain('Read(//~/.ssh) leaked');
    // An actionable error names what the user can do, not just what broke.
    expect(msg).toContain('docker');
    expect(msg).toContain('verify_sandbox_boundary');
  });

  test('HostBoundaryBrokenError carries the verdict it refused on', () => {
    const r = result({ verdict: 'violation' });
    const err = new HostBoundaryBrokenError(r);
    expect(err.result).toBe(r);
    expect(err.message).toContain('BROKEN');
  });
});

describe('host boundary guard — embedded probe', () => {
  // INVARIANT: the binary must carry the SAME script CI runs. A TypeScript
  // reimplementation of the vectors could pass while the real boundary is broken.
  test('the embedded script is the committed probe, with the guard contract intact', async () => {
    const onDisk = await readFile(join(import.meta.dir, '../../scripts/host-sandbox-probe.sh'), 'utf-8');
    expect(PROBE_SCRIPT).toBe(onDisk);
    expect(PROBE_SCRIPT).toContain('--guard');
    expect(PROBE_SCRIPT).toContain('LAZY_PROBE_DENY_SETTINGS');
    // The exit-code contract the TS side classifies on.
    expect(PROBE_SCRIPT).toContain('exit 1');
    expect(PROBE_SCRIPT).toContain('exit 2');
  });
});

describe('host boundary guard — CI workflow honesty', () => {
  // The CI job is the standing signal, and its whole value rests on two things:
  // it re-exits the probe's code (so a violation is red), and it never presents
  // a run that could not check as a run that checked. Both are one careless edit
  // away from silently inverting, so they are asserted here.
  let workflow: string;

  beforeEach(async () => {
    workflow = await readFile(join(import.meta.dir, '../../.github/workflows/host-sandbox-guard.yml'), 'utf-8');
  });

  test('runs the committed probe in guard mode and propagates its exit code', () => {
    expect(workflow).toContain('scripts/host-sandbox-probe.sh --guard');
    expect(workflow).toContain('exit "$RC"');
  });

  test('errexit is disabled where the probe is classified', () => {
    // GitHub runs `run:` under `bash -e`, so a bare `set -uo pipefail` would abort
    // the step on the probe's meaningful non-zero exit before it is classified.
    expect(workflow).not.toMatch(/set -uo pipefail\n\s*(if )?.*host-sandbox-probe/);
    expect(workflow).toContain('set +e -uo pipefail');
  });

  test('a run that could not check says so instead of passing quietly', () => {
    expect(workflow).toContain('SKIPPED');
    expect(workflow).toContain('NOT verified');
    expect(workflow).toContain('::warning');
  });

  test('a scheduled run with no credential is an error, not a skip', () => {
    // The schedule IS the standing signal; a permanently skipping schedule is a
    // guard that has quietly stopped guarding.
    expect(workflow).toMatch(/github\.event_name }}" = "schedule"/);
    expect(workflow).toContain('::error title=Boundary guard cannot run');
  });

  test('an inconclusive guard run is reported as unverified, never as a pass', () => {
    expect(workflow).toContain('Boundary guard INCONCLUSIVE');
    expect(workflow).toContain('This is not a pass');
  });
});

/**
 * The real `claude --version`, or null when the CLI is absent.
 *
 * A few cases need the fingerprint the production code will compute, and that
 * reads the installed version. Rather than inject a seam that only tests use, we
 * ask for the same value — and skip (returning null) where there is no CLI. The
 * skip prints, so it can never be silently green.
 */
async function currentClaudeVersion(): Promise<string | null> {
  const { detectClaudeVersion } = await import('../../src/runner/host-boundary-guard');
  const v = await detectClaudeVersion();
  if (!v) console.log('skipped: no `claude` CLI on PATH, so the real fingerprint cannot be computed');
  return v;
}
