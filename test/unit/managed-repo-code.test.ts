/**
 * Repository code on a managed host: what runs, what never does, and a guard
 * that makes the next such path classify itself.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { loadProxyRequestPlugins, listRepositoryPluginFiles, proxyPluginDir } from '../../src/proxy/plugins/loader';
import { REPOSITORY_CODE_PATHS } from '../../src/config/managed-repo-code';

const REPO = join(import.meta.dir, '..', '..');

describe('repository plugins are never loaded', () => {
  let root: string;
  let marker: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-managed-plugins-'));
    marker = join(root, 'imported.marker');
    await mkdir(proxyPluginDir(root), { recursive: true });
    // An observable side effect at IMPORT time — the moment that matters, since
    // module top-level code runs in the daemon before any shape check.
    await writeFile(
      join(proxyPluginDir(root), `side-effect-${Date.now()}.ts`),
      `import { writeFileSync } from 'fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
        `export default { name: 'side-effect', transformRequest: () => null };\n`,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function markerExists(): Promise<boolean> {
    return stat(marker).then(() => true, () => false);
  }

  // INVARIANT: lazy never imports repository plugin code, in any mode — it
  // would run inside lazy's own process on the host, and the repository is code
  // an agent can write and get accepted (engineer, 2026-10-10: "accept or no
  // accept"). The loader does not even read the directory.
  test('the loader never imports a repository plugin by default', async () => {
    const plugins = await loadProxyRequestPlugins(root);
    expect(plugins).toEqual([]);
    expect(await markerExists()).toBe(false);
  });

  test('the loading mechanism still works when a test opts in', async () => {
    const plugins = await loadProxyRequestPlugins(root, { enabled: true });
    expect(plugins.map((p) => p.name)).toEqual(['side-effect']);
    expect(await markerExists()).toBe(true);
  });

  test('listRepositoryPluginFiles names the files without importing them', async () => {
    const files = await listRepositoryPluginFiles(root);
    expect(files.length).toBe(1);
    expect(await markerExists()).toBe(false);
  });
});

// INVARIANT: a regular FILE at .lazy/plugins (or any unreadable entry) never
// breaks the default loader path — nothing is read, so repository content
// cannot stop the daemon's proxy from starting. The listing used for messages
// does throw, and both of its callers (daemon startup, doctor) catch it.
test('a file at .lazy/plugins does not break the default loader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-plugins-file-'));
  try {
    await mkdir(join(dir, '.lazy'), { recursive: true });
    await writeFile(join(dir, '.lazy', 'plugins'), 'not a directory');
    expect(await loadProxyRequestPlugins(dir)).toEqual([]);
    await expect(listRepositoryPluginFiles(dir)).rejects.toThrow(/plugin directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// INVARIANT: no production caller opts into loading repository plugins. The
// `enabled` option exists for tests of the mechanism only.
test('no src/ caller passes the opt-in to the plugin loader', async () => {
  const offenders: string[] = [];
  for (const file of await walk(join(REPO, 'src'))) {
    const text = await readFile(file, 'utf8');
    if (/(?<!function )loadProxyRequestPlugins\([^)]*enabled/.test(text)) offenders.push(relative(REPO, file));
  }
  expect(offenders).toEqual([]);
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

describe('every repository-code path is classified', () => {
  // INVARIANT: any src/ file that dynamically imports a computed specifier is a
  // way for code from disk to run in the daemon process, and must be listed in
  // REPOSITORY_CODE_PATHS with a disposition. An unlisted one is a path nobody
  // decided about.
  test('dynamic imports of non-literal specifiers are classified', async () => {
    const classified = new Set(
      REPOSITORY_CODE_PATHS.filter((p) => p.inProcessImport).map((p) => p.sourceFile),
    );
    const unclassified: string[] = [];
    // `import(` / `require(` whose argument is not a plain string literal: an
    // identifier/expression, or a template literal that interpolates.
    const computed = /\b(?:import|require)\(\s*(?:[^'"`\s)]|`[^`]*\$\{)/;
    for (const file of await walk(join(REPO, 'src'))) {
      const text = await readFile(file, 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (computed.test(code)) {
        const rel = relative(REPO, file);
        if (!classified.has(rel)) unclassified.push(rel);
      }
    }
    expect(unclassified).toEqual([]);
  });

  test('the guard recognises computed specifiers', () => {
    const computed = /\b(?:import|require)\(\s*(?:[^'"`\s)]|`[^`]*\$\{)/;
    expect(computed.test('await import(href)')).toBe(true);
    expect(computed.test('await import(`${dir}/x.ts`)')).toBe(true);
    expect(computed.test('require(path)')).toBe(true);
    expect(computed.test("await import('./x')")).toBe(false);
    expect(computed.test('await import(`./x`)')).toBe(false);
  });

  // INVARIANT: no path is classified as running on the daemon's host. Code a
  // task branch can influence never runs there (engineer, 2026-10-10); the type
  // union says so too, but a union can be widened silently.
  test('every disposition is not-run or contained', () => {
    for (const p of REPOSITORY_CODE_PATHS) {
      expect(['not-run', 'contained']).toContain(p.managed);
    }
  });

  // INVARIANT: lazy's runner for configured shell commands is imported only
  // under src/supervisor/, which runs inside the task or gate container. Any
  // other importer would run a configured command — and the branch-written
  // scripts it resolves — on the daemon's host. The accept check did exactly
  // that until 2026-10-10.
  test('only the supervisor imports the configured-command runner', async () => {
    const offenders: string[] = [];
    for (const file of await walk(join(REPO, 'src'))) {
      const rel = relative(REPO, file);
      if (rel.startsWith('src/supervisor/')) continue;
      const text = await readFile(file, 'utf8');
      if (/\brunTurnHookCommand\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('every classified source file exists', async () => {
    for (const p of REPOSITORY_CODE_PATHS) {
      expect(await stat(join(REPO, p.sourceFile)).then(() => true, () => false)).toBe(true);
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });
});
