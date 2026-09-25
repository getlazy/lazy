/**
 * Unit tests for config keys lazy has REMOVED outright
 * (DEPRECATED_SECTION_KEYS in src/config/schema.ts, applied by the loader).
 *
 * The one entry today is `[protection] passphrase_file`. What matters is that a
 * human who still has it in lazy.toml is TOLD — a removed key silently ignored
 * is the "gate believed armed but isn't" failure protection must never have —
 * and that they are told the right thing, not "unknown option".
 */

import { describe, test, beforeEach, afterEach, expect, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findDeprecatedConfigKeys,
  findRemovedConfigKeys,
  findDeprecatedConfigSections,
  findUnknownConfigKeys,
  DEPRECATED_SECTION_KEYS,
  DEPRECATED_SECTIONS,
  KNOWN_CONFIG_SCHEMA,
} from '../../src/config/schema';
import {
  loadConfig,
  resetRemovedKeyDeprecationWarnings,
  resetLoopDeprecationWarning,
  resetByTypeLoopDeprecationWarning,
  resetLowHighDeprecationWarning,
  usesDeprecatedByTypeLoop,
  getDefaultConfigTemplate,
} from '../../src/config/loader';
import { invalidTaskTypeMessage, LEGACY_CLUSTER_TASK_TYPE } from '../../src/types';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('removed config keys', () => {
  test('protection.passphrase_file is removed from the schema, not still known', () => {
    expect(KNOWN_CONFIG_SCHEMA.protection).not.toContain('passphrase_file');
    expect(DEPRECATED_SECTION_KEYS['protection.passphrase_file']!()).toContain(
      'lazy system passphrase set',
    );
  });

  // INVARIANT: the low-high loop's pre-rename config keys are REMOVED, not
  // quietly still accepted. A config still saying `ivan_loop = true` would
  // otherwise run plain single-shot turns while its author believed the
  // experiment was armed — the same silent-no-op failure passphrase_file had.
  test("the loop's pre-rename agent keys are removed, and the new ones are known", () => {
    // The low-high keys have since moved again — out of `[agent]` and into
    // `[review]`, where they are HONOURED rather than ignored (see the
    // honoured-alias tests below). So the assertion that survives here is the
    // one about `ivan_loop`: it is removed, and its remedy still names the
    // spelling that replaced it.
    for (const suffix of ['', '_draft_effort', '_review_effort']) {
      expect(KNOWN_CONFIG_SCHEMA.agent).not.toContain(`ivan_loop${suffix}`);
      // Still KNOWN (and honoured) — see the honoured-alias describe below.
      expect(KNOWN_CONFIG_SCHEMA.agent).toContain(`low_high_loop${suffix}`);
      expect(DEPRECATED_SECTION_KEYS[`agent.ivan_loop${suffix}`]!()).toContain(
        `low_high_loop${suffix}`,
      );
    }
    expect(KNOWN_CONFIG_SCHEMA.review).toEqual(
      expect.arrayContaining(['mode', 'auto_fix', 'draft_effort', 'review_effort']),
    );
  });

  /*
   * `[agent] low_high_loop*` → `[review]` is a RENAME, not a removal, and the
   * difference is what these pin. The low-high loop stopped being an experiment
   * bolted onto `[agent]` and became the DEFAULT review mode, so its keys moved
   * to the section that owns that choice — but a project that configured them
   * asked for something, and silently ignoring it would change how their tasks
   * are reviewed on upgrade without a word.
   */
  describe('the low-high keys are honoured aliases, not removed keys', () => {
    // INVARIANT: an honoured key never appears in the "obsolete and is IGNORED"
    // list. A human told their setting is dead leaves it in place while it
    // keeps deciding — the one direction a config warning may not fail in.
    test('they are excluded from the removed-key scan', () => {
      const raw = { agent: { low_high_loop: true, ivan_loop: true } };
      expect(findDeprecatedConfigKeys(raw)).toContain('agent.low_high_loop');
      expect(findRemovedConfigKeys(raw)).not.toContain('agent.low_high_loop');
      expect(findRemovedConfigKeys(raw)).toContain('agent.ivan_loop');
    });

  });

  test('findDeprecatedConfigKeys finds it only when present', () => {
    expect(findDeprecatedConfigKeys({ protection: { enabled: true } })).toEqual([]);
    expect(findDeprecatedConfigKeys({ protection: { passphrase_file: '.lazy/x' } })).toEqual([
      'protection.passphrase_file',
    ]);
  });

  // INVARIANT: a removed key gets its migration message, never the generic
  // "Unknown config option" — which sends the human hunting for a typo when the
  // real answer is "that moved, here is where".
  test('a removed key is not reported as an unknown option', () => {
    const warnings = findUnknownConfigKeys({
      protection: { enabled: true, passphrase_file: '.lazy/approve-passphrase' },
    });
    expect(warnings.join('\n')).not.toContain('passphrase_file');

    // A genuinely unknown key in the same section still is.
    const unknown = findUnknownConfigKeys({ protection: { nonsense_key: 1 } });
    expect(unknown.join('\n')).toContain("Unknown config option 'protection.nonsense_key'");
  });

  // A whole SECTION can be removed too, and `[ollama]` is. Keeping its keys in
  // KNOWN_CONFIG_SCHEMA made the scan answer "no unknown config options" for a
  // file the loader refuses outright — the schema surface disagreeing with the
  // load. Dropping it without a deprecation entry would have swung the other
  // way, to "Unknown config section '[ollama]'", which reads as a typo for a
  // section lazy knows perfectly well.
  test('[ollama] is a removed SECTION, with the remedy attached', () => {
    expect('ollama' in KNOWN_CONFIG_SCHEMA).toBe(false);
    expect(DEPRECATED_SECTIONS.ollama!()).toContain('[agents.<name>]');
    expect(DEPRECATED_SECTIONS.ollama!()).toContain('lazy doctor --fix agents');

    expect(findDeprecatedConfigSections({ agent: { agent_id: 'pi' } })).toEqual([]);
    expect(findDeprecatedConfigSections({ ollama: { model: 'qwen3:8b' } })).toEqual(['ollama']);
    // An [ollama] header with no keys under it is still the removed section.
    expect(findDeprecatedConfigSections({ ollama: {} })).toEqual(['ollama']);
  });

  test('a removed section is not reported as an unknown one', () => {
    const warnings = findUnknownConfigKeys({ ollama: { model: 'qwen3:8b' } });
    expect(warnings.join('\n')).not.toContain('ollama');

    // A section lazy has never heard of still is.
    expect(findUnknownConfigKeys({ llama: { model: 'x' } }).join('\n'))
      .toContain("Unknown config section '[llama]'");
  });

  describe('at load time', () => {
    let root: string;
    let warnings: string[];
    let restoreWarn: () => void;
    let unpinConfig: () => void;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'deprecated-keys-'));
      // Without this, loadConfig walks UP from cwd — which under `bun test` is
      // lazy's OWN worktree — and reads the developer's real lazy.toml.
      unpinConfig = pinConfig(root);
      warnings = [];
      const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });
      restoreWarn = () => spy.mockRestore();
      resetRemovedKeyDeprecationWarnings();
    });

    afterEach(async () => {
      restoreWarn();
      unpinConfig();
      resetRemovedKeyDeprecationWarnings();
      resetLoopDeprecationWarning();
      resetByTypeLoopDeprecationWarning();
      resetLowHighDeprecationWarning();
      await rm(root, { recursive: true, force: true });
    });

    async function writeConfig(body: string): Promise<void> {
      await writeFile(join(root, 'lazy.toml'), body);
    }

    test('warns once, names the new command, and points at lazy doctor', async () => {
      await writeConfig(
        '[protection]\nenabled = true\npassphrase_file = ".lazy/approve-passphrase"\n',
      );

      await loadConfig(root);
      expect(warnings.join('\n')).toContain('lazy system passphrase set');
      expect(warnings.join('\n')).toContain('lazy doctor');
      expect(warnings.filter((w) => w.includes('passphrase_file')).length).toBe(1);

      // One-shot per process, like the [checks] warning — a second load in the
      // same process must not re-spam it.
      await loadConfig(root);
      expect(warnings.filter((w) => w.includes('passphrase_file')).length).toBe(1);
    });

    // INVARIANT: the key is not merely unread, it is STRIPPED. deepMerge copies
    // keys it does not know about, so leaving it on the resolved config would
    // keep a stray second source of truth for the gate's key.
    test('the removed key never reaches the resolved config', async () => {
      await writeConfig('[protection]\nenabled = true\npassphrase_file = "/tmp/mine"\n');

      const config = await loadConfig(root);
      expect(config.protection.enabled).toBe(true);
      expect('passphrase_file' in (config.protection as Record<string, unknown>)).toBe(false);
    });

    test('a config without the key loads silently', async () => {
      await writeConfig('[protection]\nenabled = true\n');

      await loadConfig(root);
      expect(warnings.join('\n')).not.toContain('passphrase_file');
    });

      test('the old spelling decides when only it is set', async () => {
        await writeConfig('[agent]\nlow_high_loop_review_effort = "max"\n');
        const config = await loadConfig(root);
        expect(config.review.review_effort).toBe('max');
        expect('low_high_loop_review_effort' in (config.agent as Record<string, unknown>)).toBe(false);
      });

      // INVARIANT: `low_high_loop = false` maps to `separate`, NEVER to the new
      // `low_high` default. False meant "no in-session loop, the daemon
      // dispatches a reviewer of its own", and that is exactly `separate`.
      // Reading it as the default would switch every existing project into a
      // different review arm on upgrade, which is the opposite of honouring it.
      test('false means separate, not the new default', async () => {
        await writeConfig('[agent]\nlow_high_loop = false\n');
        expect((await loadConfig(root)).review.mode).toBe('separate');
      });

      test('true means low_high', async () => {
        await writeConfig('[agent]\nlow_high_loop = true\n');
        expect((await loadConfig(root)).review.mode).toBe('low_high');
      });

      // INVARIANT: lazy refuses rather than guessing which spelling the author
      // meant — the same rule `[checks]` and `[loop]` follow.
      test('two spellings that disagree refuse the load', async () => {
        await writeConfig('[agent]\nlow_high_loop = true\n\n[review]\nmode = "separate"\n');
        await expect(loadConfig(root)).rejects.toThrow(/low_high_loop/);
      });

      test('agreeing spellings load fine', async () => {
        await writeConfig('[agent]\nlow_high_loop = true\n\n[review]\nmode = "low_high"\n');
        expect((await loadConfig(root)).review.mode).toBe('low_high');
      });

    test('a removed low-high loop key warns and names its replacement', async () => {
      await writeConfig('[agent]\nivan_loop = true\nivan_loop_review_effort = "max"\n');

      const config = await loadConfig(root);
      const text = warnings.join('\n');
      expect(text).toContain('low_high_loop');
      expect(text).toContain('lazy doctor');
      // Removed, not aliased: the project stays on its configured review mode
      // rather than silently honouring a key lazy no longer supports.
      expect(config.review.mode).toBe('low_high');
      expect('ivan_loop' in (config.agent as Record<string, unknown>)).toBe(false);
    });

    /*
     * `[loop]` → `[cluster]` is a RENAME, not a removal, and the difference is
     * the whole point of these three.
     *
     * INVARIANT: the old spelling is still HONOURED. The task type `loop`
     * became `cluster` on 2026-09-20 and its config section moved with it; a
     * project that wrote `max_child_fix_rounds = 5` asked for 5, and silently
     * giving it the default 3 because a header changed would be lazy overruling
     * a number the human chose. Same three rules as the `[checks]` →
     * `[automation]` fold: honour, refuse a disagreement, warn once.
     */
    test('[loop] max_child_fix_rounds is still honoured, and warns once', async () => {
      await writeConfig('[loop]\nmax_child_fix_rounds = 5\n');

      const config = await loadConfig(root);
      expect(config.cluster.max_child_fix_rounds).toBe(5);
      const text = warnings.join('\n');
      expect(text).toContain('[cluster]');
      expect(text).toContain('lazy doctor');
      expect(warnings.filter((w) => w.includes('[loop]')).length).toBe(1);

      // One-shot per process, like every other deprecation warning here.
      await loadConfig(root);
      expect(warnings.filter((w) => w.includes('[loop]')).length).toBe(1);
    });

    // INVARIANT: the old table is STRIPPED off the resolved config. deepMerge
    // copies keys it does not know about, so leaving `loop` on there would be a
    // stray second source of truth for the same number.
    test('the old section never reaches the resolved config', async () => {
      await writeConfig('[loop]\nmax_child_fix_rounds = 5\n');

      const config = await loadConfig(root);
      expect('loop' in (config as unknown as Record<string, unknown>)).toBe(false);
    });

    // INVARIANT: lazy does not guess. Two spellings with different values is a
    // human asking for two things, and picking one silently is how a project
    // ends up running a budget nobody chose.
    test('the two spellings disagreeing refuses the load, naming both', async () => {
      await writeConfig('[loop]\nmax_child_fix_rounds = 5\n\n[cluster]\nmax_child_fix_rounds = 2\n');

      await expect(loadConfig(root)).rejects.toThrow(/\[loop\] 5 vs \[cluster\] 2/);
    });

    test('[cluster] alone loads silently', async () => {
      await writeConfig('[cluster]\nmax_child_fix_rounds = 7\n');

      const config = await loadConfig(root);
      expect(config.cluster.max_child_fix_rounds).toBe(7);
      expect(warnings.join('\n')).not.toContain('[loop]');
    });

    /*
     * `[agent.by_type] loop` is the THIRD surface of the same rename, and the
     * only one that used to be fatal.
     *
     * INVARIANT: a legacy key here never hard-fails the load. `by_type` keys are
     * task type names, validated by THROWING on an unknown one, so dropping
     * `loop` from VALID_TASK_TYPES turned a routing line that worked yesterday
     * into a config `loadConfig` refuses. Because every command loads config,
     * that does not break one feature — it takes the whole project down,
     * including the commands that would diagnose it. Routing the driving type
     * to a named profile is a natural thing to have done, so it is aliased,
     * exactly like the `[loop]` section above.
     */
    test('[agent.by_type] loop loads, routes as cluster, and warns once', async () => {
      await writeConfig('[agent.by_type]\nloop = "cursor"\n');

      const config = await loadConfig(root);
      expect(config.agent.by_type?.cluster).toBe('cursor');
      const text = warnings.join('\n');
      expect(text).toContain('cluster');
      expect(text).toContain('lazy doctor');
      expect(warnings.filter((w) => w.includes('by_type')).length).toBe(1);

      // One-shot per process, like every other deprecation warning here.
      await loadConfig(root);
      expect(warnings.filter((w) => w.includes('by_type')).length).toBe(1);
    });

    // INVARIANT: the old key is STRIPPED, same reason as the `[loop]` table —
    // a resolved config carrying both spellings is two sources of truth for one
    // routing decision.
    test('the legacy by_type key never reaches the resolved config', async () => {
      await writeConfig('[agent.by_type]\nloop = "cursor"\n');

      const config = await loadConfig(root);
      expect('loop' in (config.agent.by_type as Record<string, unknown>)).toBe(false);
    });

    // INVARIANT: lazy does not guess here either. Both names routing the same
    // type to different profiles is a human asking for two things.
    test('both spellings routing to different profiles refuses the load', async () => {
      await writeConfig('[agent.by_type]\nloop = "cursor"\ncluster = "claude-code"\n');

      await expect(loadConfig(root)).rejects.toThrow(/loop = "cursor" vs cluster = "claude-code"/);
    });

    // The doctor is where the remedy lives, by the same convention as [loop]:
    // one generic line at load time, the rename and the edit here.
    test('lazy doctor reports the by_type rename with the profile to move', () => {
      expect(usesDeprecatedByTypeLoop({ agent: { by_type: { loop: 'cursor' } } })).toBe(true);
      expect(usesDeprecatedByTypeLoop({ agent: { by_type: { cluster: 'cursor' } } })).toBe(false);
      expect(usesDeprecatedByTypeLoop({ agent: {} })).toBe(false);
      expect(usesDeprecatedByTypeLoop({})).toBe(false);
    });

    // The template lazy init writes must not reintroduce what we just removed.
    test('the generated lazy.toml template carries no passphrase_file key', () => {
      const template = getDefaultConfigTemplate();
      expect(template).not.toContain('passphrase_file');
      expect(template).toContain('lazy system passphrase set');
    });
  });
});

