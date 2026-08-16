/**
 * Declare test mode for e2e suites that call `src/` code IN-PROCESS.
 *
 * WHY THIS EXISTS: `setupTestLazy()` sets `LAZY_TEST=1` on every SUBPROCESS a
 * daemonless suite spawns (see `test/helpers/setup.ts`) and the subprocess
 * reconcile driver sets it too (`test/helpers/reconcile.ts`) — but the `bun test`
 * process itself never had it. A suite that imports `reconcileTasks` and awaits
 * it directly therefore ran production code in NON-test mode, inside a project
 * that has no daemon by design.
 *
 * That was invisible until the audit/policy proxy became on-by-default:
 * `createRunner` now resolves the daemon's live proxy address up front and fails
 * loud when it can't (`ProxyUnavailableError`), so every in-process reconcile
 * pass aborted before doing any work. `LAZY_TEST=1` is the documented bypass for
 * exactly this situation — "the harness runs the whole CLI without a daemon by
 * design" (`proxyGateBypassed` in `src/daemon/auth-env.ts`) — and it is what the
 * subprocess drivers have always used. This makes the in-process driver
 * symmetric with them rather than inventing a second seam.
 *
 * WHY IT IS SUITE-SCOPED: `process.env` is a single map shared by every test
 * FILE in one `bun test` run. The first version of this helper set
 * `LAZY_TEST=1` at module scope and never cleared it, so a single daemonless
 * suite poisoned every `withDaemon: true` suite that ran after it in the same
 * process: those suites need `LAZY_TEST` UNSET so their spawned CLI children
 * really talk to the test daemon instead of taking the in-process RPC bypass.
 * Poisoned, the children ran storage in-process and deadlocked against the
 * daemon holding `.storage-lock` — `bun test test/e2e/submit.test.ts
 * test/e2e/accept-reason.test.ts` failed all six accept tests while each file
 * passed alone. It needed nothing to crash and nothing to be slow; pure file
 * ordering on a clean, fully successful run.
 *
 * So the flag is now set in a `beforeAll` and restored in an `afterAll`: it
 * cannot outlive the file that asked for it. Call it at module scope (or inside
 * a `describe`) — the hooks register in whatever scope you call it from.
 *
 * CONSEQUENCE: `LAZY_TEST` is NOT set while the module body evaluates, only
 * once tests start. Module-scope code in a suite must not depend on it. Nothing
 * does today: every caller reads it from inside a test or a hook.
 *
 * Belt-and-braces: `setupTestLazy` also passes `LAZY_TEST: ''` explicitly to
 * every child of a `withDaemon: true` context, so such a suite is immune to
 * this leak and to any other source of a stray `LAZY_TEST` in the parent env.
 *
 * Do NOT call this from a `withDaemon: true` suite — there `LAZY_TEST=1` must
 * stay unset so the CLI actually talks to the real test daemon.
 */

import { beforeAll, afterAll } from 'bun:test';

export function enableInProcessTestMode(): void {
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env.LAZY_TEST;
    process.env.LAZY_TEST = '1';
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.LAZY_TEST;
    else process.env.LAZY_TEST = previous;
  });
}
