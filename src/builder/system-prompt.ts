/**
 * Assemble the builder system prompt.
 *
 * One function, two launch paths (`lazy builder` and the headless review-session
 * turn). Substitutions that used to live in both callers — runner instructions,
 * verbosity, dashboard URL, memory, system messages, model guidance — live here
 * so a new section cannot be added to one path and forgotten on the other.
 *
 * Prompt templates stay in `src/prompts/*.md` with `{{placeholder}}` substitution.
 */
import { loadConfig, hasExplicitModelConfig } from '../config/loader';
import { renderChattinessSnippet, resolveBuilderChattiness } from '../config/chattiness';
import { buildMemorySection } from '../memory';
import { buildSystemMessagesSection } from '../messages';
import {
  renderDashboardPromptSection,
  resolveDashboardAvailability,
  type DashboardAvailability,
} from '../daemon/dashboard-availability';
import type { Storage } from '../storage';
import type { ResolvedConfig } from '../config/types';
import { resolveProjectAgent } from '../daemon/project-settings';
import type { Runner } from '../runner';

import lazySystemPrompt from '../prompts/builder-system-prompt.md' with { type: 'text' };
import scratchHostSection from '../prompts/builder-scratch-host.md' with { type: 'text' };
import scratchStoreSection from '../prompts/builder-scratch-store.md' with { type: 'text' };
import modelGuidance from '../prompts/model-guidance.md' with { type: 'text' };
import agentProfilesSection from '../prompts/agent-profiles-section.md' with { type: 'text' };
import { agentProfilesFor, profileNameForAgent, renderAgentProfileList } from '../config/agent-profiles';

export interface AssembleBuilderSystemPromptOpts {
  lazyRoot: string;
  runner: Runner;
  storage: Storage;
  /**
   * Tests inject a fixture so assembly does not talk to a daemon.
   * Production callers omit this and resolve from `/daemon/status`.
   */
  dashboard?: DashboardAvailability;
  /**
   * False when the prompt is being assembled to be MEASURED rather than sent —
   * doctor's context budget does this. It suppresses the over-threshold memory
   * line a real launch logs (a diagnostic must not tell you to run the command
   * you are already running) and nothing else; the prompt is byte-identical.
   */
  announceMemorySize?: boolean;
  /**
   * Where the human reads the builder's scratch dir. `host` (default): the
   * `lazy builder` launches, which mount scratch at its own host path, so a
   * printed path opens in the operator's shell. `store`: a daemon-owned
   * detached (Lazy Teams) builder, whose scratch is mounted at a container-only
   * path (BUILDER_CONTAINER_PATHS.scratchDir) — members read it only through
   * the captured copy, so the prompt must never promise the path works for them.
   */
  scratchAccess?: ScratchAccess;
}

export type ScratchAccess = 'host' | 'store';

/**
 * Fill the builder template's placeholders. Pure: no I/O, so unit tests can
 * assert the assembled prompt contains the dashboard URL (or the off sentence)
 * without a running daemon.
 *
 * `chattinessSnippet` may be empty (placeholder collapses). `dashboardSection`
 * is never empty — the builder always gets either the URL patterns or the
 * unavailable sentence.
 */
export function applyBuilderPromptPlaceholders(opts: {
  template?: string;
  runnerInstructions: string;
  chattinessSnippet: string;
  dashboardSection: string;
  scratchAccess?: ScratchAccess;
}): string {
  const template = opts.template ?? lazySystemPrompt;
  let prompt = template.replace('{{RUNNER_INSTRUCTIONS}}', opts.runnerInstructions);
  prompt = prompt.replace(
    '{{CHATTINESS}}',
    opts.chattinessSnippet ? opts.chattinessSnippet + '\n\n' : '',
  );
  prompt = prompt.replace('{{DASHBOARD}}', opts.dashboardSection + '\n\n');
  const scratchSection = opts.scratchAccess === 'store' ? scratchStoreSection : scratchHostSection;
  prompt = prompt.replace('{{SCRATCH_LOCATION}}', () => scratchSection.trimEnd());
  return prompt.trimEnd();
}

/**
 * The builder's "Agent profiles" section: the project's offered profiles with
 * their "use when" notes, and the default for new top-level tasks (the
 * project-settings overlay included, as `lazy_create` resolves it). Function
 * replacers, so `$` sequences in user-written descriptions stay literal.
 */
export function renderBuilderAgentProfilesSection(config: ResolvedConfig, defaultAgent: string): string {
  const list = renderAgentProfileList(agentProfilesFor(config));
  return agentProfilesSection
    .replace('{{default}}', () => profileNameForAgent(defaultAgent))
    .replace('{{profiles}}', () => list)
    .trimEnd();
}

/** Full builder system prompt — same substitutions on every launch path. */
export async function assembleBuilderSystemPrompt(
  opts: AssembleBuilderSystemPromptOpts,
): Promise<string> {
  const config = await loadConfig(opts.lazyRoot);
  const chattinessSnippet = renderChattinessSnippet(resolveBuilderChattiness(config));
  const availability = opts.dashboard
    ?? await resolveDashboardAvailability(opts.lazyRoot);

  let prompt = applyBuilderPromptPlaceholders({
    runnerInstructions: opts.runner.getBuilderInstructions().trimEnd(),
    chattinessSnippet,
    dashboardSection: renderDashboardPromptSection(availability),
    scratchAccess: opts.scratchAccess,
  });

  const memorySection = await buildMemorySection(opts.storage, 'builder', {
    warnBytes: config.memory.warn_bytes,
    announceOverThreshold: opts.announceMemorySize !== false,
  });
  if (memorySection) prompt += '\n\n' + memorySection;

  const messagesSection = await buildSystemMessagesSection(opts.storage);
  if (messagesSection) prompt += '\n\n' + messagesSection;

  // The project's agent profiles with their "use when" descriptions, so the
  // builder can PROPOSE one for a task. The loader already resolved the table,
  // so a bad block has failed before this point.
  prompt += '\n\n' + renderBuilderAgentProfilesSection(
    config,
    resolveProjectAgent(await opts.storage.getProjectSettings(), config),
  );

  if (await hasExplicitModelConfig(opts.lazyRoot)) {
    const defaultModel = config.models.default;
    prompt += `\n\n## Model selection\n\nThe project is configured to use **${defaultModel}** as the default model (in lazy.toml).\nDo NOT pass \`--model\` when creating or starting tasks unless the engineer explicitly asks for a different model.\nOmitting \`--model\` lets the CLI use the configured default automatically.`;
  } else {
    prompt += '\n\n' + modelGuidance.trimEnd();
  }

  return prompt;
}
