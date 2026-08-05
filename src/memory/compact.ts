/**
 * Generating the DERIVED memory compact.
 *
 * A compact is a smaller stand-in for the full one-line-per-record index, used
 * when assembling the injected memory context (see `renderMemoryBody`). Two
 * invariants shape everything here:
 *
 *   1. **Records are never modified.** Compaction reads them and writes a
 *      separate artifact. No description rewrites, no truncation of stored
 *      content, no deletions.
 *   2. **Always regenerate from the records.** A recompact NEVER reads the
 *      previous compact, so repeated compaction cannot compound lossy
 *      compression — every generation is one summarization step away from the
 *      source of truth.
 *
 * Two generators:
 *
 *   - `mechanical` — code-only. Groups by type and drops the per-line type
 *     token, which is a modest but *lossless* win: every name and every
 *     description survives verbatim. Cannot fail, needs no model.
 *   - `llm` — a model summarizes the records thematically (bodies included in
 *     its input, never in its output). This is where real compression comes
 *     from: descriptions are already one line each, so only a reader that
 *     understands them can merge overlapping knowledge.
 *
 * Default mode is `auto`: try the LLM, fall back to mechanical on ANY failure
 * (no credential, offline, non-zero exit, unusable output) with the reason
 * reported. Compaction is optional infrastructure — it must never be the reason
 * a project cannot compact its memory.
 */

import type { MemoryRecord, MemoryCompact, MemoryCompactInput, MemoryCompactCoverage } from '../types';
import { isLiveMemory, renderMemoryBody } from './index';
import { runClaudeOneshot } from '../capture/claude';
import { logger } from '../utils/logger';

import memoryCompactGenerateTemplate from '../prompts/memory-compact-generate.md' with { type: 'text' };

/** How much of each record body the LLM generator is shown, per record. */
export const COMPACT_BODY_CHARS_PER_RECORD = 1500;

export type CompactMode = 'auto' | 'llm' | 'mechanical';

export interface GenerateCompactOptions {
  mode?: CompactMode;
  /** Model for the LLM path. Undefined → the Claude CLI default. */
  model?: string;
  /** Byte size the LLM path is asked to stay under. */
  targetBytes?: number;
  /**
   * Whether the project is in offline mode. Passed in rather than read here so
   * this module stays free of project-root/config plumbing (it is imported by
   * the launch path too).
   */
  offline?: boolean;
}

/**
 * What a candidate compact would do to the injected memory context: the body
 * bytes WITH it against the body bytes WITHOUT it (the plain index).
 *
 * Both numbers come from `renderMemoryBody`, the renderer every launch path
 * uses — so they include the compact's own explanatory preamble and the live
 * index lines for records newer than the watermark. Measuring the compact TEXT
 * against the plain index instead (which is what this module used to do) omits
 * ~450B of preamble and lets a "compact" that grows every future prompt through.
 */
export interface CompactInjectionSizes {
  /** Injected body bytes with this compact in place. */
  withCompact: number;
  /** Injected body bytes with no compact at all (the plain index). */
  withoutCompact: number;
}

export interface GenerateCompactResult {
  /**
   * The compact to save, or NULL when no candidate shrank the injected context.
   * A "compact" that grows the context is a failed compaction: the caller must
   * keep whatever compact was already in place (or none) rather than saving it.
   */
  input: MemoryCompactInput | null;
  /**
   * What happened, for the human: degradations, repairs, and fallbacks. Every
   * entry is something the operator should be told, never a silent adjustment.
   */
  notes: string[];
  /**
   * The rejected candidate, when `input` is null. Carried so the caller can
   * report exactly how much bigger it would have been (and, with `--show`-style
   * detail, why) instead of just saying "no".
   */
  rejected?: MemoryCompactInput;
  /** Injection sizes for whichever candidate this result carries. */
  sizes?: CompactInjectionSizes;
}

/**
 * Measure what a candidate compact does to the injected memory context.
 *
 * INVARIANT (the load-bearing one for this module): compaction must never make
 * injection bigger than it would be with no compact at all. The comparison is
 * on the ASSEMBLED body — not on the compact text versus the raw index — because
 * the assembled body is what actually reaches a prompt: the compact's preamble,
 * plus live index lines for anything newer than its watermark, plus the removed-
 * since block. A summary that is smaller than the index it replaces can still
 * lose once those are counted.
 */
