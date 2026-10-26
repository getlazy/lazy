/**
 * Which command-line client drives a runner's containers.
 *
 * For docker and podman it is the runtime's own name. For smolvm it is the
 * runner's script that aims the host's docker CLI at the project's machine
 * (src/runner/smolvm-runner.ts) — so picking "docker" by runner type would
 * silently drive a DIFFERENT engine (Docker Desktop, if one is running) and
 * find none of the task's containers. Every caller that shells out to "the
 * runner's docker" asks here.
 */
import type { Runner } from './types';
import type { RunnerType } from '../config/types';
import { DockerRunner } from './docker-runner';

/** The client a container runner drives. Throws for a runner that has no containers. */
export function containerCliOf(runner: Runner): string {
  if (runner instanceof DockerRunner) return runner.containerCli;
  throw new Error(`The ${runner.type} runner has no containers, so there is no container client to drive.`);
}

/**
 * Which engine a terminal's exec goes to: the runner's own client and, when it
 * owns one, its Engine API socket. On smolvm that is the relay to the
 * project's machine (src/vm/docker-relay.ts) — the host's own Docker socket is
 * a different engine, with none of the task's containers. A runner view that is
 * not a real container runner (a test's) gets the client named by its type.
 */
export function terminalEngineOf(runner: Pick<Runner, 'type'>): { binary: string; engineSocket?: string } {
  if (runner instanceof DockerRunner) {
    const engineSocket = runner.engineSocketPath();
    return engineSocket ? { binary: runner.containerCli, engineSocket } : { binary: runner.containerCli };
  }
  return { binary: runner.type === 'podman' ? 'podman' : 'docker' };
}

/** For a caller holding only a runner TYPE (a session's, a task's). */
export async function containerCliForType(projectRoot: string, type: RunnerType | string): Promise<string> {
  if (type === 'smolvm') {
    const { createRunner } = await import('./index');
    return containerCliOf(await createRunner(projectRoot, 'smolvm'));
  }
  return type === 'podman' ? 'podman' : 'docker';
}
