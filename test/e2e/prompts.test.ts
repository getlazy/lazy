import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy system prompts', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lists built-in system prompts with lazy-prompt- prefix', async () => {
    const result = await ctx.lazy(['system', 'prompts']);

    expectSuccess(result);
    expectOutput(result, 'Built-in System Prompts');
    expectOutput(result, 'lazy-prompt-system-instructions');
    expectOutput(result, 'lazy-prompt-goal-context-start');
  });

  test('lists all expected prompt codes', async () => {
    const result = await ctx.lazy(['system', 'prompts']);

    expectSuccess(result);
    // Verify each prompt file has a corresponding entry with lazy-prompt- prefix
    expectOutput(result, 'lazy-prompt-goal-context-continue');
    expectOutput(result, 'lazy-prompt-goal-context-resume');
    expectOutput(result, 'lazy-prompt-goal-context-start');
    expectOutput(result, 'lazy-prompt-builder-system-prompt');
    expectOutput(result, 'lazy-prompt-tool-instructions');
    expectOutput(result, 'lazy-prompt-merge-conflict-resolution');
    expectOutput(result, 'lazy-prompt-model-guidance');
    expectOutput(result, 'lazy-prompt-remote-branch-merge');
    expectOutput(result, 'lazy-prompt-resume-context');
    expectOutput(result, 'lazy-prompt-system-instructions-resume');
    expectOutput(result, 'lazy-prompt-system-instructions');
  });

  test('system --help shows usage with prompts', async () => {
    const result = await ctx.lazy(['system', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Usage: lazy system');
    expectOutput(result, 'prompts');
  });

  test('system without subcommand shows usage and fails', async () => {
    const result = await ctx.lazy(['system']);

    expectFailure(result);
  });

  test('system with unknown subcommand fails', async () => {
    const result = await ctx.lazy(['system', 'unknown']);

    expectFailure(result);
    expectError(result, 'Unknown subcommand');
  });
});

describe('lazy show <builtin-prompt>', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows a built-in prompt by code', async () => {
    const result = await ctx.lazy(['show', 'lazy-prompt-system-instructions']);

    expectSuccess(result);
    expectOutput(result, 'Prompt');
    expectOutput(result, 'lazy-prompt-system-instructions');
    expectOutput(result, 'system-instructions.md');
    // Should contain actual prompt content
    expectOutput(result, 'commit');
  });

  test('shows another built-in prompt', async () => {
    const result = await ctx.lazy(['show', 'lazy-prompt-goal-context-start']);

    expectSuccess(result);
    expectOutput(result, 'Prompt');
    expectOutput(result, 'lazy-prompt-goal-context-start');
    expectOutput(result, 'goal-context-start.md');
  });

  // The code is just BUILTIN_PROMPT_PREFIX + the filename stem, so a
  // multi-word filename must round-trip verbatim — no stripping, no
  // re-hyphenation. (This test used to target `lazy-prompt-system-prompt`;
  // that file was renamed to builder-system-prompt.md in #138 and the code
  // moved with it. Prompt codes are derived from filenames and have no
  // rename aliases.)
  test('shows a prompt whose filename has several hyphenated words', async () => {
    const result = await ctx.lazy(['show', 'lazy-prompt-builder-system-prompt']);

    expectSuccess(result);
    expectOutput(result, 'Prompt');
    expectOutput(result, 'lazy-prompt-builder-system-prompt');
    expectOutput(result, 'builder-system-prompt.md');
  });

  test('fails for non-existent builtin prompt', async () => {
    const result = await ctx.lazy(['show', 'lazy-prompt-nonexistent-prompt']);

    expectFailure(result);
    expectError(result, 'No built-in system prompt found');
    expectError(result, 'lazy-prompt-nonexistent-prompt');
    // Should suggest the command to see available prompts
    expectError(result, 'lazy system prompts');
  });
});

describe('lazy- prefix reservation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('create rejects lazy- prefix codes', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test task', '--code', 'lazy-my-task']);

    expectFailure(result);
    expectError(result, 'lazy-');
    expectError(result, 'reserved');
  });

  test('create allows non-lazy- prefix codes', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test task', '--code', 'my-task']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'my-task');
  });
});
