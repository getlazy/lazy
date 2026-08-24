/**
 * Unit tests for config keys lazy has REMOVED outright
 * (DEPRECATED_SECTION_KEYS in src/config/schema.ts, applied by the loader).
 *
 * The one entry today is `[protection] passphrase_file`. What matters is that a
 * human who still has it in lazy.toml is TOLD — a removed key silently ignored
 * is the "gate believed armed but isn't" failure protection must never have —
 * and that they are told the right thing, not "unknown option".
 */

import { describe, test, beforeEach, afterEach, expect, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findDeprecatedConfigKeys,
  findUnknownConfigKeys,
  DEPRECATED_SECTION_KEYS,
  KNOWN_CONFIG_SCHEMA,
} from '../../src/config/schema';
import {
  loadConfig,
  resetRemovedKeyDeprecationWarnings,
  getDefaultConfigTemplate,
} from '../../src/config/loader';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('removed config keys', () => {
  test('protection.passphrase_file is removed from the schema, not still known', () => {
    expect(KNOWN_CONFIG_SCHEMA.protection).not.toContain('passphrase_file');
    expect(DEPRECATED_SECTION_KEYS['protection.passphrase_file']).toContain(
      'lazy system passphrase set',
    );
  });

  test('findDeprecatedConfigKeys finds it only when present', () => {
    expect(findDeprecatedConfigKeys({ protection: { enabled: true } })).toEqual([]);
    expect(findDeprecatedConfigKeys({ protection: { passphrase_file: '.lazy/x' } })).toEqual([
      'protection.passphrase_file',
    ]);
  });

  // INVARIANT: a removed key gets its migration message, never the generic
  // "Unknown config option" — which sends the human hunting for a typo when the
  // real answer is "that moved, here is where".
  test('a removed key is not reported as an unknown option', () => {
    const warnings = findUnknownConfigKeys({
      protection: { enabled: true, passphrase_file: '.lazy/approve-passphrase' },
    });
    expect(warnings.join('\n')).not.toContain('passphrase_file');

    // A genuinely unknown key in the same section still is.
    const unknown = findUnknownConfigKeys({ protection: { nonsense_key: 1 } });
    expect(unknown.join('\n')).toContain("Unknown config option 'protection.nonsense_key'");
  });

  describe('at load time', () => {
    let root: string;
    let warnings: string[];
    let restoreWarn: () => void;
    let unpinConfig: () => void;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'deprecated-keys-'));
      // Without this, loadConfig walks UP from cwd — which under `bun test` is
      // lazy's OWN worktree — and reads the developer's real lazy.toml.
      unpinConfig = pinConfig(root);
      warnings = [];
      const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });
      restoreWarn = () => spy.mockRestore();
      resetRemovedKeyDeprecationWarnings();
    });

    afterEach(async () => {
      restoreWarn();
      unpinConfig();
      resetRemovedKeyDeprecationWarnings();
      await rm(root, { recursive: true, force: true });
    });

    async function writeConfig(body: string): Promise<void> {
      await writeFile(join(root, 'lazy.toml'), body);
    }

    test('warns once, names the new command, and points at lazy doctor', async () => {
      await writeConfig(
        '[protection]\nenabled = true\npassphrase_file = ".lazy/approve-passphrase"\n',
      );

      await loadConfig(root);
      expect(warnings.join('\n')).toContain('lazy system passphrase set');
      expect(warnings.join('\n')).toContain('lazy doctor');
      expect(warnings.filter((w) => w.includes('passphrase_file')).length).toBe(1);

      // One-shot per process, like the [checks] warning — a second load in the
      // same process must not re-spam it.
      await loadConfig(root);
      expect(warnings.filter((w) => w.includes('passphrase_file')).length).toBe(1);
    });

    // INVARIANT: the key is not merely unread, it is STRIPPED. deepMerge copies
    // keys it does not know about, so leaving it on the resolved config would
    // keep a stray second source of truth for the gate's key.
    test('the removed key never reaches the resolved config', async () => {
      await writeConfig('[protection]\nenabled = true\npassphrase_file = "/tmp/mine"\n');

      const config = await loadConfig(root);
      expect(config.protection.enabled).toBe(true);
      expect('passphrase_file' in (config.protection as Record<string, unknown>)).toBe(false);
    });

    test('a config without the key loads silently', async () => {
      await writeConfig('[protection]\nenabled = true\n');

      await loadConfig(root);
      expect(warnings.join('\n')).not.toContain('passphrase_file');
    });

    // The template lazy init writes must not reintroduce what we just removed.
    test('the generated lazy.toml template carries no passphrase_file key', () => {
      const template = getDefaultConfigTemplate();
      expect(template).not.toContain('passphrase_file');
      expect(template).toContain('lazy system passphrase set');
    });
  });
});
