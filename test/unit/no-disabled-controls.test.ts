import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const forbidden = /^\s*disabled(?:\s|>)|\bdisabled\s*[:=]|\bsetAttribute\(\s*['"](?:disabled|aria-disabled)['"]|<[^>]*\sdisabled(?:\s|>)|aria-disabled\s*=|\bis-disabled\b|pointer-events-none|cursor-not-allowed|pointer-events\s*:\s*none/g;
// Decorative progress bar only. The explicit allowlist for disabled controls
// in flight is empty: request guards use aria-busy instead.
const exceptions = new Map([['src/server/styles/app.css', ['pointer-events: none']]]);
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sources(join(dir, entry.name)) : Promise.resolve(/\.(ts|css)$/.test(entry.name) ? [join(dir, entry.name)] : [])));
  return nested.flat();
}
// INVARIANT: unavailable controls answer a click with a reason and remedy.
// Disabling them hides that answer from mouse, keyboard and touch users.
test('dashboard templates scripts and styles cannot introduce disabled controls', async () => {
  const violations: string[] = [];
  for (const file of await sources('src/server')) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      for (const match of line.matchAll(forbidden)) {
        if (!exceptions.get(file)?.includes(match[0])) violations.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
