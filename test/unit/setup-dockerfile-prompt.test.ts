import { describe, test, expect } from 'bun:test';
import { renderSetupDockerfilePrompt } from '../../src/cli/setup-dockerfile-prompt';
import { getAgentPackaging } from '../../src/agent/registry';

describe('renderSetupDockerfilePrompt', () => {
  // INVARIANT: `lazy init` seeds this task for EVERY project, so the prompt must
  // feature the project's own agent CLI. Hardcoding Claude Code handed cursor
  // projects a Dockerfile.lazy their agent could not run from.
  test('substitutes the configured agent name and install command', () => {
    const prompt = renderSetupDockerfilePrompt('cursor');
    expect(prompt).toContain('Cursor');
    expect(prompt).toContain(getAgentPackaging('cursor').dockerInstallCommand());
    expect(prompt).not.toContain('@anthropic-ai/claude-code');
  });

  test('claude-code projects get the Claude Code installer', () => {
    const prompt = renderSetupDockerfilePrompt('claude-code');
    expect(prompt).toContain('Claude Code');
    expect(prompt).toContain(getAgentPackaging('claude-code').dockerInstallCommand());
  });

  test('leaves no unsubstituted placeholders', () => {
    for (const agentId of ['claude-code', 'cursor', 'qa-agent', 'made-up-agent']) {
      expect(renderSetupDockerfilePrompt(agentId)).not.toContain('{{');
    }
  });

  // An agent id lazy does not know (hand-edited lazy.toml) must not make init
  // throw while seeding a best-effort task prompt.
  test('unknown agent id degrades instead of throwing', () => {
    const prompt = renderSetupDockerfilePrompt('made-up-agent');
    expect(prompt).toContain('made-up-agent');
  });

  // The base-image paragraph keeps naming Claude Code deliberately: lazy runs
  // Claude Code in-container for its own merge turns whatever the task agent is.
  test('base runner guidance still names Claude Code', () => {
    expect(renderSetupDockerfilePrompt('cursor')).toContain('Claude Code CLI');
  });
});
