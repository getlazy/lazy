/**
 * Can this process launch a workload container on the Docker daemon it is
 * pointed at? — one question, one answer, in a module that depends on almost
 * nothing.
 *
 * ## The problem it exists for
 *
 * Lazy's container argv is built as `-v <path>:<path>`: the same absolute path
 * on both sides, so a file means the same thing to the agent, to git and to the
 * daemon. That holds as long as the process building the argv and the Docker
 * daemon executing it see the same filesystem.
 *
 * The self-host Lazy Teams image breaks that assumption. It runs the Rails app,
 * the fleet supervisor and every project daemon inside ONE container, and mounts
 * the host Docker socket into it — so a task container is created by the HOST's
 * daemon, from paths only the app container can see. Two things fail to
 * translate, and neither is recoverable from inside:
 *
 *   1. **The mount sources.** The project clone, the task worktree, the split
 *      `.git` mount, the sandbox agent-config dirs and the `lazy-agent` binary
 *      are all addressed by a path that does not name those files on the host.
 *      On native Linux Docker the launch SUCCEEDS and the daemon creates empty
 *      directories at each path — an agent then runs against an empty worktree
 *      and `/usr/local/bin/lazy-agent` is a directory. On Docker Desktop it is
 *      refused with `mounts denied: The path … is not shared from the host`.
 *   2. **The callback address.** A task container reaches the daemon at
 *      `host.docker.internal:<webPort>`, which `--add-host=…:host-gateway`
 *      resolves to the HOST's bridge gateway. The daemon is bound inside the app
 *      container's network namespace and is not there, so every `lazy_*` call,
 *      the supervisor protocol and the credential proxy fail.
 *
 * The silent-empty-mount outcome is the dangerous one: it burns a turn and the
 * eventual error names anything but the cause. So the launch is REFUSED up
 * front, with a message that says which two things do not translate and what to
 * do instead.
 *
 * ## It is DECLARED, never detected
 *
 * {@link FOREIGN_DOCKER_HOST_ENV} is set by the one deployment that knows —
 * today the self-host compose image, in its own Dockerfile. Unset is the whole
 * rest of the world, unchanged: a developer running lazy on their laptop, a
 * CI box, and Lazy Teams installed natively on the machine that runs Docker.
 * That last one is why this is NOT keyed on managed mode — a native Teams
 * install arms managed mode and its daemons ARE on the Docker host.
 *
 * Detecting it instead (`/.dockerenv`, a cgroup scan) would be guessing at the
 * question "is this container's Docker socket its own?", which no marker on the
 * filesystem answers: a container CAN legitimately run its own nested daemon.
 * CLAUDE.md's "straightforward over magical" applies — the deployment states
 * its arrangement, lazy does not infer it.
 *
 * The full analysis, the mount inventory and the design for making the
 * self-host image launch siblings properly are in
 * docs/design/self-host-task-containers.md.
 */

import { docsSuffix } from '../docs/links';
import { RpcError } from '../daemon/rpc-error';

/**
 * The status this refusal carries to any RPC caller.
 *
 * 409, not 500. It is a deliberate, permanent refusal about the state of the
 * deployment — the same category as "this task already has an active session" —
 * and `RpcError`'s status is load-bearing precisely so that a decision like
 * this does not flatten into a server error. A 500 here was a steady stream of
 * false alarms in the one install this targets: every Start logged at ERROR,
 * the daemon's web UI filed it under "Server Error", and any client that
 * classifies by status read a permanent policy answer as a crash worth
 * retrying.
 */
export const SIBLING_REFUSAL_STATUS = 409;

/**
 * Set to `1` by a deployment where the Docker daemon lazy launches containers
 * on does NOT share this process's filesystem and network — lazy in a container
 * with somebody else's docker socket bind-mounted in.
 */
export const FOREIGN_DOCKER_HOST_ENV = 'LAZY_FOREIGN_DOCKER_HOST';

/** True when the deployment declared the Docker host to be a foreign one. */
export function hasForeignDockerHost(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FOREIGN_DOCKER_HOST_ENV];
  return raw === '1' || raw === 'true';
}

