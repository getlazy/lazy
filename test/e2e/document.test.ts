import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy document', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a document task with --goal flag', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Document the storage interface']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Document the storage interface');
    expectOutput(result, 'document');
  });

  test('sets task type to document automatically', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Document auth flow']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    document');
  });

  test('includes document constraints in prompt', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Document auth flow']);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    // The prompt should contain the document constraints
    expectOutput(showResult, 'Documentation Task Constraints');
  });

  test('creates docs directory if it does not exist', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Document architecture']);
    expectSuccess(result);

    expectOutput(result, 'Created documents directory: docs/');
    expect(existsSync(join(ctx.root, 'docs'))).toBe(true);
  });

  test('adds [documents] section to lazy.toml when not configured', async () => {
    await ctx.lazy(['document', '--goal', 'Document architecture']);

    const configContent = readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8');
    expect(configContent.includes('[documents]')).toBe(true);
    expect(configContent.includes('path = "docs"')).toBe(true);
  });

  test('creates a task with --goal and --prompt', async () => {
    const result = await ctx.lazy([
      'document', '--goal', 'Document storage',
      '--prompt', 'Focus on the file storage implementation',
    ]);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Document storage');
  });

  test('user prompt is combined with document constraints', async () => {
    const result = await ctx.lazy([
      'document', '--goal', 'Document storage',
      '--prompt', 'Focus on the file storage implementation',
    ]);
    expectSuccess(result);

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    // Both user prompt and constraints should be present
    expectOutput(showResult, 'Focus on the file storage implementation');
    expectOutput(showResult, 'Documentation Task Constraints');
  });

  test('creates a task with --code flag', async () => {
    const result = await ctx.lazy([
      'document', '--goal', 'Document the supervisor', '--code', 'doc-supervisor',
    ]);

    expectSuccess(result);
    expectOutput(result, 'doc-supervisor');
  });

  test('creates a task with --model flag', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Doc auth', '--model', 'opus']);

    expectSuccess(result);
    expectOutput(result, 'opus');
  });

  test('fails with invalid model', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Doc', '--model', 'invalid']);

    expectFailure(result);
    expectError(result, 'Invalid model');
  });

  test('fails with invalid code', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Doc', '--code', 'X']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('fails without TTY when no flags provided', async () => {
    const result = await ctx.lazy(['document']);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

  test('doc alias works the same as document', async () => {
    const result = await ctx.lazy(['doc', '--goal', 'Document via alias']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Document via alias');
    expectOutput(result, 'document');
  });

  test('shows docs path in output', async () => {
    const result = await ctx.lazy(['document', '--goal', 'Document architecture']);

    expectSuccess(result);
    expectOutput(result, 'Docs:   docs/');
  });

  test('document task appears in list', async () => {
    await ctx.lazy(['document', '--goal', 'Document for listing']);
    const listResult = await ctx.lazy(['list']);

    expectSuccess(listResult);
    expectOutput(listResult, 'Document for listing');
  });

  test('accepts piped stdin as prompt', async () => {
    const result = await ctx.lazy(
      ['document', '--goal', 'Document from stdin'],
      { input: 'Extra instructions from stdin' },
    );

    expectSuccess(result);
    expectOutput(result, 'Created task');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Extra instructions from stdin');
    expectOutput(showResult, 'Documentation Task Constraints');
  });

  test('auto-discovers existing doc/ directory', async () => {
    // Create a doc/ directory before running document command
    const { mkdirSync } = await import('fs');
    mkdirSync(join(ctx.root, 'doc'), { recursive: true });

    const result = await ctx.lazy(['document', '--goal', 'Document with existing doc/']);

    expectSuccess(result);
    // Should use existing doc/ not create docs/
    expectOutput(result, 'Docs:   doc/');
  });
});
