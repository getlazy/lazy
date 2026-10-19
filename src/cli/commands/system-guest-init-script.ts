/**
 * `lazy system guest-init-script` — write out the lazy-guest-init this binary
 * carries and print its path.
 *
 * The daemon image's /usr/local/bin/lazy-guest-init is a shim that runs
 * `exec sh "$(lazy system guest-init-script)" "$@"`, so the script a machine
 * runs is always the one embedded in its CURRENT lazy binary — an in-place
 * swap upgrades it with no new guest ABI. Project-free (no preflight, no
 * daemon): the shim runs it before any daemon exists.
 */
import { parseFlags } from '../helpers';
import { guestInitId, materializeGuestInit } from '../../guest/guest-init';

export async function commandSystemGuestInitScript(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'id', takesValue: false },
    { name: 'run-dir', takesValue: true },
  ], 'system guest-init-script');

  if (parsed.flags.get('id') === true) {
    console.log(guestInitId());
    return;
  }
  const runDir = (parsed.flags.get('run-dir') as string | undefined) ?? process.env.LAZY_GUEST_RUN_DIR ?? '/run';
  try {
    console.log(await materializeGuestInit(runDir));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function systemGuestInitScriptUsage(): void {
  console.log(`Usage: lazy system guest-init-script [options]

Write the lazy-guest-init script this lazy carries to the run directory and
print its path. The lazy daemon image runs it through a shim, so the guest's
preparation script is upgraded together with the lazy binary.

Options:
  --id               Print the script's id (16 hex of its sha256) and write nothing
  --run-dir <path>   Where to write it (default: $LAZY_GUEST_RUN_DIR, else /run)

Examples:
  lazy system guest-init-script               # /run/lazy-guest-init.<id>
  lazy system guest-init-script --id          # Which script does this lazy carry?`);
}
