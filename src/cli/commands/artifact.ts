/**
 * `lazy artifact <subcommand>` — attach files to a task, and retrieve the files
 * a task published back.
 *
 * An artifact is a named file attached to a task. Inputs are handed to the agent
 * by materializing them into its worktree at the start of every turn (see
 * `materializeArtifacts` in src/utils/sandbox.ts); outputs are files the agent
 * published back with `lazy_artifact_add`, retrievable here without digging
 * through a worktree that may already be gone.
 *
 * This replaces the pre-artifact smuggle — pasting file bodies into a comment
 * under an `=== FILE: path ===` header — which had no integrity, no binary
 * support, a size limit, and polluted the comment stream.
 *
 * INVARIANT: attaching an artifact is a PASSIVE write. It never starts a turn,
 * never changes task status, and never triggers auto-react — the same rule
 * follow-ups and journal entries follow. The agent sees artifacts on its NEXT
 * turn; to make it act on them now, unblock it with feedback.
 *
 * Subcommands:
 *   add <task> <file...>  — attach files (replaces by name)
 *   list <task>           — names, sizes, origin (default)
 *   get <task> <name>     — write one artifact to stdout or -o <path>
 *   rm <task> <name>      — detach one artifact
 */

import { basename, join, resolve, relative, isAbsolute } from 'path';
import { formatDate } from '../../utils/format';
import { displayId } from '../../task/identity';
import { readFile, writeFile, stat, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { theme } from '../../render/theme';
import { docsFooter } from '../../docs/links';
import { getActor } from '../../constants';
import { writeStdout } from '../../utils/stdio';
import {
  MAX_ARTIFACT_BYTES,
  MAX_TASK_ARTIFACT_BYTES,
  MAX_TASK_ARTIFACT_COUNT,
  formatArtifactBytes,
} from '../../artifacts/limits';
import { normalizeArtifactName } from '../../artifacts/name';

export async function commandArtifact(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  // No implicit default subcommand: `lazy artifact <task>` would have to guess
  // that a bare argument means "list", and a task whose code is `get` or `rm`
  // would then mean two things at once. Say what you want.
  if (subcommand === undefined) {
    artifactUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case 'list':
    case 'ls':
      await commandArtifactList(subArgs);
      break;
    case 'add':
    case 'attach':
      await commandArtifactAdd(subArgs);
      break;
    case 'get':
    case 'cat':
      await commandArtifactGet(subArgs);
      break;
    case 'rm':
    case 'remove':
      await commandArtifactRemove(subArgs);
      break;
    default:
      console.error(`Unknown artifact subcommand: ${subcommand}`);
      artifactUsage();
      process.exit(1);
  }
}

export const artifactSubcommandUsage: Record<string, () => void> = {
  'list': artifactUsage,
  'add': artifactUsage,
  'get': artifactUsage,
  'rm': artifactUsage,
};

// --- add ---

async function commandArtifactAdd(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'name', aliases: ['n'], takesValue: true },
    { name: 'origin', takesValue: true },
  ], 'artifact');

  const taskRef = parsed.positional[0];
  const files = parsed.positional.slice(1);
  if (!taskRef || files.length === 0) {
    console.error('Usage: lazy artifact add <task> <file...> [--name <name>]');
    process.exit(1);
  }

  const nameOverride = parsed.flags.get('name') as string | undefined;
  if (nameOverride !== undefined && files.length > 1) {
    console.error('--name applies to a single file; pass one file, or omit --name to keep each file\'s own name.');
    process.exit(1);
  }

  const originFlag = parsed.flags.get('origin') as string | undefined;
  if (originFlag !== undefined && originFlag !== 'input' && originFlag !== 'output') {
    console.error(`Invalid --origin '${originFlag}'. Use 'input' (default) or 'output'.`);
    process.exit(1);
  }
  const origin = (originFlag ?? 'input') as 'input' | 'output';

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);

    // PRE-FLIGHT: read and validate every file before writing any of them, so a
    // bad path or an oversized file in the middle of the list does not leave a
    // half-attached set behind.
    const staged: { name: string; content_base64: string }[] = [];
    for (const file of files) {
      const path = resolve(file);
      let info;
      try {
        info = await stat(path);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          console.error(`No such file: ${file}`);
        } else {
          console.error(`Cannot read ${file}: ${e.message}`);
        }
        process.exit(1);
      }
      if (info!.isDirectory()) {
        console.error(`${file} is a directory. Artifacts are single files — pass the files inside it.`);
        process.exit(1);
      }
      if (info!.size > MAX_ARTIFACT_BYTES) {
        console.error(
          `${file} is ${formatArtifactBytes(info!.size)}, over the ${formatArtifactBytes(MAX_ARTIFACT_BYTES)} ` +
          `per-artifact limit. Artifacts are inputs and outputs, not a blob store.`,
        );
        process.exit(1);
      }
      const bytes = await readFile(path);
      staged.push({
        name: normalizeArtifactName(nameOverride ?? artifactNameFor(file)),
        content_base64: bytes.toString('base64'),
      });
    }

    for (const item of staged) {
      const existing = await storage.getTaskArtifact(task.id, item.name);
      const artifact = await storage.createTaskArtifact(
        task.id,
        { name: item.name, content_base64: item.content_base64, origin },
        getActor(),
      );
      console.log(
        `${existing ? 'Replaced' : 'Attached'} ${theme.command(artifact.name)} ` +
        `(${formatArtifactBytes(artifact.size)}, ${artifact.mime_type}) on ${displayId(task)}`,
      );
    }

    console.log(
      `\nThe task's agent will find ${staged.length === 1 ? 'it' : 'them'} in ` +
      `.lazy-task-sandbox/artifacts/ on its next turn. Attaching does not start one — ` +
      `use ${theme.command(`lazy unblock ${taskRef}`)} for that.`,
    );
  } finally {
    await storage.close();
  }
}

