/**
 * Tag normalization — the single source of truth for turning arbitrary
 * user/builder input into a canonical tag.
 *
 * A normalized tag is lowercase, contains only alphanumerics and single
 * hyphens, and has no leading/trailing hyphens. Runs of any other characters
 * (spaces, punctuation, brackets) collapse to a single hyphen. This is applied
 * at the storage boundary so every channel (CLI, MCP, direct storage) produces
 * identical tags — e.g. "ONBOARDING" → `onboarding`, "[Onboarding]" →
 * `onboarding`, "on boarding" → `on-boarding` (interior spaces become a hyphen;
 * only leading/trailing separators are stripped).
 */
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a tag and assert it is non-empty. Throws a human-actionable error
 * when the input normalizes to nothing (e.g. all punctuation), so the caller
 * surfaces the problem instead of silently persisting an empty tag.
 */
export function normalizeTagOrThrow(raw: string): string {
  const tag = normalizeTag(raw);
  if (tag.length === 0) {
    throw new Error(
      `Invalid tag '${raw}': a tag must contain at least one letter or digit ` +
      `(tags are normalized to lowercase alphanumerics and hyphens).`,
    );
  }
  return tag;
}
