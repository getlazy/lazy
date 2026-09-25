/**
 * `lazy playground` — a throwaway lazy project an agent can drive from inside its own
 * container.
 *
 * WHY THIS IS A COMMAND. Lazy's UI work — the dashboard, the review surfaces,
 * Teams — used to be provable only by the engineer clicking through their own
 * real project, because an agent in a container has no lazy project of its own
 * and no Docker to make one. That put a human in the loop on every UI change.
 * This command gives an agent a real daemon, real turns and real tasks in every
 * state worth rendering, so it can prove its own work.
 *
 * Every user-facing decision here lives in `src/demo/`; this file parses flags
 * and prints, like every other CLI command.
 */

import { parseFlags, type FlagDefinition } from '../helpers';
import { theme } from '../../render/theme';
import { bringDemoUp } from '../../demo/up';
import { takeDemoEnvironmentDown } from '../../demo/down';
import { readDemoStatus } from '../../demo/status';
import { DEMO_TASK_CODES } from '../../demo/seed';
import { DEMO_WRAPPER_NAME } from '../../demo/runtime';
import { DEFAULT_MACHINE_MEMORY_MIB, fleetHowToBlock, formatGuestVitals } from '../../demo/fleet';
import type { FleetStatus } from '../../demo/status';
import { join } from 'path';
import type { DemoPaths } from '../../demo/paths';
import { findLegacyDemoRoot } from '../../demo/paths';

/** One line about an environment the old `lazy demo` left at its old default root. */
export function legacyRootNotice(legacy: string): string {
  return `An environment from the old \`lazy demo\` is still at ${legacy} — tear it down with: lazy playground down --root ${legacy}`;
}

async function warnAboutLegacyRoot(root: string | undefined): Promise<void> {
  const legacy = await findLegacyDemoRoot(root);
  if (!legacy) return;
  console.log(theme.separator(legacyRootNotice(legacy)));
}

// Each table is a plain array of object LITERALS, with `--root` spelled out in
// all three rather than shared through a const. `test/unit/cli-command-
// discoverability.test.ts` is a source scan that reads these literals to learn
// what the command really accepts; an identifier it cannot resolve credits the
// command with fewer flags than it takes, and the guard then reports a correct
// tab-completion as stale.
const UP_FLAGS: FlagDefinition[] = [
  { name: 'root', takesValue: true },
  { name: 'teams', takesValue: false },
  { name: 'fleet', takesValue: true },
  { name: 'repo', takesValue: true },
  { name: 'memory', takesValue: true },
  { name: 'model', takesValue: true },
];

const DOWN_FLAGS: FlagDefinition[] = [
  { name: 'root', takesValue: true },
];

const STATUS_FLAGS: FlagDefinition[] = [
  { name: 'root', takesValue: true },
];

export async function commandPlayground(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    playgroundUsage();
    process.exit(1);
  }

  const sub = args.slice(1);

  switch (subcommand) {
    case 'up':
      await playgroundUp(sub);
      break;
    case 'down':
      await playgroundDown(sub);
      break;
    case 'status':
      await playgroundStatus(sub);
      break;
    default:
      console.error(`Unknown subcommand: playground ${subcommand}`);
      playgroundUsage();
      process.exit(1);
  }
}