/**
 * Artifact name for a file path given on the command line.
 *
 * A relative path is kept as-is so `lazy artifact add t design/button.html`
 * lands at `design/button.html` in the worktree — the shape the human already
 * has on disk. An absolute path (or one escaping upward) collapses to its
 * basename: there is no sensible directory to preserve.
 */
function artifactNameFor(file: string): string {
  if (isAbsolute(file)) return basename(file);
  const rel = relative('.', file);
  if (rel.startsWith('..')) return basename(file);
  return rel;
}

// --- list ---

async function commandArtifactList(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'artifact');
  const taskRef = parsed.positional[0];
  if (!taskRef) {
    console.error('Usage: lazy artifact list <task>');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    const artifacts = await storage.listTaskArtifacts(task.id);
    if (artifacts.length === 0) {
      console.log(`No artifacts on ${displayId(task)}.`);
      console.log(`Attach one with: ${theme.command(`lazy artifact add ${taskRef} <file>`)}`);
      return;
    }

    const total = artifacts.reduce((sum, a) => sum + a.size, 0);
    console.log(`${artifacts.length} artifact(s) on ${displayId(task)} — ${formatArtifactBytes(total)} of ` +
      `${formatArtifactBytes(MAX_TASK_ARTIFACT_BYTES)}, ${MAX_TASK_ARTIFACT_COUNT - artifacts.length} slot(s) left:\n`);
    console.log(`${theme.header('NAME'.padEnd(40))} ${theme.header('SIZE'.padEnd(10))} ${theme.header('ORIGIN'.padEnd(7))} ${theme.header('ATTACHED')}`);
    for (const a of artifacts) {
      console.log(
        `${a.name.padEnd(40)} ${formatArtifactBytes(a.size).padEnd(10)} ${a.origin.padEnd(7)} ` +
        `${formatDate(a.created_at)} by ${a.created_by}`,
      );
    }
    console.log(`\nRead one with: ${theme.command(`lazy artifact get ${taskRef} <name> -o <path>`)}`);
  } finally {
    await storage.close();
  }
}

// --- get ---

