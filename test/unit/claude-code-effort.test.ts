import { describe, test, expect } from 'bun:test';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { VALID_EFFORT_LEVELS } from '../../src/config/types';

/**
 * INVARIANT: ClaudeCodeAgent.buildExecArgs must pass `--effort <level>`
 * when the caller supplies one, and must omit it entirely when not supplied.
 *
 * This is the final hop where the resolved effort value becomes a CLI flag
 * on the Claude Code subprocess — if this breaks, the whole pipeline silently
 * reverts to Claude's built-in default.
 */

describe('ClaudeCodeAgent effort flag', () => {
  const agent = new ClaudeCodeAgent();

  test('emits --effort <level> when effort is provided', () => {
    const args = agent.buildExecArgs({
      prompt: 'Do the thing',
      dangerouslySkipPermissions: false,
      effort: 'high',
    });

    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('high');
  });

  test('omits --effort entirely when effort is undefined', () => {
    const args = agent.buildExecArgs({
      prompt: 'Do the thing',
      dangerouslySkipPermissions: false,
    });

    expect(args).not.toContain('--effort');
  });

  // INVARIANT: every valid level round-trips through buildExecArgs.
  test('passes every valid effort level through verbatim', () => {
    for (const level of VALID_EFFORT_LEVELS) {
      const args = agent.buildExecArgs({
        prompt: 'Do the thing',
        dangerouslySkipPermissions: false,
        effort: level,
      });
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(level);
    }
  });
});
