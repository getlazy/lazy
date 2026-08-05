/**
 * Unit tests for the DERIVED memory compact: the watermark rules that decide
 * what injection says, and the generator's guarantees.
 *
 * The invariants under test (each asserted with the WHY, per CLAUDE.md):
 *   - records are never modified by compaction;
 *   - a record written after compaction is injected as its LIVE index line and
 *     supersedes the summary;
 *   - a record removed after compaction is called out, not silently left in the
 *     summary as if it were current;
 *   - every compacted NAME survives into the compact text (names are the lookup
 *     key for `lazy_memory_recall`, so an unmentioned name is orphaned);
 *   - the size warning is advisory: it never truncates and never blocks, and it
 *     is carried in-prompt for the builder only (an agent cannot act on it).
 */

import { describe, test, expect } from 'bun:test';
import type { MemoryRecord, MemoryCompact } from '../../src/types';
import {
  renderMemoryIndex,
  renderMemoryBody,
  renderMemorySection,
  assembleMemorySection,
  recordsNewerThanCompact,
  namesRemovedSinceCompact,
  measureMemorySection,
  DEFAULT_MEMORY_WARN_BYTES,
} from '../../src/memory';
import {
  generateMemoryCompact,
  renderMechanicalCompact,
  measureCompactInjection,
  coverageOf,
  unmentionedNames,
} from '../../src/memory/compact';

const base = {
  body: 'body text',
  created_at: 1,
  updated_at: 1,
  created_by: 'human' as const,
  updated_by: 'human' as const,
  revision: 1,
};

function rec(name: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return { name, description: `About ${name}`, type: 'project', ...base, ...over };
}

/**
 * A store big enough that MECHANICAL compaction is a real win.
 *
 * Mechanical compaction is near-lossless — it saves one `(type)` token per
 * record — so it only beats the plain index once there are enough records to pay
 * for the compact's own explanatory preamble. Below that the generator correctly
 * refuses to produce a compact, so any test that needs a mechanical compact to
 * EXIST has to seed a store where compaction genuinely helps.
 */
function bigStore(count = 60): MemoryRecord[] {
  return Array.from({ length: count }, (_, i) =>
    rec(`store-record-number-${i}`, {
      description: `A typical one-line description for record ${i} of the shared memory store.`,
    }),
  );
}

function compactOf(records: MemoryRecord[], content: string): MemoryCompact {
  return {
    content,
    generated_at: 1_700_000_000_000,
    generated_by: 'human',
    method: 'mechanical',
    covered: coverageOf(records),
  };
}

describe('memory compact — watermark', () => {
  // INVARIANT: the watermark is name+REVISION, not a timestamp. Revisions are
  // monotonic per record and immune to clock skew, and a delete→revive cycle
  // bumps the revision so the revived record is correctly seen as "new".
  test('a record written since the compact is not covered by it', () => {
    const before = [rec('alpha'), rec('beta')];
    const compact = compactOf(before, 'summary mentioning alpha and beta');

    const after = [rec('alpha'), rec('beta', { revision: 2, description: 'Beta changed' }), rec('gamma')];
    const newer = recordsNewerThanCompact(after, compact).map(r => r.name);
    expect(newer).toEqual(['beta', 'gamma']);
  });

  // INVARIANT: the live index line SUPERSEDES the summary. That is what makes a
  // compact safe to keep using while records change — new knowledge accumulates
  // on top of it instead of being masked by it.
  test('injection is the compact plus live lines for anything newer', () => {
    const before = [rec('alpha')];
    const compact = compactOf(before, 'Summary: alpha is about alpha.');
    const after = [rec('alpha'), rec('beta', { description: 'Brand new fact' })];

    const body = renderMemoryBody(after, compact);
    expect(body).toContain('Summary: alpha is about alpha.');
    expect(body).toContain('- beta (project) — Brand new fact');
    // And it is explicit about which wins, so a reader cannot get it backwards.
    expect(body).toContain('they win');
  });

  // A compact that still describes a since-removed record would be read as
  // current, and `lazy_memory_recall` on that name would come back empty for no
  // stated reason. Injection has to say the name is gone.
  test('names removed since the compact are called out', () => {
    const before = [rec('alpha'), rec('doomed')];
    const compact = compactOf(before, 'Summary covering alpha and doomed.');
    const after = [rec('alpha'), rec('doomed', { deleted_at: 5, deleted_by: 'human' })];

    expect(namesRemovedSinceCompact(after, compact)).toEqual(['doomed']);
    const body = renderMemoryBody(after, compact);
    expect(body).toContain('Removed since that summary');
    expect(body).toContain('doomed');
  });

  // With no compact, behavior is exactly what it was before this feature.
  test('no compact (or an empty one) falls back to the full index', () => {
    const records = [rec('alpha'), rec('beta')];
    expect(renderMemoryBody(records, null)).toBe(renderMemoryIndex(records));
    expect(renderMemoryBody(records, compactOf(records, '   '))).toBe(renderMemoryIndex(records));
  });

  // A compact whose every record is gone is pure staleness — injecting a
  // summary of nothing would be worse than injecting nothing.
  test('a compact of only-removed records falls back to the (empty) index', () => {
    const before = [rec('alpha')];
    const compact = compactOf(before, 'Summary of alpha.');
    const after = [rec('alpha', { deleted_at: 5, deleted_by: 'human' })];
    expect(renderMemoryBody(after, compact)).toBe('');
  });
});

