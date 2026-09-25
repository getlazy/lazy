/**
 * `lazy playground up --teams` — boot Lazy Teams against the demo and print its URL.
 *
 * It boots the real Rails app in this container, prepares and seeds its
 * database, registers the demo's fixture repository as a project, and hands
 * back a URL and a sign-in — so a Teams task can exercise the real surfaces
 * with real tasks on screen.
 *
 * ## The two things a demo Teams must not do, and how it is stopped
 *
 * **It must not run agents the way a real fleet does, and must not be able to
 * pretend otherwise.** Teams provisions a project by starting a daemon through
 * `LocalSupervisor`, whose `daemon_env` always sets `LAZY_MANAGED=1`; managed
 * mode allows only docker and podman, and there is no Docker in an agent
 * container. So this boot arms the app's own DEMO MODE
 * (`lazy-teams/app/models/demo_mode.rb`), which selects a supervisor that turns
 * managed mode off and allows lazy's host-process runner. That mode refuses to
 * arm outside development, refuses without an explicit switch, and refuses
 * without a stand-in agent — the guard lives in the Rails app, deliberately,
 * because that is where someone auditing Teams will look for it.
 *
 * **It must not touch a developer's own Teams data.** Rails resolves sqlite
 * paths against `Rails.root`, so the app's four development databases live in
 * the checkout. Preparing them would seed a developer's install and tearing
 * them down would delete it — from a command whose whole promise is that it is
 * disposable. So the demo passes `LAZY_TEAMS_STORAGE_DIR`, pointing all four at
 * a directory under the demo root, where `lazy playground down` removes them with
 * everything else and no `db:drop` is needed at all.
 */

import { access, mkdir, open, writeFile } from 'fs/promises';
import { join } from 'path';
import { spawn, spawnSyncUnsupervised } from '../utils/spawn';
import type { DemoManifest } from './paths';
import { allowlistedEnv, DEMO_FAKE_CREDENTIAL, run, run$ } from './runtime';
import {
  fleetTeamsEnv, runDemoFleet, type FleetInputs, type FleetManifest,
} from './fleet';

/** Where the seeded development account lives — see `lazy-teams/db/seeds.rb`. */
export const TEAMS_DEMO_EMAIL = 'you@example.com';
export const TEAMS_DEMO_PASSWORD = 'fixture-password';

/**
 * What Ruby needs on top of the demo's shared allowlist.
 *
 * The gem environment comes from the container image rather than from the app
 * (`Dockerfile.lazy` sets GEM_HOME/BUNDLE_PATH and copies a baked bundle), so
 * dropping these makes bundler re-resolve from the network and fail. None of
 * them is a credential.
 */
const TEAMS_EXTRA_ENV_KEYS = [
  'GEM_HOME', 'GEM_PATH', 'BUNDLE_PATH', 'BUNDLE_APP_CONFIG', 'BUNDLE_GEMFILE',
  'BUNDLE_SILENCE_ROOT_WARNING', 'RUBY_VERSION',
  // The system tests and any browser work Teams does look these up by name.
  'CHROME_BIN', 'CHROMEDRIVER_BIN', 'PLAYWRIGHT_BROWSERS_PATH',
] as const;

/** Environment variables the Rails app reads to become a demo. See its DemoMode. */
const DEMO_MODE_SWITCH = 'LAZY_TEAMS_DEMO_MODE';
const DEMO_AGENT_BIN_ENV = 'LAZY_TEAMS_DEMO_AGENT_BIN';
const DEMO_FLEET_ROOT_ENV = 'LAZY_TEAMS_DEMO_FLEET_ROOT';
/**
 * Where the app puts its four sqlite databases. Defaults to `storage/`.
 *
 * Exported so the test that guards the worst bug this command ever had can name
 * the same string the code sets, rather than a copy of it.
 */
export const STORAGE_DIR_ENV = 'LAZY_TEAMS_STORAGE_DIR';

/**
 * Everything the demo's Teams owns, derived from the demo root.
 *
 * Split out of `bootTeams` so it is decidable without booting anything: the
 * property that matters — every path Teams writes to is UNDER the demo root,
 * never in the checkout — is a pure function of the root, and a test that has
 * to boot Rails to check it is a test nobody runs.
 */
