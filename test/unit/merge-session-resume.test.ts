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
import { buildMergeClaudeArgs } from '../../src/supervisor/merge';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';

describe('buildMergeClaudeArgs', () => {
  const MERGE_PROMPT = 'Merge main into your branch and resolve conflicts.';
  const SESSION_ID = 'abc12345-session-id';
  const MODEL_ID = 'claude-sonnet-4-5-20250929';

  // INVARIANT: When agentSessionId is provided and useResume=true, the args
  // include --resume so the agent has full context from prior work.
  test('includes --resume when agentSessionId is provided and useResume is true', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, undefined, SESSION_ID, true);

    expect(args).toContain('--resume');
    expect(args).toContain(SESSION_ID);
    // Verify --resume comes with the session ID
    const resumeIdx = args.indexOf('--resume');
    expect(args[resumeIdx + 1]).toBe(SESSION_ID);
  });

  // INVARIANT: When no session exists, fall back to standalone cold-start mode.
  test('does not include --resume when agentSessionId is not provided', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, undefined, undefined, false);

    expect(args).not.toContain('--resume');
  });

  test('does not include --resume when useResume is false even with session ID', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, undefined, SESSION_ID, false);

    expect(args).not.toContain('--resume');
    expect(args).not.toContain(SESSION_ID);
  });

  test('does not include --resume when useResume is true but no session ID', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, undefined, undefined, true);

    expect(args).not.toContain('--resume');
  });

  test('always includes base args: claude -p <prompt> --output-format json --dangerously-skip-permissions', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, undefined, undefined, false);

    expect(args[0]).toBe('claude');
    expect(args[1]).toBe('-p');
    expect(args[2]).toBe(MERGE_PROMPT);
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  test('includes --model when modelId is provided', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, MODEL_ID, undefined, false);

    expect(args).toContain('--model');
    expect(args).toContain(MODEL_ID);
  });

  test('includes both --resume and --model when both are provided', () => {
    const args = buildMergeClaudeArgs(MERGE_PROMPT, MODEL_ID, SESSION_ID, true);

    expect(args).toContain('--resume');
    expect(args).toContain(SESSION_ID);
    expect(args).toContain('--model');
    expect(args).toContain(MODEL_ID);
  });

  test('uses the provided prompt text (resume prompt vs standalone prompt)', () => {
    const standalonePrompt = 'Full standalone merge instructions...';
    const resumePrompt = 'Short resume merge instructions...';

    const standaloneArgs = buildMergeClaudeArgs(standalonePrompt, undefined, undefined, false);
    const resumeArgs = buildMergeClaudeArgs(resumePrompt, undefined, SESSION_ID, true);

    expect(standaloneArgs[2]).toBe(standalonePrompt);
    expect(resumeArgs[2]).toBe(resumePrompt);
  });
});

describe('--resume + -p arg order consistency', () => {
  // INVARIANT: `claude --resume <id> -p <prompt>` sends the prompt as a follow-up
  // message in the existing session. Both `-p` and `--resume` must be present, and
  // `-p` always provides the merge instructions. The arg order produced by
  // buildMergeClaudeArgs must match what ClaudeCodeAgent.buildExecArgs produces,
  // ensuring consistent behavior between merge resolution and normal work.
  test('buildMergeClaudeArgs produces same arg pattern as ClaudeCodeAgent.buildExecArgs', () => {
    const agent = new ClaudeCodeAgent();
    const prompt = 'Resolve conflicts';
    const sessionId = 'test-session-123';

    const agentArgs = agent.buildExecArgs({
      prompt,
      sessionId,
      dangerouslySkipPermissions: true,
    });

    const mergeArgs = buildMergeClaudeArgs(prompt, undefined, sessionId, true);

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
    const args = buildMergeClaudeArgs('Merge prompt', undefined, undefined, false);

    expect(args).toContain('-p');
    expect(args).not.toContain('--resume');
    // Must still have required flags
    expect(args).toContain('--output-format');
    expect(args).toContain('--dangerously-skip-permissions');
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
});
