/**
 * INVARIANT — THE REFUSAL IS WIRED INTO THE CONTAINER RUNNERS, AND DELETING IT
 * FAILS HERE.
 *
 * `sibling-containers.test.ts` covers the pure decision, and a Ruby test pins
 * the image `ENV` that arms it. Between them sat the thing that actually does
 * the work: removing every `assertSiblingContainerLaunchSupported(...)` call
 * from `DockerRunner` and `PodmanRunner` left the entire suite green and
 * silently restored the launch-into-empty-directories failure the gate exists
 * to prevent. This file is the missing guard.
 *
 * It asserts BEHAVIOUR, not the presence of a call: each method is invoked for
 * real with the flag set and must reject. A source scan would pass on a call
 * that had been moved somewhere it never runs.
 *
 * NO DOCKER IS NEEDED and none may be reached. In every method the gate is the
 * first statement, ahead of the runtime probe and ahead of resolving anything,
 * so a rejection here proves it fired before any of that — and a regression
 * that moved the check below the probe would show up as a different error (or a
 * hang) rather than as a pass.
 *
 * Full analysis: docs/design/self-host-task-containers.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DockerRunner } from '../../src/runner/docker-runner';
import { PodmanRunner } from '../../src/runner/podman-runner';
import {
  FOREIGN_DOCKER_HOST_ENV,
  SIBLING_REFUSAL_STATUS,
} from '../../src/runner/sibling-containers';
import { RpcError } from '../../src/daemon/rpc-error';

let previous: string | undefined;

beforeEach(() => {
  previous = process.env[FOREIGN_DOCKER_HOST_ENV];
  process.env[FOREIGN_DOCKER_HOST_ENV] = '1';
});

afterEach(() => {
  if (previous === undefined) delete process.env[FOREIGN_DOCKER_HOST_ENV];
  else process.env[FOREIGN_DOCKER_HOST_ENV] = previous;
});

/** A sandbox shaped enough for a launch that must never get that far. */
const SANDBOX = {
  worktreePath: '/tmp/lazy-wiring/.lazy/worktrees/task-a',
  sandboxPath: '/tmp/lazy-wiring/.lazy/worktrees/task-a/.lazy-task-sandbox',
} as any;

/** Every runner entry point the gate has to cover, by the name it is known by. */
const GATED = [
  {
    name: 'DockerRunner.checkAvailability',
    run: () => new DockerRunner().checkAvailability(),
  },
  {
    // PodmanRunner overrides checkAvailability WITHOUT calling super — its
    // probe is Docker-themed — so the gate is re-stated there and could be
    // dropped independently. It was, once.
    name: 'PodmanRunner.checkAvailability',
    run: () => new PodmanRunner().checkAvailability(),
  },
  {
    name: 'DockerRunner.launchSupervisor',
    run: () => new DockerRunner().launchSupervisor(SANDBOX, 'lazy-abc12345', '/tmp/lazy-wiring/proto'),
  },
  {
    name: 'DockerRunner.runOneshot',
    run: () => new DockerRunner().runOneshot({ prompt: 'hello', effort: 'low', repoAccess: 'none' } as any),
  },
] as const;

describe('the sibling-container refusal is wired into the container runners', () => {
  for (const { name, run } of GATED) {
    test(`${name} refuses when the Docker host is declared foreign`, async () => {
      await expect(run()).rejects.toThrow(/cannot launch agent containers/);
    });

    // INVARIANT: a deliberate, permanent refusal is NOT a server error. Every
    // entry point must carry the 409 — a path that threw a plain Error would
    // be logged at ERROR and rendered as "Server Error" on the daemon's own
    // web UI, and status-classifying clients would retry a permanent answer.
    test(`${name} refuses with ${SIBLING_REFUSAL_STATUS}, not a bare Error`, async () => {
      const err = await run().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).status).toBe(SIBLING_REFUSAL_STATUS);
    });
  }

  // The gate must be OFF by default, proven through the same real entry point
  // rather than through the pure module: an `undeclared` install has to reach
  // the Docker probe, and the probe's own failure is what it must reach.
  //
  // Asserted as "not the refusal" rather than "resolves", because this machine
  // may or may not have a working Docker — either outcome is fine here, and
  // only the refusal's own words would be a regression.
  test('an undeclared deployment gets past the gate to the runtime probe', async () => {
    delete process.env[FOREIGN_DOCKER_HOST_ENV];
    const err = await new DockerRunner().checkAvailability().then(() => null, (e: unknown) => e);
    if (err !== null) {
      expect((err as Error).message).not.toMatch(/cannot launch agent containers/);
    }
  });
});