export function demoTeamsPaths(demoRoot: string): {
  teamsRoot: string; storageDir: string; fleetRoot: string; logPath: string; pidPath: string;
} {
  const teamsRoot = join(demoRoot, 'teams');
  return {
    teamsRoot,
    storageDir: join(teamsRoot, 'storage'),
    fleetRoot: join(teamsRoot, 'fleet'),
    logPath: join(teamsRoot, 'server.log'),
    pidPath: join(teamsRoot, 'server.pid'),
  };
}

/**
 * How Teams is booted: as the demo-mode demo, or against a real fleet backend.
 *
 * Two shapes rather than a bag of optionals, because the two must never mix:
 * a fleet boot carrying a stand-in agent, or a demo-mode boot carrying a
 * backend, is a demo that proves the wrong thing while looking green.
 */
export type TeamsBootMode =
  | {
    kind: 'demo';
    /** The stand-in agent's bin directory, which demo mode requires. */
    agentBinDir: string;
    /** The demo's fixture repository, registered as the Teams project's repo. */
    repoPath: string;
  }
  | {
    kind: 'fleet';
    inputs: FleetInputs;
    /** Filled in as the boot learns them; written to the manifest by the caller. */
    onProgress: (fleet: Partial<FleetManifest>) => Promise<void>;
  };

export interface TeamsBootOptions {
  /** The lazy source checkout — `lazy-teams/` is a directory inside it. */
  sourceRoot: string;
  /** Demo root: the server log, the databases and the fleet all live under it. */
  demoRoot: string;
  mode: TeamsBootMode;
  /**
   * HOME for Teams and everything it starts. The demo's own under demo mode
   * (agents run on this host and write to it); the human's real one under a
   * fleet backend, where no agent runs on this host and smolvm keeps its
   * machine registry under HOME — so the human's own `smolvm machine ls` sees
   * the demo's machine and the commands `lazy playground status` prints work as
   * pasted.
   */
  home: string;
  report: (message: string) => void;
  /**
   * Record the server's identity the moment it is spawned, BEFORE it is known
   * to be healthy.
   *
   * The same reasoning `lazy playground up` applies to the daemon, one level down: a
   * readiness failure still leaves a real Rails process holding a real port, and
   * if nothing wrote its pid down first, teardown has nothing to find and the
   * user is told the boot failed while the server keeps running. So the caller
   * gets a chance to persist it between `spawn` and the health check.
   */
  onServerStarted?: (server: { pid: number; port: number; url: string }) => Promise<void>;
}

export interface TeamsBootResult {
  url: string;
  pid: number;
  port: number;
  email: string;
  password: string;
  logPath: string;
}

