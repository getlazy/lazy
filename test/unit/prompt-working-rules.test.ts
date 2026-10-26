import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readdir, readFile } from 'fs/promises';

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
    expect(t).toContain("Only for acceptance into the protected branch, confirm the project's full test suite is green on the task's head");
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

// INVARIANT: prompts reserve full-suite verification for protected-branch acceptance.
// Repeating it in work and child-review rounds makes every feedback cycle needlessly slow.
function fullSuiteViolations(text: string): string[] {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  return sentences.filter(sentence => {
    const mentions = sentence.matchAll(/\b(?:full|whole|entire)[ -]+(?:(?:test|unit)[ -]+)?suite\b/gi);
    for (const mention of mentions) {
      const prefix = sentence.slice(0, mention.index);
      // Only the clause governing this mention can permit it. An unrelated
      // "never" elsewhere in the paragraph must not excuse a positive command.
      const prohibited = /(?:\bnever (?:run|request)(?: or request)? (?:the project's |the |a )?|\bnever the project's |\bdo not demand a |\bnot the )$/i.test(prefix);
      const acceptance = /^(?:Reserve the project's |Only for acceptance into the protected branch, confirm the project's )$/i.test(prefix)
        && /\b(?:for )?acceptance into the protected branch\b/i.test(sentence);
      if (!prohibited && !acceptance) return true;
    }
    return false;
  });
}

test('full-suite guard rejects wrapped and unrelated-clause loopholes', () => {
  for (const text of [
    'Run the full\ntest suite after every fix.',
    'Never skip typecheck. Run the full test suite after every fix.',
    'Never skip typecheck; run the full test suite after every fix.',
    'Before acceptance into an unprotected branch, run the full test suite.',
    'Run the whole unit suite during active work.',
  ]) {
    expect(fullSuiteViolations(text)).not.toEqual([]);
  }
  for (const text of [
    "Never run or request the project's full\ntest suite during active work.",
    "Reserve the project's full test suite for acceptance into the protected branch.",
    "Only for acceptance into the protected branch, confirm the project's full test suite is green.",
  ]) {
    expect(fullSuiteViolations(text)).toEqual([]);
  }
});

test('no prompt requests a full suite outside protected-branch acceptance', async () => {
  const files = (await readdir(promptsDir, { recursive: true })).filter(file => file.endsWith('.md'));
  for (const file of files) {
    const text = await readFile(join(promptsDir, file), 'utf-8');
    expect({ file, violations: fullSuiteViolations(text) }).toEqual({ file, violations: [] });
  }
  for (const file of [
    'system-instructions.md', 'system-instructions-resume.md',
    'cluster-constraints.md', 'builder-system-prompt.md', 'fix-constraints.md',
    'low-high-loop-review.md', 'review-turn-feature.md', 'review-turn-scope.md',
  ]) {
    expect(await flat(file)).toMatch(/never (?:run|request|the project's full test suite)/i);
  }
});
