import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { classifyDoctorCheck, DOCTOR_CHECK_FAMILIES } from '../../src/doctor/check-families';
import { toStructuredCheck } from '../../src/doctor/registry';
import { reportDaemonCredentials } from '../../src/doctor/sweep';

const SWEEP = join(import.meta.dir, '../../src/doctor/sweep.ts');

/** Every label the sweep spells as a literal: `label: '…'`, `label: \`…\``, `const label = '…'`. */
async function sweepLabels(): Promise<string[]> {
  const src = await readFile(SWEEP, 'utf-8');
  const labels = new Set<string>();
  const patterns = [/label: '([^']+)'/g, /label: `([^`$]+)/g, /const label = '([^']+)'/g];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) labels.add(m[1]!);
  }
  labels.add('Model credential present');
  return [...labels];
}

describe('doctor check families', () => {
  // INVARIANT: every fixed label the sweep emits maps to a named family. Lazy
  // Teams reacts to findings by family (self-heal, operator, user notice); a
  // label renamed without its table entry would silently drop to the
  // conservative default and change what Teams does with it.
  test('every literal sweep label is classified', async () => {
    const unclassified = (await sweepLabels()).filter(
      label => !DOCTOR_CHECK_FAMILIES.some(rule => label.startsWith(rule.prefix)),
    );
    expect(unclassified).toEqual([]);
  });

  test('a label variant keeps its family', () => {
    expect(classifyDoctorCheck('Git installed (v2.44.0)', 'x').family).toBe('git-installed');
    expect(classifyDoctorCheck('No stale runner images (skipped — runtime unavailable)', 'x').family).toBe('stale-images');
  });

  test('longest prefix wins', () => {
    const c = classifyDoctorCheck('Daemon holds the storage lock but is not serving storage', 'x');
    expect(c).toEqual({ family: 'storage-lock', remedyKind: 'restart-daemon', impact: 'work' });
  });

  // INVARIANT: `flag` is claimed only when a remedy flag is actually present.
  // A client applies `doctor.applyRemedy(remedyFlag)` on `flag`; promising one
  // that is not there would send it an undefined flag.
  test('flag kind requires a remedy flag', () => {
    expect(classifyDoctorCheck('No orphaned containers', 'x').remedyKind).toBe('manual');
    expect(classifyDoctorCheck('No orphaned containers', 'x', 'clean-orphaned-containers').remedyKind).toBe('flag');
  });

  // INVARIANT: an unknown check is operator-only — never acted on, never shown to users.
  test('unknown label defaults to manual/setup with its own id as family', () => {
    expect(classifyDoctorCheck('Something new', 'something-new')).toEqual({
      family: 'something-new', remedyKind: 'manual', impact: 'setup',
    });
  });

  test('structured checks carry the classification', () => {
    const s = toStructuredCheck({ ok: false, label: 'Disk space adequate', detail: 'low' });
    expect(s).toMatchObject({ family: 'disk-space', remedyKind: 'host', impact: 'work', status: 'error' });
    const o = toStructuredCheck({
      ok: false, label: 'Docker daemon running', detail: 'down',
      classification: { family: 'runner-health', remedyKind: 'host', impact: 'work' },
    });
    expect(o.family).toBe('runner-health');
  });

  // INVARIANT: per-provider credential lines share the model-credential family.
  // Their labels name the provider and its profiles, so the label table cannot
  // classify them; without the push-site tag they would fall to operator-only
  // and a missing credential would never reach the people whose work it stops.
  test('daemon credential lines are classified as model-credential', () => {
    const base = { label: 'Anthropic', requiredBy: ['default'], source: 'env', via: 'X' };
    const lines = reportDaemonCredentials([
      { name: 'anthropic', present: true, ...base },
      { name: 'openai', present: false, ...base, label: 'OpenAI', source: null, via: null },
      { name: 'ollama', present: false, error: 'index unreadable', ...base, label: 'Ollama' },
    ] as never);
    const structured = lines.map(line => toStructuredCheck(line));
    expect(structured.map(c => c.family)).toEqual(['model-credential', 'model-credential', 'model-credential']);
    expect(structured.every(c => c.remedyKind === 'credential' && c.impact === 'work')).toBe(true);
    expect(toStructuredCheck(reportDaemonCredentials([])[0]!).family).toBe('model-credential');
  });
});
