/**
 * INVARIANT: every turn launch checks for a member inside the task
 * (`refuseLaunchWhileMemberInside`, reached through
 * `mustRecreateForCredentialPlan` / `prepareTurnLaunch`) and flips the task to
 * `working` INSIDE `withTaskLifecycleLock`. A member's entry
 * (src/daemon/member-entry.ts) takes the same lock; a launch path outside it
 * could pass the check just before a member got in, and run a turn on the
 * worktree underneath them.
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
    // The start path: its member check and its flip to `working`.
    ['src/daemon/task-launcher.ts', 'refuseLaunchWhileMemberInside\\('],
    ['src/daemon/task-launcher.ts', "storage\\.updateTaskStatus\\(t\\.id, 'working'"],
  ] as const) {
    test(`${file}: every /${callee}/ is inside withTaskLifecycleLock`, async () => {
      const src = await readFile(join(ROOT, file), 'utf-8');
      expect(new RegExp(callee).test(src)).toBe(true);
      expect(unlockedCalls(src, callee)).toEqual([]);
    });
  }
});

// INVARIANT: a launch refused because a member has a terminal open on the task
// is refused BEFORE it records a turn. A human turn written ahead of the
// refusal is half-dispatched: the task stays paused, and the redelivery path
// later hands its text to the agent as unconsumed feedback. The human's words
// are kept by the surface that sent them (recovery file, review draft, Teams'
// ask record) until a delivery succeeds.
describe('a launch refuses a member-occupied task before it records anything', () => {
  for (const [label, anchor] of [
    ['unblock', 'while the unblock was being prepared'],
    ['ask', 'assertAskableStatus(task, fresh.status);'],
    ['review', 'assertReviewableStatus(task, fresh.status);'],
    ['manual resume', '// --- Persist state BEFORE launch ---\n    // The resume notice'],
  ] as const) {
    test(`${label}: assertNoMemberInside precedes its first turn write`, async () => {
      const src = await readFile(join(ROOT, 'src/daemon/task-lifecycle.ts'), 'utf-8');
      const at = src.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      const guard = src.indexOf('assertNoMemberInside(task.id)', at);
      const writes = ['storage.createTurn(', 'claimSyncTurn(']
        .map((w) => src.indexOf(w, at))
        .filter((i) => i > -1);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(Math.min(...writes));
    });
  }
});

// INVARIANT: a manual resume checks for a member and writes its notice turn
// INSIDE the lifecycle lock, with the launch — a member's entry between the
// check and the write would otherwise leave a notice for a resume refused
// moments later.
test("manual resume's member check and notice turn are inside the lifecycle lock", async () => {
  const src = await readFile(join(ROOT, 'src/daemon/task-lifecycle.ts'), 'utf-8');
  const notice = src.indexOf("'[system] Session interrupted and resumed'");
  const check = src.lastIndexOf('assertNoMemberInside(task.id)', notice);
  expect(notice).toBeGreaterThan(-1);
  const ranges = lockedRanges(src);
  for (const at of [notice, check]) {
    expect(ranges.some(([a, b]) => at > a && at < b)).toBe(true);
  }
});

// INVARIANT: the daemon's own launches — auto-resume and auto-deliver — write
// their synthetic turn INSIDE the lifecycle lock and AFTER the in-lock member
// check (mustRecreateForCredentialPlan), as manual resume does. Written before
// it, a launch the check refused left a notice for a resume that never
// happened, or a feedback-carrying turn nobody dispatched that redelivery would
// later hand the agent again.
for (const [file, marker] of [
  ['src/utils/auto-resume.ts', "'[system] Session interrupted and auto-resumed'"],
  ['src/daemon/auto-deliver.ts', 'content: `[system] ${safeMessage}`'],
] as const) {
  test(`${file}: the synthetic turn is written inside the lock, after the member check`, async () => {
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
