import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig } from '../../src/config/types';
import type { ProjectSettings } from '../../src/storage/types';
import {
  resolveProjectModel,
  resolveProjectAgent,
  effectiveProjectSettings,
} from '../../src/daemon/project-settings';

/**
 * Minimal ResolvedConfig carrying only the fields these functions read.
 */
function configWith(opts: {
  model?: string;
  runner?: string;
  effort?: string;
  agent?: string;
  agents?: Record<string, { harness?: string; model?: string; endpoint?: string; credential?: string }>;
} = {}): ResolvedConfig {
  return {
    models: { default: opts.model ?? 'claude-opus-4-8', roles: {} },
    runner: { type: opts.runner ?? 'docker' },
    agent: { agent_id: opts.agent ?? 'claude-code', effort: opts.effort ?? 'medium' },
    agents: opts.agents ?? {},
  } as unknown as ResolvedConfig;
}

describe('resolveProjectModel', () => {
  // INVARIANT: the overlay is the deployment's override of the repository's
  // stated default (docs/design/lazy-teams.md §11). lazy.toml is NEVER written
  // to record a UI change, so the ONLY way the two can disagree is this
  // precedence rule — if it inverts, a settings page silently does nothing.
  test('the project setting outranks lazy.toml [models] default', () => {
    const settings: ProjectSettings = { defaultModel: 'claude-haiku-4-5-20251001' };
    expect(resolveProjectModel(settings, configWith({ model: 'claude-opus-4-8' })))
      .toBe('claude-haiku-4-5-20251001');
  });

  test('lazy.toml wins when no override is set', () => {
    expect(resolveProjectModel(null, configWith({ model: 'sonnet' }))).toBe('sonnet');
    expect(resolveProjectModel({}, configWith({ model: 'sonnet' }))).toBe('sonnet');
  });

  // INVARIANT: an omitted key and an empty string both mean "no override".
  // The write path normalizes empty to omitted, but a store written by an
  // older build (or by hand) must not be read as "override with the empty
  // model name", which would resolve to a model that does not exist.
  test('an empty override string is not an override', () => {
    expect(resolveProjectModel({ defaultModel: '' }, configWith({ model: 'sonnet' }))).toBe('sonnet');
  });

  test('returns undefined when neither source has an opinion', () => {
    // Undefined, not '' — the caller passes this to resolveAgentModel as
    // preferredModel, where undefined means "fall through to your own chain"
    // and '' would be a falsy value that reads the same but says less.
    expect(resolveProjectModel(null, configWith({ model: '' }))).toBeUndefined();
  });
});

describe('resolveProjectAgent', () => {
  test('the project setting outranks lazy.toml [agent] agent_id', () => {
    const settings: ProjectSettings = { defaultAgent: 'cursor' };
    expect(resolveProjectAgent(settings, configWith({ agent: 'claude-code' }))).toBe('cursor');
  });

  test('lazy.toml wins when no override is set', () => {
    expect(resolveProjectAgent(null, configWith({ agent: 'cursor' }))).toBe('cursor');
    expect(resolveProjectAgent({}, configWith({ agent: 'cursor' }))).toBe('cursor');
  });

  test('an empty override string is not an override', () => {
    expect(resolveProjectAgent({ defaultAgent: '' }, configWith({ agent: 'cursor' }))).toBe('cursor');
  });
});

