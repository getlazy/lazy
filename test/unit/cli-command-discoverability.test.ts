import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: every command in the dispatch table is discoverable — it appears
 * in the `lazy --help` listing AND in shell completion, and its flags are the
 * flags it actually accepts.
 *
 * `lazy timings` shipped registered in the dispatch table but absent from both
 * surfaces, so the only way to find it was to read `src/index.ts`. Nothing
 * failed; it was simply invisible. The same drift class had quietly reached
 * ~13 entries of completion's `COMMAND_FLAGS` (flags the CLI accepts that
 * never tab-complete) and several multiplexer subcommands. This suite fails
 * CI on all of it.
 *
 * Four surfaces are cross-checked:
 *   1. dispatch table (`commandMap` in src/index.ts) ↔ completion's ALL_COMMANDS
 *   2. dispatch table → the `lazy --help` listing in `usage()`
 *   3. each multiplexer's documented subcommands ↔ completion's SUBCOMMANDS
 *   4. each command's real `parseFlags` table ↔ completion's COMMAND_FLAGS
 *
 * Best-effort by construction: it is a source scan, not a runtime probe of the
 * dispatch table (importing `src/index.ts` executes the CLI). It relies on
 * repo conventions, all asserted in the coverage-guard tests below so the scan
 * can't degrade into a no-op:
 *   1. `src/index.ts` declares entries as `'<name>': { run: ..., usage: ... }`
 *      at two-space indentation, and the help listing lives in `usage()`
 *   2. completion's three tables are array/object literals of string literals
 *   3. flags are registered through `parseFlags(args, [...], '<label>')`, where
 *      the label is the command name (`'accept'`) or `'<parent> <sub>'`
 *      (`'daemon start'`)
 */

const SRC = join(import.meta.dir, '../../src');
const COMMANDS_DIR = join(SRC, 'cli/commands');

/**
 * Commands whose flags are NOT parsed through `parseFlags`, so the scan has
 * nothing to compare COMMAND_FLAGS against. `init` reads `args.includes(...)`
 * directly because it runs before storage/config exist. Asserted to be exactly
 * this set below — a new entry here has to be deliberate.
 */
const NO_PARSE_FLAGS_TABLE = new Set(['init']);

/**
 * `parseFlags` labels that are not `<command>` or `<command> <sub>` and so
 * can't be attributed to a top-level command by name alone. `lazy daemon logs`
 * delegates to `commandLogs` in logs.ts, which labels itself `'logs'`.
 * The scan asserts the orphan set matches these keys exactly, so a new
 * unattributable label fails loudly instead of being silently dropped.
 */
const LABEL_OWNER: Record<string, string> = {
  'logs': 'daemon',
};

/**
 * Real flags that completion deliberately does NOT advertise, with the reason.
 * Everything else a command accepts must tab-complete.
 */
const UNCOMPLETED_FLAGS: Record<string, Array<{ flag: string; why: string }>> = {
  'review': [
    { flag: 'stub-agent', why: 'test-only hook; not documented in reviewUsage' },
  ],
  'unblock': [
    // Registered as `{ name: 'f', aliases: ['f'] }` purely so the documented
    // `-f` spelling parses. `--f` is an artifact of that registration, not a
    // spelling anyone should be offered.
    { flag: 'f', why: 'artifact of registering the documented -f short flag' },
  ],
};

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

