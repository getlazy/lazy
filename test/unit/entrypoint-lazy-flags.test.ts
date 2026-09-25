/**
 * Every flag the self-host entrypoint passes to lazy must be a flag lazy
 * actually registers.
 *
 * `lazy-teams/deploy/entrypoint.sh` runs the lazy CLI at container start, and
 * it is the one caller no suite in either half of this repository executes: the
 * Rails suite may not shell out to lazy at all, and the Bun suite has no reason
 * to run a shell script that only makes sense inside the shipped image. So a
 * wrong flag there is invisible until somebody builds the image and boots it.
 *
 * It shipped that way. The runner build was written as
 * `system build lazy-runner --yes`, `system build` registers only `--no-cache`
 * and `--timeout`, and the CLI answered `Unknown flag: --yes` — from the day
 * the line was written until the seventh end-to-end run found it. The flag was
 * never real; nothing had ever run the line.
 *
 * This reads the entrypoint as text and each command's `parseFlags` table as
 * text, because the alternative — importing `src/index.ts` — executes the CLI.
 * Same approach as `cli-flag-alias-coverage.test.ts`, and it fails loudly when
 * it cannot resolve a table rather than quietly covering nothing.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');
const ENTRYPOINT = join(ROOT, 'lazy-teams', 'deploy', 'entrypoint.sh');
const COMMANDS_DIR = join(ROOT, 'src', 'cli', 'commands');

/** Flags the dispatcher in `src/index.ts` handles before a command's own parseFlags. */
const GLOBALLY_HANDLED = new Set(['help']);

interface Invocation {
  /** The command words, e.g. ['system', 'build']. */
  command: string[];
  /** Long-flag names without the dashes, e.g. ['no-cache']. */
  flags: string[];
  /** The line as written, for a failure message somebody can act on. */
  source: string;
}

/**
 * Pull every `bun run <…>/src/index.ts …` invocation out of a shell script.
 *
 * Backslash continuations are joined first: the runner build is written across
 * two lines with the `gosu`/`env` prefix on the first, and a line-by-line scan
 * would read the flags without the command or vice versa.
 */
