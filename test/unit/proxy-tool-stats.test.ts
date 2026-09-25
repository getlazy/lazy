/**
 * The durable per-task tool statistics the proxy folds as it forwards.
 *
 * What is pinned here is the part that makes the numbers worth keeping: a call
 * replayed in every later request is ONE call, a result is filed once against
 * the call it answers, an unmeasured result is not a free one, and a result
 * whose call was never seen is not filed under a guessed tool name. The
 * read-time derivation could dedupe by holding a whole window at once; a
 * running aggregate cannot, so these rules are load-bearing in a way they were
 * not before.
 */

import { describe, test, expect } from 'bun:test';
import {
  emptyToolStatsRecord,
  foldAuditRecord,
  ProxyToolStatsRecorder,
  TOOL_STATS_AWAITING_CAP,
  TOOL_STATS_RECENT_CAP,
} from '../../src/proxy/tool-stats';
import { extractRequest } from '../../src/proxy/extractor';
import { toolStatsFromRecord } from '../../src/task/stats';
import type { ProxyAuditRecord, TaskToolStatsRecord } from '../../src/storage/types';

const T0 = new Date('2026-09-13T00:00:00Z').getTime();

let seq = 0;
function audit(over: Partial<ProxyAuditRecord> = {}): ProxyAuditRecord {
  return {
    id: `a-${++seq}`,
    seq,
    ts: T0 + seq * 1000,
    role: 'agent',
    taskId: 'task-1111',
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: null,
    stopReason: 'tool_use',
    error: null,
    durationMs: 10,
    reroute: null,
    ...over,
  } as unknown as ProxyAuditRecord;
}

function use(id: string, name: string, tail = true) {
  return { id, name, path: null, command: null, target: null, connector: false, inputPreview: '', tail };
}

function result(
  id: string,
  opts: { tokens?: number | null; isError?: boolean; tail?: boolean } = {},
) {
  return {
    toolUseId: id,
    isError: opts.isError ?? false,
    contentPreview: '',
    contentLen: 100,
    contentTokens: opts.tokens ?? null,
    tail: opts.tail ?? true,
  };
}

function rowsOf(record: TaskToolStatsRecord) {
  return Object.fromEntries(record.tools.map((t) => [t.name, t]));
}

