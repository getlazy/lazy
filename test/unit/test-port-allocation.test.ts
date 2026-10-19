import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

// INVARIANT: proxy tests never pick a listen port at random from a fixed window; they bind port 0
// and read the assigned port back. Concurrent test files drawing from one shared window collided
// under full-suite load and made the pre-accept unit run flaky.
describe('proxy test port allocation', () => {
  test('no proxy-related test picks ports from a random window', async () => {
    const dirs = [join(import.meta.dir), join(import.meta.dir, '..', 'e2e')];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const name of await readdir(dir)) {
        if (!/proxy|codex-endpoint-path/.test(name) || !name.endsWith('.test.ts')) continue;
        if (name === 'test-port-allocation.test.ts') continue;
        const text = await readFile(join(dir, name), 'utf8');
        if (/\d{5}\s*\+\s*Math\.floor\(\s*Math\.random\(\)/.test(text)) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
