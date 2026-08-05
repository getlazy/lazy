/**
 * Lazy-owned shared memory — normalization and index rendering.
 *
 * Memory records are many small, named pieces of curated cross-task knowledge
 * held in lazy's storage (see `MemoryRecord`). This module owns the rules that
 * every write path (CLI, MCP, import) and every storage backend must agree on:
 * how a name is normalized, what a valid type is, and how the compact index is
 * rendered for prompt injection.
 *
 * It deliberately depends only on types — storage backends import it, so it
 * must not import storage.
 */

import type { MemoryRecord, MemoryType, MemoryCompact } from '../types';
import type { Storage } from '../storage/interface';
import { VALID_MEMORY_TYPES } from '../types';
import { DEFAULT_MEMORY_WARN_BYTES } from '../config/constants';

import { logger } from '../utils/logger';

import memoryIndexAgentTemplate from '../prompts/memory-index-agent.md' with { type: 'text' };
import memoryIndexBuilderTemplate from '../prompts/memory-index-builder.md' with { type: 'text' };
import memoryIndexUnavailableTemplate from '../prompts/memory-index-unavailable.md' with { type: 'text' };
import memoryCompactBodyTemplate from '../prompts/memory-compact-body.md' with { type: 'text' };
import memorySizeWarningTemplate from '../prompts/memory-size-warning.md' with { type: 'text' };

/** Longest a record name may be after normalization. */
export const MAX_MEMORY_NAME_LENGTH = 64;

/**
 * Longest a one-line description may be **when authored through lazy**
 * (`lazy memory save`, `lazy_memory_save`). Longer descriptions are rejected
 * there.
 *
 * This is an AUTHORING limit, not a storage constraint. The import path
 * (`src/import/import-harness-memory.ts`) deliberately does NOT enforce it:
 * imported records were written by another tool under another contract, and an
 * importer's job is to bring data in faithfully — rejecting or truncating a
 * curated description would destroy exactly the knowledge the import exists to
 * rescue. Curating an over-long imported description is a separate, later act.
 */
export const MAX_MEMORY_DESCRIPTION_LENGTH = 200;

/**
 * Normalize a memory record name to a kebab-case slug: lowercase, alphanumerics
 * and hyphens only, no leading/trailing/repeated hyphens. Mirrors tag
 * normalization so `Tasks Not Branches` and `tasks-not-branches` are the same
 * record rather than two near-duplicates.
 *
 * Throws when the input normalizes to nothing or is too long — a memory record
 * without a usable identity is a caller bug, not something to paper over.
 */
export function normalizeMemoryName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    throw new Error(
      `Invalid memory name '${input}': names must contain at least one letter or digit ` +
      `(they are normalized to a kebab-case slug, e.g. "vm-credentials-idea").`,
    );
  }
  if (normalized.length > MAX_MEMORY_NAME_LENGTH) {
    throw new Error(
      `Memory name '${normalized}' is ${normalized.length} characters; the maximum is ${MAX_MEMORY_NAME_LENGTH}. ` +
      `Use a shorter slug and put the detail in the body.`,
    );
  }
  return normalized;
}

/**
 * Normalize a description to a single line. The description is what gets
 * injected into every builder and agent prompt, so newlines (which would break
 * the one-record-per-line index) are collapsed rather than rejected.
 *
 * MECHANISTIC: length is NOT checked here. This is the function every intake
 * path uses (including the harness-memory import), and an importer must store
 * what it was given. Authoring surfaces call
 * `normalizeAuthoredMemoryDescription` instead.
 */
export function normalizeMemoryDescription(input: string): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    throw new Error('A memory record needs a one-line description — it is what the injected index shows.');
  }
  return oneLine;
}

/** True when a (already normalized) description exceeds the authoring limit. */
export function exceedsAuthoringDescriptionLimit(description: string): boolean {
  return description.length > MAX_MEMORY_DESCRIPTION_LENGTH;
}

/**
 * Normalize a description written through a lazy AUTHORING surface
 * (`lazy memory save`, the `lazy_memory_save` MCP tool) and enforce the
 * one-line length budget there.
 *
 * INVARIANT: the limit lives on the authoring surfaces only. Import paths call
 * `normalizeMemoryDescription` and store verbatim — see
 * `MAX_MEMORY_DESCRIPTION_LENGTH`.
 */
