/**
 * `lazy stats <subcommand>` — read-only analytics over what lazy recorded.
 *
 * Top-level verbs are for task-lifecycle operations (create/start/accept/…).
 * Analytics readouts live here instead, so the root command list stays about
 * moving tasks through the system and this multiplexer accumulates the
 * read-only rollups (`tokens` today; more to follow).
 *
 * Every subcommand under `stats` must be read-only: it reads what lazy already
 * recorded and prints it. Nothing here mutates a task, a branch or the store.
 */
import { commandTokens, tokensUsage } from './tokens';
import { commandTimings, timingsUsage } from './timings';
import { commandAudit, auditUsage } from './audit';

export async function commandStats(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    statsUsage();
    process.exit(1);
  }

  const sub = args.slice(1);

  switch (subcommand) {
    case 'tokens':
      await commandTokens(sub);
      break;
    case 'timings':
      await commandTimings(sub);
      break;
    case 'audit':
      await commandAudit(sub);
      break;
    default:
      console.error(`Unknown subcommand: stats ${subcommand}`);
      statsUsage();
      process.exit(1);
  }
}

/**
 * Usage functions for `lazy stats <subcommand>`, keyed by subcommand name.
 *
 * The dispatcher in src/index.ts intercepts -h/--help before the command runs,
 * so a subcommand's own usage is only reachable if it is listed here — without
 * this map `lazy stats tokens -h` prints the parent's usage.
 */
export const statsSubcommandUsage: Record<string, () => void> = {
  'tokens': tokensUsage,
  'timings': timingsUsage,
  'audit': auditUsage,
};

export function statsUsage(): void {
  console.log(`Usage: lazy stats <subcommand>

Read-only analytics over what lazy recorded. Nothing here changes any state.

Subcommands:
  tokens    Token accounting from the proxy audit trail (by role, task and model)
  audit     Browse the proxy audit trail record by record (filters + detail view)
  timings   Recorded request traces, ranked by self time

Examples:
  lazy stats tokens                 # totals plus by-role / by-task / by-model
  lazy stats tokens --since 24h     # only the last day
  lazy stats tokens --json          # machine-readable rollup
  lazy stats audit                  # newest proxied requests, one row each
  lazy stats audit --denied         # only requests with a policy denial
  lazy stats timings                # newest traces, ranked by self time
  lazy stats timings --limit 1 --tree  # newest request plus its span tree
  lazy stats tokens -h              # full options for a subcommand`);
}
