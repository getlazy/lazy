/**
 * Unit tests for reactive-automation match detection and rendering — fires when
 * a turn's commits TOUCH a configured pattern (inverse of maintain.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectMatchedReactEntries,
  renderReactContext,
} from '../../src/supervisor/react';
import { loadConfig } from '../../src/config/loader';
import { findUnknownConfigKeys } from '../../src/config/schema';
import type { ReactEntry } from '../../src/config/types';

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

const UI: ReactEntry = {
  title: 'take-UI-snapshots',
  pattern: 'src/ui/**/*',
  instructions: 'Screenshot the screens you changed.',
};
const API_DOCS: ReactEntry = {
  title: 'regen-openapi',
  pattern: 'src/api/**/*',
  instructions: 'Regenerate the OpenAPI spec.',
};

describe('detectMatchedReactEntries', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lazy-react-test-'));
    git(repoDir, 'init');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');
    writeFileSync(join(repoDir, 'README.md'), '# Project\n');
    mkdirSync(join(repoDir, 'src', 'ui'), { recursive: true });
    mkdirSync(join(repoDir, 'src', 'api'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'ui', 'page.tsx'), 'export const Page = () => null;\n');
    writeFileSync(join(repoDir, 'src', 'api', 'routes.ts'), 'export const routes = [];\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Initial commit');
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(repoDir, { recursive: true, force: true });
  });

  // INVARIANT: No react groups configured → nothing to check.
  test('returns no matched entries when no react groups configured', async () => {
    const sha = getSha(repoDir);
    const result = await detectMatchedReactEntries(repoDir, sha, sha, []);
    expect(result.matched).toEqual([]);
    expect(result.turnHadChanges).toBe(false);
  });

  // INVARIANT: A no-op turn never triggers reactive automations.
  test('skips the whole check when the turn produced no changes', async () => {
    const sha = getSha(repoDir);
    const result = await detectMatchedReactEntries(repoDir, sha, sha, [UI, API_DOCS]);
    expect(result.turnHadChanges).toBe(false);
    expect(result.matched).toEqual([]);
  });

  // INVARIANT: A group whose files the turn DID touch is matched.
  test('flags a react group whose files were touched', async () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'src', 'ui', 'page.tsx'), 'export const Page = () => "v2";\n');
    writeFileSync(join(repoDir, 'other.ts'), 'export const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'UI change');
    const endSha = getSha(repoDir);

    const result = await detectMatchedReactEntries(repoDir, startSha, endSha, [UI, API_DOCS]);
    expect(result.turnHadChanges).toBe(true);
    expect(result.matched.map(e => e.title)).toEqual(['take-UI-snapshots']);
  });

  // INVARIANT: A group the turn did NOT touch is not matched (inverse of maintain).
  test('does not flag a react group the turn ignored', async () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'other.ts'), 'export const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Unrelated');
    const endSha = getSha(repoDir);

    const result = await detectMatchedReactEntries(repoDir, startSha, endSha, [UI, API_DOCS]);
    expect(result.turnHadChanges).toBe(true);
    expect(result.matched).toEqual([]);
  });

  // INVARIANT: Multiple groups can match the same turn.
  test('flags every react group the turn touched', async () => {
    const startSha = getSha(repoDir);
    writeFileSync(join(repoDir, 'src', 'ui', 'page.tsx'), 'export const Page = () => "v2";\n');
    writeFileSync(join(repoDir, 'src', 'api', 'routes.ts'), 'export const routes = ["a"];\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'UI + API');
    const endSha = getSha(repoDir);

    const result = await detectMatchedReactEntries(repoDir, startSha, endSha, [UI, API_DOCS]);
    expect(result.matched.map(e => e.title)).toEqual(['take-UI-snapshots', 'regen-openapi']);
  });
});

describe('renderReactContext', () => {
  // INVARIANT: Empty / undefined config leaves the system prompt unchanged.
  test('returns empty string when no entries', () => {
    expect(renderReactContext(undefined)).toBe('');
    expect(renderReactContext([])).toBe('');
  });

  test('includes titles, patterns, and instructions', () => {
    const text = renderReactContext([UI]);
    expect(text).toContain('Reactive automations');
    expect(text).toContain('take-UI-snapshots');
    expect(text).toContain('src/ui/**/*');
    expect(text).toContain('Screenshot the screens you changed.');
  });
});

describe('automation.react config parsing', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-react-cfg-'));
    delete process.env.LAZY_CONFIG;
  });

  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: react is opt-in — the default config ships an empty list.
  test('defaults to an empty react list when unconfigured', async () => {
    await writeFile(join(dir, 'lazy.toml'), 'models.default = "sonnet"\n');
    const config = await loadConfig(dir);
    expect(config.automation.react).toEqual([]);
  });

  // INVARIANT: [[automation.react]] array-of-tables parses into ReactEntry[].
  test('parses [[automation.react]] entries with title/pattern/instructions', async () => {
    const toml = `
[[automation.react]]
title = "take-UI-snapshots"
pattern = "src/ui/**/*"
instructions = "Screenshot changed screens."

[[automation.react]]
title = "regen-openapi"
pattern = "src/api/**/*"
instructions = "Regenerate the OpenAPI spec."
`;
    await writeFile(join(dir, 'lazy.toml'), toml);
    const config = await loadConfig(dir);
    expect(config.automation.react).toEqual([
      { title: 'take-UI-snapshots', pattern: 'src/ui/**/*', instructions: 'Screenshot changed screens.' },
      { title: 'regen-openapi', pattern: 'src/api/**/*', instructions: 'Regenerate the OpenAPI spec.' },
    ]);
  });

  // INVARIANT: doctor must not warn about the known automation.react key.
  test('findUnknownConfigKeys does not flag automation.react', () => {
    const raw = { automation: { react: [{ title: 't', pattern: 'p', instructions: 'i' }] } };
    expect(findUnknownConfigKeys(raw)).toEqual([]);
  });

  // INVARIANT: malformed react entries fail at loadConfig, not mid-supervisor
  // after the work phase already committed (Bun.Glob would throw on a bad pattern
  // object; missing fields would surface even later).
  test('rejects a react entry missing instructions', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      '[[automation.react]]\ntitle = "x"\npattern = "src/**/*"\n',
    );
    await expect(loadConfig(dir)).rejects.toThrow(/\[\[automation\.react\]\].*instructions/i);
  });

  test('rejects a react entry with empty title', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      '[[automation.react]]\ntitle = ""\npattern = "src/**/*"\ninstructions = "do it"\n',
    );
    await expect(loadConfig(dir)).rejects.toThrow(/\[\[automation\.react\]\].*title/i);
  });
});
