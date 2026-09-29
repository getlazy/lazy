/**
 * Undo git's C-style path quoting (`"b/\\303\\251.txt"`), which git applies to
 * any path with non-ASCII bytes, quotes, backslashes or control characters.
 * Paths from `--numstat -z` are raw, and the progressive Changes tab matches
 * the two by string — so the parsed diff must carry the raw spelling too.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
