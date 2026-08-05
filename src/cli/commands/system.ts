import { printBuiltinPrompts } from './prompts';
import { commandSystemBuild, systemBuildUsage } from './system-build';
import { commandOffline, commandOnline, offlineUsage, onlineUsage } from './offline';
import { commandSystemStatus, systemStatusUsage } from './system-status';
import { commandExportDockerfile, exportDockerfileUsage } from './export-dockerfile';

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
  status             Show current system state (offline/online, driver, daemon, storage)
  offline            Enable offline mode (skip all remote operations)
  online             Disable offline mode (restore remote operations)
  export-dockerfile  Write the embedded default Dockerfile to disk for customization

System prompts use the 'lazy-prompt-' prefix (e.g. lazy-prompt-system-instructions).
View any with: lazy show <code>

Examples:
  lazy system prompts                             # List all built-in system prompts
  lazy system status                              # Show current system state
  lazy system build lazy-runner                   # Prebuild the base runner image
  lazy system offline                             # Skip all remote operations
  lazy system online                              # Restore remote operations
  lazy system export-dockerfile                   # Write Dockerfile.lazy for customization
  lazy show lazy-prompt-system-instructions       # View a specific system prompt`);
}