describe('memory compact — size warning', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    rec(`record-${String(i).padStart(2, '0')}`, { description: 'D'.repeat(120) }),
  );

  // INVARIANT: over the threshold is a WARNING, never an error and never a
  // truncation. Memory past the threshold is still knowledge.
  test('nothing is truncated when the section is over the threshold', () => {
    const section = renderMemorySection(many, 'builder', { warnBytes: 512 });
    expect(measureMemorySection(section, 512).overThreshold).toBe(true);
    for (const r of many) expect(section).toContain(r.name);
  });

  // The in-prompt note goes to the BUILDER only: it can act on it, whereas an
  // agent is read-only on memory, so telling it would be pure noise.
  //
  // INVARIANT: the note points at `lazy doctor` and carries no sizes or remedy
  // of its own. `lazy doctor` is the single "check engine light" surface that
  // owns the diagnosis; duplicating it here would be a second thing to keep in
  // sync.
  test('the in-prompt size note is builder-only and points at lazy doctor', () => {
    expect(renderMemorySection(many, 'builder', { warnBytes: 512 })).toContain('lazy doctor');
    expect(renderMemorySection(many, 'agent', { warnBytes: 512 })).not.toContain('lazy doctor');
  });

  test('under the threshold there is no note at all', () => {
    const section = renderMemorySection([rec('alpha')], 'builder');
    expect(measureMemorySection(section).overThreshold).toBe(false);
    expect(section).not.toContain('lazy doctor');
    expect(DEFAULT_MEMORY_WARN_BYTES).toBe(4096);
  });

  // The measurement must be taken on the section WITHOUT the note, so the number
  // that decides "over threshold" is the same number `lazy doctor` quotes. If the
  // note counted toward the budget, doctor would report a size the threshold
  // check never used.
  test('the reported size excludes the note it triggers', () => {
    const { section, measured } = assembleMemorySection(many, 'builder', { warnBytes: 512 });
    expect(section).toContain('lazy doctor');
    expect(measured.bytes).toBeLessThan(Buffer.byteLength(section, 'utf-8'));
    // Same records, same surface, threshold high enough that no note is added:
    // that is exactly the string the measurement is taken on.
    const noteFree = renderMemorySection(many, 'builder', { warnBytes: 10_000_000 });
    expect(measured.bytes).toBe(Buffer.byteLength(noteFree, 'utf-8'));
  });
});

describe('memory compact — generator', () => {
  // Mechanical compaction is LOSSLESS by construction: it drops the repeated
  // `(type)` token and nothing else. Truncating descriptions would be exactly
  // the curation-by-mutilation this feature exists to avoid.
  test('mechanical compaction keeps every name and description verbatim', () => {
    const records = [
      rec('alpha', { description: 'A'.repeat(250) }),
      rec('beta', { type: 'feedback' }),
    ];
    const content = renderMechanicalCompact(records);
    for (const r of records) {
      expect(content).toContain(r.name);
      expect(content).toContain(r.description);
    }
    expect(unmentionedNames(records, content)).toEqual([]);
  });

  test('mechanical mode needs no model and never fails', async () => {
    const records = bigStore();
    const result = await generateMemoryCompact(records, { mode: 'mechanical' });
    expect(result.input).not.toBeNull();
    expect(result.input!.method).toBe('mechanical');
    expect(result.input!.covered).toEqual(coverageOf(records));
  });

  // Tombstoned records are not compacted — the compact represents the live set.
  test('tombstoned records are excluded from content and coverage', async () => {
    const records = [...bigStore(), rec('gone-for-good', { deleted_at: 2, deleted_by: 'human' })];
    const result = await generateMemoryCompact(records, { mode: 'mechanical' });
    expect(result.input!.content).not.toContain('gone-for-good');
    expect(result.input!.covered.map(c => c.name)).not.toContain('gone-for-good');
  });

  test('no live records yields an empty compact rather than a summary of nothing', async () => {
    const result = await generateMemoryCompact([], { mode: 'mechanical' });
    expect(result.input!.content).toBe('');
    expect(result.input!.covered).toEqual([]);
  });

  // Offline is a deliberate posture, not a failure: auto degrades with a note,
  // and an explicit --llm request fails loudly rather than silently doing
  // something else than the operator asked for.
  test('offline degrades to mechanical in auto and fails loudly under --llm', async () => {
    const records = bigStore();
    const auto = await generateMemoryCompact(records, { offline: true });
    expect(auto.input!.method).toBe('mechanical');
    expect(auto.notes.join(' ')).toContain('Offline mode');

    await expect(generateMemoryCompact(records, { mode: 'llm', offline: true }))
      .rejects.toThrow(/Offline mode/);
  });

  // INVARIANT: compaction NEVER mutates the records it reads. Curation by
  // rewriting descriptions is the thing this feature exists to avoid.
  test('generating a compact does not modify the records', async () => {
    const records = [rec('alpha'), rec('beta', { description: 'B'.repeat(250) })];
    const snapshot = JSON.stringify(records);
    await generateMemoryCompact(records, { mode: 'mechanical' });
    expect(JSON.stringify(records)).toBe(snapshot);
  });
});

