/**
 * A clone somehow holding TWO Teams logins is a broken state whose only
 * recovery is `lazy logout` (`readTeamsLogin` refuses to pick one and names
 * that remedy — `src/teams/login.ts`). Child 8 (`teams-cli-login`) hit and
 * fixed this once already: `clearTeamsLogin` enumerates the credential index
 * directly rather than going through `readTeamsLogin`, precisely so the
 * recovery command still works when the thing it exists to fix is present.
 *
 * This task's own dispatcher preflight (`src/index.ts`, added to decide
 * whether to skip local daemon auto-start for a bound clone) reintroduced the
 * SAME trap one level up: it called `readTeamsLogin` unconditionally, before
 * ANY command's own body ran — including `lazy logout`'s. `isCloneBound`'s
 * catch is the fix; these pin that a two-login clone can still run `lazy
 * logout` (and gets the daemon's own loud refusal, not a crash, for an
 * ordinary command).
 *
 * Two logins are written directly with `setCredential` rather than through
 * `writeTeamsLogin`, which deliberately REPLACES on a second write (the
 * one-clone-one-project rule) — this state is reachable only by something
 * bypassing that, e.g. a restored or hand-edited store, which is exactly why
 * it is a "broken state" rather than a normal transition.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { setCredential } from '../../src/credentials/store';

describe('a clone holding two Teams logins', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBase: string;
  let unpin: () => void;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-two-logins-home-'));
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-two-logins-'));
    unpin = pinDaemonBaseDir(daemonBase);

    for (const [host, project] of [
      ['teams-a.example.com', 'acme/one'],
      ['teams-b.example.com', 'acme/two'],
    ] as const) {
      await setCredential(ctx.root, {
        provider: `teams:${host}`,
        kind: 'api-key',
        secret: `token-for-${host}`,
        binding: {
          teams_url: `https://${host}`,
          project,
          project_id: host,
          bound_at: new Date().toISOString(),
        },
      });
    }
  });

  afterEach(async () => {
    await ctx.cleanup();
    unpin();
    await rm(tmpHome, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  const env = () => ({ HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBase });

  test('lazy logout still works — the documented recovery is not itself broken by the dispatcher', async () => {
    const result = await ctx.lazy(['logout'], { env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('holds 2 Teams logins');

    // Logged out clean: a normal command now behaves like an ordinary,
    // unbound local project rather than tripping over a leftover binding.
    const again = await ctx.lazy(['login'], { env: env() });
    expect(again.stdout).not.toContain('Bound to');
  });

  test('an ordinary command gets the daemon-side loud refusal naming lazy logout, not a crash', async () => {
    // LAZY_TEST=1 (the harness default) makes storage resolution bypass the
    // remote/login path entirely — irrelevant to what THIS test is about,
    // which is whether the DISPATCHER'S OWN preflight crashes before the
    // command body runs at all. Unset it so `list` actually reaches
    // `readTeamsLogin` a second time, inside `resolveStorage`, and gets its
    // own loud refusal rather than silently reading a local store that was
    // never the point.
    const result = await ctx.lazy(['list'], { env: { ...env(), LAZY_TEST: '', LAZY_IS_DAEMON: '' } });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('holds 2 Teams logins');
    expect(result.stderr).toContain('lazy logout');
  });
});
