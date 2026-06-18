import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import {
  resolveRoleTarget,
  resolveAgentModel,
  targetEnvVars,
  checkTargetConnectivity,
  preflightRoleTarget,
  isKnownAnthropicModel,
} from '../../src/utils/role-target';

/**
 * Build a minimal ResolvedConfig carrying only the fields resolveRoleTarget reads.
 * The role-target resolver only touches config.models, so the rest is unused here.
 */
function configWith(roles: { builder: RoleTarget; agent: RoleTarget }, dflt = 'claude-opus-4-8'): ResolvedConfig {
  return { models: { default: dflt, roles } } as unknown as ResolvedConfig;
}

const anthropic = (model = ''): RoleTarget => ({ backend: 'anthropic', model, endpoint: '' });
const ollama = (model: string, endpoint = 'http://host.docker.internal:11434'): RoleTarget => ({ backend: 'ollama', model, endpoint });

describe('resolveRoleTarget', () => {
  test('anthropic role honors the caller preferred model', () => {
    const config = configWith({ builder: anthropic(), agent: anthropic() });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-haiku-4-5-20251001' });
    expect(r.backend).toBe('anthropic');
    expect(r.model).toBe('claude-haiku-4-5-20251001');
  });

  test('anthropic role with no preferred model falls back to the configured model', () => {
    const config = configWith({ builder: anthropic('claude-opus-4-8'), agent: anthropic() });
    expect(resolveRoleTarget('builder', config).model).toBe('claude-opus-4-8');
  });

  // INVARIANT: For a local backend (ollama/proxy) the configured model is
  // authoritative and a caller's preferred alias (e.g. "claude-opus-4-8") is
  // intentionally ignored — that name does not exist in the local registry.
  test('ollama role ignores the preferred model and uses the configured one', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8' });
    expect(r.backend).toBe('ollama');
    expect(r.model).toBe('qwen3-coder');
    expect(r.endpoint).toBe('http://host.docker.internal:11434');
  });

  // INVARIANT: Local backends only work through Claude Code. Any other agent
  // forces the anthropic path rather than passing a local model name to a
  // backend that can't serve it.
  test('non-claude agent forces anthropic even when the role is ollama', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8', agentId: 'qa-agent' });
    expect(r.backend).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-8');
  });

  // INVARIANT: No silent name substitution — a hand-built ollama target with no
  // model throws rather than guessing a default.
  test('throws on an ollama role with no model', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('') });
    expect(() => resolveRoleTarget('agent', config)).toThrow(/No model configured/);
  });

  // INVARIANT (fix-builder-model-ollama-precedence): an EXPLICIT override (e.g.
  // `lazy builder --model X`) wins over the configured model on a local backend,
  // while the backend + endpoint (the "server") stay as configured. This makes a
  // local [models.roles.*] entry effectively *server* configuration — its model
  // is just a default the explicit flag overrides. Contrast the soft
  // preferredModel above, which an ollama role intentionally ignores.
  test('ollama role: overrideModel wins over the configured model but keeps the server', () => {
    const config = configWith({ builder: ollama('ollama-local-model'), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { overrideModel: 'mythos' });
    expect(r.backend).toBe('ollama');
    expect(r.model).toBe('mythos');
    expect(r.endpoint).toBe('http://host.docker.internal:11434');
  });

  // INVARIANT: a hard override beats the soft preferredModel on every backend.
  test('overrideModel takes precedence over preferredModel (anthropic)', () => {
    const config = configWith({ builder: anthropic('claude-opus-4-8'), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { preferredModel: 'claude-haiku-4-5-20251001', overrideModel: 'mythos' });
    expect(r.backend).toBe('anthropic');
    expect(r.model).toBe('mythos');
  });

  // INVARIANT: an explicit override satisfies the "no model configured" guard for
  // a local backend — server pinned in config, model supplied by the flag.
  test('overrideModel supplies the model for an ollama role with no configured model', () => {
    const config = configWith({ builder: ollama(''), agent: anthropic() });
    const r = resolveRoleTarget('builder', config, { overrideModel: 'mythos' });
    expect(r.backend).toBe('ollama');
    expect(r.model).toBe('mythos');
  });

  // INVARIANT: the soft preferredModel must NEVER override an authoritative local
  // model — otherwise an opus-defaulted agent task would break every ollama
  // launch. Only the explicit overrideModel may.
  test('ollama role still ignores preferredModel (only overrideModel wins)', () => {
    const config = configWith({ builder: anthropic(), agent: ollama('qwen3-coder') });
    const r = resolveRoleTarget('agent', config, { preferredModel: 'claude-opus-4-8' });
    expect(r.model).toBe('qwen3-coder');
  });
});

