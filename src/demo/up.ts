/**
 * `lazy playground up` — provision a throwaway demo environment and say how to reach it.
 */

import { mkdir, writeFile } from 'fs/promises';
import { access } from 'fs/promises';
import { join, dirname } from 'path';
import { installDemoAgent, resolveDemoPacingMs, writeDemoScript } from './agent';
import { patchDemoConfig } from './config';
import { createFixtureRepo, DEMO_PROTECTED_GLOB } from './fixture';
import {
  cloneProjectRepo, PLAYGROUND_REPO_URL, resolveRepoSource, readStarterTasks, seedStarterTasks, type StarterTask,
} from './playground';
import {
  demoPaths, writeManifest, MANIFEST_VERSION, type DemoManifest, type DemoPaths,
} from './paths';
import { demoScript, seedDemoTasks } from './seed';
import { takeDemoEnvironmentDown } from './down';
import { bootTeams, TEAMS_DEMO_EMAIL, TEAMS_DEMO_PASSWORD, type TeamsBootMode } from './teams';
import {
  assertRepoPubliclyFetchable, readRepoServePort, resolveFleetBackend, resolveFleetInputs,
  type FleetInputs, type FleetManifest,
} from './fleet';
import {
  demoEnv, installDemoWrapper, lazy, lazyTry, resolveLazyInvocation, withDemoDaemonBase,
  type LazyInvocation,
} from './runtime';

export interface DemoUpOptions {
  /** Explicit demo root; defaults per {@link demoPaths}. */
  root?: string;
  /** Also boot Lazy Teams against this demo and provision the project into it. */
  teams?: boolean;
  /**
   * Run the Teams half on a REAL fleet backend (`--fleet smolvm`) instead of
   * in demo mode: no host daemon, no stand-in agent, the human's own
   * credential, one real task. Requires `teams`. See src/demo/fleet.ts.
   */
  fleet?: string;
  /**
   * The repository the demo adopts as its project. With `fleet`: the public
   * repository the guest clones. Without: any `git clone` source (a URL or a
   * local path); when it is the playground its starter tasks are seeded. Both
   * default to {@link PLAYGROUND_REPO_URL} once that is set.
   */
  repo?: string;
  /** With `fleet`: the machine's memory budget in MiB (`--memory`); see resolveMachineMemoryMib. */
  memory?: string;
  /** With `fleet`: the model the seeded task runs on (`--model`). */
  model?: string;
  /** Progress line sink. */
  report: (message: string) => void;
}

export interface DemoUpResult {
  paths: DemoPaths;
  manifest: DemoManifest;
  /** A one-time dashboard sign-in URL, or null when one could not be minted. */
  loginUrl: string | null;
  /**
   * The playground's starter tasks when the project is the playground; an empty
   * list for another cloned repository; null for the generated fixture, whose
   * seeded states are described by the CLI.
   */
  starterTasks: StarterTask[] | null;
}

/**
 * Provision the demo, replacing any previous one.
 *
 * Idempotence is REPLACEMENT rather than reuse, deliberately: the value of the
 * demo is that its state is known, and reusing a root someone has clicked
 * around in gives a surface a state nobody wrote down. Tearing down first is
 * also what makes the command safe to re-run after a failed run, which is when
 * it matters most.
 */
