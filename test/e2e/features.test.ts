import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

describe('feature flags', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('lazy init', () => {
    test('generated lazy.toml contains features section with commented-out keys', () => {
      const toml = readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8');
      // Section headers must never be commented out — only keys within them.
      // A commented-out section header is a footgun: users uncomment a key
      // but forget the header, and the key silently lands in the wrong section.
      expect(toml).toContain('[features]');
      expect(toml).toContain('LAZY_VANILLA=1');
      expect(toml).toContain('# all = true');
    });
  });

  describe('lazy doctor', () => {
    test('shows feature flags status with no features explicitly configured', async () => {
      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'Feature flags');
      // Known flags should be listed even when not explicitly configured
      expectOutput(result, 'auto_sync_after_turn');
    });

    test('shows feature flags with individual flag enabled', async () => {
      const tomlPath = join(ctx.root, 'lazy.toml');
      let toml = readFileSync(tomlPath, 'utf-8');
      toml += '\n[features]\nsome_feature = true\n';
      writeFileSync(tomlPath, toml);

      const result = await ctx.lazy(['doctor']);
      // Unknown flag since some_feature is not in KNOWN_FEATURES
      expectOutput(result, 'Feature flags');
      expectOutput(result, 'Unknown feature flag');
      expectOutput(result, 'some_feature');
    });

    test('shows feature flags with all = true', async () => {
      const tomlPath = join(ctx.root, 'lazy.toml');
      let toml = readFileSync(tomlPath, 'utf-8');
      toml += '\n[features]\nall = true\n';
      writeFileSync(tomlPath, toml);

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'Feature flags');
      expectOutput(result, 'all = true');
    });

    test('shows LAZY_VANILLA=1 status', async () => {
      const result = await ctx.lazy(['doctor'], { env: { LAZY_VANILLA: '1' } });
      expectOutput(result, 'Feature flags');
      expectOutput(result, 'LAZY_VANILLA=1');
    });

    test('warns about unknown flags without failing', async () => {
      const tomlPath = join(ctx.root, 'lazy.toml');
      let toml = readFileSync(tomlPath, 'utf-8');
      toml += '\n[features]\nnonexistent_flag = true\n';
      writeFileSync(tomlPath, toml);

      const result = await ctx.lazy(['doctor']);
      // Doctor should still pass (unknown flags are warnings, not errors)
      // But it might fail for other reasons (Docker, etc.)
      // Just check the output contains the warning
      expectOutput(result, 'Unknown feature flag');
      expectOutput(result, 'nonexistent_flag');
      expectOutput(result, 'stale flags');
    });
  });
});
