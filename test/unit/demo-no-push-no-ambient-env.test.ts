/**
 * INVARIANT: nothing under `src/demo/` ever runs `git push`, and no demo
 * subprocess runs outside the demo's environment allowlist.
 *
 * The engineer's rule (2026-09-20), after a fleet demo shipped that force-pushed
 * a generated fixture to a repository the human named, using the human's own
 * git credentials borrowed from the ambient environment: "What kind of a
 * terrible destructive demo this is?" Removing that code path was not enough —
 * this scan is what keeps the next one from being written. If a future demo
 * ever needs a remote, it is a URL the human gives, read-only, and nothing
 * else. The rule itself is in the module comment of src/demo/runtime.ts.
 *
 * Two mechanical checks, each failing with the file and line:
 *
 *  1. No `push` as a git verb — in an argv array (`'push'`, `"push"`) or a
 *     shell string (`git push`), and no `--force`. Array `.push(` and prose
 *     about the daemon's own pushes are not git verbs and are allowed.
 *  2. No subprocess with a non-allowlisted environment: no spread of
 *     `process.env` into anything, no `env: process.env`, no
 *     `Object.entries(process.env)` / `Object.assign(…, process.env)`, and
 *     every `spawn(` / `spawnSyncUnsupervised(` / `Bun.spawn(` call passes an
 *     `env:`. Keyed reads (`process.env.HOME`, `process.env[key]`) are how the
 *     allowlist itself is built and are allowed.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..');
const demoDir = join(repoRoot, 'src', 'demo');

function demoSources(dir = demoDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...demoSources(full));
    else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out.sort();
}

/**
 * The demo agent's own program, embedded in agent.ts as a `String.raw` template
 * and run INSIDE the demo daemon's environment (already the allowlist). Its
 * lines are a different process's code and are excluded from both scans.
 */
function withoutEmbeddedAgent(file: string, text: string): string {
  if (!file.endsWith('agent.ts')) return text;
  const start = text.indexOf('const DEMO_AGENT_SOURCE = String.raw`');
  if (start === -1) return text;
  const end = text.indexOf('\n`;', start);
  const blanked = text.slice(start, end).replace(/[^\n]/g, '');
  return text.slice(0, start) + blanked + text.slice(end);
}

/** `path:line: text` for every line of `text` matching `re`, comments stripped. */
function offending(re: RegExp, keep: (line: string) => boolean = () => true): string[] {
  const hits: string[] = [];
  for (const file of demoSources()) {
    const lines = withoutEmbeddedAgent(file, readFileSync(file, 'utf8')).split('\n');
    lines.forEach((raw, i) => {
      // Strip line comments and the bodies of block-comment lines: prose about
      // pushes (the daemon's own, the invariant's own text) is not code.
      const line = raw.replace(/^\s*(\*|\/\/|\/\*\*?).*$/, '').replace(/\/\/.*$/, '');
      if (re.test(line) && keep(line)) hits.push(`${relative(repoRoot, file)}:${i + 1}: ${raw.trim()}`);
    });
  }
  return hits;
}

describe('src/demo never pushes to a remote', () => {
  test('the scan reads the demo sources at all', () => {
    expect(demoSources().length).toBeGreaterThan(8);
    expect(demoSources().some(f => f.endsWith('fleet.ts'))).toBe(true);
  });

  test('no git push verb, in an argv array or a shell string', () => {
    // `'push'` / `"push"` as a standalone string token; `git push` in a
    // template or string; never `.push(` (the array method) — that has a dot.
    const gitPush = /(?<![.\w])['"`]push['"`]|\bgit\s+push\b|['"]push['"]\s*,/;
    expect(offending(gitPush)).toEqual([]);
  });

  test('no --force anywhere a subprocess could receive it', () => {
    // smolvm's `machine delete --force` is the one legitimate force flag, and
    // it never touches a repository; everything else is refused.
    expect(offending(/--force/, l => !/machine.*delete|delete.*machine/.test(l))).toEqual([]);
  });

  test('the scan catches the shape that shipped', () => {
    const shipped = "await run$('git push (fixture remote)', ['git', 'push', '--force', '--quiet', remote, 'HEAD:refs/heads/main'], { cwd, env })";
    expect(/(?<![.\w])['"`]push['"`]|\bgit\s+push\b|['"]push['"]\s*,/.test(shipped)).toBe(true);
    expect(/--force/.test(shipped)).toBe(true);
    // …and not the array method or prose.
    expect(/(?<![.\w])['"`]push['"`]|\bgit\s+push\b|['"]push['"]\s*,/.test("lines.push('Origin: pushes fail')")).toBe(false);
  });
});

describe('src/demo never hands a subprocess the ambient environment', () => {
  test('process.env is only ever read by key, never spread or passed whole', () => {
    // A spread, a whole-object pass, or an enumeration of process.env: each
    // one is the ambient environment leaving this process for a child.
    // A typed default parameter (`env: NodeJS.ProcessEnv = process.env`) on a
    // PURE function is a read-only view for keyed lookups, not a launch; the
    // type annotation is what distinguishes it.
    const whole = /\.\.\.process\.env\b|env:\s*process\.env\b|Object\.(entries|assign|keys)\(\s*process\.env\b|(?<!NodeJS\.ProcessEnv\s)=\s*process\.env\s*[;,)]/;
    expect(offending(whole)).toEqual([]);
  });

  test('every subprocess launch passes an env', () => {
    // Multi-line call sites: join the file and inspect each call's argument
    // list up to its closing paren at depth 0.
    const problems: string[] = [];
    for (const file of demoSources()) {
      const text = withoutEmbeddedAgent(file, readFileSync(file, 'utf8'));
      const re = /\b(spawn|spawnSyncUnsupervised|Bun\.spawn|spawnSync)\(/g;
      for (const m of text.matchAll(re)) {
        // The wrapper in runtime.ts that every other launch goes through takes
        // `opts.env` from its caller; it is the callers that are checked.
        if (file.endsWith('runtime.ts') && m[1] === 'spawn') continue;
        let depth = 0; let end = m.index! + m[0].length - 1;
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')' && --depth === 0) break;
        }
        const call = text.slice(m.index!, end + 1);
        if (!/\benv\s*[:,]/.test(call) && !/\benv\b/.test(call)) {
          const line = text.slice(0, m.index!).split('\n').length;
          problems.push(`${relative(repoRoot, file)}:${line}: ${call.split('\n')[0]!.trim()}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('the scan catches a spread of the ambient environment', () => {
    const whole = /\.\.\.process\.env\b|env:\s*process\.env\b|Object\.(entries|assign|keys)\(\s*process\.env\b|(?<!NodeJS\.ProcessEnv\s)=\s*process\.env\s*[;,)]/;
    expect(whole.test('for (const [k, v] of Object.entries(process.env)) env[k] = v;')).toBe(true);
    expect(whole.test('export function f(env: NodeJS.ProcessEnv = process.env) {')).toBe(false);
    expect(whole.test('const env = process.env;')).toBe(true);
    expect(whole.test('env: { ...process.env, LAZY_TEST: "" }')).toBe(true);
    expect(whole.test("const home = process.env.HOME ?? '';")).toBe(false);
    expect(whole.test('const value = process.env[key];')).toBe(false);
  });
});
