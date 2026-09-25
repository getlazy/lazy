/**
 * `lazy customize <subcommand>` — scaffold project-local customizations.
 *
 * Lazy ships extension SEAMS rather than built-in behaviour: the proxy loads
 * request plugins from `.lazy/plugins/`, and more seams will follow. Writing
 * the first file against a seam is the part with all the friction — the
 * interface shape, the contract you must not break, a test that proves the
 * wiring works — so this family generates it.
 *
 * Everything a `customize` subcommand writes lands in the user's project (under
 * `.lazy/`, which is deliberately not gitignored) and is theirs to edit and
 * commit. Lazy never reads back what it scaffolded expecting it unchanged.
 */

import { commandCustomizeProxyPlugin, customizeProxyPluginUsage } from './customize-proxy-plugin';

export async function commandCustomize(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    customizeUsage();
    process.exit(1);
  }

  const sub = args.slice(1);

  switch (subcommand) {
    case 'proxy-plugin':
      await commandCustomizeProxyPlugin(sub);
      break;
    default:
      console.error(`Unknown subcommand: customize ${subcommand}`);
      customizeUsage();
      process.exit(1);
  }
}

/**
 * Usage functions for `lazy customize <subcommand>`, keyed by subcommand name.
 *
 * The dispatcher in src/index.ts intercepts -h/--help before the command runs,
 * so a subcommand's own usage is only reachable if it is listed here — without
 * this map `lazy customize proxy-plugin -h` prints the parent's usage.
 */
export const customizeSubcommandUsage: Record<string, () => void> = {
  'proxy-plugin': customizeProxyPluginUsage,
};

export function customizeUsage(): void {
  console.log(`Usage: lazy customize <subcommand>

Scaffold a project-local customization against one of lazy's extension seams.
Generated files land in your project and are yours to edit — and, since .lazy is
not gitignored, to commit and share with your team.

Subcommands:
  proxy-plugin <name>   A request plugin for the model-API proxy, in .lazy/plugins/

Examples:
  lazy customize proxy-plugin strip-trailing-space
  lazy customize proxy-plugin -h        # full options for a subcommand`);
}
