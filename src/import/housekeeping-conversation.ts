/**
 * Classifier for ALREADY-STORED machine-generated housekeeping conversations.
 *
 * WHY THIS EXISTS — AND WHY IT IS NOT THE CAPTURE-TIME PREDICATE
 * -------------------------------------------------------------
 * `src/import/machine-oneshot.ts` stops NEW `claude -p` housekeeping runs from
 * ever entering the conversation store, by stamping a marker onto the prompt at
 * the source. It deliberately refuses to sniff prompt wording: capture runs on
 * every sweep tick forever, and a wording-based rule silently rots (and, worse,
 * silently swallows real conversations) the day a prompt is reworded.
 *
 * That leaves the conversations captured BEFORE the marker shipped: ~83% of the
 * store, carrying no marker, drowning real builder conversations in
 * `lazy builder list` and in search. Nothing but their content identifies them.
 *
 * So this module does sniff content — under three constraints that make the
 * brittleness acceptable where it was not acceptable at capture time:
 *
 *   1. It runs ONLY from `lazy doctor --purge-housekeeping-conversations`,
 *      never automatically, never as part of a routine doctor sweep.
 *   2. Its output is a list a human reads and confirms before anything is
 *      deleted (see `runPurgeHousekeeping` in src/cli/commands/doctor.ts).
 *   3. It is a ONE-TIME cleanup. Post-marker one-shots never reach the store,
 *      so this rule set does not need to survive future prompt rewordings —
 *      it needs to describe the prompts as they were written when these
 *      conversations were captured.
 *
 * THE DANGEROUS DIRECTION IS THE FALSE POSITIVE
 * ---------------------------------------------
 * Missing a housekeeping conversation costs one row of noise. Matching a real
 * builder conversation destroys history that cannot be recovered — the raw
 * JSONL on disk is pruned by Claude Code over time, so a purge is not
 * necessarily undoable by re-importing. Every rule is therefore ANCHORED at the
 * very start of the conversation's first user message, and the conversation
 * must have at most ONE user message. A machine one-shot is a single `-p`
 * prompt and nothing else; a human conversation that quotes a lazy prompt
 * quotes it *somewhere*, not as byte 0 of its opening message, and almost never
 * stops after one message. Both guards must hold.
 */

import type { StoredConversation } from '../storage/types';
import { ONESHOT_MARKER } from './machine-oneshot';

/** Which lazy housekeeping run produced this conversation. */
export type HousekeepingKind =
  | 'fidelity-summary'
  | 'report'
  | 'memory-compact'
  | 'pairing-summary'
  | 'marked-oneshot';

export interface HousekeepingClassification {
  kind: HousekeepingKind;
  /** Human-readable justification, shown in the purge preview. */
  reason: string;
}

/**
 * One rule per machine-generated prompt lazy sends through `claude -p`.
 *
 * `prefix` is matched against the START of the first user message. `corroborate`
 * is an additional substring that must appear ANYWHERE in that message — used
 * where the opening line alone is plain enough English that a human could
 * conceivably have typed it. Prompts that open with an HTML-comment sentinel
 * (report, memory compact, the one-shot marker) need no corroboration: nobody
 * opens a message with those by accident.
 */
interface HousekeepingRule {
  kind: HousekeepingKind;
  prefix: string;
  corroborate?: string;
  reason: string;
}

const RULES: HousekeepingRule[] = [
  {
    // Marked at the source. Only reachable for a session captured in the window
    // between the marker landing in runClaudeOneshot and the capture-time skip
    // taking effect, but exact and free to check.
    kind: 'marked-oneshot',
    prefix: ONESHOT_MARKER,
    reason: 'carries the lazy machine-one-shot marker',
  },
  {
    // src/prompts/report-task.md / report-commit.md / report-reduce.md — each
    // opens with `<!-- LAZY_REPORT_STAGE: ... -->`.
    kind: 'report',
    prefix: '<!-- LAZY_REPORT_STAGE:',
    reason: '`lazy report` summarization stage prompt',
  },
  {
    // src/prompts/memory-compact-generate.md
    kind: 'memory-compact',
    prefix: '<!-- LAZY_MEMORY_COMPACT -->',
    reason: '`lazy memory compact` generation prompt',
  },
  {
    // src/prompts/fidelity-summary.md — run on every accept. Unchanged in
    // wording since it was introduced (283a2e45), which is why a prefix match
    // covers the whole back-catalogue. `## What actually happened` is a section
    // header the template always emits, so it corroborates the opening line.
    kind: 'fidelity-summary',
    prefix: 'You are writing the description that will land on the target branch',
    corroborate: '## What actually happened',
    reason: 'accept-time PR/commit fidelity summary prompt',
  },
  {
    // src/cli/commands/pair.ts — the end-of-pairing session summary. Inlined
    // there rather than in src/prompts/, and it goes through `runClaude` rather
    // than `runClaudeOneshot`, so the source-side marker never covered it.
    kind: 'pairing-summary',
    prefix: 'Summarize this pairing session in 2-3 sentences.',
    corroborate: 'Keep the summary concise and factual.',
    reason: 'end-of-pairing session summary prompt',
  },
];

/**
 * The text of the conversation's single user message, or null when the shape
 * itself rules out a one-shot (no user message at all, or more than one).
 *
 * `stats.userMessageCount` is not trusted on its own: it is a stored, derived
 * number, and the messages array is what a human would actually read back.
 */
function soleUserMessageText(conversation: StoredConversation): string | null {
  const userMessages = (conversation.messages ?? []).filter(m => m.role === 'user');
  if (userMessages.length !== 1) return null;
  return userMessages[0].text ?? null;
}

/**
 * Classify a stored conversation as lazy housekeeping, or null for "this is (or
 * might be) a real conversation — leave it alone".
 */
export function classifyHousekeepingConversation(
  conversation: StoredConversation,
): HousekeepingClassification | null {
  const text = soleUserMessageText(conversation);
  if (text === null) return null;

  // Leading whitespace only. Nothing else is stripped: a rule anchored at the
  // start is the whole defense against matching a conversation that merely
  // quotes a lazy prompt, so "skip past a preamble to find the prefix" would
  // give away exactly the property that makes this safe.
  const head = text.replace(/^\s+/, '');

  for (const rule of RULES) {
    if (!head.startsWith(rule.prefix)) continue;
    if (rule.corroborate && !head.includes(rule.corroborate)) continue;
    return { kind: rule.kind, reason: rule.reason };
  }
  return null;
}

/** A stored conversation together with why it was classified as housekeeping. */
export interface HousekeepingMatch extends HousekeepingClassification {
  conversation: StoredConversation;
}

/** Classify a whole store's worth of conversations, preserving input order. */
export function findHousekeepingConversations(
  conversations: StoredConversation[],
): HousekeepingMatch[] {
  const matches: HousekeepingMatch[] = [];
  for (const conversation of conversations) {
    const classification = classifyHousekeepingConversation(conversation);
    if (classification) matches.push({ conversation, ...classification });
  }
  return matches;
}
