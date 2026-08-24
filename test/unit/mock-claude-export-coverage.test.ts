import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: `test/mocks/claude.ts` must export every symbol that any file in
 * `src/` imports from `src/capture/claude`.
 *
 * The mock REPLACES the whole module via bun `--preload` (see CLAUDE.md, "Two
 * agent seams"). Bun resolves the aliased module's named exports eagerly, so a
 * source file importing a symbol the mock lacks does not degrade — every
 * module-mock e2e suite that touches that import chain dies at load with
 * `SyntaxError: Export named 'x' not found`, an error that names the REAL
 * module and so reads like a bug in `src/` rather than in the mock.
 *
 * That is exactly how `getLaunchAuthEnvVars` (added to `src/capture/claude.ts`
 * by `proxy-jit-credentials`, imported by `src/runner/host-process-runner.ts`)
 * broke every module-mock suite reaching the host-process runner. The failure
 * mode is silent until some unrelated suite runs, so it gets a test rather than
 * a convention.
 *
 * Source scan, not a runtime probe: importing the mock here would not exercise
 * the preload alias, and importing `src/capture/claude` pulls in Docker/daemon
 * machinery. The scan asserts its own preconditions below so it cannot rot into
 * a no-op that passes by finding nothing.
 */

const ROOT = join(import.meta.dir, '../..');
const SRC = join(ROOT, 'src');
const MOCK = join(ROOT, 'test/mocks/claude.ts');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(p)));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every named import of `capture/claude` across `src/`, symbol → importers. */
async function collectImportedSymbols(): Promise<Map<string, string[]>> {
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*capture\/claude['"]/g;
  const used = new Map<string, string[]>();
  for (const file of await tsFiles(SRC)) {
    if (file.endsWith(join('capture', 'claude.ts'))) continue;
    const src = await readFile(file, 'utf-8');
    for (const match of src.matchAll(importRe)) {
      for (const raw of match[1]!.split(',')) {
        // `type Foo`, `Foo as Bar`, trailing commas, newlines.
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
        if (!name) continue;
        const importers = used.get(name) ?? [];
        importers.push(file.slice(ROOT.length + 1));
        used.set(name, importers);
      }
    }
  }
  return used;
}

/** Names the mock exports, including `export { a, b }` re-export lists. */
function collectMockExports(source: string): Set<string> {
  const names = new Set<string>();
  const declRe =
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
  for (const m of source.matchAll(declRe)) names.add(m[1]!);
  const listRe = /^export\s*\{([^}]*)\}/gm;
  for (const m of source.matchAll(listRe)) {
    for (const raw of m[1]!.split(',')) {
      const parts = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0])!.trim();
      if (exported) names.add(exported);
    }
  }
  return names;
}

describe('test/mocks/claude.ts export coverage', () => {
  test('exports every symbol src/ imports from capture/claude', async () => {
    const imported = await collectImportedSymbols();
    const exported = collectMockExports(await readFile(MOCK, 'utf-8'));

    // Guard: the scan found real data. A regex that stops matching (an import
    // style change, a moved mock) would otherwise make this test pass by
    // finding nothing to check — the failure this file exists to prevent.
    expect(imported.size).toBeGreaterThan(10);
    expect(exported.size).toBeGreaterThan(10);
    expect(imported.has('getAuthEnvVars')).toBe(true);

    const missing = [...imported]
      .filter(([name]) => !exported.has(name))
      .map(([name, importers]) => `${name} (imported by ${importers.join(', ')})`);

    expect(missing).toEqual([]);
  });
});
