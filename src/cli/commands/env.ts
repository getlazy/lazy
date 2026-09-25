/**
 * `lazy env <subcommand>` — per-task environment variables.
 *
 * Give ONE task an API token without exposing it to every other task. The
 * value is held on the host in the daemon's own 0600 state file for the task's
 * lifetime and injected into the agent's process/container at every launch;
 * it never enters task state, turns, prompts, comments, the journal, or a log
 * line. See src/daemon/task-env.ts for where it lives and why.
 *
 * The one rule this command obeys everywhere: it PRINTS KEYS, NEVER VALUES.
 * `lazy env list` on a task with a live token must be safe to paste into a bug
 * report, so there is deliberately no `get` subcommand and no `--show-values`
 * flag — if you need the value back, it is in the place you got it from.
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { parseFlags } from '../helpers';
import { promptSecret, isTTY } from '../editor';
import { queryTaskEnv } from '../../daemon/rpc-fallback';
import { parseEnvAssignment, parseEnvFile, validateTaskEnvKey } from '../../daemon/task-env';
import { theme } from '../../render/theme';

/**
 * Statuses where a container/process for the task may already be running.
 *
 * Docker fixes a container's environment at creation time (`docker run -e`) and
 * lazy reuses a live supervisor container across turns, so a change made now
 * reaches the agent at the NEXT launch, not this instant. Saying so is the
 * difference between "lazy is broken" and "one more step" — see the
 * principle-of-least-surprise rule in CLAUDE.md.
 */
const LIVE_STATUSES = new Set(['working', 'queued']);

function warnIfLive(status: string, displayId: string): void {
  if (!LIVE_STATUSES.has(status)) return;
  console.log(theme.warning(
    `\nTask ${displayId} is ${status} — its agent is already running with the previous environment.\n` +
    `The change takes effect at the next launch (e.g. after the agent blocks and you unblock it).`,
  ));
}

/**
 * Collect KEY=VALUE assignments from CLI specs, an optional --env-file, and
 * (for a bare KEY on a TTY) a no-echo prompt.
 *
 * Shared with `lazy start --env/--env-file` so the two surfaces cannot drift in
 * what they accept or in how a bare KEY is prompted for.
 */
