/**
 * Unit tests for the Claude Code activity stream and the response parsing it
 * implies.
 *
 * The event shapes asserted here were captured empirically from Claude Code
 * 2.1.220 running `claude -p --output-format stream-json --verbose`. They are
 * the contract the supervisor's no-progress and wind-down guards depend on:
 * see src/supervisor/watchdog.ts.
 *
 * INVARIANTS:
 *   - `tool_progress` with `heartbeat: true` classifies as `heartbeat`, never
 *     as progress. A wedged MCP call emits one every 30s forever; classifying
 *     it as progress would make a stuck tool call immortal.
 *   - A garbage / partial line yields `null` (not a throw). Killing a process
 *     mid-line is normal and must not blow up the reader.
 *   - `parseResponse` accepts BOTH output shapes: the single `--output-format
 *     json` blob and the final `result` line of a stream. The result object is
 *     byte-identical between the two, so nothing that consumes a response
 *     needs to know which mode produced it.
 */

import { describe, test, expect } from 'bun:test';
import { ClaudeCodeActivityStream } from '../../src/agent/activity-stream';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';

const stream = new ClaudeCodeActivityStream();

const RESULT_OBJ = {
  type: 'result',
  subtype: 'success',
  result: 'summary text',
  session_id: 'sess-1',
  is_error: false,
};

describe('ClaudeCodeActivityStream.parseLine', () => {
  test('system/init reports the session id', () => {
    const ev = stream.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
    expect(ev?.kind).toBe('session_start');
    expect(ev?.sessionId).toBe('sess-1');
  });

  // INVARIANT (init-line-is-ground-truth): the init line is the ONLY place the
  // agent reports what it actually loaded — which MCP servers connected and
  // which tools exist in its own process. Everything else lazy can observe is
  // what it ASKED for. Dropping these fields is what left a toolless turn
  // undetectable while `claude mcp list` printed "✔ Connected".
  test('system/init carries the mcp servers and tool names the agent loaded', () => {
    const ev = stream.parseLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      mcp_servers: [{ name: 'lazy', status: 'connected' }],
      tools: ['Bash', 'mcp__lazy__lazy_status'],
    }));
    expect(ev?.kind).toBe('session_start');
    expect(ev?.mcpServers).toEqual([{ name: 'lazy', status: 'connected' }]);
    expect(ev?.toolNames).toEqual(['Bash', 'mcp__lazy__lazy_status']);
  });

  // INVARIANT (absence-is-not-zero): an init line without these fields — an
  // older or future agent, or a different agent entirely — must leave them
  // undefined. `undefined` means "the agent said nothing"; only `[]` is
  // evidence of "none". Conflating the two would kill healthy turns.
  test('system/init without mcp fields leaves them undefined, not empty', () => {
    const ev = stream.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
    expect(ev?.mcpServers).toBeUndefined();
    expect(ev?.toolNames).toBeUndefined();
  });

  // The parser must never throw on an odd shape — a malformed field costs the
  // observation, never the turn.
  test('system/init with malformed mcp fields does not throw', () => {
    const ev = stream.parseLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      mcp_servers: [{ status: 'connected' }, 'nonsense', { name: 'lazy' }],
      tools: ['Bash', 42, null],
    }));
    expect(ev?.kind).toBe('session_start');
    expect(ev?.mcpServers).toEqual([{ name: 'lazy' }]);
    expect(ev?.toolNames).toEqual(['Bash']);
  });

  test('assistant tool_use is a tool_start carrying id and name', () => {
    const ev = stream.parseLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }] },
    }));
    expect(ev?.kind).toBe('tool_start');
    expect(ev?.toolUseId).toBe('toolu_9');
    expect(ev?.toolName).toBe('Bash');
  });

  test('user tool_result is a tool_end for the matching id', () => {
    const ev = stream.parseLine(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9' }] },
    }));
    expect(ev?.kind).toBe('tool_end');
    expect(ev?.toolUseId).toBe('toolu_9');
  });

  test('assistant text is plain progress', () => {
    const ev = stream.parseLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    }));
    expect(ev?.kind).toBe('progress');
  });

  // INVARIANT: heartbeats are liveness, not progress.
  test('tool_progress heartbeat classifies as heartbeat, not progress', () => {
    const ev = stream.parseLine(JSON.stringify({
      type: 'tool_progress',
      heartbeat: true,
      parent_tool_use_id: 'toolu_9',
      tool_name: 'mcp__lazy__lazy_commit',
      elapsed_time_seconds: 60,
    }));
    expect(ev?.kind).toBe('heartbeat');
    expect(ev?.toolUseId).toBe('toolu_9');
    expect(ev?.toolName).toBe('mcp__lazy__lazy_commit');
  });

  test('result carries the session id and the verbatim line', () => {
    const raw = JSON.stringify(RESULT_OBJ);
    const ev = stream.parseLine(raw);
    expect(ev?.kind).toBe('result');
    expect(ev?.sessionId).toBe('sess-1');
    expect(ev?.raw).toBe(raw);
  });

  test('leading/trailing whitespace does not hide an event', () => {
    const ev = stream.parseLine(`  ${JSON.stringify(RESULT_OBJ)}  `);
    expect(ev?.kind).toBe('result');
  });

  // INVARIANT: a partial line after a kill is normal, not an error.
  test('non-JSON and partial lines yield null instead of throwing', () => {
    expect(stream.parseLine('')).toBeNull();
    expect(stream.parseLine('   ')).toBeNull();
    expect(stream.parseLine('not json at all')).toBeNull();
    expect(stream.parseLine('{"type":"assis')).toBeNull();
  });

  // Forward compatibility: an event kind we've never seen still means the CLI
  // is doing something, so it counts as progress rather than being ignored.
  test('unknown event types are treated as progress', () => {
    const ev = stream.parseLine(JSON.stringify({ type: 'some_future_event' }));
    expect(ev?.kind).toBe('progress');
  });
});

