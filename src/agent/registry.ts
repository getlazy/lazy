/**
 * Agent registry — factory functions for creating Agent and AgentPackaging instances.
 *
 * Adding a new agent requires:
 * 1. Implement Agent interface (e.g., src/agent/cursor.ts)
 * 2. Implement AgentPackaging interface (e.g., src/agent/cursor-packaging.ts)
 * 3. Register both in this file
 */

import { ClaudeCodeAgent } from './claude-code';
import { ClaudeCodePackaging } from './claude-code-packaging';
import { CursorAgent } from './cursor';
import { CursorPackaging } from './cursor-packaging';
import { QaAgent } from './qa-agent';
import { QaAgentPackaging } from './qa-agent-packaging';
import type { Agent, AgentPackaging } from './interface';

const agents: Record<string, () => Agent> = {
  'claude-code': () => new ClaudeCodeAgent(),
  'cursor': () => new CursorAgent(),
  'qa-agent': () => new QaAgent(),
};

const packaging: Record<string, () => AgentPackaging> = {
  'claude-code': () => new ClaudeCodePackaging(),
  'cursor': () => new CursorPackaging(),
  'qa-agent': () => new QaAgentPackaging(),
};

export function getAgent(agentId: string): Agent {
  const factory = agents[agentId];
  if (!factory) {
    throw new Error(
      `Unknown agent: ${agentId}. Available agents: ${Object.keys(agents).join(', ')}`
    );
  }
  return factory();
}

export function getAgentPackaging(agentId: string): AgentPackaging {
  const factory = packaging[agentId];
  if (!factory) {
    throw new Error(
      `Unknown agent: ${agentId}. Available agents: ${Object.keys(packaging).join(', ')}`
    );
  }
  return factory();
}

export function listAgents(): string[] {
  return Object.keys(agents);
}

const displayNames: Record<string, string> = {
  'claude-code': 'Claude Code',
  'cursor': 'Cursor',
  'qa-agent': 'QA agent',
};

/**
 * Human-readable name for an agent id, for user-facing messages.
 *
 * Exists so no message has to hardcode "Claude" where the TASK'S agent is
 * meant — a cursor task told "no Claude session ID" names the wrong product.
 * Unknown ids pass through verbatim (a message naming the raw id beats one
 * naming the wrong agent), and a missing id falls back to the generic word.
 */
export function agentDisplayName(agentId: string | null | undefined): string {
  if (!agentId) return 'agent';
  return displayNames[agentId] ?? agentId;
}
