import { test, expect } from 'bun:test';
import { resolveConfigText } from '../../src/config/loader';

for (const backend of ['in-repo', 'orphan-branch', 'postgres']) {
  test(`Teams overrides ${backend} storage while solo projects still require migration`, () => {
    const names = ['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', 'LAZY_TEST_FORCE_MANAGED'];
    const saved = names.map(name => process.env[name]);
    try {
      delete process.env.LAZY_TEST_FORCE_MANAGED;
      process.env.LAZY_MANAGED = '1';
      process.env.LAZY_MANAGED_STORAGE_PATH = '/fleet/store';
      const text = `[storage]\nbackend = "${backend}"\nexternal_path = "/author/store"\n`;
      const config = resolveConfigText(text, '/project/lazy.toml', { install: false });
      // INVARIANT: a Teams project's committed storage settings cannot select or prevent use of the fleet-assigned store.
      expect(config.storage.backend).toBe('external');
      expect(config.storage.external_path).toBe('/fleet/store');
      delete process.env.LAZY_MANAGED;
      expect(() => resolveConfigText(text, '/project/lazy.toml', { install: false })).toThrow(`Storage backend "${backend}"`);
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
      });
    }
  });
}
