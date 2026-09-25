import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, fullTaskId, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readCommand, protocolDir as getProtocolDir } from '../../src/protocol';
import type { StartCommand } from '../../src/protocol';

/**
 * E2E coverage for LAZY.md: the project's instructions for agents running lazy
 * tasks actually reach the agent's system prompt, and a project that ships none
 * pays nothing.
 */
describe('LAZY.md project instructions', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Write a file into the test repo and commit it, so task worktrees carry it. */
  async function commitFile(relPath: string, content: string): Promise<void> {
    const full = join(ctx.root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
    ctx.git('add', '.');
    ctx.git('commit', '-m', `add ${relPath}`);
  }

  // INVARIANT: LAZY.md is injected by lazy because NO agent harness loads it.
  // Claude Code reads CLAUDE.md, cursor and codex read their own files; the
  // instructions that are true only under lazy have nowhere else to be read
  // from, so if this injection stops the file silently does nothing.
  test('the root LAZY.md reaches the agent system prompt', async () => {
    await commitFile('LAZY.md', 'Run the suite inside the lazy container with `bun test`.');

    const taskId = await createTask(ctx, 'Do some work', 'Do the work');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(start);

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command).not.toBeNull();
    expect(command.system_prompt).toContain('Project instructions for lazy tasks (LAZY.md)');
    expect(command.system_prompt).toContain('Run the suite inside the lazy container');
    expect(command.system_prompt).toContain('### LAZY.md');
  });

  // INVARIANT: nested LAZY.md files are injected UP FRONT, ordered after the
  // ancestor chain. Claude Code defers subdirectory CLAUDE.md until the agent
  // reads a file there; lazy has no hook into an agent's file reads, so a
  // nested file is either loaded at launch or never seen.
  test('a nested LAZY.md is injected too, after the root one', async () => {
    await commitFile('LAZY.md', 'ROOT INSTRUCTIONS');
    await commitFile('services/api/LAZY.md', 'API INSTRUCTIONS');

    const taskId = await createTask(ctx, 'Do some work', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    const prompt = command.system_prompt ?? '';
    expect(prompt).toContain('ROOT INSTRUCTIONS');
    expect(prompt).toContain('API INSTRUCTIONS');
    expect(prompt).toContain('### services/api/LAZY.md');
    expect(prompt.indexOf('ROOT INSTRUCTIONS')).toBeLessThan(prompt.indexOf('API INSTRUCTIONS'));
  });

  // INVARIANT: no LAZY.md means no section at all — a project that ships none
  // pays nothing and is told nothing, like the shared-memory index.
  test('nothing is injected when the project ships no LAZY.md', async () => {
    const taskId = await createTask(ctx, 'Do some work', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).not.toContain('Project instructions for lazy tasks (LAZY.md)');
  });
});
