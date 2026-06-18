import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig, ChattinessLevel } from '../../src/config/types';
import { resolveBuilderChattiness, resolveAgentChattiness, renderChattinessSnippet } from '../../src/config/chattiness';
import { buildSystemPrompt } from '../../src/cli/commands/shared';
import builderSystemPrompt from '../../src/prompts/builder-system-prompt.md' with { type: 'text' };

function makeConfig(chattiness: Partial<ResolvedConfig['chattiness']>): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    chattiness: { default: '', builder: '', agent: '', ...chattiness },
  };
}

describe('chattiness resolution', () => {
  // INVARIANT: When nothing is configured, both roles resolve to '' (unset),
  // which means NO verbosity snippet is injected — preserving today's behavior.
  test('unset everywhere resolves to empty for both roles', () => {
    const config = makeConfig({});
    expect(resolveBuilderChattiness(config)).toBe('');
    expect(resolveAgentChattiness(config)).toBe('');
  });

  // INVARIANT: A single `default` is the shared baseline for both roles when no
  // per-role override is given.
  test('shared default applies to both roles', () => {
    const config = makeConfig({ default: 'normal' });
    expect(resolveBuilderChattiness(config)).toBe('normal');
    expect(resolveAgentChattiness(config)).toBe('normal');
  });

  // INVARIANT: Per-role values override the shared default for that role only.
  test('per-role overrides win over the shared default', () => {
    const config = makeConfig({ default: 'normal', builder: 'chatty', agent: 'terse' });
    expect(resolveBuilderChattiness(config)).toBe('chatty');
    expect(resolveAgentChattiness(config)).toBe('terse');
  });

  // INVARIANT: A per-role value works even with no shared default; the other
  // role stays unset.
  test('a per-role value without a default leaves the other role unset', () => {
    const config = makeConfig({ agent: 'chatty' });
    expect(resolveAgentChattiness(config)).toBe('chatty');
    expect(resolveBuilderChattiness(config)).toBe('');
  });
});

describe('renderChattinessSnippet', () => {
  // INVARIANT: Unset level renders nothing so callers inject no guidance.
  test('returns empty string when level is unset', () => {
    expect(renderChattinessSnippet('')).toBe('');
  });

  // INVARIANT: The configured level is substituted into the snippet and the
  // elastic "one notch" wording is present — that wording is the heart of the
  // feature and must not silently disappear.
  test('substitutes the level and includes the elastic stepping rule', () => {
    for (const level of ['terse', 'normal', 'chatty'] as ChattinessLevel[]) {
      const snippet = renderChattinessSnippet(level);
      expect(snippet).toContain(`**${level}**`);
      expect(snippet).not.toContain('{{CHATTINESS_LEVEL}}');
      expect(snippet.toLowerCase()).toContain('one rung');
      expect(snippet.toLowerCase()).toContain('elastic');
    }
  });
});

describe('agent system prompt assembly', () => {
  // INVARIANT: The verbosity snippet lands at the very TOP of the agent system
  // prompt (before the tool instructions) so it gets the model's attention early.
  test('places the snippet at the top of the prompt when set', () => {
    const snippet = renderChattinessSnippet('terse');
    const prompt = buildSystemPrompt('RUNNER', snippet);
    expect(prompt.startsWith(snippet)).toBe(true);
    expect(prompt.indexOf('Response verbosity')).toBeLessThan(prompt.indexOf('RUNNER'));
  });

  // INVARIANT: Without a snippet, the prompt is unchanged from the no-chattiness
  // baseline (no leading verbosity block).
  test('injects nothing when snippet is empty', () => {
    const withEmpty = buildSystemPrompt('RUNNER', '');
    const without = buildSystemPrompt('RUNNER');
    expect(withEmpty).toBe(without);
    expect(withEmpty).not.toContain('Response verbosity');
  });
});

describe('builder system prompt template', () => {
  // INVARIANT: The {{CHATTINESS}} placeholder sits near the top of the builder
  // prompt — before the first major section — so the injected snippet is early.
  test('placeholder appears before the first "## Core principle" section', () => {
    const placeholderIdx = builderSystemPrompt.indexOf('{{CHATTINESS}}');
    const corePrincipleIdx = builderSystemPrompt.indexOf('## Core principle');
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeLessThan(corePrincipleIdx);
  });
});