async function commandArtifactGet(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'output', aliases: ['o'], takesValue: true },
  ], 'artifact');

  const taskRef = parsed.positional[0];
  const name = parsed.positional[1];
  if (!taskRef || !name) {
    console.error('Usage: lazy artifact get <task> <name> [-o <path>]');
    process.exit(1);
  }

  const output = parsed.flags.get('output') as string | undefined;

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    const artifact = await storage.getTaskArtifact(task.id, name);
    if (!artifact) {
      console.error(`No artifact named '${name}' on ${displayId(task)}. List them with: lazy artifact list ${taskRef}`);
      process.exit(1);
    }

    const bytes = Buffer.from(artifact.content_base64, 'base64');
    if (output) {
      const dest = resolve(output);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      console.log(`Wrote ${artifact.name} (${formatArtifactBytes(artifact.size)}) to ${dest}`);
      return;
    }

    if (artifact.binary) {
      console.error(
        `${artifact.name} is binary (${artifact.mime_type}, ${formatArtifactBytes(artifact.size)}). ` +
        `Write it to a file instead: lazy artifact get ${taskRef} ${name} -o <path>`,
      );
      process.exit(1);
    }
    // writeStdout, not console.log: a large artifact printed with console.log
    // followed by process.exit truncates at 64KB on a pipe.
    await writeStdout(bytes.toString('utf-8'));
  } finally {
    await storage.close();
  }
}

// --- rm ---

async function commandArtifactRemove(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'artifact');
  const taskRef = parsed.positional[0];
  const name = parsed.positional[1];
  if (!taskRef || !name) {
    console.error('Usage: lazy artifact rm <task> <name>');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    const removed = await storage.deleteTaskArtifact(task.id, name);
    if (!removed) {
      console.error(`No artifact named '${name}' on ${displayId(task)}.`);
      process.exit(1);
    }
    console.log(`Removed artifact '${name}' from ${displayId(task)}.`);
  } finally {
    await storage.close();
  }
}

export function artifactUsage(): void {
  console.log(`Usage: lazy artifact <subcommand>

Attach files to a task, and retrieve files a task published back. An artifact is
a named file stored with the task — no smuggling file content through comments.

Subcommands:
  list <task>              List a task's artifacts
  add <task> <file...>     Attach one or more files (replaces by name)
  get <task> <name>        Print an artifact, or write it with -o
  rm <task> <name>         Detach one artifact

Options:
  -n, --name <name>        (add) Store under this name instead of the file's own
      --origin <origin>    (add) 'input' (default) or 'output'
  -o, --output <path>      (get) Write to this path instead of stdout

Delivery: a task's artifacts are written into its worktree at
${'`'}.lazy-task-sandbox/artifacts/${'`'} at the start of every turn, and the agent's prompt
carries their names and sizes — never their content. That directory is gitignored
and excluded from the task's diff, and it is rewritten each turn from the store,
so it is a mirror and not a workspace.

Attaching is PASSIVE: it never starts a turn, changes status, or triggers
auto-react. The agent sees new artifacts on its next turn — use ${'`'}lazy unblock${'`'} to
make it act on them now.

Bounds: ${formatArtifactBytes(MAX_ARTIFACT_BYTES)} per artifact, ${formatArtifactBytes(MAX_TASK_ARTIFACT_BYTES)} and ${MAX_TASK_ARTIFACT_COUNT} artifacts per task.
Artifacts are inputs and outputs, not a blob store. One name, one artifact —
re-attaching a name replaces it; there is no versioning.

Agents attach their own outputs with the ${'`'}lazy_artifact_add${'`'} MCP tool. There is
deliberately no MCP remove — see docs/surface-asymmetries.md.

Examples:
  lazy artifact add my-task design/button.html design/tokens.json
  lazy artifact add my-task ~/Downloads/mock.png --name mocks/home.png
  lazy artifact list my-task
  lazy artifact get my-task design/button.html
  lazy artifact get my-task report.pdf -o ./report.pdf
  lazy artifact rm my-task mocks/home.png${docsFooter('artifacts')}`);
}
