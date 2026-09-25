/**
 * Host half of in-container pairing — the launcher `lazy pair <task>` gives the
 * interactive supervisor.
 *
 * `lazy pair` used to run Claude Code as a HOST process in the task's worktree.
 * That was the escape hatch for everything that did not work in a container, and
 * it was also a security hole with a body count: the agent ran unconfined as the
 * human, and container-written session state had to be carried across the
 * boundary to be resumable (see pair-bridge.ts and the invariants in
 * test/unit/pair-no-host-home-writes.test.ts). Pairing now runs where supervised
 * turns run — `docker exec -it <task container> lazy-agent pair …` — so:
 *
 *  - the session's `~/.claude` / `~/.cursor` IS the sandbox mount the task's own
 *    turns write, so resume needs no bridging, no copying, and no host home;
 *  - `--autonomous` is the same trust decision as any supervised turn rather
 *    than unrestricted access to the human's machine;
 *  - anything that does not work in the container is now a container bug to fix,
 *    not something pairing quietly routes around.
 *
 * WHY EXEC RATHER THAN A NEW CONTAINER: the task's container is a long-lived
 * thing that may be running dev servers, watchers, and published ports. Pairing
 * joins it; it does not replace it. `ensureTaskContainer` (daemon-side) starts
 * one only when there is none.
 *
 * WHY THE AUTH ENV IS RE-PASSED ON EVERY EXEC: the container's baked-in env
 * carries the audit proxy address it was launched with, and a daemon restart
 * moves that address (OS-assigned port). The exec's own `-e` values win over the
 * container's, so each (re)launch talks to the live proxy without recreating the
 * container and killing whatever else is running in it. The values are JIT
 * PLACEHOLDERS the proxy exchanges upstream, never the human's token — the same
 * thing `docker run` already puts in its argv at container launch.
 */

import { readFile, rm } from 'fs/promises';
import { resolveInteractiveLaunch, launchEnvOverlay } from '../../credentials/interactive-auth';
import { profileNameForAgent } from '../../config/agent-profiles';
import { pairPidFilePath, pairInContainerCmd } from '../../supervisor/pair';
import { queryEnsureTaskContainer } from '../../daemon/rpc-fallback';
import { spawn } from '../../utils/spawn';
import { SANDBOX_DIR } from '../../utils/sandbox';
import { join } from 'path';
import type { InteractiveLauncher, InteractiveLaunchPlan } from '../../supervisor/interactive';

/** How long the reach-in stop waits on docker before giving up (ms). */
const REACH_IN_STOP_TIMEOUT_MS = 10_000;

/**
 * Argv for one `docker exec` into a task's container. Pure, so it is testable
 * without docker — the shape of this command is the contract with
 * `lazy-agent pair` (src/supervisor/pair.ts).
 */
export function buildPairExecArgs(opts: {
  /** Container CLI: `docker` or `podman`. */
  binary: string;
  containerName: string;
  /** Full task UUID — what the in-container MCP server is scoped to. */
  taskId: string;
  worktreePath: string;
  /**
   * Agent BINARY to hand the terminal to — a harness, not a profile name.
   * `lazy-agent pair --agent` looks it up in the agent registry, which is keyed
   * by harness. See `commandHarness` in src/supervisor/index.ts.
   */
  harness: string;
  runnerType: string;
  /** Allocate a tty. False when stdout is not a terminal (piped/CI). */
  tty: boolean;
  sessionId?: string | null;
  modelId?: string | null;
  autonomous?: boolean;
  /** Env passed with `-e`, freshest wins over the container's baked values. */
  env?: Record<string, string>;
  /**
   * Reflective chat rather than a pairing takeover. The in-container process
   * still runs `lazy-agent pair`, with `--chat` so MCP is read-only and the
   * agent is locked down the same way `lazy chat` is.
   */
  chat?: boolean;
}): string[] {
  const argv = [opts.binary, 'exec', '-i'];
  if (opts.tty) argv.push('-t');
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    argv.push('-e', `${key}=${value}`);
  }
  argv.push(opts.containerName, ...pairInContainerCmd(opts));
  return argv;
}

