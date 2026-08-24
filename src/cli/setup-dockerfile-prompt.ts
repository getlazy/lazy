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

export function renderSetupDockerfilePrompt(agentId: string): string {
  const name = agentDisplayName(agentId);
  let install: string;
  try {
    install = getAgentPackaging(agentId).dockerInstallCommand();
  } catch {
    // Unknown agent id (a hand-edited lazy.toml). Seeding a task is best-effort
    // context, never a reason to fail init — name the agent and let the seeded
    // task's own agent fill in its installer.
    install = `RUN <install the ${name} CLI>`;
  }
  return setupDockerfilePrompt
    .replace(/\{\{agentName\}\}/g, name)
    .replace(/\{\{agentInstall\}\}/g, install);
}