export function measureCompactInjection(
  records: MemoryRecord[],
  input: MemoryCompactInput,
): CompactInjectionSizes {
  // A synthetic MemoryCompact: only the fields renderMemoryBody reads matter,
  // and `generated_at` renders as a fixed-width ISO timestamp either way.
  const candidate: MemoryCompact = {
    ...input,
    generated_at: 0,
    generated_by: 'human',
  };
  return {
    withCompact: Buffer.byteLength(renderMemoryBody(records, candidate), 'utf-8'),
    withoutCompact: Buffer.byteLength(renderMemoryBody(records, null), 'utf-8'),
  };
}

/** The watermark for a set of records: name + revision as compacted. */
export function coverageOf(records: MemoryRecord[]): MemoryCompactCoverage[] {
  return records
    .filter(isLiveMemory)
    .map(r => ({ name: r.name, revision: r.revision }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Mechanical compaction: group live records by type, one header per type, and
 * `- name — description` per record.
 *
 * Lossless by construction — every name and every description appears in full.
 * The saving is the repeated `(type)` token plus a tighter shape; modest, but
 * honest. Anything more aggressive (truncating descriptions) is exactly the
 * curation-by-mutilation this feature exists to avoid.
 */
export function renderMechanicalCompact(records: MemoryRecord[]): string {
  const live = records.filter(isLiveMemory);
  if (live.length === 0) return '';

  const byType = new Map<string, MemoryRecord[]>();
  for (const r of live) {
    const bucket = byType.get(r.type) ?? [];
    bucket.push(r);
    byType.set(r.type, bucket);
  }

  const sections: string[] = [];
  for (const type of [...byType.keys()].sort()) {
    const bucket = byType.get(type)!.sort((a, b) => a.name.localeCompare(b.name));
    sections.push(
      `**${type}**\n` +
      bucket.map(r => `- ${r.name} — ${r.description.replace(/\s+/g, ' ').trim()}`).join('\n'),
    );
  }
  return sections.join('\n\n');
}

/** The LLM generator's input bundle: name, type, description, bounded body. */
function formatRecordsForLlm(records: MemoryRecord[]): string {
  return records
    .map(r => {
      const body = r.body.length > COMPACT_BODY_CHARS_PER_RECORD
        ? `${r.body.slice(0, COMPACT_BODY_CHARS_PER_RECORD)}\n… (body truncated for this prompt only; the record is unchanged)`
        : r.body;
      return [
        `### \`${r.name}\` (${r.type}) — ${r.description.replace(/\s+/g, ' ').trim()}`,
        '',
        body.trim(),
      ].join('\n');
    })
    .join('\n\n');
}

/** Strip a whole-output code fence, which models add despite being told not to. */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
  return (match ? match[1] : trimmed).trim();
}

/**
 * Names of live records the compact text fails to mention. These would be
 * ORPHANED — summarized but unrecallable, since the name is the lookup key.
 */
export function unmentionedNames(records: MemoryRecord[], content: string): string[] {
  return records.filter(isLiveMemory).filter(r => !content.includes(r.name)).map(r => r.name);
}

/**
 * How much smaller than the plain index the LLM is ASKED to be.
 *
 * The caller's `targetBytes` is an absolute ceiling (the advisory threshold),
 * which on a store whose index already sits near that threshold is no target at
 * all — "stay under 4KB" when the index is 5.5KB leaves the model free to return
 * 4KB of text that barely beats the thing it replaces and loses outright once
 * the compact preamble is counted. So the ask is also relative to the index.
 */
const LLM_TARGET_INDEX_FRACTION = 0.6;

/** Never ask for a target so small the model has to drop knowledge to hit it. */
const LLM_TARGET_FLOOR_BYTES = 1024;

/**
 * Generate a compact from the LIVE records. Never reads a previous compact.
 *
 * Throws only when the caller explicitly demanded the LLM path (`mode: 'llm'`)
 * and it was unavailable — in `auto` the failure is a note plus a mechanical
 * result. Returns an empty-content input when there are no live records, which
 * the CLI treats as "nothing to compact".
 *
 * Returns `input: null` when NO candidate shrank the injected context (see
 * `measureCompactInjection`). That is a failed compaction, not a compact: the
 * caller keeps whatever was already in place and tells the human why.
 */
export async function generateMemoryCompact(
  records: MemoryRecord[],
  options: GenerateCompactOptions = {},
): Promise<GenerateCompactResult> {
  const live = records.filter(isLiveMemory);
  const mode = options.mode ?? 'auto';
  const covered = coverageOf(live);
  const notes: string[] = [];

  if (live.length === 0) {
    return { input: { content: '', method: 'mechanical', covered }, notes };
  }

  /**
   * Accept a candidate only if it actually shrinks what gets injected.
   * Applies to EVERY generator — the mechanical path is near-lossless, so on a
   * small store its saving (one `(type)` token per record) does not pay for the
   * compact's preamble, and shipping it unchecked is how injection grows.
   */
  const decide = (input: MemoryCompactInput): GenerateCompactResult => {
    const sizes = measureCompactInjection(live, input);
    if (sizes.withCompact < sizes.withoutCompact) return { input, notes, sizes };
    return { input: null, notes, rejected: input, sizes };
  };

  const mechanical = renderMechanicalCompact(live);
  const mechanicalResult = (): GenerateCompactResult =>
    decide({ content: mechanical, method: 'mechanical', covered });

  if (mode === 'mechanical') return mechanicalResult();

  // Offline mode is a deliberate posture, not a failure — do not attempt a
  // network call just to report that it failed.
  if (options.offline) {
    if (mode === 'llm') {
      throw new Error(
        'Offline mode is on, so the LLM compaction path is unavailable. ' +
        'Run `lazy memory compact --mechanical`, or turn offline mode off (`lazy offline off`).',
      );
    }
    notes.push('Offline mode is on — used mechanical compaction instead of the LLM path.');
    return mechanicalResult();
  }

  const plainIndexBytes = Buffer.byteLength(renderMemoryBody(live, null), 'utf-8');
  const targetBytes = Math.max(
    LLM_TARGET_FLOOR_BYTES,
    Math.min(options.targetBytes ?? 4096, Math.floor(plainIndexBytes * LLM_TARGET_INDEX_FRACTION)),
  );
  const prompt = memoryCompactGenerateTemplate
    .replace('{{TARGET_BYTES}}', String(targetBytes))
    .replace('{{COUNT}}', String(live.length))
    .replace('{{RECORDS}}', formatRecordsForLlm(live));

  let content: string;
  try {
    const response = await runClaudeOneshot(prompt, options.model);
    content = stripOuterFence(response.result ?? '');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === 'llm') {
      throw new Error(
        `LLM compaction failed: ${message}. ` +
        `Run \`lazy memory compact --mechanical\` to compact without a model.`,
      );
    }
    logger.warn(`LLM compaction failed (${message}); falling back to mechanical compaction.`);
    notes.push(`LLM compaction unavailable (${message}) — used mechanical compaction instead.`);
    return mechanicalResult();
  }

  if (!content) {
    if (mode === 'llm') {
      throw new Error('LLM compaction returned an empty summary. Nothing was saved.');
    }
    notes.push('LLM compaction returned an empty summary — used mechanical compaction instead.');
    return mechanicalResult();
  }

  // REPAIR, not rejection: a name the summary never mentions would be orphaned
  // (the name is how `lazy_memory_recall` finds the body), so append the missing
  // ones as plain index lines. The knowledge stays reachable and the operator is
  // told which records the model skipped.
  const missing = unmentionedNames(live, content);
  if (missing.length > 0) {
    const byName = new Map(live.map(r => [r.name, r]));
    const lines = missing
      .map(n => byName.get(n)!)
      .map(r => `- ${r.name} (${r.type}) — ${r.description.replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    content = `${content}\n\n**Also recorded** (not covered above):\n${lines}`;
    notes.push(
      `The summary omitted ${missing.length} record name(s) — appended them verbatim so they stay ` +
      `recallable: ${missing.join(', ')}.`,
    );
  }

  // A "compact" that grows the injected context is a failed compaction, not a
  // compact. Measured on the ASSEMBLED body (preamble included), because that is
  // what a prompt actually pays for — see `measureCompactInjection`.
  const llmCandidate: MemoryCompactInput = {
    content,
    method: 'llm',
    ...(options.model ? { model: options.model } : {}),
    covered,
  };
  const llmSizes = measureCompactInjection(live, llmCandidate);
  if (llmSizes.withCompact >= llmSizes.withoutCompact) {
    const cost =
      `The LLM summary would make the injected context ${llmSizes.withCompact}B instead of ` +
      `${llmSizes.withoutCompact}B without a compact`;
    // `--llm` means "use the LLM path", the same way it does for every other
    // failure above: quietly substituting a mechanical compact would replace a
    // compact the operator did not ask for. In `auto`, mechanical is the
    // documented fallback, so try it.
    if (mode === 'llm') {
      notes.push(`${cost} — nothing was saved.`);
      return { input: null, notes, rejected: llmCandidate, sizes: llmSizes };
    }
    notes.push(`${cost} — tried mechanical compaction instead.`);
    return mechanicalResult();
  }

  return { input: llmCandidate, notes, sizes: llmSizes };
}
