import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { messagePostTool } from '../../src/mcp/tools';

/**
 * INVARIANT: agent-facing prompts state that a red check on the task's OWN
 * branch is part of the task, and that an environment blocker only the human
 * can fix gets reported with `lazy_message_post`.
 *
 * Both rules come from one incident. A task's CI went red; the cause was not
 * the task's change but a stuck process on the runner. The agent's first move
 * was to call the failure "out of scope" and hand back. Only after the human
 * pushed did it investigate, find the real cause, and — unprompted — file a
 * system message saying what was broken and how to fix it. That last step is
 * the behavior we want by default; the shrug is the failure mode.
 *
 * "Not caused by my diff" is a FINDING an agent has to establish, and being
 * unable to reach CI is not a statement about what is wrong with it — so the
 * prompts have to say both, or the next agent reaches for the same excuse.
 * These are prompt-content assertions on purpose: the behavior lives in
 * wording, and wording is what silently rots.
 *
 * system-instructions.md (fresh launch) and system-instructions-resume.md
 * (resume / auto-deliver) are near-duplicates by convention; a rule added to
 * one and forgotten in the other disappears for every resumed turn. Both
 * sections are pinned to identical text below.
 */
describe('agent check-failure discipline prompts', () => {
  const promptsDir = join(import.meta.dir, '..', '..', 'src', 'prompts');
  const VERIFY = '### Verifying your work';
  const BLOCKED = '### When you are blocked by something outside your reach';

  const readPrompt = (name: string) => readFile(join(promptsDir, name), 'utf-8');

  function extractSection(text: string, heading: string, file: string): string {
    const start = text.indexOf(heading);
    expect(start, `${file} must contain "${heading}"`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n### ', start + heading.length);
    return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
  }

  /**
   * These prompts are hard-wrapped, so any phrase long enough to be worth
   * pinning can land across a line break — and re-wraps this whole class of
   * assertion to nothing without touching a word of the rule. Collapse runs of
   * whitespace before matching phrases; only the words are the invariant.
   */
  const phrases = (section: string) => section.replace(/\s+/g, ' ');

  test('both system-instruction variants carry identical verify and blocked sections', async () => {
    const fresh = await readPrompt('system-instructions.md');
    const resume = await readPrompt('system-instructions-resume.md');
    for (const heading of [VERIFY, BLOCKED]) {
      expect(
        extractSection(resume, heading, 'system-instructions-resume.md'),
        `"${heading}" must be identical in both system-instruction variants`,
      ).toBe(extractSection(fresh, heading, 'system-instructions.md'));
    }
  });

  test('the verification section refuses "out of scope" for a red check on this branch', async () => {
    const section = phrases(
      extractSection(await readPrompt('system-instructions.md'), VERIFY, 'system-instructions.md'),
    );

    // The three check surfaces an agent can meet, named explicitly so none of
    // them reads as someone else's problem.
    expect(section).toContain('CI');
    expect(section).toContain('post-turn check');
    expect(section).toContain('pre-accept');

    // The excuses, quoted so an agent cannot reach for them unexamined.
    // "flaky" belongs here with the other two: it is the one excuse that sounds
    // like a diagnosis while naming no cause at all.
    expect(section).toContain('out of scope');
    expect(section).toContain('pre-existing');
    expect(section).toContain('"flaky"');

    // Establishing that a failure predates the change is a step, not the end:
    // the cause still has to be named either way.
    expect(section).toContain('findings you establish');
    expect(section).toContain('found the CAUSE');
    expect(section).toContain('name the cause');

    // Escape hatch closed: agents have no forge credentials, so "I can't see
    // CI" is the obvious dodge. Reproducing locally is the required fallback,
    // and being unable to reach or fix a thing says nothing about what is
    // wrong with it.
    expect(section).toContain('reproduce the failing step locally');
    expect(section).toContain('not an explanation of what is');

    // Escape hatch closed: a non-blocking raised item is passive and notifies
    // nobody, which makes it the perfect place to quietly park a red check.
    // After unification that is the only shape the dodge can take — there is no
    // separate follow-up entity to reach for.
    expect(section).toContain('not to raise it as a non-blocking item and move on');

    // Environment causes route to the system-message rule rather than dropping.
    expect(section).toContain('wedged runner');
  });

  test('the blocked section routes environment failures to lazy_message_post', async () => {
    const section = phrases(
      extractSection(await readPrompt('system-instructions.md'), BLOCKED, 'system-instructions.md'),
    );

    expect(section).toContain('`lazy_message_post`');
    // The blocker classes from the incident and its neighbours.
    expect(section).toContain('wedged CI runner');
    expect(section).toContain('expired credential');

    // The four things a report has to say, and how the kind is chosen.
    expect(section).toContain('what is broken');
    expect(section).toContain('the evidence');
    expect(section).toContain('concrete remedy');
    expect(section).toContain('which task hit it');
    expect(section).toContain('`alert`');
    expect(section).toContain('`notice`');

    // Escape hatch closed: a message must not become a way to skip the work.
    expect(section).toContain('investigation ENDS, never a substitute for one');
    expect(section).toContain('is not a report');

    // INVARIANT: TWO channels, not three. Unification collapsed the old
    // raise/follow-up split into one tool with a flag, so the prompt must
    // present a broken environment vs. everything else — and say what decides
    // the flag, or the agent is back to guessing between two entities.
    expect(section).toContain('Two channels');
    expect(section).toContain('`lazy_message_post`');
    expect(section).toContain('`lazy_raise`');
    expect(section).toContain('scope or diff');
    expect(section).not.toContain('lazy_add_followup');
  });

  test('tool instructions carry the same rule next to the tool that implements it', async () => {
    const tools = await readPrompt('tool-instructions.md');
    expect(tools).toContain('lazy_message_post');
    expect(tools).toContain('ENVIRONMENT is broken');
    expect(tools).toContain('out of scope');
    // The two-way distinction, restated where the tools are listed.
    expect(tools).toContain('Keep the two straight');
    expect(tools).toContain("`lazy_raise` = anything else the human must see");
  });

  test('MCP server instructions tell agents to investigate a red check first', async () => {
    const mcp = await readPrompt('mcp-server-instructions.md');
    expect(mcp).toContain('out of scope');
    expect(mcp).toContain('lazy_message_post');
    expect(mcp).toContain('post-turn check');
  });

  test('the builder prompt generalizes its missing-tool rule the same way', async () => {
    // The builder relays the inbox to the human and files its own messages; a
    // missing-tool-only rule there would contradict what agents are now told.
    const builder = await readPrompt('builder-system-prompt.md');
    expect(builder).toContain('wedged CI runner');
    expect(builder).toContain('which task hit it');
    expect(builder).toContain('`alert`');
  });
});

/**
 * The MCP tool description is the other place an agent reads before deciding
 * whether a system message is allowed here. It used to say the tool was "NOT a
 * warning channel", which reads as a refusal of exactly the environment report
 * we now ask for. The boundary it was protecting is narrower: `lazy doctor`
 * owns LAZY's own config/health diagnosis. Keep the narrow boundary; do not let
 * the blanket wording come back on any surface.
 */
describe('lazy_message_post description', () => {
  test('names the environment-blocker use', () => {
    expect(messagePostTool.description).toContain('wedged CI runner');
    expect(messagePostTool.description).toContain('what is broken');
    expect(messagePostTool.description).toContain('the evidence');
    expect(messagePostTool.description).toContain('which task hit it');
  });

  test('keeps the doctor boundary as a narrow one', () => {
    expect(messagePostTool.description).toContain('lazy doctor');
    expect(messagePostTool.description).toContain('report FOR the human');
  });

  test('no surface reverts to the blanket "not a warning channel" wording', async () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const files = [
      'src/mcp/tools.ts',
      'src/types/index.ts',
      'src/cli/commands/messages.ts',
      'src/prompts/tool-instructions.md',
      'src/prompts/mcp-server-instructions.md',
      'public-docs/system-messages.md',
    ];
    expect(
      messagePostTool.description.toLowerCase(),
      'the lazy_message_post description must not say "not a warning channel"',
    ).not.toContain('a warning channel');
    for (const file of files) {
      const text = await readFile(join(repoRoot, file), 'utf-8');
      expect(text.toLowerCase(), `${file} must not say "not a warning channel"`).not.toContain(
        'a warning channel',
      );
    }
  });
});

/**
 * The wording is worthless if a prompt-assembly path drops it. Every agent
 * launch composes tool-instructions + one of the system-instruction variants,
 * so assert both composed prompts carry the rule itself, not just the heading.
 */
describe('composed agent system prompts', () => {
  test('buildSystemPrompt carries the red-check rule and the blocked section', async () => {
    const { buildSystemPrompt } = await import('../../src/task/turn-context');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('A red check on this task\'s branch is part of this task.');
    expect(prompt).toContain('### When you are blocked by something outside your reach');
    expect(prompt).toContain('lazy_message_post');
  });

  test('buildSystemPromptForResume carries the same rules', async () => {
    const { buildSystemPromptForResume } = await import('../../src/daemon/task-lifecycle');
    const prompt = buildSystemPromptForResume();
    expect(prompt).toContain('A red check on this task\'s branch is part of this task.');
    expect(prompt).toContain('### When you are blocked by something outside your reach');
    expect(prompt).toContain('lazy_message_post');
  });
});
