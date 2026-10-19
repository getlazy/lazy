import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

// INVARIANT: no prompt shipped to a user's project names AGENTS.md twice. The
// CLAUDE.md -> AGENTS.md rename of lazy-dev's own repo once blanket-rewrote
// these texts into "AGENTS.md, AGENTS.md"; user projects still use CLAUDE.md.
describe('src/prompts instruction-file names', () => {
  test('no doubled AGENTS.md wording', async () => {
    const dir = join(import.meta.dir, '../../src/prompts');
    const offenders: string[] = [];
    for (const name of await readdir(dir, { recursive: true })) {
      if (!name.endsWith('.md')) continue;
      const text = await readFile(join(dir, name), 'utf8');
      if (/AGENTS\.md`?(,| or| and|\/)\s*`?AGENTS\.md/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