async function playgroundUp(args: string[]): Promise<void> {
  const parsed = parseFlags(args, UP_FLAGS, 'playground up');
  const root = parsed.flags.get('root') as string | undefined;
  await warnAboutLegacyRoot(root);
  const teams = parsed.flags.get('teams') === true;
  const fleet = parsed.flags.get('fleet') as string | undefined;
  const repo = parsed.flags.get('repo') as string | undefined;
  const memory = parsed.flags.get('memory') as string | undefined;
  const model = parsed.flags.get('model') as string | undefined;

  // Provisioning takes a minute or two and does real work the whole time.
  // Narrating it is not decoration: a silent command that runs this long reads
  // as a hang, and the phase it is in is the first thing to know when it fails.
  console.log(theme.header('Bringing up the lazy playground environment'));
  const started = Date.now();

  if (fleet) {
    console.log(theme.separator(
      '  A fleet playground: Teams runs on the real backend, the project is the repository you named, cloned\n' +
      '  inside a microVM, and its one task runs a REAL turn on your own Claude account.',
    ));
  }

  const result = await bringDemoUp({
    root, teams, fleet, repo, memory, model,
    report: message => console.log(`  ${theme.separator('·')} ${message}`),
  });

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n${theme.header('Playground is up')} ${theme.separator(`(${seconds}s)`)}`);
  console.log(`  Root:       ${result.paths.root}`);
  console.log(`  Project:    ${result.paths.repo}`);
  if (result.manifest.projectRepo) console.log(`              (cloned from ${result.manifest.projectRepo})`);
  if (result.manifest.dashboardUrl) {
    console.log(`  Dashboard:  ${result.manifest.dashboardUrl}`);
  }
  if (result.loginUrl) {
    console.log(`  Sign in:    ${result.loginUrl}`);
    console.log(theme.separator('              (works once — get a fresh one with `lazy playground status`)'));
  }
  if (result.manifest.teams) {
    console.log(`  Teams:      ${result.manifest.teams.url}`);
    console.log(`              ${result.manifest.teams.email} / ${result.manifest.teams.password}`);
  }

  if (result.manifest.fleet) {
    printFleetUpBlock(result.manifest.fleet, result.manifest.teams ?? null);
    console.log(`\n  Tear it all down (machine included) with: ${theme.command('lazy playground down')}`);
    return;
  }

  if (result.starterTasks === null) {
    console.log(`\n${theme.header('Seeded tasks')}`);
    for (const line of seededTaskSummary()) console.log(`  ${line}`);
  } else if (result.starterTasks.length > 0) {
    // The playground: starter tasks in the backlog, none started.
    console.log(`\n${theme.header('Starter tasks')} ${theme.separator('(in the backlog, none started)')}`);
    const width = Math.max(...result.starterTasks.map(task => task.code.length)) + 2;
    for (const task of result.starterTasks) console.log(`  ${task.code.padEnd(width)}${task.type} — ${task.goal}`);
  }

  printDriveItBlock(result.paths, result.starterTasks === null
    ? { kind: 'fixture' }
    : { kind: 'cloned', firstTask: result.starterTasks[0]?.code ?? null });
  console.log(`\n  Tear it all down with: ${theme.command('lazy playground down')}`);
}

/**
 * What a fleet `up` leaves the human with: the machine, the one task, and how
 * to see its service once the first turn has built the agent image and run.
 * Every command says where it runs.
 */
function printFleetUpBlock(
  fleet: NonNullable<import('../../demo/paths').DemoManifest['fleet']>,
  teams: import('../../demo/paths').DemoManifest['teams'] | null,
): void {
  console.log(`\n${theme.header('Fleet')}`);
  console.log(`  Backend:    ${fleet.backend}`);
  console.log(`  Repository: ${fleet.repo} (the guest cloned it)`);
  console.log(fleet.servePort === null
    ? '  Serves:     nothing declared — the task describes the repository; no address to show later'
    : `  Serves:     port ${fleet.servePort} — the task starts a server there`);
  if (fleet.machine) console.log(`  Machine:    ${fleet.machine} — ${machineBudget(fleet.memoryMib)}`);
  if (fleet.daemonUrl) console.log(`  Daemon:     ${fleet.daemonUrl} (on this host; the mapping into the machine)`);
  if (fleet.task) {
    console.log(`  Task:       ${fleet.task.code} — started; its first turn builds lazy-runner inside the guest (minutes)`);
  }
  // Said again at the very end, on their own lines: the Teams URL is what the
  // human opens, and the daemon port is the number every service address
  // below will carry. Both are printed above too; this is the line the eye
  // lands on when the command returns.
  console.log(`\n${theme.header('How to reach it')}`);
  if (teams) {
    console.log(`  Open in the browser on this host: ${teams.url}   (sign in as ${teams.email} / ${teams.password})`);
  }
  if (fleet.daemonUrl) {
    const port = new URL(fleet.daemonUrl).port;
    console.log(`  Daemon port on this host:         ${port}   (127.0.0.1:${port} → 26024 inside the machine; Teams talks to it, you need not)`);
    if (fleet.servePort !== null && fleet.task) {
      console.log(`  Service, once the turn is done:   http://${fleet.servePort}.${fleet.task.code}.lazy.localhost:${port}/   (through the daemon's own proxy on that port)`);
    }
  }
  console.log(`  When the task has finished: ${theme.command('lazy playground status')}   # on the host, any directory — the service address, the curl check, the guest commands`);
}

