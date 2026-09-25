/**
 * Shared argv/parse helpers for headless builder turns (UI review sessions).
 */

import { ClaudeCodeAgent } from '../agent/claude-code';
import type { ResolvedConfig, RoleTarget } from '../config/types';

/**
 * The model a headless builder turn runs. The turn always runs Claude Code, so
 * the builder target's model is resolved as a claude-code launch — the same
 * binary the interactive builder hands the target's model to.
 */
export function builderHeadlessModel(config: ResolvedConfig, target: RoleTarget): string {
  // Deferred: agent-model reaches the agent registry, and importing it at
  // load time from the runners closes the circular-init edge described in
  // buildOneshotAgentArgv (src/oneshot/args.ts).
  const { resolveBuilderModel } = require('../agent/agent-model') as typeof import('../agent/agent-model');
  return resolveBuilderModel(config, { harness: 'claude-code', model: target.model });
}

/** Compose `claude -p` argv for one builder review-session turn. */
export function buildBuilderHeadlessClaudeArgs(
  systemPrompt: string,
  prompt: string,
  resumeSessionId: string | null | undefined,
  model: string,
): string[] {
  const agent = new ClaudeCodeAgent();
  return agent.buildExecArgs({
    prompt,
    systemPrompt,
    sessionId: resumeSessionId ?? undefined,
    modelId: model,
    dangerouslySkipPermissions: true,
  });
}

/** Parse stream-json or json stdout from a headless builder turn. */
export function parseBuilderHeadlessStdout(stdout: string): { answer: string; sessionId: string | null } {
  const agent = new ClaudeCodeAgent();
  const parsed = agent.parseResponse(stdout);
  return {
    answer: parsed.result,
    sessionId: parsed.session_id ?? null,
  };
}
