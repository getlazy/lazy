/**
 * Minimal, comment-preserving TOML editing.
 *
 * Bun ships `Bun.TOML.parse` but no serializer, and a parse→stringify round
 * trip would destroy every comment in lazy.toml — which for this file is most
 * of its value (the template written by `lazy init` is almost entirely
 * documentation). So instead of re-rendering the document, we edit it as
 * TEXT: locate the exact line range of one `key = …` inside one `[section]`
 * and splice a replacement in. Everything we don't touch — comments, blank
 * lines, key order, quoting style — survives byte-for-byte.
 *
 * Deliberate limitations (documented in docs/protected-branches.md):
 *   - Only top-level `[section]` tables and string-array / boolean values are
 *     handled; that is all `lazy protect` needs.
 *   - Dotted top-level keys (`protection.protected_branches = [...]`) and
 *     inline tables (`protection = { ... }`) are DETECTED and rejected with an
 *     actionable error rather than silently mis-edited.
 *   - A replaced multi-line array collapses to one line. Comments *inside*
 *     that array's brackets are lost; comments above and below it are not.
 */

/** Thrown when the file uses a TOML shape this editor cannot safely edit. */
export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TomlEditError';
  }
}

/** Escape a string for a TOML basic (double-quoted) string. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render `key = ["a", "b"]` (or `key = []`). */
function renderStringArray(key: string, values: string[]): string {
  return `${key} = [${values.map(quote).join(', ')}]`;
}

/**
 * Net bracket depth change contributed by a line, ignoring brackets inside
 * strings and after a `#` comment. Used to walk over multi-line arrays so a
 * `[` that opens a continuation line is never mistaken for a section header.
 */
function bracketDelta(line: string): number {
  let delta = 0;
  let quoteChar: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"') { i++; continue; }
      if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quoteChar = ch; continue; }
    if (ch === '#') break;
    if (ch === '[') delta++;
    else if (ch === ']') delta--;
  }
  return delta;
}

interface KeyRange {
  /** Index of the line the key starts on. */
  start: number;
  /** Index of the line the value ends on (same as start for single-line values). */
  end: number;
}

interface SectionScan {
  /** Line index of the `[section]` header, or -1 when the section is absent. */
  headerLine: number;
  /** Line index just past the last line belonging to the section. */
  bodyEnd: number;
  /** Active (uncommented) keys found directly in the section. */
  keys: Map<string, KeyRange>;
}

/**
 * Scan the document for one top-level `[section]` table.
 *
 * Only ACTIVE lines count: a commented-out `# protected_branches = [...]` is
 * left alone (it is documentation), and a fresh value is inserted next to it.
 */
function scanSection(lines: string[], section: string): SectionScan {
  const scan: SectionScan = { headerLine: -1, bodyEnd: -1, keys: new Map() };
  let inSection = false;
  let depth = 0;
  let pending: { key: string; start: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Inside a multi-line value: consume until the brackets balance.
    if (depth > 0) {
      depth += bracketDelta(line);
      if (depth <= 0) {
        if (pending && inSection) scan.keys.set(pending.key, { start: pending.start, end: i });
        pending = null;
        depth = 0;
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const header = trimmed.match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      if (inSection) {
        scan.bodyEnd = i;
        inSection = false;
      }
      const name = header[1]!;
      if (name === section && scan.headerLine === -1) {
        scan.headerLine = i;
        inSection = true;
      }
      continue;
    }

    const keyMatch = trimmed.match(/^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!.trim();

    if (!inSection && key.replace(/\s/g, '').startsWith(`${section}.`)) {
      throw new TomlEditError(
        `lazy.toml uses the dotted key '${key}', which this editor cannot safely rewrite. ` +
        `Rewrite it as a [${section}] section (or edit the value by hand) and re-run.`,
      );
    }
    if (!inSection && key === section) {
      throw new TomlEditError(
        `lazy.toml defines '${section}' as an inline table on one line, which this editor cannot ` +
        `safely rewrite. Rewrite it as a [${section}] section (or edit the value by hand) and re-run.`,
      );
    }

    const delta = bracketDelta(line);
    if (delta > 0) {
      depth = delta;
      pending = { key, start: i };
    } else if (inSection) {
      scan.keys.set(key, { start: i, end: i });
    }
  }

  if (pending && inSection) scan.keys.set(pending.key, { start: pending.start, end: lines.length - 1 });
  if (inSection) scan.bodyEnd = lines.length;
  return scan;
}

/**
 * Set `key = [...]` inside `[section]`, creating the key (and the section)
 * when missing. Returns the new file content.
 *
 * The array is always written explicitly, including when empty: after
 * `lazy protect <branch> off` removes the last entry, `protected_branches = []`
 * says plainly "no branches are protected" rather than leaving the reader to
 * infer it from an absence.
 */
export function setSectionStringArray(
  content: string,
  section: string,
  key: string,
  values: string[],
): string {
  return setSectionValue(content, section, key, renderStringArray(key, values));
}

/**
 * Set `key = true|false` inside `[section]`, creating the key (and the
 * section) when missing. Used by `lazy protect <target> on` to flip the
 * `[protection] enabled` master switch, which is opt-in and therefore off
 * until something turns it on.
 */
export function setSectionBoolean(
  content: string,
  section: string,
  key: string,
  value: boolean,
): string {
  return setSectionValue(content, section, key, `${key} = ${value}`);
}

/** Splice one already-rendered `key = value` line into `[section]`. */
function setSectionValue(
  content: string,
  section: string,
  key: string,
  rendered: string,
): string {
  const lines = content.split('\n');
  const scan = scanSection(lines, section);

  const existing = scan.keys.get(key);
  if (existing) {
    const indent = lines[existing.start]!.match(/^\s*/)![0];
    lines.splice(existing.start, existing.end - existing.start + 1, `${indent}${rendered}`);
    return lines.join('\n');
  }

  if (scan.headerLine === -1) {
    // No section at all — append one. Keep exactly one blank line before it.
    const base = content.replace(/\n+$/, '');
    const prefix = base === '' ? '' : `${base}\n\n`;
    return `${prefix}[${section}]\n${rendered}\n`;
  }

  // Insert at the end of the section's own lines, before any trailing blank
  // lines that separate it from the next section.
  let insertAt = scan.bodyEnd === -1 ? lines.length : scan.bodyEnd;
  while (insertAt > scan.headerLine + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
  lines.splice(insertAt, 0, rendered);
  return lines.join('\n');
}
