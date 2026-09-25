/**
 * `lazy playground up --teams --fleet smolvm` — the demo as the end-to-end proof for a
 * REAL fleet backend.
 *
 * The ordinary `--teams` demo arms the app's DEMO MODE: managed mode off, the
 * host-process runner, a fake credential, a `file://` repository — everything a
 * machine with no Docker and no hypervisor needs to show tasks moving. A fleet
 * demo is the opposite on every one of those axes, so it shares the demo's
 * plumbing (one root, one teardown, one manifest, Rails' data under the root)
 * and none of its shortcuts:
 *
 *  - DEMO MODE stays OFF and the real `SmolvmSupervisor` is selected, through
 *    the same `LAZY_FLEET_BACKEND` the app reads everywhere else.
 *  - The project is the PUBLIC repository the human names (`--repo`), cloned
 *    by the guest. The guest only reaches public IP space (`PublicEgress`) and
 *    carries no credentials, so the URL has to be fetchable anonymously — checked
 *    from the Mac before anything else. Whether origin is writable is nobody's
 *    concern: the demo clones and adopts, and the daemon's branch pushes into an
 *    origin it cannot write to are a warning in its log, never a failure.
 *  - The seeded account gets the human's REAL Claude credential, read from the
 *    place lazy itself reads one — the shell — and never invented. Absent, the
 *    command refuses and says exactly where to paste one.
 *  - There is no host-side demo daemon, no stand-in agent and no seeded UI
 *    states: the one task is real, and its first turn builds `lazy-runner`
 *    inside the guest and runs a real agent on the human's own account.
 *
 * Everything with a decision in it is a pure function here so the unit suite
 * can exercise it; the Rails half is `lazy-teams/app/models/demo_fleet.rb`,
 * driven verb by verb through `bin/rails runner`.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveServicePorts } from '../serve/ports';
import { allowlistedEnv, run } from './runtime';
import { tmpdir as osTmpdir } from 'os';

export const FLEET_BACKENDS = ['smolvm'] as const;
export type FleetBackend = (typeof FLEET_BACKENDS)[number];

/** The variable the Rails app selects its fleet backend from. */
export const FLEET_BACKEND_ENV = 'LAZY_FLEET_BACKEND';
/** What the smolvm backend needs from the human's shell. */
export const SMOLVM_BINARY_ENV = 'LAZY_SMOLVM_BINARY';
export const DAEMON_IMAGE_ENV = 'LAZY_DAEMON_IMAGE';
/**
 * The machine's memory budget, in MiB. `SmolvmSupervisor` reads this variable
 * at create time; its own default (`DEFAULT_MEMORY_MIB` in
 * lazy-teams/app/clients/smolvm_supervisor.rb) is repeated here so the demo
 * can SAY what a machine got without asking Rails, and a unit test keeps the
 * two numbers equal. Whether 4 GiB is enough for the daemon, dockerd, the
 * runner-image build and one agent container is a MEASUREMENT `lazy playground
 * status` now takes (`free -m` inside the guest); the default is not raised
 * without one.
 */
export const MEMORY_MIB_ENV = 'LAZY_SMOLVM_MEMORY_MIB';
export const DEFAULT_MACHINE_MEMORY_MIB = 4096;
/** Below this a turn cannot run at all (the supervisor's own note: a 2 GiB machine is used up by one turn). */
export const MIN_MACHINE_MEMORY_MIB = 2048;
/** What `SmolvmSupervisor` sets on every smolvm invocation; repeated here so the operator's shell agrees. */
export const SMOLVM_FIXED_ENV = { SMOLVM_EGRESS_FLOOR: 'strict', SMOLVM_PUBLISH_ADDR: '127.0.0.1' } as const;

/**
 * Which backend the demo runs on, from the flag — and only the flag.
 *
 * `--fleet` is the source of truth. `LAZY_FLEET_BACKEND` in the surrounding
 * shell is not read as an instruction, because the demo's whole promise is
 * that its behaviour follows what was typed, not what the shell happened to
 * export; but it is not ignored either — a shell that says one thing while the
 * flag says another is refused, and a shell that names a backend with no flag
 * is refused too, so nobody runs a demo-mode demo believing it hit the fleet.
 */
