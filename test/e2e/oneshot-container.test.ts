/**
 * E2E: machine one-shots run in throwaway containers, not on the host.
 *
 * Covers the housekeeping paths beyond accept's fidelity summary — here,
 * `lazy memory compact`'s LLM path. Task turns are not the subject; a scriptable
 * `docker` on the daemon's PATH stands in for the runtime so the argv lazy
 * composes is asserted for real.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { IMAGE_TAG } from '../../src/capture/claude';

describe('machine one-shot container path', () => {
  let ctx: TestContext;
  let docker: FakeDocker;

  beforeEach(async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-oneshot-e2e-'));
    docker = await installFakeDocker(scratch);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`);
    // Short enough to beat the plain index once several records exist; every name
    // must appear so the LLM candidate is not repaired into something larger.
    await docker.setOneshotResponse('Themes: `alpha`, `beta`, `gamma`.');

    ctx = await setupTestLazy({
      // Real one-shot path in the daemon — the default preload mocks
      // src/oneshot/index.ts wholesale, which would hide the container argv.
      fakeClaude: true,
      daemonEnv: {
        PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy memory compact LLM path runs docker run with the one-shot label', async () => {
    for (const name of ['alpha', 'beta', 'gamma'] as const) {
      await ctx.lazy([
        'memory', 'save', name,
        '-t', 'project',
        '-d', `Long description for ${name} that repeats context several times over.`,
        '-b', 'Body paragraph. '.repeat(40),
      ]);
    }

    await ctx.lazy(['memory', 'compact', '--llm']);

    const runs = (await docker.invocations()).filter(l => l.startsWith('run '));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some(l => l.includes('lazy.oneshot=1'))).toBe(true);
    expect(runs.some(l => l.includes(`${ctx.root}:${ctx.root}`))).toBe(false);
  }, 120_000);
});
