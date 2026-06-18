/**
 * Chattiness (conversational verbosity) resolution and prompt rendering.
 *
 * The `[chattiness]` config section carries a shared `default` plus optional
 * per-role overrides (`builder`, `agent`). When a role's effective level is
 * unset (''), no verbosity snippet is injected and behavior is unchanged — this
 * preserves today's default for existing users.
 */
import type { ResolvedConfig, ChattinessLevel } from './types';
import chattinessSnippet from '../prompts/chattiness.md' with { type: 'text' };

/** Effective builder verbosity: per-role override, else shared default, else unset. */
export function resolveBuilderChattiness(config: ResolvedConfig): ChattinessLevel | '' {
  return config.chattiness.builder || config.chattiness.default;
}

/** Effective agent verbosity: per-role override, else shared default, else unset. */
export function resolveAgentChattiness(config: ResolvedConfig): ChattinessLevel | '' {
  return config.chattiness.agent || config.chattiness.default;
}

/**
 * Render the verbosity prompt snippet for the given level.
 * Returns '' when the level is unset so callers can inject nothing.
 */
export function renderChattinessSnippet(level: ChattinessLevel | ''): string {
  if (!level) return '';
  return chattinessSnippet.replace(/\{\{CHATTINESS_LEVEL\}\}/g, level).trimEnd();
}
