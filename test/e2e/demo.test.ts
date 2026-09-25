/**
 * `lazy playground up` end to end: a real daemon, real turns, and a dashboard that
 * serves the pages the seeded states are there to fill.
 *
 * WHY THIS SUITE DOES NOT USE `setupTestLazy`. Every other e2e suite asks the
 * harness for a project and a daemon. This command's whole job is to build
 * those itself, so a harness-provided pair would test nothing: the assertion is
 * that `lazy playground up`, run as a human or an agent would run it, produces a
 * working environment. So it runs the real command as a subprocess against a
 * temp root and inspects what comes out.
 *
 * NOT gated behind `LAZY_SLOW_TESTS`, despite standing up a daemon and running
 * five real turns: the whole file is ~25s, well inside the project's >300s bar
 * for a slow suite. Gating it would mean the one test of this command never
 * runs by default, which costs more than the 25s saves. The per-test timeouts
 * are generous anyway, because these are real `bun` cold starts and a loaded
 * machine makes them several times slower than a quiet one.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { slowSuiteSkipped } from '../helpers/slow-suite';
import { demoTeamsPaths, teamsEnv, STORAGE_DIR_ENV } from '../../src/demo/teams';
import { demoPaths } from '../../src/demo/paths';
import { demoEnvOverrides } from '../../src/demo/runtime';

const ENTRY = resolve(import.meta.dir, '../../src/index.ts');

let demoRoot: string | null = null;

/**
 * Every demo root this file has created, and every subprocess it has spawned.
 *
 * WHY A REGISTRY RATHER THAN PER-TEST CLEANUP. A demo daemon is deliberately
 * OUTSIDE the harness reapers — `demoEnv`'s allowlist drops
 * `LAZY_TEST_PARENT_PID`, because the demo is a real environment a human keeps
 * after the command exits, not harness scaffolding. So an explicit teardown is
 * the ONLY thing that stops a demo daemon, and any path that skips one leaks a
 * real daemon holding a real port plus an agent holding a turn open for 45
 * minutes.
 *
 * Per-test `try/finally` is necessary and was not sufficient: an `up` outside
 * the `try`, or an assertion between `spawn` and `kill`, skips it. CLAUDE.md is
 * explicit that leaked daemons exhaust the port window and fail LATER suites
 * with spurious bind errors — a failure that looks like someone else's bug.
 * The registry is the backstop that holds however a test dies.
 */
const createdRoots = new Set<string>();
const spawnedProcesses = new Set<Bun.Subprocess>();

/** Make a demo root that teardown is guaranteed to see. */
async function makeDemoRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.add(root);
  return root;
}

/**
 * Spawn a subprocess this file will kill even if the test dies first.
 *
 * Generic so the caller keeps its stdout/stderr types — a `Bun.Subprocess`
 * return would erase them and make the piped reader untypeable.
 */
function trackSpawn<T extends Bun.Subprocess>(proc: T): T {
  spawnedProcesses.add(proc);
  return proc;
}

// The backstop. Runs after EVERY test in the file, whatever happened in them,
// and covers every root — the shared one, the bystander's, the Teams one, the
// HOME one. `demo down` on an already-torn-down root is a no-op, so running it
// twice costs nothing and skipping it once costs a stray daemon.
afterAll(async () => {
  for (const proc of spawnedProcesses) {
    try {
      proc.kill('SIGKILL');
      await proc.exited;
    } catch {
      // Already gone is the normal case; a process we cannot signal is not a
      // reason to skip tearing down the roots below.
    }
  }
  spawnedProcesses.clear();

  for (const root of createdRoots) {
    await lazyDemo(['down'], root).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  createdRoots.clear();
  demoRoot = null;
});

/** Run a lazy subcommand for the demo, capturing both streams. */
async function lazyDemo(args: string[], root: string, command = 'playground'): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, 'run', ENTRY, command, ...args, '--root', root], {
    // Deliberately NOT the demo's own directory: the command must work from
    // anywhere, including a checkout it does not own, which is the situation it
    // exists for.
    cwd: resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      // The harness pins LAZY_TEST on its own processes; the demo drives a real
      // daemon and must not take the in-process storage bypass.
      LAZY_TEST: '',
      // Pacing is for people watching; this suite checks states, not timing.
      LAZY_PLAYGROUND_AGENT_PACING_MS: '0',
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: (await proc.exited) ?? 1, out: `${stdout}\n${stderr}` };
}

