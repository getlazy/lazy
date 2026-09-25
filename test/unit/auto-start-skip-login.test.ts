import { describe, expect, test } from 'bun:test';
import { SKIP_AUTO_START } from '../../src/daemon/auto-start';

describe('daemon auto-start skip list', () => {
  // INVARIANT: `lazy login` / `lazy logout` never auto-start a local daemon.
  // They run in an unbound checkout — after a store handover, one whose
  // lazy.toml still names the store Lazy Teams now owns — and a local daemon
  // there is a second writer on that store. ensureDaemon is bypassed under
  // LAZY_TEST, so the set itself is what the suite can check.
  test('login and logout are skipped', () => {
    expect(SKIP_AUTO_START.has('login')).toBe(true);
    expect(SKIP_AUTO_START.has('logout')).toBe(true);
  });
});
