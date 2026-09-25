/**
 * Pi session JSONL → lazy conversation model.
 *
 * The fixtures under test/fixtures/pi/sessions/ are REAL files written by the
 * pinned binary (@earendil-works/pi-coding-agent@0.84.4) run against a
 * scripted Anthropic-wire server — not hand-written from the format doc.
 * Regenerating them requires re-running the pinned binary; do not edit them
 * by hand (that is exactly the assert-unverified-vendor-behavior failure the
 * add-pi-agent task documented).
 *
 *  - two-turn-resumed.jsonl: one `pi -p --session-id <id>` run plus a second
 *    resumed run — verifies resume APPENDS to the same file (2 user + 2
 *    assistant messages, one header).
 *  - tool-use.jsonl: an assistant turn that emits a toolCall, the toolResult
 *    entry, and the follow-up assistant text.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { mkdtemp, mkdir, copyFile, rm, appendFile, readFile, writeFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { piPairingTranscript } from '../../src/cli/commands/pair';
import type { ParsedConversation } from '../../src/import/claude-code-logs';
import {
  parsePiSessionFile,
  parsePiSessionContent,
  piSessionIdFromFilename,
  statPiSessionFiles,
} from '../../src/import/pi-session-logs';
import {
  snapshotPiTaskSessionFiles,
  capturePiTaskConversations,
} from '../../src/import/capture-session';
import { extractSummary, conversationStats } from '../../src/import/claude-code-logs';
import type { Storage } from '../../src/storage';
import type { StoredConversation } from '../../src/storage/types';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'pi', 'sessions');
const TWO_TURN = join(FIXTURES, 'two-turn-resumed.jsonl');
const TOOL_USE = join(FIXTURES, 'tool-use.jsonl');

describe('piSessionIdFromFilename', () => {
  test('extracts the uuid from pi session filenames', () => {
    expect(
      piSessionIdFromFilename('/x/2026-09-04T10-05-45-134Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001.jsonl'),
    ).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001');
    expect(piSessionIdFromFilename('/x/not-a-session.jsonl')).toBeNull();
  });
});

describe('parsePiSessionFile', () => {
  test('parses a real two-turn resumed session', async () => {
    const conv = await parsePiSessionFile(TWO_TURN);

    // Session id comes from the v3 header, not the filename we gave the fixture.
    expect(conv.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001');
    expect(conv.cwd).toBe('/tmp/pi-verify/work');
    expect(conv.version).toBe('pi-session-v3');
    expect(conv.gitBranch).toBeNull();

    // Resume appended to the SAME file: both turns are here.
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.messages[0].text).toBe('say hi');
    expect(conv.messages[1].text).toBe('FAKE_OK reply number 1');
    expect(conv.messages[2].text).toBe('second turn please');
    expect(conv.messages[3].text).toBe('FAKE_OK reply number 2');

    // Tree linkage: entry ids/parentIds map onto uuid/parentUuid.
    expect(conv.messages[1].parentUuid).toBe(conv.messages[0].uuid);
    expect(conv.messages[0].uuid).toMatch(/^[0-9a-f]{8}$/);

    // Entry timestamps are ISO strings; startedAt/endedAt derive from them.
    expect(conv.startedAt).toBe(conv.messages[0].timestamp);
    expect(conv.endedAt).toBe(conv.messages[3].timestamp);
    expect(conv.startedAt!.startsWith('2026-09-04T')).toBe(true);

    // pi usage maps input/output/cacheWrite/cacheRead onto lazy's TokenUsage;
    // both assistant messages carried {input:11, output:9, cacheWrite:3, cacheRead:7}.
    expect(conv.messages[1].model).toBe('claude-sonnet-4-5');
    expect(conv.messages[1].usage).toEqual({
      inputTokens: 11,
      outputTokens: 9,
      cacheCreationTokens: 3,
      cacheReadTokens: 7,
    });
    expect(conv.messages[0].usage).toBeNull();
    expect(conv.totalUsage).toEqual({
      inputTokens: 22,
      outputTokens: 18,
      cacheCreationTokens: 6,
      cacheReadTokens: 14,
    });
  });

  test('parses a real tool-use session: toolCall text kept, toolResult skipped, usage counted', async () => {
    const conv = await parsePiSessionFile(TOOL_USE);

    // The toolResult message contributes no conversation message; the
    // assistant message that carried the toolCall keeps its text part.
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(conv.messages[1].text).toBe('Let me check the date.');
    expect(conv.messages[2].text).toBe('FAKE_DONE the command printed VERIFY_OK');

    // Usage sums over BOTH assistant LLM calls (11+11 in, 21+9 out).
    expect(conv.totalUsage).toEqual({
      inputTokens: 22,
      outputTokens: 30,
      cacheCreationTokens: 6,
      cacheReadTokens: 14,
    });
  });

  test('summary and stats helpers work on the converted model', async () => {
    const conv = await parsePiSessionFile(TWO_TURN);
    expect(extractSummary(conv)).toBe('say hi');
    const stats = conversationStats(conv);
    expect(stats.userMessageCount).toBe(2);
    expect(stats.assistantMessageCount).toBe(2);
    expect(stats.totalTokens).toBe(22 + 18 + 6 + 14);
  });
});

describe('parsePiSessionContent', () => {
  test('tolerates malformed lines and a missing header', () => {
    const content = [
      'not json at all',
      '{"type":"message","id":"aa","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"hello"}}',
      '{broken',
    ].join('\n');
    const conv = parsePiSessionContent(content, 'fallback-id', 'proj-dir');
    expect(conv.sessionId).toBe('fallback-id');
    expect(conv.projectPath).toBe('proj-dir');
    expect(conv.messages.length).toBe(1);
    // String content (the doc's UserMessage allows string or blocks).
    expect(conv.messages[0].text).toBe('hello');
  });

  test('a branched tree parses in file order (branch entries have earlier parents)', async () => {
    // Real-file base plus a branch: pi's /tree appends a branch_summary whose
    // parent is an EARLIER entry, then continues from there — the file stays
    // append-only. Capture keeps the abandoned branch's messages too.
    const base = await readFile(TWO_TURN, 'utf-8');
    const branched = base
      + '{"type":"branch_summary","id":"bbbb0001","parentId":"936ee88c","timestamp":"2026-09-04T12:00:00.000Z","fromId":"38ad74b5","summary":"explored X"}\n'
      + '{"type":"message","id":"bbbb0002","parentId":"bbbb0001","timestamp":"2026-09-04T12:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"after branch"}],"timestamp":1788523201000}}\n';
    const conv = parsePiSessionContent(branched, 'f', 'p');
    expect(conv.messages.map((m) => m.text)).toEqual([
      'say hi',
      'FAKE_OK reply number 1',
      'second turn please',
      'FAKE_OK reply number 2',
      'after branch',
    ]);
    // The branch point is preserved in the parent linkage, not flattened away.
    expect(conv.messages[4].parentUuid).toBe('bbbb0001');
    expect(conv.endedAt).toBe('2026-09-04T12:00:01.000Z');
  });

  test('a truncated last line (pi mid-append) loses only that line', async () => {
    const base = await readFile(TWO_TURN, 'utf-8');
    const lines = base.trimEnd().split('\n');
    const lastLine = lines[lines.length - 1];
    const truncated = lines.slice(0, -1).join('\n') + '\n' + lastLine.slice(0, Math.floor(lastLine.length / 2));
    const conv = parsePiSessionContent(truncated, 'f', 'p');
    // Everything before the cut survives; the half-written line is dropped.
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(conv.messages[2].text).toBe('second turn please');
  });

  test('unknown entry types and unknown message roles from a newer pi are skipped, usage still counted', () => {
    const content = [
      '{"type":"session","version":4,"id":"s-new","timestamp":"t","cwd":"/x"}',
      '{"type":"hologram_checkpoint","id":"aa","parentId":null,"timestamp":"t","payload":{"x":1}}',
      '{"type":"message","id":"bb","parentId":"aa","timestamp":"t","message":{"role":"choreography","content":"???","usage":{"input":5,"output":1,"cacheRead":0,"cacheWrite":0}}}',
      '{"type":"message","id":"cc","parentId":"bb","timestamp":"t","message":{"role":"user","content":"still here"}}',
    ].join('\n');
    const conv = parsePiSessionContent(content, 'f', 'p');
    expect(conv.version).toBe('pi-session-v4');
    expect(conv.messages.length).toBe(1);
    expect(conv.messages[0].text).toBe('still here');
    // An unknown role's usage still counts — pi's totals include every LLM call.
    expect(conv.totalUsage.inputTokens).toBe(5);
  });

  test('toolResult usage (nested LLM work) counts toward the total', () => {
    const content = [
      '{"type":"session","version":3,"id":"s2","timestamp":"t","cwd":"/x"}',
      '{"type":"message","id":"aa","parentId":null,"timestamp":"t","message":{"role":"toolResult","toolCallId":"c1","toolName":"subagent","content":[{"type":"text","text":"did LLM work"}],"isError":false,"usage":{"input":40,"output":4,"cacheRead":2,"cacheWrite":1},"timestamp":1}}',
    ].join('\n');
    const conv = parsePiSessionContent(content, 'f', 'p');
    expect(conv.messages.length).toBe(0);
    expect(conv.totalUsage).toEqual({
      inputTokens: 40,
      outputTokens: 4,
      cacheCreationTokens: 1,
      cacheReadTokens: 2,
    });
  });

  test('non-text content blocks (images) yield no text and are skipped, not crashed on', () => {
    const content = [
      '{"type":"session","version":3,"id":"s3","timestamp":"t","cwd":"/x"}',
      '{"type":"message","id":"aa","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR"}}]}}',
      '{"type":"message","id":"bb","parentId":"aa","timestamp":"t","message":{"role":"toolResult","toolCallId":"c1","toolName":"screenshot","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR"}}],"isError":false}}',
      '{"type":"message","id":"cc","parentId":"bb","timestamp":"t","message":{"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":"what is this?"}]}}',
    ].join('\n');
    const conv = parsePiSessionContent(content, 'f', 'p');
    // Image-only messages contribute nothing; a mixed message keeps its text.
    expect(conv.messages.map((m) => m.text)).toEqual(['what is this?']);
  });

  test('counts compaction/branch_summary usage into the total without emitting messages', () => {
    const content = [
      '{"type":"session","version":3,"id":"s1","timestamp":"t","cwd":"/x"}',
      '{"type":"compaction","id":"aa","parentId":null,"timestamp":"t","summary":"…","tokensBefore":5,"usage":{"input":100,"output":10,"cacheRead":1,"cacheWrite":2}}',
      '{"type":"branch_summary","id":"bb","parentId":"aa","timestamp":"t","fromId":"aa","summary":"…","usage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0}}',
    ].join('\n');
    const conv = parsePiSessionContent(content, 'f', 'p');
    expect(conv.messages.length).toBe(0);
    expect(conv.totalUsage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheCreationTokens: 2,
      cacheReadTokens: 1,
    });
  });
});

// --- Task sandbox capture ---

/** Storage stub covering exactly what pi capture touches. */
function storageStub() {
  const saved: StoredConversation[] = [];
  const stub = {
    saved,
    async saveConversation(c: StoredConversation) {
      saved.push(c);
    },
    async loadConversation(_id: string) {
      return null;
    },
  };
  return stub as typeof stub & Storage;
}

