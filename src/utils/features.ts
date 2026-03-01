/**
 * Feature flags system for Lazy.
 *
 * Enables experimental features to be merged to main behind flags,
 * allowing earlier merging, sooner dogfooding, and per-user opt-in.
 *
 * Precedence (highest to lowest):
 *   1. LAZY_VANILLA=1 env var -> all features off, no exceptions
 *   2. features.all = true in config -> everything on
 *   3. Individual features.X = true -> selective opt-in
 *   4. Default: all features off
 *
 * KNOWN_FEATURES is private to this module. All consumers access it through
 * functions that guarantee alphabetical order. This is critical for prompt
 * caching: if the order of injected prompt snippets changes between turns,
 * the cache is invalidated and tokens are wasted.
 */

import type { ResolvedConfig } from '../config/types';

/**
 * Registry of known feature flag names (private).
 *
 * Used internally to detect stale/unknown flags and build prompt snippets.
 * Flag names must be stable — once a name is used, it stays forever
 * (even after the feature graduates, the name is just removed from this list).
 *
 * The .sort() call guarantees alphabetical order regardless of how entries
 * are added. This is critical for prompt caching stability.
 */
const KNOWN_FEATURES: readonly string[] = ([
  'auto_sync_after_turn',
] as string[]).sort();

/**
 * Return the list of known feature flag names in alphabetical order.
 *
 * This is the only way to access the flag registry from outside this module.
 * The returned order is guaranteed stable for prompt caching.
 */
export function getKnownFeatures(): readonly string[] {
  return KNOWN_FEATURES;
}

/**
 * Check whether a flag name is in the known features registry.
 */
export function isKnownFeature(name: string): boolean {
  return KNOWN_FEATURES.includes(name);
}

/**
 * Return config flag names that are not in the known features registry.
 * Useful for doctor warnings about stale/graduated flags.
 */
export function getUnknownFlags(config: ResolvedConfig): string[] {
  return Object.keys(config.features)
    .filter(k => k !== 'all' && !KNOWN_FEATURES.includes(k));
}

/**
 * Check whether a feature flag is enabled.
 *
 * This function is cheap to call (no I/O) and safe to use in hot paths.
 */
export function isFeatureEnabled(name: string, config: ResolvedConfig): boolean {
  if (process.env.LAZY_VANILLA === '1') return false;
  if (config.features.all) return true;
  return config.features[name] === true;
}

/**
 * Build a deterministic prompt snippet listing enabled feature flags.
 *
 * Returns an empty string when no features are enabled (the common case),
 * so callers can unconditionally concatenate without adding noise.
 *
 * The snippet iterates KNOWN_FEATURES in alphabetical order to ensure
 * prompt stability across turns — any reordering would invalidate the
 * prompt cache and waste tokens.
 */
export function getEnabledFeaturesPromptSnippet(config: ResolvedConfig): string {
  const enabled = KNOWN_FEATURES.filter(f => isFeatureEnabled(f, config));
  if (enabled.length === 0) return '';
  return `\nEnabled experimental features: ${enabled.join(', ')}\n`;
}