/**
 * Stop an in-container pairing session, best-effort.
 *
 * Docker does not forward signals to an exec'd process, so killing the local
 * `docker exec` client leaves `lazy-agent pair` running inside the container,
 * still holding the session a relaunch is about to `--resume`. The in-container
 * process publishes its pid to the sandbox dir — the same directory on both
 * sides of the mount — and this signals it with the shell's `kill` builtin
 * rather than `pkill`, which the image does not ship (no procps).
 *
 * NEVER throws: a stop that fails is reported by the session refusing to end,
 * not by turning a clean stop into a crash.
 */
export async function stopInContainerPair(opts: {
  binary: string;
  containerName: string;
  worktreePath: string;
}): Promise<void> {
  try {
    const pid = (await readFile(pairPidFilePath(opts.worktreePath), 'utf-8')).trim();
    if (!/^\d+$/.test(pid)) return;
    const result = spawn(
      [opts.binary, 'exec', opts.containerName, 'sh', '-c', `kill -TERM ${pid}`],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: REACH_IN_STOP_TIMEOUT_MS },
    );
    await result.exited;
  } catch {
    // No pidfile (the session never started, or already cleaned up), an
    // unreadable one, or docker refusing the exec. All three mean the same
    // thing here: there is nothing more this best-effort path can do.
  }
}

/**
 * `lazy pair <task> --unlock` half of the reach-in stop.
 *
 * --unlock exists for the case where a pairing session died without cleaning up
 * after itself. Clearing the lock file and the task status is only half of that:
 * the in-container agent it abandoned may still be RUNNING, still holding the
 * session that the next `lazy pair` wants to resume. So --unlock stops it too.
 *
 * The pidfile is the trigger, deliberately. It lives in the sandbox mount (see
 * pairPidFilePath), so its presence is the host's only evidence that an
 * in-container session was ever started and did not unlink it on the way out.
 * No pidfile means there is nothing to reach in for — and specifically means we
 * do NOT call ensureTaskContainer, which would START a stopped container purely
 * to look for a process that cannot be running in it.
 *
 * Best-effort throughout: --unlock's job is to leave the task pairable, and it
 * must finish doing that whether or not docker cooperates.
 *
 * @returns true if a pidfile was found (and a stop was therefore attempted).
 */
export async function stopOrphanedContainerPair(taskId: string, worktreePath: string): Promise<boolean> {
  const pidFile = pairPidFilePath(worktreePath);
  try {
    const pid = (await readFile(pidFile, 'utf-8')).trim();
    if (!/^\d+$/.test(pid)) {
      await rm(pidFile, { force: true });
      return false;
    }
  } catch {
    // ENOENT is the overwhelmingly common case: no in-container session was
    // orphaned. Anything else unreadable means we cannot identify a process to
    // signal, which lands in the same place.
    return false;
  }

  try {
    const ensured = await queryEnsureTaskContainer({ taskId });
    await stopInContainerPair({
      binary: ensured.runnerType === 'podman' ? 'podman' : 'docker',
      containerName: ensured.containerName,
      worktreePath,
    });
  } catch {
    // The daemon is unreachable, or the container is gone. Either way the
    // process we wanted to signal is not reachable from here, and --unlock
    // still has to clear the state below.
  }

  // Remove it even when the kill failed: a stale pidfile that outlives its
  // process makes every future --unlock reach into the container for a pid that
  // is not there.
  await rm(pidFile, { force: true });
  return true;
}

/**
 * The launcher `lazy pair <task>` hands to `runInteractiveSupervisor`.
 *
 * `plan()` runs on every (re)launch: it re-ensures the container (a daemon
 * restart or a manual `docker rm` can have taken it) and re-resolves the auth
 * env, which is what makes an in-place resume across a daemon restart work.
 */
