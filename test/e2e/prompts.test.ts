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
    expectOutput(result, 'lazy-prompt-merge-instructions');
    expectOutput(result, 'lazy-prompt-goal-context-start');
  });

  test('lists all expected prompt codes', async () => {
    const result = await ctx.lazy(['system', 'prompts']);

    expectSuccess(result);
    // Verify each prompt file has a corresponding entry with lazy-prompt- prefix
    expectOutput(result, 'lazy-prompt-goal-context-continue');
    expectOutput(result, 'lazy-prompt-goal-context-resume');
    expectOutput(result, 'lazy-prompt-goal-context-start');
    expectOutput(result, 'lazy-prompt-system-prompt');
    expectOutput(result, 'lazy-prompt-tool-instructions');
    expectOutput(result, 'lazy-prompt-merge-conflict-resolution');
    expectOutput(result, 'lazy-prompt-merge-instructions');
    expectOutput(result, 'lazy-prompt-model-guidance');
    expectOutput(result, 'lazy-prompt-remote-branch-merge');
    expectOutput(result, 'lazy-prompt-resume-context');
    expectOutput(result, 'lazy-prompt-system-instructions-resume');
    expectOutput(result, 'lazy-prompt-system-instructions');
  });

  test('system --help shows usage with prompts and toolchains', async () => {
    const result = await ctx.lazy(['system', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Usage: lazy system');
    expectOutput(result, 'prompts');
    expectOutput(result, 'toolchains');
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

describe('lazy system toolchains', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lists built-in toolchains', async () => {
    const result = await ctx.lazy(['system', 'toolchains']);

    expectSuccess(result);
    expectOutput(result, 'Built-in Toolchains');
    expectOutput(result, 'lazy-toolchain-base');
    expectOutput(result, 'lazy-toolchain-bun');
    expectOutput(result, 'lazy-toolchain-node');
    expectOutput(result, 'lazy-toolchain-rust');
    expectOutput(result, 'lazy-toolchain-python');
  });

  test('lists all expected toolchain codes', async () => {
    const result = await ctx.lazy(['system', 'toolchains']);

    expectSuccess(result);
    expectOutput(result, 'lazy-toolchain-base');
    expectOutput(result, 'lazy-toolchain-bun');
    expectOutput(result, 'lazy-toolchain-node');
    expectOutput(result, 'lazy-toolchain-deno');
    expectOutput(result, 'lazy-toolchain-rust');
    expectOutput(result, 'lazy-toolchain-go');
    expectOutput(result, 'lazy-toolchain-cpp');
    expectOutput(result, 'lazy-toolchain-ruby-rails');
    expectOutput(result, 'lazy-toolchain-ruby-rails-rust');
    expectOutput(result, 'lazy-toolchain-dotnet');
    expectOutput(result, 'lazy-toolchain-python');
    expectOutput(result, 'lazy-toolchain-python-ml');
    expectOutput(result, 'lazy-toolchain-java');
    expectOutput(result, 'lazy-toolchain-kotlin');
    expectOutput(result, 'lazy-toolchain-swift');
  });

  test('shows descriptions for toolchains', async () => {
    const result = await ctx.lazy(['system', 'toolchains']);

    expectSuccess(result);
    expectOutput(result, 'Minimal dev container');
    expectOutput(result, 'Bun runtime');
    expectOutput(result, 'Rust via rustup');
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
    const result = await ctx.lazy(['show', 'lazy-prompt-merge-instructions']);

    expectSuccess(result);
    expectOutput(result, 'Prompt');
    expectOutput(result, 'lazy-prompt-merge-instructions');
    expectOutput(result, 'merge-instructions.md');
  });

  test('shows a prompt whose filename used to start with lazy-', async () => {
    const result = await ctx.lazy(['show', 'lazy-prompt-system-prompt']);

    expectSuccess(result);
    expectOutput(result, 'Prompt');
    expectOutput(result, 'lazy-prompt-system-prompt');
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

describe('lazy show <builtin-toolchain>', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows a toolchain Dockerfile by code', async () => {
    const result = await ctx.lazy(['show', 'lazy-toolchain-rust']);

    expectSuccess(result);
    expectOutput(result, 'Toolchain');
    expectOutput(result, 'rust');
    expectOutput(result, 'Rust via rustup');
    expectOutput(result, 'Dockerfile');
    expectOutput(result, 'FROM');
  });

  test('shows the base toolchain', async () => {
    const result = await ctx.lazy(['show', 'lazy-toolchain-base']);

    expectSuccess(result);
    expectOutput(result, 'Toolchain');
    expectOutput(result, 'base');
    expectOutput(result, 'Minimal dev container');
  });

  test('fails for non-existent toolchain', async () => {
    const result = await ctx.lazy(['show', 'lazy-toolchain-nonexistent']);

    expectFailure(result);
    expectError(result, 'No built-in toolchain found');
    expectError(result, 'lazy-toolchain-nonexistent');
    expectError(result, 'lazy system toolchains');
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
