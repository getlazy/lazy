/**
 * "Is this host managed?" — the one question, in a module that depends on
 * nothing.
 *
 * The policy itself lives in `./managed`, which necessarily reaches into
 * agent profiles, credentials and the docs links to classify config keys. That
 * makes it unimportable from the modules BENEATH those — and the arming flag is
 * exactly what they need, because what a message tells a reader to go and edit
 * depends on whether they are allowed to edit it (see `./agent-profile-advice`).
 *
 * So the flag is split out here, as a leaf, for the same reason
 * `utils/endpoint` and `utils/anthropic-models` were: a cycle through a policy
 * module is a real failure (a temporal-dead-zone crash at import time), not a
 * style preference. `./managed` re-exports both names, so nothing that already
 * imports them from there has to change.
 */

/** Build-time flag, defined only in a compiled `lazy` / `lazy-agent` binary. */
declare const LAZY_RELEASE_BUILD: boolean;

/** Arms managed mode. Set by the fleet supervisor in the daemon's environment. */
export const MANAGED_ENV = 'LAZY_MANAGED';

/** True when the fleet has armed managed mode for this process. */
export function isManagedMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MANAGED_ENV];
  if (raw === '1' || raw === 'true') return true;

  // TEST SEAM: allows the fake-binary supervisor to run under managed mode.
  // The one suite that needs a real agent process plus a user token cannot otherwise run,
  // as the fake-binary seam requires the host-process runner, which managed mode overrides.
  // This branch is eliminated from released binaries via LAZY_RELEASE_BUILD.
  if (typeof LAZY_RELEASE_BUILD === 'undefined' && env['LAZY_TEST_FORCE_MANAGED'] === '1') {
    return true;
  }

  return false;
}