export function resolveFleetBackend(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FleetBackend | null {
  const ambient = env[FLEET_BACKEND_ENV]?.trim();
  if (flag === undefined) {
    if (ambient) {
      throw new Error(
        `${FLEET_BACKEND_ENV}=${ambient} is set in this shell, but \`lazy playground\` does not read it — ` +
        `the backend is chosen by the flag. Pass \`--fleet ${ambient}\` to run the playground on it, ` +
        `or unset the variable to run the ordinary playground.`,
      );
    }
    return null;
  }
  if (!(FLEET_BACKENDS as readonly string[]).includes(flag)) {
    throw new Error(`--fleet ${flag} is not a fleet backend the playground can run on (one of: ${FLEET_BACKENDS.join(', ')}).`);
  }
  if (ambient && ambient !== flag) {
    throw new Error(
      `--fleet ${flag} disagrees with ${FLEET_BACKEND_ENV}=${ambient} in this shell. ` +
      `Unset the variable or pass the same backend; the playground will not guess which one you meant.`,
    );
  }
  return flag as FleetBackend;
}

/** The credential kinds `ClaudeCredential` stores, keyed by the env var lazy reads each from. */
const CREDENTIAL_SOURCES = [
  { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'oauth_token' },
  { envVar: 'ANTHROPIC_API_KEY', kind: 'api_key' },
] as const;

export interface FleetCredential {
  /** `ClaudeCredential#kind` in the Rails app. */
  kind: 'oauth_token' | 'api_key';
  value: string;
  /** Which variable it came from — printed, so the human knows what was used. */
  envVar: string;
}

/**
 * The human's own Claude credential, from where lazy reads one on this
 * machine: the shell (`CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` —
 * the same order and the same variables as `credentialFromEnv` in
 * src/daemon/credential-gate.ts). Never a stored file, never a fake.
 */
export function resolveFleetCredential(env: NodeJS.ProcessEnv = process.env): FleetCredential | null {
  for (const source of CREDENTIAL_SOURCES) {
    const value = env[source.envVar]?.trim();
    if (value) return { kind: source.kind, value, envVar: source.envVar };
  }
  return null;
}

/** The refusal when no credential is in the shell: where to get one and where else it can go. */
export function missingCredentialMessage(teamsUrlHint = 'http://127.0.0.1:<teams port>'): string {
  return (
    'lazy playground up --fleet needs YOUR Claude credential in this shell: the project\'s first turn runs a ' +
    'real agent on your account inside the guest, and the playground will not invent one.\n\n' +
    'On the host, in the shell you run the playground from, either\n' +
    '  export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"      # an OAuth setup-token\n' +
    'or\n' +
    '  export ANTHROPIC_API_KEY=<your key>                          # an API key\n\n' +
    `and run it again. (The equivalent by hand, once Teams is up, is ${teamsUrlHint}/settings/claude — ` +
    'but provisioning needs the credential before the server exists, so the shell is the way in here.)'
  );
}

export interface FleetInputs {
  backend: FleetBackend;
  smolvmBinary: string;
  daemonImage: string;
  /** The public repository the guest clones and the demo adopts as its project. */
  repo: string;
  /**
   * The first `[serve]` port the repository's committed lazy.toml declares, or
   * null when it declares none. Decides which task the demo seeds: a detached
   * server on that port (whose address `status` then prints), or a plain one.
   */
  servePort: number | null;
  credential: FleetCredential;
  /** The machine's memory budget in MiB, or null for the supervisor's default ({@link DEFAULT_MACHINE_MEMORY_MIB}). */
  memoryMib: number | null;
  /** The model the seeded task runs on (`--model`, a tier alias such as `haiku` or a model id); null for the daemon's default. */
  model: string | null;
}

/**
 * The memory budget the human asked for: `--memory` first, then the shell's
 * `LAZY_SMOLVM_MEMORY_MIB` (the variable Rails reads, so the runbook's export
 * and the flag agree), else null for the supervisor's default. Refused by
 * name when it is not a whole number of MiB or too small to run a turn.
 */
export function resolveMachineMemoryMib(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const fromFlag = flag?.trim();
  const fromEnv = env[MEMORY_MIB_ENV]?.trim();
  const raw = fromFlag || fromEnv;
  if (!raw) return null;
  const source = fromFlag ? '--memory' : MEMORY_MIB_ENV;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${source} must be a whole number of MiB (got ${JSON.stringify(raw)}); e.g. --memory 6144 for a 6 GiB machine.`);
  }
  const mib = Number(raw);
  if (mib < MIN_MACHINE_MEMORY_MIB) {
    throw new Error(
      `${source} is ${mib} MiB, below the ${MIN_MACHINE_MEMORY_MIB} MiB a single turn uses up; ` +
      `the default is ${DEFAULT_MACHINE_MEMORY_MIB} MiB and \`lazy playground status\` shows how much of it the guest uses.`,
    );
  }
  return mib;
}

