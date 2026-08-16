/**
 * Unit tests for the session-start MCP verification (src/supervisor/mcp-verify.ts).
 *
 * Context: `prepareTurnMcp` proves only that lazy WROTE an MCP config. The
 * incident that motivated this module had a perfect-looking config and
 * `claude mcp list` printing "✔ Connected", while the agent in that same
 * container failed every call with `No such tool available: lazy_status`.
 * The agent's own init line is the only ground truth, and these tests pin how
 * it is judged.
 */

import { describe, test, expect } from 'bun:test';
import type { AgentActivityEvent } from '../../src/agent/activity-stream';
import { formatMcpObservation, verifyInitMcpTools } from '../../src/supervisor/mcp-verify';

function initEvent(partial: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return { kind: 'session_start', sessionId: 'sess-1', ...partial };
}

describe('verifyInitMcpTools', () => {
  // INVARIANT (toolless-turns-must-not-run): a turn that provably started with
  // no lazy tools cannot read task history, record follow-ups, or reach any
  // lazy state. Letting it run to completion produces a turn whose output looks
  // normal and whose work was done blind. It must be killed.
  test('an agent that loaded no mcp__lazy__ tools is a failure', () => {
    const verdict = verifyInitMcpTools(initEvent({
      mcpServers: [{ name: 'lazy', status: 'connected' }],
      toolNames: ['Bash', 'Read', 'Edit'],
    }));
    expect(verdict.outcome).toBe('missing');
    if (verdict.outcome !== 'missing') throw new Error('unreachable');
    expect(verdict.observation).toEqual({ serverStatus: 'connected', lazyToolCount: 0 });
    // The reason must name the connected-but-toolless shape, since that is the
    // state `claude mcp list` reports as healthy.
    expect(verdict.reason).toContain('connected');
  });

  test('a healthy init line passes and reports what was observed', () => {
    const verdict = verifyInitMcpTools(initEvent({
      mcpServers: [{ name: 'lazy', status: 'connected' }],
      toolNames: ['Bash', 'mcp__lazy__lazy_status', 'mcp__lazy__lazy_commit'],
    }));
    expect(verdict.outcome).toBe('ok');
    if (verdict.outcome !== 'ok') throw new Error('unreachable');
    expect(formatMcpObservation(verdict.observation)).toBe('lazy=connected tools=2');
  });

  // INVARIANT (ask-turns-get-fewer-tools): ask turns run read-only and
  // legitimately receive only READ_ONLY_TOOL_NAMES. The check asserts "at least
  // one lazy tool", never the full set — anything stricter kills every ask turn.
  test('a single lazy tool is enough (read-only ask turns)', () => {
    const verdict = verifyInitMcpTools(initEvent({
      mcpServers: [{ name: 'lazy', status: 'connected' }],
      toolNames: ['Bash', 'mcp__lazy__lazy_status'],
    }));
    expect(verdict.outcome).toBe('ok');
  });

  // INVARIANT (unknown-must-not-kill): absence of evidence is not evidence of
  // absence. A future agent release that stops reporting these fields, a
  // different agent (Cursor emits no equivalent), or a parser miss must never
  // take down a turn that was working fine.
  test('an init line reporting neither field is unknown, not a failure', () => {
    const verdict = verifyInitMcpTools(initEvent());
    expect(verdict.outcome).toBe('unknown');
  });

  test('no session-start event at all is unknown, not a failure', () => {
    expect(verifyInitMcpTools(null).outcome).toBe('unknown');
    expect(verifyInitMcpTools(undefined).outcome).toBe('unknown');
    expect(verifyInitMcpTools({ kind: 'progress' }).outcome).toBe('unknown');
  });

  test('servers reported but no tools list is unknown while the server looks healthy', () => {
    const verdict = verifyInitMcpTools(initEvent({
      mcpServers: [{ name: 'lazy', status: 'connected' }],
    }));
    expect(verdict.outcome).toBe('unknown');
  });

  test('a server list that omits lazy is positive evidence even without a tools list', () => {
    const verdict = verifyInitMcpTools(initEvent({ mcpServers: [{ name: 'other', status: 'connected' }] }));
    expect(verdict.outcome).toBe('missing');
    if (verdict.outcome !== 'missing') throw new Error('unreachable');
    expect(verdict.observation.serverStatus).toBe('absent');
  });

  test('a lazy server reported as failed is positive evidence', () => {
    const verdict = verifyInitMcpTools(initEvent({ mcpServers: [{ name: 'lazy', status: 'failed' }] }));
    expect(verdict.outcome).toBe('missing');
  });

  // Tools are what the agent can actually call, so they win over a stale or
  // odd server status — the turn is usable and must not be killed.
  test('tools present with a non-connected server status still passes', () => {
    const verdict = verifyInitMcpTools(initEvent({
      mcpServers: [{ name: 'lazy', status: 'needs-auth' }],
      toolNames: ['mcp__lazy__lazy_status'],
    }));
    expect(verdict.outcome).toBe('ok');
    if (verdict.outcome !== 'ok') throw new Error('unreachable');
    expect(formatMcpObservation(verdict.observation)).toBe('lazy=needs-auth tools=1');
  });

  test('an empty tools array is evidence of zero, not of silence', () => {
    const verdict = verifyInitMcpTools(initEvent({ toolNames: [] }));
    expect(verdict.outcome).toBe('missing');
    if (verdict.outcome !== 'missing') throw new Error('unreachable');
    expect(verdict.observation.serverStatus).toBe('unreported');
  });
});
