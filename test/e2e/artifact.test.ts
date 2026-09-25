/**
 * e2e coverage for `lazy artifact` — attach files to a task, list them, read
 * them back out, and detach them.
 *
 * Daemonless: none of these subcommands launches an agent.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { MAX_ARTIFACT_BYTES } from '../../src/artifacts/limits';

describe('lazy artifact', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    taskId = await createTask(ctx, 'Task with artifacts');
    await mkdir(join(ctx.root, 'design'), { recursive: true });
    await writeFile(join(ctx.root, 'design', 'index.html'), '<h1>hello</h1>\n');
    await writeFile(join(ctx.root, 'design', 'tokens.json'), '{"color":"red"}\n');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('add attaches files and keeps their relative paths as names', async () => {
    const result = await ctx.lazy(['artifact', 'add', taskId, 'design/index.html', 'design/tokens.json']);
    expectSuccess(result);
    expectOutput(result, 'Attached');
    expectOutput(result, 'design/index.html');
    // The pointer the human needs: where the agent will find them, and that
    // attaching did not start a turn.
    expectOutput(result, '.lazy-task-sandbox/artifacts/');

    const list = await ctx.lazy(['artifact', 'list', taskId]);
    expectSuccess(list);
    expectOutput(list, 'design/index.html');
    expectOutput(list, 'design/tokens.json');
    expectOutput(list, 'input');
  });

  test('list says so, and how to fix it, when there is nothing attached', async () => {
    const result = await ctx.lazy(['artifact', 'list', taskId]);
    expectSuccess(result);
    expectOutput(result, 'No artifacts');
    expectOutput(result, 'lazy artifact add');
  });

  // No implicit default subcommand: guessing that a bare argument means "list"
  // collides with a task whose code is `get` or `rm`.
  test('a bare task reference is an error, not a guessed list', async () => {
    const result = await ctx.lazy(['artifact', taskId]);
    expectFailure(result);
    expectError(result, 'Unknown artifact subcommand');
  });

  test('get prints a text artifact to stdout', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html']));

    const result = await ctx.lazy(['artifact', 'get', taskId, 'design/index.html']);
    expectSuccess(result);
    expect(result.stdout).toBe('<h1>hello</h1>\n');
  });

  test('get -o writes the artifact to a path, creating parent directories', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html']));

    const dest = join(ctx.root, 'out', 'nested', 'copy.html');
    const result = await ctx.lazy(['artifact', 'get', taskId, 'design/index.html', '-o', dest]);
    expectSuccess(result);
    expectOutput(result, 'Wrote');
    expect(await readFile(dest, 'utf-8')).toBe('<h1>hello</h1>\n');
  });

  test('--name stores under a different name', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html', '--name', 'mocks/home.html']));
    const list = await ctx.lazy(['artifact', 'list', taskId]);
    expectOutput(list, 'mocks/home.html');
  });

  // INVARIANT: one name, one artifact. Re-attaching a name REPLACES it — there
  // is deliberately no versioning, so a task cannot accumulate history it never
  // asked for.
  test('re-attaching a name replaces it rather than adding a second', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html']));
    await writeFile(join(ctx.root, 'design', 'index.html'), '<h1>second</h1>\n');

    const again = await ctx.lazy(['artifact', 'add', taskId, 'design/index.html']);
    expectSuccess(again);
    expectOutput(again, 'Replaced');

    const list = await ctx.lazy(['artifact', 'list', taskId]);
    expectOutput(list, '1 artifact(s)');
    const got = await ctx.lazy(['artifact', 'get', taskId, 'design/index.html']);
    expect(got.stdout).toBe('<h1>second</h1>\n');
  });

  test('rm detaches an artifact and fails on an unknown name', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html']));

    const removed = await ctx.lazy(['artifact', 'rm', taskId, 'design/index.html']);
    expectSuccess(removed);
    expectOutput(removed, 'Removed');

    const missing = await ctx.lazy(['artifact', 'rm', taskId, 'design/index.html']);
    expectFailure(missing);
    expectError(missing, "No artifact named 'design/index.html'");
  });

  test('get fails helpfully on an unknown name', async () => {
    const result = await ctx.lazy(['artifact', 'get', taskId, 'nope.txt']);
    expectFailure(result);
    expectError(result, 'lazy artifact list');
  });

  test('add refuses a missing file and a directory', async () => {
    const missing = await ctx.lazy(['artifact', 'add', taskId, 'no-such-file.txt']);
    expectFailure(missing);
    expectError(missing, 'No such file');

    const dir = await ctx.lazy(['artifact', 'add', taskId, 'design']);
    expectFailure(dir);
    expectError(dir, 'is a directory');
  });

  // The bound exists so a task's history cannot grow without limit — the lesson
  // the 677 MiB proxy audit log taught. Refusal must be explicit, not a truncate.
  test('add refuses a file over the per-artifact limit', async () => {
    const big = join(ctx.root, 'big.bin');
    await writeFile(big, Buffer.alloc(MAX_ARTIFACT_BYTES + 1024, 0x61));

    const result = await ctx.lazy(['artifact', 'add', taskId, 'big.bin']);
    expectFailure(result);
    expectError(result, 'per-artifact limit');

    // …and nothing was half-attached.
    const list = await ctx.lazy(['artifact', 'list', taskId]);
    expectOutput(list, 'No artifacts');
  });

  // PRE-FLIGHT: every file is read and checked before any of them is written,
  // so a bad path late in the list leaves nothing behind.
  test('a bad file later in the list attaches nothing at all', async () => {
    const result = await ctx.lazy(['artifact', 'add', taskId, 'design/index.html', 'no-such-file.txt']);
    expectFailure(result);

    const list = await ctx.lazy(['artifact', 'list', taskId]);
    expectOutput(list, 'No artifacts');
  });

  test('add rejects a name that would escape the artifact directory', async () => {
    const result = await ctx.lazy(['artifact', 'add', taskId, 'design/index.html', '--name', '../escape.html']);
    expectFailure(result);
  });

  test('--name with several files is refused rather than guessed at', async () => {
    const result = await ctx.lazy([
      'artifact', 'add', taskId, 'design/index.html', 'design/tokens.json', '--name', 'one.html',
    ]);
    expectFailure(result);
    expectError(result, '--name applies to a single file');
  });

  test('--origin output marks a published artifact', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html', '--origin', 'output']));
    expectOutput(await ctx.lazy(['artifact', 'list', taskId]), 'output');

    const bad = await ctx.lazy(['artifact', 'add', taskId, 'design/index.html', '--origin', 'sideways']);
    expectFailure(bad);
    expectError(bad, "Invalid --origin");
  });

  test('binary artifacts round-trip byte-for-byte and refuse to print to stdout', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
    await writeFile(join(ctx.root, 'shot.png'), png);
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'shot.png']));

    const printed = await ctx.lazy(['artifact', 'get', taskId, 'shot.png']);
    expectFailure(printed);
    expectError(printed, 'is binary');

    const dest = join(ctx.root, 'copy.png');
    expectSuccess(await ctx.lazy(['artifact', 'get', taskId, 'shot.png', '-o', dest]));
    expect(Buffer.compare(await readFile(dest), png)).toBe(0);
  });

  test('lazy show lists a task\'s artifacts as metadata', async () => {
    expectSuccess(await ctx.lazy(['artifact', 'add', taskId, 'design/index.html']));

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Artifacts (1)');
    expectOutput(result, 'design/index.html');
    // Metadata only — the file's body never appears in `lazy show`.
    expect(result.stdout).not.toContain('<h1>hello</h1>');
  });

  test('add requires a task and at least one file', async () => {
    const noFile = await ctx.lazy(['artifact', 'add', taskId]);
    expectFailure(noFile);
    expectError(noFile, 'Usage: lazy artifact add');
  });

  test('artifact --help prints the artifact usage, not the parent help', async () => {
    const result = await ctx.lazy(['artifact', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy artifact <subcommand>');
  });
});
