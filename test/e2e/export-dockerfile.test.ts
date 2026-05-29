/**
 * E2E tests for `lazy system export-dockerfile`.
 *
 * The command writes the embedded default Dockerfile to disk so users can
 * customize it. These tests run the real CLI (no agent involved).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile, access } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { DEFAULT_DOCKERFILE } from '../../src/capture/claude';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('lazy system export-dockerfile', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('exports the default Dockerfile to Dockerfile.lazy', async () => {
    const result = await ctx.lazy(['system', 'export-dockerfile']);

    expectSuccess(result);
    expectOutput(result, 'Dockerfile.lazy');
    expectOutput(result, '[docker]');

    const target = join(ctx.root, 'Dockerfile.lazy');
    if (!(await fileExists(target))) {
      throw new Error('expected Dockerfile.lazy to be written');
    }
  });

  // INVARIANT: the exported file is the embedded DEFAULT_DOCKERFILE, byte-for-byte.
  // This guards the single-source-of-truth rule — the export command must NOT
  // copy/paste or transform the Dockerfile; it writes the exact embedded text
  // that lazy uses to build agent containers. If these ever diverge, users
  // customizing the exported file would be editing something different from
  // what lazy actually builds.
  test('exported content matches embedded DEFAULT_DOCKERFILE byte-for-byte', async () => {
    const result = await ctx.lazy(['system', 'export-dockerfile']);
    expectSuccess(result);

    const written = await readFile(join(ctx.root, 'Dockerfile.lazy'), 'utf-8');
    expect(written).toBe(DEFAULT_DOCKERFILE);
  });

  test('refuses to overwrite an existing file without --force', async () => {
    const target = join(ctx.root, 'Dockerfile.lazy');
    await writeFile(target, 'ORIGINAL CONTENT', 'utf-8');

    const result = await ctx.lazy(['system', 'export-dockerfile']);

    expectFailure(result);
    expectError(result, 'already exists');

    // Original content must be untouched.
    const after = await readFile(target, 'utf-8');
    expect(after).toBe('ORIGINAL CONTENT');
  });

  test('--force overwrites an existing file', async () => {
    const target = join(ctx.root, 'Dockerfile.lazy');
    await writeFile(target, 'ORIGINAL CONTENT', 'utf-8');

    const result = await ctx.lazy(['system', 'export-dockerfile', '--force']);

    expectSuccess(result);
    const after = await readFile(target, 'utf-8');
    expect(after).toBe(DEFAULT_DOCKERFILE);
  });

  test('--stdout prints the Dockerfile without writing a file', async () => {
    const result = await ctx.lazy(['system', 'export-dockerfile', '--stdout']);

    expectSuccess(result);
    expect(result.stdout).toBe(DEFAULT_DOCKERFILE);

    const target = join(ctx.root, 'Dockerfile.lazy');
    if (await fileExists(target)) {
      throw new Error('--stdout must not write Dockerfile.lazy');
    }
  });

  test('-o writes to a custom path', async () => {
    const result = await ctx.lazy(['system', 'export-dockerfile', '-o', 'custom.Dockerfile']);

    expectSuccess(result);
    expectOutput(result, 'custom.Dockerfile');

    const written = await readFile(join(ctx.root, 'custom.Dockerfile'), 'utf-8');
    expect(written).toBe(DEFAULT_DOCKERFILE);
  });

  test('system --help mentions the export-dockerfile subcommand', async () => {
    const result = await ctx.lazy(['system', '--help']);

    expectSuccess(result);
    expectOutput(result, 'export-dockerfile');
  });

  // INVARIANT: `eject-dockerfile` shipped in v0.16 as the original command name,
  // then was renamed to `export-dockerfile` ("eject" wrongly implied an
  // irreversible escape hatch). The old name MUST keep working as a hidden alias
  // so anyone who scripted against v0.16 isn't broken. It is intentionally NOT
  // advertised in `system --help` or shell completion.
  test('eject-dockerfile still works as a hidden back-compat alias', async () => {
    const result = await ctx.lazy(['system', 'eject-dockerfile', '--stdout']);

    expectSuccess(result);
    expect(result.stdout).toBe(DEFAULT_DOCKERFILE);
  });
});
