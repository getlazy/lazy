/**
 * Continue a Builder from a summary — the Builders page's "Continue from a
 * summary", open to every member for every listed Builder, their own included
 * (engineer's rules, 2026-10-20). The daemon side is
 * `handleContinueBuilderFromSummary` (src/daemon/builder-sessions.ts); this
 * module is the pure half: what the summariser reads, and what the new builder
 * is seeded with.
 *
 * THE SUMMARY READS THE READABLE TRANSCRIPT ONLY — each message's role and text,
 * exactly what the Builders page shows every member. Never the raw Claude Code
 * session file, which also holds every command the builder ran and everything
 * those commands printed, and never subagent sidechains. That is what keeps a
 * teammate's tool output with its owner, and why full-fidelity Resume of a
 * teammate's Builder stays refused (src/builder/resume-rules.ts).
 */

import type { BuilderContinuedFrom, StoredConversation } from '../storage/types';
import summarizeTemplate from '../prompts/builder-continue-summarize.md' with { type: 'text' };
import seedTemplate from '../prompts/builder-continuation-seed.md' with { type: 'text' };

export type { BuilderContinuedFrom };

/** The summariser's input is capped: the newest messages win. */
export const SUMMARY_INPUT_MAX_CHARS = 120_000;
/** One message's text in the summariser input is capped too. */
const MESSAGE_MAX_CHARS = 8_000;
/** The offline excerpt keeps this many of the newest messages. */
const EXCERPT_MESSAGES = 12;
const EXCERPT_MESSAGE_CHARS = 1_200;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)} […]`;
}

/**
 * The readable transcript as summariser input: one block per message, role and
 * text only, oldest first, keeping the NEWEST messages when it must be cut.
 *
 * INVARIANT: built from `conversation.messages` text alone — never tool blocks,
 * never the raw session file, never subagents.
 */
export function renderSummaryInput(conversation: StoredConversation): { text: string; count: number } {
  const blocks: string[] = [];
  let size = 0;
  const messages = conversation.messages.filter((m) => m.text && m.text.trim());
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const block = `### ${m.role === 'user' ? 'Person' : 'Builder'}\n\n${clip(m.text, MESSAGE_MAX_CHARS)}`;
    if (size + block.length > SUMMARY_INPUT_MAX_CHARS && blocks.length > 0) break;
    blocks.unshift(block);
    size += block.length + 2;
  }
  const omitted = messages.length - blocks.length;
  const head = omitted > 0 ? `(${omitted} earlier message(s) omitted for length)\n\n` : '';
  return { text: head + blocks.join('\n\n'), count: blocks.length };
}

/** The prompt the summariser runs on. */
export function buildSummaryPrompt(conversation: StoredConversation, targetWords = 600): string {
  const input = renderSummaryInput(conversation);
  return summarizeTemplate
    .replace('{{TARGET_WORDS}}', String(targetWords))
    .replace('{{COUNT}}', String(input.count))
    .replace('{{TRANSCRIPT}}', () => input.text);
}

/**
 * The summary when no model may run (offline mode): the newest messages,
 * clipped, labelled as an excerpt so nobody mistakes it for a summary.
 */
export function excerptSummary(conversation: StoredConversation): string {
  const messages = conversation.messages.filter((m) => m.text && m.text.trim()).slice(-EXCERPT_MESSAGES);
  const lines = messages.map((m) =>
    `- **${m.role === 'user' ? 'Person' : 'Builder'}:** ${clip(m.text, EXCERPT_MESSAGE_CHARS).replace(/\s*\n\s*/g, ' ')}`);
  return [
    `_No model could run (offline mode), so this is the last ${messages.length} message(s) of the conversation, not a summary._`,
    '',
    ...lines,
  ].join('\n');
}

/** What the new builder is seeded with: the source named, then the summary. */
export function buildContinuationSeed(opts: {
  source: BuilderContinuedFrom;
  memberEmail: string | null;
  summary: string;
}): string {
  const owner = opts.source.memberEmail?.trim() || 'nobody recorded';
  const member = opts.memberEmail?.trim() || 'this project\'s person';
  const sameMember = !!opts.memberEmail && !!opts.source.memberEmail
    && opts.memberEmail.trim().toLowerCase() === opts.source.memberEmail.trim().toLowerCase();
  return seedTemplate
    .replace('{{MEMBER}}', () => member)
    .replace('{{SOURCE_TITLE}}', () => opts.source.title.replace(/\s+/g, ' ').trim().slice(0, 200))
    .replaceAll('{{SOURCE_ID}}', () => opts.source.builderId)
    .replace('{{SOURCE_OWNER}}', () => (sameMember ? `${owner} (the same person)` : owner))
    .replace('{{SUMMARY}}', () => opts.summary.trim());
}
