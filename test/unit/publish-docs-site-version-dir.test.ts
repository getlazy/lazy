/**
 * The root-copy refresh in scripts/publish-docs-site.sh must never delete the
 * version directory the same run just wrote.
 *
 * INVARIANT: the guard that spares `vMAJOR.MINOR/` from the root refresh must
 * behave identically on macOS and Linux. It once used `find -regex`, whose
 * DIALECT is platform-dependent: BSD find (macOS) defaults to BASIC regex,
 * where `+` is a literal plus, so `v[0-9]+\.[0-9]+` does NOT match `v0.22`;
 * GNU find (Linux, CI) defaults to Emacs regex, where it does. The version
 * directory was therefore deleted one line before the commit on macOS only —
 * and the run still printed "Published", so docs.getlazy.dev served a root
 * copy with every version-pinned URL 404ing.
 *
 * These tests run the real script region against a temp tree. Do not rewrite
 * the guard back to a `find` regex, and do not "simplify" `[0-9][0-9]*` back to
 * `[0-9]+` inside one.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'publish-docs-site.sh');

/**
 * Extract the root-refresh loop from the real script and run it standalone, so
 * the test exercises the shipped code rather than a copy that can drift.
 */
function rootRefreshSnippet(): string {
  const src = readFileSync(SCRIPT, 'utf-8');
  const start = src.indexOf('  shopt -s dotglob');
  const end = src.indexOf('  shopt -u dotglob');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + '  shopt -u dotglob'.length);
}

describe('publish-docs-site.sh root refresh', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pds-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed() {
    const pub = join(dir, 'pages');
    for (const v of ['v0.9', 'v0.21', 'v0.22']) {
      await mkdir(join(pub, v, 'troubleshooting'), { recursive: true });
      await writeFile(join(pub, v, 'troubleshooting', 'index.html'), `<h1>${v}</h1>`);
    }
    await mkdir(join(pub, '.git'), { recursive: true });
    await writeFile(join(pub, '.git', 'HEAD'), 'ref: refs/heads/gh-pages\n');
    await mkdir(join(pub, 'blog'), { recursive: true });
    await writeFile(join(pub, 'blog', 'index.html'), 'stale root copy');
    await writeFile(join(pub, 'index.html'), 'stale root copy');
    await writeFile(join(pub, 'CNAME'), 'docs.getlazy.dev');
    return pub;
  }

  function runRefresh(pub: string) {
    const result = spawnSyncUnsupervised(
      ['bash', '-c', `set -euo pipefail\nPUB_DIR="${pub}"\n${rootRefreshSnippet()}`],
      { timeout: 15_000 },
    );
    expect(result.exitCode).toBe(0);
  }

  test('every version directory survives the root refresh', async () => {
    const pub = await seed();
    runRefresh(pub);

    const left = (await readdir(pub)).sort();
    // The version directories and .git survive; stale root content is gone.
    expect(left).toEqual(['.git', 'v0.21', 'v0.22', 'v0.9']);

    // ...and they survive with their CONTENT, not as empty husks.
    const inner = await readdir(join(pub, 'v0.22', 'troubleshooting'));
    expect(inner).toEqual(['index.html']);
  });

  test('the guard does not depend on the platform find(1)', () => {
    // Comments are stripped first: the fix's own comment NAMES `find -regex` as
    // the trap, and that explanation must not trip the check it explains.
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    // `find -regex` is the trap: its dialect differs between BSD and GNU, and
    // `find -E` would only invert the breakage onto Linux. Matched WITHOUT
    // anchoring to `find` on the same line — the original bug wrote `-regex` on
    // a backslash continuation, which a same-line pattern silently misses.
    expect(code).not.toMatch(/-regex\b/);
    expect(code).not.toMatch(/find\s+-E\b/);
  });
});