/** Command names in the `commandMap` dispatch table, in declaration order. */
export function dispatchCommands(indexSrc: string): string[] {
  const start = indexSrc.indexOf('const commandMap: Record');
  const end = indexSrc.indexOf('// Register alias entries');
  if (start === -1 || end === -1) throw new Error('cannot locate commandMap in src/index.ts');
  const body = indexSrc.slice(start, end);
  return [...body.matchAll(/^ {2}'([a-z-]+)':\s*\{/gm)].map((m) => m[1]);
}

/** Text of the `lazy --help` listing (the body of `usage()`). */
export function helpListing(indexSrc: string): string {
  const start = indexSrc.indexOf('function usage(): void');
  const end = indexSrc.indexOf('const commandMap: Record');
  if (start === -1 || end === -1) throw new Error('cannot locate usage() in src/index.ts');
  return indexSrc.slice(start, end);
}

/** `subcommands: <ident>` entries — the multiplexers, keyed by command name. */
export function multiplexerIdents(indexSrc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of indexSrc.matchAll(/'([a-z-]+)':\s*\{[^}]*?subcommands:\s*([A-Za-z0-9_]+)/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** String literals of a `const <ident> = withAliases([...])` array. */
export function stringArrayLiteral(src: string, decl: string): string[] {
  const re = new RegExp(`const ${decl}[^=]*=\\s*(?:withAliases\\()?\\[([\\s\\S]*?)\\]`);
  const m = re.exec(src);
  if (!m) throw new Error(`cannot locate ${decl}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Entries of a `const <ident> = expandAliasKeys({ 'k': [...] })` map. */
export function stringArrayMapLiteral(src: string, decl: string): Record<string, string[]> {
  const re = new RegExp(`const ${decl}[^=]*=\\s*(?:expandAliasKeys\\()?\\{([\\s\\S]*?)\\n\\}\\)?;?`);
  const m = re.exec(src);
  if (!m) throw new Error(`cannot locate ${decl}`);
  const out: Record<string, string[]> = {};
  for (const e of m[1].matchAll(/^ {2}'([a-z-]+)':\s*\[([^\]]*)\]/gm)) {
    out[e[1]] = [...e[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}

/**
 * `parseFlags(<args>, <table>, '<label>')` calls in a source file, with the
 * flag names of the table. The table is either an inline array literal or an
 * identifier naming a `const <IDENT> = [...]` in the same file.
 *
 * `label` is the string literal when there is one. `lazy show` passes a
 * variable (it reports itself as whichever alias invoked it), so the enclosing
 * `command<Name>()` is used instead — reported as `fn`.
 */
export function parseFlagsCalls(
  src: string,
): Array<{ label: string | null; fn: string | null; names: string[] }> {
  const out: Array<{ label: string | null; fn: string | null; names: string[] }> = [];
  let idx = 0;
  while ((idx = src.indexOf('parseFlags(', idx)) !== -1) {
    let depth = 0;
    let i = idx + 'parseFlags'.length;
    const open = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const call = src.slice(open + 1, i);
    idx = i;

    const names = [...call.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
    // An identifier flag table: `parseFlags(args, BUILDER_FLAGS, 'builder')`.
    const ident = /^\s*[A-Za-z0-9_]+\s*,\s*([A-Z][A-Za-z0-9_]*)\s*,/.exec(call);
    if (ident) {
      const table = new RegExp(`const ${ident[1]}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`).exec(src);
      if (table) names.push(...[...table[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]));
    }

    // Trailing comma is optional — multi-line calls carry one.
    const label = /,\s*'([a-z][a-z0-9 -]*)'\s*,?\s*$/.exec(call.trim());
    const enclosing = [
      ...src.slice(0, idx).matchAll(/function\s+command([A-Za-z0-9]+)\s*\(/g),
    ].pop();
    out.push({
      label: label ? label[1] : null,
      fn: enclosing ? enclosing[1] : null,
      names,
    });
  }
  return out;
}

/** `case '<sub>':` labels of a multiplexer's dispatcher switch. */
export function switchCaseLabels(src: string, fnName: string): string[] {
  const lines = src.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\b`).test(l)
  );
  if (start === -1) throw new Error(`cannot find ${fnName}()`);
  const labels: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') break;
    const m = /^\s*case\s+'([^']+)'\s*:/.exec(lines[i]);
    if (m) labels.push(m[1]);
  }
  return labels;
}

/**
 * Subcommand names a multiplexer's `<parent>Usage()` documents, read from the
 * `Subcommands:` block. Usage text is the definition of "documented surface",
 * which is what completion has to cover — undocumented aliases (`memory ls`)
 * are deliberately left out of both.
 */
