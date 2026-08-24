import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { resolveAgentModel } from '../../src/agent/agent-model';
import { getAgent, listAgents } from '../../src/agent/registry';

/**
 * Build a minimal ResolvedConfig carrying only the fields the resolver reads.
 * Model resolution only touches config.models, so the rest is unused here.
 */
function configWith(roles: { builder: RoleTarget; agent: RoleTarget }, dflt = 'claude-opus-4-8'): ResolvedConfig {
  return { models: { default: dflt, roles } } as unknown as ResolvedConfig;
}

const anthropic = (model = ''): RoleTarget => ({ backend: 'anthropic', model, endpoint: '' });
const ollama = (model: string, endpoint = 'http://host.docker.internal:11434'): RoleTarget => ({ backend: 'ollama', model, endpoint });

describe('resolveAgentModel', () => {
  test('falls back to models.default for an anthropic role with nothing set', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'claude-opus-4-8');
    expect(resolveAgentModel(config)).toBe('claude-opus-4-8');
  });

  test('returns the ollama model for an ollama agent role', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    expect(resolveAgentModel(config)).toBe('qwen3-coder');
  });

  test('accepts a null preferred model (task.model may be null)', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'claude-opus-4-8');
    expect(resolveAgentModel(config, { preferredModel: null })).toBe('claude-opus-4-8');
  });

  // INVARIANT: an agent may declare its own default model, and it outranks
  // [models] default. `opus` is an Anthropic name chosen for Claude Code; a
  // Cursor task has no business inheriting it (that is what walled a real user
  // into a plan limit). Cursor's own sensible default is "let Cursor choose".
  test("a Cursor task with nothing set gets Cursor's declared default, not models.default", () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'cursor' })).toBe('auto');
  });

  // INVARIANT: the agent-declared default is a DEFAULT — an explicit per-task
  // model (lazy start --model, sticky model, task.model) still wins.
  test('an explicit model still overrides the agent-declared default', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'cursor', preferredModel: 'gpt-5' })).toBe('gpt-5');
    expect(resolveAgentModel(config, { agentId: 'cursor', overrideModel: 'gpt-5' })).toBe('gpt-5');
  });

  // Claude Code declares no default (null), so config keeps deciding — the
  // agent-declared default must not change any existing Claude Code behavior.
  test('Claude Code tasks are unchanged by the agent-declared default', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'claude-code' })).toBe('opus');
    expect(resolveAgentModel(config, { agentId: 'claude-code', preferredModel: 'sonnet' })).toBe('sonnet');
    expect(resolveAgentModel(config, {})).toBe('opus');
  });

  // INVARIANT: a pinned local model is authoritative. An agent-declared default
  // must not stomp it any more than a task/sticky model may — the local server
  // serves exactly the configured model and nothing else.
  test('a pinned ollama model still wins over the agent-declared default', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'claude-code' })).toBe('qwen3-coder');
  });

  test('a pinned proxy model still wins over the agent-declared default', () => {
    const proxy: RoleTarget = { backend: 'proxy', model: 'local-llm', endpoint: 'http://127.0.0.1:9000' };
    const config = configWith({ builder: anthropic(), agent: proxy }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'claude-code' })).toBe('local-llm');
  });

  // Cursor cannot talk to a local backend at all (resolveRoleTarget forces the
  // anthropic path for non-claude-code agents), so its own default applies
  // rather than the local model name — which would be meaningless to Cursor.
  test("a Cursor task under an ollama role falls back to Cursor's default, not the ollama model", () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'cursor' })).toBe('auto');
  });

  test('an unknown agent id falls through to models.default', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'not-a-real-agent' })).toBe('opus');
  });

  // INVARIANT: "no default" is spelled `null`, never `''`. The empty string is
  // not a second way to say it — resolveAgentModel throws on one rather than
  // guessing which answer a blank meant, so every agent must pick a side.
  test('every registered agent declares null or a non-blank model, never a blank string', () => {
    for (const agentId of listAgents()) {
      const declared = getAgent(agentId).defaultModel();
      if (declared === null) continue;
      expect(typeof declared).toBe('string');
      expect(declared.trim()).not.toBe('');
    }
  });
});
