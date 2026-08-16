/**
 * Ask-style Q&A against a stored conversation.
 *
 * Claude Code's own retention ages old sessions out of `/resume`, but lazy's
 * conversation store keeps them forever. Reading one back (`lazy show <id>`,
 * `lazy_conversation_read`) has always worked; this module is the missing verb —
 * asking one a question.
 *
 * Shape, and why it is not the task ask:
 *
 *   A task ask (`launchAskTask`) resumes the agent's LIVE session in its
 *   worktree: there is a session to resume, a worktree to look at, and a task
 *   status to restore afterwards. A stored conversation has none of those. It
 *   is immutable text in lazy's store, and the machine that produced it is
 *   long gone. So the conversation ask is a throwaway one-shot instead: render
 *   the stored transcript, hand it to a fresh read-only agent along with the
 *   question, print the answer, keep nothing.
 *
 * Persistence: NOTHING is written. The conversation is immutable history and an
 * ask is a read of it. The one-shot prompt is stamped as a machine one-shot
 * (see src/import/machine-oneshot.ts), so the ask's own Claude Code session is
 * never captured back into the conversation store — asking a conversation a
 * question does not create another conversation.
 *
 * Oversized transcripts map-reduce rather than fail (same shape as `lazy
 * report`): consecutive excerpts are read in parallel, each reporting only what
 * bears on the question, and a reduce pass writes the single answer. Every
 * degradation — an excerpt that failed, a single message too large to pass
 * whole — comes back as a warning rather than being silently absorbed.
 */

import { runClaudeOneshot, extractTokenUsage } from '../capture/claude';
import { logger } from '../utils/logger';
import type { StoredConversation, StoredMessage } from '../storage/types';
import type { TokenUsage } from '../types';

import singleTemplate from '../prompts/conversation-ask-single.md' with { type: 'text' };
import mapTemplate from '../prompts/conversation-ask-map.md' with { type: 'text' };
import reduceTemplate from '../prompts/conversation-ask-reduce.md' with { type: 'text' };

/**
 * How many characters of rendered transcript may go into ONE prompt.
 *
 * The binding limit is not the context window — it is argv. `runClaudeOneshot`
 * passes the prompt as a single `claude -p <prompt>` argument, and Linux caps
 * one argv element at MAX_ARG_STRLEN (128 KiB); exceeding it fails the spawn
 * with E2BIG rather than degrading. 96 KiB of transcript leaves ~30 KiB of head
 * room for the template, the question and the metadata block, which is far more
 * than either needs.
 */
export const TRANSCRIPT_CHARS_PER_CALL = 96_000;

/** Sentinel a map pass returns for an excerpt with nothing bearing on the question. */
const NOTHING_RELEVANT = 'NOTHING_RELEVANT';

/**
 * Map passes in flight at once. Bounded rather than unbounded-parallel: a big
 * transcript can be dozens of excerpts, and firing all of them at the API at
 * once is how a read-only question turns into a rate-limit error.
 */
const MAP_CONCURRENCY = 4;

export interface ConversationAskOptions {
  /** Model for every pass. Undefined → the Claude CLI default. */
  model?: string;
  /**
   * Progress sink for the human-facing surfaces. Called with one short line per
   * milestone (chunking decision, each excerpt, reduce). The CLI routes these
   * to stderr; the MCP handler passes nothing.
   */
  onProgress?: (message: string) => void;
}

export interface ConversationAskResult {
  /** Session ID of the conversation that was asked. */
  sessionId: string;
  /** The answer, as plain text. */
  answer: string;
  /** How many excerpts the transcript was split into. 1 = single pass. */
  chunks: number;
  /** How many excerpts had anything bearing on the question (0 when chunks === 1). */
  relevantChunks: number;
  /** Summed usage across every pass. */
  usage: TokenUsage;
  /** Degradations the caller must surface: failed excerpts, elided message text. */
  warnings: string[];
}

/** Render one stored message the way the transcript surfaces do. */
function renderMessage(msg: StoredMessage): string {
  const role = msg.role === 'user' ? 'human' : 'assistant';
  const time = msg.timestamp ? ` (${msg.timestamp.replace('T', ' ').substring(0, 19)})` : '';
  return `--- ${role}${time} ---\n${msg.text}`;
}