export async function bringDemoUp(options: DemoUpOptions): Promise<DemoUpResult> {
  const paths = demoPaths(options.root);
  const lazyCmd = resolveLazyInvocation();

  // Every fleet refusal comes FIRST, before the teardown below touches the
  // previous demo: a missing variable must not cost a working demo.
  const fleetBackend = resolveFleetBackend(options.fleet);
  if (fleetBackend && !options.teams) {
    throw new Error('--fleet runs the Teams half of the playground on a real backend, so it needs --teams as well.');
  }
  let fleet: FleetInputs | null = null;
  if (fleetBackend) {
    fleet = resolveFleetInputs({ backend: fleetBackend, repo: options.repo ?? PLAYGROUND_REPO_URL ?? undefined, memory: options.memory, model: options.model });
    // Both from the Mac, with git's credential sources turned off — what the
    // guest has. A private or wrong URL is refused here, not minutes later
    // inside the machine; and the repository's committed lazy.toml decides
    // which task is seeded.
    options.report(`checking ${fleet.repo} can be fetched without credentials`);
    const branch = await assertRepoPubliclyFetchable(fleet.repo);
    fleet = { ...fleet, servePort: await readRepoServePort(fleet.repo, branch, options.report) };
  }

  await preflight(lazyCmd);

  return await withDemoDaemonBase(paths.daemonBase, async () => {
    // Replacement goes through the SAME teardown `lazy playground down` uses, so it
    // inherits both of its refusals rather than having a second, weaker copy:
    // an unsafe root shape, and a root with content this command did not put
    // there. That matters more here than in `down` — this is the silent path,
    // running before anything is printed, so a mistyped `--root` would
    // otherwise be destroyed with no output at all.
    options.report(`tearing down anything already at ${paths.root}`);
    await takeDemoEnvironmentDown({ root: options.root, report: () => {}, quiet: true });

    // THE MARKER GOES DOWN FIRST — and "first" means the very next statement
    // after the directory exists, with nothing between them.
    //
    // The instant this root holds ANY content without a manifest,
    // `classifyRoot` calls it FOREIGN: `down` refuses it, a retried `up`
    // refuses it, and the user is wedged with no supported way out. So every
    // statement standing between `mkdir` and this write is a window where a
    // full disk, a permissions error, a read-only mount or an interrupt strands
    // the root permanently. There used to be two more `mkdir`s and the home
    // creation in that gap; they now happen after, where a failure leaves a
    // root teardown can still remove.
    //
    // `writeManifest` does its own `mkdir` of the root, so this ordering costs
    // nothing. Facts not known yet are written empty and filled in below, and
    // writes are atomic, so a crash between them leaves the previous complete
    // manifest rather than a truncated one.
    // Validated before anything is created: a malformed pacing value refused
    // after the root exists would leave a half-made playground to remove.
    const pacingMs = resolveDemoPacingMs();

    await mkdir(paths.root, { recursive: true });
    const manifest: DemoManifest = {
      version: MANIFEST_VERSION,
      root: paths.root,
      createdAt: new Date().toISOString(),
      lazyEntry: lazyCmd.entry,
      dashboardUrl: null,
      seededTasks: [],
    };
    await writeManifest(paths, manifest);

    // Everything below can fail freely: the root is now removable.
    await mkdir(paths.out, { recursive: true });
    await createDemoHome(paths);

    if (fleet) return await bringFleetDemoUp({ options, paths, lazyCmd, manifest, fleet });

    options.report('installing the playground agent');
    const agent = await installDemoAgent(paths.agent, { pacingMs });
    await writeDemoScript(paths.agent, demoScript());

    const env = demoEnv({ paths });

    // The playground (or any repository the human names) when it can be
    // cloned; the generated fixture otherwise. Only the DEFAULT source may fall
    // back — that is what keeps an offline `lazy playground up` working.
    const repoSource = options.repo !== undefined
      ? resolveRepoSource(options.repo, process.cwd())
      : PLAYGROUND_REPO_URL;
    const cloned = repoSource !== null && await cloneProjectRepo({
      repo: repoSource, dest: paths.repo, env,
      fallbackAllowed: options.repo === undefined,
      report: options.report,
    });
    let starterTasks: StarterTask[] | null = null;
    if (cloned) {
      manifest.projectRepo = repoSource!;
      starterTasks = (await readStarterTasks(paths.repo)) ?? [];
    } else {
      options.report('creating the fixture repository');
      await createFixtureRepo(paths.repo, env);
    }

    // `<root>/bin/lazy-playground` — the supported way to drive this demo by hand.
    // Installed rather than printed as exports, because those variables must
    // not outlive the demo in somebody's shell. See `installDemoWrapper`.
    await installDemoWrapper({ paths, lazyCmd });

    options.report('initializing lazy in the fixture repository');
    // `--non-interactive` is what makes init work without a TTY; the demo is
    // run by agents and by the e2e suite, neither of which has one.
    await lazy('lazy init', lazyCmd, [
      'init', '--non-interactive',
      '--external-path', paths.store,
      '--skip-auth-check', '--skip-remote-check', '--skip-completion-check',
    ], { cwd: paths.repo, env });

    await patchDemoConfig(paths.repo, env, cloned ? null : DEMO_PROTECTED_GLOB);

    options.report('starting the playground daemon');
    await lazy('lazy daemon start', lazyCmd, ['daemon', 'start'], {
      cwd: paths.repo, env, timeoutMs: 180_000,
    });

    // The daemon is up and holding a port: record how to reach it before the
    // long part (seeding) starts, so `lazy playground status` can describe a demo
    // whose seeding then fails.
    manifest.dashboardUrl = await readDashboardUrl(lazyCmd, paths.repo, env);
    await writeManifest(paths, manifest);

    if (!cloned) {
      manifest.seededTasks = await seedDemoTasks({
        lazyCmd, repo: paths.repo, env,
        report: message => options.report(message),
      });
    } else {
      if (starterTasks!.length === 0) options.report('the repository has no tasks.json, so no tasks were seeded');
      manifest.seededTasks = await seedStarterTasks({
        lazyCmd, repo: paths.repo, env, tasks: starterTasks!,
        report: message => options.report(message),
      });
    }
    await writeManifest(paths, manifest);

    if (options.teams) {
      const teams = await bootTeams({
        sourceRoot: dirname(dirname(lazyCmd.entry)),
        demoRoot: paths.root,
        mode: { kind: 'demo', agentBinDir: agent.binDir, repoPath: paths.repo },
        home: paths.home,
        report: message => options.report(message),
        // Written the moment the process exists, before it is known to be
        // healthy — so a readiness failure leaves a manifest teardown can act
        // on rather than an orphaned server. The credentials are filled in
        // here too, since they are fixed by the seeds and known already.
        onServerStarted: async ({ pid, port, url }) => {
          manifest.teams = {
            url, pid, port,
            email: TEAMS_DEMO_EMAIL, password: TEAMS_DEMO_PASSWORD,
          };
          await writeManifest(paths, manifest);
        },
      });
      manifest.teams = {
        url: teams.url, pid: teams.pid, port: teams.port,
        email: teams.email, password: teams.password,
      };
      await writeManifest(paths, manifest);
    }

    // Minted LAST: the link works exactly once and expires, so a demo that
    // spent a minute booting Teams after minting one would print a link that
    // had been sitting unused all that time.
    const loginUrl = await mintLoginUrl(lazyCmd, paths.repo, env);

    return { paths, manifest, loginUrl, starterTasks };
  });
}