/**
 * Everything the fleet demo needs from the human, checked before anything is
 * torn down or created. Each refusal names the variable or flag and what it
 * is for, because the alternative is a supervisor error several processes
 * away.
 */
export function resolveFleetInputs(opts: {
  backend: FleetBackend;
  repo: string | undefined;
  /** Learned from the repository by {@link readRepoServePort}; null until then. */
  servePort?: number | null;
  /** `--memory <MiB>`; see {@link resolveMachineMemoryMib}. */
  memory?: string;
  /** `--model`: what the seeded task runs on; a real turn spends real tokens, so a cheap tier is a reasonable test. */
  model?: string;
  env?: NodeJS.ProcessEnv;
}): FleetInputs {
  const env = opts.env ?? process.env;
  const memoryMib = resolveMachineMemoryMib(opts.memory, env);
  const smolvmBinary = env[SMOLVM_BINARY_ENV]?.trim();
  if (!smolvmBinary) {
    throw new Error(
      `${SMOLVM_BINARY_ENV} is not set. The smolvm backend runs only the vendored, digest-verified launcher; ` +
      `\`cd lazy-teams && bin/vendor-smolvm\` prints the absolute path to export.`,
    );
  }
  const daemonImage = env[DAEMON_IMAGE_ENV]?.trim();
  if (!daemonImage) {
    throw new Error(
      `${DAEMON_IMAGE_ENV} is not set. It names the image the project's microVM boots — build it with ` +
      `\`scripts/publish-lazy-daemon-image.sh --platform linux/arm64 --save /tmp/lazy-daemon.tar\` ` +
      `and export the tar's path.`,
    );
  }
  const repo = opts.repo?.trim();
  if (!repo || !/^https?:\/\/\S+$/.test(repo)) {
    throw new Error(
      '--repo <public git url> is required with --fleet: the project is that repository, cloned by the ' +
      'guest. The guest reaches only public IP space and carries no credentials, so it must be an ' +
      'http(s) URL anybody can fetch — not a file:// path, not a repository served from this machine, ' +
      'not a private one.',
    );
  }
  const credential = resolveFleetCredential(env);
  if (!credential) throw new Error(missingCredentialMessage());
  const model = opts.model?.trim() || null;
  if (model !== null && !/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new Error(`--model must be a tier alias (haiku, sonnet, opus) or a model id; got ${JSON.stringify(model)}.`);
  }
  return { backend: opts.backend, smolvmBinary, daemonImage, repo, servePort: opts.servePort ?? null, credential, memoryMib, model };
}

/**
 * git with no way to ask for or find a credential — what the guest has.
 *
 * The demo's allowlist (no HOME, so no `~/.gitconfig` and none of the
 * credential helpers in it), the global config pointed at nothing in case a
 * platform git looks it up anyway, prompts off, and an askpass that answers
 * nothing — so a private repository fails at once instead of hanging on a
 * prompt or quietly succeeding through the Mac's keychain, which would make
 * the demo claim a URL the guest cannot clone.
 */
