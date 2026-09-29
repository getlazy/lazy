/**
 * The ONE place each harness's built-in default model is spelled.
 *
 * Every surface that needs "the model a task runs when nothing more specific
 * picks one" — the config defaults, the generated lazy.toml, the agents'
 * `defaultModel()`, token counting — imports from here, so bumping a default
 * is a one-line change that cannot leave a stale copy behind.
 *
 * Use FULL ids: Anthropic does not resolve `claude-opus-5` to 5.5, so a short
 * family name here silently pins an older model.
 *
 * Zero imports on purpose: config, agents and the daemon all read this.
 */

/** Claude Code (and lazy's `[models] default`): the model a TASK runs. */
export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * The builder's model when its profile names none. Separate from the task
 * default on purpose: the builder plans, reviews and decides across many
 * tasks, so it defaults to the more capable tier while tasks default to the
 * cheaper one. `[models.roles.builder]` naming a profile with a `model`
 * overrides it; `[models] default` does not.
 */
export const BUILDER_DEFAULT_MODEL = 'claude-opus-5-5';

/** Codex. */
export const CODEX_LATEST_MODEL = 'gpt-6-sol';

/** Cursor: `auto` — Cursor picks the model (its catalog is server-side and per plan). */
export const CURSOR_DEFAULT_MODEL = 'auto';

/*
 * Model names that mean "let the harness pick" rather than a model. Cursor's
 * own default is one (`auto`); for Codex it is opt-in. Per harness, because the
 * spellings differ: Codex's `default` omits `-m`, while Codex passes `auto`
 * through as `-m auto`; Cursor's `auto` has the catalog id `default`.
 */
export const CODEX_PICKS_MODEL_NAMES: ReadonlySet<string> = new Set(['default']);
export const CURSOR_PICKS_MODEL_NAMES: ReadonlySet<string> = new Set(['auto', 'default']);

/** Any harness's "pick for me" name — for surfaces that are not harness-specific. */
export const HARNESS_PICKS_MODEL_NAMES: ReadonlySet<string> = new Set([...CODEX_PICKS_MODEL_NAMES, ...CURSOR_PICKS_MODEL_NAMES]);
