/**
 * Creating a task on an agent a MANAGED installation cannot run.
 *
 * This is the reported failure from `fix-teams-pi-agent-launch`, at the layer
 * that decides it: a member on Lazy Teams picks Pi, whose built-in profile runs
 * the machine's own Ollama, and the installation has no model server. Before,
 * the task was created and only its LAUNCH refused — so somebody who pressed
 * "create and start" owned a task nothing would ever run. Now the create itself
 * is refused, and the daemon's own words are what the member reads.
 *
 * A REAL DAEMON WITH MANAGED MODE ARMED, because the whole behaviour is
 * conditional on managed mode and an in-process toggle proves only that a
 * function branches. `LAZY_MANAGED` and `LAZY_MANAGED_STORAGE_PATH` are exactly
 * what lazy-teams' `FleetProjectFiles#daemon_env` puts in a project daemon's
 * environment.
 *
 * The managed store is a throwaway directory of this suite's own rather than the
 * `external_path` `lazy init` wrote, because managed mode OVERRIDES the
 * repository's storage — pointing it at a path the harness chose is what the
 * fleet does, and every assertion here goes through the daemon, so the two
 * never have to agree.
 *
 * ## Why the suite cannot bring its own upstream, though it should
 *
 * An unreachable upstream this suite PICKED would make the premise hold on any
 * machine, and there is no way to have one. Three routes, all closed:
 *
 *  - **A profile with an `endpoint`** — `agents.*.endpoint` in a repository's
 *    lazy.toml is REFUSED on a managed host, so the daemon would not load the
 *    config at all. That refusal is the very thing under test.
 *  - **`[models.roles.agent] endpoint`** — refused for the same reason, and the
 *    key no longer exists.
 *  - **Pointing the built-in `pi` profile elsewhere** — its upstream is
 *    `DEFAULT_LOCAL_OLLAMA_ENDPOINT`, a constant with no override, and adding an
 *    env seam for a test would put a test-only variable on a production path.
 *
 * So the only upstream available is the real local Ollama port, and the premise
 * is "nothing is serving it" — true in CI and in a task container, not true on a
 * developer's machine running Ollama. ONE test depends on that and stands down
 * with a printed line when it does not hold; the other must never.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';

/** The built-in `pi` profile's upstream — see HARNESS_DEFAULT_ENDPOINT. */
const BUILTIN_PI_UPSTREAM = 'http://localhost:11434';

/**
 * Whether something is answering on the local Ollama port.
 *
 * A SKIP, never a silent pass: on a developer's machine with Ollama running,
 * Pi genuinely IS runnable and this suite's premise does not hold — asserting a
 * refusal there would be asserting the absence of correct behaviour. One line
 * is printed so a skipped run is never mistaken for a green one.
 */
async function ollamaIsRunning(): Promise<boolean> {
  try {
    const res = await fetch(BUILTIN_PI_UPSTREAM, { signal: AbortSignal.timeout(2_000) });
    return res.ok || res.status > 0;
  } catch {
    return false;
  }
}

describe('creating a task on an agent a managed installation cannot run', () => {
  let ctx: TestContext;
  let managedStore: string;

  // Whether THIS test's premise holds, re-asked per test rather than kept as
  // suite state. The first version of this file set a `skipped` flag in
  // `beforeEach` and never cleared it, so one skip skipped the rest of the run —
  // and an `afterEach` that returned early on the same flag would have leaked
  // the daemon of any context created before it was set.
  let piUpstreamAnswered = false;

  beforeEach(async () => {
    piUpstreamAnswered = await ollamaIsRunning();
    managedStore = await mkdtemp(join(tmpdir(), 'lazy-managed-store-'));
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: managedStore },
    });
  });

  // UNCONDITIONAL. Every path above creates the context, so every path must
  // reap it: a cleanup somebody can skip is a leaked daemon holding a port out
  // of the harness's bounded window, which fails a later suite with a bind
  // error that says nothing about this file.
  afterEach(async () => {
    await ctx.cleanup();
    await rm(managedStore, { recursive: true, force: true });
  });

  // INVARIANT: the refusal happens at CREATE, so no task exists afterwards. A
  // task created on an agent this installation cannot run is a dead task: its
  // launch is refused, and nothing anybody in the project can do will ever make
  // it runnable, because the repository may not choose an agent's upstream on a
  // managed host. Telling somebody afterwards is not the same as not doing it.
  //
  // THE ONLY test here whose premise depends on the machine, and the only one
  // that may stand down. A developer running Ollama genuinely CAN run Pi, so
  // asserting a refusal there would be asserting the absence of correct
  // behaviour.
  test('refuses the create, and creates nothing', async () => {
    if (piUpstreamAnswered) {
      console.log(
        `SKIP "refuses the create" — something is serving ${BUILTIN_PI_UPSTREAM}, so the built-in ` +
        'pi profile is runnable on this machine and there is no refusal to assert.',
      );
      return;
    }

    const before = await ctx.lazy(['list', '--all']);
    expectSuccess(before);

    const result = await ctx.lazy(['create', '--agent', 'pi', '--goal', 'Run something on pi']);

    expect(result.exitCode).not.toBe(0);
    const said = `${result.stdout}${result.stderr}`;
    expect(said).toMatch(/cannot run on this installation/);
    // Who can change it, and who cannot. Both halves matter: the member is not
    // at fault and has no key to reach for.
    expect(said).toMatch(/manages agent configuration/);
    expect(said).toMatch(/ask whoever runs it/i);

    // …and it must never hand them the thing this gate exists to prevent.
    expect(said).not.toMatch(/change \[agents\.[^\]]+\] in lazy\.toml/);

    const after = await ctx.lazy(['list', '--all']);
    expectSuccess(after);
    expect(after.stdout).not.toMatch(/Run something on pi/);
  }, 60_000);

  // …and the gate is narrow. An agent whose upstream is not probed at all rides
  // the proxy's primary upstream and is created exactly as before — a managed
  // host that refused every create would be a far worse bug than the one this
  // fixes, and this is the assertion that would catch it.
  //
  // NEVER SKIPPED. Whether anything is serving a local Ollama port has no
  // bearing on whether an ordinary agent is still creatable, and standing this
  // down alongside the refusal above would have turned off the only guard
  // against the worse bug on exactly the machines most likely to hit it.
  test('still creates a task on an agent the installation does run', async () => {
    const result = await ctx.lazy(['create', '--agent', 'claude-code', '--goal', 'Ordinary work']);

    expectSuccess(result);
    const after = await ctx.lazy(['list', '--all']);
    expect(after.stdout).toMatch(/Ordinary work/);
  }, 60_000);
});
