/**
 * `lazy playground status` — what is provisioned, is it alive, and how to reach it.
 *
 * It mints a FRESH dashboard sign-in link every time, rather than echoing the
 * one `up` printed: those links work exactly once, so a status command that
 * repeated a spent one would hand every caller after the first a sign-in page
 * and no way to tell why.
 */

import { stat } from 'fs/promises';
import { demoPaths, readManifest, MANIFEST_VERSION, type DemoManifest, type DemoPaths } from './paths';
import {
  agentBinDir, demoEnv, lazyTry, resolveLazyInvocation, withDemoDaemonBase,
} from './runtime';
import { dirname, join } from 'path';
import { demoTeamsPaths, teamsEnv } from './teams';
import { readGuestVitals, runDemoFleet, type FleetManifest, type GuestVitals } from './fleet';

export interface DemoStatus {
  paths: DemoPaths;
  manifest: DemoManifest | null;
  /** Whether the demo daemon answered. */
  daemonRunning: boolean;
  /** Raw `lazy daemon status` output, for the CLI to show when something is wrong. */
  daemonDetail: string;
  /** A fresh one-time sign-in URL, or null when the daemon is down. */
  loginUrl: string | null;
  /** `lazy list --all` against the demo project. */
  taskTable: string | null;
  /** The fleet half, when this is a `--fleet` demo. */
  fleet: FleetStatus | null;
}

/** What `DemoFleet.status` reports, typed for the CLI to print. */
export interface FleetStatus {
  manifest: FleetManifest;
  lifecycle: string;
  daemonUrl: string | null;
  machine: string | null;
  daemonAnswers: boolean;
  daemonError: string | null;
  provisioningError: string | null;
  provisioningErrorDetail: string | null;
  task: { id: string; code: string; status: string } | null;
  services: { name: string; port: number; listening: boolean | null; address: string | null }[];
  servicesUnavailable: string | null;
  /** What the guest reports about itself (`cat /proc/uptime; free -m` via machine exec), or why it could not be asked. */
  guest: GuestVitals | null;
  guestError: string | null;
  /** The daemon's own log — a path on THIS Mac, because the daemon directory is a mount out of the machine. */
  daemonLogPath: string | null;
  /** Rails could not be asked at all; the manifest is all there is. */
  error: string | null;
  /** The Teams server, when `up` got as far as starting it. */
  teams: { url: string; email: string; password: string } | null;
}

export async function readDemoStatus(root?: string): Promise<DemoStatus> {
  const paths = demoPaths(root);
  const manifest = await readManifest(paths);

  if (manifest && manifest.version !== MANIFEST_VERSION) {
    // The advice here has to match what `down` will actually DO. It used to say
    // "tear it down rather than deleting the directory: lazy playground down" — but a
    // version mismatch is exactly what `manifestClaimsThisRoot` refuses, so that
    // command answers "it is not a lazy playground" and the user is sent in a circle.
    // Pointing someone at a recovery that cannot run is worse than saying there
    // is none.
    throw new Error(
      `The playground at ${paths.root} was created by a different version of \`lazy playground\` ` +
      `(manifest version ${manifest.version}, this lazy speaks ${MANIFEST_VERSION}).\n\n` +
      `This lazy will not manage it: \`lazy playground down\` refuses a manifest it does not ` +
      `recognise, because that check is what stops the command deleting directories that ` +
      `are not its own.\n\n` +
      `Tear it down with the lazy that created it, if you still have it. Otherwise stop ` +
      `its daemon and remove the directory yourself:\n` +
      `  LAZY_DAEMON_BASE_DIR=${paths.daemonBase} lazy daemon stop\n` +
      `  rm -rf ${paths.root}`,
    );
  }

  if (!manifest) {
    return {
      paths, manifest: null, daemonRunning: false,
      daemonDetail: '', loginUrl: null, taskTable: null, fleet: null,
    };
  }

  // A fleet demo has no daemon on this host: its daemon is inside the machine,
  // and everything worth saying about it comes back from Rails, which holds the
  // project's coordinates. The demo-mode readers below would only report a
  // daemon that was never started.
  if (manifest.fleet) {
    return {
      paths, manifest, daemonRunning: false, daemonDetail: '', loginUrl: null, taskTable: null,
      fleet: await readFleetStatus(manifest, paths),
    };
  }

  return await withDemoDaemonBase(paths.daemonBase, async () => {
    const lazyCmd = resolveLazyInvocation();
    const env = demoEnv({ paths });
    const opts = { cwd: paths.repo, env };

    // Every command below runs IN the demo project, so it has to exist. On a
    // demo whose `up` died before the fixture was created it does not — and
    // that is precisely the half-provisioned case `status` now promises to
    // describe, so throwing a raw "spawn failed: working directory does not
    // exist" would fail at the one job this path was added for. `down` already
    // guards the same way.
    if (!(await pathExists(paths.repo))) {
      return {
        paths, manifest, daemonRunning: false,
        daemonDetail:
          `The playground at ${paths.root} was never fully created — it has no project directory.\n` +
          `Remove it with: lazy playground down --root ${paths.root}`,
        loginUrl: null, taskTable: null, fleet: null,
      };
    }

    const daemon = await lazyTry(lazyCmd, ['daemon', 'status'], opts);
    const daemonDetail = (daemon.stdout + daemon.stderr).trim();
    const daemonRunning = daemon.code === 0 && /Daemon is running/i.test(daemonDetail);

    if (!daemonRunning) {
      return { paths, manifest, daemonRunning, daemonDetail, loginUrl: null, taskTable: null, fleet: null };
    }

    const login = await lazyTry(lazyCmd, ['dashboard', '--print'], opts);
    const loginUrl = login.code === 0
      ? (login.stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('http')) ?? null)
      : null;

    const list = await lazyTry(lazyCmd, ['list', '--all'], opts);
    const taskTable = list.code === 0 ? list.stdout.trimEnd() : null;

    return { paths, manifest, daemonRunning, daemonDetail, loginUrl, taskTable, fleet: null };
  });
}

