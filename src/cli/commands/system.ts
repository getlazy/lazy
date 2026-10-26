import { printBuiltinPrompts } from './prompts';
import { commandSystemBuild, systemBuildUsage } from './system-build';
import { commandOffline, commandOnline, offlineUsage, onlineUsage } from './offline';
import { commandSystemStatus, systemStatusUsage } from './system-status';
import { commandExportDockerfile, exportDockerfileUsage } from './export-dockerfile';
import { commandSystemAgent, systemAgentUsage } from './system-agent';
import { commandSystemPassphrase, systemPassphraseUsage } from './system-passphrase';
import { commandSystemSourceId, systemSourceIdUsage } from './system-source-id';
import { commandSystemGuestInitScript, systemGuestInitScriptUsage } from './system-guest-init-script';
import { commandSystemSmolvmBuildImage, systemSmolvmBuildImageUsage } from './system-smolvm-build-image';
import { commandSystemSmolvmInstall, systemSmolvmInstallUsage } from './system-smolvm-install';
import { commandSystemRepairCommits, systemRepairCommitsUsage } from './system-repair-commits';
import { commandSystemStoreCheck, systemStoreCheckUsage } from './system-store-check';
import {
  commandSystemStoreBackup, commandSystemStoreBackups, commandSystemStoreRestore,
  systemStoreBackupUsage, systemStoreBackupsUsage, systemStoreRestoreUsage,
} from './system-store-backup';
import { commandSystemRunnerImage, systemRunnerImageUsage } from './system-runner-image';
import { commandSystemMachine, systemMachineUsage } from './system-machine';

export async function commandSystem(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    systemUsage();
    process.exit(1);
  }

  const sub = args.slice(1);

  switch (subcommand) {
    case 'prompts':
      await printBuiltinPrompts();
      break;
    case 'build':
      await commandSystemBuild(sub);
      break;
    case 'offline':
      await commandOffline(sub);
      break;
    case 'online':
      await commandOnline(sub);
      break;
    case 'status':
      await commandSystemStatus(sub);
      break;
    case 'agent':
      await commandSystemAgent(sub);
      break;
    case 'passphrase':
      await commandSystemPassphrase(sub);
      break;
    case 'guest-init-script':
      await commandSystemGuestInitScript(sub);
      break;
    case 'smolvm-build-image':
      await commandSystemSmolvmBuildImage(sub);
      break;
    case 'smolvm-install':
      await commandSystemSmolvmInstall(sub);
      break;
    case 'source-id':
      await commandSystemSourceId(sub);
      break;
    case 'repair-commits':
      await commandSystemRepairCommits(sub);
      break;
    case 'store-check':
      await commandSystemStoreCheck(sub);
      break;
    case 'store-backup':
      await commandSystemStoreBackup(sub);
      break;
    case 'store-backups':
      await commandSystemStoreBackups(sub);
      break;
    case 'store-restore':
      await commandSystemStoreRestore(sub);
      break;
    case 'runner-image':
      await commandSystemRunnerImage(sub);
      break;
    case 'machine':
      await commandSystemMachine(sub);
      break;
    case 'export-dockerfile':
    // `eject-dockerfile` is the pre-v0.16.x name, kept as a hidden alias for
    // back-compat. Not advertised in usage or completion — prefer the canonical
    // `export-dockerfile` ("eject" wrongly implied an irreversible escape hatch).
    case 'eject-dockerfile':
      await commandExportDockerfile(sub);
      break;
    default:
      console.error(`Unknown subcommand: system ${subcommand}`);
      systemUsage();
      process.exit(1);
  }
}

/**
 * Usage functions for `lazy system <subcommand>`, keyed by subcommand name.
 *
 * The dispatcher in src/index.ts intercepts -h/--help before the command runs,
 * so a subcommand's own usage is only reachable if it is listed here — without
 * this map `lazy system export-dockerfile -h` prints the parent's usage.
 * Subcommands with no dedicated usage (e.g. `prompts`) are intentionally absent
 * and fall back to systemUsage().
 */
