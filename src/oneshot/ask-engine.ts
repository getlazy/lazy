/**
 * The map-reduce read-only ask, shared by everything lazy can ask that has no
 * live agent session to resume.
 *
 * Two things use it today: a stored conversation (src/conversation/ask.ts) and
 * a task's stored record (src/task/record-ask.ts). Both hand a rendered text
 * body and a question to a throwaway one-shot and keep nothing; both must
 * map-reduce rather than fail when the body is too large for one call; and both
 * must surface every degradation — a failed excerpt, an elided oversized
 * section — as a warning rather than absorbing it into a confident answer.
 *
 * That shape was written once for conversations. A second hand-rolled copy for
 * tasks would be the same rules spelled twice, one edit away from disagreeing,
 * so the engine lives here and each caller supplies only what is genuinely its
 * own: the rendered text, the metadata block, and its three prompt templates.
 */

import { extractTokenUsage } from '../capture/claude';
import { runOneshot } from '../oneshot';
import { logger } from '../utils/logger';
import type { TokenUsage } from '../types';

/**
 * How many characters of rendered body may go into ONE prompt.
 *
 * The binding limit is not the context window — it is argv. A one-shot
 * passes the prompt as a single `claude -p <prompt>` argument, and Linux caps
 * one argv element at MAX_ARG_STRLEN (128 KiB); exceeding it fails the spawn
 * with E2BIG rather than degrading. 96 KiB of body leaves ~30 KiB of head room
 * for the template, the question and the metadata block, which is far more than
 * either needs.
 */
export const TRANSCRIPT_CHARS_PER_CALL = 96_000;

/** Sentinel a map pass returns for an excerpt with nothing bearing on the question. */
export const NOTHING_RELEVANT = 'NOTHING_RELEVANT';

/**
 * Map passes in flight at once. Bounded rather than unbounded-parallel: a big
 * body can be dozens of excerpts, and firing all of them at the API at once is
 * how a read-only question turns into a rate-limit error.
 */
const MAP_CONCURRENCY = 4;

/**
 * Effort every pass of an ask runs at.
 *
 * `medium` rather than `low`: unlike a fidelity summary, an ask answers a
 * QUESTION — the human wants a specific fact or decision found in material that
 * may contradict itself, which is reasoning, not paraphrasing.
 */
export const ASK_EFFORT = 'medium' as const;

export interface AskChunk {
  text: string;
  /** Warnings produced while building this chunk (an elided oversized part). */
  warnings: string[];
}

/** One renderable unit that must not be split across excerpts. */
export interface AskPart {
  text: string;
  /** The noun for the in-text elision marker ("message", "section"). */
  noun: string;
  /** How the warning names this part ("One human message at 2026-01-02T…"). */
  warningSubject: string;
}

/**
 * Split rendered parts into consecutive chunks, each under the per-call budget.
 *
 * A part is never split across chunks — an answer assembled from half of a
 * message (or half of a diff) on either side of a boundary is worse than one
 * assembled from whole parts. The exception is a SINGLE part that alone exceeds
 * the budget: that one is truncated in place, with a visible marker in the text
 * and a warning for the caller, because the alternative is failing the whole
 * ask over one long paste.
 */
