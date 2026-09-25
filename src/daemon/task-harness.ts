/**
 * Profile → harness resolution for a task's launch.
 *
 * `task.agent_id` names a PROFILE (`[agents.<name>]` in lazy.toml: harness +
 * model + endpoint + credential). The agent REGISTRY, by contrast, is keyed by
 * harness — `getAgent()` / `getAgentPackaging()` answer "which binary, packaged
 * how", and a profile called `local-ollama-pi` is not a key there.
 *
 * Every daemon launch path therefore has to cross from one to the other, and it
 * has to do it the same way each time: the built-in profiles are named after
 * their harnesses, so a site that skips the resolution keeps working for every
 * default project and fails only for the user who defined a custom profile —
 * exactly the shape of bug that hides until someone uses the feature. Two
 * helpers, used everywhere, is what stops that from being per-site discipline.
 */

import type { ResolvedConfig } from '../config/types';
import type { Task } from '../types';
import { type AgentProfile, profileForAgentName } from '../config/agent-profiles';
import { roleTargetForProfile } from '../config/default-target';
import { getAgent } from '../agent/registry';
import { displayId } from '../task/identity';

/**
 * The harness a task's agent profile runs.
 *
 * Throws when the profile no longer exists in lazy.toml — naming the task, so
 * the error says which one to fix rather than just which name was missing. A
 * task whose profile was deleted from config cannot be launched, and guessing a
 * harness for it would run the turn on a binary, model and upstream nobody
 * chose (CLAUDE.md: no silent fallbacks).
 */
export function harnessForTask(config: ResolvedConfig, task: Task): string {
  return profileForAgentName(config, task.agent_id, `task ${displayId(task)}`).harness;
}

/**
 * Point a runner at the agent class for a task's harness, and return the
 * harness name for the caller to put on the supervisor command.
 *
 * Without this the host-process runner falls back to the Claude Code singleton
 * and demands an Anthropic credential for agents that need none (qa-agent), so
 * every launch path sets it. The `setAgent` capability check is a runtime probe
 * because it is not on the `Runner` interface — only the two process runners
 * have it.
 *
 * The whole resolution is handed over in ONE call — see {@link applyRunnerAgent}
 * for what travels with it and why none of it may be set separately.
 */
export function setRunnerAgentForTask(
  runner: unknown,
  config: ResolvedConfig,
  task: Task,
): string {
  const profile = profileForAgentName(config, task.agent_id, `task ${displayId(task)}`);
  applyRunnerAgent(runner, profile);
  return profile.harness;
}

/**
 * Point a runner at a task's resolved profile: the harness it runs, the profile
 * name its credential grant is minted against, and the profile's own target
 * (endpoint, credential slot, model) for the agent role.
 *
 * Split out of {@link setRunnerAgentForTask} for the one launch path that has
 * already resolved the profile itself (src/daemon/task-launcher.ts, which needs
 * it for a container-compat refusal before this point).
 *
 * All three land in ONE call deliberately. The runner needs the harness to pick
 * a binary, the profile NAME so the proxy can route the grant, and the profile's
 * TARGET so the launch preflights that profile's upstream and mints against that
 * profile's credential slot. A path that set only some of them fails exactly
 * where it is hardest to notice: a task naming a custom profile would launch on
 * the ROLE's credential and preflight the ROLE's endpoint while its traffic was
 * routed to the profile's — and every default project would look fine.
 */
export function applyRunnerAgent(runner: unknown, profile: AgentProfile): void {
  if (runner && typeof runner === 'object' && 'setAgent' in runner
      && typeof (runner as { setAgent: unknown }).setAgent === 'function') {
    (runner as { setAgent: (a: ReturnType<typeof getAgent>, p?: string) => void })
      .setAgent(getAgent(profile.harness), profile.name);
  }
  if (runner && typeof runner === 'object' && 'setAgentTarget' in runner
      && typeof (runner as { setAgentTarget: unknown }).setAgentTarget === 'function') {
    (runner as { setAgentTarget: (t: ReturnType<typeof roleTargetForProfile>) => void })
      .setAgentTarget(roleTargetForProfile(profile));
  }
}
