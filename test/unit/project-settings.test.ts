import { CODEX_LATEST_MODEL } from '../../src/config/default-models';
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
  agents?: Record<string, { harness?: string; model?: string; endpoint?: string; credential?: string; description?: string }>;
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

  // INVARIANT: the daemon ANSWERS each profile's `description` (when to use
  // it), so every client renders it without reading lazy.toml; a built-in
  // carries lazy's own.
  test('reports each profile\'s description, a built-in\'s included', () => {
    const result = effectiveProjectSettings(null, configWith({
      agents: { security: { harness: 'claude-code', description: 'Use whenever a security aspect comes up.' } },
    }));
    const byName = new Map(result.agentProfiles.map((p) => [p.name, p]));
    expect(byName.get('security')!.description).toBe('Use whenever a security aspect comes up.');
    expect(byName.get('claude-code')!.description).not.toBe('');
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
    expect(Object.keys(local!).sort()).toEqual(['builtin', 'description', 'harness', 'model', 'name']);
  });

  // INVARIANT: lazy's own picker hides internal agents (qa-agent), and a remote
  // picker offering one would launch an agent no human should be choosing.
  test('excludes lazy\'s internal agents, as the daemon\'s own picker does', () => {
    const result = effectiveProjectSettings(null, configWith());
    expect(result.agentProfiles.map((p) => p.name)).not.toContain('qa-agent');
  });

  // INVARIANT: the model a task runs when its Model field is left empty follows
  // the chosen PROFILE — its own model, else its harness's default, else the
  // project default — and remote forms read that answer rather than re-deriving
  // it. A form that showed the project default next to a codex profile named a
  // model the task would never run.
  test('reports each profile\'s own default model', () => {
    const result = effectiveProjectSettings(
      { defaultModel: 'claude-sonnet-5' },
      configWith({ agents: { 'work-opus': { harness: 'claude-code', model: 'claude-opus-5' } } }),
    );
    expect(result.agentDefaultModels['work-opus']).toBe('claude-opus-5');
    expect(result.agentDefaultModels['claude-code']).toBe('claude-sonnet-5');
  });

  // INVARIANT: a profile whose model is its harness's "pick it yourself"
  // placeholder (codex `default`, cursor `auto`) is reported as such, never as
  // the placeholder id — "this agent's default (default)" is what the form
  // showed for a codex profile otherwise.
  test('a profile whose harness picks its own model is flagged, not named', () => {
    const result = effectiveProjectSettings(null, configWith({ agents: {
      'codex-sub': { harness: 'codex', model: 'default' },
      'cursor-auto': { harness: 'cursor', model: 'auto' },
    } }));
    expect(result.agentHarnessChoosesModel).toContain('codex-sub');
    expect(result.agentHarnessChoosesModel).toContain('cursor-auto');
    expect(result.agentDefaultModels['codex-sub']).toBeUndefined();
    expect(result.agentDefaultModels['cursor-auto']).toBeUndefined();
  });

  // The "let the tool pick" names are per harness: Codex passes `auto` through
  // as `-m auto`, so a Codex profile pinned to it is a named model, not a pick.
  test('a codex profile pinned to auto is named, not flagged', () => {
    const result = effectiveProjectSettings(null, configWith({ agents: { 'codex-auto': { harness: 'codex', model: 'auto' } } }));
    expect(result.agentHarnessChoosesModel).not.toContain('codex-auto');
    expect(result.agentDefaultModels['codex-auto']).toBe('auto');
  });

  // Codex declares a concrete default id, so a profile that leaves Model
  // empty names that id rather than claiming the harness chooses.
  test('a harness declared default is named', () => {
    const result = effectiveProjectSettings(null, configWith({ agents: { 'codex-plain': { harness: 'codex' } } }));
    expect(result.agentDefaultModels['codex-plain']).toBe(CODEX_LATEST_MODEL);
  });

  // INVARIANT: Cursor's own default is `auto`, so an unpinned Cursor profile
  // is reported as "Cursor chooses". Cursor's catalog is server-side and per
  // plan; a hard-coded id (grok-4) failed every unpinned Cursor task.
  test('an unpinned Cursor profile is reported as Cursor chooses', () => {
    const result = effectiveProjectSettings(null, configWith());
    expect(result.agentHarnessChoosesModel).toContain('cursor');
    expect(result.agentDefaultModels['cursor']).toBeUndefined();
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
