/**
 * Guard: every launch path delivers the task's artifacts.
 *
 * Artifacts reach an agent by being materialized into its worktree, and the one
 * choke point that does it is `setupSandbox(worktreePath, { storage, taskId })`.
 * A launch path that calls `setupSandbox` with the path alone still works — it
 * just silently hands the agent an empty artifact directory, which looks exactly
 * like "the human attached nothing". This test makes that omission loud.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';

const SRC = join(import.meta.dir, '../../src');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('artifact delivery coverage', () => {
  test('every setupSandbox call site passes the artifact source', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(SRC)) {
      // The definition itself, obviously, has no call site to check.
      if (file.endsWith(join('utils', 'sandbox.ts'))) continue;
      const source = await readFile(file, 'utf-8');
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('setupSandbox(')) return;
        // The artifacts argument may sit on the same line or the next one.
        const window = line + (lines[i + 1] ?? '');
        if (!/setupSandbox\([^)]*,/.test(window)) {
          offenders.push(`${relative(SRC, file)}:${i + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
