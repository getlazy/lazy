/**
 * Unit tests for the presentation marker (final-turn design §6.2) — the
 * protocol-dir signal the `lazy_report` handler writes when a report carries a
 * presentation and the wrap-up's presentation step reads to enforce §6.2.
 *
 * The marker is a SIGNAL, never the record: the durable fact lives in the
 * stored report. What is pinned here is the mechanics the enforcement leans on
 * — an absent, corrupt, or unrecognized file must read as "not declared" (the
 * recoverable direction: the step parks a task that owes its reader a
 * walkthrough, instead of waving one through), and a clear must never throw.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PRESENTATION_MARKER_FILE,
  writePresentationMarker,
  readPresentationMarker,
  clearPresentationMarker,
} from '../../src/protocol/presentation-marker';

let protoDir: string;
let logLines: string[] = [];
const log = (message: string): void => { logLines.push(message); };

beforeEach(async () => {
  protoDir = await mkdtemp(join(tmpdir(), 'lazy-presentation-marker-'));
  logLines = [];
});

afterEach(async () => {
  await rm(protoDir, { recursive: true, force: true });
});

describe('writePresentationMarker / readPresentationMarker', () => {
  test('a written marker reads back as declared, creating the dir if needed', async () => {
    const nested = join(protoDir, 'task-abc');
    await writePresentationMarker(nested, '2026-01-01T00:00:00.000Z');
    const read = await readPresentationMarker(nested, log);
    expect(read).toEqual({ version: 1, declared_at: '2026-01-01T00:00:00.000Z' });
  });

  test('write stamps the current time when no declared_at is given', async () => {
    await writePresentationMarker(protoDir);
    const read = await readPresentationMarker(protoDir, log);
    expect(read?.version).toBe(1);
    expect(typeof read?.declared_at).toBe('string');
    expect(Number.isNaN(Date.parse(read?.declared_at ?? ''))).toBe(false);
  });

  test('a missing file reads as not declared — the normal case', async () => {
    expect(await readPresentationMarker(protoDir, log)).toBeNull();
    expect(logLines).toEqual([]);
  });

  test('a corrupt file degrades to not declared, with a warning', async () => {
    await writeFile(join(protoDir, PRESENTATION_MARKER_FILE), '{not json', 'utf-8');
    expect(await readPresentationMarker(protoDir, log)).toBeNull();
    expect(logLines.length).toBe(1);
    expect(logLines[0]).toContain('corrupt');
  });

  test('an unrecognized shape degrades to not declared — never a fabricated declaration', async () => {
    // v2 some day, or a hand-edited file with a missing timestamp.
    await writeFile(
      join(protoDir, PRESENTATION_MARKER_FILE),
      JSON.stringify({ version: 2, declared_at: '2026-01-01' }),
      'utf-8',
    );
    expect(await readPresentationMarker(protoDir, log)).toBeNull();
    expect(logLines[0]).toContain('unrecognized shape');

    await writeFile(
      join(protoDir, PRESENTATION_MARKER_FILE),
      JSON.stringify({ version: 1 }),
      'utf-8',
    );
    logLines = [];
    expect(await readPresentationMarker(protoDir, log)).toBeNull();
  });

  test('the marker survives a rewrite (last writer wins, no merge needed)', async () => {
    // Two concurrent lazy_report calls racing on one daemon-side write both
    // mean "declared"; whole-file atomic writes make last-wins safe.
    await writePresentationMarker(protoDir, '2026-01-01T00:00:00.000Z');
    await writePresentationMarker(protoDir, '2026-01-02T00:00:00.000Z');
    const read = await readPresentationMarker(protoDir, log);
    expect(read?.declared_at).toBe('2026-01-02T00:00:00.000Z');
  });

  test('no half-file is ever visible: the write lands via temp+rename', async () => {
    // After a successful write only the marker exists — the temp file is gone.
    await writePresentationMarker(protoDir, '2026-01-01T00:00:00.000Z');
    const entries = await Array.fromAsync(new Bun.Glob('presentation.json*').scan({ cwd: protoDir }));
    expect(entries).toEqual([PRESENTATION_MARKER_FILE]);
  });
});

describe('clearPresentationMarker', () => {
  test('clears an existing marker', async () => {
    await writePresentationMarker(protoDir);
    await clearPresentationMarker(protoDir, log);
    expect(await readPresentationMarker(protoDir, log)).toBeNull();
    expect(logLines).toEqual([]);
  });

  test('a missing marker is success, not an error', async () => {
    await clearPresentationMarker(protoDir, log);
    expect(logLines).toEqual([]);
  });

  test('an unclearable marker warns instead of throwing — the clear runs before an invocation that must not fail on it', async () => {
    // Make unlink fail: put a directory where the marker file belongs.
    await mkdir(join(protoDir, PRESENTATION_MARKER_FILE));
    await clearPresentationMarker(protoDir, log);
    expect(logLines.length).toBe(1);
    expect(logLines[0]).toContain('failed to clear');
    await rm(join(protoDir, PRESENTATION_MARKER_FILE), { recursive: true, force: true });
  });
});

describe('file placement', () => {
  test('the marker lives in the protocol dir under its reserved name', async () => {
    await writePresentationMarker(protoDir);
    const raw = await readFile(join(protoDir, PRESENTATION_MARKER_FILE), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ version: 1, declared_at: expect.any(String) });
  });
});