export async function bootTeams(options: TeamsBootOptions): Promise<TeamsBootResult> {
  const appDir = join(options.sourceRoot, 'lazy-teams');
  try {
    await access(join(appDir, 'bin', 'rails'));
  } catch {
    throw new Error(
      `--teams needs the Lazy Teams app, and there is none at ${appDir}.\n` +
      `It ships inside the lazy checkout; run \`lazy playground up --teams\` from one.`,
    );
  }

  const { storageDir, fleetRoot, logPath, pidPath } =
    demoTeamsPaths(options.demoRoot);

  // Created before Rails runs: `db:prepare` will not make the directory its
  // sqlite files live in, and the failure reads as an unopenable database.
  await mkdir(storageDir, { recursive: true });
  await mkdir(fleetRoot, { recursive: true });

  const env = teamsEnv({
    sourceRoot: options.sourceRoot,
    storageDir,
    fleetRoot,
    mode: options.mode,
    home: options.home,
  });

  options.report('checking the Teams gem bundle');
  const bundle = await run(['bundle', 'check'], { cwd: appDir, env, timeoutMs: 120_000 });
  if (bundle.code !== 0) {
    throw new Error(
      `The Lazy Teams gem bundle is not installed, so --teams cannot boot the app.\n` +
      `Install it and try again:  (cd ${appDir} && bundle install)\n\n` +
      `${bundle.stdout.trim()}\n${bundle.stderr.trim()}`,
    );
  }

  // `db:prepare` creates the four databases and runs the seeds, and both halves
  // are idempotent — which is what makes `lazy playground up --teams` re-runnable.
  // The seeds mint the first user, and Teams makes the first user a site admin.
  // All four land under the demo root, never in the checkout.
  options.report('preparing the Teams database');
  await run$('bin/rails db:prepare', ['bin/rails', 'db:prepare'], {
    cwd: appDir, env, timeoutMs: 600_000,
  });

  // `bin/dev` runs a Tailwind WATCHER alongside the server (see Procfile.dev),
  // so a bare `bin/rails server` has no stylesheet to serve and every page dies
  // with Propshaft::MissingAssetError — a 500 on the sign-in page, which looks
  // like a broken app rather than a missing build step. Build it once instead
  // of running a watcher: the demo does not edit the app's CSS.
  options.report('building the Teams stylesheet');
  await run$('bin/rails tailwindcss:build', ['bin/rails', 'tailwindcss:build'], {
    cwd: appDir, env, timeoutMs: 300_000,
  });

  if (options.mode.kind === 'demo') {
    options.report('registering the playground project in Teams');
    await registerDemoProject(appDir, env, options.mode.repoPath);
  } else {
    await provisionFleetProject(appDir, env, options.mode, options.report);
  }

  // logPath and pidPath come from demoTeamsPaths above.
  await writeFile(logPath, '');

  const port = await firstFreePort();
  options.report(`starting the Teams server on port ${port}`);
  const pid = await startServer(appDir, env, port, logPath, pidPath);

  const url = `http://127.0.0.1:${port}`;
  // Persisted BEFORE the health check, not after it. From this line there is a
  // real Rails process holding a real port; if the readiness wait then fails —
  // a slow boot, a wedged migration, a deadline — the caller has already
  // recorded enough for `lazy playground down` to stop it. Recording it afterwards
  // meant a boot that failed at the last step left a server nobody could find.
  await options.onServerStarted?.({ pid, port, url });

  await waitForServer(url, logPath, pid);

  if (options.mode.kind === 'fleet') {
    // Only now: the launch bills the human's own account through the daemon,
    // and `Tasks::StartJob` runs inline in the runner. The credential the
    // daemon needs was pushed by `provision`, so nothing here waits on Puma's
    // job workers.
    const { servePort } = options.mode.inputs;
    options.report(servePort === null
      ? 'creating and starting the task (a real turn on your Claude account; the repository serves no port, so a plain one)'
      : `creating and starting the serve task on port ${servePort} (a real turn on your Claude account)`);
    const started = await runDemoFleet(appDir, env, 'start-task', {
      LAZY_DEMO_FLEET_SERVE_PORT: servePort === null ? '' : String(servePort),
      LAZY_DEMO_FLEET_MODEL: options.mode.inputs.model ?? '',
    });
    await options.mode.onProgress({ task: { id: String(started.task_id), code: String(started.task_code) } });
  }

  return { url, pid, port, email: TEAMS_DEMO_EMAIL, password: TEAMS_DEMO_PASSWORD, logPath };
}

/**
 * The fleet half of the boot, before the server starts: register the project
 * from the pushed fixture with the human's credential, then provision it
 * synchronously through `StartsProject` — the same path `Projects::StartJob`
 * takes — so the failure, if any, arrives here with the supervisor's own
 * diagnosis (`Inside the machine: …`) rather than a minute later from a job.
 *
 * Synchronous is also what makes this safe against the reconciler: Puma is not
 * running yet, so nothing else can be provisioning the same project.
 */
async function provisionFleetProject(
  appDir: string,
  env: Record<string, string>,
  mode: Extract<TeamsBootMode, { kind: 'fleet' }>,
  report: (message: string) => void,
): Promise<void> {
  const { inputs } = mode;
  report(`registering ${inputs.repo} in Teams with your ${inputs.credential.envVar}`);
  const registered = await runDemoFleet(appDir, env, 'register', {
    LAZY_DEMO_FLEET_REPO_URL: inputs.repo,
    LAZY_DEMO_FLEET_CREDENTIAL_KIND: inputs.credential.kind,
    // In the environment, never on the command line: `ps` shows argv to everyone.
    LAZY_DEMO_FLEET_CREDENTIAL_VALUE: inputs.credential.value,
  });
  await mode.onProgress({
    projectSlug: String(registered.project_slug),
    fleetProjectId: String(registered.fleet_project_id),
    credentialEnvVar: inputs.credential.envVar,
  });

  report('provisioning the project on the fleet backend (creates the machine, clones inside it, starts the daemon — minutes)');
  const provisioned = await runDemoFleet(appDir, env, 'provision', {}, 1_800_000);
  await mode.onProgress({
    machine: provisioned.machine ? String(provisioned.machine) : null,
    daemonUrl: provisioned.daemon_url ? String(provisioned.daemon_url) : null,
  });
  report(`the project daemon answers at ${String(provisioned.daemon_url)} (machine ${String(provisioned.machine)})`);
}