async function makePiWorktree(): Promise<{ worktree: string; sessionFile: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'pi-capture-test-'));
  const sessionsDir = join(worktree, '.lazy-task-sandbox', '.pi', 'agent', 'sessions', '--tmp-pi-verify-work--');
  await mkdir(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, '2026-09-04T10-05-45-134Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001.jsonl');
  await copyFile(TWO_TURN, sessionFile);
  return { worktree, sessionFile };
}

describe('capturePiTaskConversations', () => {
  test('captures new and modified sessions from the task sandbox, skips untouched ones', async () => {
    const { worktree, sessionFile } = await makePiWorktree();
    try {
      // Pre-existing untouched file → not owned by this pairing, not captured.
      const before = await snapshotPiTaskSessionFiles(worktree);
      const storage = storageStub();
      const untouched = await capturePiTaskConversations(worktree, before, storage);
      expect(untouched.captured).toEqual([]);
      expect(untouched.errors).toEqual([]);
      expect(storage.saved.length).toBe(0);

      // The pairing appends a turn (what pi resume really does) → captured whole.
      await appendFile(
        sessionFile,
        '{"type":"message","id":"ffff0001","parentId":"38ad74b5","timestamp":"2026-09-04T11:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"paired turn"}],"timestamp":1788520000000}}\n',
      );
      const grown = await capturePiTaskConversations(worktree, before, storage);
      expect(grown.captured).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001']);
      expect(grown.newestSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001');
      expect(grown.errors).toEqual([]);
      expect(storage.saved.length).toBe(1);
      expect(storage.saved[0].messages.length).toBe(5);
      expect(storage.saved[0].messages[4].text).toBe('paired turn');
      expect(storage.saved[0].summary).toBe('say hi');
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  // INVARIANT: ownership is new-OR-MODIFIED, and "modified" is not just
  // "bigger". A pi session edited in place (a branch replacing entries) can
  // land on the same byte count, and dropping it would lose the pairing.
  test('a file whose size did not change but whose mtime did is still owned', async () => {
    const { worktree, sessionFile } = await makePiWorktree();
    try {
      const before = await snapshotPiTaskSessionFiles(worktree);
      // Same bytes, later mtime.
      const bytes = await readFile(sessionFile, 'utf-8');
      await writeFile(sessionFile, bytes);
      await utimes(sessionFile, new Date(), new Date(Date.now() + 60_000));

      const storage = storageStub();
      const result = await capturePiTaskConversations(worktree, before, storage);
      expect(result.captured).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001']);
      expect(storage.saved.length).toBe(1);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('an empty snapshot captures everything (fresh pairing session)', async () => {
    const { worktree } = await makePiWorktree();
    try {
      const storage = storageStub();
      const result = await capturePiTaskConversations(worktree, new Map(), storage);
      expect(result.captured).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001']);
      expect(storage.saved.length).toBe(1);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('a header+settings-only session (paired and quit immediately) is skipped, not saved, not an error', async () => {
    const { worktree } = await makePiWorktree();
    try {
      // The first three lines of the real fixture are exactly what pi writes
      // before any conversation happens: header, model_change,
      // thinking_level_change.
      const settingsOnly = (await readFile(TWO_TURN, 'utf-8')).split('\n').slice(0, 3).join('\n') + '\n';
      const sessionsDir = join(worktree, '.lazy-task-sandbox', '.pi', 'agent', 'sessions', '--tmp-pi-verify-work--');
      const emptyFile = join(sessionsDir, '2026-09-04T12-00-00-000Z_ffffffff-bbbb-cccc-dddd-eeeeeeee0009.jsonl');
      await writeFile(emptyFile, settingsOnly);
      // Pin the shell as the newest owned file (sub-ms writes would otherwise
      // tie), which is the case worth testing.
      await utimes(emptyFile, new Date(), new Date(Date.now() + 60_000));

      const storage = storageStub();
      // Snapshot excludes the empty file (it appears "during pairing").
      const before: Map<string, { mtimeMs: number; size: number }> = new Map();
      const result = await capturePiTaskConversations(worktree, before, storage);

      // The conversation-bearing fixture is captured; the empty shell is
      // neither saved nor an error — same rule as Claude capture.
      expect(result.captured).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001']);
      expect(result.errors).toEqual([]);
      expect(storage.saved.length).toBe(1);
      // newestSessionId still points at the newest OWNED file even when it is
      // an empty shell — which is exactly why the pairing summary is built
      // from `conversations` and not from that id: the empty shell has no
      // transcript, and summarizing it would silently drop the real one.
      expect(result.newestSessionId).toBe('ffffffff-bbbb-cccc-dddd-eeeeeeee0009');
      expect(result.conversations.length).toBe(1);
      expect(result.conversations[0].sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001');
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  // INVARIANT: persisting the conversation and summarizing it are independent.
  // A storage failure must be surfaced (never swallowed) AND must not also
  // cost the human the end-of-session summary — the parsed conversation is
  // collected before the save is attempted.
  test('a storage failure is reported but still yields the conversation to summarize', async () => {
    const { worktree } = await makePiWorktree();
    try {
      const storage = storageStub();
      storage.saveConversation = async () => {
        throw new Error('store is down');
      };
      const result = await capturePiTaskConversations(worktree, new Map(), storage);
      expect(result.captured).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001');
      expect(result.errors[0].error.message).toContain('store is down');
      expect(result.conversations.length).toBe(1);
      expect(result.conversations[0].messages.length).toBe(4);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('a worktree with no pi sandbox captures nothing and reports no errors', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'pi-capture-empty-'));
    try {
      const storage = storageStub();
      const result = await capturePiTaskConversations(worktree, new Map(), storage);
      expect(result.captured).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.newestSessionId).toBeNull();
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('piPairingTranscript', () => {
  const conv = (sessionId: string, msgs: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string }>): ParsedConversation => ({
    sessionId,
    projectPath: 'p',
    cwd: null,
    version: 'pi-session-v3',
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    messages: msgs.map((m, i) => ({
      uuid: `u${i}`,
      parentUuid: null,
      timestamp: m.timestamp,
      role: m.role,
      text: m.text,
      model: null,
      usage: null,
    })),
    subagents: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  });

  // INVARIANT: one pairing can write more than one session file (a daemon
  // restart relaunches the agent mid-session), and summarizing only the newest
  // would silently drop everything said before the restart.
  test('spans every conversation the pairing owned, in order', () => {
    const transcript = piPairingTranscript([
      conv('s1', [{ role: 'user', text: 'before restart', timestamp: '2026-09-04T10:00:00.000Z' }]),
      conv('s2', [{ role: 'assistant', text: 'after restart', timestamp: '2026-09-04T10:05:00.000Z' }]),
    ]);
    expect(transcript).toBe('Human: before restart\n\nAssistant: after restart');
  });

  test('drops entries from before pairing started but keeps undated ones', () => {
    const transcript = piPairingTranscript(
      [
        conv('s1', [
          { role: 'user', text: 'last week', timestamp: '2026-08-28T10:00:00.000Z' },
          { role: 'user', text: 'undated', timestamp: '' },
          { role: 'assistant', text: 'this session', timestamp: '2026-09-04T10:05:00.000Z' },
        ]),
      ],
      '2026-09-04T10:00:00.000Z',
    );
    expect(transcript).toBe('Human: undated\n\nAssistant: this session');
  });

  test('returns null when nothing was said since pairing started', () => {
    expect(piPairingTranscript([])).toBeNull();
    expect(
      piPairingTranscript(
        [conv('s1', [{ role: 'user', text: 'old', timestamp: '2026-08-01T00:00:00.000Z' }])],
        '2026-09-04T10:00:00.000Z',
      ),
    ).toBeNull();
  });

  test('caps a very long transcript and says it truncated', () => {
    const long = conv('s1', [{ role: 'user', text: 'x'.repeat(30_000), timestamp: '2026-09-04T10:00:00.000Z' }]);
    const transcript = piPairingTranscript([long]);
    expect(transcript).not.toBeNull();
    expect(transcript!.startsWith('...(earlier conversation truncated)...')).toBe(true);
    expect(transcript!.length).toBeLessThan(30_000);
  });
});

describe('statPiSessionFiles', () => {
  test('skips vanished paths instead of throwing', async () => {
    const infos = await statPiSessionFiles([TWO_TURN, '/nonexistent/nope_aaaaaaaa-bbbb-cccc-dddd-eeeeeeee9999.jsonl']);
    expect(infos.length).toBe(1);
    // The fixture is renamed without pi's `_<uuid>` suffix, so the key falls
    // back to the basename (the header id still wins once the file is parsed).
    expect(infos[0].sessionId).toBe('two-turn-resumed');
    expect(infos[0].size).toBeGreaterThan(0);
  });
});
