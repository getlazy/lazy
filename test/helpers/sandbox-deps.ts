/**
 * Availability gate for suites that really launch an agent under the host OS
 * sandbox (`hostPermissionMode: 'sandbox'`).
 *
 * On Linux, Claude Code's sandbox needs `bwrap` and `socat` on PATH, and lazy
 * refuses to run without them — `failIfUnavailable: true` means there is no
 * silent fallback to an unsandboxed agent. That is correct product behavior and
 * exactly what we want, but it makes a sandbox-launching test fail on a machine
 * that simply lacks two packages, with a message about the sandbox rather than
 * about the code under test. Those failures cost more than they catch: they are
 * indistinguishable at a glance from a watchdog or supervisor regression.
 *
 * So: skip when the deps are absent, and — INVARIANT, same rule as
 * `slowSuiteSkipped` — print exactly one line saying so. A skipped sandbox
 * suite must never be silently green-by-omission, because the posture it covers
 * is the PRODUCTION default.
 *
 * Note this gates only suites that *launch* an agent. Suites that assert on the
 * sandbox config surface or on the argv lazy composes (`host-sandbox-posture`,
 * `test/unit/host-sandbox-posture.test.ts`) never spawn one and need no gate.
 */

import { spawnSync } from '../../src/utils/spawn';

/** True when `name` resolves on PATH. */
function onPath(name: string): boolean {
  const result = spawnSync(['sh', '-c', `command -v ${name}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0;
}

/**
 * Returns true when a sandbox-launching suite should be skipped, printing one
 * line naming the missing binaries and how to install them. Intended for
 * `describe.skipIf(sandboxSuiteSkipped('name'))(...)`.
 *
 * macOS uses Seatbelt, which is part of the OS — nothing to install, never
 * skipped there.
 */
export function sandboxSuiteSkipped(suiteName: string): boolean {
  if (process.platform !== 'linux') return false;

  const missing = ['bwrap', 'socat'].filter(bin => !onPath(bin));
  if (missing.length === 0) return false;

  console.log(
    `skipped: sandbox suite "${suiteName}" — missing ${missing.join(', ')} on PATH; ` +
      `install with: sudo apt-get install -y bubblewrap socat`,
  );
  return true;
}
