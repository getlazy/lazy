/**
 * The `--timeout` flag shared by every command that triggers a container image
 * build (`lazy upgrade`, `lazy system build`).
 *
 * Image builds are UNBOUNDED by default — see the timeout policy note on
 * `runDockerBuild`. This flag exists only so someone who genuinely wants a
 * bound (CI, a machine they cannot babysit) can ask for one explicitly.
 *
 * The unit is SECONDS, because that is what a human types at a shell. `0`
 * spells out the default, so `--timeout 0` is a supported no-op rather than an
 * error — a script can pass a computed value without special-casing zero.
 */

import type { FlagDefinition } from '../helpers';

/** Add this to a command's parseFlags table alongside its other flags. */
export const BUILD_TIMEOUT_FLAG: FlagDefinition = { name: 'timeout', takesValue: true };

/** Usage line, so every command documents the flag identically. */
export const BUILD_TIMEOUT_USAGE =
  '  --timeout <seconds>      Kill the image build after N seconds (default: no timeout)';

/**
 * Convert the parsed flag value to milliseconds for `runDockerBuild`.
 * Returns 0 (unbounded) when the flag is absent or explicitly 0.
 *
 * Exits with an actionable message on a non-numeric or negative value rather
 * than silently falling back to unbounded — a mistyped bound that silently does
 * nothing is exactly the kind of surprise CLAUDE.md forbids.
 */
export function resolveBuildTimeoutMs(
  value: string | boolean | string[] | undefined,
  commandName: string,
): number {
  if (value === undefined) return 0;

  const raw = String(value);
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 0) {
    console.error(`Error: --timeout expects a whole number of seconds (got '${raw}').`);
    console.error(`Image builds are unbounded by default — omit the flag, or pass \`--timeout 0\`,`);
    console.error(`to run without a bound. Run \`lazy ${commandName} --help\` for usage.`);
    process.exit(1);
  }

  return seconds * 1000;
}
