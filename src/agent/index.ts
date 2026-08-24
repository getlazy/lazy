/**
 * Agent module — public API for agent abstraction.
 */

export type { Agent, AgentPackaging } from './interface';
export { getAgent, getAgentPackaging, listAgents, agentDisplayName } from './registry';
export { ClaudeCodeAgent } from './claude-code';
export { ClaudeCodePackaging } from './claude-code-packaging';