/**
 * Run a lazy subcommand against the provisioned demo project.
 *
 * Built from `demoEnvOverrides` rather than hand-assembled, so this helper
 * cannot drift from what the demo's own subprocesses get — and, specifically,
 * so it inherits the redirected `HOME`. Spelled out by hand it did not, and the
 * helper was itself rewriting the machine's `~/.claude.json` on every call: a
 * test for a leak that reproduced the leak.
 */
async function lazyInDemo(args: string[], root: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, 'run', ENTRY, ...args], {
    cwd: join(root, 'repo'),
    env: {
      ...process.env,
      ...demoEnvOverrides(demoPaths(root)),
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return `${stdout}\n${stderr}`;
}

describe('lazy playground', () => {
  // No teardown of its own: the module-scope `afterAll` owns every root this
  // file creates, including this one. A second cleanup here would be a second
  // place claiming the same responsibility — and the reason the leak existed at
  // all was per-describe cleanup that covered only the root it knew about.

  test('provisions a demo whose seeded tasks are really in those states', async () => {
    const root = await makeDemoRoot('lazy-demo-e2e-');
    demoRoot = root;

    const up = await lazyDemo(['up'], root);
    expect(up.out).toContain('Playground is up');
    expect(up.code).toBe(0);

    // Through the CLI, as a reviewer would see it — not by reading the store.
    const list = await lazyInDemo(['list', '--all'], root);

    // INVARIANT: every seeded state is reached by a REAL turn, so each of these
    // is evidence the daemon, the supervisor and the demo agent all ran. A
    // status written directly into the store would satisfy a weaker assertion
    // while proving nothing about the surfaces the demo exists to exercise.
    expect(list).toMatch(/demo-backlog\s+backlog/);
    expect(list).toMatch(/demo-review\s+blocked/);
    expect(list).toMatch(/demo-conflict\s+blocked/);
    expect(list).toMatch(/demo-accepted\s+accepted/);
    // The protected-file task lands in `conflict`, not `blocked`: its turn
    // violated [permissions] protected, which is the state that exists to be
    // looked at.
    expect(list).toMatch(/demo-protected\s+conflict/);
    // Still mid-turn — the reason the demo does not wait on this one.
    expect(list).toMatch(/demo-working\s+working/);
  }, 600_000);

  // INVARIANT: the wrapper works with NONE of the demo's variables in the
  // environment, and leaves none behind. The printed recipe used to be a block
  // of `export` lines, which is a trap: `LAZY_ALLOW_HOST_RUNNER` and a fake
  // `ANTHROPIC_API_KEY` survive the `cd` out of the demo and then apply to
  // every later `lazy` command in every other project in that shell.
  test('the installed wrapper drives the demo from a bare environment', async () => {
    const root = demoRoot!;
    const wrapper = join(root, 'bin', 'lazy-playground');

    expect(await Bun.file(wrapper).exists()).toBe(true);

    // Deliberately hostile: a different cwd, and every variable the demo needs
    // explicitly absent. If the wrapper depended on ambient state, this fails.
    const bare = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    } as Record<string, string>;

    const proc = Bun.spawn([wrapper, 'list', '--all'], {
      cwd: '/', env: bare, stdout: 'pipe', stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(`${out}${err}`).toContain('demo-review');
  }, 300_000);

  test('the blocked task has a real diff, real comments and both kinds of raised item', async () => {
    const root = demoRoot!;

    const diff = await lazyInDemo(['diff', 'demo-review'], root);
    expect(diff).toContain('src/inventory.js');

    const show = await lazyInDemo(['show', 'demo-review'], root);
    // Two human comments and the two raised items the review surfaces render.
    expect(show).toContain('unknown SKU');
    expect(show.toLowerCase()).toContain('blocking');
  }, 300_000);

  test('the dashboard serves the task and review pages for a seeded task', async () => {
    const root = demoRoot!;

    const status = await lazyDemo(['status'], root);
    const loginUrl = status.out.split('\n').map(l => l.trim())
      .find(l => l.startsWith('http') && l.includes('lazy_login'))
      ?? status.out.match(/https?:\/\/\S*lazy_login=\S+/)?.[0];
    expect(loginUrl).toBeTruthy();

    const base = new URL(loginUrl!).origin;
    const token = new URL(loginUrl!).searchParams.get('lazy_login');
    expect(token).toBeTruthy();

    // The sign-in token is accepted on ANY path, which is what lets an agent
    // screenshot a deep page in one shot — assert that, not just the root.
    const cookie = await signIn(`${base}/tasks/demo-review?lazy_login=${token}`);

    for (const path of ['/', '/tasks', '/tasks/demo-review']) {
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const html = await res.text();
      // A signed-out response is a 200 too — it renders the sign-in page. Assert
      // on content so that failure cannot pass as success.
      expect(html).not.toContain('<title>Sign in - Lazy</title>');
    }

    const taskPage = await fetch(`${base}/tasks/demo-review`, { headers: { cookie } });
    expect(await taskPage.text()).toContain('demo-review');
  }, 300_000);

  test('down stops the daemon, removes the root and leaves nothing running', async () => {
    const root = demoRoot!;

    const down = await lazyDemo(['down'], root);
    expect(down.code).toBe(0);
    expect(down.out).toContain('Playground torn down');

    expect(await Bun.file(join(root, 'demo.json')).exists()).toBe(false);

    // INVARIANT: the demo deliberately leaves a task mid-turn, and that turn's
    // agent outlives the daemon. Teardown must reap it — an agent left running
    // against a deleted directory is the leak `lazy playground down` exists to
    // prevent, and it was a real bug before the sweep was added.
    const ps = Bun.spawnSync(['ps', '-eo', 'args=']);
    const running = ps.stdout.toString().split('\n')
      .filter(line => line.includes(root) && !line.includes('ps -eo'));
    expect(running).toEqual([]);

    // Idempotent: tearing down twice says there was nothing to do rather than failing.
    const again = await lazyDemo(['down'], root);
    expect(again.code).toBe(0);

    demoRoot = null;
    await rm(root, { recursive: true, force: true });
  }, 300_000);
});

/**
 * The refusals that make `--root` safe to offer.
 *
 * `lazy playground` removes its root recursively and kills processes associated with
 * it, on a path its caller names. These are the guards that stand between a
 * mistyped flag and someone's checkout, and they run in their own describe
 * block because none of them needs a provisioned demo — which is the point:
 * they must refuse BEFORE anything is created or destroyed.
 */
describe('lazy playground refuses what is not its own', () => {
  // INVARIANT: a root with content but no demo manifest is never removed. The
  // manifest is the only marker that says "this directory is ours", and without
  // this check `lazy playground down --root ~/prg/my-project` deleted a real
  // checkout — as did `lazy playground up` on the same path, silently, as its first
  // step before printing anything.
  test('refuses to tear down a directory that is not a demo, and leaves it intact', async () => {
    const root = await makeDemoRoot('lazy-demo-foreign-');
    await writeFile(join(root, 'package.json'), '{"name":"not-a-demo"}');
    await mkdir(join(root, 'src'), { recursive: true });

    const down = await lazyDemo(['down'], root);
    expect(down.code).not.toBe(0);
    expect(down.out).toContain('it is not a lazy playground');
    // The refusal names what it found, which is what makes a one-character
    // path typo obvious rather than mysterious.
    expect(down.out).toContain('package.json');

    // The whole point: still there.
    expect(await Bun.file(join(root, 'package.json')).exists()).toBe(true);

    // INVARIANT: `up` must not be a way around the check. It tears down before
    // provisioning, and that teardown is the same code — so it refuses too,
    // rather than replacing somebody's directory with a demo.
    const up = await lazyDemo(['up'], root);
    expect(up.code).not.toBe(0);
    expect(up.out).toContain('it is not a lazy playground');
    expect(await Bun.file(join(root, 'package.json')).exists()).toBe(true);

    await rm(root, { recursive: true, force: true });
  }, 120_000);

  // INVARIANT: some paths may never be a demo root whatever they contain,
  // because owning one would put a home directory or a whole filesystem inside
  // something this command deletes. Checked by SHAPE, so it holds even for a
  // root that does not exist yet.
  test('refuses a root that is, or contains, $HOME or a temp directory', async () => {
    for (const root of [homedir(), tmpdir(), '/']) {
      const result = await lazyDemo(['down'], root);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain('Refusing to use');
    }
  }, 120_000);

  // INVARIANT: the marker is the manifest's CONTENT, never its filename.
  // `demo.json` is a plausible name for a real project to carry, and
  // authorising an irreversible recursive delete on a filename match meant a
  // directory that happened to have one was removed whole.
  test('a directory whose demo.json is unrelated JSON survives', async () => {
    const root = await makeDemoRoot('lazy-demo-fakemarker-');
    await writeFile(join(root, 'demo.json'), '{"name":"my-app","version":"2.0.0"}');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.js'), 'console.log("keep me")');

    for (const verb of ['down', 'up']) {
      const result = await lazyDemo([verb], root);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain('it is not a lazy playground');
    }

    expect(await Bun.file(join(root, 'src', 'main.js')).exists()).toBe(true);
    await rm(root, { recursive: true, force: true });
  }, 300_000);

  // A manifest that parses and is the right version but names a DIFFERENT root
  // is somebody else's, copied, moved or restored — it must not authorise the
  // deletion of wherever it now sits.
  test('a manifest naming a different root does not authorise this one', async () => {
    const root = await makeDemoRoot('lazy-demo-movedmarker-');
    await writeFile(join(root, 'demo.json'), JSON.stringify({
      version: 1, root: '/somewhere/else', createdAt: 'x', lazyEntry: 'y',
      dashboardUrl: null, seededTasks: [],
    }));
    await writeFile(join(root, 'keep.txt'), 'data');

    const down = await lazyDemo(['down'], root);
    expect(down.code).not.toBe(0);
    expect(down.out).toContain('it is not a lazy playground');
    expect(await Bun.file(join(root, 'keep.txt')).exists()).toBe(true);
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  // INVARIANT: a manifest that will not parse is refused, never treated as
  // absent and never fallen through to the delete.
  test('a demo.json that will not parse is refused rather than deleted', async () => {
    const root = await makeDemoRoot('lazy-demo-badjson-');
    await writeFile(join(root, 'demo.json'), '{"version":1,"root":"/tmp/trunc');
    await writeFile(join(root, 'keep.txt'), 'data');

    const down = await lazyDemo(['down'], root);
    expect(down.code).not.toBe(0);
    expect(down.out).toContain('it is not a lazy playground');
    expect(await Bun.file(join(root, 'keep.txt')).exists()).toBe(true);
    await rm(root, { recursive: true, force: true });
  }, 120_000);
});

/**
 * A demo that fails partway through must still be removable.
 *
 * This is the other end of the same guard: once `up` has created content, that
 * content has no marker until the manifest is written — and content without a
 * marker is what teardown refuses. Written late, any failure after the daemon
 * started left the user wedged, with `down` and a retried `up` both refusing
 * the root while the daemon held its port.
 */
describe('lazy playground recovers from a half-provisioned root', () => {
  test('a demo killed during seeding can still be torn down', async () => {
    const root = await makeDemoRoot('lazy-demo-wedge-');

    // Start `up` and interrupt it once it is past the daemon and into seeding —
    // the longest phase, five real turns, and so the likeliest place to fail.
    // Tracked AND killed in the `finally`: the wait below can time out, and an
    // `expect` between the spawn and the kill used to leave this subprocess —
    // and the daemon it had already started — running for the rest of the run.
    const proc = trackSpawn(Bun.spawn([process.execPath, 'run', ENTRY, 'playground', 'up', '--root', root], {
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, LAZY_TEST: '', LAZY_PLAYGROUND_AGENT_PACING_MS: '0' } as Record<string, string>,
      stdout: 'pipe', stderr: 'pipe',
    }));
    const reader = new Response(proc.stdout).text();

    try {
      let sawSeeding = false;
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && !sawSeeding) {
        await new Promise(r => setTimeout(r, 1_000));
        sawSeeding = await Bun.file(join(root, 'demo.json')).exists()
          && await Bun.file(join(root, 'repo', 'lazy.toml')).exists();
      }
      expect(sawSeeding).toBe(true);

      proc.kill('SIGKILL');
      await proc.exited;
      await reader;

      // The marker is already down, so this is a demo — half-built, but ours.
      expect(await Bun.file(join(root, 'demo.json')).exists()).toBe(true);

      // INVARIANT: teardown succeeds. Before the manifest moved to the top of
      // `up`, this refused the root as foreign and the user had no way to stop
      // the daemon it had already started.
      const down = await lazyDemo(['down'], root);
      expect(down.code).toBe(0);
      expect(down.out).toContain('Playground torn down');
      expect(await Bun.file(join(root, 'demo.json')).exists()).toBe(false);
    } finally {
      proc.kill('SIGKILL');
      await proc.exited.catch(() => {});
      await lazyDemo(['down'], root).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});

/**
 * Teardown kills what the demo owns — and only that.
 *
 * Separate from the main flow because it needs an unrelated process alive at
 * the moment `down` runs, which is exactly the thing the old substring match
 * would have killed.
 */
describe('lazy playground down leaves unrelated processes alone', () => {
  test('a process merely mentioning the root survives teardown', async () => {
    const root = await makeDemoRoot('lazy-demo-bystander-');

    // The `up` and its assertion are INSIDE the try. Outside it, an `up` that
    // started the daemon and then failed during seeding threw here and no
    // `down` ever ran — leaking exactly the daemon and 45-minute agent this
    // file's other tests are about.
    const bystander = trackSpawn(Bun.spawn(['sleep', '120'], {
      cwd: root, stdout: 'ignore', stderr: 'ignore',
      // A process that names the demo root but is not part of the demo — the
      // engineer's editor, a tail, a build watching that directory. The root
      // appears in its environment and cwd but not in a path it owns. Under the
      // old sweep (`command.includes(root)`) this was SIGKILLed.
      env: { ...process.env, DEMO_ROOT_MENTION: root } as Record<string, string>,
    }));

    try {
      const up = await lazyDemo(['up'], root);
      expect(up.out).toContain('Playground is up');

      const down = await lazyDemo(['down'], root);
      expect(down.code).toBe(0);

      // INVARIANT: still alive. `down` reaps processes running against paths the
      // demo OWNS (its agent bin dir, its project, its daemon dir, its Teams
      // tree), never everything that happens to mention the root.
      expect(bystander.killed).toBe(false);
      expect(isAlive(bystander.pid)).toBe(true);
    } finally {
      bystander.kill('SIGKILL');
      await bystander.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});

/**
 * The demo's Lazy Teams must not touch a developer's own Teams data.
 *
 * This replaces a test that ran `up` and `down` with NO `--teams` flag, never
 * reached `src/demo/teams.ts` at all, and compared a file nothing had been
 * asked to write — so it was trivially green, would have stayed green if the
 * redirect were deleted, and self-skipped on a fresh container where there was
 * no database to compare. It also carried an INVARIANT comment for a path it
 * never executed. Two tests now, split by what each can actually decide:
 *
 *  1. A structural one that runs on every default `bun test` and needs no boot.
 *  2. A real `--teams` boot behind `LAZY_SLOW_TESTS=1`, because a Rails boot
 *     plus a fleet provision is minutes, not seconds.
 */
describe('the demo Teams keeps its databases under the demo root', () => {
  // INVARIANT: every path the demo's Teams writes to is UNDER the demo root.
  // Decidable without booting anything, which is the point — this is the
  // assertion that fails the moment somebody drops the redirect, and it runs by
  // default rather than only under an opt-in gate.
  test('every Teams path is inside the demo root, and the env names the storage dir', () => {
    const root = '/tmp/some-demo-root';
    const paths = demoTeamsPaths(root);

    for (const path of Object.values(paths)) {
      expect(path.startsWith(`${root}/`)).toBe(true);
    }

    const env = teamsEnv({
      sourceRoot: '/checkout',
      storageDir: paths.storageDir,
      fleetRoot: paths.fleetRoot,
      mode: { kind: 'demo', agentBinDir: '/agent/bin', repoPath: '/tmp/some-demo-root/repo' },
      home: '/tmp/some-demo-root/home',
    });

    // The single variable the whole property rests on.
    expect(env[STORAGE_DIR_ENV]).toBe(paths.storageDir);
    expect(env[STORAGE_DIR_ENV].startsWith(`${root}/`)).toBe(true);
  });

  // INVARIANT: the app must actually READ that variable. The demo setting it
  // and database.yml ignoring it would put the databases back in the checkout
  // with every test above still green — the two halves only mean something
  // together, so they are asserted together.
  test('database.yml resolves all four development databases through that variable', async () => {
    const yml = await Bun.file(
      join(resolve(import.meta.dir, '../..'), 'lazy-teams', 'config', 'database.yml'),
    ).text();

    const development = yml.slice(yml.indexOf('\ndevelopment:'), yml.indexOf('\ntest:'));
    const databases = [...development.matchAll(/^\s*database:\s*(.+)$/gm)].map(m => m[1].trim());

    expect(databases).toHaveLength(4);
    for (const database of databases) {
      expect(database).toContain(STORAGE_DIR_ENV);
    }
  });
});

/**
 * The real thing: `--teams` end to end, and the shared database still intact.
 *
 * Gated because it boots Rails, prepares four databases, builds a stylesheet
 * and waits for a server — minutes rather than the ~25s the rest of this file
 * costs. Everything it asserts is impossible to check without that boot, which
 * is exactly why it exists: the fast test above cannot tell you that
 * `db:prepare` actually wrote where it was told to.
 */
describe.skipIf(slowSuiteSkipped('demo --teams'))('lazy playground up --teams', () => {
  test('writes its databases under the demo root and leaves the checkout alone', async () => {
    const checkout = resolve(import.meta.dir, '../..');
    const sharedDir = join(checkout, 'lazy-teams', 'storage');
    const shared = join(sharedDir, 'development.sqlite3');

    // Take a fingerprint of the WHOLE shared storage directory, not one file:
    // the bug dropped four databases, and three of them would survive a check
    // that only looked at the primary.
    const fingerprint = async () => {
      const names = (await readdir(sharedDir).catch(() => [] as string[]))
        .filter(n => n.startsWith('development')).sort();
      const parts: string[] = [];
      for (const name of names) {
        parts.push(`${name}:${Bun.hash(await Bun.file(join(sharedDir, name)).arrayBuffer())}`);
      }
      return parts.join('|');
    };

    const hadDatabase = await Bun.file(shared).exists();
    const before = await fingerprint();

    const root = await makeDemoRoot('lazy-demo-teams-');
    try {
      const up = await lazyDemo(['up', '--teams'], root);
      expect(up.out).toContain('Playground is up');
      expect(up.out).toContain('Teams:');

      // The demo's OWN databases exist, under the demo root.
      const demoStorage = join(root, 'teams', 'storage');
      const demoDatabases = (await readdir(demoStorage)).filter(n => n.endsWith('.sqlite3'));
      expect(demoDatabases).toContain('development.sqlite3');
      expect(demoDatabases.length).toBeGreaterThanOrEqual(4);

      // INVARIANT: the checkout's shared development databases are untouched by
      // a run that really did prepare and seed four of them. `--teams` used to
      // run db:prepare and then db:drop against these files, seeding and then
      // deleting whatever a developer had in their own Teams install.
      expect(await fingerprint()).toBe(before);
      if (hadDatabase) expect(await Bun.file(shared).exists()).toBe(true);

      // And Rails' pidfile did not land in the checkout either.
      expect(await Bun.file(join(checkout, 'lazy-teams', 'tmp', 'pids', 'server.pid')).exists())
        .toBe(false);

      const down = await lazyDemo(['down'], root);
      expect(down.code).toBe(0);
      expect(await fingerprint()).toBe(before);
    } finally {
      await lazyDemo(['down'], root);
      await rm(root, { recursive: true, force: true });
    }
  }, 1_800_000);
});

/** Is there still a process with this pid? Signal 0 tests without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Trade a one-time login link for the session cookie.
 *
 * `redirect: 'manual'` because the link RESPONDS with the cookie and a
 * redirect; following it would drop the Set-Cookie header we are here for.
 */
async function signIn(loginUrl: string): Promise<string> {
  const res = await fetch(loginUrl, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`No session cookie from the demo dashboard login link (status ${res.status})`);
  }
  return setCookie.split(';')[0];
}

/**
 * The demo must not touch the machine's own Claude Code configuration.
 *
 * Demo turns run on the host-process runner, and every agent launch writes an
 * MCP entry to `$HOME/.claude.json`, merges a tool allowlist into
 * `$HOME/.claude/settings.json` and leaves session state under
 * `$HOME/.claude/projects/`. Inheriting the ambient home meant five seeded turns
 * per `up` rewrote the machine's own config to point at the demo's worktree —
 * which teardown then deleted.
 *
 * That is not hypothetical: `docs/testing-harness.md` records stray supervisors
 * re-pointing a real agent's tool channel at a deleted worktree, and Claude Code
 * reads ONE MCP config per home. On a machine where an agent is working, the
 * demo was doing that to it on purpose.
 */
describe('lazy playground leaves the ambient HOME alone', () => {
  // INVARIANT: an up/down cycle leaves `$HOME/.claude.json` byte-identical.
  // This is the assertion that stops the leak coming back — every other guard
  // in this command is about the demo root, and this is the one thing that was
  // outside it.
  test('an up/down cycle does not modify the real ~/.claude.json', async () => {
    const claudeConfig = join(homedir(), '.claude.json');

    // Only meaningful where one exists. Say so loudly rather than passing
    // vacuously — a silent skip here is how the previous version of this
    // file's Teams test managed to assert nothing at all.
    if (!(await Bun.file(claudeConfig).exists())) {
      console.log('skipped: no ~/.claude.json on this machine to protect');
      return;
    }

    const before = Bun.hash(await Bun.file(claudeConfig).arrayBuffer()).toString();

    const root = await makeDemoRoot('lazy-demo-home-');
    try {
      const up = await lazyDemo(['up'], root);
      expect(up.out).toContain('Playground is up');

      // The writes happened — just not in the ambient home. If the demo's own
      // HOME has no Claude state, the redirection is not being used at all and
      // the byte comparison below would pass for the wrong reason.
      const demoHome = demoPaths(root).home;
      expect(await Bun.file(join(demoHome, '.claude.json')).exists()).toBe(true);

      expect(Bun.hash(await Bun.file(claudeConfig).arrayBuffer()).toString()).toBe(before);

      await lazyDemo(['down'], root);
      expect(Bun.hash(await Bun.file(claudeConfig).arrayBuffer()).toString()).toBe(before);
    } finally {
      await lazyDemo(['down'], root);
      await rm(root, { recursive: true, force: true });
    }
  }, 900_000);

  // The demo's HOME is inside the demo root, so teardown removes it with
  // everything else — which is what makes "it only ever touches its own root"
  // true rather than nearly true.
  test('the demo HOME is under the demo root', () => {
    const paths = demoPaths('/tmp/some-demo-root');
    expect(paths.home).toBe('/tmp/some-demo-root/home');
    expect(paths.home.startsWith(`${paths.root}/`)).toBe(true);
  });

  // INVARIANT: HOME is always set explicitly, never inherited. If it were on
  // the inherit allowlist, a caller that passed no override would silently get
  // the ambient one back and the whole leak would return.
  test('the demo environment always overrides HOME', () => {
    const paths = demoPaths('/tmp/some-demo-root');
    expect(demoEnvOverrides(paths).HOME).toBe(paths.home);
  });
});

// `--fleet` refuses before it touches anything: every missing input is named,
// and the previous demo (if any) is not torn down on the way to the refusal.
// Cheap — no daemon, no Rails — so it is not gated like the boots above.
describe('lazy playground up --fleet refuses before touching anything', () => {
  test('a missing smolvm binary is refused by name and the root stays untouched', async () => {
    const root = await makeDemoRoot('lazy-demo-fleet-refusal-');
    await writeFile(join(root, 'marker.txt'), 'not a demo');
    const proc = trackSpawn(Bun.spawn([process.execPath, 'run', ENTRY, 'playground', 'up', '--teams', '--fleet', 'smolvm',
      '--repo', 'https://github.com/example/some-public-repo.git', '--root', root], {
      cwd: resolve(import.meta.dir, '../..'),
      env: {
        ...process.env, LAZY_TEST: '', LAZY_SMOLVM_BINARY: '', LAZY_DAEMON_IMAGE: '/tmp/lazy-daemon.tar',
        CLAUDE_CODE_OAUTH_TOKEN: 'not-used', LAZY_FLEET_BACKEND: '',
      } as Record<string, string>,
      stdout: 'pipe', stderr: 'pipe',
    }));
    const out = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
    expect(await proc.exited).not.toBe(0);
    expect(out).toContain('LAZY_SMOLVM_BINARY is not set');
    // Nothing was created and nothing removed: the foreign marker is still there
    // and no manifest appeared.
    expect(await readdir(root)).toEqual(['marker.txt']);
  });

  // The guest clones with no credentials over public egress only, so a URL the
  // Mac cannot fetch anonymously is refused BEFORE anything is created — here an
  // address nothing listens on, which fails the same way a private repository
  // does and needs no network.
  test('a repository that cannot be fetched without credentials is refused, and the root stays untouched', async () => {
    const root = await makeDemoRoot('lazy-demo-fleet-refusal-');
    const proc = trackSpawn(Bun.spawn([process.execPath, 'run', ENTRY, 'playground', 'up', '--teams', '--fleet', 'smolvm',
      '--repo', 'https://127.0.0.1:1/private/repo.git', '--root', root], {
      cwd: resolve(import.meta.dir, '../..'),
      env: {
        ...process.env, LAZY_TEST: '', LAZY_SMOLVM_BINARY: '/nonexistent/smolvm', LAZY_DAEMON_IMAGE: '/tmp/lazy-daemon.tar',
        CLAUDE_CODE_OAUTH_TOKEN: 'not-used', LAZY_FLEET_BACKEND: '',
      } as Record<string, string>,
      stdout: 'pipe', stderr: 'pipe',
    }));
    const out = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
    expect(await proc.exited).not.toBe(0);
    expect(out).toContain('cannot be fetched without credentials');
    expect(await readdir(root)).toEqual([]);
  });

  test('--fleet without --teams, and a shell backend without the flag, are refused', async () => {
    const root = await makeDemoRoot('lazy-demo-fleet-refusal-');
    const noTeams = await lazyDemo(['up', '--fleet', 'smolvm'], root);
    expect(noTeams.code).not.toBe(0);
    expect(noTeams.out).toContain('needs --teams');

    const proc = trackSpawn(Bun.spawn([process.execPath, 'run', ENTRY, 'playground', 'up', '--root', root], {
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, LAZY_TEST: '', LAZY_FLEET_BACKEND: 'smolvm' } as Record<string, string>,
      stdout: 'pipe', stderr: 'pipe',
    }));
    const out = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
    expect(await proc.exited).not.toBe(0);
    expect(out).toContain('LAZY_FLEET_BACKEND=smolvm is set');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('the old `lazy demo` spelling', () => {
  // INVARIANT: `lazy demo` keeps working for one release after the rename to
  // `lazy playground`, and says so on stderr. A script written against the old
  // name must not break on upgrade, and must not have its stdout changed either.
  test('runs the playground command and points at the new name', async () => {
    const root = await makeDemoRoot('lazy-playground-alias-');
    const result = await lazyDemo(['status'], root, 'demo');
    expect(result.code).toBe(0);
    expect(result.out).toContain('lazy demo is now lazy playground');
    expect(result.out).toContain(`No playground at ${root}`);
  }, 60_000);
});

describe('lazy playground up --repo', () => {
  // INVARIANT: pointed at the playground repository, the demo adopts it as the
  // project and creates exactly its starter tasks, in the backlog, and none of
  // the fixture's seeded states. The repository is built by the same publish
  // script the engineer runs, so this also proves what that script produces is
  // a working lazy project.
  test('adopts the playground and seeds its starter tasks', async () => {
    const root = await makeDemoRoot('lazy-demo-playground-');
    // Beside the root, not inside it: `demo up` refuses a root with foreign content.
    const built = await makeDemoRoot('lazy-playground-build-');
    const script = resolve(import.meta.dir, '../../scripts/publish-playground-repo.sh');
    // A pinned identity: the script commits as whoever runs it, and a CI runner may have none.
    const identity = { GIT_AUTHOR_NAME: 'Lazy Demo', GIT_AUTHOR_EMAIL: 'demo@lazy.invalid', GIT_COMMITTER_NAME: 'Lazy Demo', GIT_COMMITTER_EMAIL: 'demo@lazy.invalid' };
    const build = Bun.spawnSync(['bash', script, '--out', built], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...identity } });
    expect(build.stdout.toString()).toContain('Nothing was pushed');
    expect(build.exitCode).toBe(0);

    const up = await lazyDemo(['up', '--repo', built], root);
    expect(up.out).toContain('Starter tasks');
    expect(up.code).toBe(0);

    const expected = (await Bun.file(join(built, 'tasks.json')).json()) as { tasks: { code: string }[] };
    const list = await lazyInDemo(['list', '--all'], root);
    for (const { code } of expected.tasks) expect(list).toMatch(new RegExp(`${code}\\s+backlog`));
    expect(list).not.toContain('demo-');

    // The clone is local-only, and keeps the playground's own protection.
    const remotes = Bun.spawnSync(['git', 'remote'], { cwd: join(root, 'repo') }).stdout.toString();
    expect(remotes.trim()).toBe('');
    const toml = await Bun.file(join(root, 'repo', 'lazy.toml')).text();
    expect(toml).toContain('protected = ["src/schema.sql"]');

    // A starter task really runs in the cloned project — the output invites it.
    const first = expected.tasks[0]!.code;
    await lazyInDemo(['start', first], root);
    // Polled rather than `lazy wait`: wait returns at turn end, while the
    // playground's post_turn check (`bun test`) is still running.
    let after = '';
    for (let i = 0; i < 120; i++) {
      after = await lazyInDemo(['list', '--all'], root);
      if (new RegExp(`${first}\\s+blocked`).test(after)) break;
      await Bun.sleep(1000);
    }
    expect(after).toMatch(new RegExp(`${first}\\s+blocked`));
  }, 600_000);

  // INVARIANT: a repository the human NAMED that cannot be cloned is an error,
  // never a silent fallback to the fixture — only the built-in default may fall back.
  test('refuses a named repository it cannot clone', async () => {
    const root = await makeDemoRoot('lazy-demo-badrepo-');
    const up = await lazyDemo(['up', '--repo', join(root, 'no-such-repo')], root);
    expect(up.code).not.toBe(0);
    expect(up.out).toContain('Could not clone');
  }, 120_000);
});