/** `4096 MiB memory (the default; --memory raises it)` or `6144 MiB memory (--memory)`. */
function machineBudget(memoryMib: number | null): string {
  return memoryMib === null
    ? `${DEFAULT_MACHINE_MEMORY_MIB} MiB memory (the default; lazy playground up --memory <MiB> raises it)`
    : `${memoryMib} MiB memory (--memory)`;
}

/** The fleet section of `lazy playground status`. */
function printFleetStatus(fleet: FleetStatus): void {
  console.log(`\n${theme.header('Fleet')}`);
  console.log(`  Backend:    ${fleet.manifest.backend}`);
  console.log(`  Project:    ${fleet.manifest.projectSlug || '(not registered)'} — ${fleet.lifecycle}`);
  if (fleet.machine) console.log(`  Machine:    ${fleet.machine} — ${machineBudget(fleet.manifest.memoryMib)}`);
  if (fleet.guest) {
    console.log(`  Guest:      ${formatGuestVitals(fleet.guest, fleet.manifest.memoryMib)}   # measured just now inside the guest via machine exec`);
  } else if (fleet.machine) {
    console.log(`  Guest:      ${theme.separator(`could not be asked — ${fleet.guestError ?? 'unknown'}`)}`);
  }
  if (fleet.daemonLogPath) {
    console.log(`  Daemon log: ${fleet.daemonLogPath}   # on this host — the daemon directory is a mount out of the machine; tail it directly`);
  }
  if (fleet.daemonUrl) {
    console.log(`  Daemon:     ${fleet.daemonUrl} — ${fleet.daemonAnswers ? 'answering' : theme.separator('not answering')}`);
  }
  if (fleet.daemonError) console.log(theme.separator(`              ${fleet.daemonError}`));
  if (fleet.error) console.log(theme.separator(`  Rails could not be asked: ${fleet.error.split('\n')[0]}`));
  if (fleet.provisioningError) {
    console.log(`\n  ${theme.header('Provisioning failed')}: ${fleet.provisioningError}`);
    if (fleet.provisioningErrorDetail) {
      console.log(theme.separator(fleet.provisioningErrorDetail.split('\n').map(l => `    ${l}`).join('\n')));
    }
  }
  if (fleet.task) {
    console.log(`  Task:       ${fleet.task.code} — ${fleet.task.status}`);
  } else if (fleet.manifest.task) {
    console.log(`  Task:       ${fleet.manifest.task.code} — not readable right now`);
  }
  if (fleet.servicesUnavailable) {
    console.log(`  Services:   ${fleet.servicesUnavailable === 'not-running'
      ? 'the task\'s container is not running yet (the first turn builds the agent image; check again in a few minutes)'
      : fleet.servicesUnavailable}`);
  }
  for (const service of fleet.services) {
    const state = service.listening === true ? 'running' : service.listening === false ? 'not answering' : 'unknown';
    console.log(`  Service:    ${service.name} (port ${service.port}) — ${state}`);
  }
  for (const line of fleetHowToBlock(fleet.manifest, fleet.services, fleet.teams)) console.log(`  ${line}`);
  console.log(`\n  Every command above says where it runs: on this host, or inside the guest through \`machine exec\`.`);
}

/**
 * How to drive the demo by hand.
 *
 * One wrapper, not a block of `export` lines. The variables a demo turn needs —
 * the stand-in agent on PATH, the host-runner allowance, the fake credential —
 * are exactly the ones that must NOT outlive the demo: exported into an
 * interactive shell they survive the `cd` out and then apply to every later
 * `lazy` command in every other project, quietly handing a real project a bogus
 * credential and re-enabling a runner that is meant to be unavailable. The
 * wrapper binds them to one invocation instead, and it runs from anywhere.
 */
/** What the demo's project is: the generated fixture, or a cloned repository and its first starter task. */
type DriveItProject = { kind: 'fixture' } | { kind: 'cloned'; firstTask: string | null };

function printDriveItBlock(paths: DemoPaths, project: DriveItProject): void {
  const wrapper = join(paths.root, 'bin', DEMO_WRAPPER_NAME);
  console.log(`\n${theme.header('Drive it')}`);
  console.log(`  ${theme.command(`${wrapper} list --all`)}`);
  if (project.kind === 'cloned') {
    if (project.firstTask) {
      console.log(`  ${theme.command(`${wrapper} start ${project.firstTask}`)}`);
      console.log(`  ${theme.command(`${wrapper} show ${project.firstTask}`)}`);
    }
    console.log(theme.separator(
      '  Turns here run a stand-in agent that spends nothing. For real turns, clone the\n' +
      '  repository yourself and run `lazy init` in it' +
      (project.firstTask ? ' — the starter tasks are in tasks.md.' : '.'),
    ));
  } else {
    console.log(`  ${theme.command(`${wrapper} diff demo-review`)}`);
    console.log(`  ${theme.command(`${wrapper} unblock demo-review -m "looks good, ship it"`)}`);
  }
  console.log(theme.separator(
    '  That wrapper is lazy with everything this playground needs already set, for one',
  ));
  console.log(theme.separator(
    '  command at a time — so your own shell keeps its own environment.',
  ));
}

