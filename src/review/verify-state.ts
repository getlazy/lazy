/**
 * The Verify tab's content as a WIRE ANSWER, for clients that render it
 * themselves (Lazy Teams).
 *
 * The daemon dashboard's Verify tab (`verifyTabHtml`, src/server/review-verify.ts)
 * decides four things: which report is CURRENT and which are superseded
 * (`partitionVerifyReports`), how a how_to_verify body splits into steps
 * (`splitVerifySteps`), what a Copy button puts on the clipboard
 * (`copyTextFor` / `perLineCommands`), and what a "Verified" tick is keyed and
 * hashed on (`verifyTickKey` / `shortHash(stepSource(step))`) — which is what
 * the "N of M steps verified" count compares a draft against.
 *
 * Nothing here decides anything: every field is the owning function's answer,
 * so a client stores ticks under the exact key and hash the dashboard would,
 * and never carries its own copy of the split, the partition or the hash.
 */

import {
  copyTextFor,
  howToVerifySource,
  isRunnableLang,
  partitionVerifyReports,
  perLineCommands,
  splitVerifySteps,
  stepSource,
  verifyTickKey,
  countVerifiedSteps,
} from '../server/review-verify';
import { shortHash } from '../server/viewed-cards';
import type { TurnReport } from '../types';

export interface VerifyStepWire {
  index: number;
  kind: 'prose' | 'code';
  /** Prose steps only. */
  markdown?: string;
  /** Code steps only: the fence's language tag ('' when untagged). */
  lang?: string;
  code?: string;
  /** What the whole-block Copy button copies (`$ ` prompt markers stripped). */
  copyText?: string;
  /**
   * Code steps only: whether the block can be typed at a shell — what decides
   * whether a "Run in shell" is offered for it, on every surface.
   */
  runnable?: boolean;
  /** Per-line copy targets for a `$ `-prefixed block of 2+ commands, else []. */
  perLine?: string[];
  /** Review-draft key the Verified tick is stored under. */
  tickKey: string;
  /** Content hash the tick must carry to count. */
  hash: string;
}

export interface VerifySetWire {
  /** 0 when the task has no agent turn yet. */
  turnSequence: number;
  createdAt: number | null;
  steps: VerifyStepWire[];
}

export interface VerifyStateWire {
  /** The latest agent turn's steps; `steps: []` is the honest empty state. */
  current: VerifySetWire;
  /** Earlier sessions' steps, newest first — superseded. */
  earlier: VerifySetWire[];
  /** Ticks in `viewedFiles` that count against the current steps. */
  progress: { verified: number; total: number };
}

function stepsWire(report: TurnReport | null, turnSequence: number): VerifyStepWire[] {
  const source = howToVerifySource(report);
  if (!source) return [];
  return splitVerifySteps(source).map((step, index) => {
    const base = {
      index,
      tickKey: verifyTickKey(turnSequence, index),
      hash: shortHash(stepSource(step)),
    };
    if (step.kind === 'prose') return { ...base, kind: 'prose' as const, markdown: step.markdown };
    return {
      ...base,
      kind: 'code' as const,
      lang: step.lang,
      code: step.code,
      copyText: copyTextFor(step.code),
      runnable: isRunnableLang(step.lang),
      perLine: perLineCommands(step.code),
    };
  });
}

export function buildVerifyState(
  reports: TurnReport[],
  lastAgentTurn: { session_id: string; sequence: number } | null,
  viewedFiles: Record<string, string>,
): VerifyStateWire {
  const parts = partitionVerifyReports(reports, lastAgentTurn);
  const currentSource = howToVerifySource(parts.current);
  const currentSteps = currentSource ? splitVerifySteps(currentSource) : [];
  return {
    current: {
      turnSequence: parts.currentSequence,
      createdAt: parts.current ? (parts.current.updated_at ?? parts.current.created_at) : null,
      steps: stepsWire(parts.current, parts.currentSequence),
    },
    earlier: parts.earlier.map((entry) => ({
      turnSequence: entry.turnSequence,
      createdAt: entry.createdAt,
      steps: stepsWire(entry.report, entry.turnSequence),
    })),
    progress: countVerifiedSteps(viewedFiles, parts.currentSequence, currentSteps),
  };
}