describe('ClaudeCodeAgent.buildExecArgs', () => {
  // The activity stream only exists because the CLI is asked to stream. If
  // these flags drift, the supervisor silently goes back to total silence
  // until exit and the no-progress guard becomes a launch deadline again.
  test('requests stream-json with --verbose', () => {
    const args = new ClaudeCodeAgent().buildExecArgs({
      prompt: 'do the thing',
      dangerouslySkipPermissions: true,
    });
    expect(args.slice(0, 3)).toEqual(['claude', '-p', 'do the thing']);
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    // Required by the CLI for stream-json in -p mode.
    expect(args).toContain('--verbose');
  });

  test('declares an activity stream (Claude Code streams; Cursor does not)', () => {
    expect(new ClaudeCodeAgent().activityStream()).not.toBeNull();
  });
});

describe('ClaudeCodeAgent.parseResponse', () => {
  const agent = new ClaudeCodeAgent();

  test('parses a single --output-format json blob', () => {
    const resp = agent.parseResponse(JSON.stringify(RESULT_OBJ));
    expect(resp.result).toBe('summary text');
    expect(resp.session_id).toBe('sess-1');
  });

  test('parses the result line out of a stream-json transcript', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify(RESULT_OBJ),
      '', // trailing newline
    ].join('\n');

    const resp = agent.parseResponse(transcript);
    expect(resp.result).toBe('summary text');
    expect(resp.session_id).toBe('sess-1');
  });

  // Scanning backwards matters: a sub-agent transcript can contain more than
  // one result-shaped object, and the LAST one is the turn's own.
  test('takes the last result when several appear', () => {
    const transcript = [
      JSON.stringify({ ...RESULT_OBJ, result: 'earlier' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'more work' }] } }),
      JSON.stringify({ ...RESULT_OBJ, result: 'final' }),
    ].join('\n');

    expect(agent.parseResponse(transcript).result).toBe('final');
  });

  test('throws with a diagnosable message when no result is present', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n');

    expect(() => agent.parseResponse(transcript)).toThrow('no result found');
  });

  test('throws when the response object is missing required fields', () => {
    expect(() => agent.parseResponse(JSON.stringify({ type: 'result', result: 'x' })))
      .toThrow('missing required fields');
  });

  test('throws on empty output', () => {
    expect(() => agent.parseResponse('   ')).toThrow();
  });
});
