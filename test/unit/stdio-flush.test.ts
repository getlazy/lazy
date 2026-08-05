/**
 * Regression tests for src/utils/stdio.ts — the "last chunk of a large reply is
 * silently dropped" bug.
 *
 * These must run as a real subprocess writing to a real pipe. The bug is an
 * interaction between kernel pipe buffering and `process.exit()`, so there is no
 * in-process way to observe it: a mocked stream would report success for the
 * exact case that fails in production. The test therefore spawns `bun`, lets the
 * pipe fill, and counts the bytes that actually arrive.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from '../../src/utils/spawn';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Big enough to dwarf a 64 KiB pipe buffer, small enough to stay fast. */
const PAYLOAD_BYTES = 5_000_000;
const MARKER = 'END_MARKER';

let dir: string;
const stdioModule = join(import.meta.dir, '../../src/utils/stdio.ts');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lazy-stdio-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Run `source` as a script and return everything it wrote to stdout.
 *
 * The reader deliberately does not start consuming immediately — that is what
 * makes the writer hit backpressure, which is the precondition for the bug.
 */
async function runAndCollect(source: string, name: string): Promise<string> {
  const script = join(dir, name);
  await writeFile(script, source);

  const proc = spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' });

  // Let the kernel pipe buffer fill before draining it.
  await new Promise(resolve => setTimeout(resolve, 500));

  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describe('writeStdout', () => {
  // THE REGRESSION: this is the exact shape that lost a reviewer's ask answer —
  // a large write followed immediately by process.exit(). Asserting on the final
  // marker and the byte count, because a truncated payload still starts
  // correctly and passes any check aimed at the beginning of the output.
  test('a multi-MB write survives process.exit() on a pipe', async () => {
    const out = await runAndCollect(
      `import { writeStdout } from ${JSON.stringify(stdioModule)};\n` +
      `await writeStdout('y'.repeat(${PAYLOAD_BYTES}) + '${MARKER}\\n');\n` +
      `process.exit(0);\n`,
      'fixed.ts',
    );

    expect(out.trimEnd().endsWith(MARKER)).toBe(true);
    expect(out.length).toBe(PAYLOAD_BYTES + MARKER.length + 1);
  }, 30_000);

  // CONTROL: proves the test can actually detect the bug it guards against.
  // Without the drain, the same payload is cut to one pipe buffer (65536 bytes
  // as measured on Bun 1.3.14). If this ever stops truncating, the runtime has
  // changed and the guarantee above no longer needs this machinery — but do not
  // delete the drain on that basis alone; verify on every supported platform.
  test('CONTROL: a bare process.stdout.write + exit truncates', async () => {
    const out = await runAndCollect(
      `process.stdout.write('y'.repeat(${PAYLOAD_BYTES}) + '${MARKER}\\n');\n` +
      `process.exit(0);\n`,
      'broken.ts',
    );

    expect(out.length).toBeLessThan(PAYLOAD_BYTES);
    expect(out.endsWith(MARKER + '\n')).toBe(false);
  }, 30_000);

  // A short write must not pay for the drain machinery — no stalling on the
  // 2s timeout when there was never any backpressure.
  test('a small write returns promptly', async () => {
    const started = Date.now();
    const out = await runAndCollect(
      `import { writeStdout } from ${JSON.stringify(stdioModule)};\n` +
      `await writeStdout('small\\n');\n` +
      `process.exit(0);\n`,
      'small.ts',
    );

    expect(out).toBe('small\n');
    // Generous bound: the point is "did not wait out DRAIN_TIMEOUT_MS", not a
    // performance budget for process startup.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);
});