describe('folding a request into a task record', () => {
  test('a call and its result land on the named tool', () => {
    const record = emptyToolStatsRecord('task-1111');
    foldAuditRecord(record, audit({ toolUses: [use('u1', 'Read')] }));
    foldAuditRecord(record, audit({ toolResults: [result('u1', { tokens: 900 })] }));

    expect(rowsOf(record).Read).toMatchObject({
      invocations: 1,
      errors: 0,
      resultTokens: 900,
      resultsMeasured: 1,
      resultsUnmeasured: 0,
    });
    expect(record.requests).toBe(2);
  });

  // INVARIANT: every request replays the WHOLE conversation, so the same
  // tool_use and tool_result blocks reappear in every later request. A running
  // aggregate must count each one ONCE. Counting raw blocks measures how many
  // requests followed a call, which is not a tool statistic — on a real log it
  // inflated 142 calls to 3,966. The read-time derivation deduped by holding
  // the window; this one dedupes with the tail marker plus a bounded ring.
  test('a call replayed across many requests is one call, and one result', () => {
    const record = emptyToolStatsRecord('task-1111');
    // Request 1: the call is new — it is in the response the agent just made,
    // which the extractor marks as the tail.
    foldAuditRecord(record, audit({ toolUses: [use('u1', 'Read')] }));
    // Requests 2-4 replay it as history (tail: false), each also carrying the
    // result — new on request 2, replayed after that.
    for (let i = 0; i < 3; i++) {
      foldAuditRecord(
        record,
        audit({
          toolUses: [use('u1', 'Read', false)],
          toolResults: [result('u1', { tokens: 100, tail: i === 0 })],
        }),
      );
    }

    expect(rowsOf(record).Read).toMatchObject({
      invocations: 1,
      resultTokens: 100,
      resultsMeasured: 1,
    });
    expect(record.requests).toBe(4);
  });

  // INVARIANT: the tail can legitimately repeat — a retried request replays it
  // verbatim, and appending a plain user message leaves the previous response
  // as the last assistant message. The recent-id ring is what makes the fold
  // survive that; without it a retry double-counts every call in flight.
  test('an identical request replayed verbatim adds nothing', () => {
    const record = emptyToolStatsRecord('task-1111');
    const body = {
      toolUses: [use('u1', 'Bash')],
      toolResults: [result('u0', { tokens: 5 })],
    };
    foldAuditRecord(record, audit(body));
    foldAuditRecord(record, audit(body));
    foldAuditRecord(record, audit(body));

    expect(rowsOf(record).Bash.invocations).toBe(1);
    // u0's call was never observed, so its tokens are unattributed — once.
    expect(record.unattributed_results).toBe(1);
    expect(record.unattributed_result_tokens).toBe(5);
  });

  // INVARIANT: an unmeasured result is counted as unmeasured, never as zero
  // tokens — a zero would read as "this tool's output was free".
  test('results with no recorded size are counted, not assumed free', () => {
    const record = emptyToolStatsRecord('task-1111');
    foldAuditRecord(record, audit({ toolUses: [use('u1', 'Bash')] }));
    foldAuditRecord(record, audit({ toolResults: [result('u1', { tokens: null })] }));

    expect(rowsOf(record).Bash).toMatchObject({
      resultTokens: 0,
      resultsMeasured: 0,
      resultsUnmeasured: 1,
    });
  });

  // INVARIANT: a result whose tool_use was never observed has no known tool.
  // Its tokens are real, so they are reported separately rather than dropped or
  // filed under a guessed name.
  test('results for calls that were never observed are unattributed', () => {
    const record = emptyToolStatsRecord('task-1111');
    foldAuditRecord(record, audit({ toolResults: [result('gone', { tokens: 200 })] }));

    expect(record.tools).toEqual([]);
    expect(record.unattributed_result_tokens).toBe(200);
  });

  // INVARIANT: a request's USAGE is never split across the tools it carried.
  // Usage is per request and one response routinely asks for several tools, so
  // any such division would be invented. The token column is the measured size
  // of each tool's own results and nothing else.
  test('per-tool tokens never come from request usage', () => {
    const record = emptyToolStatsRecord('task-1111');
    foldAuditRecord(
      record,
      audit({
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        toolUses: [use('a', 'Read'), use('b', 'Grep')],
      }),
    );
    foldAuditRecord(
      record,
      audit({ toolResults: [result('a', { tokens: 900 }), result('b', { tokens: 12 })] }),
    );

    const stats = toolStatsFromRecord(record);
    expect(stats.proxyTotals.total).toBe(1100);
    expect(stats.rows.map((r) => [r.name, r.resultTokens])).toEqual([
      ['Read', 900],
      ['Grep', 12],
    ]);
    // Not one of the 1,100 request tokens landed in a row.
    expect(stats.resultTokens).toBe(912);
  });

  test('an error result is counted against its tool', () => {
    const record = emptyToolStatsRecord('task-1111');
    foldAuditRecord(record, audit({ toolUses: [use('u1', 'Bash')] }));
    foldAuditRecord(record, audit({ toolResults: [result('u1', { isError: true, tokens: 9 })] }));
    expect(rowsOf(record).Bash.errors).toBe(1);
  });

  // INVARIANT: the record is bounded by construction whatever the task does.
  // That is the condition for keeping it in Storage at all — the audit log is
  // the unbounded-by-nature stream, and it stays outside.
  test('dedupe bookkeeping stays capped over a long conversation', () => {
    const record = emptyToolStatsRecord('task-1111');
    for (let i = 0; i < TOOL_STATS_AWAITING_CAP * 3; i++) {
      foldAuditRecord(record, audit({ toolUses: [use(`u${i}`, 'Read')] }));
    }
    expect(record.awaiting.length).toBe(TOOL_STATS_AWAITING_CAP);
    expect(record.recent_use_ids.length).toBe(TOOL_STATS_RECENT_CAP);
    // Every call was still counted — only the bookkeeping is capped.
    expect(rowsOf(record).Read.invocations).toBe(TOOL_STATS_AWAITING_CAP * 3);
  });

  test('a block with no id is skipped rather than counted on every replay', () => {
    const record = emptyToolStatsRecord('task-1111');
    const malformed = { ...use('x', 'Read'), id: null };
    foldAuditRecord(record, audit({ toolUses: [malformed] }));
    foldAuditRecord(record, audit({ toolUses: [malformed] }));
    expect(record.tools).toEqual([]);
  });
});

