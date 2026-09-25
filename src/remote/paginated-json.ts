/**
 * Parse forge CLI `--paginate` output without corrupting comment bodies.
 *
 * `gh api --paginate` (and `glab api --paginate`) concatenate JSON pages as
 * `][`. A global `][` → `],[` rewrite also matches markdown reference links
 * (`[text][ref]`) inside comment bodies, which turns valid JSON into a parse
 * error. Walk one JSON value at a time instead, tracking strings so `][`
 * inside a body is just data.
 *
 * `--paginate --slurp` (one JSON array of pages) also lands here: a single
 * value that is itself an array of arrays, which we flatten.
 */

/** Records from one or more concatenated JSON pages (arrays or objects). */
export function parsePaginatedApiJson(raw: string): Array<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const values = parseConcatenatedJson(trimmed);
  const records: Array<Record<string, unknown>> = [];
  for (const value of values) {
    pushRecords(value, records);
  }
  return records;
}

function pushRecords(value: unknown, into: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      // --slurp wraps each page; pages are arrays of comments.
      if (Array.isArray(item)) {
        pushRecords(item, into);
      } else if (isRecord(item)) {
        into.push(item);
      }
    }
    return;
  }
  if (isRecord(value)) into.push(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConcatenatedJson(raw: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && isJsonSpace(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    i = skipJsonValue(raw, i);
    out.push(JSON.parse(raw.slice(start, i)));
  }
  return out;
}

function isJsonSpace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t';
}

/**
 * Advance past one JSON value starting at `i`. Throws on truncated input
 * rather than walking off the end and silently dropping a page.
 */
function skipJsonValue(s: string, i: number): number {
  if (i >= s.length) {
    throw new Error('truncated JSON in paginated forge response');
  }
  const c = s[i]!;
  if (c === '"') return skipJsonString(s, i);
  if (c === '{' || c === '[') return skipJsonContainer(s, i);
  if (c === 't' && s.startsWith('true', i)) return i + 4;
  if (c === 'f' && s.startsWith('false', i)) return i + 5;
  if (c === 'n' && s.startsWith('null', i)) return i + 4;
  if (c === '-' || (c >= '0' && c <= '9')) return skipJsonNumber(s, i);
  throw new Error(`invalid JSON in paginated forge response at index ${i}`);
}

function skipJsonString(s: string, i: number): number {
  // s[i] === '"'
  i++;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i++;
  }
  throw new Error('unterminated string in paginated forge response');
}

function skipJsonContainer(s: string, i: number): number {
  const open = s[i]!;
  const close = open === '{' ? '}' : ']';
  const isObject = open === '{';
  i++;
  while (i < s.length) {
    while (i < s.length && isJsonSpace(s[i]!)) i++;
    if (i >= s.length) break;
    if (s[i] === close) return i + 1;
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (isObject) {
      i = skipJsonValue(s, i);
      while (i < s.length && isJsonSpace(s[i]!)) i++;
      if (s[i] !== ':') {
        throw new Error('expected \':\' in paginated forge JSON object');
      }
      i++;
      while (i < s.length && isJsonSpace(s[i]!)) i++;
    }
    i = skipJsonValue(s, i);
  }
  throw new Error('unterminated array or object in paginated forge response');
}

function skipJsonNumber(s: string, i: number): number {
  const rest = s.slice(i);
  const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
  if (!m) throw new Error('invalid number in paginated forge response');
  return i + m[0].length;
}
