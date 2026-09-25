/**
 * `lazy scratch <subcommand>` — the human's hands on the builder scratch sandbox.
 *
 * The live sandbox is a plain directory (`$LAZY_SCRATCH_DIR`, see
 * src/builder/scratch.ts) that builders write with ordinary tools. The builder
 * supervisor CAPTURES it into the project store on its regular cadence, so the
 * artifacts outlive the host, travel with the project, and are readable by later
 * builders and by this command.
 *
 * Subcommands:
 *   list             — captured files, newest first (default)
 *   show <path>      — one captured file's content
 *   sync             — capture the live dir now, without waiting for a builder
 *   rm <path>        — drop a captured file from the store (the disk file stays)
 *   path             — print the live scratch dir
 */

import { requireStorage, requireLazyRoot, parseFlags } from '../helpers';
import { formatDate } from '../../utils/format';
import { promptYesNo } from '../editor';
import { theme } from '../../render/theme';
import { getActor } from '../../constants';
import {
  resolveScratchDirForCapture,
  scratchDirSize,
  formatScratchBytes,
} from '../../builder/scratch';
import { syncScratchDir } from '../../builder/scratch-sync';
import {
  MAX_SCRATCH_FILE_BYTES,
  MAX_SCRATCH_SANDBOX_BYTES,
  formatBytes,
} from '../../builder/scratch-limits';

export async function commandScratch(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case undefined:
    case 'list':
    case 'ls':
      await commandScratchList(subArgs);
      break;
    case 'show':
    case 'read':
    case 'cat':
      await commandScratchShow(subArgs);
      break;
    case 'sync':
      await commandScratchSync(subArgs);
      break;
    case 'rm':
    case 'remove':
      await commandScratchRemove(subArgs);
      break;
    case 'path':
      await commandScratchPath(subArgs);
      break;
    default:
      console.error(`Unknown scratch subcommand: ${subcommand}`);
      scratchUsage();
      process.exit(1);
  }
}

export const scratchSubcommandUsage: Record<string, () => void> = {
  'list': scratchUsage,
  'show': scratchUsage,
  'sync': scratchUsage,
  'rm': scratchUsage,
  'path': scratchUsage,
};

// --- list ---

async function commandScratchList(args: string[]): Promise<void> {
  parseFlags(args, [], 'scratch');

  const storage = await requireStorage();
  try {
    const files = await storage.listScratchFiles();
    if (files.length === 0) {
      console.log('No captured builder scratch files yet.');
      console.log(
        `Builders write into ${theme.command('$LAZY_SCRATCH_DIR')}; capture persists it. ` +
        `Capture now with: ${theme.command('lazy scratch sync')}`,
      );
      return;
    }

    console.log(`${files.length} captured scratch file(s):\n`);
    console.log(
      `${theme.header('PATH'.padEnd(44))} ${theme.header('SIZE'.padEnd(10))} ` +
      `${theme.header('UPDATED'.padEnd(18))} ${theme.header('STATE')}`,
    );
    for (const f of files) {
      // A skipped record exists on purpose: knowing the artifact is there, and
      // that lazy declined to persist its body, beats it vanishing silently.
      const state = f.skipped ? `${f.skipped} (content on disk only)` : 'stored';
      console.log(
        `${f.path.padEnd(44)} ${formatBytes(f.size).padEnd(10)} ` +
        `${formatDate(f.updated_at).padEnd(18)} ${state}`,
      );
    }
    console.log(`\nRead one with: ${theme.command('lazy scratch show <path>')}`);
    console.log(`Search inside them with: ${theme.command("lazy search 'in:scratch <text>'")}`);
  } finally {
    await storage.close();
  }
}

// --- show ---

async function commandScratchShow(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'scratch');
  const path = parsed.positional[0];
  if (!path) {
    console.error('Usage: lazy scratch show <path>');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const file = await storage.getScratchFile(path);
    if (!file) {
      console.error(`No captured scratch file at '${path}'. List them with: lazy scratch list`);
      process.exit(1);
    }
    if (file.skipped) {
      // Not an error — the record is the answer. Say why the body is missing
      // and where it still is, rather than printing an empty file.
      console.error(
        `'${file.path}' was captured by name only (${file.skipped}): ${formatBytes(file.size)} on disk.\n` +
        `Its content is not in the store. Read it from the live scratch dir instead.`,
      );
      process.exit(1);
    }
    process.stdout.write(file.content.endsWith('\n') ? file.content : `${file.content}\n`);
  } finally {
    await storage.close();
  }
}

