/**
 * Unit tests for same-session conflict resolution in merge.ts.
 *
 * Verifies that when an agent session ID is provided, merge conflict resolution
 * uses `--resume` to leverage the agent's prior context, and falls back to
 * standalone `claude -p` when no session exists.
 *
 * ASSUMPTION: Claude Code's `--resume <id> -p <prompt>` sends the prompt as a
 * follow-up message in the existing session, not as a fresh conversation. This
 * is verified by the ClaudeCodeAgent.buildExecArgs tests and by the Claude Code
 * CLI documentation. If this behavior changes, merges would silently lose context.
 * To verify manually: `claude --resume <session-id> -p "hello"` should show the
 * response includes context from the prior session.
 */

import { describe, test, expect } from 'bun:test';
import { buildMergeAgentArgs } from '../../src/supervisor/merge';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { CursorAgent, CURSOR_AUTO_MODEL } from '../../src/agent/cursor';

const CLAUDE = new ClaudeCodeAgent();
/** Every merge turn names a model — a model-less launch is refused. */
const MODEL_ID = 'claude-sonnet-4-5-20250929';

describe('buildMergeAgentArgs', () => {
  const MERGE_PROMPT = 'Merge main into your branch and resolve conflicts.';
  const SESSION_ID = 'abc12345-session-id';

  // INVARIANT: When agentSessionId is provided and useResume=true, the args
  // include --resume so the agent has full context from prior work.
  test('includes --resume when agentSessionId is provided and useResume is true', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, SESSION_ID, true);

    expect(args).toContain('--resume');
    expect(args).toContain(SESSION_ID);
    // Verify --resume comes with the session ID
    const resumeIdx = args.indexOf('--resume');
    expect(args[resumeIdx + 1]).toBe(SESSION_ID);
  });

  // INVARIANT: When no session exists, fall back to standalone cold-start mode.
  test('does not include --resume when agentSessionId is not provided', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, undefined, false);

    expect(args).not.toContain('--resume');
  });

  test('does not include --resume when useResume is false even with session ID', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, SESSION_ID, false);

    expect(args).not.toContain('--resume');
    expect(args).not.toContain(SESSION_ID);
  });

  test('does not include --resume when useResume is true but no session ID', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, undefined, true);

    expect(args).not.toContain('--resume');
  });

  test('always includes base args: claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, undefined, false);

    expect(args[0]).toBe('claude');
    expect(args[1]).toBe('-p');
    expect(args[2]).toBe(MERGE_PROMPT);
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  // INVARIANT: a merge turn is an ordinary agent turn — it edits files, runs
  // tests, and commits — so it must stream like the work phase. Without
  // stream-json there is no activity signal, which means no no-progress guard
  // and no way to know the agent's result has landed. Dropping back to the
  // single-blob `json` format would silently leave merge turns unguarded.
  test('streams, so merge turns get the same two guards as the work phase', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, undefined, false);

    const formatIdx = args.indexOf('--output-format');
    expect(args[formatIdx + 1]).toBe('stream-json');
    // stream-json is only emitted per-event when --verbose is also passed.
    expect(args).toContain('--verbose');
  });

  test('includes --model when modelId is provided', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, undefined, false);

    expect(args).toContain('--model');
    expect(args).toContain(MODEL_ID);
  });

  test('includes both --resume and --model when both are provided', () => {
    const args = buildMergeAgentArgs(CLAUDE, MERGE_PROMPT, MODEL_ID, SESSION_ID, true);

    expect(args).toContain('--resume');
    expect(args).toContain(SESSION_ID);
    expect(args).toContain('--model');
    expect(args).toContain(MODEL_ID);
  });

  test('uses the provided prompt text (resume prompt vs standalone prompt)', () => {
    const standalonePrompt = 'Full standalone merge instructions...';
    const resumePrompt = 'Short resume merge instructions...';

    const standaloneArgs = buildMergeAgentArgs(CLAUDE, standalonePrompt, MODEL_ID, undefined, false);
    const resumeArgs = buildMergeAgentArgs(CLAUDE, resumePrompt, MODEL_ID, SESSION_ID, true);

    expect(standaloneArgs[2]).toBe(standalonePrompt);
    expect(resumeArgs[2]).toBe(resumePrompt);
  });
});

