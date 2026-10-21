import { describe, test, expect } from 'bun:test';
import { createParseState, parseJsonlLines } from '../../src/import/claude-code-logs';
import {
  buildContinuationSeed,
  buildSummaryPrompt,
  excerptSummary,
  renderSummaryInput,
  SUMMARY_INPUT_MAX_CHARS,
} from '../../src/builder/continue-from-summary';
import { continuationFor, summarizeBuilders } from '../../src/builder/identity-view';
import type { BuilderSession, StoredConversation } from '../../src/storage/types';

const TOOL_SECRET = 'TOOL-OUTPUT-SECRET-cat-of-env-file';
const TOOL_COMMAND = 'TOOL-COMMAND-SECRET-printenv';
const SUBAGENT_SECRET = 'SUBAGENT-SIDECHAIN-SECRET';

/** A builder session as Claude Code writes it: text turns AND tool turns. */
function rawSessionJsonl(): string {
  const lines = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-10-20T10:00:00Z',
      message: { role: 'user', content: 'Plan the release notes' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-10-20T10:00:05Z',
      message: { role: 'assistant', model: 'm', content: [
        { type: 'text', text: 'Let me look at the changelog.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: TOOL_COMMAND } },
      ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 's1', timestamp: '2026-10-20T10:00:06Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: TOOL_SECRET },
      ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: 's1', timestamp: '2026-10-20T10:00:09Z',
      message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Here is the plan.' }] } },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

function storedFromRaw(): StoredConversation {
  const state = createParseState();
  parseJsonlLines(rawSessionJsonl(), state);
  return {
    sessionId: 's1', projectPath: 'p', cwd: null, version: null, gitBranch: null,
    startedAt: null, endedAt: null, importedAt: 0, summary: 'Plan the release notes',
    stats: { messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
    totalUsage: state.usage,
    messages: state.messages.map((m: any) => ({
      uuid: m.uuid, parentUuid: m.parentUuid ?? null, timestamp: m.timestamp, role: m.role, text: m.text,
      model: m.model ?? null, usage: null,
    })),
    subagents: [{ agentId: 'x', messages: [{
      uuid: 'sa', parentUuid: null, timestamp: '2026-10-20T10:00:07Z', role: 'assistant', text: SUBAGENT_SECRET, model: null, usage: null,
    }] }],
  } as StoredConversation;
}

describe('continue a builder from a summary', () => {
  // INVARIANT: the summary of a builder conversation is made from its READABLE
  // transcript only — never a tool call, never a tool's output, never a
  // subagent sidechain. Any member may continue a teammate's builder, so this
  // is what keeps the commands it ran and what they printed with their owner.
  test('the summary input never includes tool blocks or subagents', () => {
    const conversation = storedFromRaw();
    const { text } = renderSummaryInput(conversation);
    const prompt = buildSummaryPrompt(conversation);
    for (const out of [text, prompt, excerptSummary(conversation)]) {
      expect(out).toContain('Plan the release notes');
      expect(out).toContain('Here is the plan.');
      expect(out).not.toContain(TOOL_SECRET);
      expect(out).not.toContain(TOOL_COMMAND);
      expect(out).not.toContain('tool_use');
      expect(out).not.toContain('tool_result');
      expect(out).not.toContain(SUBAGENT_SECRET);
    }
  });

  test('a long conversation keeps its newest messages within the cap', () => {
    const conversation = storedFromRaw();
    const big = 'x'.repeat(7_000);
    conversation.messages = Array.from({ length: 40 }, (_, i) => ({
      uuid: `m${i}`, parentUuid: null, timestamp: '', role: i % 2 ? 'assistant' : 'user', text: `${i} ${big}`, model: null, usage: null,
    })) as StoredConversation['messages'];
    const { text } = renderSummaryInput(conversation);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_INPUT_MAX_CHARS + 200);
    expect(text).toContain('39 x');
    expect(text).toContain('earlier message(s) omitted');
  });

  test('the seed names the source conversation and who had it', () => {
    const seed = buildContinuationSeed({
      source: { builderId: 'b-123', title: 'Plan the release notes', memberEmail: 'alice@example.com', method: 'llm' },
      memberEmail: 'bob@example.com',
      summary: '## Goal\nShip it. $& $1',
    });
    expect(seed).toContain('bob@example.com');
    expect(seed).toContain('"Plan the release notes" (builder b-123), which alice@example.com had');
    // Replacement patterns in the summary are inserted literally.
    expect(seed).toContain('Ship it. $& $1');
  });

  // The link reads both ways on the Builders page.
  test('a continued builder links to its source, and the source to it', () => {
    const seg = (id: string, email: string) => ({
      sessionId: id, memberEmail: email, projectPath: 'p', startedAt: null, endedAt: null, importedAt: 0,
      summary: id, gitBranch: null,
      stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
      lineage: { firstUuid: `${id}-1`, tailUuids: [`${id}-1`], externalRefs: [], forkedFromSessionIds: [] },
    });
    const run = {
      id: 'r1', projectRoot: '/p', memberEmail: 'bob@example.com', kind: 'interactive', state: 'stopped',
      containerName: null, builderId: 'b', agentSessionId: 'bobs', createdAt: '', updatedAt: '', endedAt: null,
      continuedFrom: { builderId: 'alices', title: 'alices', memberEmail: 'alice@example.com', method: 'llm' },
    } as BuilderSession;
    const builders = summarizeBuilders([seg('alices', 'alice@example.com'), seg('bobs', 'bob@example.com')] as any, [run]);
    const bobs = builders.find((b) => b.id === 'bobs')!;
    const alices = builders.find((b) => b.id === 'alices')!;
    expect(bobs.continuedFrom?.builderId).toBe('alices');
    expect(alices.continuedAs).toEqual([{ builderId: 'bobs', memberEmail: 'bob@example.com' }]);
  });

  // INVARIANT: the "continued from" link belongs to the CONVERSATION, not to
  // whichever run row last touched it. An End then Resume (a newer row) and a
  // run re-pointed at another conversation must both keep it.
  test('the link survives an end-then-resume and a re-pointed run', () => {
    const from = { builderId: 'alices', title: 'alices', memberEmail: 'alice@example.com', method: 'llm' as const };
    const base = { projectRoot: '/p', memberEmail: 'bob@example.com', kind: 'interactive', containerName: null,
      builderId: 'b', createdAt: '', endedAt: null };
    const ended = { ...base, id: 'r1', state: 'ended', agentSessionId: 'bobs', updatedAt: '2026-10-20T10:00:00Z',
      continuedFrom: from, continuationSeed: 'SEED' } as BuilderSession;
    const resumed = { ...base, id: 'r2', state: 'stopped', agentSessionId: 'bobs', updatedAt: '2026-10-20T11:00:00Z' } as BuilderSession;
    expect(continuationFor([ended, resumed], ['bobs'])).toEqual({ continuedFrom: from, continuationSeed: 'SEED' });

    const repointed = { ...base, id: 'r3', state: 'stopped', agentSessionId: 'other', updatedAt: '2026-10-20T12:00:00Z',
      pastContinuations: [{ agentSessionId: 'bobs', continuedFrom: from, continuationSeed: 'SEED' }] } as BuilderSession;
    expect(continuationFor([repointed], ['bobs'])?.continuedFrom.builderId).toBe('alices');
    expect(continuationFor([repointed], ['other'])).toBeNull();
  });
});
