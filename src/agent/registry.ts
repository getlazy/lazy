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
import { CodexAgent } from './codex';
import { CodexPackaging } from './codex-packaging';
import { CursorAgent } from './cursor';
import { CursorPackaging } from './cursor-packaging';
import { PiAgent } from './pi';
import { PiPackaging } from './pi-packaging';
import { QaAgent } from './qa-agent';
import { QaAgentPackaging } from './qa-agent-packaging';
import type { Agent, AgentPackaging } from './interface';

const agents: Record<string, () => Agent> = {
  'claude-code': () => new ClaudeCodeAgent(),
  'codex': () => new CodexAgent(),
  'cursor': () => new CursorAgent(),
  'pi': () => new PiAgent(),
  'qa-agent': () => new QaAgent(),
};

const packaging: Record<string, () => AgentPackaging> = {
  'claude-code': () => new ClaudeCodePackaging(),
  'codex': () => new CodexPackaging(),
  'cursor': () => new CursorPackaging(),
  'pi': () => new PiPackaging(),
  'qa-agent': () => new QaAgentPackaging(),
};

export function getAgent(agentId: string): Agent {
  const factory = agents[agentId];
  if (!factory) {
    throw new Error(
      `Unknown agent: ${agentId}. Available agents: ${availableAgentsHint()}`
    );
  }
  return factory();
}

export function getAgentPackaging(agentId: string): AgentPackaging {
  const factory = packaging[agentId];
  if (!factory) {
    throw new Error(
      `Unknown agent: ${agentId}. Available agents: ${availableAgentsHint()}`
    );
  }
  return factory();
}

export function listAgents(): string[] {
  return Object.keys(agents);
}

/**
 * Agents lazy runs for its own purposes, never offered to a user.
 *
 * `qa-agent` is the deterministic scriptable agent the e2e/QA harness drives
 * (src/qa/agent.ts). It stays fully registered — `listAgents()` still returns
 * it, so a lazy.toml or a `--agent qa-agent` naming it loads and launches — but
 * it must not appear in anything a user reads: the `lazy system agent` listing,
 * the "Available agents:" hints, or the dashboard's agent picker. Those all use
 * {@link listSelectableAgents}.
 */
const INTERNAL_AGENT_IDS = new Set(['qa-agent']);

export function isInternalAgent(agentId: string): boolean {
  return INTERNAL_AGENT_IDS.has(agentId);
}

/**
 * Agents to OFFER a human: every registered agent minus the internal ones.
 *
 * Pass `include` to keep an agent that is already in use visible — a picker
 * whose select silently drops the task's current agent would change it on the
 * next save. Validation never uses this list; it uses {@link listAgents}.
 */
export function listSelectableAgents(include?: string | null): string[] {
  const selectable = Object.keys(agents).filter((id) => !INTERNAL_AGENT_IDS.has(id));
  if (include && agents[include] && !selectable.includes(include)) {
    selectable.push(include);
  }
  return selectable;
}

/**
 * The agent list to print in a "Available agents: …" hint. Selectable only —
 * an error message is user-facing, so it must not advertise an internal agent
 * even though naming one would have validated.
 */
export function availableAgentsHint(): string {
  return listSelectableAgents().join(', ');
}

const displayNames: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'cursor': 'Cursor',
  'pi': 'Pi',
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