describe('effectiveProjectSettings', () => {
  // INVARIANT: design §11.2 rule 2 — every read carries BOTH values and which
  // one won. A settings page that can only show the winner cannot tell a user
  // why their repository's lazy.toml appears to be ignored.
  test('reports the repository value alongside an active override', () => {
    const result = effectiveProjectSettings(
      { defaultModel: 'sonnet', defaultAgent: 'cursor' },
      configWith({ model: 'claude-opus-4-8', agent: 'claude-code' }),
    );
    expect(result.defaultModel.value).toBe('sonnet');
    expect(result.defaultModel.repositoryValue).toBe('claude-opus-4-8');
    expect(result.defaultModel.source).toBe('project-setting');
    expect(result.defaultAgent.value).toBe('cursor');
    expect(result.defaultAgent.repositoryValue).toBe('claude-code');
    expect(result.defaultAgent.source).toBe('project-setting');
  });

  test('reports the repository as the source when nothing overrides it', () => {
    const result = effectiveProjectSettings(null, configWith({ model: 'claude-opus-4-8' }));
    expect(result.defaultModel.value).toBe('claude-opus-4-8');
    expect(result.defaultModel.repositoryValue).toBe('claude-opus-4-8');
    expect(result.defaultModel.source).toBe('repository');
  });

  // INVARIANT: display-only settings are marked as such rather than omitted.
  // The page renders the whole operational picture; `editable` is what stops
  // it offering a form for a key the overlay cannot yet carry (design §11.4).
  test('runner type and effort are reported but not editable', () => {
    const result = effectiveProjectSettings(null, configWith({ runner: 'docker', effort: 'high' }));
    expect(result.runnerType.value).toBe('docker');
    expect(result.runnerType.editable).toBe(false);
    expect(result.agentEffort.value).toBe('high');
    expect(result.agentEffort.editable).toBe(false);
    expect(result.defaultModel.editable).toBe(true);
    expect(result.defaultAgent.editable).toBe(true);
  });

  // INVARIANT: a remote client cannot read lazy.toml, so the agents a project
  // can run have to travel with the settings read. Without this a browser
  // client can only offer a hardcoded list of harness names — a second copy of
  // lazy's agent vocabulary that hides every profile the project configured.
  test('reports the project\'s own agent profiles ahead of the built-ins', () => {
    const result = effectiveProjectSettings(null, configWith({
      agents: { 'work-opus': { harness: 'claude-code', model: 'claude-opus-5' } },
    }));
    const names = result.agentProfiles.map((p) => p.name);
    expect(names[0]).toBe('work-opus');
    expect(names).toContain('claude-code');
    expect(result.agentProfiles[0]).toMatchObject({
      name: 'work-opus',
      harness: 'claude-code',
      model: 'claude-opus-5',
      builtin: false,
    });
  });

  // INVARIANT: a profile's endpoint and the credential that pays for it are
  // operator configuration, not a choice in a task form — and nothing that
  // merely describes auth should cross the wire (the line
  // handleGetCredentialState draws). The picker shape carries neither.
  test('never carries a profile\'s endpoint or credential', () => {
    const result = effectiveProjectSettings(null, configWith({
      agents: {
        local: {
          harness: 'codex',
          model: 'qwen3.8:latest',
          endpoint: 'http://127.0.0.1:11434',
          credential: 'work-openai',
        },
      },
    }));
    const local = result.agentProfiles.find((p) => p.name === 'local');
    expect(local).toBeDefined();
    expect(Object.keys(local!).sort()).toEqual(['builtin', 'harness', 'model', 'name']);
  });

  // INVARIANT: lazy's own picker hides internal agents (qa-agent), and a remote
  // picker offering one would launch an agent no human should be choosing.
  test('excludes lazy\'s internal agents, as the daemon\'s own picker does', () => {
    const result = effectiveProjectSettings(null, configWith());
    expect(result.agentProfiles.map((p) => p.name)).not.toContain('qa-agent');
  });

  test('carries overlay metadata when present, omits it when not', () => {
    const withMeta = effectiveProjectSettings(
      { defaultModel: 'sonnet', updatedAt: '2026-08-15T00:00:00.000Z', updatedBy: 'human' },
      configWith(),
    );
    expect(withMeta.updatedAt).toBe('2026-08-15T00:00:00.000Z');
    expect(withMeta.updatedBy).toBe('human');

    const withoutMeta = effectiveProjectSettings(null, configWith());
    expect(withoutMeta.updatedAt).toBeUndefined();
    expect(withoutMeta.updatedBy).toBeUndefined();
  });
});