/**
 * What each seeded task is FOR, keyed by its code.
 *
 * Kept next to the printing rather than in the seed module because it is
 * orientation for a human reading terminal output, not a property of the tasks.
 *
 * A MAP rather than a list of pre-formatted lines, so the relationship to
 * `DEMO_TASK_CODES` is structural: {@link seededTaskSummary} walks the codes and
 * looks each one up, which means a task added to the seed shows up here as a
 * missing entry rather than being silently unmentioned, and the two can no
 * longer disagree about ORDER because only one of them has an order at all.
 * `test/unit/demo-task-summary.test.ts` asserts every code has a description.
 *
 * This replaces a comment that claimed the discoverability test enforced the
 * relationship. It did not — nothing did, and the two lists had already drifted
 * out of order, which is exactly what a real check would have caught.
 */
const SEEDED_TASK_DESCRIPTIONS: Record<string, string> = {
  'demo-backlog': 'backlog — created, never started',
  'demo-conflict': 'blocked — edits the same lines as the accepted task; accepting it conflicts',
  'demo-accepted': 'accepted — merged into main',
  'demo-review': 'blocked — a real diff, two comments, one blocking decision, one follow-up',
  'demo-protected': 'conflict — the turn edited a protected file, so it is held for a decision',
  'demo-working': 'working — its agent is holding a turn open right now',
};

/** The seeded-task lines, in the order the demo creates them. */
export function seededTaskSummary(): string[] {
  const width = Math.max(...DEMO_TASK_CODES.map(code => code.length)) + 2;
  return DEMO_TASK_CODES.map(code => {
    const description = SEEDED_TASK_DESCRIPTIONS[code];
    // A code with no description is a bug in this file, not something to print
    // a blank line for. The unit test catches it first; this is the backstop.
    if (!description) return `${code.padEnd(width)}(no description — see src/cli/commands/demo.ts)`;
    return `${code.padEnd(width)}${description}`;
  });
}

export { SEEDED_TASK_DESCRIPTIONS, DEMO_TASK_CODES };

async function playgroundDown(args: string[]): Promise<void> {
  const parsed = parseFlags(args, DOWN_FLAGS, 'playground down');
  const root = parsed.flags.get('root') as string | undefined;
  await warnAboutLegacyRoot(root);

  const result = await takeDemoEnvironmentDown({
    root,
    report: message => console.log(`  ${theme.separator('·')} ${message}`),
  });

  console.log(result.removed
    ? `${theme.header('Playground torn down')} — ${result.root} is gone.`
    : `Nothing to tear down at ${result.root}.`);
}

async function playgroundStatus(args: string[]): Promise<void> {
  const parsed = parseFlags(args, STATUS_FLAGS, 'playground status');
  const root = parsed.flags.get('root') as string | undefined;
  await warnAboutLegacyRoot(root);

  const status = await readDemoStatus(root);

  if (!status.manifest) {
    console.log(`No playground at ${status.paths.root}.`);
    console.log(`Bring one up with: ${theme.command('lazy playground up')}`);
    return;
  }

  console.log(theme.header('Lazy playground'));
  console.log(`  Root:       ${status.paths.root}`);
  console.log(`  Created:    ${status.manifest.createdAt}`);
  if (!status.fleet) {
    console.log(`  Daemon:     ${status.daemonRunning ? 'running' : theme.separator('not running')}`);
  }

  if (!status.daemonRunning && !status.fleet) {
    // The directory is still there, so this is recoverable — say which way.
    console.log(`\nThe playground's files are still at ${status.paths.root}, but its daemon is gone.`);
    if (status.daemonDetail) {
      console.log(theme.separator(status.daemonDetail.split('\n').map(l => `  ${l}`).join('\n')));
    }
    console.log(`\nRe-provision it with: ${theme.command('lazy playground up')}`);
    return;
  }

  if (status.manifest.dashboardUrl) console.log(`  Dashboard:  ${status.manifest.dashboardUrl}`);
  if (status.loginUrl) {
    console.log(`  Sign in:    ${status.loginUrl}`);
    console.log(theme.separator('              (works once — re-run this command for another)'));
  }
  if (status.manifest.teams) {
    console.log(`  Teams:      ${status.manifest.teams.url}`);
    console.log(`              ${status.manifest.teams.email} / ${status.manifest.teams.password}`);
  }

  if (status.fleet) {
    printFleetStatus(status.fleet);
    return;
  }

  if (status.taskTable) {
    console.log(`\n${theme.header('Tasks')}`);
    console.log(status.taskTable);
  }

  // Repeated here, not only on `up`: the usual reader of `status` is in a
  // fresh shell some time later, which is exactly when the exports are missing
  // and a review action gets refused.
  printDriveItBlock(status.paths, status.manifest.projectRepo
    ? { kind: 'cloned', firstTask: status.manifest.seededTasks[0] ?? null }
    : { kind: 'fixture' });
}

