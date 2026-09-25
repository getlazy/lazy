/**
 * The person's side of the usage-pause override: a CLI launch TAKES the
 * one-shot override only when it vouches that a person at their own terminal
 * asked (`usagePauseOverrideEligible`, src/cli/human-terminal.ts). The daemon
 * requires the flag (src/daemon/usage-pause.ts, `overrideEligible`), so a CLI
 * launch that forgets to send it silently takes the override away from the
 * person — and a helper that never answers "yes" would do the same everywhere.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { mayOfferUsagePauseOverride, PROMPT_TEST_SEAMS, usagePauseOverrideEligibility } from '../../src/cli/human-terminal';

const ENV_KEYS = ['LAZY_FORCE_CONTAINER', 'LAZY_ACTOR', ...PROMPT_TEST_SEAMS] as const;

describe('a person at their own terminal', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const savedTTY = process.stdin.isTTY;

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    (process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
  });

  /** Outside a container, stdin a TTY, no prompt seam, the human channel. */
  function asPersonAtTerminal(): void {
    process.env.LAZY_FORCE_CONTAINER = '0';
    delete process.env.LAZY_ACTOR;
    for (const seam of PROMPT_TEST_SEAMS) delete process.env[seam];
    (process.stdin as { isTTY?: boolean }).isTTY = true;
  }

  // INVARIANT: a person at their own terminal IS offered the override and
  // vouches for their launches. Every other test of this rule shows it being
  // withheld; a helper that never said "yes" would pass all of them while
  // taking the override away from the one caller it exists for.
  test('vouches for a launch and is offered the command', async () => {
    asPersonAtTerminal();
    expect(await usagePauseOverrideEligibility()).toEqual({ usagePauseOverrideEligible: true });
    expect(await mayOfferUsagePauseOverride()).toBe(true);
  });

  test('each of the four conditions withholds it on its own', async () => {
    const withheld = async (change: () => void) => {
      asPersonAtTerminal();
      change();
      expect(await usagePauseOverrideEligibility()).toEqual({});
    };
    await withheld(() => { process.env.LAZY_FORCE_CONTAINER = '1'; });
    await withheld(() => { (process.stdin as { isTTY?: boolean }).isTTY = false; });
    await withheld(() => { process.env.LAZY_PROMPT_DEFAULTS = '1'; });
    await withheld(() => { process.env.LAZY_ACTOR = 'builder'; });
  });
});

// --- Every CLI launch vouches through the helper ---

const LAUNCHES = [
  'queryStartTask', 'queryUnblockTask', 'queryResumeTask', 'querySyncTask',
  'queryAskTask', 'queryAskTaskAwaited', 'queryReviewTask', 'queryReviewTaskAwaited',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The full argument text of every call to `name`, parens balanced — never one line. */
function callsTo(name: string, source: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`(^|[^\\w.$])${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const before = source.slice(0, match.index + match[1].length);
    if (/\b(function|async function)\s*$/.test(before)) continue;
    const open = source.indexOf('(', match.index + match[1].length);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    calls.push(source.slice(open + 1, end));
  }
  return calls;
}

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('every CLI launch sends the usage-pause eligibility', () => {
  // INVARIANT: every launch call under src/cli/ passes
  // `usagePauseOverrideEligibility()` — directly, or by spreading a variable the
  // same file assigned from it. The daemon REQUIRES the flag, so a launch that
  // omits it quietly denies a person at their terminal the override they set
  // (the default `lazy review` / `lazy ask` paths shipped that way once).
  // Balanced parens, not one line: a call split across lines put its options
  // on another line, and a line-based scan once hid exactly that omission.
  test('no launch call omits it', async () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of await tsFiles(join(import.meta.dir, '../../src/cli'))) {
      const source = stripComments(await readFile(file, 'utf-8'));
      const vouchers = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*await\s+usagePauseOverrideEligibility\(\)/g)]
        .map((m) => m[1]);
      for (const name of LAUNCHES) {
        for (const call of callsTo(name, source)) {
          seen++;
          const vouched = call.includes('usagePauseOverrideEligibility()')
            || vouchers.some((v) => new RegExp(`\\.\\.\\.\\s*${v}\\b`).test(call));
          if (!vouched) missing.push(`${file.split('/src/')[1]}: ${name}(${call.replace(/\s+/g, ' ').slice(0, 80)}…)`);
        }
      }
    }
    // Not vacuous: the known launch call sites are all found.
    expect(seen).toBeGreaterThanOrEqual(12);
    expect(missing).toEqual([]);
  });
});