export function documentedSubcommands(src: string, parent: string): string[] {
  const usage = new RegExp(`export function ${parent}Usage\\(\\)[\\s\\S]*?\\n\\}`).exec(src);
  if (!usage) throw new Error(`cannot find ${parent}Usage()`);
  const block = /Subcommands:\n([\s\S]*?)\n\n/.exec(usage[0]);
  if (!block) throw new Error(`${parent}Usage() has no Subcommands: block`);
  return [...block[1].matchAll(/^ {2}([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
}

/** camelCase a kebab command name: `import-conversation` -> `ImportConversation`. */
function pascal(name: string): string {
  return name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

interface Surface {
  dispatch: string[];
  help: string;
  multiplexers: Record<string, string>;
  allCommands: string[];
  subcommands: Record<string, string[]>;
  commandFlags: Record<string, string[]>;
  /** Real flags per top-level command, unioned across its parseFlags labels. */
  realFlags: Map<string, Set<string>>;
  /** parseFlags labels that don't start with a dispatch-table command name. */
  orphanLabels: string[];
}

async function readSurface(): Promise<Surface> {
  const indexSrc = await readFile(join(SRC, 'index.ts'), 'utf-8');
  const compSrc = await readFile(join(COMMANDS_DIR, 'completion.ts'), 'utf-8');

  const dispatch = dispatchCommands(indexSrc);

  const realFlags = new Map<string, Set<string>>();
  const orphanLabels: string[] = [];
  for (const file of (await readdir(COMMANDS_DIR)).filter((f) => f.endsWith('.ts'))) {
    const src = await readFile(join(COMMANDS_DIR, file), 'utf-8');
    for (const call of parseFlagsCalls(src)) {
      // `'daemon start'` belongs to `daemon`; `'accept'` to `accept`. With no
      // literal label, fall back to the enclosing `command<Name>()`.
      const label =
        call.label ??
        (call.fn ? call.fn.replace(/(?<!^)[A-Z]/g, (c) => `-${c}`).toLowerCase() : null);
      if (!label) continue;
      const head = label.split(' ')[0];
      let owner: string | undefined = head;
      if (!dispatch.includes(head)) {
        // Not `<command>` / `<command> <sub>` — only LABEL_OWNER can place it.
        orphanLabels.push(label);
        owner = LABEL_OWNER[label];
      }
      if (!owner) continue;
      const set = realFlags.get(owner) ?? new Set<string>();
      call.names.forEach((n) => set.add(n));
      realFlags.set(owner, set);
    }
  }

  return {
    dispatch,
    help: helpListing(indexSrc),
    multiplexers: multiplexerIdents(indexSrc),
    allCommands: stringArrayLiteral(compSrc, 'ALL_COMMANDS'),
    subcommands: stringArrayMapLiteral(compSrc, 'SUBCOMMANDS'),
    commandFlags: stringArrayMapLiteral(compSrc, 'COMMAND_FLAGS'),
    realFlags,
    orphanLabels: [...new Set(orphanLabels)].sort(),
  };
}

/** Barrel/import resolution for a multiplexer's defining file. */
async function multiplexerFile(mapIdent: string): Promise<string> {
  const barrel = await readFile(join(COMMANDS_DIR, 'index.ts'), 'utf-8');
  for (const m of barrel.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(mapIdent)) return `${m[2].replace(/^\.\//, '')}.ts`;
  }
  throw new Error(`cannot resolve ${mapIdent} through src/cli/commands/index.ts`);
}

describe('CLI command discoverability', () => {
  test('every dispatch-table command tab-completes', async () => {
    const s = await readSurface();
    const missing = s.dispatch.filter((c) => !s.allCommands.includes(c));

    expect(
      missing.map(
        (c) => `'${c}' is in the src/index.ts dispatch table but not in ALL_COMMANDS ` +
          `(src/cli/commands/completion.ts) — it never tab-completes`
      )
    ).toEqual([]);
  });

  test('every completed command is really dispatchable', async () => {
    const s = await readSurface();
    const bogus = s.allCommands.filter((c) => !s.dispatch.includes(c));

    expect(
      bogus.map(
        (c) => `ALL_COMMANDS completes '${c}' but src/index.ts has no dispatch entry for it`
      )
    ).toEqual([]);
  });

  test('every dispatch-table command appears in the lazy --help listing', async () => {
    const s = await readSurface();
    // Listing lines are `  <command>[ <args>]   Description`. A multiplexer is
    // listed through its subcommands (`  daemon start ...`), which still
    // matches on the parent word.
    const missing = s.dispatch.filter(
      (c) => !new RegExp(`^ {2}${c}(?![a-z0-9-])`, 'm').test(s.help)
    );

    expect(
      missing.map(
        (c) => `'${c}' is in the dispatch table but absent from the usage() listing ` +
          `in src/index.ts — \`lazy --help\` never mentions it`
      )
    ).toEqual([]);
  });

  test('every documented multiplexer subcommand tab-completes', async () => {
    const s = await readSurface();
    const offenders: string[] = [];

    for (const [parent, mapIdent] of Object.entries(s.multiplexers)) {
      const src = await readFile(join(COMMANDS_DIR, await multiplexerFile(mapIdent)), 'utf-8');
      const completed = s.subcommands[parent] ?? [];
      for (const sub of documentedSubcommands(src, parent)) {
        if (!completed.includes(sub)) {
          offenders.push(
            `'${parent} ${sub}' is documented in ${parent}Usage() but missing from ` +
              `SUBCOMMANDS['${parent}'] in completion.ts`
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every completed multiplexer subcommand is really dispatchable', async () => {
    const s = await readSurface();
    const offenders: string[] = [];

    for (const [parent, mapIdent] of Object.entries(s.multiplexers)) {
      const src = await readFile(join(COMMANDS_DIR, await multiplexerFile(mapIdent)), 'utf-8');
      const cases = switchCaseLabels(src, `command${pascal(parent)}`);
      for (const sub of s.subcommands[parent] ?? []) {
        if (!cases.includes(sub)) {
          offenders.push(
            `SUBCOMMANDS['${parent}'] completes '${sub}' but command${pascal(parent)}() ` +
              `has no matching case`
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('COMMAND_FLAGS lists no flag the command would reject', async () => {
    const s = await readSurface();
    const offenders: string[] = [];

    for (const [cmd, flags] of Object.entries(s.commandFlags)) {
      if (NO_PARSE_FLAGS_TABLE.has(cmd)) continue;
      const real = s.realFlags.get(cmd);
      if (!real) continue; // reported by the coverage guard below
      const stale = flags.map((f) => f.replace(/^--/, '')).filter((f) => !real.has(f));
      if (stale.length > 0) {
        offenders.push(
          `'${cmd}' tab-completes ${stale.map((f) => `--${f}`).join(', ')} but ` +
            `parseFlags does not register ${stale.length > 1 ? 'them' : 'it'}`
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every flag a command accepts is in COMMAND_FLAGS', async () => {
    const s = await readSurface();
    const offenders: string[] = [];

    for (const [cmd, real] of s.realFlags) {
      const completed = new Set((s.commandFlags[cmd] ?? []).map((f) => f.replace(/^--/, '')));
      const excused = new Set((UNCOMPLETED_FLAGS[cmd] ?? []).map((e) => e.flag));
      const missing = [...real].filter((f) => !completed.has(f) && !excused.has(f));
      if (missing.length > 0) {
        offenders.push(
          `'${cmd}' accepts ${missing.map((f) => `--${f}`).join(', ')} but ` +
            `COMMAND_FLAGS in completion.ts does not list ${missing.length > 1 ? 'them' : 'it'}`
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  // REGRESSION: `lazy timings` was dispatchable but absent from both surfaces.
  // It now lives under the stats multiplexer; pin that it is reachable there.
  test('stats timings is discoverable', async () => {
    const s = await readSurface();

    expect(s.dispatch).not.toContain('timings');
    expect(s.subcommands['stats']).toContain('timings');
    expect(s.help).toContain('stats timings');
    // The union of every stats subcommand's flags. `tokens`/`timings`
    // contribute the first group; `audit` contributes the record-level
    // filters. Adding a subcommand is expected to grow this list — what it
    // must never do is shrink it, which would mean a subcommand stopped
    // being scanned.
    expect([...s.realFlags.get('stats')!].sort()).toEqual(
      [
        'json', 'limit', 'role', 'since', 'task', 'top', 'tree',
        'denied', 'errors', 'last', 'model', 'reroutes', 'scan',
      ].sort()
    );
  });

  // A source scan must prove it scanned something: without these guards a
  // rename of any convention above turns the test green by finding nothing.
  test('the scan finds the expected surface', async () => {
    const s = await readSurface();

    expect(s.dispatch.length).toBeGreaterThan(50);
    expect(s.allCommands.length).toBeGreaterThan(50);
    expect(Object.keys(s.commandFlags).length).toBeGreaterThan(40);
    expect(Object.keys(s.multiplexers).sort()).toEqual(['daemon', 'memory', 'stats', 'system']);
    expect(Object.keys(s.subcommands).sort()).toEqual([
      'config', 'daemon', 'memory', 'stats', 'system',
    ]);

    // Every unattributable parseFlags label must be explained. A new one means
    // a command's flags silently stopped being checked.
    expect(s.orphanLabels).toEqual(Object.keys(LABEL_OWNER).sort());

    // Every dispatch-table command either has a resolved flag table, has no
    // flags at all, or is a documented exception. Anything else means the
    // parseFlags scan stopped resolving that command.
    const unresolved = Object.keys(s.commandFlags).filter(
      (c) =>
        !s.realFlags.has(c) &&
        !NO_PARSE_FLAGS_TABLE.has(c) &&
        // An empty entry means "takes no flags" — nothing to resolve.
        (s.commandFlags[c] ?? []).length > 0
    );
    expect(unresolved).toEqual([]);
    expect([...NO_PARSE_FLAGS_TABLE]).toEqual(['init']);
  });

  // Guard the detectors themselves: each must report a planted drift. Without
  // these a broken regex would make the whole suite pass silently.
  test('detects a dispatch entry missing from the completion list', () => {
    const indexSrc = [
      'const commandMap: Record<string, Entry> = {',
      "  'widget':  { run: commandWidget, usage: widgetUsage },",
      "  'gadget':  { run: commandGadget, usage: gadgetUsage, subcommands: gadgetSubcommandUsage },",
      '};',
      '// Register alias entries',
    ].join('\n');
    const compSrc = ["const ALL_COMMANDS = withAliases([", "  'widget',", "]);"].join('\n');

    expect(dispatchCommands(indexSrc)).toEqual(['widget', 'gadget']);
    expect(multiplexerIdents(indexSrc)).toEqual({ gadget: 'gadgetSubcommandUsage' });
    expect(stringArrayLiteral(compSrc, 'ALL_COMMANDS')).toEqual(['widget']);
    // 'gadget' dispatches but never completes — exactly the drift caught above.
  });

  test('detects a flag table that has drifted from parseFlags', () => {
    const src = [
      'export async function commandWidget(args: string[]): Promise<void> {',
      '  const parsed = parseFlags(args, [',
      "    { name: 'quiet', takesValue: false },",
      "    { name: 'output', takesValue: true },",
      "  ], 'widget');",
      '}',
    ].join('\n');
    const compSrc = [
      'const COMMAND_FLAGS: Record<string, string[]> = expandAliasKeys({',
      "  'widget':  ['--quiet', '--verbose'],",
      '});',
    ].join('\n');

    expect(parseFlagsCalls(src)).toEqual([
      { label: 'widget', fn: 'Widget', names: ['quiet', 'output'] },
    ]);
    expect(stringArrayMapLiteral(compSrc, 'COMMAND_FLAGS')).toEqual({
      widget: ['--quiet', '--verbose'],
    });
    // --verbose is stale (rejected by parseFlags); --output never completes.
  });

  test('reads an identifier flag table and a subcommand-scoped label', () => {
    const src = [
      'export async function commandWidget(args: string[]): Promise<void> {',
      '  const WIDGET_FLAGS: FlagDefinition[] = [',
      "    { name: 'force', takesValue: false },",
      '  ];',
      "  const parsed = parseFlags(args, WIDGET_FLAGS, 'gadget widget');",
      '}',
    ].join('\n');

    expect(parseFlagsCalls(src)).toEqual([
      { label: 'gadget widget', fn: 'Widget', names: ['force'] },
    ]);
  });

  test('reads documented subcommands and switch cases', () => {
    const src = [
      'export async function commandGadget(args: string[]): Promise<void> {',
      '  switch (args[0]) {',
      "    case 'spin':",
      '      break;',
      "    case 'whirl':",
      '      break;',
      '  }',
      '}',
      '',
      'export function gadgetUsage(): void {',
      '  console.log(`Usage: lazy gadget <subcommand>',
      '',
      'Subcommands:',
      '  spin    Spin it',
      '  whirl   Whirl it',
      '',
      'Examples:',
      '  lazy gadget spin`);',
      '}',
    ].join('\n');

    expect(switchCaseLabels(src, 'commandGadget')).toEqual(['spin', 'whirl']);
    expect(documentedSubcommands(src, 'gadget')).toEqual(['spin', 'whirl']);
  });
});
