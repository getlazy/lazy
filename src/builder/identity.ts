/**
 * Builder identity: one Builder = one conversation in the human sense.
 *
 * A builder RUN (one `lazy builder` process) rolls Claude through several
 * SEGMENTS — one `<uuid>.jsonl` each. `/clear` starts a new Builder; compaction
 * and resume CONTINUE the current one. This module derives Builders from the
 * captured segments by LINEAGE, the on-disk evidence Claude Code writes, and
 * nothing else (no timing heuristics, no run bookkeeping).
 *
 * The evidence, read off the Claude Code 2.1.282 bundle (never invented):
 *
 *   - compaction writes a `{type:"system", subtype:"compact_boundary"}` record
 *     with `parentUuid: null` and `logicalParentUuid: <uuid of the last record
 *     before the boundary>`;
 *   - a resumed segment's first record has `parentUuid` pointing at the leaf of
 *     the conversation it continues;
 *   - a branch copies history with `forkedFrom: {sessionId, messageUuid}`;
 *   - older Claude Code versions resumed by COPYING the prior history into the
 *     new file under the same record uuids, so the new file's first record is
 *     the old file's first record.
 *
 * A `/clear` segment carries none of these: its first record has
 * `parentUuid: null` and nothing in it points outside the file.
 *
 * So a segment continues another when a uuid it references but does not itself
 * define is one of the other segment's ANCHORS (its first record and its last
 * {@link LINEAGE_TAIL} records — where a continuation points), when it names the
 * other segment as `forkedFrom`, or when both share a first record uuid. The
 * Builder is the connected component of that relation.
 */

/** How many trailing record uuids a segment keeps as anchors. */
export const LINEAGE_TAIL = 32;

/** Lineage evidence of one segment, captured at import time. */
export interface SegmentLineage {
  /** Uuid of the segment's first record (any record type), or null. */
  firstUuid: string | null;
  /** Uuids of the segment's last {@link LINEAGE_TAIL} records, oldest first. */
  tailUuids: string[];
  /** Lineage uuids referenced by this segment but not defined in it. */
  externalRefs: string[];
  /** `forkedFrom.sessionId` values seen in the segment. */
  forkedFromSessionIds: string[];
}

/** Accumulates {@link SegmentLineage} over raw JSONL records, line by line. */
export class LineageCollector {
  private firstUuid: string | null = null;
  private tail: string[] = [];
  private defined = new Set<string>();
  private refs = new Set<string>();
  private forked = new Set<string>();

  observe(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const uuid = typeof r.uuid === 'string' ? r.uuid : null;
    if (uuid) {
      if (this.firstUuid === null) this.firstUuid = uuid;
      this.defined.add(uuid);
      this.tail.push(uuid);
      if (this.tail.length > LINEAGE_TAIL) this.tail.shift();
    }
    // NOT `leafUuid`: `last-prompt` records carry the file's OWN leaf (seen on
    // real JSONL), and `summary` records are resume-picker titles that can name
    // other conversations — counting them could merge a /clear into its
    // predecessor.
    for (const key of ['parentUuid', 'logicalParentUuid'] as const) {
      const v = r[key];
      if (typeof v === 'string' && v) this.refs.add(v);
    }
    const forkedFrom = r.forkedFrom as Record<string, unknown> | undefined;
    if (forkedFrom && typeof forkedFrom === 'object') {
      if (typeof forkedFrom.sessionId === 'string') this.forked.add(forkedFrom.sessionId);
      if (typeof forkedFrom.messageUuid === 'string') this.refs.add(forkedFrom.messageUuid);
    }
  }

  finish(ownSessionId?: string): SegmentLineage {
    return {
      firstUuid: this.firstUuid,
      tailUuids: [...this.tail],
      externalRefs: [...this.refs].filter((u) => !this.defined.has(u)),
      forkedFromSessionIds: [...this.forked].filter((s) => s !== ownSessionId),
    };
  }
}

