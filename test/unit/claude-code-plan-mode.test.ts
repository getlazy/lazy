import { describe, test, expect } from 'bun:test';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';

/**
 * INVARIANT: Ask/plan mode must NOT pass `--permission-mode plan` to claude.
 * That flag triggers an interactive ExitPlanMode prompt that `claude -p`
 * cannot answer, causing the agent to stall. Instead, write tools are blocked
 * via `--disallowedTools "Bash Write Edit"`.
 *
 * Pairs with the MCP read-only handler guards and the ask-system-prompt as
 * a defense-in-depth lockdown for ask mode.
 */
describe('ClaudeCodeAgent plan-mode lockdown', () => {
  const agent = new ClaudeCodeAgent();

  test('plan mode pushes --disallowedTools and NOT --permission-mode plan', () => {
    const args = agent.buildExecArgs({
      prompt: 'What does X do?',
      dangerouslySkipPermissions: true,
      permissionMode: 'plan',
    });

    const disallowedIdx = args.indexOf('--disallowedTools');
    expect(disallowedIdx).toBeGreaterThanOrEqual(0);
    expect(args[disallowedIdx + 1]).toBe('Bash Write Edit');

    expect(args).not.toContain('--permission-mode');
  });

  test('non-plan mode still pushes --dangerously-skip-permissions', () => {
    const args = agent.buildExecArgs({
      prompt: 'Do the thing',
      dangerouslySkipPermissions: true,
    });

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--disallowedTools');
    expect(args).not.toContain('--permission-mode');
  });

  test('plan mode keeps --dangerously-skip-permissions when caller asked for it', () => {
    const args = agent.buildExecArgs({
      prompt: 'What does X do?',
      dangerouslySkipPermissions: true,
      permissionMode: 'plan',
    });

    expect(args).toContain('--dangerously-skip-permissions');
  });
});
