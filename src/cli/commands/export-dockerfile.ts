/**
 * `lazy system export-dockerfile` command
 *
 * Writes the embedded default Dockerfile (the one lazy uses to build agent
 * containers when no custom Dockerfile is configured) to disk so the user can
 * customize it and point [docker].dockerfile in lazy.toml at it.
 *
 * The embedded DEFAULT_DOCKERFILE is the single source of truth — this command
 * re-uses it directly, never a copy.
 */

import { writeFile, access } from 'fs/promises';
import { join } from 'path';
import { requireLazyRoot } from '../helpers';
import { parseFlags } from '../helpers';
import { writeStdout } from '../../utils/stdio';
import { isTTY, promptYesNo } from '../editor';
import { theme } from '../theme';
import { DEFAULT_DOCKERFILE } from '../../capture/claude';

const DEFAULT_OUTPUT = 'Dockerfile.lazy';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function commandExportDockerfile(args: string[]): Promise<void> {
  const parsed = parseFlags(
    args,
    [
      { name: 'force', aliases: ['f'], takesValue: false },
      { name: 'output', aliases: ['o'], takesValue: true },
      { name: 'stdout', takesValue: false },
    ],
    'system export-dockerfile'
  );

  const output = parsed.flags.get('output') as string | undefined;
  const stdout = parsed.flags.get('stdout') === true || output === '-';

  // stdout mode: print the Dockerfile and write nothing.
  if (stdout) {
    // Drained write, not a bare process.stdout.write: this is bulk output and
    // the CLI calls process.exit() immediately after, which on a pipe
    // (`lazy export-dockerfile --stdout | docker build -f - .`) drops whatever
    // is still queued. See src/utils/stdio.ts.
    await writeStdout(DEFAULT_DOCKERFILE);
    return;
  }

  const root = requireLazyRoot();
  const targetName = output ?? DEFAULT_OUTPUT;
  const targetPath = join(root, targetName);
  const force = parsed.flags.get('force') === true;

  if (await fileExists(targetPath)) {
    let overwrite = force;
    if (!overwrite && isTTY()) {
      overwrite = await promptYesNo(`${targetName} already exists. Overwrite?`, false);
    }
    if (!overwrite) {
      console.error(`Error: ${targetName} already exists. Refusing to overwrite.`);
      console.error(`  Re-run with ${theme.command('--force')} to overwrite, or use ${theme.command('--stdout')} to inspect without writing.`);
      process.exit(1);
    }
  }

  await writeFile(targetPath, DEFAULT_DOCKERFILE, 'utf-8');

  console.log(theme.success(`Wrote default Dockerfile to ${targetName}`));
  console.log('');
  console.log('  Customize it, then wire it up in lazy.toml:');
  console.log('');
  console.log('    [docker]');
  console.log(`    dockerfile = "${targetName}"`);
  console.log('');
  console.log(`  Lazy will rebuild the agent image from your Dockerfile on the next task run.`);
}

export function exportDockerfileUsage(): void {
  console.log(`Usage: lazy system export-dockerfile [options]

Write the embedded default Dockerfile (used to build agent containers) to disk
so you can customize it. Output defaults to ${DEFAULT_OUTPUT} in the project root.

This does NOT modify lazy.toml — after editing, point [docker].dockerfile at the
file yourself.

Options:
  -o, --output <path>   Write to <path> instead of ${DEFAULT_OUTPUT}
      --stdout          Print to stdout instead of writing a file (also: -o -)
  -f, --force           Overwrite the target file if it already exists

Examples:
  lazy system export-dockerfile                 # Write ${DEFAULT_OUTPUT}
  lazy system export-dockerfile --force         # Overwrite an existing file
  lazy system export-dockerfile --stdout        # Inspect without writing
  lazy system export-dockerfile -o custom.Dockerfile`);
}
