/**
 * `lazy doctor` on a project configured for `[runner] type = "smolvm"`: the
 * smolvm rows appear, each failure carries its fix, and nothing tells a
 * smolvm user to start Docker Desktop. A docker project shows no smolvm rows.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { rm } from 'fs/promises';
import { smolvmStateRoot } from '../../src/vm/smolvm-engines';
import { soloMachineName } from '../../src/vm/smolvm-project-machine';

function useSmolvm(root: string, binary: string): void {
  const path = join(root, 'lazy.toml');
  const before = readFileSync(path, 'utf-8');
  const after = before.replace('type = "docker"', 'type = "smolvm"');
  expect(after).not.toBe(before);
  writeFileSync(path, `${after}\n[smolvm]\nbinary = "${binary}"\nimage = "${join(root, 'missing-daemon.tar')}"\n`);
}

describe('lazy doctor on a smolvm project', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => {
    // Creating the runner writes this project's relay shim dir under ~/.lazy/smolvm.
    const stateDir = join(smolvmStateRoot(), soloMachineName(ctx.root));
    await ctx.cleanup();
    await rm(stateDir, { recursive: true, force: true });
  });

  // INVARIANT: on the smolvm runner doctor is the one place that explains a
  // broken smolvm setup, row by row with the fix, and it never reports the
  // host's Docker engine as a failure: a smolvm project does not need one.
  test('a missing smolvm binary: the binary row fails with how to install it, and no Docker Desktop advice', async () => {
    useSmolvm(ctx.root, join(ctx.root, 'no-such-smolvm', 'smolvm'));
    const result = await ctx.lazy(['doctor'], { env: { LAZY_SMOLVM_BINARY: '' } });
    expectOutput(result, 'no-such-smolvm/smolvm cannot be used');
    expectOutput(result, 'lazy system smolvm-install');
    expectOutput(result, 'smolvm machine (skipped — fix the smolvm binary first)');
    expectOutput(result, 'No image tar at');
    expectOutput(result, 'smolvm relay socket dir private');
    expectOutput(result, 'Docker engine in smolvm machine');
    expectOutputExcludes(result, 'Docker Desktop');
    expectOutputExcludes(result, 'Docker daemon running');
    expect(result.exitCode).not.toBe(0);
  });

  test('a docker project shows no smolvm rows', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutputExcludes(result, 'smolvm');
  });
});