/**
 * The environment the Teams app boots under.
 *
 * `RAILS_ENV=development` is required rather than incidental, and twice over:
 * `db/seeds.rb` aborts outside development and test because the account it
 * creates has a published password, and the app's own demo mode refuses to arm
 * anywhere but development. Both are the app protecting itself, and the demo
 * satisfies them rather than working around them.
 */
export function teamsEnv(opts: {
  sourceRoot: string;
  storageDir: string;
  fleetRoot: string;
  mode: TeamsBootMode;
  home: string;
}): Record<string, string> {
  const common = {
    // Same allowlist posture as the demo's other subprocesses (see
    // `demoEnv`), plus what Ruby needs to find its gems. A spread of
    // `process.env` would hand the Teams server, and every daemon it starts,
    // whatever credentials the surrounding shell happens to export.
    ...allowlistedEnv([...TEAMS_EXTRA_ENV_KEYS]),
    // The demo's own HOME, for the same reason every other demo process gets
    // one: Teams starts daemons, those daemons launch agents, and an agent
    // launch writes to `$HOME/.claude.json`. Inherited, that is the machine's
    // own Claude Code config being rewritten by a throwaway demo.
    HOME: opts.home,
    RAILS_ENV: 'development',
    // Teams launches daemons from a lazy checkout; point it at THIS one so the
    // app and any daemon it starts are the same code.
    LAZY_CHECKOUT: opts.sourceRoot,
    // Rails reads this to decide whether it may print to stdout; the demo keeps
    // the server's output in a log file instead.
    RAILS_LOG_TO_STDOUT: '',
    // All four sqlite databases, under the demo root rather than the checkout.
    [STORAGE_DIR_ENV]: opts.storageDir,
  };

  if (opts.mode.kind === 'fleet') {
    // The real backend: DEMO MODE is not armed (none of its three variables is
    // set), the credential is the human's and travels to Rails per verb through
    // `runDemoFleet`, never in the server's environment. The fleet root is
    // under the demo root, so `lazy playground down` removes it.
    return { ...common, ...fleetTeamsEnv(opts.mode.inputs, opts.fleetRoot) };
  }

  return {
    ...common,
    // The demo's stand-in credential, for the same reason the demo daemon gets
    // one: Teams refuses to provision a project without a model credential on
    // the fleet host, and the only acceptable one here is a fake. Nothing dials
    // out — the stand-in agent never calls a model API — so this is what makes
    // "nothing is ever spent" true rather than merely intended.
    ANTHROPIC_API_KEY: DEMO_FAKE_CREDENTIAL,
    CLAUDE_CODE_OAUTH_TOKEN: '',
    // Arm the app's demo mode. Every condition it checks is satisfied here
    // explicitly; none of them is inferred.
    [DEMO_MODE_SWITCH]: '1',
    [DEMO_AGENT_BIN_ENV]: opts.mode.agentBinDir,
    [DEMO_FLEET_ROOT_ENV]: opts.fleetRoot,
  };
}

/**
 * Point the seeded team's project at the demo repository.
 *
 * `bin/rails runner` rather than a fixture or a migration: this is a one-off
 * change to seeded data, and the seeds themselves must stay the app's own (they
 * are run by developers who have never heard of `lazy playground`).
 *
 * The path arrives as `ARGV[0]`, never interpolated into the script text. JSON
 * quoting does NOT neutralise Ruby — a path containing `#{...}` inside a
 * double-quoted Ruby string is executed, and a demo root can come from a flag,
 * an environment variable, a CI setting or a copied command line. Passing it as
 * an argument means the value is data to Ruby, whatever is in it.
 */
