import { test, expect } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { loadConfig } from '../../src/config/loader';
import { findUnknownConfigKeys } from '../../src/config/schema';

const docsRoot = join(import.meta.dir, '..', '..', 'public-docs');

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
  }));
  return files.flat();
}

// INVARIANT: Every public TOML example must load as lazy configuration without
// unknown keys. Readers copy these blocks, so a stale example becomes a failed setup.
test('public documentation TOML blocks are valid lazy configuration', async () => {
  const errors: string[] = [];
  const temp = await mkdtemp(join(tmpdir(), 'lazy-docs-toml-'));
  try {
    for (const path of await markdownFiles(docsRoot)) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*```toml\s*$/.test(lines[i]!)) continue;
        const start = i + 1;
        const block: string[] = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) block.push(lines[i]!);
        const location = `${relative(docsRoot, path)}:${start}`;
        if (i === lines.length) { errors.push(`${location}: unclosed TOML block`); break; }
        if (lines[start - 2]?.trim() === '<!-- toml-example: invalid -->') continue;
        try {
          const raw = Bun.TOML.parse(block.join('\n')) as Record<string, unknown>;
          const unknown = findUnknownConfigKeys(raw);
          if (unknown.length) errors.push(`${location}: ${unknown.join('; ')}`);
          await writeFile(join(temp, 'lazy.toml'), block.join('\n'));
          await loadConfig(temp, { strict: true });
        } catch (error) {
          errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