export const systemSubcommandUsage: Record<string, () => void> = {
  'build': systemBuildUsage,
  'status': systemStatusUsage,
  'agent': systemAgentUsage,
  'passphrase': systemPassphraseUsage,
  'source-id': systemSourceIdUsage,
  'guest-init-script': systemGuestInitScriptUsage,
  'smolvm-build-image': systemSmolvmBuildImageUsage,
  'smolvm-install': systemSmolvmInstallUsage,
  'repair-commits': systemRepairCommitsUsage,
  'store-check': systemStoreCheckUsage,
  'store-backup': systemStoreBackupUsage,
  'store-backups': systemStoreBackupsUsage,
  'store-restore': systemStoreRestoreUsage,
  'runner-image': systemRunnerImageUsage,
  'machine': systemMachineUsage,
  'offline': offlineUsage,
  'online': onlineUsage,
  'export-dockerfile': exportDockerfileUsage,
  'eject-dockerfile': exportDockerfileUsage,
};

export function systemUsage(): void {
  console.log(`Usage: lazy system <subcommand>

Inspect and prebuild Lazy system internals, and toggle project-wide modes.

Subcommands:
  prompts            List built-in system prompt templates
  build <name>       Prebuild a lazy system image (bypasses lazy.toml)
  runner-image       The project's runner image the daemon builds at start: status, log, rebuild, cancel
  machine            What the project's machine is doing: services, logs, CPU, memory, disk
  status             Show current system state (offline/online, driver, daemon, storage)
  source-id          Print the content identity of this lazy source tree
  guest-init-script  Write out the daemon image's guest preparation script this lazy carries
  smolvm-build-image Build the lazy daemon image in a throwaway smolvm machine (no host Docker)
  smolvm-install     Download, verify and install the smolvm release lazy pins
  agent              Show agent readiness, switch the default agent, or set an agent API key
  passphrase         Enroll, inspect, or delete this machine's approval passphrase
  offline            Enable offline mode (skip all remote operations)
  online             Disable offline mode (restore remote operations)
  export-dockerfile  Write the embedded default Dockerfile to disk for customization
  repair-commits     Fix recorded commit lists that name commits a task never made
  store-check <path> Report what a store directory holds, without opening it
  store-backup       Copy and verify the store into <store>.backups/ (taken before every upgrade)
  store-backups      List the store's backups
  store-restore <b>  Put a backup back (daemon stopped; the current store is moved aside)

System prompts use the 'lazy-prompt-' prefix (e.g. lazy-prompt-system-instructions).
View any with: lazy show <code>

Examples:
  lazy system prompts                             # List all built-in system prompts
  lazy system status                              # Show current system state
  lazy system source-id                           # Which lazy code is this?
  lazy system agent set cursor                    # Switch the default agent to Cursor
  lazy system agent set-key cursor                # Store the Cursor API key (masked prompt)
  lazy system passphrase set                      # Enroll the approval passphrase (masked prompt)
  lazy system passphrase                          # Is one enrolled on this machine?
  lazy system build lazy-runner                   # Prebuild the base runner image
  lazy system runner-image                        # Is the project's runner image ready?
  lazy system runner-image log --follow           # Watch its build, step by step
  lazy system machine --logs                      # Services, their logs, resource use
  lazy system offline                             # Skip all remote operations
  lazy system online                              # Restore remote operations
  lazy system export-dockerfile                   # Write Dockerfile.lazy for customization
  lazy system repair-commits --all                # Which commit lists are wrong?
  lazy system store-check ~/.lazy/my-project      # Is this store safe to hand over?
  lazy system store-backups                       # Which pre-upgrade backups exist?
  lazy show lazy-prompt-system-instructions       # View a specific system prompt`);
}
