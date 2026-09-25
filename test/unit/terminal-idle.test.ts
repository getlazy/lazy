/**
 * INVARIANT: a member's terminal cannot keep turns off a task forever. It is
 * closed after an hour with nobody typing in it (output does not count — see
 * test/unit/terminal-idle-input-only.test.ts), and after
 * twelve hours in any case (src/server/terminal-idle.ts) — a forgotten browser
 * tab would otherwise hold every turn, auto-resume and auto-delivery off the
 * task indefinitely.
 */

import { describe, test, expect } from 'bun:test';
import { watchTerminalIdle, terminalExpiredMessage, MEMBER_TERMINAL_IDLE_MS, MEMBER_TERMINAL_MAX_MS } from '../../src/server/terminal-idle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('member terminal limits', () => {
  test('an idle terminal expires; activity keeps it open', async () => {
    let t = 0;
    const fired: string[] = [];
    const watch = watchTerminalIdle({ idleMs: 100, maxMs: 10_000 }, (r) => fired.push(r), { now: () => t, checkEveryMs: 2 });
    t = 90; await sleep(10);
    watch.touch();
    t = 180; await sleep(10);
    expect(fired).toEqual([]);
    t = 200; await sleep(10);
    expect(fired).toEqual(['idle']);
    watch.stop();
  });

  test('a busy terminal still expires at the maximum, once', async () => {
    let t = 0;
    const fired: string[] = [];
    const watch = watchTerminalIdle({ idleMs: 100, maxMs: 300 }, (r) => fired.push(r), { now: () => t, checkEveryMs: 2 });
    for (const at of [80, 160, 240, 310]) { t = at; watch.touch(); await sleep(10); }
    await sleep(10);
    expect(fired).toEqual(['max']);
    watch.stop();
  });

  test('the defaults are an hour idle and twelve hours in all, and the terminal is told why', () => {
    expect(MEMBER_TERMINAL_IDLE_MS).toBe(3_600_000);
    expect(MEMBER_TERMINAL_MAX_MS).toBe(43_200_000);
    expect(terminalExpiredMessage('idle', { idleMs: MEMBER_TERMINAL_IDLE_MS, maxMs: MEMBER_TERMINAL_MAX_MS })).toContain('60 minutes');
    expect(terminalExpiredMessage('max', { idleMs: MEMBER_TERMINAL_IDLE_MS, maxMs: MEMBER_TERMINAL_MAX_MS })).toContain('12 hours');
  });
});
