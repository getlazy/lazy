/**
 * Renders the seeded `setup-dockerfile` task prompt for a project's agent.
 *
 * `lazy init` offers this task to every project, so the prompt must feature the
 * CLI of the agent that project actually runs — a cursor project told to
 * `bun install -g @anthropic-ai/claude-code` gets a Dockerfile.lazy its own
 * agent cannot run from.
 */

import setupDockerfilePrompt from '../prompts/setup-dockerfile.md' with { type: 'text' };
import { getAgentPackaging, agentDisplayName } from '../agent/registry';

/**
 * @param harness The agent BINARY the image must install — not a profile name.
 *   Packaging is keyed by harness, so the caller resolves `[agent] agent_id`
 *   through the profile table before calling.
 */
export function renderSetupDockerfilePrompt(harness: string): string {
  const name = agentDisplayName(harness);
  let install: string;
  try {
    install = getAgentPackaging(harness).dockerInstallCommand();
  } catch {
    // Unknown harness (a hand-edited lazy.toml, or a profile naming one lazy
    // does not implement). Seeding a task is best-effort context, never a reason
    // to fail init — name the agent and let the seeded task's own agent fill in
    // its installer.
    install = `RUN <install the ${name} CLI>`;
  }
  return setupDockerfilePrompt
    .replace(/\{\{agentName\}\}/g, name)
    .replace(/\{\{agentInstall\}\}/g, install);
}