describe('--resume + -p arg order consistency', () => {
  // INVARIANT: `claude --resume <id> -p <prompt>` sends the prompt as a follow-up
  // message in the existing session. Both `-p` and `--resume` must be present, and
  // `-p` always provides the merge instructions. The arg order produced by
  // buildMergeAgentArgs must match what ClaudeCodeAgent.buildExecArgs produces,
  // ensuring consistent behavior between merge resolution and normal work.
  test('buildMergeAgentArgs produces same arg pattern as ClaudeCodeAgent.buildExecArgs', () => {
    const agent = new ClaudeCodeAgent();
    const prompt = 'Resolve conflicts';
    const sessionId = 'test-session-123';

    const agentArgs = agent.buildExecArgs({
      prompt,
      sessionId,
      modelId: MODEL_ID,
      dangerouslySkipPermissions: true,
    });

    const mergeArgs = buildMergeAgentArgs(CLAUDE, prompt, MODEL_ID, sessionId, true);

    // Both must contain -p with prompt, --resume with session, and --dangerously-skip-permissions
    expect(agentArgs).toContain('-p');
    expect(agentArgs).toContain(prompt);
    expect(agentArgs).toContain('--resume');
    expect(agentArgs).toContain(sessionId);
    expect(agentArgs).toContain('--dangerously-skip-permissions');

    expect(mergeArgs).toContain('-p');
    expect(mergeArgs).toContain(prompt);
    expect(mergeArgs).toContain('--resume');
    expect(mergeArgs).toContain(sessionId);
    expect(mergeArgs).toContain('--dangerously-skip-permissions');

    // Both must have -p before --resume (Claude Code expects -p first, --resume after)
    // Actually: the agent puts -p first, then --resume. Verify same pattern.
    const agentPIdx = agentArgs.indexOf('-p');
    const agentResumeIdx = agentArgs.indexOf('--resume');
    const mergePIdx = mergeArgs.indexOf('-p');
    const mergeResumeIdx = mergeArgs.indexOf('--resume');

    // Verify both put -p before --resume (Claude Code CLI convention)
    expect(agentPIdx).toBeLessThan(agentResumeIdx);
    expect(mergePIdx).toBeLessThan(mergeResumeIdx);
  });

  // Verify that without --resume, the args still work as a standalone invocation
  test('standalone mode produces valid cold-start args (no --resume)', () => {
    const args = buildMergeAgentArgs(CLAUDE, 'Merge prompt', MODEL_ID, undefined, false);

    expect(args).toContain('-p');
    expect(args).not.toContain('--resume');
    // Must still have required flags
    expect(args).toContain('--output-format');
    expect(args).toContain('--dangerously-skip-permissions');
  });
});

describe('merge resolver launches the TASK\'s agent', () => {
  // INVARIANT: a merge turn runs through the same Agent abstraction as the work
  // phase. The old builder hardcoded the `claude` binary but appended the TASK's
  // --model and --resume, so a cursor task launched
  // `claude --model auto --resume <cursor-session-id>` and exited 1 instantly —
  // retries exhausted, no agent ever saw the conflicts, worktree left mid-merge.
  // The foreign-parameter inheritance is impossible by construction now: the
  // model and session go to the agent that owns them.
  test('a cursor task resolves with cursor-agent, never the claude binary', () => {
    const cursor = new CursorAgent();
    const args = buildMergeAgentArgs(
      cursor,
      'Resolve conflicts',
      CURSOR_AUTO_MODEL,
      'cursor-session-abc',
      true,
    );

    expect(args[0]).toBe('cursor-agent');
    expect(args).not.toContain('claude');
    // The cursor model and session reach the cursor CLI, where they are valid.
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe(CURSOR_AUTO_MODEL);
    const resumeIdx = args.indexOf('--resume');
    expect(args[resumeIdx + 1]).toBe('cursor-session-abc');
  });

  // INVARIANT: `auto` is not a Claude Code model id and a cursor session id is
  // not a Claude Code session — neither may ever appear in claude argv. This is
  // the precise shape of the crash this task fixes.
  test('claude argv never carries a cursor model or a cursor session id', () => {
    const args = buildMergeAgentArgs(CLAUDE, 'Resolve conflicts', MODEL_ID, undefined, false);

    expect(args[0]).toBe('claude');
    expect(args).not.toContain(CURSOR_AUTO_MODEL);
    expect(args).not.toContain('--resume');
  });

  // The builder never invents a model or a session: it forwards exactly what the
  // caller resolved for THAT agent, so there is no path by which one agent's
  // parameters can be handed to another. A merge turn with no resolved model is
  // refused rather than run on the harness's own default (src/agent/launch-model.ts).
  test('refuses a merge turn when the task has no resolved model', () => {
    expect(() => buildMergeAgentArgs(new CursorAgent(), 'p', undefined, undefined, false))
      .toThrow(/cursor launch names no model/);
    expect(() => buildMergeAgentArgs(CLAUDE, 'p', undefined, undefined, false))
      .toThrow(/claude-code launch names no model/);
  });
});

