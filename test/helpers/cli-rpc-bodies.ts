/**
 * The exact top-level request-body keys lazy's own CLI sends for each
 * top-level RPC command — read off the source, so a lazy-side test can check
 * the Teams proxy's per-command body-key allowlist
 * (`CliRpcCommand::BODY_KEYS`) against what the CLI really sends.
 *
 * EXACT, not a union of every `key:` in the enclosing function (the older
 * scan in `cli-proxy-message-param-parity.test.ts` does that, which also picks
 * up return-type fields): for an allowlist, a key collected by accident is a
 * key admitted by accident. So each call's params argument is parsed:
 *
 *   - an object literal → its top-level keys, including shorthand (`taskId,`)
 *     and the object literals inside a spread (`...(x ? { a } : {})`);
 *   - a spread of an identifier (`...input`) → the keys of that parameter's
 *     declared type (an inline type literal, or a named interface found in
 *     the module list below);
 *   - a bare identifier (`params`) → the keys of that parameter's declared
 *     type, the same way;
 *   - nothing / `{}` → no keys.
 *
 * Anything it cannot resolve THROWS, naming the call site — a parser that
 * silently answered "no keys" would make an allowlist check pass vacuously.
 *
 * Two sources: `src/daemon/rpc-fallback.ts` (every `tryRpc…('<cmd>'` call)
 * and `src/cli/review-actions-rpc.ts` (the review TUI's `call('<cmd>'`).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Modules searched for a named interface a spread or bare param is typed as. */
const INTERFACE_MODULES = [
  'src/daemon/rpc-fallback.ts',
  'src/cli/review-actions-rpc.ts',
  'src/server/review-actions.ts',
];

