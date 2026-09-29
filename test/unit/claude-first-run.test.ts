import { describe, expect, test } from 'bun:test';
import { applyClaudeFirstRunDefaults, CLAUDE_FIRST_RUN_KEYS } from '../../src/agent/claude-first-run';
import { extractClaudePreferenceSeed } from '../../src/task/claude-home';

describe('applyClaudeFirstRunDefaults', () => {
  test('an empty document gets every first-run answer and nothing else', () => {
    const out = applyClaudeFirstRunDefaults({}, { trustPaths: ['/p'], apiKey: 'sk-ant-placeholder-0123456789abcdef' });
    // INVARIANT: the first-run seed writes only onboarding/trust keys — never
    // an account or identity. A member must never inherit anybody's identity.
    expect(Object.keys(out).sort()).toEqual([...CLAUDE_FIRST_RUN_KEYS].sort());
    expect(out.hasCompletedOnboarding).toBe(true);
    expect(out.bypassPermissionsModeAccepted).toBeUndefined();
    expect(out.projects).toEqual({ '/p': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });
    expect(out.customApiKeyResponses).toEqual({ approved: ['sk-ant-placeholder-0123456789abcdef'.slice(-20)], rejected: [] });
  });

  test('existing answers win', () => {
    const out = applyClaudeFirstRunDefaults(
      { theme: 'light', projects: { '/p': { hasTrustDialogAccepted: false, history: [1] } }, customApiKeyResponses: { approved: [], rejected: ['x'.repeat(20)] } },
      { trustPaths: ['/p'], apiKey: 'x'.repeat(30) },
    );
    expect(out.theme).toBe('light');
    expect(out.projects).toEqual({ '/p': { hasTrustDialogAccepted: false, history: [1], hasCompletedProjectOnboarding: true } });
    expect(out.customApiKeyResponses).toEqual({ approved: [], rejected: ['x'.repeat(20)] });
  });

  test('a new launch replaces the previous launch\'s approval instead of accumulating', () => {
    const first = applyClaudeFirstRunDefaults({}, { apiKey: 'a'.repeat(30) });
    const second = applyClaudeFirstRunDefaults(first, { apiKey: 'b'.repeat(30) });
    expect((second.customApiKeyResponses as { approved: string[] }).approved).toEqual(['b'.repeat(20)]);
  });

  test('the task seed uses the same defaults', () => {
    // INVARIANT: task and builder seeds share one first-run source and cannot drift.
    expect(extractClaudePreferenceSeed({})).toEqual(applyClaudeFirstRunDefaults({}));
  });
});
