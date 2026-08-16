import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: every multiplexer subcommand that ships its own `<name>Usage()`
 * must be listed in its parent's `<parent>SubcommandUsage` map.
 *
 * The dispatcher in `src/index.ts` intercepts `-h`/`--help` BEFORE the command
 * runs, and routes to `entry.subcommands?.[cmdArgs[0]] ?? entry.usage`. So a
 * new `lazy system <sub>` / `lazy daemon <sub>` that has a dedicated usage
 * function but isn't added to the map silently prints the PARENT's help — a
 * quiet regression with no error anywhere. This test fails on that drift.
 *
 * Best-effort by construction: it is a source scan, not a runtime probe of the
 * dispatch table (importing `src/index.ts` executes the CLI). It relies on
 * repo conventions, all asserted below so the scan can't degrade into a no-op:
 *   1. `src/index.ts` declares multiplexers as `subcommands: <ident>`
 *   2. `src/cli/commands/index.ts` re-exports `<ident>` from its defining file
 *   3. that file dispatches with a `switch` of `case '<sub>':` labels, each
 *      calling a handler function on a following line
 *   4. usage text lives in an exported `function <name>Usage()`
 * A subcommand whose handler can't be traced to a module (an inline body, a
 * dynamic import, a handler resolved through a table) is reported as untraced
 * rather than silently passing — see the coverage guard test.
 */

const SRC = join(import.meta.dir, '../../src');
const COMMANDS_DIR = join(SRC, 'cli/commands');

interface Multiplexer {
  /** Top-level command name, e.g. `system`. */
  command: string;
  /** Name of the usage-map const, e.g. `systemSubcommandUsage`. */
  mapIdent: string;
  /** File that defines the multiplexer, e.g. `system.ts`. */
  file: string;
  /** Dispatchable `case '<sub>':` labels, in switch order. */
  dispatchable: string[];
  /** Keys of the usage map. */
  mapped: Record<string, string>;
  /** Subcommands with a dedicated usage function that are missing from the map. */
  missing: string[];
  /** Map keys that no switch case dispatches. */
  unreachable: string[];
  /** Subcommands whose handler module couldn't be resolved statically. */
  untraced: string[];
}

/** `case 'x':` labels and the handler each group of labels falls through to. */
function switchCases(fnBody: string): Array<{ labels: string[]; handler: string | null }> {
  const groups: Array<{ labels: string[]; handler: string | null }> = [];
  let pending: string[] = [];

  for (const line of fnBody.split('\n')) {
    const label = /^\s*case\s+'([^']+)'\s*:/.exec(line);
    if (label) {
      pending.push(label[1]);
      continue;
    }
    if (pending.length === 0) continue;
    const call = /(?:await\s+)?([A-Za-z0-9_]+)\s*\(/.exec(line);
    if (call) {
      groups.push({ labels: pending, handler: call[1] });
      pending = [];
    }
  }
  if (pending.length > 0) groups.push({ labels: pending, handler: null });
  return groups;
}

/** Body of a top-level `function <name>` declaration, or null. */
function functionBody(src: string, name: string): string | null {
  const lines = src.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(l)
  );
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > start && lines[i] === '}') break;
  }
  return out.join('\n');
}

/**
 * If a local handler is a pure one-liner delegation (`daemonLogs` -> `await
 * commandLogs(args)`), return the delegate's name. Anything with real logic in
 * it owns its own subcommand and is not a wrapper — resolving further would
 * mistake an incidental helper call for the handler's home module.
 */
