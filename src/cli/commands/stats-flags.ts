/**
 * Flag parsing shared by the `lazy stats` subcommands.
 *
 * `tokens`, `timings` and `audit` all take a `--since <duration>` window and
 * positive-integer caps, and all three must reject the same bad input the same
 * way — `--since yesterday` failing in `tokens` but being silently ignored in
 * `audit` is exactly the kind of drift that makes a CLI feel untrustworthy.
 * One implementation, three callers.
 */

const DURATION_UNITS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };

/**
 * Turn a `30m` / `2h` / `1d` duration into the absolute unix-ms cutoff it
 * denotes. Returns undefined when the flag was not given. Exits with a usage
 * error on a malformed value rather than guessing at intent.
 *
 * `flag` names the flag in the error so `--last` says `--last`, not `--since`.
 */
export function parseSince(value: string | undefined, flag = 'since'): number | undefined {
  if (value === undefined) return undefined;
  const m = value.match(/^(\d+)([smhd])$/);
  if (!m) {
    console.error(`Invalid --${flag} '${value}'. Use forms like 30m, 2h, 1d.`);
    process.exit(1);
  }
  return Date.now() - parseInt(m[1], 10) * DURATION_UNITS[m[2]]!;
}

/** Parse a positive-integer flag, falling back when it was not given. */
export function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`Invalid --${flag} '${raw}'. Expected a positive integer.`);
    process.exit(1);
  }
  return n;
}
