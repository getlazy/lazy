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
  raised: ['followups', 'followup'],
  playground: ['demo'],
};

/**
 * Aliases kept only so an old spelling keeps working, each with the notice the
 * dispatcher prints before running the canonical command. A note here is a
 * promise that the spelling still WORKS — it is not a way to reject one.
 *
 * The notice goes to stderr, so a script piping stdout into something keeps
 * parsing exactly what it parsed before.
 */
export const DEPRECATED_ALIAS_NOTES: Record<string, string> = {
  demo:
    'lazy demo is now lazy playground — same subcommands and flags. ' +
    'The old name works for one more release.',
  followups:
    'lazy followups is now lazy raised — follow-ups are non-blocking raised items. ' +
    'The old name works for one more release.',
  followup:
    'lazy followup is now lazy raised — follow-ups are non-blocking raised items. ' +
    'The old name works for one more release.',
};

/** Flattened reverse lookup: alias name -> canonical command. */
export const ALIAS_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(COMMAND_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias, canonical]),
  ),
);

/** All alias names, e.g. for excluding aliases from fuzzy-match suggestions. */
export const ALIAS_NAMES: string[] = Object.keys(ALIAS_TO_CANONICAL);
