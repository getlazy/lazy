/**
 * Unit tests for maintained-file skip detection and rendering — the inverse of
 * protected-file violation detection (see permissions.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectSkippedMaintainEntries,
  renderMaintainContext,
} from '../../src/supervisor/maintain';
import { loadConfig } from '../../src/config/loader';
import { findUnknownConfigKeys } from '../../src/config/schema';
import type { MaintainEntry } from '../../src/config/types';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function getSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD');
}

const DOCS: MaintainEntry = {
  title: 'docs',
  pattern: 'docs/**/*',
  instructions: 'Update docs affected by your work.',
};
const CHANGELOG: MaintainEntry = {
  title: 'changelog',
  pattern: 'CHANGELOG.md',
  instructions: 'Add a line describing your work.',
};

describe('detectSkippedMaintainEntries', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lazy-maintain-test-'));
    git(repoDir, 'init');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');
    writeFileSync(join(repoDir, 'README.md'), '# Project\n');
    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'api.md'), '# API\n');
    writeFileSync(join(repoDir, 'CHANGELOG.md'), '# Changelog\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Initial commit');
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(repoDir, { recursive: true, force: true });
  });

  // INVARIANT: No maintained groups configured → nothing to check.
  test('returns no skipped entries when no maintain groups configured', async () => {
    const sha = getSha(repoDir);
    const result = await detectSkippedMaintainEntries(repoDir, sha, sha, []);
    expect(result.skipped).toEqual([]);
    expect(result.turnHadChanges).toBe(false);
  });

  // INVARIANT: A no-op turn (zero changes) is never nagged about maintained files.
  test('skips the whole check when the turn produced no changes', async () => {
    const sha = getSha(repoDir);
    const result = await detectSkippedMaintainEntries(repoDir, sha, sha, [DOCS, CHANGELOG]);
    expect(result.turnHadChanges).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  // INVARIANT: A group whose files the turn DID touch is satisfied — not skipped.
  test('does not flag a group whose files were touched (committed)', async () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'src.ts'), 'export const x = 1;\n');
    writeFileSync(join(repoDir, 'docs', 'api.md'), '# API v2\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Work + docs');
    const endSha = getSha(repoDir);

    const result = await detectSkippedMaintainEntries(repoDir, startSha, endSha, [DOCS, CHANGELOG]);
    expect(result.turnHadChanges).toBe(true);
    // docs touched → only changelog is skipped
    expect(result.skipped.map(e => e.title)).toEqual(['changelog']);
  });

  // INVARIANT: A group the turn did NOT touch (while making other changes) is skipped.
  test('flags a maintained group the turn ignored', async () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'src.ts'), 'export const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Code only');
    const endSha = getSha(repoDir);

    const result = await detectSkippedMaintainEntries(repoDir, startSha, endSha, [DOCS, CHANGELOG]);
    expect(result.turnHadChanges).toBe(true);
    expect(result.skipped.map(e => e.title).sort()).toEqual(['changelog', 'docs']);
  });

  // INVARIANT: Committed-only — mirrors detectViolations. An UNCOMMITTED edit to
  // a maintained file does NOT count as touched: it won't land on the parent
  // branch, so the agent should still be nudged (to actually commit it).
  test('uncommitted edits to a maintained file do NOT satisfy the group', async () => {
    const startSha = getSha(repoDir);
    // Commit a code change so the turn has committed work...
    writeFileSync(join(repoDir, 'src.ts'), 'export const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Code');
    const endSha = getSha(repoDir);
    // ...and leave an UNCOMMITTED edit to a maintained file (won't land).
    writeFileSync(join(repoDir, 'CHANGELOG.md'), '# Changelog\n- did work\n');

    const result = await detectSkippedMaintainEntries(repoDir, startSha, endSha, [CHANGELOG]);
    expect(result.turnHadChanges).toBe(true);
    expect(result.skipped.map(e => e.title)).toEqual(['changelog']); // uncommitted → still nudged
  });

  // INVARIANT: A turn with no committed changes is a no-op — uncommitted working
  // tree state alone never triggers the check (it won't land on the branch).
  test('uncommitted-only changes are treated as a no-op turn', async () => {
    const sha = getSha(repoDir);
    writeFileSync(join(repoDir, 'scratch.ts'), 'export const y = 2;\n');

    const result = await detectSkippedMaintainEntries(repoDir, sha, sha, [DOCS]);
    expect(result.turnHadChanges).toBe(false);
    expect(result.skipped).toEqual([]);
  });
});

describe('maintain rendering', () => {
  test('renderMaintainContext is empty when there are no groups', () => {
    expect(renderMaintainContext([])).toBe('');
    expect(renderMaintainContext(undefined)).toBe('');
  });

  test('renderMaintainContext lists titles, patterns, and instructions', () => {
    const out = renderMaintainContext([DOCS, CHANGELOG]);
    expect(out).toContain('docs (docs/**/*): Update docs affected by your work.');
    expect(out).toContain('changelog (CHANGELOG.md): Add a line describing your work.');
  });

});

describe('automation.maintain config parsing', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-maintain-cfg-'));
    delete process.env.LAZY_CONFIG;
  });

  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: maintain is opt-in — the default config ships an empty list.
  test('defaults to an empty maintain list when unconfigured', async () => {
    await writeFile(join(dir, 'lazy.toml'), 'models.default = "sonnet"\n');
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.automation.maintain).toEqual([]);
  });

  // INVARIANT: [[automation.maintain]] array-of-tables parses into MaintainEntry[].
  test('parses [[automation.maintain]] entries with title/pattern/instructions', async () => {
    const toml = `
[[automation.maintain]]
title = "docs"
pattern = "docs/**/*"
instructions = "Update affected docs."

[[automation.maintain]]
title = "changelog"
pattern = "CHANGELOG.md"
instructions = "Add a line; skip if intra-release."
`;
    await writeFile(join(dir, 'lazy.toml'), toml);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.automation.maintain).toEqual([
      { title: 'docs', pattern: 'docs/**/*', instructions: 'Update affected docs.' },
      { title: 'changelog', pattern: 'CHANGELOG.md', instructions: 'Add a line; skip if intra-release.' },
    ]);
  });

  // INVARIANT: doctor must not warn about the known [automation] section / maintain key.
  test('findUnknownConfigKeys does not flag automation.maintain', () => {
    const raw = { automation: { maintain: [{ title: 't', pattern: 'p', instructions: 'i' }] } };
    expect(findUnknownConfigKeys(raw)).toEqual([]);
  });
});