export interface CliRpcBody {
  keys: Set<string>;
  /** `file:function` of one call site, for failure messages. */
  sites: string[];
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Blank out comments and string contents so braces inside them never count. */
function mask(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const q = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== q) j += source[j] === '\\' ? 2 : 1;
      // Keep the quotes so a command name stays matchable; blank the inside.
      out += q + source.slice(i + 1, j).replace(/[^\n]/g, ' ') + q;
      i = j + 1;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

const OPEN: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

/** Index just past the bracket that closes the one at `start`. */
function closing(masked: string, start: number): number {
  const stack: string[] = [];
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '{' || ch === '[') stack.push(OPEN[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) throw new Error(`unbalanced ${ch} at ${i}`);
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error(`no closing bracket for ${masked[start]} at ${start}`);
}

/** Split `text` on `sep` characters at bracket depth 0. */
function splitTop(text: string, seps: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (depth === 0 && seps.includes(ch)) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Keys of a type literal body (`a: T; b?: U`) — `{`/`}` already stripped. */
function typeLiteralKeys(inner: string): Set<string> {
  const keys = new Set<string>();
  for (const member of splitTop(inner, ';,\n')) {
    const m = member.match(/^(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function interfaceKeys(name: string): Set<string> {
  for (const rel of INTERFACE_MODULES) {
    const masked = mask(read(rel));
    const m = masked.match(new RegExp(`interface ${name}\\s*(?:extends[^{]*)?\\{`));
    if (!m) continue;
    const open = m.index! + m[0].length - 1;
    return typeLiteralKeys(masked.slice(open + 1, closing(masked, open) - 1));
  }
  throw new Error(`cli-rpc-bodies: cannot find interface ${name} in ${INTERFACE_MODULES.join(', ')}`);
}

/** Keys of a TYPE expression: an inline literal or a named interface. */
function typeKeys(type: string, where: string): Set<string> {
  const t = type.trim();
  if (t.startsWith('{')) return typeLiteralKeys(t.slice(1, t.lastIndexOf('}')));
  const named = t.match(/^([A-Z]\w*)$/);
  if (named) return interfaceKeys(named[1]);
  throw new Error(`cli-rpc-bodies: cannot resolve the type "${t}" at ${where}`);
}

/** The enclosing function's parameters: name → declared type text. */
function enclosingParams(masked: string, callIndex: number): { name: string; params: Map<string, string> } {
  const header = /(?:export\s+)?async\s+(?:function\s+)?(\w+)\s*(?:<[^(]*>)?\(/g;
  let found: RegExpExecArray | null = null;
  for (const m of masked.matchAll(header)) {
    if (m.index! < callIndex) found = m as RegExpExecArray;
    else break;
  }
  if (!found) throw new Error(`cli-rpc-bodies: no enclosing function for the call at ${callIndex}`);
  const open = found.index! + found[0].length - 1;
  const inner = masked.slice(open + 1, closing(masked, open) - 1);
  const params = new Map<string, string>();
  for (const p of splitTop(inner, ',')) {
    const m = p.match(/^([A-Za-z_]\w*)\??\s*:\s*([\s\S]+?)(?:=[\s\S]*)?$/);
    if (m) params.set(m[1], m[2]);
  }
  return { name: found[1], params };
}

/** Keys of one params ARGUMENT expression. */
function argumentKeys(expr: string, fnParams: Map<string, string>, where: string): Set<string> {
  const e = expr.trim();
  if (e === '' ) return new Set();
  if (/^[A-Za-z_]\w*$/.test(e)) {
    const type = fnParams.get(e);
    if (!type) throw new Error(`cli-rpc-bodies: "${e}" is not a typed parameter at ${where}`);
    return typeKeys(type, where);
  }
  if (!e.startsWith('{')) throw new Error(`cli-rpc-bodies: cannot read the params argument "${e.slice(0, 40)}" at ${where}`);
  return objectLiteralKeys(e.slice(1, closing(e, 0) - 1), fnParams, where);
}

function objectLiteralKeys(inner: string, fnParams: Map<string, string>, where: string): Set<string> {
  const keys = new Set<string>();
  for (const entry of splitTop(inner, ',')) {
    if (entry.startsWith('...')) {
      const spread = entry.slice(3).trim();
      if (/^[A-Za-z_]\w*$/.test(spread)) {
        for (const k of argumentKeys(spread, fnParams, where)) keys.add(k);
        continue;
      }
      // A conditional spread: every object literal inside contributes.
      let found = false;
      for (let i = 0; i < spread.length; i++) {
        if (spread[i] !== '{') continue;
        const end = closing(spread, i);
        for (const k of objectLiteralKeys(spread.slice(i + 1, end - 1), fnParams, where)) keys.add(k);
        found = true;
        i = end - 1;
      }
      if (!found) throw new Error(`cli-rpc-bodies: cannot read the spread "${entry}" at ${where}`);
      continue;
    }
    const m = entry.match(/^([A-Za-z_]\w*)\s*(?::|$)/);
    if (!m) throw new Error(`cli-rpc-bodies: cannot read the entry "${entry}" at ${where}`);
    keys.add(m[1]);
  }
  return keys;
}

function scan(rel: string, callPattern: RegExp, into: Map<string, CliRpcBody>): void {
  const masked = mask(read(rel));
  const raw = read(rel);
  for (const m of masked.matchAll(callPattern)) {
    // The command name is read off the RAW source — masking blanked it.
    const nameStart = m.index! + m[0].length;
    const quote = raw[nameStart - 1];
    const nameEnd = raw.indexOf(quote, nameStart);
    const command = raw.slice(nameStart, nameEnd);
    const open = m.index! + m[0].search(/\(\s*['"]$/);
    const args = splitTop(masked.slice(open + 1, closing(masked, open) - 1), ',');
    const fn = enclosingParams(masked, m.index!);
    const where = `${rel}:${fn.name}`;
    const keys = args.length > 1 ? argumentKeys(args[1], fn.params, where) : new Set<string>();
    const existing = into.get(command);
    if (existing) {
      for (const k of keys) existing.keys.add(k);
      existing.sites.push(where);
    } else {
      into.set(command, { keys, sites: [ where ] });
    }
  }
}

let cached: Map<string, CliRpcBody> | undefined;

/** Command → the exact top-level body keys the CLI sends for it. */
export function cliRpcBodies(): Map<string, CliRpcBody> {
  if (cached) return cached;
  const bodies = new Map<string, CliRpcBody>();
  scan('src/daemon/rpc-fallback.ts', /tryRpc(?:Void)?(?:<.*?>)?\(\s*'/g, bodies);
  scan('src/cli/review-actions-rpc.ts', /\bcall\(\s*'/g, bodies);
  cached = bodies;
  return bodies;
}