describe('isKnownAnthropicModel', () => {
  // INVARIANT (fix-builder-model-ollama-precedence): any `claude-*` id is the
  // escape hatch for models newer than our short-name list, so it's always
  // recognized without a hard-coded entry.
  test('recognizes any claude-* id (escape hatch for future models)', () => {
    expect(isKnownAnthropicModel('claude-opus-4-8')).toBe(true);
    expect(isKnownAnthropicModel('claude-something-not-shipped-yet')).toBe(true);
  });

  // INVARIANT: the known short aliases are recognized so users can pass them.
  test('recognizes the known short names', () => {
    for (const name of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) {
      expect(isKnownAnthropicModel(name)).toBe(true);
    }
    expect(isKnownAnthropicModel('OPUS')).toBe(true); // case-insensitive
  });

  // INVARIANT: an arbitrary (e.g. local) model name is NOT an Anthropic model —
  // it needs a configured local server, so it's rejected against the anthropic backend.
  test('rejects arbitrary / local model names', () => {
    expect(isKnownAnthropicModel('qwen3-coder')).toBe(false);
    expect(isKnownAnthropicModel('llama3')).toBe(false);
    expect(isKnownAnthropicModel('gpt-4o')).toBe(false);
  });
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
});

describe('targetEnvVars', () => {
  test('ollama uses self-contained dummy credentials + base URL + stability flags', () => {
    const env = targetEnvVars(ollama('qwen3-coder', 'http://localhost:11434'), []);
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(map.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(map.DISABLE_TELEMETRY).toBe('1');
  });

  test('proxy forwards the real credential alongside the base URL', () => {
    const env = targetEnvVars(
      { backend: 'proxy', model: 'claude-opus-4-8', endpoint: 'http://localhost:8080' },
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-real' }],
    );
    const map = Object.fromEntries(env.map(v => [v.key, v.value]));
    expect(map.ANTHROPIC_BASE_URL).toBe('http://localhost:8080');
    expect(map.ANTHROPIC_API_KEY).toBe('sk-real');
  });

  test('anthropic passes the credential through unchanged', () => {
    const env = targetEnvVars(anthropic('claude-opus-4-8'), [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }]);
    expect(env).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' }]);
  });
});

describe('connectivity preflight', () => {
  // Anthropic reachability is the credential gate's job, not the network probe's.
  test('anthropic targets are always reported reachable', async () => {
    const check = await checkTargetConnectivity(anthropic('claude-opus-4-8'));
    expect(check.reachable).toBe(true);
  });

  test('anthropic preflight never throws', async () => {
    await preflightRoleTarget('agent', anthropic('claude-opus-4-8'));
  });

  // INVARIANT: An unreachable local backend fails hard with an actionable error —
  // lazy must NEVER silently fall back to a different backend.
  test('preflight throws an actionable error for an unreachable ollama backend', async () => {
    // Port 1 is reserved/unused, so the probe fails fast with a connection error.
    const target: RoleTarget = { backend: 'ollama', model: 'qwen3-coder', endpoint: 'http://127.0.0.1:1' };
    await expect(preflightRoleTarget('agent', target)).rejects.toThrow(/Preflight failed for the "agent" role/);
  });
});
