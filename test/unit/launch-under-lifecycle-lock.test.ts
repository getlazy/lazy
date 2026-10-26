/**
 * INVARIANT: every turn launch decides its credential and container
 * (`mustRecreateForCredentialPlan` / `prepareTurnLaunch`) and flips the task
 * to `working` INSIDE `withTaskLifecycleLock`, the lock every other lifecycle
 * change (accept, reject, close, sync) takes, so no two of them interleave.
 *
 * It used to also carry a check for a member inside the task; that check is
 * RETIRED (engineer, 2026-10-21): a member's sessions and a turn never block
 * each other, exactly like solo `lazy shell <task>`. The last test below
 * keeps it from coming back.
 *
 * A source scan, because the property is WHERE a call sits: every
 * `prepareTurnLaunch(` / `mustRecreateForCredentialPlan(` call in the launch
 * modules must fall inside the argument list of a `withTaskLifecycleLock(`
 * call. Parentheses are balanced (ignoring strings and comments crudely, which
 * these files do not trip) rather than lines read, so a call formatted across
 * lines cannot hide.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');

/** Index ranges covered by the argument lists of every `withTaskLifecycleLock(` call. */
function lockedRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /withTaskLifecycleLock\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) { ranges.push([open, i]); break; }
      }
    }
  }
  return ranges;
}

function unlockedCalls(src: string, callee: string): number[] {
  const ranges = lockedRanges(src);
  const out: number[] = [];
  const re = new RegExp(`(?<![\\w.])${callee}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Skip the definition and imports.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/function\s/.test(line) || /^\s*(import|export)\b/.test(line) || /^\s*(\*|\/\/)/.test(line)) continue;
    if (!ranges.some(([a, b]) => m!.index > a && m!.index < b)) {
      out.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return out;
}

describe('turn launches decide their container under the lifecycle lock', () => {
  for (const [file, callee] of [
    ['src/daemon/task-lifecycle.ts', 'prepareTurnLaunch\\('],
    ['src/utils/auto-resume.ts', 'mustRecreateForCredentialPlan\\('],
    ['src/daemon/auto-deliver.ts', 'mustRecreateForCredentialPlan\\('],
    // The start path: its flip to `working`.
    ['src/daemon/task-launcher.ts', "storage\\.updateTaskStatus\\(t\\.id, 'working'"],
  ] as const) {
    test(`${file}: every /${callee}/ is inside withTaskLifecycleLock`, async () => {
      const src = await readFile(join(ROOT, file), 'utf-8');
      expect(new RegExp(callee).test(src)).toBe(true);
      expect(unlockedCalls(src, callee)).toEqual([]);
    });
  }
});

// INVARIANT: a manual resume writes its notice turn INSIDE the lifecycle
// lock, with the launch — never a notice for a resume refused moments later.
test("manual resume's notice turn is inside the lifecycle lock", async () => {
  const src = await readFile(join(ROOT, 'src/daemon/task-lifecycle.ts'), 'utf-8');
  const notice = src.indexOf("'[system] Session interrupted and resumed'");
  expect(notice).toBeGreaterThan(-1);
  expect(lockedRanges(src).some(([a, b]) => notice > a && notice < b)).toBe(true);
});

// INVARIANT (engineer, 2026-10-21): no launch path refuses a turn because a
// member is inside the task. The guards that did are gone from every launch
// module, and must not come back under another name in these files.
test('no launch path consults the member hold', async () => {
  for (const file of ['src/daemon/task-lifecycle.ts', 'src/daemon/task-launcher.ts', 'src/utils/auto-resume.ts', 'src/daemon/auto-deliver.ts', 'src/daemon/turn-credentials.ts', 'src/daemon/sync-retry.ts']) {
    const src = await readFile(join(ROOT, file), 'utf-8');
    expect(src).not.toMatch(/refuseLaunchWhileMemberInside|assertNoMemberInside|standDownForMember|queueIfMemberInside/);
  }
});

// INVARIANT: the daemon's own launches — auto-resume and auto-deliver — write
// their synthetic turn INSIDE the lifecycle lock and AFTER the in-lock
// credential plan (mustRecreateForCredentialPlan), as manual resume does. Written before
// it, a launch the check refused left a notice for a resume that never
// happened, or a feedback-carrying turn nobody dispatched that redelivery would
// later hand the agent again.
for (const [file, marker] of [
  ['src/utils/auto-resume.ts', "'[system] Session interrupted and auto-resumed'"],
  ['src/daemon/auto-deliver.ts', 'content: `[system] ${neutralizeLazyMarkers(safeMessage)}`'],
] as const) {
  test(`${file}: the synthetic turn is written inside the lock, after the credential plan`, async () => {
    const src = await readFile(join(ROOT, file), 'utf-8');
    const turn = src.indexOf(marker);
    expect(turn).toBeGreaterThan(-1);
    const range = lockedRanges(src).find(([a, b]) => turn > a && turn < b);
    expect(range).toBeDefined();
    const check = src.indexOf('mustRecreateForCredentialPlan(', range![0]);
    expect(check).toBeGreaterThan(range![0]);
    expect(check).toBeLessThan(turn);
  });
}
