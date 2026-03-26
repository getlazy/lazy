/**
 * Permission violation push-back.
 *
 * After the work phase detects file permission violations, this module
 * resumes the agent's session with a push-back prompt listing the violations.
 * The agent gets one chance to self-correct (revert unnecessary changes) or
 * justify them. After push-back, the supervisor re-checks violations on the
 * new HEAD.
 *
 * This is a single-shot mechanism — no loop. Detect → push back → re-detect → report.
 */

import type { FileViolation } from '../types';
import type { Agent } from '../agent/interface';
import { log, logError } from './log';
import { execWithWatchdog } from './watchdog';
import permissionPushbackTemplate from '../prompts/permission-pushback.md' with { type: 'text' };

export interface PushbackResult {
  /** The agent's text response to the push-back prompt */
  response: string;
}

/**
 * Resume the agent's session with a push-back prompt listing violations.
 *
 * @param agent The agent to use
 * @param worktreePath Working directory
 * @param sessionId The agent's session ID from the work phase
 * @param violations Detected violations to present to the agent
 * @param modelId Optional model override
 * @returns The agent's response text
 */
export async function runPermissionPushback(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  violations: FileViolation[],
  modelId?: string,
): Promise<PushbackResult> {
  const fileList = violations.map(v => `  - ${v.file}`).join('\n');
  const prompt = permissionPushbackTemplate
    .replace('{{count}}', String(violations.length))
    .replace('{{files}}', fileList);

  log(`[pushback] Resuming session ${sessionId.substring(0, 8)}... with ${violations.length} violation(s)`);

  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId,
  });

  const { stdout, stderr, exitCode } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    timeoutMs: 0, // no watchdog for push-back — it should be fast
  });

  if (exitCode !== 0) {
    logError(`[pushback] Agent exited with code ${exitCode}`);
    logError(`[pushback] stderr: ${stderr.slice(-500)}`);
    // Push-back failure is non-fatal — return empty response and let violations stand
    return { response: 'Push-back failed: agent exited with an error.' };
  }

  // Parse the agent's response
  let responseText: string;
  try {
    const parsed = agent.parseResponse(stdout, { workingDir: worktreePath });
    responseText = parsed.result;
  } catch (err) {
    logError(`[pushback] Failed to parse response: ${err instanceof Error ? err.message : err}`);
    responseText = 'Push-back failed: could not parse agent response.';
  }

  log(`[pushback] Agent responded (${responseText.length} chars)`);
  return { response: responseText };
}