function anonymousGitEnv(): Record<string, string> {
  return {
    ...allowlistedEnv(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/true',
  };
}
const ANONYMOUS_GIT = ['git', '-c', 'credential.helper='];

/**
 * Refuse a repository the guest could not clone, from the Mac, before anything
 * is torn down or created: `git ls-remote` with every credential source turned
 * off. Returns the default branch when it can be read (for the shallow read
 * below); null when the remote answered but named none.
 */
export async function assertRepoPubliclyFetchable(repo: string): Promise<string | null> {
  const result = await run([...ANONYMOUS_GIT, 'ls-remote', '--symref', repo, 'HEAD'],
    { cwd: tmpdir(), env: anonymousGitEnv(), timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(
      `--repo ${repo} cannot be fetched without credentials, and the guest has none: it clones over ` +
      `public egress only, so a private repository, a wrong URL or a host it cannot reach all fail the ` +
      `same way inside the machine. git said:\n${indentLines(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`)}\n` +
      'Use a public repository (or make this one public).',
    );
  }
  const symref = result.stdout.split('\n').find(l => l.startsWith('ref: refs/heads/'));
  return symref ? symref.slice('ref: '.length).split('\t')[0]!.replace(/^refs\/heads\//, '') : null;
}

/**
 * The first `[serve]` port the repository's committed lazy.toml declares, or
 * null. Read from a throwaway shallow clone on the Mac (no checkout, one
 * commit, the same anonymous git as the check above), because the config that
 * matters is the one the GUEST will see — the project root's — and nothing the
 * demo writes after the fact can reach it.
 */
export async function readRepoServePort(repo: string, branch: string | null, report: (m: string) => void): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-demo-repo-peek-'));
  try {
    const clone = await run([
      ...ANONYMOUS_GIT, 'clone', '--quiet', '--depth', '1', '--no-checkout', '--single-branch',
      ...(branch ? ['--branch', branch] : []), repo, dir,
    ], { cwd: tmpdir(), env: anonymousGitEnv(), timeoutMs: 300_000 });
    if (clone.code !== 0) {
      throw new Error(`could not read ${repo} to look for a [serve] port:\n${indentLines(clone.stderr.trim())}`);
    }
    const show = await run(['git', 'show', 'HEAD:lazy.toml'], { cwd: dir, env: anonymousGitEnv(), timeoutMs: 30_000 });
    if (show.code !== 0) {
      report('the repository commits no lazy.toml — the seeded task will be a plain one, with no served port');
      return null;
    }
    const port = servePortFromToml(show.stdout);
    report(port === null
      ? 'the repository\'s lazy.toml declares no [serve] port — the seeded task will be a plain one'
      : `the repository's lazy.toml serves on port ${port} — the seeded task starts a server there`);
    return port;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The first declared `[serve]` port in a lazy.toml, or null — same reading as
 * lazy's own (`resolveServicePorts`), so the demo cannot disagree with the
 * daemon about what the project serves. A file that does not parse, or a
 * `[serve]` section lazy would refuse, reads as "no port": the daemon will say
 * so itself, loudly, when it loads the config.
 */
export function servePortFromToml(text: string): number | null {
  try {
    const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
    const serve = parsed.serve;
    if (!serve || typeof serve !== 'object') return null;
    const ports = resolveServicePorts(serve as { ports?: unknown; services?: unknown });
    return ports[0]?.port ?? null;
  } catch {
    return null;
  }
}

function indentLines(text: string): string {
  return text.split('\n').map(l => `  ${l}`).join('\n');
}

/**
 * What the Teams process (and every `bin/rails runner` the demo drives) gets
 * on top of the demo's allowlisted environment, to run the real backend.
 *
 * Exactly the variables the runbook names, plus the fleet root under the demo
 * root. No demo-mode switch, no stand-in agent, no fake credential — a test
 * asserts every one of those is absent, because their presence would silently
 * turn this back into the demo it is not.
 */
export function fleetTeamsEnv(inputs: Pick<FleetInputs, 'backend' | 'smolvmBinary' | 'daemonImage' | 'memoryMib'>, fleetRoot: string): Record<string, string> {
  return {
    [FLEET_BACKEND_ENV]: inputs.backend,
    [SMOLVM_BINARY_ENV]: inputs.smolvmBinary,
    [DAEMON_IMAGE_ENV]: inputs.daemonImage,
    ...SMOLVM_FIXED_ENV,
    LAZY_FLEET_ROOT: fleetRoot,
    // Both the runner verbs (which create the machine) and the server (whose
    // reconciler recreates one that is gone) read it, so it rides the one
    // environment they share. Absent means the supervisor's default.
    ...(inputs.memoryMib === null ? {} : { [MEMORY_MIB_ENV]: String(inputs.memoryMib) }),
  };
}

/** What the guest itself reports about its uptime and memory, from `cat /proc/uptime; free -m`. */
export interface GuestVitals {
  uptimeSeconds: number;
  memTotalMib: number;
  memUsedMib: number;
  /** `free -m`'s "available" column; null on a `free` that does not print it. */
  memAvailableMib: number | null;
}

/** The one guest command `status` runs for the vitals; exported so the runbook and the test quote the same thing. */
export const GUEST_VITALS_SCRIPT = 'cat /proc/uptime; free -m';

/** Parse the output of {@link GUEST_VITALS_SCRIPT}. Throws when it is not that output. */
export function parseGuestVitals(stdout: string): GuestVitals {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const uptime = lines.find(l => /^\d+(\.\d+)?\s+\d+(\.\d+)?$/.test(l));
  const mem = lines.find(l => /^Mem:\s/.test(l));
  if (!uptime || !mem) throw new Error(`not the output of \`${GUEST_VITALS_SCRIPT}\`:\n${stdout.trim()}`);
  const cols = mem.split(/\s+/).slice(1).map(Number);
  return {
    uptimeSeconds: Math.floor(Number(uptime.split(/\s+/)[0])),
    memTotalMib: cols[0]!,
    memUsedMib: cols[1]!,
    memAvailableMib: cols.length >= 6 && Number.isFinite(cols[5]) ? cols[5]! : null,
  };
}

/** `up 14m 3s — memory 238 of 3941 MiB used, 3703 available (budget 4096 MiB)`. */
export function formatGuestVitals(v: GuestVitals, budgetMib: number | null): string {
  const s = v.uptimeSeconds;
  const up = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const avail = v.memAvailableMib === null ? '' : `, ${v.memAvailableMib} available`;
  return `up ${up} — memory ${v.memUsedMib} of ${v.memTotalMib} MiB used${avail} (budget ${budgetMib ?? DEFAULT_MACHINE_MEMORY_MIB} MiB)`;
}

/**
 * Ask the guest for its vitals through `machine exec`, from this Mac. Never
 * throws: a machine that is stopped, or a binary that cannot be run, is an
 * answer `status` prints, not a reason to print nothing.
 */
export async function readGuestVitals(fleet: Pick<FleetManifest, 'smolvmBinary' | 'machine'>): Promise<{ vitals: GuestVitals | null; error: string | null }> {
  if (!fleet.machine) return { vitals: null, error: 'no machine yet' };
  try {
    const result = await run(
      [fleet.smolvmBinary, 'machine', 'exec', '--name', fleet.machine, '--', 'sh', '-c', GUEST_VITALS_SCRIPT],
      { cwd: osTmpdir(), env: allowlistedEnv(), timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      return { vitals: null, error: `machine exec exited ${result.code}: ${(result.stderr || result.stdout).trim().split('\n')[0] ?? ''}` };
    }
    return { vitals: parseGuestVitals(result.stdout), error: null };
  } catch (err) {
    return { vitals: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Keys that mean DEMO MODE; a fleet environment must carry none of them. */
export const DEMO_MODE_KEYS = ['LAZY_TEAMS_DEMO_MODE', 'LAZY_TEAMS_DEMO_AGENT_BIN', 'LAZY_TEAMS_DEMO_FLEET_ROOT'] as const;

/** One line `DEMO_FLEET_RESULT {json}` on the runner's stdout; see DemoFleet.run!. */
export const DEMO_FLEET_RESULT_PREFIX = 'DEMO_FLEET_RESULT ';

export type DemoFleetVerb = 'register' | 'provision' | 'start-task' | 'status' | 'teardown';

/** Pull the result line out of a runner's stdout, or throw with the tail of what it printed. */
export function parseDemoFleetResult(stdout: string, stderr: string, verb: string): Record<string, unknown> {
  const line = stdout.split('\n').map(l => l.trim()).reverse().find(l => l.startsWith(DEMO_FLEET_RESULT_PREFIX));
  if (!line) {
    const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-25).join('\n');
    throw new Error(`DemoFleet.${verb} printed no result line. The last lines were:\n${tail}`);
  }
  const parsed = JSON.parse(line.slice(DEMO_FLEET_RESULT_PREFIX.length)) as Record<string, unknown>;
  if (typeof parsed.error === 'string') throw new Error(`DemoFleet.${verb} failed:\n${parsed.error}`);
  return parsed;
}

/**
 * Run one DemoFleet verb through `bin/rails runner`. Inputs travel in the
 * environment — the credential value never on the command line, where `ps`
 * would show it to every user on the machine.
 */
export async function runDemoFleet(
  appDir: string,
  env: Record<string, string>,
  verb: DemoFleetVerb,
  extraEnv: Record<string, string> = {},
  timeoutMs = 300_000,
): Promise<Record<string, unknown>> {
  const result = await run(['bin/rails', 'runner', `DemoFleet.run!(${JSON.stringify(verb)})`], {
    cwd: appDir, env: { ...env, ...extraEnv }, timeoutMs,
  });
  return parseDemoFleetResult(result.stdout, result.stderr, verb);
}

/** What the manifest records about a fleet demo, so status and down need nothing from the shell. */
export interface FleetManifest {
  backend: FleetBackend;
  smolvmBinary: string;
  daemonImage: string;
  repo: string;
  /** The first declared `[serve]` port, or null when the repository declares none. */
  servePort: number | null;
  /** The machine's memory budget in MiB; null when the supervisor's default was used. */
  memoryMib: number | null;
  /** The model the seeded task was created on; null when the daemon's default was used. */
  model: string | null;
  /** Which variable the credential came from. Never the value. */
  credentialEnvVar: string;
  projectSlug: string;
  fleetProjectId: string;
  /** The machine's name, `lazy-<fleet project id>`, once provisioned. */
  machine: string | null;
  daemonUrl: string | null;
  /** The serve task, once created. */
  task: { id: string; code: string } | null;
}

/** What `status` needs to say about Teams itself: the URL and sign-in when the server started, and why not otherwise. */
export interface TeamsReach {
  url: string;
  email: string;
  password: string;
}

/**
 * The commands `lazy playground status` prints for a fleet demo, each labelled with
 * where it runs — starting with the Teams URL and its sign-in, which is what
 * the human opens. When the server never started (provisioning failed first),
 * that is said in as many words rather than left out.
 */
export function fleetHowToBlock(
  fleet: FleetManifest,
  services: { name: string; address: string | null }[],
  teams: TeamsReach | null = null,
): string[] {
  const lines: string[] = [];
  if (teams) {
    lines.push(`Teams:      ${teams.url}   (open in the browser on this host; sign in as ${teams.email} / ${teams.password})`);
  } else {
    lines.push('Teams:      not started — provisioning did not finish, so the server was never launched; the sign-in will be you@example.com / fixture-password once it is');
  }
  const port = fleet.daemonUrl ? new URL(fleet.daemonUrl).port : '<daemon port>';
  const live = services.find(s => s.address);
  if (fleet.servePort === null) {
    lines.push('Service:    the repository declares no [serve] port, so there is no address to show');
  } else if (live?.address) {
    const host = new URL(live.address).hostname;
    lines.push(`Service:    ${live.address}   (open in Chrome or Firefox on this host)`);
    lines.push(`            curl -sS -H "Host: ${host}" "http://127.0.0.1:${port}/"   # on the host, any directory`);
  }
  lines.push('Origin:     read-only to the guest — the daemon\'s pushes of task branches fail with a warning in its own log and change nothing for the task');
  if (fleet.machine) {
    lines.push(`Machine:    ${fleet.machine}`);
    lines.push(`            "${fleet.smolvmBinary}" machine exec --name ${fleet.machine} -- lazy-guest-init --print-plan   # inside the guest, from the host`);
    lines.push(`            "${fleet.smolvmBinary}" machine exec --name ${fleet.machine} -- docker ps                       # inside the guest, from the host`);
    if (fleet.fleetProjectId && fleet.task) {
      // Teams has no Watch: a task's progress there is its Turns tab, which
      // updates when a turn lands. The daemon's own `lazy watch` streams the
      // agent live, and it runs where the daemon is — inside the guest — with
      // the daemon's environment file sourced and the clone as cwd, the same
      // way the supervisor runs every guest command.
      for (const line of guestWatchLines(fleet)) lines.push(line);
    }
  }
  return lines;
}

/**
 * The commands that watch a working task from inside the guest, since Teams
 * has no live stream of its own and the daemon is the only thing that has one.
 *
 * `lazy watch` follows the agent's stream and needs nothing from the terminal
 * beyond stdout, so it works through `machine exec` whether or not that hands
 * over a TTY; Ctrl-C ends it. The two lines after it are the non-streaming
 * fallbacks: the task record with its turns, and the daemon's own log.
 */
export function guestWatchLines(fleet: Pick<FleetManifest, 'smolvmBinary' | 'machine' | 'fleetProjectId' | 'task'>): string[] {
  if (!fleet.machine || !fleet.fleetProjectId || !fleet.task) return [];
  const guest = `/lazy/projects/${fleet.fleetProjectId}`;
  const prelude = `cd ${guest}/repo; . ${guest}/daemon/env.*.sh;`;
  const exec = `"${fleet.smolvmBinary}" machine exec --name ${fleet.machine} --`;
  return [
    `Watch:      ${exec} sh -c '${prelude} exec lazy watch ${fleet.task.code}'   # inside the guest, from the host — streams the agent live; Ctrl-C to stop`,
    `            ${exec} sh -c '${prelude} exec lazy show ${fleet.task.code}'    # inside the guest, from the host — the task record and its turns, no stream`,
    `            ${exec} sh -c '${prelude} exec lazy daemon logs --no-follow -n 200'   # inside the guest, from the host — the daemon's own log`,
  ];
}

export function fleetPaths(teamsRoot: string): { fleetRoot: string } {
  return { fleetRoot: join(teamsRoot, 'fleet') };
}
