/**
 * Signalling a recorded process GROUP is verified, not argued for.
 *
 * Once a supervisor dies, its process group is the only handle left on the agent
 * it spawned — but a pgid IS a pid, and pids are recycled. "The group is
 * non-empty, so it must still be ours" is a plausibility argument: it holds only
 * while the number was never reused, which is exactly what cannot be assumed.
 * This project has already lost an afternoon to a recycled pid making a dead
 * storage-lock holder look alive forever, and a SIGKILL aimed at a whole group
 * on a stale number is that hazard with a far larger blast radius — it would
 * kill another task's live agent.
 *
 * So the runner requires a MEMBER of the recorded group to be working in the
 * worktree the run recorded. These tests drive both directions of that check
 * against real processes, because an ownership test that only ever sees owned
 * processes proves nothing about the case that matters.
 *
 * Both use a run record whose supervisor pid is DEAD, which is the only path
 * that consults the recorded group at all.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HostProcessRunner } from '../../src/runner/host-process-runner';
import { processGroupId, isRunningProcess } from '../../src/utils/process-identity';

/**
 * Reproduce the shape the runner actually meets: a process group whose LEADER
 * has exited while a member of it is still running in `cwd`.
 *
 * That is what a dead supervisor leaves behind, and it is the only state in
 * which the recorded pgid is consulted — the leader's own `/proc` entry is gone,
 * so the group id cannot be re-read from it. Using a live leader here would test
 * a branch that never runs.
 *
 * Returns the leader's pid, which is also the group id, exactly as the run
 * record stores it.
 */
async function deadLeaderWithLiveMemberIn(cwd: string) {
  const marker = join(cwd, 'member.pid');
  // `sh` becomes its own group leader (detached), starts a child that inherits
  // the group, then exits — leaving the group populated and leaderless.
  const leader = Bun.spawn(['sh', '-c', `sleep 120 & echo $! > ${JSON.stringify(marker)}; exit 0`], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  await leader.exited;

  // The group is read off the MEMBER, never off the leader. Reading it from the
  // leader races its exit — `sh` is gone within milliseconds of the spawn, and a
  // `/proc` entry that has already vanished reports no group at all, which made
  // this helper throw intermittently. The member is in the leader's group by
  // inheritance, so it reports the same number and is still there to be asked.
  for (let i = 0; i < 100; i++) {
    const raw = await Bun.file(marker).text().catch(() => '');
    const member = Number(raw.trim());
    if (Number.isInteger(member) && member > 0) {
      const pgid = await processGroupId(member);
      if (pgid !== null) {
        // The run record's invariant: the recorded group IS the leader's pid.
        if (pgid !== leader.pid) {
          throw new Error(`stand-in group ${pgid} is not the leader's pid ${leader.pid}`);
        }
        return { pgid, member };
      }
    }
    await Bun.sleep(20);
  }
  throw new Error('stand-in group never reported a live member');
}

describe('a recorded process group is signalled only when it is verifiably ours', () => {
  let home: string;
  let worktree: string;
  let strangerCwd: string;
  let previousHome: string | undefined;
  let victims: number[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-grp-home-'));
    worktree = await realpath(await mkdtemp(join(tmpdir(), 'lazy-grp-worktree-')));
    strangerCwd = await realpath(await mkdtemp(join(tmpdir(), 'lazy-grp-elsewhere-')));
    await mkdir(join(home, '.lazy', 'run'), { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = home;
    victims = [];
  });

  afterEach(async () => {
    for (const pid of victims) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(strangerCwd, { recursive: true, force: true });
  });

  /**
   * A run record exactly as a launch writes one: pid === pgid, because the
   * supervisor is spawned with setsid() and so leads the group it is recorded
   * against. The pid is dead here — that is the whole point — but the EQUALITY
   * is load-bearing, and a fixture that broke it would silently exercise the
   * fallback path instead of the branch under test.
   */
  async function writeRunRecord(runName: string, pgid: number, recordedWorktree = worktree) {
    await writeFile(
      join(home, '.lazy', 'run', `${runName}.json`),
      JSON.stringify({
        pid: pgid,
        pgid,
        worktree: recordedWorktree,
        startedAt: new Date().toISOString(),
        logFile: join(home, 'missing.log'),
      }),
    );
  }

  // INVARIANT: a recorded pgid whose group contains nothing of ours is NOT
  // signalled. This is the pid-reuse case — the number in the run file now names
  // somebody else's group — and the only acceptable outcome is to leave it be.
  test('refuses a group that no longer belongs to the run', async () => {
    // Working somewhere else entirely: nothing ties it to this run's worktree.
    const stranger = await deadLeaderWithLiveMemberIn(strangerCwd);
    victims.push(stranger.pgid);
    await writeRunRecord('lazy-stranger', stranger.pgid);

    const runner = new HostProcessRunner();
    await runner.stopRun('lazy-stranger');

    expect(await isRunningProcess(stranger.member)).toBe(true);
  }, 30_000);

  // INVARIANT: a SYMLINKED worktree path still verifies.
  //
  // The recorded worktree is whatever string the launch was handed; the cwd
  // comes back from the kernel already fully resolved. Compare them raw and any
  // symlink in the project path makes this decline FOREVER — silently, since
  // declining is the safe direction and nothing logs it. That turns the
  // verification that fixes the orphan leak into a permanent version of the
  // leak, on exactly the platform the engineer works on: macOS `tmpdir()` is
  // `/var`, a symlink to `/private/var`, so every temp path there has this
  // shape.
  test('verifies through a symlinked worktree path', async () => {
    // The record holds the symlink; the process resolves through it.
    const link = join(strangerCwd, 'linked-worktree');
    await symlink(worktree, link);
    const ours = await deadLeaderWithLiveMemberIn(worktree);
    victims.push(ours.pgid);
    await writeRunRecord('lazy-symlinked', ours.pgid, link);

    const runner = new HostProcessRunner();
    await runner.stopRun('lazy-symlinked');

    const deadline = Date.now() + 15_000;
    while (await isRunningProcess(ours.member) && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect(await isRunningProcess(ours.member)).toBe(false);
  }, 30_000);

  // INVARIANT: and the check is not vacuous — a group that IS ours is signalled.
  // Without this, the test above would pass just as well against a runner that
  // never signals anything.
  test('signals a group that is working in the run’s own worktree', async () => {
    const ours = await deadLeaderWithLiveMemberIn(worktree);
    victims.push(ours.pgid);
    await writeRunRecord('lazy-ours', ours.pgid);

    const runner = new HostProcessRunner();
    await runner.stopRun('lazy-ours');

    const deadline = Date.now() + 15_000;
    while (await isRunningProcess(ours.member) && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect(await isRunningProcess(ours.member)).toBe(false);
  }, 30_000);
});
