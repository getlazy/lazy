import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import { resolveBuilderLaunchInputs } from '../../src/builder/launch-inputs';
import { describeStaleBuilders, modelFromBuilderCmd } from '../../src/doctor/builder-staleness';
import { runBuilderRelaunchLoop } from '../../src/builder/relaunch';

describe('builder launch inputs', () => {
  // INVARIANT: every (re)launch of a builder re-reads config and rebuilds the prompt.
  // A relaunch after `lazy upgrade` must not run the model/prompt captured at first start.
  test('a relaunch through the loop sees config changed since the first launch', async () => {
    let model = 'claude-fable-5-1';
    let prompt = 'prompt-v1';
    const seen: Array<{ model: string; prompt: string }> = [];
    let launches = 0;
    const intent = { builderId: 'abc', sessionId: 's1', reason: 'daemon-restart' } as never;
    let intents: unknown[] = [];
    await runBuilderRelaunchLoop({
      initialResumeId: null,
      canRelaunch: true,
      projectRoot: '/p',
      launch: async () => {
        const inputs = await resolveBuilderLaunchInputs({
          loadConfig: async () => ({ model }),
          buildSystemPrompt: async () => prompt,
        });
        seen.push({ model: inputs.config.model, prompt: inputs.systemPrompt });
        launches++;
        if (launches === 1) {
          intents = [intent];
          model = 'claude-opus-5-5'; // lazy.toml edited while the builder ran
          prompt = 'prompt-v2';
        } else intents = [];
        return { exitCode: 0, sessionId: null, builderId: 'abc' };
      },
      getStorage: async () => ({
        listBuilderResumeIntents: async () => intents as never,
        takeBuilderResumeIntent: async () => { intents = []; return intent; },
        listConversations: async () => [],
      }),
      daemonStatus: async () => ({ running: true }) as never,
      ensureReady: async () => {},
      refreshProxyTarget: async () => {},
      log: () => {},
      errorOut: () => {},
      sleep: async () => {},
    });
    expect(seen).toEqual([
      { model: 'claude-fable-5-1', prompt: 'prompt-v1' },
      { model: 'claude-opus-5-5', prompt: 'prompt-v2' },
    ]);
  });

  // INVARIANT: launchOnce resolves the builder model from the per-launch config, never the one
  // captured at first start. Reverting to the captured `config` reintroduces builders that run a
  // model lazy.toml stopped naming days ago after an upgrade relaunch.
  test('builder.ts resolves the role target from the per-launch config', () => {
    const src = readFileSync('src/cli/commands/builder.ts', 'utf8');
    expect(src).toContain("resolveRoleTarget('builder', launchConfig,");
    expect(src).not.toContain("resolveRoleTarget('builder', config,");
  });

  // INVARIANT: doctor flags a running builder whose argv model or image differs from what a fresh launch would use.
  // Upgrade leaves builders running, so this is the only place that staleness is visible.
  test('doctor reports builders on an old model or image', () => {
    const cmd = ['builder', '--', '--add-dir', '/s', '--model', 'claude-fable-5-1', '--effort', 'high'];
    expect(modelFromBuilderCmd(cmd)).toBe('claude-fable-5-1');
    const stale = describeStaleBuilders([{ name: 'lazy-builder-a', imageId: 'sha:old', cmd, runningModel: 'claude-fable-5-1' }], 'claude-opus-5-5', 'sha:new');
    expect(stale[0]).toContain('claude-fable-5-1');
    expect(stale[0]).toContain('older image');
    expect(describeStaleBuilders([{ name: 'b', imageId: 'sha:new', cmd, runningModel: 'claude-fable-5-1' }], 'claude-fable-5-1', 'sha:new')).toEqual([]);
    // unreadable live process: the first-start argv is no evidence, so no model report
    expect(describeStaleBuilders([{ name: 'c', imageId: 'sha:new', cmd }], 'claude-opus-5-5', 'sha:new')).toEqual([]);
  });
});

import { applyLaunchDirective, MODEL_OVERRIDE_FLAG, EFFORT_OVERRIDE_FLAG } from '../../src/builder/launch-directive';
import { runningModelFromProcessLine } from '../../src/doctor/builder-staleness';
import { composeBuilderClaudeArgs } from '../../src/supervisor/builder';

describe('applyLaunchDirective', () => {
  const composed = ['--model', 'old', '--effort', 'low'];
  // INVARIANT: an untyped model/effort is replaced by the daemon's; a typed one is kept; markers never reach claude.
  test('replaces untyped values', () => {
    expect(applyLaunchDirective(composed, { model: 'new', effort: 'high' })).toEqual(['--model', 'new', '--effort', 'high']);
  });
  test('keeps typed values and strips markers', () => {
    const out = applyLaunchDirective(['--model', 'mine', MODEL_OVERRIDE_FLAG, '--effort', 'max', EFFORT_OVERRIDE_FLAG], { model: 'new', effort: 'high' });
    expect(out).toEqual(['--model', 'mine', '--effort', 'max']);
  });
  test('no directive only strips markers', () => {
    expect(applyLaunchDirective(['--model', 'x', MODEL_OVERRIDE_FLAG], undefined)).toEqual(['--model', 'x']);
  });
  // INVARIANT: the supervisor's real composition applies the directive (dropping it reintroduces stale models).
  test('supervisor composition applies the directive', () => {
    const args = composeBuilderClaudeArgs({ systemPrompt: 'p', resumeId: 's', extraArgs: composed, directive: { model: 'new', effort: 'low' } });
    expect(args).toContain('new');
    expect(args).not.toContain('old');
    expect(args.slice(0, 2)).toEqual(['claude', '--append-system-prompt']);
  });
  // INVARIANT: doctor reads the model from the END of the process line; the prompt earlier in it may mention --model.
  test('running model is the last --model', () => {
    expect(runningModelFromProcessLine('claude --append-system-prompt use --model x here --model real --effort high')).toBe('real');
    expect(runningModelFromProcessLine('claude --effort high')).toBeNull();
  });
});

import { resolveBuilderLaunchDirective } from '../../src/builder/launch-directive';
import { BUILDER_DEFAULT_MODEL } from '../../src/config/default-models';
import { loadConfig } from '../../src/config/loader';

describe('resolveBuilderLaunchDirective', () => {
  const withBuilderModel = <C extends { models: { roles: { builder: object } } }>(cfg: C, model: string): C => ({
    ...cfg,
    models: { ...cfg.models, roles: { ...cfg.models.roles, builder: { ...cfg.models.roles.builder, model } } },
  });

  // INVARIANT: a relaunch whose profile names no model resolves to the builder default, exactly like a fresh `lazy builder` — never null (omit --model); a model the profile pins is used as-is.
  test('profile without a model yields the builder default; a pinned model wins', async () => {
    const { mkdtemp, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'lazy-directive-'));
    try {
      const cfg = await loadConfig(dir);
      expect(resolveBuilderLaunchDirective(withBuilderModel(cfg, '')).model).toBe(BUILDER_DEFAULT_MODEL);
      expect(resolveBuilderLaunchDirective(withBuilderModel(cfg, 'my-pinned-model')).model).toBe('my-pinned-model');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