/**
 * Why an agent container launch is refused, or null when it may proceed.
 *
 * It says AGENT containers, not task containers, because a task turn is not the
 * only casualty: `lazy report`, `lazy ask` over a stored conversation and
 * memory compaction all run a one-shot agent in a container built the same way,
 * and all of them stop working here too. A refusal that named only task turns
 * would leave whoever hit it through `lazy report` reading a sentence about
 * something they did not ask for.
 *
 * Separated from the throwing helper so the decision is unit-testable without
 * catching, and so a caller that wants to warn rather than fail can.
 */
export function siblingContainerRefusal(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!hasForeignDockerHost(env)) return null;

  return (
    'This lazy install cannot launch agent containers: it is running somewhere ' +
    'the Docker daemon it would launch them on cannot see.\n' +
    '\n' +
    'Two things do not translate:\n' +
    '  - every bind mount is built as <path>:<path> from this process\'s view, so ' +
    'the project checkout, the task worktree and the agent binary would name ' +
    'files that do not exist on the Docker host (created empty on Linux, refused ' +
    'as "mounts denied" on Docker Desktop);\n' +
    '  - a container reaches the daemon at host.docker.internal, which is ' +
    'the Docker host — not this process.\n' +
    '\n' +
    'Every command that needs a container is affected — task turns, ' +
    '`lazy report`, `lazy ask` over a stored conversation, memory compaction, ' +
    '`lazy builder`, `lazy browse`, `lazy upgrade --images`, and `lazy sync` ' +
    'when a merge conflict needs agent resolution. A clean `lazy sync` does not ' +
    'need a container and still works. Commands that ' +
    'only read or write the store still work.\n' +
    '\n' +
    'There is no packaged install that runs agent work from inside a container ' +
    'like this one. The packaged Lazy Teams install runs agent work in one ' +
    'microVM per project instead: give the server hardware virtualization ' +
    '(/dev/kvm) and leave the fleet backend at its default rather than `local`. ' +
    'Otherwise, install lazy on the machine that runs Docker and drive tasks ' +
    'from its command line.' +
    docsSuffix('self-hosting-task-turns', '\n\n')
  );
}

/**
 * Refuse an agent container launch that cannot work, before any argv is built.
 *
 * `what` is a VERB PHRASE completing "Cannot …" — `start a task turn`,
 * `use the docker runner` — so the first sentence names what the caller was
 * actually doing and the rest explains why none of it can work.
 *
 * `checkAvailability` is the caller that matters — in `DockerRunner` and again
 * in `PodmanRunner`, which overrides it rather than calling `super`. Every
 * task-turn path preflights through it before any worktree, branch, session row
 * or credential placeholder exists, so the task keeps its pre-start status
 * instead of being recorded as `interrupted` and retried forever by
 * auto-resume. `launchSupervisor` and `runOneshot` keep the check as belt to
 * those braces, for a path that reached them some other way.
 *
 * WHAT THAT PLACEMENT ALSO REFUSES, said plainly because it is not only task
 * turns: `checkAvailability` is the container runtime's own "can I run?", so
 * `lazy builder`, `lazy browse`, `lazy upgrade --images` and doctor's runtime
 * probe are refused here too. That is correct — every one of them launches a
 * container, and none of them can work in a deployment whose Docker host is a
 * foreign filesystem — but it is a consequence worth knowing about rather than
 * a carve-out.
 *
 * The ONE genuine exemption is `lazy system build`, which does not call
 * `checkAvailability` at all: an image build emits no bind mounts, and it has
 * to keep working so the self-host image's opt-in runner build can still be
 * armed.
 *
 * ONE ROUGH EDGE, on the belt path only. The six `launchSupervisor` call sites
 * in `src/daemon/` wrap any throw as `RpcError(500, 'Failed to launch
 * supervisor: …')`, which would flatten this 409 back into a 500. It does not
 * bite in practice — `checkAvailability` refuses first on every path that
 * reaches them — and rewording six shared call sites to preserve an inner
 * status is a change for its own task, not this one.
 */
export function assertSiblingContainerLaunchSupported(
  what: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const refusal = siblingContainerRefusal(env);
  if (refusal) throw new RpcError(SIBLING_REFUSAL_STATUS, `Cannot ${what}. ${refusal}`);
}
