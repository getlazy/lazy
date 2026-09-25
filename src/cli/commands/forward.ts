import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { displayId, taskRef } from '../../task/identity';
import { SERVE_BIND_HOST } from '../../serve/ports';
import {
  parseForwardSpecs,
  startForward,
  type ActiveForward,
  type ForwardChannel,
  type ForwardSpec,
} from '../../serve/forward';
import type { Runner } from '../../runner/types';
import type { Task } from '../../types';

/** What the tunnel inside the container is: STDIO ↔ a loopback TCP connection. */
function socatArgv(containerPort: number): string[] {
  return ['socat', 'STDIO', `TCP:127.0.0.1:${containerPort}`];
}

/**
 * `lazy forward <task> <host>:<container> …` — reach a port inside a running
 * task's environment, for as long as this command runs.
 *
 * The on-demand complement to `[serve]`/`lazy url`, which publish declared ports
 * permanently when a container is created. Permanent publishing is the wrong
 * shape for an ad-hoc look at one task's database or one-off debug server, and
 * it cannot be added to a container that is already up. This forwards host-side
 * instead: a loopback listener per pair, an exec into the container per
 * connection, and nothing left behind when you stop it.
 */
export async function commandForward(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'forward');

  const taskId = parsed.positional[0];
  const pairs = parsed.positional.slice(1);
  if (!taskId || pairs.length === 0) {
    forwardUsage();
    process.exit(1);
  }

  let specs: ForwardSpec[];
  try {
    specs = parseForwardSpecs(pairs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  const started: ActiveForward[] = [];
  try {
    const task = await resolveTaskOrExit(storage, taskId);
    const session = await storage.getSessionByTaskId(task.id);

    const { createRunner } = await import('../../runner');
    const runner = await createRunner(root, session?.runner_type ?? task.runner_type ?? undefined);
    const containerName = session?.container_name ?? runner.runNameForTask(taskRef(task));

    if (!(await runner.isRunning(containerName))) {
      console.error(
        `Task ${displayId(task)} has no running container, so there is nothing to forward into.\n` +
        `Bring it up with \`lazy shell ${displayId(task)}\` (which starts it and drops ` +
        `you inside), start whatever should be listening, then run this again in another terminal.`,
      );
      process.exit(1);
    }

    await requireSocat(runner, containerName, task);

    // Every listener is bound before anything is announced: a half-open set of
    // forwards, with the failure reported after two "forwarding ..." lines, is
    // worse to read than one error.
    for (const spec of specs) {
      started.push(
        startForward(spec, containerPort => openTunnel(runner, containerName, containerPort), {
          onTunnelError(_spec, message) {
            console.error(`  ! ${message}`);
          },
        }),
      );
    }

    for (const forward of started) {
      console.log(
        `Forwarding ${SERVE_BIND_HOST}:${forward.hostPort} -> ${containerName}:${forward.spec.containerPort}`,
      );
    }
    console.log(`\nForwarding while this command runs. Press Ctrl-C to stop.`);

    await untilInterrupted(started);
  } finally {
    for (const forward of started) forward.stop();
    await storage.close();
  }

  // Explicit: a forward that has been torn down should not leave the process
  // lingering on some stream we did not think to close.
  process.exit(0);
}

/** One host connection's byte pipe into the container. */
function openTunnel(runner: Runner, containerName: string, containerPort: number): ForwardChannel {
  const stream = runner.openRunStream(containerName, socatArgv(containerPort));
  if (!stream) {
    // Unreachable in practice — the runner was checked before any listener was
    // bound — but a channel factory has nowhere to return "no".
    throw new Error(`The ${runner.type} runner has no container to forward into.`);
  }
  return stream;
}

/**
 * Refuse early when the container's image has no `socat`.
 *
 * lazy's own image ships it, so this only bites an image built before that or a
 * project's own Dockerfile. Finding out per-connection, as a stream that closes
 * instantly, would be a mystery; finding out up front is one line and a fix.
 */
async function requireSocat(runner: Runner, containerName: string, task: Task): Promise<void> {
  const code = await runner.execInRun(
    containerName,
    ['sh', '-c', 'command -v socat >/dev/null 2>&1'],
    { timeoutMs: 15_000 },
  );
  if (code === 0) return;
  if (code === null) {
    console.error(
      `Task ${displayId(task)} runs on the ${runner.type} runner, which has no container to ` +
      `forward into.`,
    );
    process.exit(1);
  }
  console.error(
    `The container for task ${displayId(task)} has no \`socat\`, which is how a forwarded ` +
    `connection reaches a port inside it.\n` +
    `Lazy's own image ships socat, so this container was most likely built from an older ` +
    `image or a project Dockerfile that does not install it.\n` +
    `Rebuild the image (\`lazy upgrade --images\`) and restart the task, or add socat to the ` +
    `project's Dockerfile.`,
  );
  process.exit(1);
}

/**
 * Block until the human stops us, then tear every forward down.
 *
 * Explicit signal handling rather than letting the default kill us: the tunnels
 * are child processes of THIS process, and a default SIGINT exit leaves them to
 * be reaped by whoever gets to them first. Nothing lazy starts should outlive
 * the command that started it.
 */
function untilInterrupted(forwards: ActiveForward[]): Promise<void> {
  return new Promise<void>(resolve => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      console.log(`\nStopping ${forwards.length === 1 ? 'forward' : 'forwards'}.`);
      for (const forward of forwards) forward.stop();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export function forwardUsage(): void {
  console.log(`Usage: lazy forward <task_id> <port> [<port> ...]

Reach a port inside a running task's container from this machine, for as long as
this command runs. Ctrl-C stops it and leaves nothing behind.

Arguments:
  <task_id>    ID of the task (prefix matching works)
  <port>       <host-port>:<container-port>, e.g. 8080:3000 — listen on host
               port 8080 and forward into the container's port 3000.
               Or just <container-port>, e.g. 3000, to have a free host port
               assigned. The resolved address is printed either way.

Listeners are bound on ${SERVE_BIND_HOST} only — a forwarded port is never
exposed to the network this machine is on.

This is the ad-hoc counterpart to [serve] and \`lazy url\`, which publish a
project's declared ports permanently when a task's container is created. Use
[serve] for the ports a project always serves on; use \`lazy forward\` for the
one-off look at a database, a debug server, or a port you did not declare.
A running container's published ports cannot be changed, which is why this
forwards host-side instead.

The task's container must already be running with something listening on the
port — this command never starts a container, because a fresh one would have
nothing in it yet. Bring it up with \`lazy shell <task>\` first.

Examples:
  lazy forward my-task 3000              # container 3000 -> an assigned host port
  lazy forward my-task 8080:3000         # container 3000 -> 127.0.0.1:8080
  lazy forward my-task 8080:3000 5433:5432
  lazy forward my-task 5432              # poke at the task's database`);
}