describe('the extractor marks the conversation tail', () => {
  test('only the last assistant message holds new calls', () => {
    const body = {
      model: 'claude-opus-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'x' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: 'y' }] },
      ],
    };
    const extracted = extractRequest('/v1/messages', body);

    expect(extracted.toolUses.map((u) => [u.id, u.tail])).toEqual([
      ['old', false],
      ['new', true],
    ]);
    // Results are new when they arrive AFTER the last assistant message.
    expect(extracted.toolResults.map((r) => [r.toolUseId, r.tail])).toEqual([
      ['old', false],
      ['new', true],
    ]);
  });

  // The one shape that would double-count without the ring: the agent's last
  // response is still the last assistant message after a plain user follow-up.
  test('a plain user follow-up leaves the previous response as the tail', () => {
    const body = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'x' }] },
        { role: 'user', content: [{ type: 'text', text: 'thanks, carry on' }] },
      ],
    };
    const extracted = extractRequest('/v1/messages', body);
    expect(extracted.toolUses[0].tail).toBe(true);

    const record = emptyToolStatsRecord('task-1111');
    foldAuditRecord(record, audit({ toolUses: [use('u1', 'Read')] }));
    foldAuditRecord(
      record,
      audit({ toolUses: extracted.toolUses, toolResults: extracted.toolResults }),
    );
    expect(rowsOf(record).Read.invocations).toBe(1);
  });
});

describe('the recorder never fails the request it observes', () => {
  test('a storage error is swallowed and later folds still land', async () => {
    let saved: TaskToolStatsRecord | null = null;
    let failNext = true;
    const recorder = new ProxyToolStatsRecorder({
      getToolStats: async () => saved,
      saveToolStats: async (record) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        saved = structuredClone(record);
      },
    });

    // Returns synchronously whatever storage is about to do.
    expect(recorder.observe(audit({ toolUses: [use('u1', 'Read')] }))).toBeUndefined();
    await recorder.flush();
    expect(saved).toBeNull();

    recorder.observe(audit({ toolUses: [use('u2', 'Bash')] }));
    await recorder.flush();
    expect(saved).not.toBeNull();
    // The failed fold was dropped with its cached record, so the surviving
    // record is the one storage actually holds — never a half-written mix.
    expect(rowsOf(saved!).Bash.invocations).toBe(1);
  });

  test('traffic with no task id is not filed anywhere', async () => {
    let writes = 0;
    const recorder = new ProxyToolStatsRecorder({
      getToolStats: async () => null,
      saveToolStats: async () => {
        writes++;
      },
    });
    recorder.observe(audit({ taskId: null, toolUses: [use('u1', 'Read')] }));
    await recorder.flush();
    expect(writes).toBe(0);
  });

  test('two requests for one task are folded in order, not lost', async () => {
    let saved: TaskToolStatsRecord | null = null;
    const recorder = new ProxyToolStatsRecorder({
      getToolStats: async () => saved,
      saveToolStats: async (record) => {
        await new Promise((r) => setTimeout(r, 5));
        saved = structuredClone(record);
      },
    });
    recorder.observe(audit({ toolUses: [use('u1', 'Read')] }));
    recorder.observe(audit({ toolUses: [use('u2', 'Read')] }));
    await recorder.flush();
    expect(rowsOf(saved!).Read.invocations).toBe(2);
  });
});