describe('merge prompt templates', () => {
  test('upstream resume prompt exists and contains parentBranch placeholder', async () => {
    const template = await import('../../src/prompts/merge-conflict-resolution-resume.md');
    const text = template.default;

    expect(text).toContain('{{parentBranch}}');
    expect(text.length).toBeGreaterThan(0);
  });

  test('upstream standalone prompt exists and contains parentBranch placeholder', async () => {
    const template = await import('../../src/prompts/merge-conflict-resolution.md');
    const text = template.default;

    expect(text).toContain('{{parentBranch}}');
  });

  test('upstream resume prompt is shorter than standalone prompt (leverages prior context)', async () => {
    const resumeTemplate = await import('../../src/prompts/merge-conflict-resolution-resume.md');
    const standaloneTemplate = await import('../../src/prompts/merge-conflict-resolution.md');

    expect(resumeTemplate.default.length).toBeLessThan(standaloneTemplate.default.length);
  });

  test('remote resume prompt exists and contains remoteBranch placeholder', async () => {
    const template = await import('../../src/prompts/remote-branch-merge-resume.md');
    const text = template.default;

    expect(text).toContain('{{remoteBranch}}');
    expect(text.length).toBeGreaterThan(0);
  });

  test('remote resume prompt is shorter than standalone remote prompt', async () => {
    const resumeTemplate = await import('../../src/prompts/remote-branch-merge-resume.md');
    const standaloneTemplate = await import('../../src/prompts/remote-branch-merge.md');

    expect(resumeTemplate.default.length).toBeLessThan(standaloneTemplate.default.length);
  });

  // INVARIANT: Upstream merge prompts tell agents to preserve upstream changes while
  // merging intelligently — not blindly picking upstream's version of every conflict.
  test('upstream prompts guide intelligent merge, not blind upstream preference', async () => {
    const standalone = (await import('../../src/prompts/merge-conflict-resolution.md')).default;
    const resume = (await import('../../src/prompts/merge-conflict-resolution-resume.md')).default;

    // Both should mention preserving upstream AND combining/adapting both sides
    for (const prompt of [standalone, resume]) {
      expect(prompt).toContain('preserve');
      expect(prompt).not.toContain('authoritative');
      // Should guide intelligent merging, not blind preference
      expect(prompt).toMatch(/both|coexist|combin/i);
    }
  });

  // INVARIANT (fix-merge-agent-nonclaude): every merge prompt carries the four
  // resolution disciplines learned from real bad merges — a changelog section
  // resolved by taking one side, a serialize list that silently lost three
  // fields, a "merge" finished by hand-copying files as fresh single-parent
  // commits, and a resolution nobody ran anything against.
  test('every merge prompt carries the resolution disciplines', async () => {
    const prompts = await Promise.all([
      import('../../src/prompts/merge-conflict-resolution.md'),
      import('../../src/prompts/merge-conflict-resolution-resume.md'),
      import('../../src/prompts/remote-branch-merge.md'),
      import('../../src/prompts/remote-branch-merge-resume.md'),
    ]);

    for (const { default: text } of prompts) {
      // (a) lists of entries — changelog sections — take the union
      expect(text).toMatch(/UNION/);
      expect(text).toMatch(/changelog/i);
      // (b) field/enum lists take the union, verified against BOTH parents
      expect(text).toMatch(/enum|field list/i);
      expect(text).toContain('MERGE_HEAD');
      expect(text).toMatch(/BOTH parents/i);
      // (c) the merge commit with both parents is the deliverable
      expect(text).toMatch(/hand-cop/i);
      // (d) verify each side where cheap
      expect(text).toMatch(/type-check/i);
    }
  });

  // INVARIANT: the merge prompts are handed to whichever agent owns the task
  // (see buildMergeAgentArgs), so they must never name one agent. Naming
  // "Claude Code" in a prompt a cursor agent reads is at best noise and at
  // worst an instruction it cannot follow.
  test('merge prompts are agent-agnostic', async () => {
    const prompts = await Promise.all([
      import('../../src/prompts/merge-conflict-resolution.md'),
      import('../../src/prompts/merge-conflict-resolution-resume.md'),
      import('../../src/prompts/remote-branch-merge.md'),
      import('../../src/prompts/remote-branch-merge-resume.md'),
    ]);

    for (const { default: text } of prompts) {
      expect(text).not.toMatch(/claude/i);
      expect(text).not.toMatch(/cursor/i);
    }
  });
});