export function createContainerPairLauncher(opts: {
  root: string;
  /** Full task UUID. */
  taskId: string;
  worktreePath: string;
  /** Agent BINARY the session runs — a harness. See `buildPairExecArgs`. */
  harness: string;
  /**
   * The task's agent PROFILE, which decides the upstream and credential the
   * session's model traffic bills. Equal to `harness` for a built-in profile;
   * a custom `[agents.<name>]` makes them differ, and the grant must carry the
   * profile so the proxy routes this session exactly where the task's own
   * turns go.
   */
  profile: string;
  /**
   * The model the session pins — resolved on the host by the caller with
   * `pairSessionModel` (src/task/launch-identity-view.ts), i.e. what the task's
   * next turn would run. Never the builder role's model.
   */
  model: string;
  runnerType: string;
  containerName: string;
  /** Container CLI binary — `docker` or `podman`. */
  binary: string;
  tty: boolean;
  /** True when the agent writes Claude-format session JSONL we can read back. */
  claudeSessions: boolean;
  extraEnv?: Record<string, string>;
}): InteractiveLauncher {
  let containerName = opts.containerName;
  let runnerType = opts.runnerType;
  let binary = opts.binary;
  return {
    surface: 'container',
    async plan({ resumeSessionId, autonomous }): Promise<InteractiveLaunchPlan> {
      // Re-ensure rather than assume: between the first launch and a relaunch
      // the container can have been stopped (daemon restart, `lazy upgrade`,
      // an operator). Cheap when it is already up — the daemon reports
      // alreadyRunning and does nothing.
      const ensured = await queryEnsureTaskContainer({ taskId: opts.taskId });
      // The daemon is the authority on all three: it resolved the runner from
      // the session, named the container, and started it.
      containerName = ensured.containerName;
      runnerType = ensured.runnerType;
      binary = ensured.runnerType === 'podman' ? 'podman' : 'docker';

      const { envVars } = await resolveInteractiveLaunch(opts.root, 'lazy pair', {
        // The session runs in the container, so every address it is handed must
        // be container-reachable — the same conversion a supervised turn gets.
        surface: 'container',
        // Task-scoped JIT identity: the audit log attributes these model calls
        // to this task, not to an anonymous host builder session.
        // The profile is the TASK's agent, not the builder's: pairing runs that
        // agent in that container, so its traffic belongs on that agent's
        // upstream. Only the audit ROLE is builder (a human is driving).
        identity: {
          role: 'builder',
          taskId: opts.taskId,
          label: `pair:${opts.taskId}`,
          profile: profileNameForAgent(opts.profile),
        },
      });

      return {
        argv: buildPairExecArgs({
          binary,
          containerName,
          taskId: opts.taskId,
          worktreePath: opts.worktreePath,
          harness: opts.harness,
          runnerType,
          tty: opts.tty,
          sessionId: resumeSessionId,
          modelId: opts.model,
          autonomous,
          env: { ...launchEnvOverlay(envVars), ...(opts.extraEnv ?? {}) },
        }),
        // The docker CLI itself runs on the host; where it runs is irrelevant to
        // the session, but the worktree is a stable, existing directory.
        cwd: opts.worktreePath,
        env: process.env as Record<string, string>,
        // The agent's HOME inside the container is the sandbox mount, which is
        // this directory on the host — so the session's JSONL is readable here
        // at the same relative path, with no bridging and no copying. The cwd
        // the agent encodes is the worktree, which is mounted at the identical
        // path inside the container (see buildSupervisorDockerArgs), so the two
        // spellings agree by construction.
        sessionHomeDir: opts.claudeSessions ? join(opts.worktreePath, SANDBOX_DIR) : null,
        sessionCwd: opts.worktreePath,
        stop: () => stopInContainerPair({
          binary,
          containerName,
          worktreePath: opts.worktreePath,
        }),
      };
    },
  };
}
