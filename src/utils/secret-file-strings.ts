/**
 * Which strings of a secret FILE must be scrubbed from free text.
 *
 * Pure, so every surface that delivers secret files — the daemon writing them
 * into a task's worktree, Lazy Teams resolving a project's secret files — asks
 * the same question and registers the answer with the redactor
 * (`setRegisteredSecretValues`, src/utils/redact.ts) before the file reaches a
 * container.
 *
 * The rule:
 *
 *  - A dotenv-style file (`.env`, `.env.*`, `*.env`): the parsed VALUES, never
 *    the keys or the comments. Scrubbing `DATABASE_URL=` itself would only
 *    corrupt text that names the variable, which is not secret.
 *  - Any other file (a PEM key, a JSON service-account blob, a kubeconfig): the
 *    whole content, plus each non-trivial line (minus `#` comments and PEM
 *    armour), because a log line carries one
 *    line of a file far more often than the whole of it.
 *
 * Triviality is the redactor's own rule (isScrubbableSecretValue), applied to
 * the strings returned here, so a `true`, `1` or `production` in a dotenv file
 * is never substring-replaced everywhere. The redactor further expands each
 * string (encodings, a large file matched by its lines) — this function only
 * decides WHICH parts of a file are secret.
 */

import { basename } from 'path';
import { isScrubbableSecretValue, PEM_ARMOUR } from './redact';

/** True for a path the dotenv rule applies to: `.env`, `.env.local`, `prod.env`. */
export function isDotenvPath(path: string): boolean {
  const name = basename(path);
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

/** Index of the first closing `quote` in `body`; inside double quotes a backslash escapes the next character. */
function closingQuote(body: string, quote: string): number {
  for (let j = 0; j < body.length; j++) {
    if (quote === '"' && body[j] === '\\') { j++; continue; }
    if (body[j] === quote) return j;
  }
  return -1;
}

/**
 * Parse dotenv VALUES. Handles `export KEY=…`, `#` comment lines, an unquoted
 * value's trailing ` # comment`, single quotes (literal) and double quotes
 * (with `\n` escapes, and spanning several lines until the closing quote).
 * Lines that are not assignments are ignored — they hold no value.
 */
export function parseDotenvValues(contents: string): string[] {
  const values: string[] = [];
  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|$)/.test(line)) continue;
    const m = DOTENV_LINE.exec(line);
    if (!m) continue;
    let raw = m[2];
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let body = raw.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += '\n' + lines[++i];
        end = closingQuote(body, quote);
      }
      const value = end < 0 ? body : body.slice(0, end);
      values.push(quote === '"' ? value.replace(/\\n/g, '\n').replace(/\\"/g, '"') : value);
      continue;
    }
    const hash = raw.search(/\s#/);
    if (hash >= 0) raw = raw.slice(0, hash);
    values.push(raw.trim());
  }
  return values;
}

/**
 * The strings to register with the redactor for one secret file. Deduplicated
 * and filtered to scrubbable ones; empty for a file with nothing distinctive.
 */
export function secretStringsForFile(path: string, contents: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => { if (isScrubbableSecretValue(v)) out.add(v); };
  if (isDotenvPath(path)) {
    for (const value of parseDotenvValues(contents)) add(value);
  } else {
    add(contents);
    // PEM armour (`-----BEGIN PRIVATE KEY-----`) is the same in every key file
    // and names a format, not a secret; a `#` comment line is not secret either
    // and a stock one recurs across files.
    for (const line of contents.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('#') && !PEM_ARMOUR.test(t)) add(t);
    }
  }
  return [...out];
}