async function registerDemoProject(
  appDir: string, env: Record<string, string>, repoPath: string,
): Promise<void> {
  const script = [
    'repo_url, credential = ARGV',
    'team = Team.find_by!(slug: "acme")',
    'project = team.projects.find_or_initialize_by(slug: "lazy-demo-shop")',
    'project.name = "Lazy Demo Shop"',
    'project.repo_url = repo_url',
    // Registering a project in Teams IS asking for it to run — the controller
    // sets the same thing on create. Without it the project sits at "not set up
    // yet" forever: the fleet reconciler only provisions what somebody has
    // asked for, so a demo that skipped this would show a project with no
    // tasks and no way to make any.
    'project.desired_state = :running',
    'project.save!',
    // Teams runs every task on the ACTING USER's own Claude account and refuses
    // to start one without it ("Connect your Claude account to start a task").
    // That is the app being right, so the demo satisfies it rather than working
    // around it — with the same obviously-fake value everything else in the
    // demo uses. The stand-in agent never calls a model API, so it is never
    // presented to anybody.
    'user = User.find_by!(email_address: "you@example.com")',
    'cred = ClaudeCredential.find_or_initialize_by(user:)',
    'cred.label = "Demo stand-in credential"',
    'cred.kind = :api_key',
    'cred.value = credential',
    'cred.save!',
    // A demo daemon is unmanaged: identity there is the daemon's own git
    // config, so a member's actions reach it on the project's control token and
    // the turns they start are billed to the project's SERVICE credential — the
    // person the daemon names is attributed, never spent. Without one every
    // start is refused ("No service credential for automated turns"). The
    // seeded owner designates their own stand-in credential, as they would on
    // the project's settings page.
    'project.update!(service_claude_credential: cred)',
    'puts "registered #{project.name} (#{project.repo_url})"',
  ].join('; ');

  await run$('bin/rails runner (register demo project)',
    ['bin/rails', 'runner', script, `file://${repoPath}`, DEMO_FAKE_CREDENTIAL], {
      cwd: appDir, env, timeoutMs: 300_000,
    });
}

/**
 * Start the server DETACHED, with its output on a file.
 *
 * Detached because the demo outlives the command that created it: `lazy playground
 * up` returns and the server keeps serving. Its pid goes in the manifest so
 * `lazy playground down` can stop it — an unrecorded background server is a leak with
 * extra steps.
 */
async function startServer(
  appDir: string, env: Record<string, string>, port: number, logPath: string, pidFile: string,
): Promise<number> {
  // A file DESCRIPTOR, not a stream: the server outlives this process, so its
  // output has to land somewhere that does not depend on us staying alive to
  // pump it.
  const log = await open(logPath, 'a');
  try {
    // `--pid` under the demo root, for two reasons. Rails defaults it to
    // `tmp/pids/server.pid` IN THE CHECKOUT, which is state the demo would be
    // leaving in a real project — the thing this command promises not to do.
    // And a stale one from a previous demo makes the next boot refuse outright
    // with "A server is already running", which is how this was found.
    const proc = spawn([
      'bin/rails', 'server', '-p', String(port), '-b', '127.0.0.1', '--pid', pidFile,
    ], {
      cwd: appDir,
      env,
      stdout: log.fd,
      stderr: log.fd,
      // No timeout: this process is meant to outlive the command.
      timeout: 0,
    });
    proc.unref();
    return proc.pid;
  } finally {
    // OUR handle, closed as soon as the child has been given one. The spawn
    // duplicates the descriptor, so the server keeps writing; leaving this one
    // open instead makes Node fail the process at GC time
    // ("A FileHandle object was closed during garbage collection").
    await log.close();
  }
}

/**
 * Poll until the server answers — or until it is clear it never will.
 *
 * Any HTTP response counts, including the 302 an unauthenticated request gets:
 * the question is whether Rails is serving, and "it redirected me to sign in"
 * answers it.
 *
 * The EARLY-EXIT check is what stops the common failure being a three-minute
 * lie. Rails dying immediately — a port taken between the free-port check and
 * the boot, a migration it refuses, a missing gem — is indistinguishable from
 * "still starting" if all you do is poll the socket, so the wait used to run
 * its full deadline and then report that Teams "did not answer" when in fact it
 * had been dead for 179 seconds. Noticing the process is gone turns that into
 * an immediate failure carrying the log that says why.
 */
