import { printBuiltinPrompts } from './prompts';
import { printBuiltinToolchains } from './toolchains-list';

export async function commandSystem(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    systemUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case 'prompts':
      printBuiltinPrompts();
      break;
    case 'toolchains':
      printBuiltinToolchains();
      break;
    default:
      console.error(`Unknown subcommand: system ${subcommand}`);
      systemUsage();
      process.exit(1);
  }
}

export function systemUsage(): void {
  console.log(`Usage: lazy system <subcommand>

Inspect Lazy system internals.

Subcommands:
  prompts      List built-in system prompt templates
  toolchains   List built-in toolchain Dockerfiles

System prompts use the 'lazy-prompt-' prefix (e.g. lazy-prompt-system-instructions).
Toolchains use the 'lazy-toolchain-' prefix (e.g. lazy-toolchain-rust).
View any with: lazy show <code>

Examples:
  lazy system prompts                             # List all built-in system prompts
  lazy system toolchains                          # List all built-in toolchains
  lazy show lazy-prompt-system-instructions       # View a specific system prompt
  lazy show lazy-toolchain-rust                   # View a toolchain Dockerfile`);
}
