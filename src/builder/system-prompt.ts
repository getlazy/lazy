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
import type { Runner } from '../runner';

import lazySystemPrompt from '../prompts/builder-system-prompt.md' with { type: 'text' };
import modelGuidance from '../prompts/model-guidance.md' with { type: 'text' };

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
}

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
}): string {
  const template = opts.template ?? lazySystemPrompt;
  let prompt = template.replace('{{RUNNER_INSTRUCTIONS}}', opts.runnerInstructions);
  prompt = prompt.replace(
    '{{CHATTINESS}}',
    opts.chattinessSnippet ? opts.chattinessSnippet + '\n\n' : '',
  );
  prompt = prompt.replace('{{DASHBOARD}}', opts.dashboardSection + '\n\n');
  return prompt.trimEnd();
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
  });

  const memorySection = await buildMemorySection(opts.storage, 'builder', {
    warnBytes: config.memory.warn_bytes,
    announceOverThreshold: opts.announceMemorySize !== false,
  });
  if (memorySection) prompt += '\n\n' + memorySection;

  const messagesSection = await buildSystemMessagesSection(opts.storage);
  if (messagesSection) prompt += '\n\n' + messagesSection;

  if (await hasExplicitModelConfig(opts.lazyRoot)) {
    const defaultModel = config.models.default;
    prompt += `\n\n## Model selection\n\nThe project is configured to use **${defaultModel}** as the default model (in lazy.toml).\nDo NOT pass \`--model\` when creating or starting tasks unless the engineer explicitly asks for a different model.\nOmitting \`--model\` lets the CLI use the configured default automatically.`;
  } else {
    prompt += '\n\n' + modelGuidance.trimEnd();
  }

  return prompt;
}
