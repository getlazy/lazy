import { printBuiltinPrompts } from './prompts';
import { commandSystemBuild } from './system-build';
import { commandOffline, commandOnline } from './offline';
import { commandExportDockerfile } from './export-dockerfile';

export async function commandSystem(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    systemUsage();
    process.exit(1);
  }

  const sub = args.slice(1);

  switch (subcommand) {
    case 'prompts':
      printBuiltinPrompts();
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

export function systemUsage(): void {
  console.log(`Usage: lazy system <subcommand>

Inspect and prebuild Lazy system internals, and toggle project-wide modes.

Subcommands:
  prompts            List built-in system prompt templates
  build <name>       Prebuild a lazy system image (bypasses lazy.toml)
  offline            Enable offline mode (skip all remote operations)
  online             Disable offline mode (restore remote operations)
  export-dockerfile  Write the embedded default Dockerfile to disk for customization

System prompts use the 'lazy-prompt-' prefix (e.g. lazy-prompt-system-instructions).
View any with: lazy show <code>

Examples:
  lazy system prompts                             # List all built-in system prompts
  lazy system build lazy-runner                   # Prebuild the base runner image
  lazy system offline                             # Skip all remote operations
  lazy system online                              # Restore remote operations
  lazy system export-dockerfile                   # Write Dockerfile.lazy for customization
  lazy show lazy-prompt-system-instructions       # View a specific system prompt`);
}
