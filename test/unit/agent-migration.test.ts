/**
 * The pre-profile → agent-profile config rewrite behind `lazy doctor --fix agents`.
 *
 * INVARIANT: the planner never INVENTS a value and never offers a file it has
 * not re-validated. A rewrite that guessed a model would produce a lazy.toml
 * that reads plausibly and launches against a model the server does not serve —
 * the same class of silent reinterpretation the load-time refusals exist to
 * prevent. So a rewrite that would need a guess becomes a blocker, and a blocker
 * means nothing is written at all.
 */

import { describe, test, expect } from 'bun:test';
import { planAgentMigration, LEGACY_OLLAMA_ENDPOINT } from '../../src/config/agent-migration';

/** Parse a planned rewrite so assertions are about values, not formatting. */
function parse(content: string): any {
  return Bun.TOML.parse(content);
}

describe('planAgentMigration', () => {
  test('a config with no legacy spelling needs nothing', () => {
    const input = '[agent]\nagent_id = "codex"\n\n[agents.work-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\n';
    const plan = planAgentMigration(input);
    expect(plan.needed).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.updated).toBe(input);
  });

  test('a role backend becomes a named profile plus a role pointer', () => {
    const plan = planAgentMigration(
      '[models.roles.agent]\nbackend = "ollama"\nmodel = "qwen3:8b"\n',
    );
    expect(plan.blockers).toEqual([]);
    const parsed = parse(plan.updated);
    expect(parsed.agents['agent-ollama']).toEqual({
      harness: 'claude-code',
      model: 'qwen3:8b',
      endpoint: LEGACY_OLLAMA_ENDPOINT,
    });
    expect(parsed.models.roles.agent).toEqual({ agent: 'agent-ollama' });
  });

  // The replacement is a NAMED profile, never `[agents.claude-code]`: overriding
  // the built-in would also capture every claude-code TASK, which a user
  // migrating one ROLE has not asked for.
  test('the migration never overrides a built-in profile', () => {
    const plan = planAgentMigration('[models.roles.builder]\nmodel = "claude-opus-5"\n');
    const parsed = parse(plan.updated);
    expect(Object.keys(parsed.agents)).toEqual(['builder-anthropic']);
    expect(parsed.models.roles.builder.agent).toBe('builder-anthropic');
  });

  // A key the legacy config never set is left OUT of the rewrite. A role that
  // names only a backend names no model, and `model = ""` written into the
  // user's file reads like a blank they must fill in while meaning exactly what
  // omitting the key already means. The fix hands back a file the user maintains
  // by hand — it must not leave placeholder-looking values in it.
  test('a role with no model writes no model key at all', () => {
    const plan = planAgentMigration('[models.roles.builder]\nbackend = "anthropic"\n');
    expect(plan.blockers).toEqual([]);
    expect(plan.updated).not.toContain('model = ""');
    const parsed = parse(plan.updated);
    expect(parsed.agents['builder-anthropic']).toEqual({ harness: 'claude-code' });
  });

  // A backend never chose the harness — `[agent] agent_id` did — so the migrated
  // profile keeps running whatever the project already ran.
  test('the profile keeps the harness the project already runs', () => {
    const plan = planAgentMigration(
      '[agent]\nagent_id = "pi"\n\n[ollama]\nmodel = "qwen3:8b"\nendpoint = "http://localhost:11434"\n',
    );
    expect(plan.blockers).toEqual([]);
    const parsed = parse(plan.updated);
    expect(parsed.agents['local-ollama'].harness).toBe('pi');
    // [ollama] pointed BOTH roles at one server; the project default is the
    // closest honest equivalent.
    expect(parsed.agent.agent_id).toBe('local-ollama');
    expect(parsed.ollama).toBeUndefined();
  });

  test('an openai_upstream that named the default upstream just goes away', () => {
    const plan = planAgentMigration('[proxy]\nport = 8766\nopenai_upstream = "https://api.openai.com"\n');
    expect(plan.blockers).toEqual([]);
    const parsed = parse(plan.updated);
    expect(parsed.proxy).toEqual({ port: 8766 });
    // No profile block: the built-in `codex` profile already uses that upstream.
    expect(parsed.agents).toBeUndefined();
  });

  test('a custom openai_upstream moves onto the codex profile when a model is known', () => {
    const plan = planAgentMigration(
      '[agents.codex]\nharness = "codex"\nmodel = "qwen2.5-coder"\n\n[proxy]\nopenai_upstream = "http://localhost:8080/v1"\n',
    );
    expect(plan.blockers).toEqual([]);
    const parsed = parse(plan.updated);
    expect(parsed.agents.codex.endpoint).toBe('http://localhost:8080/v1');
    expect(parsed.proxy.openai_upstream).toBeUndefined();
  });

  // INVARIANT: model names belong to the server. A rewrite that cannot name one
  // reports why and writes NOTHING.
  test('a pinned endpoint with no model is a blocker, not a placeholder', () => {
    const plan = planAgentMigration('[ollama]\nendpoint = "http://localhost:11434"\n');
    expect(plan.needed).toBe(true);
    expect(plan.blockers.length).toBe(1);
    expect(plan.blockers[0]).toContain('names no model');
    expect(plan.updated).toBe('[ollama]\nendpoint = "http://localhost:11434"\n');
  });

  // ...but an [ollama] header with NO keys is not that case. It configured
  // nothing before profiles either, so there is no server to name: the rewrite
  // just deletes the dead section. Inventing a profile here would create an
  // upstream the project never had, and blocking on the missing model would
  // demand a model for a server that was never configured.
  test('an [ollama] section with no keys is simply removed', () => {
    const plan = planAgentMigration(
      '[ollama]\n# enabled = true\n# model = "qwen3:8b"\n\n[chattiness]\ndefault = "normal"\n',
    );
    expect(plan.needed).toBe(true);
    expect(plan.blockers).toEqual([]);
    const parsed = parse(plan.updated);
    expect(parsed.ollama).toBeUndefined();
    expect(parsed.agents).toBeUndefined();
    // Untouched neighbours stay untouched.
    expect(parsed.chattiness.default).toBe('normal');
  });

  // ...and "no keys" must mean exactly that, not "not a plain table". An array
  // of tables carries REAL configuration, and the zero-key branch used to
  // swallow it (`asTable(...) ?? {}`) and plan "section removed — it configured
  // nothing" — while toml-edit's section-header regex matches `[[ollama]]`, so
  // the fix then deleted the user's model and endpoint. A shape lazy cannot read
  // blocks; it never rewrites.
  test('an [[ollama]] array of tables is a blocker, not a deletion', () => {
    const plan = planAgentMigration(
      '[[ollama]]\nmodel = "qwen3:8b"\nendpoint = "http://box:11434"\n',
    );
    expect(plan.needed).toBe(true);
    expect(plan.blockers.join('\n')).toContain('array of tables');
    // The critical half: the user's file is handed back untouched.
    expect(plan.updated).toContain('model = "qwen3:8b"');
    expect(plan.updated).toContain('endpoint = "http://box:11434"');
    expect(plan.steps).toEqual([]);
  });

  test('a scalar ollama value is a blocker, not a deletion', () => {
    const plan = planAgentMigration('ollama = "http://box:11434"\n');
    expect(plan.needed).toBe(true);
    expect(plan.blockers.join('\n')).toContain('not a table');
    expect(plan.updated).toContain('ollama = "http://box:11434"');
  });

  // Same hole on the role path. `asTable(roles?.[role])` returns null for an
  // array, so `found` came out empty and the planner reported "nothing to do"
  // for a file the loader now refuses — a fix that disagrees with the load.
  test('an [[models.roles.agent]] array of tables is a blocker', () => {
    const plan = planAgentMigration(
      '[[models.roles.agent]]\nbackend = "ollama"\nmodel = "qwen3:8b"\n',
    );
    expect(plan.needed).toBe(true);
    expect(plan.blockers.join('\n')).toContain('models.roles.agent');
    expect(plan.updated).toContain('backend = "ollama"');
  });

  test('a custom openai_upstream with no codex model is a blocker', () => {
    const plan = planAgentMigration('[proxy]\nopenai_upstream = "https://openrouter.ai/api"\n');
    expect(plan.blockers.length).toBe(1);
    expect(plan.blockers[0]).toContain('[agents.codex]');
  });

  // INVARIANT: nothing is written unless EVERY step can be applied. A partial
  // rewrite leaves a config that still refuses to load, which is worse than the
  // error the user started with.
  test('one blocker suppresses the other steps too', () => {
    const plan = planAgentMigration(
      '[ollama]\nmodel = "qwen3:8b"\n\n[proxy]\nopenai_upstream = "https://openrouter.ai/api"\n',
    );
    expect(plan.steps.length).toBe(1); // the [ollama] step was planned…
    expect(plan.blockers.length).toBe(1);
    expect(plan.updated).toContain('[ollama]'); // …and not applied.
  });

  test('an unparseable file is reported, not mangled', () => {
    const input = '[ollama\nmodel = "x"\n';
    const plan = planAgentMigration(input);
    expect(plan.blockers[0]).toContain('does not parse');
    expect(plan.updated).toBe(input);
  });

  test('comments and unrelated sections survive the rewrite', () => {
    const input = [
      '[project]',
      'name = "demo"   # keep me',
      '',
      '# The local box',
      '[ollama]',
      'model = "qwen3:8b"',
      '',
      '[remote]',
      'driver = "local"',
      '',
    ].join('\n');
    const plan = planAgentMigration(input);
    expect(plan.blockers).toEqual([]);
    expect(plan.updated).toContain('name = "demo"   # keep me');
    expect(plan.updated).toContain('[remote]\ndriver = "local"');
    // The caption travelled with the section it captioned.
    expect(plan.updated).not.toContain('# The local box');
  });

  test('the rewrite is a fixed point — re-planning it finds nothing to do', () => {
    const plan = planAgentMigration(
      '[agent]\nagent_id = "claude-code"\n\n[ollama]\nmodel = "qwen3:8b"\n\n[models.roles.builder]\nmodel = "claude-opus-5"\n',
    );
    expect(plan.blockers).toEqual([]);
    expect(planAgentMigration(plan.updated).needed).toBe(false);
  });

  // The planner resolves its own output through the same profile resolver
  // loadConfig runs, so a rewrite that would still fail is a blocker.
  test('a rewrite that would not load is refused rather than offered', () => {
    // codex speaks the OpenAI wire; an Anthropic endpoint on it cannot resolve.
    const plan = planAgentMigration(
      '[agent]\nagent_id = "codex"\n\n[ollama]\nmodel = "qwen3:8b"\nendpoint = "https://api.anthropic.com"\n',
    );
    expect(plan.blockers.length).toBe(1);
    expect(plan.blockers[0]).toContain('would still not load');
  });
});
