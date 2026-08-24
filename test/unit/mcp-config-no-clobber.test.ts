/**
 * SECURITY INVARIANT (fix-cursor-security-musts §2): lazy MERGES its entry into
 * the user's real MCP/permission config files on host-process runs. A malformed
 * one used to be swallowed (`catch { config = {} }`) and replaced wholesale,
 * silently deleting every other MCP server and every permission the user had —
 * a destructive edit with no copy to restore from.
 *
 * Per CLAUDE.md's "found but broken" rule: missing falls through to defaults,
 * present-and-unparseable is an error the human must see. `prepareTurnMcp` fails
 * the turn on a config-write error, so throwing surfaces properly.
 *
 * These tests must never be relaxed into "recovers by rewriting the file".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeMcpConfig, writeCursorMcpConfig, writeToolPermissions } from '../../src/mcp/config';

const SERVER = { command: 'lazy-agent', args: ['mcp', '--task-id', 't1'] };

describe('user MCP config is never clobbered', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-mcp-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(home, { recursive: true, force: true });
  });

  const cases: Array<{
    label: string;
    path: () => string;
    prepare?: () => Promise<void>;
    run: () => Promise<void>;
  }> = [
    {
      label: '~/.claude.json',
      path: () => join(home, '.claude.json'),
      run: () => writeMcpConfig(SERVER),
    },
    {
      label: '~/.cursor/mcp.json',
      path: () => join(home, '.cursor', 'mcp.json'),
      prepare: async () => { await mkdir(join(home, '.cursor'), { recursive: true }); },
      run: () => writeCursorMcpConfig(SERVER),
    },
    {
      label: '~/.claude/settings.json',
      path: () => join(home, '.claude', 'settings.json'),
      prepare: async () => { await mkdir(join(home, '.claude'), { recursive: true }); },
      run: () => writeToolPermissions(['lazy_search']),
    },
  ];

  for (const c of cases) {
    test(`${c.label}: malformed JSON fails loudly and leaves the file untouched`, async () => {
      await c.prepare?.();
      const broken = '{ "mcpServers": { "other": { "command": "x" } }, ';  // truncated
      await writeFile(c.path(), broken);

      await expect(c.run()).rejects.toThrow(/is not valid JSON/);
      // The user's bytes are still there — nothing was overwritten.
      expect(await readFile(c.path(), 'utf-8')).toBe(broken);
    });

    test(`${c.label}: the error names the path and a remedy`, async () => {
      await c.prepare?.();
      await writeFile(c.path(), 'not json at all');
      await expect(c.run()).rejects.toThrow(c.path());
      await expect(c.run()).rejects.toThrow(/Refusing to overwrite/);
    });

    test(`${c.label}: a missing file still falls through to defaults`, async () => {
      await c.prepare?.();
      await c.run();
      const written = JSON.parse(await readFile(c.path(), 'utf-8'));
      expect(written).toBeDefined();
    });
  }

  test('a valid file keeps every other entry when lazy merges in', async () => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ someSetting: true, mcpServers: { other: { command: 'other' } } }),
    );
    await writeMcpConfig(SERVER);
    const merged = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8'));
    expect(merged.someSetting).toBe(true);
    expect(merged.mcpServers.other.command).toBe('other');
    expect(merged.mcpServers.lazy.command).toBe('lazy-agent');
  });
});