export function playgroundUsage(): void {
  console.log(`Usage: lazy playground <up|down|status> [--root PATH] [--repo URL|PATH] [--teams] [--fleet smolvm]

Provision a throwaway lazy project with a real daemon and tasks in every state,
so agents and humans can exercise the dashboard, the review surfaces, the CLI
and Lazy Teams without touching a real project.

Everything lives under one root (default: ~/.lazy-playground) — the fixture git repo,
its store, the playground daemon's state and the fake agent. Nothing is written to
any real project, and the playground daemon runs on a deliberately fake credential,
so no model API is ever called and nothing is ever spent.

Runs from a lazy SOURCE checkout only. Playground turns need the host-process runner,
which is compiled out of released binaries — a released lazy can create the
project but cannot run a turn in it.

Subcommands:
  up        Provision the playground, replacing any previous one, and print how to reach it
  down      Stop the playground daemon and remove everything it created
  status    Show what is provisioned, whether it is alive, and a fresh sign-in link

Options:
  --root PATH   Use this playground root instead of ~/.lazy-playground
  --teams       Also boot Lazy Teams against the playground and provision the project
                into it (up only)
  --fleet smolvm
                With --teams: run Teams on the REAL smolvm backend instead of its
                stand-in mode — no daemon or agent on this host, the project in a
                microVM, YOUR Claude credential from the shell (CLAUDE_CODE_OAUTH_TOKEN
                or ANTHROPIC_API_KEY), and one real task whose first turn builds the
                agent image inside the guest: a detached server on the repository's
                first [serve] port when its lazy.toml declares one, a plain describe-
                the-repo task when it does not. Needs LAZY_SMOLVM_BINARY and
                LAZY_DAEMON_IMAGE exported, and --repo. "lazy playground status" prints the
                service address (or says the repo serves none); "lazy playground down"
                deletes the machine.
  --repo URL    The repository to use as the project instead of the generated
                fixture. Without --fleet: anything git can clone (a URL or a local
                path); when it is the lazy playground, its starter tasks are
                created in the backlog, and any other repository gets no tasks.
                The clone's origin is removed, so nothing is ever pushed back.
                Commands its lazy.toml declares (post_turn and the like) run
                UNSANDBOXED on this machine when a task runs — only use
                repositories you trust.
                With --fleet: the public git URL the guest clones — checked from
                this machine first with no credentials, because the guest has none
                and reaches only public IP space.
  --memory MIB  With --fleet: the machine's memory budget in MiB (default 4096,
                or LAZY_SMOLVM_MEMORY_MIB from the shell). The daemon, dockerd,
                the agent-image build and the agent container all share it;
                "lazy playground status" prints what the guest is using, so raise it
                from a measurement, not a guess.
  --model NAME  With --fleet: the model the seeded task runs on (haiku, sonnet, opus
                or a model id). Its turn spends real tokens on your account; default
                is the daemon's own.

Examples:
  lazy playground up                  # Provision and print the dashboard link
  lazy playground up --teams          # …and boot Lazy Teams against it
  lazy playground up --repo https://github.com/getlazy/playground.git
                                      # the playground app and its starter tasks
  lazy playground up --teams --fleet smolvm --repo https://github.com/you/some-public-repo.git
                                      # the end-to-end proof: a project in a microVM, one real task
  lazy playground status                    # Fresh sign-in link and the seeded tasks
  lazy playground down                      # Stop the daemon and delete the root`);
}
