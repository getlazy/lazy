/**
 * Reporting for a `git fetch` the daemon could not complete.
 *
 * The daemon's sync loop fetches every 60 seconds and cannot stop doing so —
 * polling the remote IS its job, and a fetch that fails because the network
 * blipped must be retried on the next tick, not deferred. What it must not do
 * is write the same failure into daemon.log every minute until somebody
 * notices the file is enormous, which is what a bare `logger.warn` per tick
 * produced for a remote whose credentials the machine does not have (an
 * indefinite condition, not a transient one).
 *
 * So the retry cadence is unchanged and the REPORTING is deduplicated: a
 * failure is logged at warn level, with what to do about it, the first time it
 * is seen and again whenever the reason changes; identical repeats drop to
 * debug. State is module-level and in-memory — a daemon restart re-reports
 * everything, which is right: the operator restarting is exactly when they want
 * to see it again.
 */

import { logger } from '../utils/logger';

/** Last reported failure text, keyed by `<root>\0<remote>`. */
const lastReported = new Map<string, string>();

/**
 * git's vocabulary for "nobody gave me a credential and I was not allowed to
 * ask". Matching it lets the log say what to DO instead of only what happened —
 * the raw stderr ("could not read Username for 'https://github.com': terminal
 * prompts disabled") reads like a bug in lazy rather than a missing credential.
 */
const NO_CREDENTIAL =
  /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or (token|password)|Permission denied \(publickey/i;

/** Build the actionable line that follows the raw failure, if we have one. */
function remedyFor(stderr: string): string | undefined {
  if (!NO_CREDENTIAL.test(stderr)) return undefined;
  return (
    'The remote needs credentials this machine does not have. ' +
    'Authenticate git for it (a credential helper, `gh auth login`, or an SSH key), ' +
    'or set `sync_interval = 0` under [server] in lazy.toml to stop syncing this project.'
  );
}

/**
 * Report a failed fetch: loudly the first time and on every change, quietly
 * after that. Never throws — reporting a failure must not become one.
 */
export function reportFetchFailure(root: string, remote: string, stderr: string): void {
  const key = `${root}\0${remote}`;
  const detail = stderr.trim() || '(no output)';
  const remedy = remedyFor(detail);
  const message = `Fetch from '${remote}' failed for ${root}: ${detail}`;

  if (lastReported.get(key) === detail) {
    // Same failure as last tick. Already reported with its remedy; repeating it
    // every 60s buries everything else in the log.
    logger.debug(`${message} (unchanged since last sync)`);
    return;
  }

  lastReported.set(key, detail);
  logger.warn(message);
  if (remedy) logger.warn(`  ${remedy}`);
}

/** Forget a remote's last failure, so the next one is reported afresh. */
export function clearFetchFailure(root: string, remote: string): void {
  lastReported.delete(`${root}\0${remote}`);
}

/** Test seam: drop all remembered failures. */
export function resetFetchFailureReporting(): void {
  lastReported.clear();
}
