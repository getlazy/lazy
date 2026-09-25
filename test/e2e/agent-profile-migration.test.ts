/**
 * Migrating a pre-profile lazy.toml: the load-time refusals, and
 * `lazy doctor --fix agents` that applies what they print.
 *
 * A few real projects have `[models.roles.agent] backend = "ollama"` or an
 * `[ollama]` block in a working lazy.toml. Those keys still PARSE, so a tolerant
 * reader would keep launching — against a different upstream than the file says.
 * That is the one outcome this migration must not have, hence: refuse at load,
 * print the exact replacement, and offer to write it.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';

describe('agent profile migration', () => {
  let ctx: TestContext;
  let configPath: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    configPath = join(ctx.root, 'lazy.toml');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Append legacy sections to the init-produced lazy.toml (never overwrite it). */
  function appendLegacy(block: string): void {
    const before = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `${before}\n${block}\n`);
  }

  /**
   * Prepend a legacy line, for a BARE key that must land at the root table.
   * Appended after the file's last `[section]` header it would belong to that
   * section instead, which is a different config entirely.
   */
  function prependLegacy(block: string): void {
    const before = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, `${block}\n${before}`);
  }

  const read = () => readFileSync(configPath, 'utf-8');

  describe('the removed spellings fail loudly', () => {
    test('[ollama] is refused with the replacement profile printed', async () => {
      appendLegacy('[ollama]\nmodel = "qwen3:8b"\nendpoint = "http://localhost:11434"');

      const result = await ctx.lazy(['list']);
      expectFailure(result);
      expectError(result, 'has an [ollama] section');
      expectError(result, '[agents.local-ollama]');
      expectError(result, 'lazy doctor --fix agents');
    });

    // ...but an [ollama] header with every line commented out is not a legacy
    // CONFIGURATION — it set nothing before profiles, so there is nothing that
    // could be reinterpreted. Refusing it would abort every command over a
    // migration for an Ollama server the project never had, which is loud but
    // untrue. It is reported as a removed section and the command still runs.
    test('an [ollama] section with no keys warns instead of refusing', async () => {
      appendLegacy('[ollama]\n# enabled = true\n# model = "qwen3:8b"');

      const result = await ctx.lazy(['list']);
      expectSuccess(result);
      expect(`${result.stdout}${result.stderr}`).toContain('[ollama] section in lazy.toml has been removed');
    });

    // ...and "no keys" must mean an EMPTY TABLE, not "anything that is not a
    // plain table". `[[ollama]]` is an array of tables carrying real keys, and
    // the zero-key guard used to coerce it to `{}` and take the "configured
    // nothing" branch — so this section was warned about and IGNORED at load,
    // and `lazy doctor --fix agents` then deleted the model and endpoint lines
    // (toml-edit's header regex matches `[[ollama]]` too). Ignoring config lazy
    // cannot read is the silent reinterpretation this whole migration exists to
    // prevent, so a shape lazy cannot read is a refusal.
    test('an [[ollama]] array of tables is refused, not ignored', async () => {
      appendLegacy('[[ollama]]\nmodel = "qwen3:8b"\nendpoint = "http://box:11434"');

      const result = await ctx.lazy(['list']);
      expectFailure(result);
      expectError(result, 'array of tables');
      expectError(result, '[ollama]');
    });

    test('a scalar ollama value is refused, not ignored', async () => {
      prependLegacy('ollama = "http://box:11434"');

      const result = await ctx.lazy(['list']);
      expectFailure(result);
      expectError(result, 'lazy cannot read');
    });

    // Same hole on the role path: `refuseRoleBackendKeys` returned early on an
    // array, `resolveRole` then read `explicit?.agent` off it, got undefined,
    // and fell back to the default profile. A file that says `backend =
    // "ollama"` loading clean onto Anthropic is exactly the outcome the refusals
    // exist to make impossible.
    test('an [[models.roles.agent]] array of tables is refused, not ignored', async () => {
      appendLegacy('[[models.roles.agent]]\nbackend = "ollama"\nmodel = "qwen3:8b"');

      const result = await ctx.lazy(['list']);
      expectFailure(result);
      expectError(result, 'array of tables');
      expectError(result, 'models.roles.agent');
    });

    test('a role backend is refused with the replacement profile printed', async () => {
      appendLegacy('[models.roles.agent]\nbackend = "ollama"\nmodel = "qwen3:8b"');

      const result = await ctx.lazy(['list']);
      expectFailure(result);
      expectError(result, '[agents.agent-ollama]');
      expectError(result, 'agent = "agent-ollama"');
      expectError(result, 'lazy doctor --fix agents');
    });

    test('[proxy] openai_upstream is refused with the replacement profile printed', async () => {
      appendLegacy('[proxy]\nopenai_upstream = "https://openrouter.ai/api"');

      const result = await ctx.lazy(['list']);
      expectFailure(result);
      expectError(result, '[agents.codex]');
      expectError(result, 'lazy doctor --fix agents');
    });

    // `lazy doctor` is THE surface for "my setup is broken" — it must REPORT a
    // config it cannot load, never die on it.
    test('lazy doctor reports the refusal instead of dying on it', async () => {
      appendLegacy('[ollama]\nmodel = "qwen3:8b"');

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'lazy.toml parses');
      expectOutput(result, 'has an [ollama] section');
    });
  });

  describe('lazy doctor --fix agents', () => {
    test('rewrites the legacy config into profiles and the config loads again', async () => {
      appendLegacy('[ollama]\nmodel = "qwen3:8b"\nendpoint = "http://localhost:11434"');

      const fix = await ctx.lazy(['doctor', '--fix', 'agents', '--yes']);
      expectSuccess(fix);
      expectOutput(fix, '[agents.local-ollama]');

      const after = read();
      expect(after).not.toContain('[ollama]');
      const parsed = Bun.TOML.parse(after) as any;
      expect(parsed.agents['local-ollama']).toEqual({
        harness: 'claude-code',
        model: 'qwen3:8b',
        endpoint: 'http://localhost:11434',
      });
      expect(parsed.agent.agent_id).toBe('local-ollama');

      // The whole point: the config the refusal rejected now loads.
      expectSuccess(await ctx.lazy(['list']));
    });

    test('the rewrite preserves the rest of lazy.toml', async () => {
      const before = read();
      appendLegacy('[ollama]\nmodel = "qwen3:8b"');

      expectSuccess(await ctx.lazy(['doctor', '--fix', 'agents', '--yes']));

      const after = read();
      // Every comment line the template shipped is still there.
      for (const line of before.split('\n')) {
        if (line.trim().startsWith('#')) expect(after).toContain(line);
      }
      expect(after).toContain(`external_path`);
    });

    // Non-interactive without --yes: show the diff, write NOTHING. lazy.toml is
    // a committed file the user maintains by hand — a rewrite they did not see
    // is a rewrite they cannot review.
    test('without --yes on a non-TTY it shows the diff and writes nothing', async () => {
      appendLegacy('[ollama]\nmodel = "qwen3:8b"');
      const before = read();

      const result = await ctx.lazy(['doctor', '--fix', 'agents']);
      expectSuccess(result);
      expectOutput(result, 'Diff:');
      expectOutput(result, '--yes');
      expect(read()).toBe(before);
    });

    // INVARIANT: never invent a value. A pinned endpoint needs a model, model
    // names belong to the server, so a rewrite that would guess one refuses.
    test('a pinned endpoint with no model refuses and leaves the file alone', async () => {
      appendLegacy('[ollama]\nendpoint = "http://localhost:11434"');
      const before = read();

      const result = await ctx.lazy(['doctor', '--fix', 'agents', '--yes']);
      expectFailure(result);
      expectError(result, 'names no model');
      expectError(result, 'Nothing was written');
      expect(read()).toBe(before);
    });

    test('a config already on profiles says there is nothing to migrate', async () => {
      const result = await ctx.lazy(['doctor', '--fix', 'agents', '--yes']);
      expectSuccess(result);
      expectOutput(result, 'already uses agent profiles');
    });

    test('an unknown --fix target names the valid ones', async () => {
      const result = await ctx.lazy(['doctor', '--fix', 'everything']);
      expectFailure(result);
      expectError(result, 'Unknown --fix target');
      expectError(result, 'agents');
    });
  });
});
