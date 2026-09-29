import { describe, expect, test } from 'bun:test';
import { editableConfigKeys, validateProjectConfigText } from '../../src/config/project-config';
import {
  SETTINGS_CATALOG,
  SETTING_GROUPS,
  describeConfigChange,
  editConfigText,
  settingsCatalog,
  SettingEditError,
} from '../../src/config/settings-catalog';

describe('settings catalogue', () => {
  // INVARIANT: every key a control plane may set is explained, grouped and
  // says when a change to it is picked up. A key without an entry would show
  // on the settings page with no explanation, and a save touching it would
  // have nothing to say about when it takes effect.
  test('every editable key has an entry in a known group', () => {
    const groups = new Set(SETTING_GROUPS.map((g) => g.id));
    const missing = editableConfigKeys().filter((key) => !SETTINGS_CATALOG[key]);
    expect(missing).toEqual([]);
    for (const [key, entry] of Object.entries(SETTINGS_CATALOG)) {
      expect(groups.has(entry.group), `${key} names unknown group ${entry.group}`).toBe(true);
      if (entry.kind === 'choice') expect(entry.choices?.length, key).toBeGreaterThan(0);
    }
  });

  // INVARIANT: the proxy keys are the ones a change needs a restart for
  // (src/daemon/proxy-fingerprint.ts); saying "next turn" for them was the bug.
  test('proxy tunables say restart, not next turn', () => {
    for (const key of ['proxy.retry_after_threshold', 'proxy.upstream_timeout', 'proxy.policy.deny_path_globs']) {
      expect(SETTINGS_CATALOG[key]!.effect).toBe('restart');
    }
  });

  test('reads defaults from lazy\'s own defaults', () => {
    const byKey = new Map(settingsCatalog().settings.map((s) => [s.key, s]));
    expect(byKey.get('daemon.auto_resume_max_attempts')!.defaultText).toBe('24');
    expect(byKey.get('usage_pause.threshold_percent')!.defaultText).toBe('0');
    expect(byKey.get('agents.*.endpoint')!.formEditable).toBe(false);
    expect(byKey.get('proxy.upstream_timeout')!.defaultText).toBe('1800');
    expect(byKey.get('review.mode')!.formEditable).toBe(true);
  });
});

describe('describeConfigChange', () => {
  test('commenting out the usage-pause threshold is a removal read when a turn starts', () => {
    const changes = describeConfigChange(
      '[usage_pause]\nthreshold_percent = 95\n',
      '[usage_pause]\n# threshold_percent = 95\n',
    )!;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      key: 'usage_pause.threshold_percent', change: 'removed', before: '95', after: null,
      defaultText: '0', effect: 'next-turn',
    });
  });

  test('a background setting never mentions turns', () => {
    const [change] = describeConfigChange('', '[daemon]\nauto_resume = false\n')!;
    expect(change!.effect).toBe('background');
    expect(change!.effectText).not.toMatch(/turn starts/);
  });

  // INVARIANT: a change anywhere inside a table- or list-valued setting is a
  // change to it. Reporting "nothing changed" for an edited maintained-files
  // entry is the generic, wrong message this report exists to replace.
  test('table and list settings report their changes', () => {
    const maintain = describeConfigChange(
      '[[automation.maintain]]\ntitle = "docs"\npattern = "docs/**"\ninstructions = "x"\n',
      '[[automation.maintain]]\ntitle = "docs"\npattern = "doc/**"\ninstructions = "x"\n',
    )!;
    expect(maintain.map((c) => [c.key, c.change])).toEqual([['automation.maintain', 'changed']]);

    const credentials = describeConfigChange('', '[usage_pause]\ncredentials = { "credential:X" = 90 }\n')!;
    expect(credentials.map((c) => c.key)).toEqual(['usage_pause.credentials']);
  });

  test('two agent profiles are reported separately, by name', () => {
    const changes = describeConfigChange(
      '[agents.a]\nmodel = "m1"\n[agents.b]\nmodel = "m1"\n',
      '[agents.a]\nmodel = "m2"\n[agents.b]\nmodel = "m1"\n',
    )!;
    expect(changes.map((c) => [c.key, c.label])).toEqual([['agents.a.model', 'Profile model (a)']]);
  });

  test('an unparseable text says nothing about changes rather than "everything removed"', () => {
    expect(describeConfigChange('[session]\nverbose = true\n', '[session\n')).toBeNull();
  });

  test('the usage-pause timing names held starts and running turns', () => {
    const [change] = describeConfigChange('[usage_pause]\nthreshold_percent = 95\n', '')!;
    expect(change!.effectText).toMatch(/never stopped/);
    expect(change!.effectText).toMatch(/within about a minute/);
  });

  test('resolved-only role fields are never offered', () => {
    const keys = settingsCatalog().settings.map((s) => s.key);
    expect(keys).not.toContain('models.roles.*.model');
    expect(keys).not.toContain('models.roles.*.harness');
    expect(keys).toContain('models.roles.*.agent');
  });

  test('unknown keys are not changes', () => {
    expect(describeConfigChange('', '[session]\nverbos = true\n')).toEqual([]);
  });
});

describe('editConfigText', () => {
  const FILE = '# Our project\n[review]\n# how we review\nmode = "separate"\n\n[usage_pause]\nthreshold_percent = 95\n';

  test('sets and unsets keys, keeping every comment', () => {
    const out = editConfigText(FILE, { 'review.mode': 'low_high', 'daemon.auto_resume': 'false' }, ['usage_pause.threshold_percent']);
    expect(out).toContain('# Our project');
    expect(out).toContain('# how we review');
    expect(out).toContain('mode = "low_high"');
    expect(out).not.toContain('threshold_percent');
    expect(out).toContain('[daemon]\nauto_resume = false');
    expect(validateProjectConfigText(out).ok).toBe(true);
  });

  test('types values by the catalogue', () => {
    expect(editConfigText('', { 'usage_pause.threshold_percent': '92.5' }, [])).toContain('threshold_percent = 92.5');
    expect(() => editConfigText('', { 'usage_pause.threshold_percent': 'ninety' }, [])).toThrow(SettingEditError);
    expect(() => editConfigText('', { 'review.mode': 'sometimes' }, [])).toThrow(/one of off, low_high, separate/);
  });

  // INVARIANT: the form edits only what the policy lets a project set; a key
  // the installation decides is refused rather than written.
  test('refuses keys the form cannot edit', () => {
    expect(() => editConfigText('', { 'runner.type': 'host-process' }, [])).toThrow(SettingEditError);
    expect(() => editConfigText('', { 'permissions.protected': 'x' }, [])).toThrow(SettingEditError);
  });
});
