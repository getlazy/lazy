import { describe, test, expect, afterEach } from 'bun:test';
import { isFeatureEnabled, getKnownFeatures, isKnownFeature, getUnknownFlags, getEnabledFeaturesPromptSnippet } from '../../src/utils/features';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';

function makeConfig(features: Record<string, boolean>): ResolvedConfig {
  return { ...DEFAULT_CONFIG, features };
}

describe('isFeatureEnabled', () => {
  const originalEnv = process.env.LAZY_VANILLA;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LAZY_VANILLA;
    } else {
      process.env.LAZY_VANILLA = originalEnv;
    }
  });

  test('returns false when no features configured', () => {
    const config = makeConfig({});
    expect(isFeatureEnabled('tui_review', config)).toBe(false);
  });

  test('returns true when individual feature is enabled', () => {
    const config = makeConfig({ tui_review: true });
    expect(isFeatureEnabled('tui_review', config)).toBe(true);
  });

  test('returns false when individual feature is explicitly disabled', () => {
    const config = makeConfig({ tui_review: false });
    expect(isFeatureEnabled('tui_review', config)).toBe(false);
  });

  test('returns false for features not in config', () => {
    const config = makeConfig({ tui_review: true });
    expect(isFeatureEnabled('supervisor_permissions', config)).toBe(false);
  });

  test('returns true for all features when all = true', () => {
    const config = makeConfig({ all: true });
    expect(isFeatureEnabled('tui_review', config)).toBe(true);
    expect(isFeatureEnabled('supervisor_permissions', config)).toBe(true);
    expect(isFeatureEnabled('anything', config)).toBe(true);
  });

  test('all = true overrides individual false', () => {
    const config = makeConfig({ all: true, tui_review: false });
    expect(isFeatureEnabled('tui_review', config)).toBe(true);
  });

  test('LAZY_VANILLA=1 disables all features', () => {
    process.env.LAZY_VANILLA = '1';
    const config = makeConfig({ tui_review: true, all: true });
    expect(isFeatureEnabled('tui_review', config)).toBe(false);
    expect(isFeatureEnabled('anything', config)).toBe(false);
  });

  test('LAZY_VANILLA=0 does not disable features', () => {
    process.env.LAZY_VANILLA = '0';
    const config = makeConfig({ tui_review: true });
    expect(isFeatureEnabled('tui_review', config)).toBe(true);
  });

  test('LAZY_VANILLA unset does not disable features', () => {
    delete process.env.LAZY_VANILLA;
    const config = makeConfig({ tui_review: true });
    expect(isFeatureEnabled('tui_review', config)).toBe(true);
  });

  test('default config has empty features', () => {
    expect(DEFAULT_CONFIG.features).toEqual({});
  });
});

describe('getKnownFeatures', () => {
  test('returns an array', () => {
    expect(Array.isArray(getKnownFeatures())).toBe(true);
  });

  test('contains only strings', () => {
    for (const f of getKnownFeatures()) {
      expect(typeof f).toBe('string');
    }
  });

  test('is in alphabetical order (critical for prompt caching)', () => {
    const features = getKnownFeatures();
    const sorted = [...features].sort();
    expect(features).toEqual(sorted);
  });
});

describe('isKnownFeature', () => {
  test('returns false for unknown flag names', () => {
    expect(isKnownFeature('nonexistent_flag')).toBe(false);
  });
});

describe('getUnknownFlags', () => {
  test('returns empty for config with no features', () => {
    expect(getUnknownFlags(makeConfig({}))).toEqual([]);
  });

  test('returns unknown flag names', () => {
    const config = makeConfig({ stale_flag: true, another_stale: true });
    const unknown = getUnknownFlags(config);
    expect(unknown).toContain('stale_flag');
    expect(unknown).toContain('another_stale');
  });

  test('excludes "all" from unknown flags', () => {
    const config = makeConfig({ all: true, stale_flag: true });
    const unknown = getUnknownFlags(config);
    expect(unknown).not.toContain('all');
    expect(unknown).toContain('stale_flag');
  });
});

describe('getEnabledFeaturesPromptSnippet', () => {
  const originalEnv = process.env.LAZY_VANILLA;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LAZY_VANILLA;
    } else {
      process.env.LAZY_VANILLA = originalEnv;
    }
  });

  test('returns empty string when no features configured', () => {
    expect(getEnabledFeaturesPromptSnippet(makeConfig({}))).toBe('');
  });

  test('returns empty string when LAZY_VANILLA=1', () => {
    process.env.LAZY_VANILLA = '1';
    expect(getEnabledFeaturesPromptSnippet(makeConfig({ all: true }))).toBe('');
  });

  test('returns snippet listing known features when all=true', () => {
    // With all=true and known features, the snippet lists them
    const snippet = getEnabledFeaturesPromptSnippet(makeConfig({ all: true }));
    expect(snippet).toContain('auto_sync_after_turn');
  });
});
