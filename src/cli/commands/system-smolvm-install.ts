/**
 * `lazy system smolvm-install` — download the smolvm release lazy pins,
 * verify it against the pinned digest, install it under ~/.lazy/smolvm/, and
 * point this project's `[smolvm] binary` at it. Works from an installed lazy:
 * no source checkout needed.
 */
import { readFile, writeFile } from 'fs/promises';
import { parseFlags } from '../helpers';
import { isTTY, promptYesNo } from '../editor';
import { getHome } from '../../utils/home';
import { findLazyRoot } from '../../project-paths';
import { resolveConfigPath } from '../../config/loader';
import { setSectionString } from '../../config/toml-edit';
import { SMOLVM_RELEASE } from '../../vm/smolvm-docker-machine';
import { smolvmPlatform } from '../../vm/smolvm-release';
import { installSmolvm } from '../../vm/smolvm-install';

export async function commandSystemSmolvmInstall(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'release-base', takesValue: true },
  ], 'system smolvm-install');
  const yes = parsed.flags.get('yes') === true;
  const releaseBase = parsed.flags.get('release-base') as string | undefined;

  const triple = smolvmPlatform();
  if (!triple || !SMOLVM_RELEASE.archiveSha256[triple]) {
    console.error(`Error: smolvm ${SMOLVM_RELEASE.version} has no pinned build for ${process.platform}/${process.arch} ` +
      `(pinned: ${Object.keys(SMOLVM_RELEASE.archiveSha256).join(', ')}). An Intel Mac cannot run smolvm.`);
    process.exit(1);
  }

  let launcher: string;
  try {
    ({ launcher } = await installSmolvm({
      home: getHome(),
      platformTriple: triple,
      releaseBase,
      say: (line) => console.log(line),
    }));
  } catch (err) {
    console.error(`smolvm-install: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log('');
  console.log('Set this in lazy.toml:');
  console.log(`  [smolvm]\n  binary = "${launcher}"`);

  const root = findLazyRoot();
  if (!root) return;
  const configPath = await resolveConfigPath(root);
  let content: string;
  try { content = await readFile(configPath, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const current = ((Bun.TOML.parse(content) as { smolvm?: { binary?: unknown } }).smolvm?.binary ?? '') as string;
  if (current === launcher) {
    console.log(`${configPath} already points [smolvm] binary at it.`);
    return;
  }
  if (!yes) {
    if (!isTTY()) {
      console.log(`Not changing ${configPath} without a terminal; re-run with --yes to write it.`);
      return;
    }
    const replacing = current ? ` (replacing ${current})` : '';
    if (!(await promptYesNo(`Set [smolvm] binary in ${configPath}${replacing}?`, true))) return;
  }
  await writeFile(configPath, setSectionString(content, 'smolvm', 'binary', launcher));
  console.log(`Set [smolvm] binary in ${configPath}.`);
}

export function systemSmolvmInstallUsage(): void {
  console.log(`Usage: lazy system smolvm-install [options]

Download the smolvm release lazy pins (${SMOLVM_RELEASE.version}) for this machine,
verify it against the pinned SHA-256 digest, and install it under
~/.lazy/smolvm/${SMOLVM_RELEASE.version}/. Prints the launcher path for
[smolvm] binary and, inside a project, offers to write it to lazy.toml.

Running it again is safe: an install that still verifies is left alone, and a
damaged one is replaced. A download whose digest does not match the pin is
deleted and nothing is installed.

Options:
  -y, --yes                Write [smolvm] binary to this project's lazy.toml without asking
  --release-base <url>     Download from this mirror instead of GitHub releases
                           (the pinned digest is still checked)

Examples:
  lazy system smolvm-install
  lazy system smolvm-install --yes`);
}