/**
 * Lineage for a segment captured BEFORE lineage was recorded, derived from the
 * stored messages alone. Weaker than the raw evidence — tool and system records
 * were never stored — but a false JOIN still needs a uuid another segment
 * actually holds, which only shared history produces. What it can miss is a
 * compaction whose boundary record was not stored; such a segment shows as its
 * own Builder until it is captured again.
 */
export function lineageFromMessages(
  messages: Array<{ uuid: string; parentUuid: string | null }>,
): SegmentLineage {
  // Only UUID-shaped ids are globally unique. Other harnesses (Pi uses 8-hex
  // entry ids) would collide across sessions and merge unrelated conversations,
  // so such a segment stands alone.
  if (messages.some((m) => !UUID_SHAPE.test(m.uuid))) {
    return { firstUuid: null, tailUuids: [], externalRefs: [], forkedFromSessionIds: [] };
  }
  const c = new LineageCollector();
  for (const m of messages) c.observe(m);
  return c.finish();
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One captured segment, reduced to what stitching needs. */
export interface SegmentInput {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string;
  lineage: SegmentLineage;
}

/** A Builder derived from its segments. */
export interface StitchedBuilder {
  /**
   * The Builder's id: the session id of its FIRST segment. Chosen because it
   * never changes as the Builder grows (compaction and resume only ADD later
   * segments), it is the id the human saw when the conversation started, and it
   * is itself a segment id, so every existing link and `--resume` hint keeps
   * resolving.
   */
  id: string;
  /** First human message of the first segment. */
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Segment session ids, oldest first. */
  segments: string[];
}

function byStart(a: SegmentInput, b: SegmentInput): number {
  const c = (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
  if (c !== 0) return c;
  // A legacy copy-on-resume starts at the same time as its original; the
  // original ends first, so it is the Builder's first segment.
  const e = (a.endedAt ?? '').localeCompare(b.endedAt ?? '');
  return e !== 0 ? e : a.sessionId.localeCompare(b.sessionId);
}

/** Group segments into Builders. Pure; newest Builder first. */
export function stitchBuilders(segments: SegmentInput[]): StitchedBuilder[] {
  const ordered = [...segments].sort(byStart);
  const parent = new Map<string, string>();
  for (const s of ordered) parent.set(s.sessionId, s.sessionId);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  // Anchor uuid -> owning segment. The EARLIEST segment wins a shared anchor,
  // which is what makes copied history point back at the original.
  const anchors = new Map<string, string>();
  for (const s of ordered) {
    const own = [s.lineage.firstUuid, ...s.lineage.tailUuids].filter((u): u is string => !!u);
    for (const u of own) {
      const owner = anchors.get(u);
      if (owner === undefined) anchors.set(u, s.sessionId);
      else if (owner !== s.sessionId) union(owner, s.sessionId);
    }
  }
  const ids = new Set(ordered.map((s) => s.sessionId));
  for (const s of ordered) {
    for (const ref of s.lineage.externalRefs) {
      const owner = anchors.get(ref);
      if (owner && owner !== s.sessionId) union(owner, s.sessionId);
    }
    for (const sid of s.lineage.forkedFromSessionIds) {
      if (ids.has(sid) && sid !== s.sessionId) union(sid, s.sessionId);
    }
  }

  const groups = new Map<string, SegmentInput[]>();
  for (const s of ordered) {
    const root = find(s.sessionId);
    const g = groups.get(root);
    if (g) g.push(s);
    else groups.set(root, [s]);
  }

  const builders: StitchedBuilder[] = [];
  for (const members of groups.values()) {
    const first = members[0];
    let endedAt: string | null = null;
    for (const m of members) {
      const e = m.endedAt ?? m.startedAt;
      if (e && (!endedAt || e > endedAt)) endedAt = e;
    }
    builders.push({
      id: first.sessionId,
      title: first.summary,
      startedAt: first.startedAt,
      endedAt,
      segments: members.map((m) => m.sessionId),
    });
  }
  return builders.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}
