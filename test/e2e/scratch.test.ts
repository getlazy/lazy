/**
 * End-to-end contract for `lazy scratch` — the engineer's surface onto builder
 * scratch artifacts captured into the project store.
 *
 * The unit suite (test/unit/scratch-sync.test.ts) pins the capture engine's
 * invariants. This suite pins what only a real CLI run can show: that a file a
 * builder leaves in $LAZY_SCRATCH_DIR is reachable through lazy afterwards, that
 * a file lazy declined to persist SAYS so at both list and show (rather than
 * looking like an empty artifact), and that `lazy search 'in:scratch …'` reaches
 * captured content.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { builderScratchDir } from '../../src/builder/scratch';
import { MAX_SCRATCH_FILE_BYTES } from '../../src/builder/scratch-limits';

/**
 * The scratch dir as the CLI subprocesses see it. `setupTestLazy` redirects
 * LAZY_SCRATCH_BASE_DIR per context, so this must be resolved with the same env
 * the subprocess got — not with this test process's own environment.
 */
function scratchDirFor(ctx: TestContext): string {
  const previous = process.env.LAZY_SCRATCH_BASE_DIR;
  process.env.LAZY_SCRATCH_BASE_DIR = ctx.scratchBaseDir;
  try {
    return builderScratchDir(ctx.root);
  } finally {
    if (previous === undefined) delete process.env.LAZY_SCRATCH_BASE_DIR;
    else process.env.LAZY_SCRATCH_BASE_DIR = previous;
  }
}