function delegationTarget(body: string | null): string | null {
  if (!body) return null;
  const inner = body
    .split('\n')
    .slice(1, -1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'));
  if (inner.length !== 1) return null;
  const call = /^(?:return\s+)?(?:await\s+)?(command[A-Za-z0-9_]*)\s*\(/.exec(inner[0]);
  return call ? call[1] : null;
}

/** Exported `function <x>Usage()` names declared in a source file. */
function exportedUsageFns(src: string): string[] {
  return [...src.matchAll(/^export\s+function\s+([A-Za-z0-9_]+Usage)\s*\(/gm)].map((m) => m[1]);
}

/** Relative module specifier an identifier is imported from, or null if local. */
function importSource(src: string, ident: string): string | null {
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(ident)) return m[2];
  }
  return null;
}

/** Keys/values of an `export const <ident>: Record<string, () => void> = {...}`. */
function usageMapEntries(src: string, ident: string): Record<string, string> {
  // `[^\n]*` skips the type annotation (which contains its own `=` in
  // `Record<string, () => void>`); the body runs to a `}` at column 0.
  const re = new RegExp(`export const ${ident}[^\\n]*=\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(src);
  if (!m) return {};
  const entries: Record<string, string> = {};
  for (const e of m[1].matchAll(/['"]?([A-Za-z0-9_-]+)['"]?\s*:\s*([A-Za-z0-9_]+)/g)) {
    entries[e[1]] = e[2];
  }
  return entries;
}

/** camelCase a kebab subcommand: `export-dockerfile` -> `ExportDockerfile`. */
function pascal(sub: string): string {
  return sub
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

async function readCommandFile(file: string): Promise<string> {
  return readFile(join(COMMANDS_DIR, file), 'utf-8');
}

async function auditMultiplexers(): Promise<Multiplexer[]> {
  const indexSrc = await readFile(join(SRC, 'index.ts'), 'utf-8');
  const barrelSrc = await readCommandFile('index.ts');

  const result: Multiplexer[] = [];

  // 1. Multiplexer entries in the dispatch table: `'system': { run: ..., subcommands: systemSubcommandUsage }`
  for (const m of indexSrc.matchAll(
    /'([a-z-]+)':\s*\{[^}]*?subcommands:\s*([A-Za-z0-9_]+)/g
  )) {
    const [, command, mapIdent] = m;

    // 2. Resolve the defining file through the commands barrel.
    const spec = importSource(barrelSrc, mapIdent) ?? exportSource(barrelSrc, mapIdent);
    if (!spec) throw new Error(`cannot resolve ${mapIdent} through src/cli/commands/index.ts`);
    const file = `${spec.replace(/^\.\//, '')}.ts`;
    const src = await readCommandFile(file);

    const parentUsage = `${command}Usage`;
    const mapped = usageMapEntries(src, mapIdent);

    // 3. Switch cases of the `command<Name>` dispatcher.
    const dispatcherName = `command${pascal(command)}`;
    const body = functionBody(src, dispatcherName);
    if (!body) throw new Error(`cannot find ${dispatcherName}() in ${file}`);
    const groups = switchCases(body);

    const dispatchable: string[] = [];
    const missing: string[] = [];
    const untraced: string[] = [];

    for (const group of groups) {
      dispatchable.push(...group.labels);
      if (!group.handler) {
        untraced.push(...group.labels);
        continue;
      }

      // 4. Trace the handler to the module that owns it, hopping once through a
      //    local wrapper (`daemonLogs` -> `commandLogs`).
      let handlerSpec = importSource(src, group.handler);
      if (!handlerSpec) {
        const delegate = delegationTarget(functionBody(src, group.handler));
        if (delegate) handlerSpec = importSource(src, delegate);
      }

      let usageFns: string[];
      if (handlerSpec) {
        const handlerFile = `${handlerSpec.replace(/^\.\//, '')}.ts`;
        usageFns = exportedUsageFns(await readCommandFile(handlerFile));
      } else {
        // Handler lives in the multiplexer file itself. Only a usage function
        // named after the subcommand counts — the parent's own usage doesn't,
        // and neither does a sibling subcommand's.
        const names = new Set(exportedUsageFns(src));
        usageFns = [
          `${command}${pascal(group.labels[0])}Usage`,
          `${pascal(group.labels[0]).charAt(0).toLowerCase()}${pascal(group.labels[0]).slice(1)}Usage`,
        ].filter((n) => names.has(n));
      }

      const dedicated = usageFns.filter((n) => n !== parentUsage);
      if (dedicated.length === 0) continue;

      for (const label of group.labels) {
        if (!(label in mapped)) missing.push(label);
      }
    }

    const unreachable = Object.keys(mapped).filter((k) => !dispatchable.includes(k));

    result.push({
      command,
      mapIdent,
      file,
      dispatchable,
      mapped,
      missing,
      unreachable,
      untraced,
    });
  }

  return result;
}

/** `export { a, b } from './x'` — the barrel re-exports rather than imports. */
function exportSource(src: string, ident: string): string | null {
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(ident)) return m[2];
  }
  return null;
}

describe('CLI multiplexer subcommand help coverage', () => {
  test('every subcommand with a dedicated usage function is in its parent usage map', async () => {
    const audits = await auditMultiplexers();

    const offenders = audits
      .filter((a) => a.missing.length > 0)
      .map(
        (a) =>
          `${a.file}: ${a.missing.map((s) => `'${s}'`).join(', ')} ` +
          `have a dedicated usage function but are absent from ${a.mapIdent} — ` +
          `\`lazy ${a.command} <sub> -h\` will print ${a.command}Usage() instead`
      );

    expect(offenders).toEqual([]);
  });

  // The reverse direction: a map key nothing dispatches is dead weight (or a
  // typo, which reads identically to "the help just doesn't work").
  test('every usage-map key is a dispatchable subcommand', async () => {
    const audits = await auditMultiplexers();

    const offenders = audits
      .filter((a) => a.unreachable.length > 0)
      .map(
        (a) =>
          `${a.file}: ${a.mapIdent} maps ${a.unreachable.map((s) => `'${s}'`).join(', ')} ` +
          `but command${pascal(a.command)}() has no matching case`
      );

    expect(offenders).toEqual([]);
  });

  // A source scan must prove it scanned something: without these guards a
  // rename of any convention above turns the test green by finding nothing.
  test('the scan finds the expected multiplexer surface', async () => {
    const audits = await auditMultiplexers();

    const byCommand = new Map(audits.map((a) => [a.command, a]));
    // `memory` (list/show/save/rm/history) and `stats` (read-only analytics)
    // must appear here for the same reason daemon/system do: the scan has to
    // prove it found the real surface, not silently miss a command.
    expect([...byCommand.keys()].sort()).toEqual(['daemon', 'memory', 'stats', 'system']);

    const stats = byCommand.get('stats')!;
    expect(stats.dispatchable).toContain('tokens');
    expect(Object.keys(stats.mapped)).toContain('tokens');

    const system = byCommand.get('system')!;
    expect(system.dispatchable).toContain('export-dockerfile');
    expect(system.dispatchable).toContain('prompts');
    expect(Object.keys(system.mapped)).toContain('export-dockerfile');

    const daemon = byCommand.get('daemon')!;
    expect(daemon.dispatchable.length).toBeGreaterThan(5);
    expect(Object.keys(daemon.mapped)).toContain('logs');

    // Every case must trace to a handler; an untraced one is a silent hole.
    for (const a of audits) expect(a.untraced).toEqual([]);
  });

  // Guard the detector itself: a dedicated-usage subcommand missing from the
  // map must be reported. Without this a broken regex passes silently.
  test('detects a subcommand whose usage function is absent from the map', () => {
    const src = [
      "import { commandWidget, widgetUsage } from './widget';",
      "import { commandGadget } from './gadget';",
      '',
      'export async function commandThing(args: string[]): Promise<void> {',
      '  switch (args[0]) {',
      "    case 'widget':",
      '      await commandWidget(args.slice(1));',
      '      break;',
      "    case 'gadget':",
      '      await commandGadget(args.slice(1));',
      '      break;',
      '  }',
      '}',
      '',
      'export const thingSubcommandUsage: Record<string, () => void> = {',
      "  'gadget': gadgetUsage,",
      '};',
    ].join('\n');

    const body = functionBody(src, 'commandThing')!;
    expect(switchCases(body)).toEqual([
      { labels: ['widget'], handler: 'commandWidget' },
      { labels: ['gadget'], handler: 'commandGadget' },
    ]);
    expect(importSource(src, 'commandWidget')).toBe('./widget');
    expect(Object.keys(usageMapEntries(src, 'thingSubcommandUsage'))).toEqual(['gadget']);
    // 'widget' has a usage function in its module but no map entry — exactly
    // the drift this suite exists to catch.
  });
});
