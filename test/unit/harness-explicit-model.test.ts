/**
 * No harness launches an agent without an explicit model.
 *
 * INVARIANT (turn-model stickiness): every harness's argv builder — headless
 * and interactive — either carries the launch's model or refuses to build,
 * and the refusal classifies as `fatal_config`. Omitting the model flag hands
 * the choice to whatever the harness reads by default (cursor-agent's
 * persisted selection, the human's Claude Code settings, a compiled-in default
 * that moves between versions) and nothing reports that it did. Stickiness is
 * lazy's rule, not a harness feature, so it is checked for every registered
 * harness rather than one at a time.
 */
import { describe, expect, test } from 'bun:test';
import { getAgent, listAgents } from '../../src/agent/registry';
import { CODEX_DEFAULT_MODEL } from '../../src/agent/codex';
import { CURSOR_AUTO_MODEL } from '../../src/agent/cursor';
import { NO_MODEL_MARKER, requireLaunchModel } from '../../src/agent/launch-model';

/** The harnesses that launch a real agent binary (qa-agent calls no model). */
const HARNESSES = ['claude-code', 'codex', 'cursor', 'pi'] as const;

/** Each harness's model flag, as it appears in argv. */
const MODEL_FLAG: Record<(typeof HARNESSES)[number], string> = {
  'claude-code': '--model',
  codex: '-m',
  cursor: '--model',
  pi: '--model',
};

const MISSING = [undefined, null, '', '   '] as const;

describe('every harness refuses a model-less launch', () => {
  test('the list covers every registered model-calling harness', () => {
    expect(listAgents().filter((id) => id !== 'qa-agent').sort()).toEqual([...HARNESSES].sort());
  });

  for (const harness of HARNESSES) {
    describe(harness, () => {
      const agent = getAgent(harness);

      test('headless: a named model is passed', () => {
        const args = agent.buildExecArgs({ prompt: 'p', modelId: 'some-model', dangerouslySkipPermissions: false });
        expect(args[args.indexOf(MODEL_FLAG[harness]) + 1]).toBe('some-model');
      });

      test('headless: no model is a refusal, never an omitted flag', () => {
        for (const modelId of MISSING) {
          expect(() => agent.buildExecArgs({
            prompt: 'p',
            modelId: modelId ?? undefined,
            dangerouslySkipPermissions: false,
          })).toThrow(`${harness} ${NO_MODEL_MARKER}`);
        }
      });

      test('interactive: a named model is passed', () => {
        const args = agent.buildInteractiveArgs({ modelId: 'some-model', dangerouslySkipPermissions: false });
        expect(args).not.toBeNull();
        expect(args![args!.indexOf(MODEL_FLAG[harness]) + 1]).toBe('some-model');
      });

      test('interactive: no model is a refusal, never an omitted flag', () => {
        for (const modelId of MISSING) {
          expect(() => agent.buildInteractiveArgs({ modelId, dangerouslySkipPermissions: false }))
            .toThrow(`${harness} ${NO_MODEL_MARKER}`);
        }
      });

      test('the refusal classifies as fatal_config (retrying cannot help)', () => {
        let message = '';
        try {
          requireLaunchModel(harness, undefined);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(agent.classifyFailure({ message })).toEqual({
          class: 'fatal_config',
          reason: 'launch named no model',
        });
      });
    });
  }
});

describe('a harness default name is omitted only where it is truly the same model', () => {
  // Codex's `default` sentinel is a NAMED choice, and omitting -m is the only
  // way to spell it. What then runs is codex's compiled-in default, which
  // nothing outside lazy can redirect: lazy owns ~/.codex/config.toml and never
  // writes a `model` key there.
  test(`codex: "${CODEX_DEFAULT_MODEL}" omits -m, in both launch shapes`, () => {
    const codex = getAgent('codex');
    expect(codex.buildExecArgs({ prompt: 'p', modelId: CODEX_DEFAULT_MODEL, dangerouslySkipPermissions: false }))
      .not.toContain('-m');
    expect(codex.buildInteractiveArgs({ modelId: CODEX_DEFAULT_MODEL, dangerouslySkipPermissions: false }))
      .not.toContain('-m');
  });

  // Cursor's `auto` is NOT: an omitted --model reads the human's persisted
  // selection in ~/.cursor/cli-config.json. The headless path already passed
  // it; pairing on an `auto` task used to drop it.
  test(`cursor: "${CURSOR_AUTO_MODEL}" is passed in both launch shapes`, () => {
    const cursor = getAgent('cursor');
    const exec = cursor.buildExecArgs({ prompt: 'p', modelId: CURSOR_AUTO_MODEL, dangerouslySkipPermissions: false });
    const pair = cursor.buildInteractiveArgs({ modelId: CURSOR_AUTO_MODEL, dangerouslySkipPermissions: false })!;
    expect(exec[exec.indexOf('--model') + 1]).toBe(CURSOR_AUTO_MODEL);
    expect(pair[pair.indexOf('--model') + 1]).toBe(CURSOR_AUTO_MODEL);
  });
});