/** Ask Rails (`DemoFleet.status`) about the fleet project; never throws. */
async function readFleetStatus(manifest: DemoManifest, paths: DemoPaths): Promise<FleetStatus> {
  const fleet = manifest.fleet!;
  const base: FleetStatus = {
    manifest: fleet, lifecycle: 'unknown', daemonUrl: fleet.daemonUrl, machine: fleet.machine,
    daemonAnswers: false, daemonError: null, provisioningError: null, provisioningErrorDetail: null,
    task: fleet.task ? { ...fleet.task, status: 'unknown' } : null, services: [], servicesUnavailable: null,
    guest: null, guestError: null, daemonLogPath: null,
    error: null,
    teams: manifest.teams ? { url: manifest.teams.url, email: manifest.teams.email, password: manifest.teams.password } : null,
  };
  try {
    const sourceRoot = dirname(dirname(manifest.lazyEntry));
    const { storageDir, fleetRoot } = demoTeamsPaths(paths.root);
    const env = teamsEnv({
      sourceRoot, storageDir, fleetRoot,
      mode: {
        kind: 'fleet',
        inputs: {
          backend: fleet.backend, smolvmBinary: fleet.smolvmBinary, daemonImage: fleet.daemonImage,
          repo: fleet.repo, servePort: fleet.servePort, memoryMib: fleet.memoryMib ?? null, model: fleet.model ?? null,
          credential: { kind: 'api_key', value: '', envVar: fleet.credentialEnvVar },
        },
        onProgress: async () => {},
      },
      home: process.env.HOME ?? paths.home,
    });
    const r = await runDemoFleet(join(sourceRoot, 'lazy-teams'), env, 'status',
      { LAZY_DEMO_FLEET_TASK_CODE: fleet.task?.code ?? '' }, 120_000);
    const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const task = r.task && typeof r.task === 'object'
      ? { id: String((r.task as Record<string, unknown>).id ?? ''), code: String((r.task as Record<string, unknown>).code ?? ''), status: String((r.task as Record<string, unknown>).status ?? 'unknown') }
      : null;
    const services = Array.isArray(r.services)
      ? (r.services as Record<string, unknown>[]).map(s => ({
        name: String(s.name ?? ''), port: Number(s.port ?? 0),
        listening: typeof s.listening === 'boolean' ? s.listening : null, address: str(s.address),
      }))
      : [];
    const machine = str(r.machine) ?? fleet.machine;
    // The guest's own numbers, from the Mac through machine exec — the one
    // measurement that says whether the memory budget holds.
    const guest = await readGuestVitals({ smolvmBinary: fleet.smolvmBinary, machine });
    return {
      ...base,
      guest: guest.vitals, guestError: guest.error,
      daemonLogPath: str(r.daemon_log),
      lifecycle: str(r.lifecycle) ?? 'unknown',
      daemonUrl: str(r.daemon_url) ?? fleet.daemonUrl,
      machine: str(r.machine) ?? fleet.machine,
      daemonAnswers: r.daemon_answers === true,
      daemonError: str(r.daemon_error),
      provisioningError: str(r.provisioning_error),
      provisioningErrorDetail: str(r.provisioning_error_detail),
      task, services, servicesUnavailable: str(r.services_unavailable),
    };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

/** Does this path exist? Absence is an answer here, never an error. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