/**
 * The conversation's own identifying facts, so the agent can date and place
 * what it is reading ("this was before the daemon rewrite").
 */
function renderMetadata(conv: StoredConversation): string {
  const lines = [
    `- Session: ${conv.sessionId}`,
    `- Summary: ${conv.summary}`,
  ];
  if (conv.gitBranch) lines.push(`- Branch: ${conv.gitBranch}`);
  if (conv.startedAt) lines.push(`- Started: ${conv.startedAt}`);
  if (conv.endedAt) lines.push(`- Ended: ${conv.endedAt}`);
  lines.push(
    `- Messages: ${conv.stats.messageCount} ` +
    `(${conv.stats.userMessageCount} human, ${conv.stats.assistantMessageCount} assistant)`,
  );
  return lines.join('\n');
}

export interface TranscriptChunk {
  text: string;
  /** Warnings produced while building this chunk (an elided oversized message). */
  warnings: string[];
}

/**
 * Split a conversation into consecutive chunks, each under the per-call budget.
 *
 * Messages are never split across chunks — an answer assembled from half of a
 * message on either side of a boundary is worse than one assembled from whole
 * messages. The exception is a SINGLE message that alone exceeds the budget:
 * that one is truncated in place, with a visible marker in the text and a
 * warning for the caller, because the alternative is failing the whole ask over
 * one long paste.
 *
 * Exported for unit tests: the boundary behaviour is the part of this module
 * most likely to regress silently.
 */
