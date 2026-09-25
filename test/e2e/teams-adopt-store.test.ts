/**
 * Adopting an existing lazy store into a Lazy Teams project, end to end.
 *
 * `lazy playground up --teams` gives us the two halves nothing else can fake: a REAL
 * store, written by a real daemon running real turns, and a REAL Lazy Teams
 * that can be asked to take it over. The Ruby suite
 * (`lazy-teams/test/models/adopts_store_test.rb`) covers the refusals against a
 * fake supervisor; this covers the thing those fakes stand in for — that the
 * store lazy actually writes is the store Teams can actually adopt, and that a
 * daemon Teams starts on it serves the tasks that were already in it.
 *
 * GATED, and it has to be: it boots Rails, prepares four databases, builds a
 * stylesheet and then provisions a second project. Minutes, not seconds.
 *
 * Two cases, and the refusal is the more interesting one. The demo's own store
 * is LIVE — a daemon Teams started is holding its lock — so pointing the
 * adoption at it must refuse rather than hand one store to two daemons. That is
 * the failure the whole preflight exists for, and it is not reproducible
 * against a stub.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { cp, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { slowSuiteSkipped } from '../helpers/slow-suite';
import { demoTeamsPaths, teamsEnv } from '../../src/demo/teams';
import { demoPaths } from '../../src/demo/paths';

const CHECKOUT = resolve(import.meta.dir, '../..');
const ENTRY = join(CHECKOUT, 'src', 'index.ts');
const APP_DIR = join(CHECKOUT, 'lazy-teams');

const createdRoots = new Set<string>();

afterAll(async () => {
  for (const root of createdRoots) {
    await lazyDemo([ 'down' ], root).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

async function lazyDemo(args: string[], root: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([ process.execPath, 'run', ENTRY, 'playground', ...args, '--root', root ], {
    cwd: CHECKOUT,
    env: { ...process.env, LAZY_TEST: '', LAZY_PLAYGROUND_AGENT_PACING_MS: '0' } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [ stdout, stderr ] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: (await proc.exited) ?? 1, out: `${stdout}\n${stderr}` };
}

/**
 * Run a rake task or a runner script inside the demo's Teams install.
 *
 * The environment comes from `teamsEnv`, the same function `lazy playground up
 * --teams` boots the server with — a hand-assembled one would reach different
 * databases and a different fleet root, and every assertion here would then be
 * about a Teams install nobody is looking at.
 */
async function teamsRun(
  root: string, argv: string[], extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const paths = demoPaths(root);
  const teams = demoTeamsPaths(root);
  const env = {
    ...teamsEnv({
      sourceRoot: CHECKOUT,
      storageDir: teams.storageDir,
      fleetRoot: teams.fleetRoot,
      mode: { kind: "demo", agentBinDir: join(paths.agent, "bin"), repoPath: paths.repo },
      home: paths.home,
    }),
    ...extraEnv,
  };

  const proc = Bun.spawn(argv, { cwd: APP_DIR, env, stdout: 'pipe', stderr: 'pipe' });
  const [ stdout, stderr ] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: (await proc.exited) ?? 1, out: `${stdout}\n${stderr}` };
}

describe.skipIf(slowSuiteSkipped('teams adopt-store'))('adopting an existing store into Teams', () => {
  test('refuses a live store, then adopts a copy and serves its tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-adopt-teams-'));
    createdRoots.add(root);

    const up = await lazyDemo([ 'up', '--teams' ], root);
    expect(up.out).toContain('Teams:');
    expect(up.code).toBe(0);

    // The demo's OWN store: seeded by real turns from the daemon `lazy playground
    // up` started, and still held by it. Not the Teams project's store — Teams
    // provisions that on its reconciler's next tick, so at this point it does
    // not exist yet, and waiting a minute for one would prove nothing extra.
    const liveStore = demoPaths(root).store;

    // It really is a store with real work in it — otherwise the adoption below
    // would be proving nothing.
    const check = await teamsRun(root, [ process.execPath, 'run', ENTRY, 'system', 'store-check', liveStore ]);
    expect(check.out).toContain('Store:');
    const taskCount = Number(check.out.match(/Tasks:\s+(\d+)/)?.[1] ?? 0);
    expect(taskCount).toBeGreaterThan(0);

    // INVARIANT: a store whose lock is HELD is refused. A daemon Teams started
    // is serving this one; adopting it would give one store two writers.
    const refused = await teamsRun(root, [ 'bin/rails', 'lazy:adopt_store' ], {
      TEAM: 'acme', NAME: 'Second Sight',
      REPO_URL: `file://${demoPaths(root).repo}`, STORE: liveStore,
    });
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('still locked');

    // A copy of the same store, with the lock left behind, is adoptable. This
    // is exactly what an operator does with a store from another machine.
    const incoming = join(root, 'incoming-store');
    await cp(liveStore, incoming, { recursive: true, filter: (src) => !src.endsWith('.storage-lock') });

    const adopted = await teamsRun(root, [ 'bin/rails', 'lazy:adopt_store' ], {
      TEAM: 'acme', NAME: 'Adopted Project',
      REPO_URL: `file://${demoPaths(root).repo}`, STORE: incoming,
    });
    expect(adopted.out).toContain(`adopted ${taskCount} task(s)`);
    expect(adopted.out).toContain('ADOPTED IN PLACE');
    expect(adopted.code).toBe(0);

    // The proof: the project Teams provisioned on that directory answers with
    // the tasks that were already in it. Read through the app the way a page
    // does — the daemon's own reply, not the files on disk.
    const listed = await teamsRun(root, [ 'bin/rails', 'runner', [
      'project = Project.find_by!(name: "Adopted Project")',
      'raise "not ready: #{project.provisioning_error}" unless project.ready?',
      'tasks = LazyDaemon::Client.for(project).list(all: true)',
      // `list` answers with a TREE, so the count is every node in it, not the
      // length of the top level — the demo's seeded tasks include subtasks.
      'count = ->(nodes) { Array(nodes).sum { |n| 1 + count.call(n["children"]) } }',
      'puts "ADOPTED_TASKS=#{count.call(tasks["tree"])}"',
      'puts "ADOPTED_STORE=#{project.store_path}"',
    ].join('; ') ]);

    expect(listed.out).toContain(`ADOPTED_STORE=${incoming}`);
    const served = Number(listed.out.match(/ADOPTED_TASKS=(\d+)/)?.[1] ?? -1);
    expect(served).toBe(taskCount);
  }, 2_400_000);
});
