import { describe, test, expect } from 'bun:test';
import { readdir, readFile, stat } from 'fs/promises';
import { join, dirname, resolve, relative } from 'path';

/**
 * INVARIANT: `src/daemon/` and `src/server/` import NOTHING from `src/cli/`.
 *
 * CLAUDE.md's rule is that the daemon owns business logic and the CLI is a
 * human-facing client — "violations to reject on sight". The trouble is that
 * this class of violation is invisible at review time. It never arrives as one
 * indefensible import; it arrives as 34 daemon->CLI edges accumulated across a
 * release, each of which looked like a reasonable reuse of a helper that
 * happened to live under `src/cli/`. Nobody rejected any of them, because
 * nobody was looking at the total.
 *
 * So the rule is enforced mechanically instead of socially. Both counts are
 * zero; this test fails on the FIRST new edge, naming the file and specifier,
 * while it is still one line in one diff.
 *
 * WHY THOSE TWO DIRECTORIES AND NOT A GENERAL LAYERING RULE: the daemon and the
 * web server are the two long-lived processes. Importing a CLI command module
 * into one of them does not merely offend a diagram — it drags $EDITOR prompts,
 * `process.exit()` helpers and interactive flows into a process that has no
 * terminal, and it has produced real import cycles (`cli/commands/shared` ->
 * `daemon/rpc-fallback` -> ...). The supervisor and MCP are clients too, but
 * they are not where this failure mode bites.
 *
 * WHEN THIS TEST FAILS, the fix is never to add an exemption. Whatever the
 * daemon needs is domain logic sitting in the wrong place: move it to the
 * module that owns the concern (`src/task/`, `src/render/`, `src/credentials/`,
 * `src/preconditions.ts`) and import it from there. See
 * docs/design/module-boundaries.md.
 */

const SRC = resolve(import.meta.dir, '../../src');
const CLI_DIR = join(SRC, 'cli');

/** Directories that must not reach into `src/cli/`. */
const GUARDED = ['daemon', 'server'];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) await walk(path, out);
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/**
 * Every relative specifier this file imports or re-exports from, static or
 * dynamic. Multi-line import bodies are normal in this codebase, so the static
 * pattern deliberately spans newlines up to the `from` clause.
 */
function relativeSpecifiers(src: string): string[] {
  const found: string[] = [];
  const staticRe = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) found.push(m[1]!);
  }
  return found;
}

/** True when a relative specifier from `fromFile` lands inside `src/cli/`. */
function resolvesIntoCli(fromFile: string, spec: string): boolean {
  const target = resolve(dirname(fromFile), spec);
  return target === CLI_DIR || target.startsWith(CLI_DIR + '/');
}

describe('daemon and server do not import CLI code', () => {
  for (const guarded of GUARDED) {
    test(`src/${guarded}/ has no imports from src/cli/`, async () => {
      const files = await walk(join(SRC, guarded));

      // A scan that found no files would pass vacuously and stay green through
      // any rename of the directory it is supposed to be guarding.
      expect(files.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const file of files) {
        const src = await readFile(file, 'utf-8');
        for (const spec of relativeSpecifiers(src)) {
          if (resolvesIntoCli(file, spec)) {
            violations.push(`${relative(SRC, file)} imports '${spec}'`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  }

  test('the scan actually detects a CLI import', async () => {
    // Guards the detector itself: `relativeSpecifiers` + `resolvesIntoCli` are
    // regex-and-path work, and a silently non-matching pattern would turn the
    // two tests above into permanent green. This asserts against a file that
    // really does import from src/cli, in each spelling the scan must catch.
    const probe = join(SRC, 'daemon', 'probe.ts');
    const cases = [
      `import { x } from '../cli/helpers';`,
      `import {\n  x,\n  y,\n} from '../cli/helpers';`,
      `export { x } from '../cli/helpers';`,
      `const { x } = await import('../cli/helpers');`,
    ];
    for (const source of cases) {
      const specs = relativeSpecifiers(source);
      expect(specs.length).toBeGreaterThan(0);
      expect(specs.some(s => resolvesIntoCli(probe, s))).toBe(true);
    }

    // ...and does not fire on a specifier that merely looks similar.
    expect(resolvesIntoCli(probe, '../cli-shaped-name/thing')).toBe(false);
    expect(resolvesIntoCli(probe, '../render/theme')).toBe(false);
  });
});