// --- sync ---

async function commandScratchSync(args: string[]): Promise<void> {
  parseFlags(args, [], 'scratch');

  const root = requireLazyRoot();
  const dir = resolveScratchDirForCapture(root);
  const storage = await requireStorage();
  try {
    console.log(`Capturing ${dir} ...`);
    const result = await syncScratchDir({ scratchDir: dir, storage, actor: getActor() });

    for (const warning of result.warnings) console.warn(theme.warning(warning));

    console.log(
      `Stored ${result.stored.length} file(s), skipped ${result.skipped.length}, ` +
      `${result.unchanged} unchanged.`,
    );
    if (result.stored.length > 0) {
      console.log(`Read one with: ${theme.command('lazy scratch show <path>')}`);
    }
  } finally {
    await storage.close();
  }
}

// --- rm ---

async function commandScratchRemove(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'scratch');
  const path = parsed.positional[0];
  if (!path) {
    console.error('Usage: lazy scratch rm <path>');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const file = await storage.getScratchFile(path);
    if (!file) {
      console.error(`No captured scratch file at '${path}'. List them with: lazy scratch list`);
      process.exit(1);
    }

    if (parsed.flags.get('yes') !== true) {
      // The live file on disk is untouched, so say so — otherwise this reads as
      // "delete the artifact", which it is not.
      const ok = await promptYesNo(
        `Remove '${file.path}' from the store? The file in the live scratch dir is not touched.`,
        false,
      );
      if (!ok) {
        console.log('Cancelled.');
        return;
      }
    }

    await storage.deleteScratchFile(file.path);
    console.log(`Removed '${file.path}' from the store.`);
    console.log(
      'It will be captured again on the next sync unless you also delete it from the live scratch dir ' +
      `(${theme.command('lazy scratch path')}).`,
    );
  } finally {
    await storage.close();
  }
}

// --- path ---

async function commandScratchPath(args: string[]): Promise<void> {
  parseFlags(args, [], 'scratch');

  const root = requireLazyRoot();
  const dir = resolveScratchDirForCapture(root);
  const { bytes, entries } = await scratchDirSize(dir);
  console.log(dir);
  console.error(`${entries} top-level entr(y|ies), ${formatScratchBytes(bytes)} on disk.`);
}

export function scratchUsage(): void {
  console.log(`Usage: lazy scratch <subcommand>

Read the builder scratch sandbox. Builders write artifacts — review messages,
analysis dumps, drafts — into \$LAZY_SCRATCH_DIR, a plain directory outside the
repo. Lazy captures that directory into the PROJECT STORE, so the artifacts
outlive the host, travel with the project, and are readable by later builders.

Subcommands:
  list                     Show captured files, newest first (default)
  show <path>              Print one captured file's content
  sync                     Capture the live scratch dir now
  rm <path>                Drop a captured file from the store
  path                     Print the live scratch dir

Options:
  -y, --yes                (rm) Skip the confirmation prompt

Capture runs automatically on the builder supervisor's cadence and on exit, so
\`sync\` is only needed to capture immediately. It never deletes: removing a file
from the live dir leaves the captured copy in place — use \`rm\` for that.

Bounds: files over ${formatBytes(MAX_SCRATCH_FILE_BYTES)}, non-UTF-8 (binary) files, and anything past the
${formatBytes(MAX_SCRATCH_SANDBOX_BYTES)} sandbox budget are recorded BY NAME ONLY, with a warning naming the
file. Content is stored whole or not at all — never silently truncated — and the
body always stays readable in the live scratch dir.

Search inside captured content with: lazy search 'in:scratch <text>'
Builders read the same files through the lazy_scratch MCP tool. Task agents
cannot: scratch is an exchange channel between the builder and the human.
`);
}
