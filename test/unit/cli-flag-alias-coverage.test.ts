import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: every single-dash flag a command documents in its usage text must
 * be registered as a `parseFlags` alias for that command.
 *
 * `parseFlags` only registers `--<name>` unless a flag explicitly declares
 * `aliases: ['x']`. That made it easy to document `-f` in help text and have
 * the CLI reject it as an unknown flag — exactly what happened to
 * `lazy unblock -f`. This test walks the usage text of every command and fails
 * if a documented short flag has no matching alias registration.
 *
 * Best-effort by construction: it is a source scan, not a parse of the real
 * dispatch table (which lives in `src/index.ts` and executes the CLI on
 * import). It relies on two repo conventions, both asserted below so the test
 * can't silently degrade into a no-op:
 *   1. usage text lives in a top-level `<name>Usage()` function
 *   2. its flags are registered in the matching `command<Name>...()` function
 * A command that violates either convention is simply not covered.
 */

// Resolved from this file rather than cwd so the test works regardless of
// where `bun test` is invoked from.
const COMMANDS_DIR = join(import.meta.dir, '../../src/cli/commands');

/**
 * Short flags the top-level dispatcher (`src/index.ts`) intercepts before the
 * command's own `parseFlags` runs, so they need no per-command registration.
 */
const GLOBALLY_HANDLED = new Set(['h']);

/**
 * Split a source file into top-level function bodies keyed by function name.
 * Relies on top-level functions starting at column 0 and closing with a `}`
 * at column 0 — the style used throughout `src/cli/commands`.
 */
function topLevelFunctions(src: string): Map<string, string> {
  const scopes = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];

  for (const line of src.split('\n')) {
    const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    if (decl) {
      if (current) scopes.set(current, buf.join('\n'));
      current = decl[1];
      buf = [line];
      continue;
    }
    if (!current) continue;
    buf.push(line);
    if (line === '}') {
      scopes.set(current, buf.join('\n'));
      current = null;
      buf = [];
    }
  }
  if (current) scopes.set(current, buf.join('\n'));
  return scopes;
}

/**
 * Collect `-x`-style tokens from usage text. Angle-bracket placeholders are
 * stripped first so value grammars like `<+N|-N|=N>` aren't read as flags.
 * The lookbehind rejects `-` preceded by a word char, `.`, `/` or `$` so that
 * paths, `--long-flags` and interpolations don't produce false hits.
 */
function documentedShortFlags(text: string): Set<string> {
  const cleaned = text.replace(/<[^<>\n]*>/g, ' ');
  const found = new Set<string>();
  for (const m of cleaned.matchAll(/(?<![\w\-./$])-([a-zA-Z])(?![\w\-])/g)) found.add(m[1]);
  return found;
}

/** Collect alias letters from `aliases: ['x', 'y']` flag definitions. */
function registeredAliases(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
    for (const a of m[1].matchAll(/['"]([^'"]+)['"]/g)) found.add(a[1]);
  }
  return found;
}

interface Audit {
  file: string;
  usageFn: string;
  commandFn: string;
  documented: string[];
  registered: string[];
  missing: string[];
}

async function auditCommands(): Promise<Audit[]> {
  const files = (await readdir(COMMANDS_DIR)).filter((f) => f.endsWith('.ts'));
  const audits: Audit[] = [];

  for (const file of files) {
    const src = await readFile(join(COMMANDS_DIR, file), 'utf-8');
    const scopes = topLevelFunctions(src);

    // Flag tables declared outside any function (module-level constants) apply
    // to every command in the file.
    const moduleLevel = registeredAliases(
      src.split('\n').filter((l) => !/^\s/.test(l)).join('\n')
    );

    for (const [usageFn, usageBody] of scopes) {
      if (!usageFn.endsWith('Usage')) continue;
      const base = usageFn.slice(0, -'Usage'.length);
      if (!base) continue;
      const commandFn = `command${base[0].toUpperCase()}${base.slice(1)}`;

      const registered = new Set(moduleLevel);
      for (const [fnName, body] of scopes) {
        // `commandConfig` documents flags parsed in `commandConfigSet` /
        // `commandConfigGet`, so prefix-matched siblings count too.
        if (fnName.startsWith(commandFn)) {
          for (const alias of registeredAliases(body)) registered.add(alias);
        }
      }

      const documented = documentedShortFlags(usageBody);
      const missing = [...documented].filter(
        (f) => !registered.has(f) && !GLOBALLY_HANDLED.has(f)
      );

      audits.push({
        file,
        usageFn,
        commandFn,
        documented: [...documented].sort(),
        registered: [...registered].sort(),
        missing: missing.sort(),
      });
    }
  }

  return audits;
}

describe('CLI single-dash flag coverage', () => {
  test('every documented short flag is registered as a parseFlags alias', async () => {
    const audits = await auditCommands();

    const offenders = audits
      .filter((a) => a.missing.length > 0)
      .map(
        (a) =>
          `${a.file}: ${a.usageFn} documents ${a.missing.map((f) => `-${f}`).join(', ')} ` +
          `but ${a.commandFn} registers only [${a.registered.join(', ') || 'none'}]`
      );

    expect(offenders).toEqual([]);
  });

  // The check above is a source scan, so it must prove it actually scanned
  // something. Without these guards a rename of the usage-function convention
  // would turn the test green by finding nothing at all.
  test('the scan finds the expected command surface', async () => {
    const audits = await auditCommands();

    // ~59 usage functions today; a floor catches wholesale scan breakage.
    expect(audits.length).toBeGreaterThan(50);

    // At least a dozen commands document short flags — if this drops to zero
    // the flag-extraction regex has stopped working.
    const withShortFlags = audits.filter((a) => a.documented.length > 0);
    expect(withShortFlags.length).toBeGreaterThan(10);
  });

  // REGRESSION: `lazy unblock -f` was documented in usage but never registered,
  // so parseFlags rejected it as an unknown flag. Pin the pairing that broke.
  test('unblock documents and registers -f and -m', async () => {
    const audits = await auditCommands();
    const unblock = audits.find((a) => a.usageFn === 'unblockUsage');

    expect(unblock).toBeDefined();
    expect(unblock!.documented).toContain('f');
    expect(unblock!.documented).toContain('m');
    expect(unblock!.registered).toContain('f');
    expect(unblock!.registered).toContain('m');
    expect(unblock!.missing).toEqual([]);
  });

  // Guard the detector itself: a documented-but-unregistered flag must be
  // reported. Without this, a broken regex would make the suite pass silently.
  test('detects a documented flag that has no alias registration', () => {
    const src = [
      'function widgetUsage(): void {',
      '  console.log(`Usage: lazy widget [-q]',
      '',
      'Options:',
      '  -q, --quiet   Suppress output`);',
      '}',
      '',
      'export async function commandWidget(args: string[]): Promise<void> {',
      "  const parsed = parseFlags(args, [{ name: 'quiet', takesValue: false }], 'widget');",
      '}',
    ].join('\n');

    const scopes = topLevelFunctions(src);
    expect([...scopes.keys()]).toEqual(['widgetUsage', 'commandWidget']);
    expect([...documentedShortFlags(scopes.get('widgetUsage')!)]).toEqual(['q']);
    expect([...registeredAliases(scopes.get('commandWidget')!)]).toEqual([]);
  });
});
