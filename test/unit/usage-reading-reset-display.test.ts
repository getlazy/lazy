/**
 * A stored usage reading outlives the window it describes. Once the window's
 * reset time passes (or an untimed reading ages out), every surface must show
 * it as reset — the same answer the pause policy gives — never the old figure.
 */
import { describe, test, expect } from 'bun:test';
import { renderUsageWindow } from '../../src/cli/commands/limits';
import { currentWindow, projectUsageLimits } from '../../src/usage-pause/limits-view';
import { evaluateUsagePause, readingCoverage,STALE_UNTIMED_READING_MS, windowResetSince } from '../../src/usage-pause/policy';
import type { UsageLimitReading } from '../../src/proxy/usage-limits';

const HOUR = 3_600_000;
const readAt = Date.UTC(2026, 8, 25, 1, 4);
const now = readAt + 8 * HOUR;
const reading: UsageLimitReading = {
  credential: 'credential:ChatGPT subscription', ts: readAt,
  upstream: 'https://chatgpt.com/backend-api/codex', backend: 'codex', status: 429,
  taskId: null, model: null, headers: {},
  windows: [
    { name: 'codex-primary', usedPercent: 100, resetsAt: readAt + 2 * HOUR, status: null },
    { name: 'codex-secondary', usedPercent: 74, resetsAt: readAt + 32 * HOUR, status: null },
    { name: 'codex-untimed', usedPercent: 90, resetsAt: null, status: 'rejected' },
  ],
};
const pause = { configured: { threshold_percent: 80, credentials: {} }, override: null, paused: [], held: [] };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('a usage window past its reset', () => {
  // INVARIANT: the text surface never prints a percentage as current for a
  // window whose reset has passed. The engineer read "100% used" of a Codex
  // window that had reset eight hours earlier and was actually at 0%.
  test('text: shown as reset, old figure as history', () => {
    const [primary, secondary, untimed] = reading.windows;
    const p = strip(renderUsageWindow(primary, reading.ts, now));
    expect(p).toContain('reset at');
    expect(p).toContain('was 100% used, read 8h ago');
    expect(p).not.toMatch(/100% used\s+·/);
    expect(strip(renderUsageWindow(secondary, reading.ts, now))).toMatch(/74% used/);
    expect(strip(renderUsageWindow(untimed, reading.ts, now))).toContain('reading aged out');
    // A fresh untimed reading is still current.
    expect(strip(renderUsageWindow(untimed, reading.ts, reading.ts + 60_000))).toMatch(/90% used/);
  });

  // INVARIANT: the JSON / MCP view nulls the percentage of a reset window and
  // marks when it reset, keeping the stored numbers in storedWindows.
  test('json: usedPercent null, resetSince set, stored reading kept', () => {
    const [r] = projectUsageLimits([reading], pause, now).readings;
    expect(r.windows[0]).toMatchObject({ usedPercent: null, status: null, resetSince: readAt + 2 * HOUR });
    expect(r.windows[1]).toMatchObject({ usedPercent: 74, resetSince: null });
    expect(r.windows[2]).toMatchObject({ usedPercent: null, resetSince: readAt + STALE_UNTIMED_READING_MS });
    expect(r.storedWindows).toEqual(reading.windows);
  });

  test('a reset status-only window keeps its old status as history', () => {
    const w = { name: 'unified', usedPercent: null, resetsAt: readAt + HOUR, status: 'rejected' };
    expect(strip(renderUsageWindow(w, readAt, now))).toContain('(was rejected, read 8h ago)');
  });

  // INVARIANT: coverage agrees with the display — a reading whose windows have
  // all reset is `stale`, and every window then shows as reset.
  test('coverage uses the same reset answer', () => {
    const allReset = { ...reading, windows: reading.windows.slice(0, 1) };
    expect(readingCoverage(allReset, (ws) => ws, now)).toBe('stale');
    expect(currentWindow(allReset.windows[0], readAt, now).resetSince).not.toBeNull();
    expect(readingCoverage(reading, (ws) => ws, now)).toBe('reading');
  });

  // INVARIANT: display and pause answer "has it reset" from one function, so
  // a window the pause ignores is exactly a window the display shows as reset.
  test('display agrees with the pause policy', () => {
    for (const t of [readAt + 60_000, readAt + HOUR, now, readAt + 40 * HOUR]) {
      for (const w of reading.windows) {
        const displayedReset = currentWindow(w, reading.ts, t).resetSince !== null;
        const alone = { ...reading, windows: [{ ...w, usedPercent: 100 }] };
        const paused = evaluateUsagePause(alone, (ws) => ws, 80, t) !== null;
        expect(displayedReset).toBe(windowResetSince(w, reading.ts, t) !== null);
        expect(paused).toBe(!displayedReset);
      }
    }
  });
});
