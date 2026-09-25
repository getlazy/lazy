/**
 * "Is this an Anthropic model name?" — one predicate, in a module with no
 * runtime imports.
 *
 * A LEAF on purpose, for the reason src/config/default-target.ts documents at
 * length: src/config/agent-profiles.ts needs this at config-load time, and
 * src/utils/role-target.ts (where it used to live) reaches the credential store,
 * which reaches the loader, which reaches agent-profiles. Importing it from
 * there would close that cycle. Nothing here imports anything, so it cannot.
 *
 * Re-exported by role-target so its existing callers are unchanged.
 */

/**
 * Short names lazy recognizes as Anthropic models, in addition to any `claude-*`
 * id. The `claude-*` prefix is the escape hatch for models newer than this list;
 * these short aliases cover the known models so users can pass `--model opus`
 * etc. Used to validate an explicit `--model` override against an UNPINNED
 * profile, where an unrecognized name would be handed to the Anthropic API and
 * fail opaquely — the way to run anything else is a profile with an `endpoint`.
 */
export const KNOWN_ANTHROPIC_SHORT_NAMES = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'] as const;

/** True if `model` is a model the Anthropic API can serve directly (no local server). */
export function isKnownAnthropicModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith('claude-') || (KNOWN_ANTHROPIC_SHORT_NAMES as readonly string[]).includes(m);
}
