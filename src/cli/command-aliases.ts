/**
 * Command aliases — the single source of truth shared by the command
 * dispatcher (src/index.ts) and shell completion (commands/completion.ts).
 *
 * Maps each canonical command to its alternative names. The dispatcher
 * registers an alias entry for each, pointing at the canonical command's
 * handler; completion expands aliases so they tab-complete and inherit the
 * canonical command's flags, task-ID bucket, and subcommands. Add an alias
 * here once and both stay in sync — neither maintains its own list.
 */
export const COMMAND_ALIASES: Record<string, string[]> = {
  list: ['ls', 'tasks'],
  show: ['view'],
  document: ['doc'],
};

/** Flattened reverse lookup: alias name -> canonical command. */
export const ALIAS_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(COMMAND_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias, canonical]),
  ),
);

/** All alias names, e.g. for excluding aliases from fuzzy-match suggestions. */
export const ALIAS_NAMES: string[] = Object.keys(ALIAS_TO_CANONICAL);
