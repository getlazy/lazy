/**
 * Unit tests: agentDisplayName — the one place user-facing messages get a
 * product name for a task's agent.
 *
 * INVARIANT: a message that names an agent names the TASK'S agent. This helper
 * exists because messages used to hardcode "Claude" on code paths that also run
 * for cursor tasks (`lazy unblock` on a cursor task printed "Session has no
 * Claude session ID. Will start a fresh Claude session."). Every registered
 * agent must therefore have a name here, and an unregistered id must fall
 * through to its own id rather than to any agent's name.
 */

import { describe, test, expect } from 'bun:test';
import { agentDisplayName, listAgents } from '../../src/agent/registry';

describe('agentDisplayName', () => {
  test('names each registered agent', () => {
    expect(agentDisplayName('claude-code')).toBe('Claude Code');
    expect(agentDisplayName('cursor')).toBe('Cursor');
    expect(agentDisplayName('qa-agent')).toBe('QA agent');
  });

  // Drift guard: a newly registered agent that nobody named here would be
  // displayed as its raw id — acceptable, but only if it was a deliberate call.
  test('every registered agent has a display name distinct from its raw id', () => {
    for (const id of listAgents()) {
      expect(agentDisplayName(id)).not.toBe(id);
    }
  });

  test('unknown ids pass through verbatim rather than naming another agent', () => {
    expect(agentDisplayName('codex')).toBe('codex');
  });

  test('a missing agent id falls back to the generic word', () => {
    expect(agentDisplayName(undefined)).toBe('agent');
    expect(agentDisplayName(null)).toBe('agent');
    expect(agentDisplayName('')).toBe('agent');
  });
});
