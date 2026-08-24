/**
 * INVARIANT: KNOWN_CONFIG_SCHEMA must cover the entire documented config surface.
 *
 * `findUnknownConfigKeys` powers the "Unknown config option" warnings in
 * `lazy doctor`. It is a denylist-by-omission: anything the schema forgets is
 * reported to the user as a typo or a stale option, even when the key is fully
 * implemented and documented. That is exactly how `[proxy.policy]` and the whole
 * `[memory]` section came to be flagged on valid configs — the schema drifted
 * behind `src/config/types.ts` and `lazy.toml.example`, and nothing failed.
 *
 * This suite pins the two sides together by treating `lazy.toml.example` as the
 * authoritative statement of the user-facing surface. It reads the example the
 * way a user does — INCLUDING the commented-out keys, which is where most of the
 * documented surface lives — so a section documented but not registered fails
 * here instead of surfacing as a bogus doctor warning.
 *
 * If this test fails, the fix is almost always one of:
 *   - the key is real → add it to KNOWN_CONFIG_SCHEMA (and public-docs/lazy-toml.md), or
 *   - the key no longer exists → delete it from lazy.toml.example.
 * Do NOT "fix" it by loosening the scan.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { KNOWN_CONFIG_SCHEMA, KNOWN_TOP_LEVEL_KEYS, findUnknownConfigKeys } from '../../src/config/schema';

const EXAMPLE_PATH = join(import.meta.dir, '..', '..', 'lazy.toml.example');

/** `[section]`, `[[section]]`, `[section.sub]` — commented out or not. */
const SECTION_RE = /^#?\s*\[\[?([A-Za-z0-9_.]+)\]\]?\s*(?:#.*)?$/;
/** `key = value`, commented out or not. Keys are lowercase snake_case by convention. */
const KEY_RE = /^#?\s*([a-z_][a-z0-9_]*)\s*=/;

interface DocumentedKey {
  /** Dotted section path the key was found under, e.g. "proxy.policy". */
  section: string;
  key: string;
  line: number;
}

/**
 * Scan lazy.toml.example for every section and key it documents, whether live
 * or commented out. A plain TOML parse would only see the handful of keys that
 * ship uncommented — and would have missed both of the gaps this suite exists
 * to catch, since `[memory].warn_bytes` and `[proxy.policy]` are both examples.
 */
function scanDocumentedSurface(content: string): { sections: { path: string; line: number }[]; keys: DocumentedKey[] } {
  const sections: { path: string; line: number }[] = [];
  const keys: DocumentedKey[] = [];
  let current: string | null = null;

  content.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const sectionMatch = raw.match(SECTION_RE);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections.push({ path: current, line });
      return;
    }
    // Keys before the first section header belong to the file preamble (prose).
    if (!current) return;
    const keyMatch = raw.match(KEY_RE);
    if (keyMatch) keys.push({ section: current, key: keyMatch[1], line });
  });

  return { sections, keys };
}

describe('KNOWN_CONFIG_SCHEMA vs the documented config surface', () => {
  test('every section documented in lazy.toml.example is known', async () => {
    const { sections } = scanDocumentedSurface(await readFile(EXAMPLE_PATH, 'utf-8'));
    expect(sections.length).toBeGreaterThan(20); // the scan actually found the file's sections

    const unknown = sections.filter(({ path }) => {
      const [top, sub] = path.split('.');
      if (!(top in KNOWN_CONFIG_SCHEMA) && !KNOWN_TOP_LEVEL_KEYS.includes(top)) return true;
      // A nested table ([proxy.policy], [models.roles.builder]) is reachable only
      // if its parent key is registered; deeper levels are the loader's job.
      if (sub !== undefined && !KNOWN_CONFIG_SCHEMA[top]?.includes(sub)) return true;
      return false;
    });

    expect(unknown.map((s) => `lazy.toml.example:${s.line} [${s.path}]`)).toEqual([]);
  });

  test('every key documented in lazy.toml.example is known', async () => {
    const { keys } = scanDocumentedSurface(await readFile(EXAMPLE_PATH, 'utf-8'));
    expect(keys.length).toBeGreaterThan(40); // the scan actually found the file's keys

    const unknown = keys.filter(({ section, key }) => {
      // Nested tables are validated one level down by the config loader, not by
      // the one-level scan findUnknownConfigKeys performs.
      if (section.includes('.')) return false;
      const known = KNOWN_CONFIG_SCHEMA[section];
      if (!known) return false; // reported by the section test above
      if (known.length === 0) return false; // freeform section (e.g. [features])
      return !known.includes(key);
    });

    expect(unknown.map((k) => `lazy.toml.example:${k.line} ${k.section}.${k.key}`)).toEqual([]);
  });

  test('lazy.toml.example parses and produces no unknown-key warnings', async () => {
    const raw = Bun.TOML.parse(await readFile(EXAMPLE_PATH, 'utf-8')) as Record<string, unknown>;
    expect(findUnknownConfigKeys(raw)).toEqual([]);
  });

  // REGRESSION: [proxy.policy] and [memory] are implemented and documented, but
  // were absent from KNOWN_CONFIG_SCHEMA, so `lazy doctor` reported them as
  // unknown options on a perfectly valid config.
  test('a config using [proxy.policy] and [memory] is clean', () => {
    const raw = Bun.TOML.parse(`
[proxy]
port = 8766

[proxy.policy]
enforce = true
connector_allowlist = ["mcp__claude_ai_gmail_search_threads"]
deny_secret_path_reads = true
deny_path_globs = ["/etc/**"]
egress_allowlist = ["api.github.com"]

[memory]
warn_bytes = 8192
`) as Record<string, unknown>;

    expect(findUnknownConfigKeys(raw)).toEqual([]);
  });
});