function lazyInvocations(script: string): Invocation[] {
  const joined = script.replace(/\\\r?\n\s*/g, ' ');
  const out: Invocation[] = [];

  for (const line of joined.split('\n')) {
    const trimmed = line.trim();
    // The entrypoint QUOTES these commands in its own error messages ("expected
    // 'bun run …' to print an id"). Prose about an invocation is not an
    // invocation, and reading one as a command produced a "flag" made of the
    // rest of the sentence.
    if (/^(#|log\b|echo\b)/.test(trimmed)) continue;

    const match = /bun\s+run\s+\S*src\/index\.ts\s+([^;|&]+)/.exec(line);
    if (!match) continue;

    const words = match[1]!.trim().split(/\s+/).filter(Boolean);
    const command: string[] = [];
    const flags: string[] = [];
    let seenFlag = false;

    for (const word of words) {
      if (word.startsWith('--')) {
        seenFlag = true;
        // `--flag=value` and `--flag value` both name the same flag.
        flags.push(word.slice(2).split('=')[0]!);
        continue;
      }
      // A bare word after a flag is that flag's VALUE, not a command word.
      if (seenFlag) continue;
      // Stop at anything the shell would expand — a command name is literal.
      if (word.startsWith('$') || word.startsWith('"') || word.startsWith("'")) break;
      command.push(word);
    }

    if (command.length > 0) out.push({ command, flags, source: line.trim() });
  }

  return out;
}

/**
 * The flag names a command registers, found by its `parseFlags(…, 'name')`
 * literal — the same convention `cli-command-discoverability.test.ts` relies on.
 *
 * Returns null when no command declares that literal, which the caller reports
 * rather than treating as "no flags to check".
 */
async function registeredFlags(command: string): Promise<string[] | null> {
  for (const file of await readdir(COMMANDS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = await readFile(join(COMMANDS_DIR, file), 'utf-8');

    // The table is the argument list ending in `], '<command>'`.
    const marker = `], '${command}'`;
    const end = src.indexOf(marker);
    if (end === -1) continue;

    const start = src.lastIndexOf('parseFlags(', end);
    if (start === -1) continue;

    const table = src.slice(start, end);
    return [...table.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]!);
  }
  return null;
}

/**
 * Flag tables built from a shared constant rather than an inline literal, with
 * the names that constant contributes. `system build` spreads
 * `BUILD_TIMEOUT_FLAG` in, so scanning for `name:` inside the table alone would
 * miss `--timeout` and call a correct invocation broken.
 */
const SHARED_FLAG_CONSTANTS: Record<string, string> = {
  BUILD_TIMEOUT_FLAG: 'timeout',
};

async function expandedFlags(command: string): Promise<string[] | null> {
  const direct = await registeredFlags(command);
  if (direct === null) return null;

  const extra: string[] = [];
  for (const file of await readdir(COMMANDS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = await readFile(join(COMMANDS_DIR, file), 'utf-8');
    const end = src.indexOf(`], '${command}'`);
    if (end === -1) continue;
    const start = src.lastIndexOf('parseFlags(', end);
    const table = src.slice(start, end);
    for (const [constant, flag] of Object.entries(SHARED_FLAG_CONSTANTS)) {
      if (table.includes(constant)) extra.push(flag);
    }
  }
  return [...direct, ...extra];
}

describe('the self-host entrypoint passes flags lazy knows', () => {
  test('the scan finds the entrypoint invocations it is meant to check', async () => {
    const found = lazyInvocations(await readFile(ENTRYPOINT, 'utf-8'));

    // A scan that silently stopped matching would pass every assertion below.
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((i) => i.command.join(' '))).toContain('system build lazy-runner');
  });

  // INVARIANT: every flag the entrypoint hands the lazy CLI is registered by
  // the command it hands it to. Nothing else runs this file before the image
  // is built and booted, so an unknown flag is not a warning — it is the
  // container dying at first boot with the runner image unbuilt.
  test('every flag the entrypoint passes is registered by its command', async () => {
    const invocations = lazyInvocations(await readFile(ENTRYPOINT, 'utf-8'));
    const problems: string[] = [];

    for (const invocation of invocations) {
      // The command is the longest leading prefix that names a real table:
      // `system build lazy-runner` is the command `system build` plus an
      // argument.
      let known: string[] | null = null;
      let resolved = '';
      for (let take = invocation.command.length; take > 0; take -= 1) {
        const candidate = invocation.command.slice(0, take).join(' ');
        const flags = await expandedFlags(candidate);
        if (flags) {
          known = flags;
          resolved = candidate;
          break;
        }
      }

      if (!known) {
        problems.push(
          `${invocation.source}\n    no parseFlags table found for any prefix of ` +
          `'${invocation.command.join(' ')}' — the scan could not check it`,
        );
        continue;
      }

      for (const flag of invocation.flags) {
        if (GLOBALLY_HANDLED.has(flag)) continue;
        if (known.includes(flag)) continue;
        problems.push(
          `${invocation.source}\n    '--${flag}' is not registered by \`lazy ${resolved}\` ` +
          `(it accepts: ${known.map((f) => `--${f}`).join(', ') || 'no flags'})`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  // The detector has to be shown to work on the shape the bug really had, or
  // its empty result above means nothing.
  test('the scan reports an unregistered flag', async () => {
    const script = [
      'if ! gosu rails env LAZY_MANAGED= \\',
      '    bun run /lazy/src/index.ts system build lazy-runner --yes; then',
      'fi',
    ].join('\n');

    const invocations = lazyInvocations(script);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.command).toEqual(['system', 'build', 'lazy-runner']);
    expect(invocations[0]!.flags).toEqual(['yes']);

    const known = await expandedFlags('system build');
    expect(known).not.toBeNull();
    expect(known).not.toContain('yes');
    // …and the flags it DOES take are found, including the shared one.
    expect(known).toContain('no-cache');
    expect(known).toContain('timeout');
  });
});
