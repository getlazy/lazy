import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: Postgres rows and FileStorage rows must have the SAME SHAPE.
 *
 * FileStorage omits an unset optional field entirely; a Postgres `SELECT *`
 * hands back SQL NULL for it. PostgresStorage bridges that with
 * `dropNullOptionals(row, X_OPTIONAL_COLUMNS)` — but the column lists are
 * hand-maintained, so adding a new `foo?: T` to an entity and forgetting the
 * list silently reopens the divergence on that one field. That is exactly how
 * `model_id`/`effort` shipped broken: the writer spread them conditionally,
 * the reader did not, and `'model_id' in turn` answered differently per
 * backend.
 *
 * `test/e2e/storage-contract.test.ts` pins the behavior against a live
 * Postgres; this test is the cheap always-on guard that fails the moment the
 * two sources drift, with no database required. Both halves are checked: a
 * missing entry (NULL leaks through as a present key) AND a stale entry (a
 * field that is no longer optional, or was renamed).
 *
 * If a genuinely optional field must NOT be dropped — a `| null` field where
 * null IS the unset value — it should be typed `foo: T | null`, not `foo?: T`,
 * which is what keeps it out of this check.
 */

const ROOT = join(import.meta.dir, '..', '..');

/** Interfaces whose optional fields must each appear in the paired column list. */
const ENTITIES: { iface: string; source: string; constName: string }[] = [
  { iface: 'Turn', source: 'src/types/index.ts', constName: 'TURN_OPTIONAL_COLUMNS' },
  { iface: 'Comment', source: 'src/types/index.ts', constName: 'COMMENT_OPTIONAL_COLUMNS' },
  { iface: 'JournalEntry', source: 'src/types/index.ts', constName: 'JOURNAL_OPTIONAL_COLUMNS' },
  { iface: 'FollowUp', source: 'src/types/index.ts', constName: 'FOLLOW_UP_OPTIONAL_COLUMNS' },
  {
    iface: 'HunkApproval',
    source: 'src/types/index.ts',
    constName: 'HUNK_APPROVAL_OPTIONAL_COLUMNS',
  },
  {
    iface: 'BuilderResumeIntent',
    source: 'src/storage/types.ts',
    constName: 'BUILDER_RESUME_INTENT_OPTIONAL_COLUMNS',
  },
];

/**
 * StatusChange and TagEvent share ACTOR_ONLY_OPTIONAL_COLUMNS, so their
 * optional fields must be identical to each other and to that one list.
 */
const ACTOR_ONLY_ENTITIES: { iface: string; source: string }[] = [
  { iface: 'StatusChange', source: 'src/storage/types.ts' },
  { iface: 'TagEvent', source: 'src/types/index.ts' },
];

/** Strip comments so a `?` inside prose can't be mistaken for a field. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

/** Optional (`name?:`) field names declared directly on `export interface <name>`. */
async function optionalFields(sourcePath: string, iface: string): Promise<string[]> {
  const src = await readFile(join(ROOT, sourcePath), 'utf-8');
  const match = src.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`interface ${iface} not found in ${sourcePath}`);
  return [...stripComments(match[1]!).matchAll(/^\s*(\w+)\?\s*:/gm)].map(m => m[1]!);
}

/** Entries of an `const <name> = [...] as const` array in postgres-storage.ts. */
function optionalColumns(storageSrc: string, constName: string): string[] {
  const match = storageSrc.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const`));
  if (!match) throw new Error(`${constName} not found in src/storage/postgres-storage.ts`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!);
}

describe('PostgresStorage optional-column coverage', () => {
  test.each(ENTITIES)('$iface optional fields match $constName', async entity => {
    const storageSrc = await readFile(join(ROOT, 'src/storage/postgres-storage.ts'), 'utf-8');
    const fields = await optionalFields(entity.source, entity.iface);
    const columns = optionalColumns(storageSrc, entity.constName);

    expect(fields.length).toBeGreaterThan(0);
    expect([...columns].sort()).toEqual([...fields].sort());
  });

  test('StatusChange and TagEvent match ACTOR_ONLY_OPTIONAL_COLUMNS', async () => {
    const storageSrc = await readFile(join(ROOT, 'src/storage/postgres-storage.ts'), 'utf-8');
    const columns = optionalColumns(storageSrc, 'ACTOR_ONLY_OPTIONAL_COLUMNS').sort();

    for (const entity of ACTOR_ONLY_ENTITIES) {
      const fields = (await optionalFields(entity.source, entity.iface)).sort();
      expect(fields).toEqual(columns);
    }
  });

  // The regression that motivated this file: both were optional on Turn and
  // written conditionally by createTurn, but the read path spread them raw.
  test('model_id and effort are covered', async () => {
    const storageSrc = await readFile(join(ROOT, 'src/storage/postgres-storage.ts'), 'utf-8');
    const columns = optionalColumns(storageSrc, 'TURN_OPTIONAL_COLUMNS');
    expect(columns).toContain('model_id');
    expect(columns).toContain('effort');
  });
});
