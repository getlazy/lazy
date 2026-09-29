import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';

/**
 * INVARIANT: the agent and builder prompts carry a small set of working rules
 * that the engineer had to teach this project's builder one correction at a
 * time, and that apply to any codebase. Each was a recurring failure before it
 * was a rule: guessed causes stated as fact, tests rewritten to bless a broken
 * change, a decision task answered by the agent instead of raised, commands
 * handed over without saying where they run, a report lost between tool calls.
 * Wording rots silently, so each rule is pinned here by its substance, with
 * whitespace normalised so re-wrapping a paragraph never fails the test.
 */
const promptsDir = join(import.meta.dir, '..', '..', 'src', 'prompts');
const flat = async (name: string) =>
  (await readFile(join(promptsDir, name), 'utf-8')).replace(/\s+/g, ' ');

describe('agent prompts (fresh and resume)', () => {
  for (const file of ['system-instructions.md', 'system-instructions-resume.md']) {
    test(`${file} carries the working rules`, async () => {
      const t = await flat(file);
      expect(t).toContain('Verify a cause before you state it.');
      expect(t).toContain('"not confirmed yet" beats a plausible guess');
      expect(t).toContain('Fix the root cause; never hide a slow or broken path');
      expect(t).toContain('Never edit a test or comment just to agree with your change');
      expect(t).toContain('the task did not ask for that behaviour to change');
      expect(t).toContain("raise it (blocking), don't rewrite it");
      expect(t).toContain('no private shorthand — say in plain words what anything you name is');
      expect(t).toContain("when the task's GOAL is a decision for the human, it ends in a blocking raise");
      expect(t).toContain('never your own pick presented as the answer');
      expect(t).toContain('say where each command runs');
    });
  }
});

describe('builder prompt', () => {
  test('carries the working rules', async () => {
    const t = await flat('builder-system-prompt.md');
    expect(t).toContain("A spike's or design report's claims about how the system behaves are hypotheses");
    expect(t).toContain('Every command you hand the engineer says where it runs');
    expect(t).toContain('Scan for deletions or reverts in files the task had no reason to touch');
    expect(t).toContain('existing tests or comments rewritten to assert what the change now does');
    expect(t).toContain("confirm the project's FULL test suite is green on the task's head");
    expect(t).toContain('scope ONE task that investigates and fixes it');
    expect(t).toContain('the task ends in a blocking raise with options and evidence');
    expect(t).toContain('Hand files to a task as artifacts');
    expect(t).toContain('Your reply to the engineer is the LAST thing in a turn, after every tool call');
    expect(t).toContain('lead with its path or link');
    expect(t).toContain('treat what the session added as scope they approved');
    expect(t).toContain('Terse means short AND plain.');
    expect(t).toContain("Check the branch's commits and uncommitted state before reading the agent's report");
    expect(t).toContain('Review on a model at least as strong as the one that wrote the work');
    expect(t).toContain('Keep each brief to a few concrete items');
  });
});