/*
 * The retired type name at the surfaces where a human or an agent TYPES it.
 *
 * INVARIANT: the refusal names the rename before listing valid types, and it is
 * spelled ONCE for all five validating surfaces (`lazy create`, `lazy edit`,
 * their daemon handlers, and the MCP create handler). Every other surface of
 * this rename tells the reader what happened — `/loops` redirects, `[loop]` and
 * `[agent.by_type] loop` are honoured with a named remedy, a stored
 * `type: "loop"` is aliased — and this one used to print `Invalid type 'loop'`
 * with a bare list of thirteen names. `cluster` was in the list, so it was
 * recoverable by inference; the old spelling is also the one most people have
 * in their fingers, which is exactly when inference is the wrong thing to ask
 * for.
 */
describe('the retired task type name at the --type surfaces', () => {
  test('the refusal names the rename, and only for that name', () => {
    const retired = invalidTaskTypeMessage(LEGACY_CLUSTER_TASK_TYPE);
    expect(retired).toContain('renamed `cluster`');
    // The valid list still rides along: the reader may have meant something else.
    expect(retired).toContain('cluster');
    expect(retired).toContain('feature');

    const nonsense = invalidTaskTypeMessage('xyzzy');
    expect(nonsense).toContain("Invalid type 'xyzzy'");
    expect(nonsense).not.toContain('renamed');
  });

  // INVARIANT: one helper, five call sites. The message was duplicated across
  // all five, which is how the rename reached four of them and not the fifth in
  // the first place — and a message a user reads should not depend on which
  // surface refused them.
  test('every validating surface goes through the shared helper', async () => {
    const sources = [
      'src/cli/commands/create.ts',
      'src/cli/commands/edit.ts',
      'src/daemon/create-task.ts',
      'src/daemon/edit-task.ts',
      'src/mcp/tools.ts',
    ];
    for (const rel of sources) {
      const text = await Bun.file(join(import.meta.dir, '../..', rel)).text();
      expect(text).toContain('invalidTaskTypeMessage');
      // No hand-rolled copy left behind.
      expect(text).not.toContain("Invalid type '${");
    }
  });

  // The comment block in lazy.toml.example is what teaches a reader which names
  // `[agent.by_type]` accepts. It listed twelve types and never the driving one,
  // so somebody routing it had no in-file evidence the name exists.
  test('the example config lists the driving type', async () => {
    const example = await Bun.file(join(import.meta.dir, '../..', 'lazy.toml.example')).text();
    expect(example).toMatch(/#\s+cluster\s+—/);
  });
});
