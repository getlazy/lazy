import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import { resolveAgentModel } from '../../src/agent/agent-model';
import { getAgent, listAgents } from '../../src/agent/registry';

/**
 * Build a minimal ResolvedConfig carrying only the fields the resolver reads.
 * Model resolution only touches config.models, so the rest is unused here.
 */
function configWith(
  roles: { builder: RoleTarget; agent: RoleTarget },
  dflt = 'claude-opus-4-8',
  /**
   * `[agents.<name>]` blocks, for the cases where a task NAMES a profile: since
   * profiles, `agentId` is a profile name, and the resolver reads the block to
   * find that profile's own model and upstream. Omitted by every case that only
   * needs the role default.
   */
  agents?: Record<string, { harness?: string; model?: string; endpoint?: string; credential?: string }>,
): ResolvedConfig {
  return { models: { default: dflt, roles }, ...(agents ? { agents } : {}) } as unknown as ResolvedConfig;
}

const anthropic = (model = ''): RoleTarget => ({ ...ANTHROPIC_DEFAULT_TARGET, model });
/** A profile pinned to a local Ollama box — the successor to `backend = "ollama"`. */
const ollama = (model: string, endpoint = 'http://host.docker.internal:11434'): RoleTarget => ({
  profile: 'local-ollama',
  harness: 'claude-code',
  model,
  endpoint,
  pinned: true,
  wire: 'anthropic',
  credential: 'none',
});

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

  // Fable 5.1 (`claude-fable-5-1`) is a concrete Anthropic id. Launch-time
  // resolution must pass it through — both as a task model and as an
  // explicit override — so a task pinned to 5.1 does not collapse to the `fable`
  // short alias (which Claude Code may still resolve to Fable 5).
  test('passes claude-fable-5-1 through as preferred and override model', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'claude-opus-4-8');
    expect(resolveAgentModel(config, { preferredModel: 'claude-fable-5-1' })).toBe('claude-fable-5-1');
    expect(resolveAgentModel(config, { overrideModel: 'claude-fable-5-1' })).toBe('claude-fable-5-1');
    expect(resolveAgentModel(config, { agentId: 'claude-code', preferredModel: 'claude-fable-5-1' })).toBe('claude-fable-5-1');
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
  // model (lazy start --model, task.model) still wins.
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
  // must not stomp it any more than a task model may — the local server
  // serves exactly the configured model and nothing else.
  //
  // Asserted through the profile the task NAMES, and through the role default
  // for a task that names none. Both were once written as `agentId:
  // 'claude-code'` over a pinned ROLE, which predates profiles: `agentId` was a
  // harness hint then and is a profile name now, so that pairing says "run the
  // built-in claude-code profile" — which has no endpoint and goes to
  // Anthropic. Keeping the pinned model there would send an Ollama model name
  // to Anthropic, which is the 404 this release stopped shipping (see the case
  // below).
  test('a pinned ollama model still wins over the agent-declared default', () => {
    const config = configWith(
      { builder: anthropic(), agent: ollama('qwen3-coder') },
      'opus',
      { 'local-ollama': { harness: 'claude-code', model: 'qwen3-coder', endpoint: 'http://localhost:11434' } },
    );
    // Named by the task…
    expect(resolveAgentModel(config, { agentId: 'local-ollama' })).toBe('qwen3-coder');
    // …and inherited from the role by a task that named no agent.
    expect(resolveAgentModel(config, {})).toBe('qwen3-coder');
  });

  test('a pinned gateway model still wins over the agent-declared default', () => {
    const proxy: RoleTarget = {
      profile: 'gateway', harness: 'claude-code', model: 'local-llm',
      endpoint: 'http://127.0.0.1:9000', pinned: true, wire: 'anthropic', credential: 'anthropic',
    };
    const config = configWith(
      { builder: anthropic(), agent: proxy },
      'opus',
      { gateway: { harness: 'claude-code', model: 'local-llm', endpoint: 'http://127.0.0.1:9000' } },
    );
    expect(resolveAgentModel(config, { agentId: 'gateway' })).toBe('local-llm');
    expect(resolveAgentModel(config, {})).toBe('local-llm');
  });

  // INVARIANT: a task that NAMES a profile is resolved against that profile,
  // not against the role's default one — `[models.roles.agent]` is the fallback
  // for a task that named none. Taking the role default's model here would hand
  // this task a model from an upstream it is not going to: the built-in
  // claude-code profile has no endpoint, so its traffic goes to Anthropic, and
  // `qwen3-coder` there is a 404 no retry can fix.
  test('naming a profile takes THAT profile\'s chain, not the role default\'s model', () => {
    const config = configWith(
      { builder: anthropic(), agent: ollama('qwen3-coder') },
      'opus',
      { 'local-ollama': { harness: 'claude-code', model: 'qwen3-coder', endpoint: 'http://localhost:11434' } },
    );
    expect(resolveAgentModel(config, { agentId: 'claude-code' })).toBe('opus');
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

  // INVARIANT (fix-cursor-model-turn-setting): the project-settings overlay
  // stands in for [models] default — it does NOT ride in the per-task slot.
  // Both are one project-wide name, in practice an Anthropic one, so folding
  // either into `preferredModel` pre-empts the agent's own declared default.
  // That is precisely how a fresh Cursor task launched on this repo's `opus`
  // and stopped at Cursor's Opus usage cap.
  test("the project overlay does not pre-empt Cursor's declared default", () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'cursor', projectModel: 'sonnet' })).toBe('auto');
  });

  test('the project overlay replaces models.default for an agent with no opinion', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { agentId: 'claude-code', projectModel: 'sonnet' })).toBe('sonnet');
    expect(resolveAgentModel(config, { projectModel: 'sonnet' })).toBe('sonnet');
  });

  // A blank/absent overlay is not an override — same rule resolveProjectModel
  // enforces on its own side, restated here so the slot cannot resolve to ''.
  test('a blank project overlay falls through to models.default', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { projectModel: '' })).toBe('opus');
    expect(resolveAgentModel(config, { projectModel: '   ' })).toBe('opus');
    expect(resolveAgentModel(config, { projectModel: null })).toBe('opus');
  });

  test('a per-task model still outranks the project overlay', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() }, 'opus');
    expect(resolveAgentModel(config, { preferredModel: 'haiku', projectModel: 'sonnet' })).toBe('haiku');
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
