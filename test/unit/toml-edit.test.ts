/**
 * Unit tests for the comment-preserving TOML editor behind `lazy protect`.
 *
 * INVARIANT: editing lazy.toml must not destroy its comments. The file written
 * by `lazy init` is mostly documentation, and a parse→stringify round trip
 * would silently delete all of it — which is exactly why this text-level
 * editor exists instead.
 */

import { describe, test, expect } from 'bun:test';
import { setSectionStringArray, setSectionBoolean, TomlEditError } from '../../src/config/toml-edit';

describe('setSectionStringArray', () => {
  test('adds a key to an existing section without touching its comments', () => {
    const input = [
      '[protection]',
      '# Protected branches (OPT-IN, off by default).',
      'enabled = true',
      '# protected_branches = ["release"]',
      '',
      '[automation]',
      'maintain = []',
      '',
    ].join('\n');

    const out = setSectionStringArray(input, 'protection', 'protected_branches', ['release']);

    expect(out).toContain('# Protected branches (OPT-IN, off by default).');
    expect(out).toContain('# protected_branches = ["release"]'); // the commented doc line survives
    expect(out).toContain('enabled = true');
    // Inserted inside [protection], before the blank line separating sections.
    expect(out.indexOf('protected_branches = ["release"]\n')).toBeGreaterThan(out.indexOf('enabled = true'));
    expect(out.indexOf('protected_branches = ["release"]\n')).toBeLessThan(out.indexOf('[automation]'));
    expect(out).toContain('[automation]\nmaintain = []');
  });

  // INVARIANT: a commented-out `# key = ...` is documentation, not a value.
  // Editing must never uncomment or overwrite it — it stays as the example.
  test('does not treat a commented-out key as the existing value', () => {
    const input = '[protection]\n# protected_tasks = ["example"]\n';
    const out = setSectionStringArray(input, 'protection', 'protected_tasks', ['real']);
    expect(out).toContain('# protected_tasks = ["example"]');
    expect(out).toContain('protected_tasks = ["real"]');
  });

  test('replaces an existing value in place, keeping order and indentation', () => {
    const input = '[protection]\nenabled = true\nprotected_branches = ["release"]\npassphrase_file = "x"\n';
    const out = setSectionStringArray(input, 'protection', 'protected_branches', ['release', 'main']);
    expect(out).toBe('[protection]\nenabled = true\nprotected_branches = ["release", "main"]\npassphrase_file = "x"\n');
  });

  test('collapses a multi-line array into one line', () => {
    const input = [
      '[protection]',
      'protected_branches = [',
      '  "release",',
      '  "staging",',
      ']',
      'enabled = true',
      '',
    ].join('\n');
    const out = setSectionStringArray(input, 'protection', 'protected_branches', ['release']);
    expect(out).toBe('[protection]\nprotected_branches = ["release"]\nenabled = true\n');
  });

  // A multi-line array elsewhere in the file must not confuse the section
  // scanner: its `[`-opened continuation lines are not section headers.
  test('is not confused by multi-line arrays in other sections', () => {
    const input = [
      '[permissions]',
      'protected = [',
      '  "test/**",',
      ']',
      '',
      '[protection]',
      'enabled = true',
      '',
    ].join('\n');
    const out = setSectionStringArray(input, 'protection', 'protected_tasks', ['abc']);
    expect(out).toContain('protected = [\n  "test/**",\n]');
    expect(out).toContain('[protection]\nenabled = true\nprotected_tasks = ["abc"]');
  });

  test('creates the section when it is missing', () => {
    const input = '[remote]\ndriver = "local"\n';
    const out = setSectionStringArray(input, 'protection', 'protected_branches', ['main']);
    expect(out).toBe('[remote]\ndriver = "local"\n\n[protection]\nprotected_branches = ["main"]\n');
  });

  test('writes an explicit empty array when the last entry is removed', () => {
    const input = '[protection]\nprotected_branches = ["release"]\n';
    const out = setSectionStringArray(input, 'protection', 'protected_branches', []);
    expect(out).toBe('[protection]\nprotected_branches = []\n');
  });

  test('escapes quotes and backslashes in values', () => {
    const out = setSectionStringArray('', 'protection', 'protected_branches', ['a"b\\c']);
    expect(out).toContain('protected_branches = ["a\\"b\\\\c"]');
  });

  // INVARIANT: shapes this editor cannot rewrite safely must FAIL LOUDLY.
  // Silently appending a second definition would produce a lazy.toml whose
  // meaning depends on which one the parser wins with.
  test('rejects a dotted top-level key rather than mis-editing it', () => {
    const input = 'protection.protected_branches = ["release"]\n';
    expect(() => setSectionStringArray(input, 'protection', 'protected_branches', ['main']))
      .toThrow(TomlEditError);
  });

  test('rejects an inline-table section rather than mis-editing it', () => {
    const input = 'protection = { enabled = true }\n';
    expect(() => setSectionStringArray(input, 'protection', 'protected_branches', ['main']))
      .toThrow(TomlEditError);
  });

  test('round-trips through Bun.TOML.parse with the expected values', () => {
    let content = '[protection]\n# comment\nenabled = true\n';
    content = setSectionStringArray(content, 'protection', 'protected_branches', ['release']);
    content = setSectionStringArray(content, 'protection', 'protected_tasks', ['add-auth']);
    content = setSectionStringArray(content, 'protection', 'protected_branches', ['release', 'main']);

    const parsed = Bun.TOML.parse(content) as { protection: Record<string, unknown> };
    expect(parsed.protection.enabled).toBe(true);
    expect(parsed.protection.protected_branches).toEqual(['release', 'main']);
    expect(parsed.protection.protected_tasks).toEqual(['add-auth']);
    expect(content).toContain('# comment');
  });
});

/**
 * `lazy protect <target> on` engages the opt-in master switch as well as
 * editing the list, so the editor needs a boolean setter with the same
 * comment-preserving guarantees.
 */
describe('setSectionBoolean', () => {
  test('adds enabled = true to a section that only documents it in comments', () => {
    const input = [
      '[protection]',
      '# OPT-IN: off by default.',
      '# enabled = true',
      '',
      '[automation]',
      'maintain = []',
      '',
    ].join('\n');

    const out = setSectionBoolean(input, 'protection', 'enabled', true);

    // The commented doc line is documentation, not the value — it survives.
    expect(out).toContain('# enabled = true');
    expect(out).toContain('# OPT-IN: off by default.');
    const parsed = Bun.TOML.parse(out) as { protection: Record<string, unknown> };
    expect(parsed.protection.enabled).toBe(true);
    expect(out.indexOf('\nenabled = true')).toBeLessThan(out.indexOf('[automation]'));
  });

  test('replaces an existing value in place', () => {
    const input = '[protection]\nenabled = false\nprotected_branches = ["release"]\n';
    const out = setSectionBoolean(input, 'protection', 'enabled', true);
    const parsed = Bun.TOML.parse(out) as { protection: Record<string, unknown> };
    expect(parsed.protection.enabled).toBe(true);
    expect(parsed.protection.protected_branches).toEqual(['release']);
    expect(out).not.toContain('enabled = false');
  });

  test('creates the section when it does not exist', () => {
    const out = setSectionBoolean('[remote]\ndriver = "local"\n', 'protection', 'enabled', true);
    const parsed = Bun.TOML.parse(out) as { protection: Record<string, unknown>; remote: Record<string, unknown> };
    expect(parsed.protection.enabled).toBe(true);
    expect(parsed.remote.driver).toBe('local');
  });
});
