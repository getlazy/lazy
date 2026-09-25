/**
 * INVARIANT — A DAEMON WHOSE DOCKER HOST IS A FOREIGN FILESYSTEM REFUSES TO
 * LAUNCH A WORKLOAD CONTAINER, RATHER THAN LAUNCHING A BROKEN ONE.
 *
 * Lazy builds every bind as `-v <path>:<path>`. Run the daemon inside a
 * container with somebody else's Docker socket mounted in (the self-host Lazy
 * Teams image) and those paths name nothing on the host — and NATIVE LINUX
 * DOCKER DOES NOT REFUSE THAT. It creates each missing directory and mounts it
 * empty, so the container starts, the agent works against an empty worktree,
 * and the eventual failure names anything but the cause. A turn is burned and a
 * session is written before anyone can tell what happened.
 *
 * THE ARMING IS DECLARED, NOT DETECTED, and it is NOT managed mode. Lazy Teams
 * installed natively on the machine that runs Docker arms managed mode and its
 * daemons are on the Docker host — keying the refusal on managed mode would
 * break the one arrangement that works today. So the deployment that knows says
 * so, and everything else is byte-identical.
 *
 * Full analysis: docs/design/self-host-task-containers.md.
 */

import { describe, test, expect } from 'bun:test';
import {
  FOREIGN_DOCKER_HOST_ENV,
  hasForeignDockerHost,
  siblingContainerRefusal,
  assertSiblingContainerLaunchSupported,
} from '../../src/runner/sibling-containers';
import { MANAGED_ENV } from '../../src/config/managed-mode';

const FOREIGN: NodeJS.ProcessEnv = { [FOREIGN_DOCKER_HOST_ENV]: '1' };

describe('sibling container launch gate', () => {
  // INVARIANT: an ordinary install never sees this gate. Lazy on a developer's
  // machine launches containers on that machine's own Docker.
  test('an undeclared deployment is never refused', () => {
    expect(siblingContainerRefusal({})).toBeNull();
    expect(() => assertSiblingContainerLaunchSupported('use the docker runner', {})).not.toThrow();
  });

  // INVARIANT: managed mode alone must NOT refuse — a native Lazy Teams install
  // arms it and its daemons run on the Docker host. This is the regression that
  // would silently break every working Teams install.
  test('managed mode alone is not a refusal', () => {
    expect(siblingContainerRefusal({ [MANAGED_ENV]: '1' })).toBeNull();
  });

  test('a declared foreign Docker host is refused', () => {
    const refusal = siblingContainerRefusal(FOREIGN);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('cannot launch agent containers');
  });

  test('the flag accepts 1 and true, and nothing else', () => {
    expect(hasForeignDockerHost({ [FOREIGN_DOCKER_HOST_ENV]: '1' })).toBe(true);
    expect(hasForeignDockerHost({ [FOREIGN_DOCKER_HOST_ENV]: 'true' })).toBe(true);
    for (const raw of ['', '0', 'false', 'yes', 'maybe']) {
      expect(hasForeignDockerHost({ [FOREIGN_DOCKER_HOST_ENV]: raw })).toBe(false);
    }
  });

  // The message is the whole value of the gate: whoever hits it has to be able
  // to act without reading lazy's source. Both translations are named, and so
  // is the remedy.
  test('the refusal names both translations and what to do instead', () => {
    const refusal = siblingContainerRefusal(FOREIGN)!;
    expect(refusal).toContain('mounts denied');
    expect(refusal).toContain('host.docker.internal');
    expect(refusal).toContain('Docker host');
  });

  // INVARIANT: the refusal covers EVERY agent container, not just task turns.
  // One-shots back `lazy report`, `lazy ask` over a stored conversation and
  // memory compaction, and they are refused by the same gate — so a reader who
  // arrived through one of those must not be told only about task turns.
  test('the refusal names the non-task capabilities it also stops', () => {
    const refusal = siblingContainerRefusal(FOREIGN)!;
    expect(refusal).toContain('task turns');
    expect(refusal).toContain('lazy report');
    expect(refusal).toContain('lazy ask');
    expect(refusal).toContain('memory');
  });

  // INVARIANT: the scope it claims is the scope it HAS.
  //
  // The gate lives in `checkAvailability`, the container runtime's own "can I
  // run?", so it refuses every command that needs a container — including the
  // ones nobody thinks of as agent work. The message used to end "Everything
  // else works normally", which a CLI user outside Teams reads untranslated and
  // which its own doc comment contradicted: `lazy builder` and `lazy browse`
  // are refused too. A claim about what still works has to be true.
  test('the refusal claims the runtime-wide scope it actually has', () => {
    const refusal = siblingContainerRefusal(FOREIGN)!;

    for (const command of ['lazy builder', 'lazy browse', 'lazy upgrade --images']) {
      expect(refusal).toContain(command);
    }
    expect(refusal).not.toContain('Everything else works normally');
    expect(refusal).toContain('lazy sync');
    expect(refusal).toContain('merge conflict');
    expect(refusal).toContain('clean `lazy sync`');
  });

  // INVARIANT: the remedy must not send a reader somewhere that does not exist.
  // There is no packaged install that runs agent work from inside a container,
  // and the message says so rather than implying one is a click away.
  test('the remedy states that no packaged in-container install exists', () => {
    expect(siblingContainerRefusal(FOREIGN)!).toContain('no packaged install');
  });

  // `what` is a VERB PHRASE completing "Cannot …", so the first sentence names
  // the caller's own action. The earlier spelling took a noun and produced
  // "Cannot start a one-shot container. This … cannot launch task containers",
  // whose two halves disagreed about what had been refused.
  test('the assertion completes "Cannot <verb phrase>"', () => {
    expect(() => assertSiblingContainerLaunchSupported('use the docker runner', FOREIGN))
      .toThrow(/Cannot use the docker runner\./);
    expect(() => assertSiblingContainerLaunchSupported('start a task turn', FOREIGN))
      .toThrow(/Cannot start a task turn\./);
    expect(() => assertSiblingContainerLaunchSupported('run this in an agent container', FOREIGN))
      .toThrow(/Cannot run this in an agent container\./);
  });
});