async function waitForServer(url: string, logPath: string, pid: number): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
      return;
    } catch (err) {
      lastError = (err as Error).message;
    }

    if (!isAlive(pid)) {
      throw new Error(
        `The Lazy Teams server exited while starting up.\n` +
        `Its log is at ${logPath}; the last lines were:\n${await logTail(logPath)}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `The Lazy Teams server did not answer at ${url} within 180s (${lastError}).\n` +
    `It is still running, so it is starting slowly or wedged. Its log is at ${logPath}; ` +
    `the last lines were:\n${await logTail(logPath)}`,
  );
}

/** The server's own log is the only thing that says WHY it did not come up. */
async function logTail(logPath: string): Promise<string> {
  try {
    const text = await Bun.file(logPath).text();
    return text.split('\n').slice(-25).join('\n');
  } catch {
    return '(no server log)';
  }
}

/** Is there still a process with this pid? Signal 0 tests without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and is not ours — alive for this purpose.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** First port in the demo's range that nothing is listening on. */
async function firstFreePort(): Promise<number> {
  const FIRST_PORT = 3999;
  const LAST_PORT = 4010;
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `No free port for the Teams server between ${FIRST_PORT} and ${LAST_PORT}. ` +
    `Another playground may still be up — check with \`lazy playground status\`.`,
  );
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the Teams server this demo started — and only that.
 *
 * A pid alone is not identity. The default demo root survives a reboot, so its
 * manifest can name a pid the kernel has since handed to something else, and
 * this project has already been bitten by exactly that in the storage lock. So
 * the process is IDENTIFIED before it is signalled: its command line has to
 * still look like the Rails server this demo launched, on the port it recorded.
 * A mismatch is treated as "already gone", which is what it almost always is.
 */
export async function stopTeamsServer(teams: NonNullable<DemoManifest['teams']>): Promise<void> {
  if (!isAlive(teams.pid)) return;

  const command = commandLineOf(teams.pid);
  // `port` is absent from manifests written before it was recorded; fall back
  // to the URL, which has carried the port from the start.
  const port = teams.port ?? Number(new URL(teams.url).port);
  // The bound ADDRESS, not the word "rails". `bin/rails server` execs into
  // Puma, which rewrites its own process title to
  // `puma 8.0.2 (tcp://127.0.0.1:3999) [lazy-teams]` — so matching on "rails"
  // recognised nothing, silently skipped the kill, and left the server running
  // through teardown. The address is both more precise and actually present.
  const looksLikeOurs = command !== null && command.includes(`127.0.0.1:${port}`);

  if (!looksLikeOurs) {
    // Deliberately silent: the overwhelmingly likely cause is a stale manifest
    // after a reboot, and refusing to kill somebody else's process is the
    // correct outcome, not an incident.
    return;
  }

  if (!signalQuietly(teams.pid, 'SIGTERM')) return;

  // WAIT for it, then escalate — the same shape `reapDemoProcesses` uses, and
  // for a sharper reason here: the reap sweep cannot cover for this one. It
  // matches processes by the demo paths on their command line, and `bin/rails
  // server` execs into Puma, which rewrites its title to
  // `puma 8.0.2 (tcp://127.0.0.1:3999) [lazy-teams]` — no demo path anywhere in
  // it. So a SIGTERM that was sent and not waited for left teardown racing the
  // server's own shutdown: `rm -rf` could pull the root out from under a process
  // still exiting, or the server could outlive teardown entirely and hold its
  // port against the next `up --teams`.
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isAlive(teams.pid)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Still there after the grace period. A demo teardown that can be refused by
  // a process declining to exit is not a teardown.
  signalQuietly(teams.pid, 'SIGKILL');
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && isAlive(teams.pid)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** How long the Teams server gets to exit politely before SIGKILL. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Signal a pid, returning false when there is nothing there to wait for.
 *
 * ESRCH means it is already gone and EPERM means it is not ours to kill;
 * neither is a reason for teardown to fail, and in both cases waiting for an
 * exit we cannot cause would just burn the grace period.
 */
function signalQuietly(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw new Error(`Failed to ${signal} the playground Teams app (pid ${pid}): ${(err as Error).message}`);
  }
}

/** One process's command line, or null if it is gone or unreadable. */
function commandLineOf(pid: number): string | null {
  const result = spawnSyncUnsupervised(['ps', '-p', String(pid), '-o', 'args='], { timeout: 10_000, env: allowlistedEnv() });
  if (result.exitCode !== 0) return null;
  const text = result.stdout.toString().trim();
  return text.length > 0 ? text : null;
}