export function chunkTranscript(
  messages: StoredMessage[],
  budget: number = TRANSCRIPT_CHARS_PER_CALL,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
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

  for (const msg of messages) {
    let rendered = renderMessage(msg);
    let warning: string | null = null;

    if (rendered.length > budget) {
      const elided = rendered.length - budget;
      rendered = `${rendered.substring(0, budget)}\n[… ${elided} characters elided by lazy: this single message exceeds the per-call budget …]`;
      const stamp = msg.timestamp ? ` at ${msg.timestamp}` : '';
      warning = `One ${msg.role === 'user' ? 'human' : 'assistant'} message${stamp} was too large to pass whole — ${elided} characters were elided from it.`;
    }

    // +2 for the blank line between messages.
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

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/**
 * Ask a stored conversation a question and return the answer.
 *
 * Throws when the ask cannot produce an answer at all (no messages, every
 * excerpt failed, the single pass failed). Partial failures come back as
 * warnings on the result — the caller decides how loudly to say so, but is
 * never handed a confident answer built from silently-dropped input.
 */
export async function askConversation(
  conv: StoredConversation,
  question: string,
  opts: ConversationAskOptions = {},
): Promise<ConversationAskResult> {
  const progress = opts.onProgress ?? ((): void => {});
  const metadata = renderMetadata(conv);

  if (conv.messages.length === 0) {
    throw new Error(
      `Conversation ${conv.sessionId.substring(0, 8)} has no messages stored — there is nothing to ask about.`,
    );
  }

  const chunks = chunkTranscript(conv.messages);
  const warnings = chunks.flatMap(c => c.warnings);

  // --- Single pass: the whole transcript fits in one call ---
  if (chunks.length === 1) {
    progress(`Asking conversation ${conv.sessionId.substring(0, 8)} (${conv.messages.length} messages, single pass)…`);
    const prompt = fill(singleTemplate, {
      metadata,
      question,
      transcript: chunks[0].text,
    });
    const response = await runClaudeOneshot(prompt, opts.model, { readOnly: true });
    return {
      sessionId: conv.sessionId,
      answer: (response.result ?? '').trim(),
      chunks: 1,
      relevantChunks: 1,
      usage: extractTokenUsage(response),
      warnings,
    };
  }

  // --- Map: read each excerpt for material bearing on the question ---
  progress(
    `Conversation ${conv.sessionId.substring(0, 8)} is too large for one pass ` +
    `(${conv.messages.length} messages) — reading it as ${chunks.length} excerpts…`,
  );

  let usage = ZERO_USAGE;
  let completed = 0;
  const mapResults = await runBounded(
    chunks.map((chunk, i) => async () => {
      const prompt = fill(mapTemplate, {
        metadata,
        question,
        transcript: chunk.text,
        index: String(i + 1),
        total: String(chunks.length),
      });
      const response = await runClaudeOneshot(prompt, opts.model, { readOnly: true });
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
      logger.debug(`conversation ask: excerpt ${i + 1} failed: ${reason}`);
      return;
    }
    usage = addUsage(usage, extractTokenUsage(res.value));
    const text = (res.value.result ?? '').trim();
    if (!text || text === NOTHING_RELEVANT) return;
    findings.push(`### Excerpt ${i + 1} of ${chunks.length}\n\n${text}`);
  });

  if (failedChunks === chunks.length) {
    throw new Error(
      `Every one of the ${chunks.length} excerpts of conversation ${conv.sessionId.substring(0, 8)} failed to read. ` +
      `First failure: ${mapResults[0].status === 'rejected' ? String((mapResults[0].reason as Error)?.message ?? mapResults[0].reason) : 'unknown'}`,
    );
  }

  // Nothing relevant anywhere: say so directly rather than paying for a reduce
  // pass over an empty findings list (which could only invent an answer).
  if (findings.length === 0) {
    return {
      sessionId: conv.sessionId,
      answer:
        `Nothing in this conversation bears on that question. All ${chunks.length} excerpts of the ` +
        `transcript were read${failedChunks > 0 ? ` (${failedChunks} could not be read — see warnings)` : ''} and none of them addressed it.`,
      chunks: chunks.length,
      relevantChunks: 0,
      usage,
      warnings,
    };
  }

  // --- Reduce: one answer from the per-excerpt findings ---
  //
  // The findings themselves are bounded by the same argv budget as the
  // transcript: on a very large conversation, dozens of excerpts each returning
  // a page of bullets can add up past it. Keep whole findings in conversation
  // order until the budget is spent and SAY which ones were dropped — a reduce
  // that silently lost its tail would read as a confident, complete answer.
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
  const reducePrompt = fill(reduceTemplate, {
    metadata,
    question,
    gapNote: gapNote ? `${gapNote}\n` : '',
    findings: keptFindings.join('\n\n'),
  });
  const reduceResponse = await runClaudeOneshot(reducePrompt, opts.model, { readOnly: true });
  usage = addUsage(usage, extractTokenUsage(reduceResponse));

  return {
    sessionId: conv.sessionId,
    answer: (reduceResponse.result ?? '').trim(),
    chunks: chunks.length,
    relevantChunks: findings.length,
    usage,
    warnings,
  };
}

/**
 * Resolve a conversation by exact session ID or unique prefix.
 *
 * Same rule as `lazy show` (src/cli/commands/show.ts): an exact match wins, a
 * unique prefix is accepted, and an ambiguous prefix is an ERROR rather than a
 * silent pick of the first hit. Shared so the CLI and the MCP tool cannot drift
 * into resolving the same string differently.
 */
export async function resolveStoredConversation(
  storage: { listConversations(): Promise<StoredConversation[]>; loadConversation(id: string): Promise<StoredConversation | null> },
  idOrPrefix: string,
): Promise<{ conversation: StoredConversation } | { ambiguous: StoredConversation[] } | null> {
  const conversations = await storage.listConversations();
  const exact = conversations.find(c => c.sessionId === idOrPrefix);
  const prefixMatches = conversations.filter(c => c.sessionId.startsWith(idOrPrefix));
  const match = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);

  if (!match) {
    if (prefixMatches.length > 1) return { ambiguous: prefixMatches };
    return null;
  }

  // listConversations may hand back a lighter shape than the store holds;
  // load the authoritative copy so the transcript is never half-rendered.
  const full = await storage.loadConversation(match.sessionId);
  if (!full) {
    throw new Error(`Conversation ${match.sessionId} is listed but could not be loaded from the store.`);
  }
  return { conversation: full };
}