export function normalizeAuthoredMemoryDescription(input: string): string {
  const oneLine = normalizeMemoryDescription(input);
  if (exceedsAuthoringDescriptionLimit(oneLine)) {
    throw new Error(
      `Memory description is ${oneLine.length} characters; the maximum is ${MAX_MEMORY_DESCRIPTION_LENGTH}. ` +
      `Keep the description to one line and put the detail in the body.`,
    );
  }
  return oneLine;
}

/**
 * Elide a description for a fixed-width DISPLAY column (`lazy memory list`).
 *
 * DISPLAY ONLY: this never touches stored data, and it is deliberately not used
 * by `renderMemoryIndex` (the injected index) or by `lazy memory show` — both
 * must carry the full curated text. It exists because imported records may hold
 * descriptions well past the authoring budget, and a long description in a
 * padded table wraps across terminal lines and destroys the table's scanability.
 *
 * The result is at most `maxWidth` characters, with a trailing '…' standing in
 * for what was cut — a visible marker, so nobody mistakes the elided text for
 * the whole description.
 */
export function elideMemoryDescription(description: string, maxWidth: number): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxWidth) return oneLine;
  return oneLine.slice(0, Math.max(1, maxWidth - 1)).trimEnd() + '…';
}

/** Validate a memory type, with an actionable error listing the valid values. */
export function validateMemoryType(input: string): MemoryType {
  if ((VALID_MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(
    `Invalid memory type '${input}'. Valid types: ${VALID_MEMORY_TYPES.join(', ')}.`,
  );
}

/** True when the record is live (not tombstoned). */
export function isLiveMemory(record: MemoryRecord): boolean {
  return record.deleted_at === undefined || record.deleted_at === null;
}

/**
 * Render the compact index: one line per live record, `name (type) — description`.
 * Sorted by type then name so the ordering is stable across launches (a stable
 * prompt prefix is also cache-friendly). Returns '' when there are no records.
 *
 * The only structural requirement is ONE LINE PER RECORD, so whitespace in a
 * stored description is collapsed here, at render time. Long descriptions
 * (imported records may exceed the authoring limit) render in full — a long
 * line is harmless, whereas truncating would mangle curated content that the
 * store is the system of record for.
 */
export function renderMemoryIndex(records: MemoryRecord[]): string {
  const live = records.filter(isLiveMemory);
  if (live.length === 0) return '';

  const sorted = [...live].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type),
  );
  return sorted
    .map(r => `- ${r.name} (${r.type}) — ${r.description.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/**
 * Default advisory threshold (bytes) for the assembled memory context. Over
 * this, a WARNING is surfaced — never an error, and never a truncation. Memory
 * that grew past the threshold is still knowledge; silently dropping any of it
 * would be the worse failure. Override with `[memory] warn_bytes` in lazy.toml.
 * Defined in src/config/constants.ts and re-exported here for callers that
 * already import from src/memory.
 */
export { DEFAULT_MEMORY_WARN_BYTES };

/** Options for assembling the injected memory context. */
export interface MemorySectionOptions {
  /** The derived compact, when one has been generated. */
  compact?: MemoryCompact | null;
  /** Advisory size threshold in bytes. Defaults to DEFAULT_MEMORY_WARN_BYTES. */
  warnBytes?: number;
}

/**
 * The live records a compact does NOT represent: those whose name it never
 * covered, and those it covered at a different revision (i.e. the record has
 * been written since). Sorted like the index, so the "since" block is stable.
 *
 * INVARIANT: a record updated after compaction is represented by its LIVE index
 * line, superseding whatever the compact says about it. That is what makes the
 * compact safe to keep using as records change — new knowledge accumulates on
 * top of it rather than being masked by it.
 */
export function recordsNewerThanCompact(records: MemoryRecord[], compact: MemoryCompact): MemoryRecord[] {
  const covered = new Map(compact.covered.map(c => [c.name, c.revision]));
  return records.filter(isLiveMemory).filter(r => covered.get(r.name) !== r.revision);
}

/**
 * Names the compact covered that are no longer live records (tombstoned since
 * it was generated). The compact text still mentions them, so injection has to
 * say they are gone — otherwise a session reads stale knowledge as current and
 * `lazy_memory_recall` on that name comes back empty for no stated reason.
 */
export function namesRemovedSinceCompact(records: MemoryRecord[], compact: MemoryCompact): string[] {
  const live = new Set(records.filter(isLiveMemory).map(r => r.name));
  return compact.covered.filter(c => !live.has(c.name)).map(c => c.name).sort();
}

/** One live index line for a record (the same shape `renderMemoryIndex` emits). */
function indexLine(r: MemoryRecord): string {
  return `- ${r.name} (${r.type}) — ${r.description.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Render the memory context body: the compact plus everything written since it,
 * or — with no compact — the plain full index.
 *
 * Returns '' when there is nothing to inject at all.
 */
export function renderMemoryBody(records: MemoryRecord[], compact?: MemoryCompact | null): string {
  const live = records.filter(isLiveMemory);
  if (!compact || !compact.content.trim()) return renderMemoryIndex(records);
  // A compact whose records have all been removed is pure staleness; fall back
  // to the (possibly empty) live index rather than injecting a summary of
  // nothing.
  if (live.length === 0) return renderMemoryIndex(records);

  const newer = recordsNewerThanCompact(records, compact);
  const removed = namesRemovedSinceCompact(records, compact);

  const recent = newer.length > 0
    ? '\n### Recorded or updated since that summary\n\n' +
      'These lines are live and authoritative — where they overlap the summary above, they win.\n\n' +
      newer.map(indexLine).join('\n') + '\n'
    : '';
  const removedBlock = removed.length > 0
    ? '\n### Removed since that summary\n\n' +
      `No longer recorded — ignore what the summary says about them: ${removed.join(', ')}\n`
    : '';

  return memoryCompactBodyTemplate
    .replace('{{GENERATED}}', new Date(compact.generated_at).toISOString())
    .replace('{{COMPACT}}', compact.content.trim())
    .replace('{{RECENT}}', recent)
    .replace('{{REMOVED}}', removedBlock)
    .trimEnd();
}

/**
 * Assemble the memory section for a surface AND measure it, in one call.
 *
 * The two are returned together on purpose: the measurement is taken on the
 * section WITHOUT the builder's size note, so the number that decides "over
 * threshold" is the same number every reporting surface quotes. Measuring the
 * final string instead would count the note against the budget it exists to
 * describe, and `lazy doctor` would quote a size the threshold check never used.
 *
 * Returns an empty section (and 0 bytes) when there is nothing to inject.
 */
export function assembleMemorySection(
  records: MemoryRecord[],
  surface: 'agent' | 'builder',
  options: MemorySectionOptions = {},
): { section: string; measured: MemorySectionMeasurement } {
  const warnBytes = options.warnBytes ?? DEFAULT_MEMORY_WARN_BYTES;
  const body = renderMemoryBody(records, options.compact);
  if (!body) return { section: '', measured: measureMemorySection('', warnBytes) };

  const template = surface === 'builder' ? memoryIndexBuilderTemplate : memoryIndexAgentTemplate;
  const section = template.replace('{{MEMORY_INDEX}}', body).trimEnd();
  const measured = measureMemorySection(section, warnBytes);

  // The in-prompt note goes to the BUILDER only: it can act on it, whereas an
  // agent is read-only on memory, so telling it would be pure noise. The note
  // deliberately carries no sizes and no remedy of its own — it points at
  // `lazy doctor`, which owns the diagnosis (see src/prompts/memory-size-warning.md).
  if (surface !== 'builder' || !measured.overThreshold) return { section, measured };
  return { section: `${section}\n\n${memorySizeWarningTemplate.trimEnd()}`, measured };
}

/**
 * Render the memory section injected into a builder or agent system prompt.
 *
 * Returns '' when there are no records: an empty index is noise, and the tool
 * documentation in the tool-instructions prompt already tells the caller the
 * memory tools exist.
 *
 * The two surfaces differ because their permissions differ — the builder may
 * write memory, agents are read-only (enforced server-side at the MCP
 * boundary). See `src/prompts/memory-index-*.md`.
 *
 * SIZE: over the advisory threshold the section carries a short pointer to
 * `lazy doctor` for the BUILDER only. Nothing is ever truncated or blocked.
 * Callers that also need the measurement should use `assembleMemorySection`.
 */
export function renderMemorySection(
  records: MemoryRecord[],
  surface: 'agent' | 'builder',
  options: MemorySectionOptions = {},
): string {
  return assembleMemorySection(records, surface, options).section;
}

/** Human-readable byte size for warnings ("6.2KB", "512B"). */
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * The one line a launch prints when the memory context is over the threshold.
 *
 * Deliberately generic and detail-free: `lazy doctor` is the single "check
 * engine light" surface, so a launch states that something needs attention and
 * points there rather than growing its own advisory with sizes and remedies.
 * Phrasing follows the existing doctor referral in `lazy list` ("… Run
 * `lazy doctor` for details …"). Exported so the launch log, the check that
 * produces it, and its tests share one spelling.
 */
export const MEMORY_CONTEXT_CTA =
  'Injected memory context is over the advisory size threshold. Run `lazy doctor` for details.';

/** The size verdict for an assembled memory section. */
export interface MemorySectionMeasurement {
  bytes: number;
  warnBytes: number;
  overThreshold: boolean;
}

/**
 * Measure an assembled section against the advisory threshold. Split out from
 * rendering so `lazy memory compact` and `lazy doctor` report the same numbers
 * the launch paths warn about, without re-deriving the rule.
 */
export function measureMemorySection(
  section: string,
  warnBytes: number = DEFAULT_MEMORY_WARN_BYTES,
): MemorySectionMeasurement {
  const bytes = Buffer.byteLength(section, 'utf-8');
  return { bytes, warnBytes, overThreshold: bytes > warnBytes };
}

/**
 * Render the "index unavailable" section injected when memory could not be read
 * at launch. Distinct from '' (no records): an empty section says "this project
 * has no recorded knowledge", which is exactly the wrong thing to imply when the
 * read failed.
 */
export function renderMemoryUnavailableSection(error: string): string {
  return memoryIndexUnavailableTemplate.replace('{{ERROR}}', error).trimEnd();
}

/**
 * Load the live records and render the prompt section for a launch.
 *
 * FAILURE SEMANTICS (all five agent launch paths + the builder go through here,
 * so they behave identically):
 *   - a storage failure NEVER blocks the launch — losing a session over an
 *     unreadable index would be a worse outcome than launching without it;
 *   - the section is replaced with an explicit unavailability marker naming the
 *     error, so the model cannot mistake "could not read memory" for "this
 *     project has no memory", and is told to retry via lazy_memory_recall /
 *     lazy_search on demand;
 *   - the underlying error is logged loudly (never swallowed — see CLAUDE.md).
 *
 * The DERIVED compact is read separately and is allowed to fail on its own: it
 * is an optimization, so an unreadable compact degrades to the full index (with
 * a logged warning) rather than costing the launch its memory context.
 *
 * SIZE: an over-threshold context logs ONE generic line pointing at
 * `lazy doctor` — never an error, never a truncation. The diagnosis (actual
 * size, threshold, whether a compact exists, how stale it is, what to run)
 * belongs to doctor's memory-context check, so a launch does not grow its own
 * bespoke advisory. See `checkMemoryContext` in src/cli/commands/doctor.ts.
 */
export async function buildMemorySection(
  storage: Storage,
  surface: 'agent' | 'builder',
  options: { warnBytes?: number } = {},
): Promise<string> {
  try {
    const records = await storage.listMemories();
    const compact = await readCompactForInjection(storage);
    const warnBytes = options.warnBytes ?? DEFAULT_MEMORY_WARN_BYTES;
    const { section, measured } = assembleMemorySection(records, surface, { compact, warnBytes });

    if (measured.overThreshold) {
      logger.warn(MEMORY_CONTEXT_CTA);
    }
    return section;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to read shared memory for the ${surface} prompt: ${message}. ` +
      `Launching with an explicit "index unavailable" marker instead — the ${surface} ` +
      `can still retry with lazy_memory_recall / lazy_search.`,
    );
    return renderMemoryUnavailableSection(message);
  }
}

/**
 * Read the compact for injection. A compact is DERIVED: if it cannot be read,
 * the correct degradation is the full index — not a failed launch and not an
 * "unavailable" marker (the records themselves were readable). The failure is
 * still logged rather than swallowed.
 */
async function readCompactForInjection(storage: Storage): Promise<MemoryCompact | null> {
  try {
    return await storage.getMemoryCompact();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `Could not read the memory compact (${message}); injecting the full memory index instead. ` +
      `Regenerate it with \`lazy memory compact\`.`,
    );
    return null;
  }
}

/** Format a record for human/agent display (CLI `memory show`, MCP recall). */
export function renderMemoryRecord(record: MemoryRecord): string {
  const lines = [
    `# ${record.name}`,
    '',
    `type: ${record.type}`,
    `description: ${record.description}`,
    '',
    record.body.trimEnd(),
  ];
  return lines.join('\n');
}
