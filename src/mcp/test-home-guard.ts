/**
 * A supervisor launched under a test harness must write agent config only into
 * the private HOME that harness declared.
 *
 * Claude Code reads one MCP config per HOME. A supervisor writes
 * `$HOME/.claude.json` (and `~/.claude/settings.json`) before every turn, so a
 * test run whose supervisors share the developer's — or a builder container's —
 * HOME rewrites the `mcpServers.lazy` entry of whatever real session lives
 * there. On 2026-09-28 a fleet e2e run started from inside a builder did exactly
 * that, pointing the builder's tool channel at a worktree deleted minutes later.
 *
 * Every harness gives its launches a private HOME (test/helpers/setup.ts for the
 * fake-binary suites, `PocSupervisor` for the Teams fleet suites) and DECLARES
 * it in `LAZY_TEST_AGENT_HOME`. This guard makes that a rule rather than a
 * convention: when `LAZY_TEST_PARENT_PID` says a test run launched us, HOME must
 * be the declared private home, or the turn fails before anything is written.
 * Positive declaration rather than "is HOME the account's home": Bun's
 * `os.userInfo().homedir` follows `$HOME`, so the account home cannot be told
 * apart from inside the process.
 *
 * PRODUCTION IS UNAFFECTED, for the same reason as src/daemon/test-parent-watch.ts:
 * nothing in `src/` sets `LAZY_TEST_PARENT_PID`.
 */

import { resolve } from 'path';
import { TEST_PARENT_PID_ENV } from '../daemon/test-parent-watch';
import { getHome } from '../utils/home';

/** The private HOME a test harness gave this launch. Test-only; see above. */
export const TEST_AGENT_HOME_ENV = 'LAZY_TEST_AGENT_HOME';

export interface TestHomeGuardOptions {
  env?: Record<string, string | undefined>;
  /** HOME the writes would go to. Defaults to `getHome()`. */
  home?: string;
}

/** Throws when a test-launched process is about to write a HOME its harness did not declare. */
export function assertTestLaunchHasPrivateHome(opts: TestHomeGuardOptions = {}): void {
  const env = opts.env ?? process.env;
  const parent = env[TEST_PARENT_PID_ENV];
  if (parent === undefined || parent === '') return;

  const home = resolve(opts.home ?? getHome());
  const declared = env[TEST_AGENT_HOME_ENV];
  if (declared && resolve(declared) === home) return;

  throw new Error(
    `this supervisor was launched by a test run (${TEST_PARENT_PID_ENV}=${parent}) but its HOME ` +
    `(${home}) is not the private home the harness declared ` +
    `(${TEST_AGENT_HOME_ENV}=${declared ?? '(unset)'}); writing ${home}/.claude.json could re-point ` +
    `a real agent or builder session living there at this test's task. Give the launch a private ` +
    `HOME and declare it (docs/testing-harness.md, "Supervisors: same leak, higher cost").`,
  );
}