/**
 * The fleet demo: the human's public repository as the project, Teams booted
 * on the real backend, one real task started. No fixture is created — the
 * generated demo shop belongs to the demo-mode demo. Everything the demo-mode demo
 * does on this host — the stand-in agent, the host daemon, the seeded states,
 * the sign-in link off that daemon — is deliberately absent: there is no
 * daemon on this host to sign in to, and no agent runs here.
 *
 * Progress is written to the manifest as it is learned, so a boot that dies
 * halfway leaves `lazy playground status` able to name the machine and `lazy playground
 * down` able to delete it.
 */
async function bringFleetDemoUp(ctx: {
  options: DemoUpOptions;
  paths: DemoPaths;
  lazyCmd: LazyInvocation;
  manifest: DemoManifest;
  fleet: FleetInputs;
}): Promise<DemoUpResult> {
  const { options, paths, lazyCmd, manifest, fleet } = ctx;

  manifest.fleet = {
    backend: fleet.backend,
    smolvmBinary: fleet.smolvmBinary,
    daemonImage: fleet.daemonImage,
    repo: fleet.repo,
    servePort: fleet.servePort,
    memoryMib: fleet.memoryMib,
    model: fleet.model,
    credentialEnvVar: fleet.credential.envVar,
    projectSlug: '',
    fleetProjectId: '',
    machine: null,
    daemonUrl: null,
    task: null,
  };
  await writeManifest(paths, manifest);

  const mode: TeamsBootMode = {
    kind: 'fleet',
    inputs: fleet,
    onProgress: async (progress: Partial<FleetManifest>) => {
      manifest.fleet = { ...manifest.fleet!, ...progress };
      await writeManifest(paths, manifest);
    },
  };

  const teams = await bootTeams({
    sourceRoot: dirname(dirname(lazyCmd.entry)),
    demoRoot: paths.root,
    mode,
    // The human's HOME, on purpose — see TeamsBootOptions.home.
    home: process.env.HOME ?? paths.home,
    report: message => options.report(message),
    onServerStarted: async ({ pid, port, url }) => {
      manifest.teams = { url, pid, port, email: TEAMS_DEMO_EMAIL, password: TEAMS_DEMO_PASSWORD };
      await writeManifest(paths, manifest);
    },
  });
  manifest.teams = {
    url: teams.url, pid: teams.pid, port: teams.port, email: teams.email, password: teams.password,
  };
  await writeManifest(paths, manifest);

  return { paths, manifest, loginUrl: null, starterTasks: null };
}

