/**
 * Claude Code's first-run answers, in ONE place.
 *
 * A `~/.claude.json` with none of these keys is a brand-new install to Claude
 * Code: it opens the theme picker, then the workspace-trust dialog and the
 * custom API key approval. Task sandboxes (`src/task/claude-home.ts`) and the
 * detached (Teams) builder session (`src/builder/claude-home.ts`) fill their
 * gaps from here so the two never drift. The bypass-permissions acknowledgement
 * is deliberately NOT pre-answered: it is a safety prompt a human in bypass
 * mode (e.g. an autonomous pair) should still see, and no seeded session needs it.
 *
 * NOTHING IDENTITY-SHAPED IS SEEDED: no `oauthAccount`, `userID`, email or
 * token. Authentication rides the proxy placeholder env var. Only keys the
 * document does not already carry are filled: a person's own later answers win.
 */

export interface ClaudeFirstRunOptions {
  /** Directories the session runs in; each gets its trust dialog pre-answered. */
  trustPaths?: string[];
  /** The ANTHROPIC_API_KEY value the session is launched with (a placeholder), if any. */
  apiKey?: string;
}

/** Default theme when the document has none — avoids the first-run picker. */
export const CLAUDE_FIRST_RUN_THEME = 'dark';

/**
 * Records the key suffix lazy itself approved. Each launch gets a fresh
 * placeholder and the document is written back on exit, so without this every
 * launch would leave one dead approval behind forever; the next seed swaps it.
 */
export const LAZY_SEEDED_KEY_SUFFIX = 'lazySeededApiKeySuffix';

/** Keys this module may write. Tests assert the seed never exceeds this set. */
export const CLAUDE_FIRST_RUN_KEYS = [
  'hasCompletedOnboarding',
  'theme',
  'projects',
  'customApiKeyResponses',
  LAZY_SEEDED_KEY_SUFFIX,
] as const;

/**
 * Return `base` with every missing first-run key filled. Pure; never removes
 * or overwrites an existing value.
 */
export function applyClaudeFirstRunDefaults(
  base: Record<string, unknown>,
  opts: ClaudeFirstRunOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  // Skips the "Let's get started" wizard (theme picker, intro screens).
  if (out.hasCompletedOnboarding === undefined) out.hasCompletedOnboarding = true;
  // The wizard is skipped, so the theme it would have asked for needs a value.
  if (out.theme === undefined) out.theme = CLAUDE_FIRST_RUN_THEME;

  if (opts.trustPaths && opts.trustPaths.length > 0) {
    const projects = { ...((out.projects as Record<string, unknown> | undefined) ?? {}) };
    for (const path of opts.trustPaths) {
      const entry = { ...((projects[path] as Record<string, unknown> | undefined) ?? {}) };
      // Workspace trust dialog for the directory the session runs in (`-w`).
      if (entry.hasTrustDialogAccepted === undefined) entry.hasTrustDialogAccepted = true;
      // Per-project intro tips shown the first time a directory is opened.
      if (entry.hasCompletedProjectOnboarding === undefined) entry.hasCompletedProjectOnboarding = true;
      projects[path] = entry;
    }
    out.projects = projects;
  }

  if (opts.apiKey) {
    // "Detected a custom API key — use it?" is keyed by the key's last 20 chars.
    const suffix = opts.apiKey.slice(-20);
    const prev = (out.customApiKeyResponses as { approved?: unknown; rejected?: unknown } | undefined) ?? {};
    const stale = out[LAZY_SEEDED_KEY_SUFFIX];
    const approved = (Array.isArray(prev.approved) ? prev.approved as string[] : []).filter(s => s !== stale);
    const rejected = Array.isArray(prev.rejected) ? prev.rejected as string[] : [];
    if (!approved.includes(suffix) && !rejected.includes(suffix)) approved.push(suffix);
    out.customApiKeyResponses = { ...prev, approved, rejected };
    out[LAZY_SEEDED_KEY_SUFFIX] = suffix;
  }
  return out;
}
