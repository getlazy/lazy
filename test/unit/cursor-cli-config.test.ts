/**
 * ~/.cursor/cli-config.json must gain network.useHttp1ForAgent WITHOUT
 * clobbering anything else in it.
 *
 * On a host-process run this is the USER's real cursor CLI config, so a
 * replace-instead-of-merge here would silently delete their settings (CLAUDE.md:
 * no hidden destructive side effects; "found but broken" must surface).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureCursorHttp1Config, cursorCliConfigPath } from '../../src/agent/cursor-cli-config';

describe('ensureCursorHttp1Config', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'lazy-cursor-cfg-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const read = () => JSON.parse(readFileSync(cursorCliConfigPath(), 'utf-8'));

  test('creates the file when absent', async () => {
    expect(await ensureCursorHttp1Config()).toBe(true);
    expect(read()).toEqual({ network: { useHttp1ForAgent: true } });
  });

  test('merges into an existing config, preserving unrelated keys', async () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      cursorCliConfigPath(),
      JSON.stringify({ editor: 'vim', network: { someOtherSetting: 7 } }),
    );

    expect(await ensureCursorHttp1Config()).toBe(true);
    expect(read()).toEqual({
      editor: 'vim',
      network: { someOtherSetting: 7, useHttp1ForAgent: true },
    });
  });

  test('is a no-op (and reports no change) when already set', async () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(cursorCliConfigPath(), JSON.stringify({ network: { useHttp1ForAgent: true } }));
    expect(await ensureCursorHttp1Config()).toBe(false);
  });

  // "Found but broken" is an error the human must see — overwriting would
  // delete whatever else they had configured, with no copy to restore from.
  test('refuses to overwrite a malformed config', async () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(cursorCliConfigPath(), '{not json');
    await expect(ensureCursorHttp1Config()).rejects.toThrow(/not valid JSON/);
  });
});