/**
 * Create the demo's own HOME, with the little that has to be in it.
 *
 * Everything a demo process writes to `$HOME` lands here — the Claude Code MCP
 * config, its tool allowlist, its session state — so it is removed with the
 * root and never touches the machine's own.
 *
 * The git identity is the one thing that genuinely has to be seeded rather than
 * left empty. With `HOME` redirected there is no `~/.gitconfig`, and the demo's
 * daemon makes commits of its own (merges on accept, the initialise commit on
 * start) that are NOT routed through the per-command `-c user.email=…` the
 * fixture and the stand-in agent use. Without this they fail with git's "please
 * tell me who you are", which surfaces as an unexplained accept failure several
 * processes away.
 */
async function createDemoHome(paths: DemoPaths): Promise<void> {
  await mkdir(paths.home, { recursive: true });
  await writeFile(join(paths.home, '.gitconfig'), [
    '# Generated by `lazy playground up` for the playground\'s own HOME.',
    '# The playground never reads or writes your real git configuration.',
    '[user]',
    '\tname = Lazy Demo',
    '\temail = demo@lazy.invalid',
    '[init]',
    '\tdefaultBranch = main',
    '',
  ].join('\n'));
}

/**
 * Fail early on the two things that otherwise surface several processes away.
 *
 * Running from a lazy SOURCE tree is genuinely required, not merely preferred:
 * demo turns need the host-process runner, whose gate
 * (`isHostRunnerConfigAllowed`) is compiled out of release builds. A released
 * binary can create the fixture and start a daemon and will then fail on the
 * first `lazy start`, which is a much worse place to find out.
 */
async function preflight(lazyCmd: LazyInvocation): Promise<void> {
  if (!lazyCmd.entry.endsWith('.ts') && !lazyCmd.entry.endsWith('.js')) {
    throw new Error(
      'lazy playground needs to run from a lazy source checkout.\n\n' +
      'The playground seeds real turns, which need the host-process runner — there is no Docker ' +
      'inside an agent container. That runner is a test-harness seam and is compiled out of ' +
      'released binaries, so a released lazy can create the playground project but cannot run a ' +
      'single turn in it.\n\n' +
      'Run it from the checkout instead:  bun run ./src/index.ts playground up',
    );
  }

  // `src/version.ts` and `lazy-agent` are build-time artifacts produced by
  // `bun install`'s prepare step. Without them the demo's own subprocesses die
  // on a missing module, which reads as a daemon bug rather than a missing
  // build step.
  const sourceRoot = dirname(dirname(lazyCmd.entry));
  for (const [file, remedy] of [
    [join(sourceRoot, 'src', 'version.ts'), 'bun run generate:version'],
    [join(sourceRoot, 'lazy-agent'), 'bun run ensure:agent-placeholder'],
  ] as const) {
    try {
      await access(file);
    } catch {
      throw new Error(
        `lazy playground needs ${file}, which is generated at install time and is missing.\n` +
        `Generate it and try again:  ${remedy}`,
      );
    }
  }
}

/** The demo dashboard's plain URL, read off the running daemon. */
async function readDashboardUrl(
  lazyCmd: LazyInvocation, repo: string, env: Record<string, string>,
): Promise<string | null> {
  const result = await lazyTry(lazyCmd, ['daemon', 'dashboard-url'], { cwd: repo, env });
  if (result.code !== 0) return null;
  const url = result.stdout.trim().split('\n')[0]?.trim();
  return url && url.startsWith('http') ? url : null;
}

/**
 * Mint a one-time dashboard sign-in link.
 *
 * The dashboard needs a signed-in session, so a bare dashboard URL is useless
 * to an agent that wants to screenshot a page — it renders the sign-in screen.
 * The link works once; `lazy playground status` mints a fresh one.
 */
async function mintLoginUrl(
  lazyCmd: LazyInvocation, repo: string, env: Record<string, string>,
): Promise<string | null> {
  const result = await lazyTry(lazyCmd, ['dashboard', '--print'], { cwd: repo, env });
  if (result.code !== 0) return null;
  const line = result.stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('http'));
  return line ?? null;
}