export async function collectTaskEnvVars(
  specs: string[],
  envFile: string | undefined,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  if (envFile) {
    const path = resolve(envFile);
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err) {
      // A missing env file is the user's typo, not a "no variables" condition:
      // proceeding would launch the agent without the token it needs and fail
      // much later, inside the container, as an unexplained 401.
      throw new Error(`Cannot read env file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    Object.assign(vars, parseEnvFile(text, path));
  }

  for (const spec of specs) {
    if (spec.includes('=')) {
      const { key, value } = parseEnvAssignment(spec);
      vars[key] = value;
      continue;
    }
    // A bare KEY means "ask me for the value with echo off". This is the
    // recommended form for a real secret: `--env KEY=VALUE` on a command line
    // lands in shell history AND in the process table, where any other user on
    // the machine can read it with `ps`.
    validateTaskEnvKey(spec);
    if (!isTTY()) {
      throw new Error(
        `No value given for '${spec}'. Pass ${spec}=VALUE, use --env-file, ` +
        `or run this from a terminal to be prompted for the value without echoing it.`,
      );
    }
    vars[spec] = await promptSecret(`Value for ${spec}`);
  }

  return vars;
}

async function commandEnvSet(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'env-file', aliases: ['f'], takesValue: true },
  ], 'env set');

  const taskRef = parsed.positional[0];
  if (!taskRef) {
    console.error('Task ID required. Usage: lazy env set <task_id> KEY=VALUE [KEY=VALUE ...]');
    process.exit(1);
  }
  const specs = parsed.positional.slice(1);
  const envFile = parsed.flags.get('env-file') as string | undefined;

  if (specs.length === 0 && !envFile) {
    console.error('Nothing to set. Pass KEY=VALUE pairs, a bare KEY to be prompted, or --env-file <path>.');
    process.exit(1);
  }

  const vars = await collectTaskEnvVars(specs, envFile);
  if (Object.keys(vars).length === 0) {
    console.error(`No variables found${envFile ? ` in ${envFile}` : ''}.`);
    process.exit(1);
  }

  const result = await queryTaskEnv({ action: 'set', taskId: taskRef, vars });
  const changed = result.changed ?? [];
  console.log(theme.success(
    `Set ${changed.length} variable${changed.length === 1 ? '' : 's'} for task ${result.displayId}: ${changed.join(', ')}`,
  ));
  console.log(theme.separator('Values are held on this host only, and are deleted when the task ends.'));
  warnIfLive(result.status, result.displayId);
}

async function commandEnvList(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'env list');
  const taskRef = parsed.positional[0];
  if (!taskRef) {
    console.error('Task ID required. Usage: lazy env list <task_id>');
    process.exit(1);
  }

  const result = await queryTaskEnv({ action: 'list', taskId: taskRef });
  if (result.keys.length === 0) {
    console.log(`No environment variables set for task ${result.displayId}.`);
    return;
  }
  console.log(theme.header(`Environment variables for task ${result.displayId}:`));
  for (const key of result.keys) console.log(`  ${key}`);
  console.log(theme.separator('\nValues are never printed. Re-run `lazy env set` to change one.'));
}

async function commandEnvUnset(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'env unset');
  const taskRef = parsed.positional[0];
  const keys = parsed.positional.slice(1);
  if (!taskRef || keys.length === 0) {
    console.error('Usage: lazy env unset <task_id> KEY [KEY ...]');
    process.exit(1);
  }

  const result = await queryTaskEnv({ action: 'unset', taskId: taskRef, keys });
  const removed = (result.removed as string[] | undefined) ?? [];
  if (removed.length === 0) {
    console.log(`Nothing removed — task ${result.displayId} has none of: ${keys.join(', ')}`);
    return;
  }
  console.log(theme.success(`Removed ${removed.join(', ')} from task ${result.displayId}.`));
  warnIfLive(result.status, result.displayId);
}

async function commandEnvClear(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'env clear');
  const taskRef = parsed.positional[0];
  if (!taskRef) {
    console.error('Task ID required. Usage: lazy env clear <task_id>');
    process.exit(1);
  }

  const result = await queryTaskEnv({ action: 'clear', taskId: taskRef });
  const count = (result.removed as number | undefined) ?? 0;
  console.log(count === 0
    ? `Task ${result.displayId} had no environment variables.`
    : theme.success(`Cleared ${count} variable${count === 1 ? '' : 's'} from task ${result.displayId}.`));
  warnIfLive(result.status, result.displayId);
}

export async function commandEnv(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand) {
    envUsage();
    process.exit(1);
  }

  const sub = args.slice(1);
  try {
    switch (subcommand) {
      case 'set':
        await commandEnvSet(sub);
        break;
      case 'list':
      case 'ls':
        await commandEnvList(sub);
        break;
      case 'unset':
      case 'rm':
        await commandEnvUnset(sub);
        break;
      case 'clear':
        await commandEnvClear(sub);
        break;
      default:
        console.error(`Unknown subcommand: env ${subcommand}`);
        envUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function envSetUsage(): void {
  console.log(`Usage: lazy env set <task_id> KEY=VALUE [KEY=VALUE ...] [--env-file <path>]

Give one task an environment variable. The value is injected into that task's
agent process/container at every launch — start, unblock, sync, and automatic
resumes — and into no other task.

Prefer the bare-KEY form for real secrets:

  lazy env set my-task STRIPE_API_KEY        # prompts, echo off

A value typed as KEY=VALUE is visible in your shell history and, while the
command runs, in the process table to every other user on this machine.

Arguments:
  <task_id>          Task to set the variable on (short hex prefix or task code)
  KEY=VALUE          Variable to set. Repeatable.
  KEY                Variable whose value you will be prompted for (echo off)

Options:
  -f, --env-file <path>  Read KEY=VALUE lines from a dotenv-style file

Storage: values live only on this host, in the daemon's own 0600 state file
(never in the project, never in task state, turns, prompts, or logs), and are
deleted when the task is accepted, rejected, or closed.`);
}

export function envListUsage(): void {
  console.log(`Usage: lazy env list <task_id>

List the names of a task's environment variables. Values are never printed —
there is no way to read one back out of lazy, by design.

Arguments:
  <task_id>          Task to inspect (short hex prefix or task code)`);
}

export function envUnsetUsage(): void {
  console.log(`Usage: lazy env unset <task_id> KEY [KEY ...]

Remove named environment variables from a task. Takes effect at the task's
next launch.

Arguments:
  <task_id>          Task to modify (short hex prefix or task code)
  KEY                Variable name to remove. Repeatable.`);
}

export function envClearUsage(): void {
  console.log(`Usage: lazy env clear <task_id>

Remove every environment variable from a task. Takes effect at the task's next
launch. Running this is not required at the end of a task — accept, reject and
close each clear the task's variables automatically.

Arguments:
  <task_id>          Task to clear (short hex prefix or task code)`);
}

/**
 * Usage functions for `lazy env <subcommand>`, keyed by subcommand name.
 *
 * The dispatcher in src/index.ts intercepts -h/--help before the command runs,
 * so a subcommand's own usage is only reachable if it is listed here — without
 * this map `lazy env set -h` prints the parent's usage.
 */
export const envSubcommandUsage: Record<string, () => void> = {
  'set': envSetUsage,
  'list': envListUsage,
  'ls': envListUsage,
  'unset': envUnsetUsage,
  'rm': envUnsetUsage,
  'clear': envClearUsage,
};

export function envUsage(): void {
  console.log(`Usage: lazy env <subcommand> [options]

Per-task environment variables — give ONE task an API token or endpoint without
exposing it to every other task.

Values are held on this host only, in the daemon's own 0600 state file. They are
never written to task state, turns, prompts, comments, the journal, or any log,
are redacted from debug output, and are deleted when the task reaches a terminal
state. Nothing in lazy will print a value back to you.

For a variable every task should get, use your shell environment or the agent
image instead — this is the per-task granularity.

Subcommands:
  set      Set one or more variables on a task
  list     List a task's variable NAMES (never values)
  unset    Remove named variables from a task
  clear    Remove every variable from a task

Examples:
  lazy env set my-task STRIPE_API_KEY          # prompts for the value, echo off
  lazy env set my-task API_BASE=https://x.test # non-secret value inline
  lazy env set my-task --env-file ./task.env
  lazy env list my-task
  lazy env unset my-task STRIPE_API_KEY

You can also set variables while starting a task:
  lazy start my-task --env STRIPE_API_KEY --env-file ./task.env

Run 'lazy env <subcommand> --help' for details on any subcommand.`);
}
