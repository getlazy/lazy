/**
 * Reaping the processes a demo leaves behind.
 *
 * WHY THIS IS NEEDED AT ALL. `lazy daemon stop` ends the daemon, but the demo
 * deliberately leaves one task MID-TURN — that is the whole point of its
 * `working` state — and that turn's agent process outlives the daemon that
 * spawned it. Without this sweep, every `lazy playground down` left a held-open agent
 * running against a directory that had just been deleted. Observed, not
 * theorised.
 *
 * WHAT IT MATCHES, AND WHY NOT THE ROOT. The first version matched any process
 * whose command line CONTAINED the demo root as a substring. That is far too
 * broad for a value the caller supplies: `--root /tmp` or `--root ~` turned the
 * sweep into "SIGKILL everything on this machine whose argv mentions that
 * path" — the engineer's editor, other lazy daemons, other tasks' agents.
 *
 * So the match is on paths the demo genuinely OWNS, each tested as a path
 * boundary rather than a substring: the stand-in agent binary's directory, the
 * demo project (which is where every worktree path lives), and the demo's
 * daemon state directory. A process is only killed if its command line names
 * one of those, which no unrelated process has a reason to do. Combined with
 * {@link assertRootIsOwnable}, a root short enough to be dangerous is refused
 * before any of this runs.
 */

import { spawnSyncUnsupervised } from '../utils/spawn';
import { allowlistedEnv } from './runtime';
import { sep } from 'path';
import { join } from 'path';
import { SIGNAL_SHUTDOWN_BUDGET_MS } from '../daemon/lifecycle';
import type { DemoPaths } from './paths';

/** A process matched by the sweep. */
export interface ReapedProcess {
  pid: number;
  command: string;
  /** Which owned path matched — in the message when the sweep reports. */
  matched: string;
}

/**
 * The paths only this demo's own processes can be running against.
 *
 * Each carries a trailing separator so the test is "inside this directory"
 * rather than "starts with these characters": without it, a demo at
 * `/tmp/demo` would match a process working in `/tmp/demo-other`.
 */
export function demoOwnedPathMarkers(paths: DemoPaths): string[] {
  return [
    // The stand-in agent binary: `<root>/agent/bin/claude`, which the demo
    // daemon puts on PATH and the supervisor execs. This is the marker that
    // catches the held-open agent, the process this sweep exists for.
    join(paths.agent, 'bin') + sep,
    // The demo project, and therefore every task worktree beneath it —
    // supervisors carry their worktree path on argv.
    paths.repo + sep,
    // The demo daemon's own state directory.
    paths.daemonBase + sep,
    // Everything the demo's Lazy Teams owns — its databases, its log, and above
    // all its FLEET: with `--teams`, Teams provisions the demo project by
    // starting a daemon of its OWN under `<root>/teams/fleet/...`, which is a
    // different process from the demo's daemon and survives stopping it. Left
    // out, that daemon outlived every teardown and kept recreating the root
    // directory it was serving, so the next `lazy playground up` found content with no
    // manifest and refused. Observed, not theorised.
    paths.teams + sep,
  ];
}

/**
 * Find processes running against paths this demo owns.
 *
 * `ps` rather than anything cleverer: it is present everywhere lazy runs, and
 * the alternative (walking /proc) is Linux-only while the demo is expected to
 * work on a developer's Mac too.
 */
export function findDemoProcesses(paths: DemoPaths): ReapedProcess[] {
  const result = spawnSyncUnsupervised(['ps', '-eo', 'pid=,args='], { timeout: 15_000, env: allowlistedEnv() });
  if (result.exitCode !== 0) {
    // A failed `ps` must not block teardown: the daemon has already been asked
    // to stop, and refusing to delete the root over a failed probe would leave
    // more behind than it saves.
    return [];
  }

  const markers = demoOwnedPathMarkers(paths);
  const self = process.pid;
  const out: ReapedProcess[] = [];

  for (const line of result.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === self || pid === process.ppid) continue;

    const matched = markers.find(marker => command.includes(marker));
    if (matched) out.push({ pid, command, matched });
  }
  return out;
}

/**
 * Stop every process still running against this demo's own paths.
 *
 * SIGTERM first, then SIGKILL for anything that ignores it — the same
 * escalation the supervisor's watchdog uses, and for the same reason: a polite
 * signal is correct for a process that will honour it, and a teardown that can
 * be defeated by a process choosing not to exit is not a teardown.
 *
 * The grace is POLLED to a deadline rather than slept flat, and the deadline is
 * SIGNAL_SHUTDOWN_BUDGET_MS, not a number of its own. A `--teams` demo's fleet
 * daemons match `paths.teams` and are signalled here, and a signalled daemon
 * shuts its own project's agents down and records why their turns ended before
 * it exits — work that a SIGKILL partway through loses, leaving turns reading as
 * "General error" and `.storage-lock` naming a pid that will one day be
 * recycled. The old flat 1.5s was shorter than that budget, so it cut exactly
 * that short. (The demo's OWN daemon is not reached here at all — its argv
 * carries `--project <root>/repo` with no trailing separator, and every marker
 * has one — but relying on that would make this correct by accident.)
 *
 * Polling also makes the common case FASTER than the sleep it replaces: with
 * everything dying promptly, teardown now costs one poll interval instead of a
 * flat second and a half.
 */
export async function reapDemoProcesses(paths: DemoPaths): Promise<ReapedProcess[]> {
  const found = findDemoProcesses(paths);
  if (found.length === 0) return [];

  for (const proc of found) signalQuietly(proc.pid, 'SIGTERM');

  // One grace period for all of them together rather than per process: they are
  // siblings, they exit concurrently, and teardown should not scale with how
  // many turns the demo happened to leave open.
  const deadline = Date.now() + SIGNAL_SHUTDOWN_BUDGET_MS;
  let remaining = findDemoProcesses(paths);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    remaining = findDemoProcesses(paths);
  }

  for (const proc of remaining) signalQuietly(proc.pid, 'SIGKILL');

  return found;
}

/**
 * Signal a pid, treating "already gone" as success.
 *
 * ESRCH is the normal race — the process exited between the `ps` and the
 * signal. EPERM means it is not ours to kill, which a demo teardown should
 * survive rather than die on.
 */
function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw new Error(`Failed to ${signal} playground process ${pid}: ${(err as Error).message}`);
  }
}