describe('lazy scratch', () => {
  let ctx: TestContext;
  let scratchDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    scratchDir = scratchDirFor(ctx);
    await mkdir(scratchDir, { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('sync captures a builder artifact, list and show read it back', async () => {
    await writeFile(join(scratchDir, 'accept-foo.md'), '# Review\n\nThe merge looks right.\n');
    await mkdir(join(scratchDir, 'notes'), { recursive: true });
    await writeFile(join(scratchDir, 'notes', 'analysis.txt'), 'forty two\n');

    const sync = await ctx.lazy(['scratch', 'sync']);
    expectSuccess(sync);
    expectOutput(sync, 'Stored 2 file(s)');

    const list = await ctx.lazy(['scratch', 'list']);
    expectSuccess(list);
    expectOutput(list, 'accept-foo.md');
    expectOutput(list, 'notes/analysis.txt');
    expectOutput(list, 'stored');

    const show = await ctx.lazy(['scratch', 'show', 'accept-foo.md']);
    expectSuccess(show);
    expectOutput(show, 'The merge looks right.');

    // A second pass is a no-op — capture is idempotent, so the engineer's
    // `updated_at` column stays meaningful.
    const again = await ctx.lazy(['scratch', 'sync']);
    expectSuccess(again);
    expectOutput(again, '2 unchanged');
  });

  test('an empty store says so instead of printing an empty table', async () => {
    const list = await ctx.lazy(['scratch', 'list']);
    expectSuccess(list);
    expectOutput(list, 'No captured builder scratch files yet');
  });

  test('an over-cap file is listed by name with its reason, and show explains itself', async () => {
    await writeFile(join(scratchDir, 'heap.log'), 'x'.repeat(MAX_SCRATCH_FILE_BYTES + 1));

    const sync = await ctx.lazy(['scratch', 'sync']);
    expectSuccess(sync);
    // The skip is LOUD: an unpersisted artifact must never look persisted.
    expect(`${sync.stdout}${sync.stderr}`).toContain('heap.log');
    expect(`${sync.stdout}${sync.stderr}`).toMatch(/per-file cap/i);

    const list = await ctx.lazy(['scratch', 'list']);
    expectOutput(list, 'too_large (content on disk only)');

    // `show` on a metadata-only record fails with an explanation rather than
    // printing an empty file, which would read as "the artifact is empty".
    const show = await ctx.lazy(['scratch', 'show', 'heap.log']);
    expectFailure(show);
    expectError(show, 'captured by name only');
  });

  test('a binary file is recorded by name only', async () => {
    await writeFile(join(scratchDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0xff, 0xfe]));

    const sync = await ctx.lazy(['scratch', 'sync']);
    expectSuccess(sync);
    expect(`${sync.stdout}${sync.stderr}`).toMatch(/not UTF-8/);

    const list = await ctx.lazy(['scratch', 'list']);
    expectOutput(list, 'binary (content on disk only)');
  });

  test('capture never deletes: a file removed from disk keeps its record', async () => {
    await writeFile(join(scratchDir, 'handoff.md'), 'read me later\n');
    expectSuccess(await ctx.lazy(['scratch', 'sync']));

    await ctx.lazy(['scratch', 'list']); // sanity: it is there
    const { rm } = await import('fs/promises');
    await rm(join(scratchDir, 'handoff.md'));
    expectSuccess(await ctx.lazy(['scratch', 'sync']));

    const show = await ctx.lazy(['scratch', 'show', 'handoff.md']);
    expectSuccess(show);
    expectOutput(show, 'read me later');
  });

  test('rm removes the record explicitly and says the disk file is untouched', async () => {
    await writeFile(join(scratchDir, 'draft.md'), 'a draft\n');
    expectSuccess(await ctx.lazy(['scratch', 'sync']));

    const removed = await ctx.lazy(['scratch', 'rm', 'draft.md', '--yes']);
    expectSuccess(removed);
    expectOutput(removed, "Removed 'draft.md' from the store");

    const list = await ctx.lazy(['scratch', 'list']);
    expectOutputExcludes(list, 'draft.md');

    // The live file was untouched, so the next capture puts it back — the CLI
    // says as much, and it is true.
    expectSuccess(await ctx.lazy(['scratch', 'sync']));
    expectSuccess(await ctx.lazy(['scratch', 'show', 'draft.md']));
  });

  test('rm and show on an unknown path fail with an actionable message', async () => {
    const show = await ctx.lazy(['scratch', 'show', 'nope.md']);
    expectFailure(show);
    expectError(show, 'lazy scratch list');

    const removed = await ctx.lazy(['scratch', 'rm', 'nope.md', '--yes']);
    expectFailure(removed);
    expectError(removed, 'No captured scratch file');
  });

  test('path prints the live directory on stdout', async () => {
    const result = await ctx.lazy(['scratch', 'path']);
    expectSuccess(result);
    expect(result.stdout.trim()).toBe(scratchDir);
  });

  test('an unknown subcommand fails with usage', async () => {
    const result = await ctx.lazy(['scratch', 'frobnicate']);
    expectFailure(result);
    expectError(result, 'Unknown scratch subcommand');
  });

  test("lazy search 'in:scratch <text>' finds captured content", async () => {
    await writeFile(join(scratchDir, 'perf-notes.md'), 'the zamboni allocation is the hot path\n');
    expectSuccess(await ctx.lazy(['scratch', 'sync']));

    const found = await ctx.lazy(['search', 'in:scratch zamboni']);
    expectSuccess(found);
    expectOutput(found, 'perf-notes.md');

    // The --scratch flag narrows to the same entity type.
    const flagged = await ctx.lazy(['search', '--scratch', 'zamboni']);
    expectSuccess(flagged);
    expectOutput(flagged, 'perf-notes.md');
  });

  test('a file recorded by name only is still findable by its path', async () => {
    // Knowing the artifact exists — and that lazy declined to persist its body
    // — is the useful answer, so path is indexed alongside content.
    await writeFile(join(scratchDir, 'zamboni-dump.log'), 'x'.repeat(MAX_SCRATCH_FILE_BYTES + 1));
    expectSuccess(await ctx.lazy(['scratch', 'sync']));

    const found = await ctx.lazy(['search', 'in:scratch zamboni']);
    expectSuccess(found);
    expectOutput(found, 'zamboni-dump.log');
  });
});
