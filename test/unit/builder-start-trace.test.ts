import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger';
import { BuilderStartTrace } from '../../src/daemon/builder-start-trace';

describe('BuilderStartTrace', () => {
  let lines: string[];
  let spies: Array<{ mockRestore(): void }>;
  beforeEach(() => {
    lines = [];
    spies = [
      spyOn(logger, 'info').mockImplementation((m: string) => { lines.push(`INFO ${m}`); }),
      spyOn(logger, 'warn').mockImplementation((m: string) => { lines.push(`WARN ${m}`); }),
    ];
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  // INVARIANT: every line of one builder start carries the same searchable
  // prefix with the builder id, and the run id from the moment it is known —
  // the run id is what the Teams URL shows, so a god-mode Logs search for it
  // must find every phase after the row exists. A start used to leave one line
  // keyed by an id nobody searched for.
  test('every line carries the builder id, and the run id once known', async () => {
    const trace = new BuilderStartTrace('abcd1234', 'alice@example.com');
    trace.begin();
    await trace.phase('credential plan', async () => 1);
    trace.setRunId('6df831a8-run');
    await trace.phase('container image', async () => 2);
    trace.finish('running');
    expect(lines.every((l) => l.includes('builder start [run ') && l.includes('builder abcd1234]'))).toBe(true);
    expect(lines[1]).toContain('run not yet created');
    expect(lines[1]).toMatch(/credential plan took \d+ms/);
    expect(lines.slice(2).every((l) => l.includes('run 6df831a8-run'))).toBe(true);
    expect(lines.some((l) => l.includes('container lazy-builder-abcd1234'))).toBe(true);
  });

  // INVARIANT: a failed phase is a WARN naming the phase and its real cause,
  // and the error still propagates to the caller unchanged.
  test('a failed phase logs WARN with its cause and rethrows', async () => {
    const trace = new BuilderStartTrace('abcd1234', null);
    const boom = new Error('docker: no space left on device');
    await expect(trace.phase('docker run', async () => { throw boom; })).rejects.toBe(boom);
    expect(lines.at(-1)).toStartWith('WARN ');
    expect(lines.at(-1)).toContain('docker run FAILED after');
    expect(lines.at(-1)).toContain('no space left on device');
  });
});

describe('BuilderStartTrace on an existing row', () => {
  // INVARIANT: a start that finds the member's builder already running names
  // THAT builder's container, never the id the trace minted for a launch that
  // did not happen — the trail must not point at a container that never existed.
  test('names the existing row\'s builder, and re-maps when a launch claims the row', () => {
    const lines: string[] = [];
    const spy = spyOn(logger, 'info').mockImplementation((m: string) => { lines.push(m); });
    try {
      const trace = new BuilderStartTrace('fresh000', null);
      trace.setRunId('run-1', 'old11111');
      trace.setRunId('run-1', 'old11111');
      trace.setRunId('run-1');
      expect(lines.filter((l) => l.includes('is builder'))).toEqual([
        expect.stringContaining('run run-1 is builder old11111 (container lazy-builder-old11111)'),
        expect.stringContaining('run run-1 is builder fresh000 (container lazy-builder-fresh000)'),
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
