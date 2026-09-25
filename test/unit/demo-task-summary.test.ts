/**
 * The seeded-task summary `lazy playground up` prints, against the tasks it seeds.
 *
 * This test exists because a comment claimed it already did. `src/cli/commands/
 * demo.ts` said `DEMO_TASK_CODES` was imported "so a task added to the seed
 * without a line here fails the discoverability test" — nothing enforced that,
 * the import was only there to avoid an unused-symbol warning, and the two lists
 * had already drifted out of order. A comment asserting a guard nothing
 * implements is worse than no comment, because the next reader trusts it.
 */

import { describe, test, expect } from 'bun:test';
import { SEEDED_TASK_DESCRIPTIONS, seededTaskSummary } from '../../src/cli/commands/demo';
import { DEMO_TASK_CODES, SEEDS, demoScript } from '../../src/demo/seed';

describe('the printed seeded-task summary', () => {
  // INVARIANT: every task the demo seeds is described to the human who just
  // created it. A seeded task with no line is invisible in the one place that
  // explains what the demo contains — which is the whole value of that output.
  test('describes every task the demo seeds', () => {
    const missing = DEMO_TASK_CODES.filter(code => !SEEDED_TASK_DESCRIPTIONS[code]);
    expect(missing).toEqual([]);
  });

  // INVARIANT: and nothing else. A description for a code that is no longer
  // seeded is a line about a task nobody will find, which is the same drift in
  // the other direction.
  test('describes nothing the demo does not seed', () => {
    const codes = new Set<string>(DEMO_TASK_CODES);
    const orphans = Object.keys(SEEDED_TASK_DESCRIPTIONS).filter(code => !codes.has(code));
    expect(orphans).toEqual([]);
  });

  // The rendered output walks DEMO_TASK_CODES, so the two cannot disagree about
  // order — there is only one order. Pinned because the previous version kept a
  // second hand-ordered list that had already diverged.
  test('renders in the order the demo creates them', () => {
    const lines = seededTaskSummary();

    expect(lines).toHaveLength(DEMO_TASK_CODES.length);
    DEMO_TASK_CODES.forEach((code, index) => {
      expect(lines[index].startsWith(code)).toBe(true);
    });
  });

  test('every line carries its description', () => {
    for (const line of seededTaskSummary()) {
      expect(line).not.toContain('no description');
      // code + padding + something to read
      expect(line.trim().split(/\s{2,}/).length).toBeGreaterThan(1);
    }
  });
});

/**
 * The seeded task set is spelled out THREE times in `src/demo/seed.ts` —
 * `DEMO_TASK_CODES` (the order), `SEEDS` (what is created) and `demoScript()`
 * (what each task's agent does). Only the first pair was guarded.
 *
 * The failure modes are quiet, which is why this is worth pinning. Add a task to
 * `SEEDS` alone and it is created but missing from the printed summary. Forget
 * `demoScript()` and it silently falls through to the generic no-script turn —
 * a task that looks seeded and does something else entirely.
 *
 * This is the check the comment removed two rounds ago was pretending to be.
 */
describe('the three seeded-task lists agree', () => {
  const codes = DEMO_TASK_CODES as readonly string[];

  // INVARIANT: the ordering list and the definitions list describe the same
  // tasks, in the same order. `seedDemoTasks` returns `SEEDS.map(s => s.code)`
  // as the manifest's `seededTasks`, so a disagreement here is a manifest that
  // misreports what the demo contains.
  test('DEMO_TASK_CODES and SEEDS are the same tasks in the same order', () => {
    expect(SEEDS.map(seed => seed.code)).toEqual([...codes]);
  });

  // INVARIANT: every scripted task is a task that exists. A script keyed by a
  // code nothing creates is dead weight that reads as coverage.
  test('every demoScript key is a task the demo actually seeds', () => {
    const scripted = Object.keys(demoScript());
    const unknown = scripted.filter(code => !codes.includes(code));
    expect(unknown).toEqual([]);
  });

  // INVARIANT: every task that is STARTED has a script. `demo-backlog` is the
  // sole exception and it is asserted rather than excused — it is never started,
  // so a script for it would never run. Any other task missing one silently gets
  // the generic no-script turn instead of the state it is meant to demonstrate.
  test('every started task has a script, and only demo-backlog lacks one', () => {
    const scripted = new Set(Object.keys(demoScript()));
    const unscripted = codes.filter(code => !scripted.has(code));
    expect(unscripted).toEqual(['demo-backlog']);
  });

  // And the printed summary covers all three: it is keyed by code and rendered
  // by walking DEMO_TASK_CODES, so this closes the loop.
  test('every seeded task is described in the printed summary', () => {
    expect(SEEDS.filter(seed => !SEEDED_TASK_DESCRIPTIONS[seed.code])).toEqual([]);
  });
});