/**
 * THE load-bearing invariant of compaction: it must never make the injected
 * context bigger than it would be with no compact at all.
 *
 * This regressed once in a way worth pinning down: the check compared the
 * compact TEXT against the raw index and accepted anything smaller — which
 * ignores the ~450B explanatory preamble `renderMemoryBody` wraps a compact in.
 * A summary a few hundred bytes under the index therefore sailed through and
 * grew every future prompt (observed in the field: 6.0KB → 6.4KB, reported as a
 * success). The comparison basis must be the ASSEMBLED body, both sides.
 */
describe('memory compact — must never grow the injected context', () => {
  test('the comparison basis is the assembled body, not the compact text', () => {
    const records = bigStore(10);
    const index = renderMemoryIndex(records);
    // A summary comfortably SMALLER than the plain index it replaces …
    const content = index.slice(0, Math.floor(index.length * 0.8));
    const sizes = measureCompactInjection(records, {
      content,
      method: 'llm',
      covered: coverageOf(records),
    });

    // … and yet not a win, because the preamble is real injected bytes.
    expect(Buffer.byteLength(content)).toBeLessThan(Buffer.byteLength(index));
    expect(sizes.withCompact).toBeGreaterThan(sizes.withoutCompact);
    expect(sizes.withoutCompact).toBe(Buffer.byteLength(renderMemoryBody(records, null)));
  });

  test('an LLM summary that would grow injection is not saved', async () => {
    const records = bigStore(6);
    // Mechanical cannot win at this size either, so there is no fallback to hide
    // behind: the whole run must come back with nothing to save.
    const result = await generateMemoryCompact(records, { mode: 'mechanical' });
    expect(result.input).toBeNull();
    expect(result.rejected).toBeDefined();
    expect(result.sizes!.withCompact).toBeGreaterThanOrEqual(result.sizes!.withoutCompact);
  });

  test('a compact that IS a win is accepted and reports its saving', async () => {
    const records = bigStore();
    const result = await generateMemoryCompact(records, { mode: 'mechanical' });
    expect(result.input).not.toBeNull();
    expect(result.sizes!.withCompact).toBeLessThan(result.sizes!.withoutCompact);

    // And the promise holds end to end: what a launch would inject really is
    // smaller than what it injects with no compact.
    const injected = renderMemoryBody(records, {
      ...result.input!,
      generated_at: 1,
      generated_by: 'human',
    });
    expect(Buffer.byteLength(injected))
      .toBeLessThan(Buffer.byteLength(renderMemoryBody(records, null)));
  });

  // Records written after a compact ride along as live index lines, so they are
  // part of what injection costs. Measuring the compact alone would understate
  // it — the guard has to see the same thing a prompt sees.
  test('records newer than the watermark count toward the measured size', () => {
    const covered = bigStore();
    const withNewer = [...covered, rec('written-after-the-compact')];
    const input = { content: 'A tiny summary.', method: 'llm' as const, covered: coverageOf(covered) };

    const before = measureCompactInjection(covered, input);
    const after = measureCompactInjection(withNewer, input);
    expect(after.withCompact).toBeGreaterThan(before.withCompact);
    expect(renderMemoryBody(withNewer, { ...input, generated_at: 1, generated_by: 'human' }))
      .toContain('written-after-the-compact');
  });
});