export function chunkParts(parts: AskPart[], budget: number = TRANSCRIPT_CHARS_PER_CALL): AskChunk[] {
  const chunks: AskChunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let currentWarnings: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({ text: current.join('\n\n'), warnings: currentWarnings });
    current = [];
    currentLen = 0;
    currentWarnings = [];
  };

  for (const part of parts) {
    let rendered = part.text;
    let warning: string | null = null;

    if (rendered.length > budget) {
      const elided = rendered.length - budget;
      rendered = `${rendered.substring(0, budget)}\n[… ${elided} characters elided by lazy: this single ${part.noun} exceeds the per-call budget …]`;
      warning = `${part.warningSubject} was too large to pass whole — ${elided} characters were elided from it.`;
    }

    // +2 for the blank line between parts.
    if (currentLen > 0 && currentLen + rendered.length + 2 > budget) flush();
    current.push(rendered);
    currentLen += rendered.length + 2;
    if (warning) currentWarnings.push(warning);
  }

  flush();
  return chunks;
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (err) {
        results[index] = { status: 'rejected', reason: err };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function addUsage(total: TokenUsage, add: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + add.inputTokens,
    outputTokens: total.outputTokens + add.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + add.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens + add.cacheReadTokens,
  };
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

export function fillTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

export interface AskEngineResult {
  answer: string;
  /** How many excerpts the body was split into. 1 = single pass. */
  chunks: number;
  /** How many excerpts had anything bearing on the question (0 when chunks === 1). */
  relevantChunks: number;
  usage: TokenUsage;
  /** Degradations the caller must surface: failed excerpts, elided text. */
  warnings: string[];
}

export interface AskEngineInput {
  /** How the subject is named in progress lines and warnings ("conversation 1a2b3c"). */
  subject: string;
  /** "42 messages", "18 turns" — what the reader is told was read. */
  sizeLabel: string;
  /** The `{{metadata}}` block: identifying facts about the subject. */
  metadata: string;
  question: string;
  /** The already-chunked body. Empty is a caller error, not an empty answer. */
  chunks: AskChunk[];
  templates: { single: string; map: string; reduce: string };
  onProgress?: (message: string) => void;
}

/**
 * Answer a question from a rendered body, in one pass or by map-reduce.
 *
 * Throws when no answer can be produced at all (nothing to read, every excerpt
 * failed). Partial failures come back as warnings on the result — the caller
 * decides how loudly to say so, but is never handed a confident answer built
 * from silently-dropped input.
 */
export async function runAskEngine(input: AskEngineInput): Promise<AskEngineResult> {
  const progress = input.onProgress ?? ((): void => {});
  const { chunks, metadata, question, templates, subject } = input;

  if (chunks.length === 0) {
    throw new Error(`${subject} has nothing stored to read — there is nothing to ask about.`);
  }

  const warnings = chunks.flatMap(c => c.warnings);

  // --- Single pass: the whole body fits in one call ---
  if (chunks.length === 1) {
    progress(`Asking ${subject} (${input.sizeLabel}, single pass)…`);
    const prompt = fillTemplate(templates.single, { metadata, question, transcript: chunks[0].text });
    const response = await runOneshot({ prompt, effort: ASK_EFFORT, repoAccess: 'read-only' });
    return {
      answer: (response.result ?? '').trim(),
      chunks: 1,
      relevantChunks: 1,
      usage: extractTokenUsage(response),
      warnings,
    };
  }

  // --- Map: read each excerpt for material bearing on the question ---
  progress(
    `${subject} is too large for one pass (${input.sizeLabel}) — reading it as ${chunks.length} excerpts…`,
  );

  let usage = ZERO_USAGE;
  let completed = 0;
  const mapResults = await runBounded(
    chunks.map((chunk, i) => async () => {
      const prompt = fillTemplate(templates.map, {
        metadata,
        question,
        transcript: chunk.text,
        index: String(i + 1),
        total: String(chunks.length),
      });
      const response = await runOneshot({ prompt, effort: ASK_EFFORT, repoAccess: 'read-only' });
      progress(`  excerpt ${++completed}/${chunks.length} read`);
      return response;
    }),
    MAP_CONCURRENCY,
  );

  const findings: string[] = [];
  let failedChunks = 0;
  mapResults.forEach((res, i) => {
    if (res.status === 'rejected') {
      failedChunks++;
      const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
      warnings.push(`Excerpt ${i + 1} of ${chunks.length} could not be read (${reason}) — the answer is based on the rest.`);
      logger.debug(`ask engine: excerpt ${i + 1} failed: ${reason}`);
      return;
    }
    usage = addUsage(usage, extractTokenUsage(res.value));
    const text = (res.value.result ?? '').trim();
    if (!text || text === NOTHING_RELEVANT) return;
    findings.push(`### Excerpt ${i + 1} of ${chunks.length}\n\n${text}`);
  });

  if (failedChunks === chunks.length) {
    throw new Error(
      `Every one of the ${chunks.length} excerpts of ${subject} failed to read. ` +
      `First failure: ${mapResults[0].status === 'rejected' ? String((mapResults[0].reason as Error)?.message ?? mapResults[0].reason) : 'unknown'}`,
    );
  }

  // Nothing relevant anywhere: say so directly rather than paying for a reduce
  // pass over an empty findings list (which could only invent an answer).
  if (findings.length === 0) {
    return {
      answer:
        `Nothing in ${subject} bears on that question. All ${chunks.length} excerpts were ` +
        `read${failedChunks > 0 ? ` (${failedChunks} could not be read — see warnings)` : ''} and none of them addressed it.`,
      chunks: chunks.length,
      relevantChunks: 0,
      usage,
      warnings,
    };
  }

  // --- Reduce: one answer from the per-excerpt findings ---
  //
  // The findings themselves are bounded by the same argv budget as the body: on
  // a very large subject, dozens of excerpts each returning a page of bullets
  // can add up past it. Keep whole findings in order until the budget is spent
  // and SAY which ones were dropped — a reduce that silently lost its tail
  // would read as a confident, complete answer.
  const keptFindings: string[] = [];
  let findingsLen = 0;
  let droppedFindings = 0;
  for (const finding of findings) {
    if (findingsLen > 0 && findingsLen + finding.length + 2 > TRANSCRIPT_CHARS_PER_CALL) {
      droppedFindings++;
      continue;
    }
    keptFindings.push(finding);
    findingsLen += finding.length + 2;
  }
  if (droppedFindings > 0) {
    warnings.push(
      `${droppedFindings} of ${findings.length} relevant excerpt(s) did not fit in the final pass and were left out of the answer. ` +
      `Ask a narrower question to see them.`,
    );
  }

  progress(`Composing the answer from ${keptFindings.length} relevant excerpt(s)…`);
  const gapNote = [
    failedChunks > 0
      ? `- ${failedChunks} of ${chunks.length} excerpts could not be read. Say that the answer may be incomplete.`
      : null,
    droppedFindings > 0
      ? `- ${droppedFindings} further excerpt(s) had relevant material that did not fit here. Say that the answer may be incomplete.`
      : null,
  ].filter(Boolean).join('\n');
  const reducePrompt = fillTemplate(templates.reduce, {
    metadata,
    question,
    gapNote: gapNote ? `${gapNote}\n` : '',
    findings: keptFindings.join('\n\n'),
  });
  const reduceResponse = await runOneshot({ prompt: reducePrompt, effort: ASK_EFFORT, repoAccess: 'read-only' });
  usage = addUsage(usage, extractTokenUsage(reduceResponse));

  return {
    answer: (reduceResponse.result ?? '').trim(),
    chunks: chunks.length,
    relevantChunks: findings.length,
    usage,
    warnings,
  };
}
