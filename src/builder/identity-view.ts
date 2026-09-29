/**
 * Builders as listing records: stitched segments (src/builder/identity.ts) plus
 * summed stats and the run badge. Pure — the Storage backends feed it their
 * segment index and builder-run registry.
 */

import type { BuilderSession, BuilderSummary, ConversationStats, ConversationSummary } from '../storage/types';
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

/** Builders over `segments`, newest first, each carrying its run badge. */
export function summarizeBuilders(
  segments: SegmentWithLineage[],
  runs: BuilderSession[],
): BuilderSummary[] {
  const byId = new Map(segments.map((s) => [s.sessionId, s]));
  // Newest-updated run first, so a segment claimed by two rows names the latest.
  const orderedRuns = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return stitchBuilders(segments).map((b) => {
    const members = b.segments.map((id) => byId.get(id)!).filter(Boolean);
    const newest = members[members.length - 1];
    const inBuilder = new Set(b.segments);
    const run = orderedRuns.find((r) => r.agentSessionId && inBuilder.has(r.agentSessionId)) ?? null;
    return {
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
    };
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
