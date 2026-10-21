/**
 * Builders as listing records: stitched segments (src/builder/identity.ts) plus
 * summed stats and the run badge. Pure — the Storage backends feed it their
 * segment index and builder-run registry.
 */

import type { BuilderContinuedFrom, BuilderSession, BuilderSummary, ConversationStats, ConversationSummary } from '../storage/types';
import { stitchBuilders, type SegmentLineage } from './identity';

type SegmentWithLineage = ConversationSummary & { lineage: SegmentLineage };

function addStats(a: ConversationStats, b: ConversationStats): ConversationStats {
  return {
    messageCount: a.messageCount + b.messageCount,
    userMessageCount: a.userMessageCount + b.userMessageCount,
    assistantMessageCount: a.assistantMessageCount + b.assistantMessageCount,
    subagentCount: a.subagentCount + b.subagentCount,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

const ZERO: ConversationStats = {
  messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0,
};

/**
 * The continuation recorded for any of `sessionIds` on any run row — the row's
 * current one (its `agentSessionId`) or one it carried before being re-pointed
 * (`pastContinuations`). Newest-updated row first. Keyed by CONVERSATION, never
 * by the badge run: an End then Resume makes a newer row the badge run, and a
 * re-pointed row no longer names the conversation at all.
 */
export function continuationFor(
  runs: BuilderSession[],
  sessionIds: string[],
): { continuedFrom: BuilderContinuedFrom; continuationSeed: string | null } | null {
  const ids = new Set(sessionIds);
  for (const r of [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (r.continuedFrom && r.agentSessionId && ids.has(r.agentSessionId)) {
      return { continuedFrom: r.continuedFrom, continuationSeed: r.continuationSeed ?? null };
    }
    const past = (r.pastContinuations ?? []).find((p) => ids.has(p.agentSessionId));
    if (past) return { continuedFrom: past.continuedFrom, continuationSeed: past.continuationSeed };
  }
  return null;
}

/** Builders over `segments`, newest first, each carrying its run badge. */
export function summarizeBuilders(
  segments: SegmentWithLineage[],
  runs: BuilderSession[],
): BuilderSummary[] {
  const byId = new Map(segments.map((s) => [s.sessionId, s]));
  // Newest-updated run first, so a segment claimed by two rows names the latest.
  const orderedRuns = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const summaries: BuilderSummary[] = stitchBuilders(segments).map((b) => {
    const members = b.segments.map((id) => byId.get(id)!).filter(Boolean);
    const newest = members[members.length - 1];
    const inBuilder = new Set(b.segments);
    const run = orderedRuns.find((r) => r.agentSessionId && inBuilder.has(r.agentSessionId)) ?? null;
    return {
      memberEmail: members.find((member) => member.memberEmail)?.memberEmail ?? run?.memberEmail ?? null,
      id: b.id,
      title: b.title,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      gitBranch: newest?.gitBranch ?? null,
      segments: b.segments,
      stats: members.reduce((acc, m) => addStats(acc, m.stats), ZERO),
      importedAt: members.reduce((max, m) => Math.max(max, m.importedAt ?? 0), 0),
      run: run
        ? { id: run.id, state: run.state, live: run.state === 'running' || run.state === 'starting' }
        : null,
      ...(() => {
        const found = continuationFor(runs, b.segments);
        return found ? { continuedFrom: found.continuedFrom } : {};
      })(),
    };
  });
  // The other direction of "continued from": a Builder lists the Builders
  // whose runs name it as their source.
  return summaries.map((b) => {
    const continuedAs = summaries
      .filter((other) => other.id !== b.id && other.continuedFrom?.builderId === b.id)
      .map((other) => ({ builderId: other.id, memberEmail: other.memberEmail ?? null }));
    return continuedAs.length > 0 ? { ...b, continuedAs } : b;
  });
}

/**
 * The Builder named by `idOrSegmentId`: an exact Builder id, else the Builder
 * holding that segment, else a unique prefix of either. Null when nothing or
 * more than one Builder matches.
 */
export function findBuilder(builders: BuilderSummary[], idOrSegmentId: string): BuilderSummary | null {
  const q = idOrSegmentId.trim();
  if (!q) return null;
  const exact = builders.find((b) => b.id === q) ?? builders.find((b) => b.segments.includes(q));
  if (exact) return exact;
  const prefixed = builders.filter((b) => b.segments.some((s) => s.startsWith(q)));
  return prefixed.length === 1 ? prefixed[0] : null;
}
