import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  NEUTRAL_CREDENTIAL_STORE,
  CONTAINER_CREDENTIAL_STORE,
  builderClaudeConfigPath,
  mergeBuilderClaudeConfig,
  resolveBuilderClaudeConfigBase,
  writeNeutralCredentialStore,
} from '../../src/builder/claude-home';

describe('builder claude home', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-claude-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('neutral credential store', () => {
    // INVARIANT: the builder authenticates from the daemon credential in its
    // env, and the container must NOT see a usable claudeAiOauth record on disk.
    // Claude Code's 401-recovery path adopts a differing stored access token by
    // overwriting process.env.CLAUDE_CODE_OAUTH_TOKEN — with the human's real
    // (stale) store mounted, one transient 401 permanently replaced the good
    // daemon credential and stranded the builder in a /login loop. The store
    // must parse cleanly and yield no record.
    test('the store parses and has no claudeAiOauth record', () => {
      const parsed = JSON.parse(NEUTRAL_CREDENTIAL_STORE);
      expect(parsed).toEqual({});
      expect(parsed.claudeAiOauth).toBeUndefined();
    });

    test('shadows exactly the credential file, not the whole ~/.claude mount', () => {
      // A deeper, more-specific bind than `-v $HOME/.claude:/home/user/.claude`,
      // so settings/commands/agents/plugins stay shared.
      expect(CONTAINER_CREDENTIAL_STORE).toBe('/home/user/.claude/.credentials.json');
      expect(CONTAINER_CREDENTIAL_STORE.startsWith('/home/user/.claude/')).toBe(true);
    });

    test('writes a per-builder file so concurrent builders do not share one', async () => {
      const a = await writeNeutralCredentialStore(dir, 'aaaaaaaa');
      const b = await writeNeutralCredentialStore(dir, 'bbbbbbbb');
      expect(a).not.toBe(b);
      expect(await readFile(a, 'utf-8')).toBe(NEUTRAL_CREDENTIAL_STORE);
      expect(await readFile(b, 'utf-8')).toBe(NEUTRAL_CREDENTIAL_STORE);
    });
  });

  describe('mergeBuilderClaudeConfig', () => {
    test('injects the lazy MCP entry and preserves everything else', () => {
      const merged = mergeBuilderClaudeConfig(
        { theme: 'dark', hasCompletedOnboarding: true, mcpServers: { other: { command: 'x' } } },
        ['mcp', '--daemon-config', '/tmp/d.json'],
      );
      expect(merged.theme).toBe('dark');
      expect(merged.hasCompletedOnboarding).toBe(true);
      expect(merged.mcpServers).toEqual({
        other: { command: 'x' },
        lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', '/tmp/d.json'] },
      });
    });

    // The daemon config path changes between launches, so the lazy entry must be
    // rewritten every time rather than inherited from the persisted file.
    test('overwrites a stale lazy entry', () => {
      const merged = mergeBuilderClaudeConfig(
        { mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', '/old.json'] } } },
        ['mcp', '--daemon-config', '/new.json'],
      );
      expect((merged.mcpServers as any).lazy.args).toEqual(['mcp', '--daemon-config', '/new.json']);
    });
  });

  describe('resolveBuilderClaudeConfigBase', () => {
    const noWarn = () => {};

    test('seeds from the host config on first launch', async () => {
      const host = join(dir, 'host.json');
      await writeFile(host, JSON.stringify({ theme: 'dark' }));
      const base = await resolveBuilderClaudeConfigBase(join(dir, 'missing.json'), host, noWarn);
      expect(base).toEqual({ theme: 'dark' });
    });

    // INVARIANT: once the builder has its own config, the persisted copy is
    // authoritative. Re-seeding from the host would discard the onboarding,
    // folder-trust and model answers Claude Code wrote inside the container —
    // exactly the state the per-launch temp file used to throw away.
    test('the persisted config outranks the host config once it exists', async () => {
      const host = join(dir, 'host.json');
      const persisted = join(dir, 'persisted.json');
      await writeFile(host, JSON.stringify({ theme: 'dark', from: 'host' }));
      await writeFile(persisted, JSON.stringify({ theme: 'light', from: 'builder' }));
      const base = await resolveBuilderClaudeConfigBase(persisted, host, noWarn);
      expect(base).toEqual({ theme: 'light', from: 'builder' });
    });

    test('both absent yields an empty base', async () => {
      const base = await resolveBuilderClaudeConfigBase(
        join(dir, 'a.json'), join(dir, 'b.json'), noWarn,
      );
      expect(base).toEqual({});
    });

    test('a corrupt persisted config warns and falls back to the host', async () => {
      const host = join(dir, 'host.json');
      const persisted = join(dir, 'persisted.json');
      await writeFile(host, JSON.stringify({ from: 'host' }));
      await writeFile(persisted, '{not json');
      const warnings: string[] = [];
      const base = await resolveBuilderClaudeConfigBase(persisted, host, (m) => warnings.push(m));
      expect(base).toEqual({ from: 'host' });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(persisted);
    });

    test('a non-object config is rejected rather than spread', async () => {
      const persisted = join(dir, 'persisted.json');
      await writeFile(persisted, '[1,2,3]');
      const warnings: string[] = [];
      const base = await resolveBuilderClaudeConfigBase(persisted, join(dir, 'no.json'), (m) => warnings.push(m));
      expect(base).toEqual({});
      expect(warnings[0]).toContain('not a JSON object');
    });

    test('an unreadable file warns rather than throwing', async () => {
      // A directory at the config path surfaces EISDIR, not ENOENT — the
      // "exists but broken" case, which must be reported, not silently ignored.
      const persisted = join(dir, 'persisted.json');
      await mkdir(persisted);
      const warnings: string[] = [];
      const base = await resolveBuilderClaudeConfigBase(persisted, join(dir, 'no.json'), (m) => warnings.push(m));
      expect(base).toEqual({});
      expect(warnings.length).toBe(1);
    });
  });

  test('builderClaudeConfigPath is stable across calls', () => {
    expect(builderClaudeConfigPath('/p/.lazy')).toBe('/p/.lazy/builder-claude-config.json');
    expect(builderClaudeConfigPath('/p/.lazy')).toBe(builderClaudeConfigPath('/p/.lazy'));
  });
});
