import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { rejectTool, closeTool } from '../../src/mcp/tools';

/**
 * INVARIANT: agent-facing prompts state that a subtask's work lands in the
 * parent ONLY by `lazy_accept`. Copying the subtask's diff into the parent
 * branch and then rejecting or closing the subtask is the failure this
 * wording exists to prevent.
 *
 * The incident: parent-task agents create subtasks, wait, read the diff,
 * re-implement or paste the change into their own worktree, then reject or
 * close the subtask. The parent's history then claims work the subtask did;
 * the subtask's turns, commits and report are severed from the code that
 * shipped; every review link points at the wrong place. Lazy tracks which
 * task did what — a cannibalised subtask makes that record a lie.
 *
 * These are prompt-content assertions on purpose: the behavior lives in
 * wording (prompt-only fix, no daemon or CLI change), and wording is what
 * silently rots.
 *
 * The rule is stated once in `tool-instructions.md` (the RUNNING SUBTASKS
 * section every launch composes into the system prompt) and echoed in the
 * reject/close tool descriptions (the moment of the failure) plus a
 * one-sentence pointer on the MCP server instructions.
 */

const promptsDir = join(import.meta.dir, '..', '..', 'src', 'prompts');

const readPrompt = (name: string) => readFile(join(promptsDir, name), 'utf-8');

/**
 * These prompts are hard-wrapped, so any phrase long enough to be worth
 * pinning can land across a line break — and re-wraps this whole class of
 * assertion to nothing without touching a word of the rule. Collapse runs of
 * whitespace before matching phrases; only the words are the invariant.
 */
const phrases = (text: string) => text.replace(/\s+/g, ' ');

function extractSubtaskSection(text: string, file: string): string {
  const heading = 'RUNNING SUBTASKS YOURSELF';
  const start = text.indexOf(heading);
  expect(start, `${file} must contain "${heading}"`).toBeGreaterThanOrEqual(0);
  // Section runs to the file's closing `---` or EOF.
  const end = text.indexOf('\n---', start);
  return phrases(end === -1 ? text.slice(start) : text.slice(start, end));
}

describe('agent subtask land-by-accept prompts', () => {
  test('tool instructions state the rule in the subtask-orchestration section', async () => {
    const section = extractSubtaskSection(
      await readPrompt('tool-instructions.md'),
      'tool-instructions.md',
    );

    // The only landing path, named as the tool they must call.
    expect(section).toContain("lands in your branch ONLY by `lazy_accept`");

    // The verbs of the failure, quoted so none of them reads as a legitimate
    // "I'll just bring this in myself" shortcut.
    expect(section).toContain('Never copy, cherry-pick, re-type, or "incorporate"');
    expect(section).toContain("a subtask's diff into your own branch");

    // The two legitimate alternatives to accept, each with its constraint.
    expect(section).toContain('ITS agent');
    expect(section).toContain('do not use its code');

    // The failure named in the same sentence as the reason, so dropping either
    // half cannot leave an agent with "don't reject" and no why.
    expect(section).toContain('Rejecting or closing a subtask whose code you kept');
    expect(section).toContain('which task did the work');
    expect(section).toContain('breaks review, provenance, and accept');
  });

  test('MCP server instructions echo the rule next to the orchestration line', async () => {
    const mcp = phrases(await readPrompt('mcp-server-instructions.md'));
    expect(mcp).toContain('`lazy_accept` to land it');
    expect(mcp).toContain("A subtask's work lands ONLY by `lazy_accept`");
    expect(mcp).toContain('never copy its diff into your branch');
    expect(mcp).toContain('reject or close it');
  });

  test('no agent-facing prompt tells an agent to copy or apply a subtask diff', async () => {
    // Grep-first coverage: the failure used to look like a reasonable review
    // step ("I'll incorporate the subtask's changes"). If that wording comes
    // back anywhere an agent reads, this fails.
    for (const file of [
      'tool-instructions.md',
      'mcp-server-instructions.md',
      'system-instructions.md',
      'system-instructions-resume.md',
    ]) {
      const text = phrases(await readPrompt(file)).toLowerCase();
      expect(text, `${file} must not tell an agent to incorporate a subtask's changes`).not.toContain(
        "incorporate the subtask",
      );
      expect(text, `${file} must not tell an agent to apply the subtask diff`).not.toContain(
        'apply the diff',
      );
    }
  });
});

/**
 * The MCP tool description is the other place an agent reads before deciding
 * to reject or close. The echo has to name both the forbidden act (kept the
 * code, then discarded the subtask) and the correct landing path.
 */
describe('lazy_reject and lazy_close descriptions', () => {
  test('reject forbids discarding a subtask whose code you kept', () => {
    expect(rejectTool.description).toContain('Do not reject a subtask whose code you copied');
    expect(rejectTool.description).toContain("lands only by lazy_accept");
    expect(rejectTool.description).toContain('lazy_unblock');
  });

  test('close forbids discarding a subtask whose code you kept', () => {
    expect(closeTool.description).toContain('Do not close a subtask whose code you kept');
    expect(closeTool.description).toContain("lands only by lazy_accept");
    expect(closeTool.description).toContain('do not use its code');
  });
});

/**
 * The wording is worthless if a prompt-assembly path drops it. Every agent
 * launch composes tool-instructions + one of the system-instruction variants,
 * so assert both composed prompts carry the rule itself, not just the heading.
 */
describe('composed agent system prompts', () => {
  test('buildSystemPrompt carries the land-by-accept rule', async () => {
    const { buildSystemPrompt } = await import('../../src/task/turn-context');
    const prompt = phrases(buildSystemPrompt());
    expect(prompt).toContain("lands in your branch ONLY by `lazy_accept`");
    expect(prompt).toContain('Rejecting or closing a subtask whose code you kept');
  });

  test('buildSystemPromptForResume carries the same rule', async () => {
    const { buildSystemPromptForResume } = await import('../../src/daemon/task-lifecycle');
    const prompt = phrases(buildSystemPromptForResume());
    expect(prompt).toContain("lands in your branch ONLY by `lazy_accept`");
    expect(prompt).toContain('Rejecting or closing a subtask whose code you kept');
  });
});
