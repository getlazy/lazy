import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveAgentProfiles } from '../../src/config/agent-profiles';
import { BUILDER_DEFAULT_MODEL, CLAUDE_DEFAULT_MODEL } from '../../src/config/default-models';
import { resolveBuilderModel } from '../../src/agent/agent-model';
import { DEFAULT_CONFIG } from '../../src/config/loader';

const ROOT = join(import.meta.dir, '..', '..');

/** The commented tier blocks in lazy.toml.example, uncommented and parsed. */
async function tierProfiles(): Promise<Record<string, Record<string, string>>> {
  const example = await readFile(join(ROOT, 'lazy.toml.example'), 'utf-8');
  const start = example.indexOf('# ---- Spreading work across models by tier ----');
  const end = example.indexOf('# Codex blocks run on the metered OpenAI key', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = example.slice(start, end).split('\n')
    .filter(line => /^# (\[agents\.|harness|model|description)/.test(line))
    .map(line => line.slice(2))
    .join('\n');
  return (Bun.TOML.parse(body) as { agents: Record<string, Record<string, string>> }).agents;
}

// INVARIANT: the model-tier profiles lazy.toml.example teaches are valid
// config — every block loads through the real profile resolver, carries a
// description, and names the tier's decided model. A copied example that
// refuses to load is worse than no example.
describe('lazy.toml.example model tiers', () => {
  test('every tier block resolves and carries a description', async () => {
    const agents = await tierProfiles();
    const profiles = resolveAgentProfiles(agents as never, () => {});
    for (const name of Object.keys(agents)) {
      expect(profiles.get(name)?.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('tiers name the decided models per harness', async () => {
    const models = Object.fromEntries(Object.entries(await tierProfiles()).map(([n, b]) => [n, b.model]));
    expect(models).toEqual({
      'claude-normal': 'claude-sonnet-5-5',
      'claude-complex': 'claude-opus-5-5',
      'claude-security': 'claude-opus-5-5',
      'claude-on-demand': 'claude-fable-5-1',
      'cursor-normal': 'composer-2.5',
      'cursor-complex': 'grok-4-7',
      'cursor-security': 'claude-opus-5-5',
      'codex-normal': 'gpt-5.6-terra',
      'codex-complex': 'gpt-6-sol',
      'codex-security': 'gpt-6-sol',
      'codex-on-demand': 'gpt-6-astra',
    });
  });
});

// INVARIANT: tasks default to Sonnet 5.5 and the builder to Opus 5.5, and the
// builder never falls back to the TASK default. Lowering a project's task
// model must not silently lower the model that plans and reviews its work.
describe('task and builder defaults are separate', () => {
  test('task default is Sonnet 5.5, builder default Opus 5.5', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    expect(BUILDER_DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  test('a claude-code builder with no profile model runs the builder default, not [models] default', () => {
    const config = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, default: 'claude-haiku-4-5' } };
    expect(resolveBuilderModel(config as never, { harness: 'claude-code', model: '' })).toBe(BUILDER_DEFAULT_MODEL);
    expect(resolveBuilderModel(config as never, { harness: 'claude-code', model: 'x-model' })).toBe('x-model');
    expect(resolveBuilderModel(config as never, { harness: 'claude-code', model: '' }, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });
});

// INVARIANT: the routing lines the example teaches (`[agent] agent_id` and
// `[agent.by_type] cluster`) name profiles that exist in the same example, and
// load through the real config loader.
describe('lazy.toml.example tier routing', () => {
  test('agent_id and by_type cluster resolve against the tier profiles', async () => {
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { loadConfig } = await import('../../src/config/loader');
    const agents = await tierProfiles();
    const tables = Object.entries(agents)
      .map(([n, b]) => `[agents.${n}]\n${Object.entries(b).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}`)
      .join('\n\n');
    const dir = await mkdtemp(join(tmpdir(), 'tiers-'));
    await writeFile(join(dir, 'lazy.toml'),
      `[project]\nname = "tiers"\n\n${tables}\n\n[agent]\nagent_id = "claude-normal"\n\n[agent.by_type]\ncluster = "claude-complex"\n`);
    const config = await loadConfig(dir);
    expect(config.agent.agent_id).toBe('claude-normal');
    expect(config.agent.by_type?.cluster).toBe('claude-complex');
  });
});
