/**
 * Decomposing a lazy version string into the parts other subsystems key off.
 *
 * Exactly one thing lives here, because exactly one thing was being duplicated:
 * the `major.minor` prefix. Two independent subsystems pin to it —
 * the runner image tag (`lazy-runner:0.21`, src/capture/image-tag.ts) and the
 * documentation site version segment (`docs.getlazy.dev/v0.21/...`,
 * src/docs/links.ts) — and a second copy of `version.split('.')` is exactly the
 * kind of thing that drifts silently once the version format changes.
 *
 * The version format itself is decided in scripts/version-string.ts:
 * `{major}.{minor}.{commit-count}[-alpha]`. Everything here reads that shape and
 * nothing here decides it.
 */

/**
 * The `major.minor` prefix of a version string: `0.21.1373-alpha` → `0.21`.
 *
 * Returns the whole string when there is no minor component, and `''` for an
 * empty input. Does NOT validate that the result is numeric — callers that put
 * the result somewhere it must be well-formed (a Docker tag, a URL segment) are
 * responsible for that, and they each have different rules about it.
 */
export function majorMinor(version: string): string {
  const [major, minor] = version.split('.');
  return minor ? `${major}.${minor}` : (major ?? '');
}

/**
 * Whether a `major.minor` prefix is a plain numeric pair (`0.21`), i.e. safe to
 * paste into a URL path segment without escaping and meaningful to compare.
 *
 * A version that fails this is not an error anywhere — it just means the caller
 * falls back to an unversioned form rather than emitting `v%20weird/` into a URL.
 */
export function isNumericMajorMinor(prefix: string): boolean {
  return /^\d+\.\d+$/.test(prefix);
}
