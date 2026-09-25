/**
 * `requiredCredentials` — the DIAGNOSTIC twin of the daemon gate's
 * `requiredProviders`.
 *
 * INVARIANT: the two read the SAME per-profile answer (a profile's resolved
 * `credential` slot, never re-derived from its endpoint) over DIFFERENT scopes,
 * and the difference is deliberate:
 *
 *  - the gate reads the two ROLE DEFAULTS, because refusing to start a daemon
 *    over a profile nothing has selected would make declaring one a breaking
 *    change;
 *  - the report reads every profile the configuration REFERENCES — role
 *    defaults, `[agent.by_type]` selections and every `[agents.<name>]` block —
 *    because a task that selects such a profile refuses to launch without its
 *    credential, and `lazy doctor` is where a user should learn that first.
 *
 * Built-in profiles nothing names are NOT requirements: they exist implicitly
 * for every project, so counting them would have a plain claude-code project
 * "require" OpenAI and Cursor keys.
 */

import { describe, test, expect } from 'bun:test';
import {
  defaultRequiredCredentials,
  requiredCredentials,
  requiredProviders,
} from '../../src/credentials/providers';
import {
  NO_CREDENTIAL,
  cacheAgentProfiles,
  resolveAgentProfiles,
  type AgentProfileConfig,
} from '../../src/config/agent-profiles';
import { roleTargetForProfile } from '../../src/config/default-target';
import type { ResolvedConfig } from '../../src/config/types';

/**
 * A ResolvedConfig stub with the fields the two resolutions read: the raw
 * `[agents]` table (cached against its resolved profiles, as the loader does),
 * the role defaults flattened from those profiles, and `[agent.by_type]`.
 */
function configWith(
  agents: Record<string, AgentProfileConfig>,
  roles: { builder?: string; agent?: string } = {},
  byType: Record<string, string> = {},
): ResolvedConfig {
  const profiles = resolveAgentProfiles(agents, () => {});
  cacheAgentProfiles(agents, profiles);
  const target = (name: string) => {
    const profile = profiles.get(name);
    if (!profile) throw new Error(`test fixture names no profile "${name}"`);
    return roleTargetForProfile(profile);
  };
  return {
    models: {
      roles: {
        builder: target(roles.builder ?? 'claude-code'),
        agent: target(roles.agent ?? 'claude-code'),
      },
    },
    agents,
    agent: { agent_id: roles.agent ?? 'claude-code', by_type: byType },
  } as unknown as ResolvedConfig;
}

const LOCAL_CLAUDE: AgentProfileConfig = {
  harness: 'claude-code', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434',
};
const OPENROUTER_CODEX: AgentProfileConfig = {
  harness: 'codex', model: 'gpt-5-codex', endpoint: 'https://openrouter.ai/api/v1',
};

describe('requiredCredentials', () => {
  test('a plain project requires anthropic, for the claude-code default', () => {
    const config = configWith({});
    expect(requiredCredentials(config)).toEqual([{ name: 'anthropic', requiredBy: ['claude-code'] }]);
    // Same answer as the gate here: nothing but the role defaults is configured.
    expect(requiredProviders(config)).toEqual(['anthropic']);
  });

  // INVARIANT: implicit built-ins are not requirements. A default project must
  // not be told it is missing OpenAI (built-in codex) or Cursor (built-in cursor).
  test('built-in profiles nothing references are not requirements', () => {
    const names = requiredCredentials(configWith({})).map((r) => r.name);
    expect(names).not.toContain('openai');
    expect(names).not.toContain('cursor');
  });

  // THE DELIBERATE DIFFERENCE from the gate, asserted side by side.
  test('a declared profile is a requirement even when no role defaults to it', () => {
    const config = configWith({ 'openrouter-codex': OPENROUTER_CODEX });
    expect(requiredCredentials(config)).toEqual([
      { name: 'anthropic', requiredBy: ['claude-code'] },
      { name: 'openrouter', requiredBy: ['openrouter-codex'] },
    ]);
    // ...while the daemon gate still starts without the OpenRouter key.
    expect(requiredProviders(config)).toEqual(['anthropic']);
  });

  test('a profile selected by [agent.by_type] is a requirement', () => {
    // `codex` is a built-in nothing else references; by_type selecting it is
    // what makes it configured.
    const config = configWith({}, {}, { fix: 'codex' });
    expect(requiredCredentials(config)).toEqual([
      { name: 'anthropic', requiredBy: ['claude-code'] },
      { name: 'openai', requiredBy: ['codex'] },
    ]);
  });

  // INVARIANT: `none` is not a credential — nothing can be present for it.
  test('a project whose configured profiles all use local upstreams requires nothing', () => {
    const config = configWith({ 'claude-code': LOCAL_CLAUDE });
    expect(config.models.roles.agent.credential).toBe(NO_CREDENTIAL);
    expect(requiredCredentials(config)).toEqual([]);
    expect(requiredProviders(config)).toEqual([]);
  });

  // INVARIANT: cursor is excluded from the GATE (a missing key must not refuse
  // a daemon to every non-Cursor task) but included in the REPORT — the reason
  // is about refusing, not about telling the user.
  test('cursor is reported as a requirement although the gate skips it', () => {
    const config = configWith({}, {}, { fix: 'cursor' });
    expect(requiredCredentials(config).map((r) => r.name)).toEqual(['anthropic', 'cursor']);
    expect(requiredProviders(config)).toEqual(['anthropic']);
  });

  test('a named credential appears under its own name', () => {
    const config = configWith({
      'work-codex': { harness: 'codex', model: 'gpt-5-codex', credential: 'work-openai' },
    });
    expect(requiredCredentials(config)).toContainEqual({ name: 'work-openai', requiredBy: ['work-codex'] });
  });

  test('profiles sharing a credential collapse into one entry naming both, sorted', () => {
    const config = configWith({
      'zeta-codex': { harness: 'codex', model: 'gpt-5-codex' },
      'alpha-codex': { harness: 'codex', model: 'gpt-5.2' },
    });
    expect(requiredCredentials(config)).toContainEqual({ name: 'openai', requiredBy: ['alpha-codex', 'zeta-codex'] });
  });

  test('a role default that is also declared is listed once', () => {
    const config = configWith({ 'openrouter-codex': OPENROUTER_CODEX }, { agent: 'openrouter-codex' });
    expect(requiredCredentials(config)).toEqual([
      { name: 'anthropic', requiredBy: ['claude-code'] },
      { name: 'openrouter', requiredBy: ['openrouter-codex'] },
    ]);
  });

  // Same order `lazy auth list` prints: providers in their declared order, then
  // user-chosen names alphabetically — so the two surfaces read alike.
  test('providers come first in their declared order, then named credentials alphabetically', () => {
    const config = configWith({
      'zeta': { harness: 'codex', model: 'x', credential: 'zeta-key' },
      'alpha': { harness: 'codex', model: 'x', credential: 'alpha-key' },
      'router': OPENROUTER_CODEX,
      'plain-codex': { harness: 'codex', model: 'x' },
    });
    expect(requiredCredentials(config).map((r) => r.name))
      .toEqual(['anthropic', 'openai', 'openrouter', 'alpha-key', 'zeta-key']);
  });
});

describe('defaultRequiredCredentials', () => {
  // What `lazy doctor` checks when lazy.toml will not load: the built-in
  // defaults both roles fall back to, which bill Anthropic.
  test('is the built-in claude-code default, billing anthropic', () => {
    expect(defaultRequiredCredentials()).toEqual([{ name: 'anthropic', requiredBy: ['claude-code'] }]);
  });
});
