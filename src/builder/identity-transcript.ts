/**
 * A Builder's transcript: its segments' stored transcripts joined into ONE
 * conversation record, so every surface that reads, searches, asks or promotes
 * a conversation reads a Builder — and a compaction never splits what a human
 * sees in two.
 *
 * The joined record's `sessionId` is the Builder id. Messages are the segments'
 * in order, de-duplicated by uuid: Claude Code versions that resumed by COPYING
 * history into the new file would otherwise show every earlier message twice.
 */

import type { BuilderSummary, StoredConversation, StoredMessage } from '../storage/types';
import type { TokenUsage } from '../types';

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheCreationTokens: a.cacheCreationTokens + (b.cacheCreationTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
  };
}

/** Join `segments` (any order; missing ones skipped) into the Builder's transcript. */
export function joinBuilderTranscript(
  builder: BuilderSummary,
  segments: StoredConversation[],
): StoredConversation | null {
  const byId = new Map(segments.map((s) => [s.sessionId, s]));
  const ordered = builder.segments.map((id) => byId.get(id)).filter((s): s is StoredConversation => !!s);
  if (ordered.length === 0) return null;
  if (ordered.length === 1 && ordered[0].sessionId === builder.id) return ordered[0];

  const seen = new Set<string>();
  const messages: StoredMessage[] = [];
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  let importedAt = 0;
  for (const seg of ordered) {
    for (const m of seg.messages) {
      if (m.uuid && seen.has(m.uuid)) continue;
      if (m.uuid) seen.add(m.uuid);
      messages.push(m);
    }
    totalUsage = addUsage(totalUsage, seg.totalUsage);
    importedAt = Math.max(importedAt, seg.importedAt ?? 0);
  }
  const newest = ordered[ordered.length - 1];
  const subagents = ordered.flatMap((s) => s.subagents ?? []);
  return {
    sessionId: builder.id,
    projectPath: newest.projectPath,
    cwd: newest.cwd,
    version: newest.version,
    gitBranch: newest.gitBranch,
    startedAt: builder.startedAt,
    endedAt: builder.endedAt,
    importedAt,
    summary: builder.title,
    stats: {
      messageCount: messages.length,
      userMessageCount: messages.filter((m) => m.role === 'user').length,
      assistantMessageCount: messages.filter((m) => m.role === 'assistant').length,
      subagentCount: subagents.length,
      totalTokens: totalUsage.inputTokens + totalUsage.outputTokens +
        totalUsage.cacheCreationTokens + totalUsage.cacheReadTokens,
    },
    totalUsage,
    messages,
    subagents,
  };
}

/** Structural slice of Storage this module needs. */
export interface BuilderTranscriptStore {
  listBuilders(): Promise<BuilderSummary[]>;
  getBuilder(idOrSegmentId: string): Promise<BuilderSummary | null>;
  loadConversation(sessionId: string): Promise<StoredConversation | null>;
  listConversations(): Promise<StoredConversation[]>;
}

/** Load one Builder's joined transcript. */
export async function loadBuilderTranscript(
  storage: BuilderTranscriptStore,
  builder: BuilderSummary,
): Promise<StoredConversation | null> {
  const segments: StoredConversation[] = [];
  for (const id of builder.segments) {
    const seg = await storage.loadConversation(id);
    if (seg) segments.push(seg);
  }
  return joinBuilderTranscript(builder, segments);
}

/** Every Builder's joined transcript, newest Builder first (search reads bodies). */
export async function listBuilderTranscripts(storage: BuilderTranscriptStore): Promise<StoredConversation[]> {
  const [builders, segments] = await Promise.all([storage.listBuilders(), storage.listConversations()]);
  return builders
    .map((b) => joinBuilderTranscript(b, segments))
    .filter((c): c is StoredConversation => !!c);
}

/**
 * Resolve a Builder id, one of its segment ids, or a unique prefix of either to
 * the Builder and its joined transcript. An ambiguous prefix is an error the
 * caller renders from `ambiguous` (id + title), never a silent pick.
 */
export async function resolveBuilderTranscript(
  storage: BuilderTranscriptStore,
  idOrPrefix: string,
): Promise<
  | { builder: BuilderSummary; conversation: StoredConversation }
  | { ambiguous: Array<{ sessionId: string; summary: string }> }
  | null
> {
  const q = idOrPrefix.trim();
  if (!q) return null;
  const builders = await storage.listBuilders();
  let builder = builders.find((b) => b.id === q) ?? builders.find((b) => b.segments.includes(q)) ?? null;
  if (!builder) {
    const matches = builders.filter((b) => b.segments.some((s) => s.startsWith(q)));
    if (matches.length > 1) return { ambiguous: matches.map((b) => ({ sessionId: b.id, summary: b.title })) };
    builder = matches[0] ?? null;
  }
  if (!builder) return null;
  const conversation = await loadBuilderTranscript(storage, builder);
  if (!conversation) {
    throw new Error(`Builder ${builder.id} is listed but none of its segments could be loaded from the store.`);
  }
  return { builder, conversation };
}
