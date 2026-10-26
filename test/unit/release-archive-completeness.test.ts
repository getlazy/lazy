import { describe, test, expect } from 'bun:test';
import { readFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { tmpdir } from 'os';

/**
 * Guards what the PUBLIC release archive contains against silent drift.
 *
 * scripts/release.sh publishes an archive built from two sources: files that
 * match a pattern in .releaseinclude (via `git archive`), plus a hand-listed set
 * of GENERATED modules copied in afterwards because they are gitignored. The
 * public repo ships neither generator nor dev scripts, and its `prepare` hook
 * deliberately no-ops (`test -f scripts/generate-version.ts || true`), so
 * anything the archive omits is simply absent on public main — where every
 * import of it fails to resolve.
 *
 * Nothing in the dev repo notices: the dev checkout has all the generated
 * modules and every script, so `tsc --noEmit` and the release script's own
 * sanity build both pass. That blind spot published a public main failing
 * typecheck with four TS2307 errors (fix-release-archive-typecheck): the
 * generator grew build-info.ts and prompts-bundle.ts without release.sh's copy
 * step following, and test/unit/version-string.test.ts shipped while the
 * scripts/version-string.ts it imports did not.
 *
 * These tests are the dev-repo canary for that whole class of drift.
 */

const ROOT = join(import.meta.dir, '..', '..');

async function readRepoFile(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), 'utf-8');
}

/** Non-comment, non-blank patterns, exactly as release.sh parses them. */
function parseReleaseInclude(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

/** Repo-relative paths a generator writes into src/, e.g. `src/version.ts`. */
function parseGeneratedOutputs(source: string): string[] {
  // Both generators address their output as join(root, 'src', '<name>.ts').
  // Restricted to .ts so the prompt generator's join(root, 'src', 'prompts')
  // — an input DIRECTORY it reads, not a file it writes — is not counted.
  return [...source.matchAll(/join\(\s*root\s*,\s*'src'\s*,\s*'([^']+\.ts)'\s*\)/g)].map(m => m[1]);
}

/** The GENERATED_SRC_FILES=(...) array release.sh copies into the archive. */
function parseReleaseShGeneratedList(script: string): string[] {
  const m = script.match(/^GENERATED_SRC_FILES=\(([^)]*)\)/m);
  if (!m) throw new Error('release.sh no longer declares GENERATED_SRC_FILES=(...)');
  return m[1].split(/\s+/).filter(Boolean);
}

describe('release archive completeness', () => {
  // INVARIANT: the published archive must run the build bootstrap before dependencies exist. A working dev checkout cannot prove that build resources ship.
  test('the public archive runs the build preflight and refuses an unsupported Bun before installing', async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), 'lazy-release-build-'));
    try {
      const patterns = parseReleaseInclude(await readRepoFile('.releaseinclude'));
      const archive = Bun.spawn(['git', 'archive', '--format=tar', 'HEAD', '--', ...patterns], {
        cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
      });
      const unpack = Bun.spawn(['tar', '-xf', '-', '-C', archiveRoot], {
        stdin: archive.stdout, stdout: 'pipe', stderr: 'pipe',
      });
      const [archiveError, unpackError, archiveCode, unpackCode] = await Promise.all([
        new Response(archive.stderr).text(), new Response(unpack.stderr).text(), archive.exited, unpack.exited,
      ]);
      expect({ archiveCode, archiveError, unpackCode, unpackError }).toEqual({
        archiveCode: 0, archiveError: '', unpackCode: 0, unpackError: '',
      });
      const check = Bun.spawn([process.execPath, 'run', 'scripts/build-entry.ts', 'check'], {
        cwd: archiveRoot, stdout: 'pipe', stderr: 'pipe',
      });
      const checkError = await new Response(check.stderr).text();
      expect({ code: await check.exited, stderr: checkError }).toEqual({ code: 0, stderr: '' });

      // An intentionally unavailable pin exercises package-script ordering without downloading tools or running a build.
      await writeFile(join(archiveRoot, '.bun-version'), '99.0.0\n');
      const mise = join(archiveRoot, 'mise');
      await writeFile(mise, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      for (const entry of ['build', 'install:local']) {
        const build = Bun.spawn([process.execPath, 'run', entry], {
          cwd: archiveRoot,
          env: { ...process.env, PATH: `${archiveRoot}:${dirname(process.execPath)}`, HOME: archiveRoot },
          stdout: 'pipe', stderr: 'pipe',
        });
        const output = await new Response(build.stderr).text();
        expect(await build.exited).toBe(1);
        expect(output).toContain('Cannot build lazy:');
        expect(output).toContain('requires Bun 99.0.0');
        expect(output).not.toContain('generate:version');
        expect(output).not.toContain('tsc.js');
        expect(await Bun.file(join(archiveRoot, 'node_modules/typescript/lib/tsc.js')).exists()).toBe(false);
      }
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  /**
   * INVARIANT: every module the version generator writes into src/ must appear
   * in release.sh's GENERATED_SRC_FILES, because `git archive` cannot carry a
   * gitignored file and the public repo has no generator to recreate it.
   *
   * If this fails you added (or renamed) a generated module — add it to
   * GENERATED_SRC_FILES in scripts/release.sh. Do NOT relax this test: the
   * failure it reports is a public main that will not compile.
   */
  test('every generated src/ module is copied into the archive by release.sh', async () => {
    const generated = new Set([
      ...parseGeneratedOutputs(await readRepoFile('scripts/generate-version.ts')),
      ...parseGeneratedOutputs(await readRepoFile('scripts/generate-prompt-bundle.ts')),
    ]);

    // Sanity: the parse found something. An empty set would make this test pass
    // vacuously forever if the generators were ever restructured.
    expect(generated.size).toBeGreaterThanOrEqual(3);
    expect([...generated].sort()).toEqual(['build-info.ts', 'prompts-bundle.ts', 'version.ts']);

    const copied = parseReleaseShGeneratedList(await readRepoFile('scripts/release.sh'));
    expect([...copied].sort()).toEqual([...generated].sort());
  });

  /**
   * INVARIANT: the generated modules must be FORCE-added in the public repo.
   * The archive ships .gitignore, which lists all three, so a plain `git add -A`
   * silently drops them and the publish commit omits the very files the copy
   * step just placed.
   */
  test('release.sh force-adds the generated modules when committing the publish', async () => {
    const script = await readRepoFile('scripts/release.sh');
    expect(script).toContain('GENERATED_ADD_PATHS+=("src/$GENERATED_FILE")');
    expect(script).toMatch(/git add -A && git add -f "\$\{GENERATED_ADD_PATHS\[@\]\}"/);
  });

  /**
   * INVARIANT: release.sh typechecks the ASSEMBLED ARCHIVE before publishing.
   * Its other sanity checks run against the dev checkout, where the missing
   * files exist — which is exactly why a broken public main shipped unnoticed.
   */
  test('release.sh typechecks the assembled archive before publishing', async () => {
    const script = await readRepoFile('scripts/release.sh');
    expect(script).toContain('bun run typecheck');
    // The typecheck must come AFTER the archive is assembled, not before, and
    // must run in the archive copy rather than the dev checkout.
    expect(script).toMatch(/cd "\$TYPECHECK_DIR" && bun run typecheck/);
    expect(script.indexOf('bun run typecheck')).toBeGreaterThan(
      script.indexOf('GENERATED_SRC_FILES=(')
    );
  });

  /**
   * INVARIANT: every relative import in a shipped file must resolve to a path
   * that is itself shipped — either matched by a .releaseinclude pattern or
   * copied in as a generated module.
   *
   * .releaseinclude ships all of `test/**` but only named files from `scripts/`,
   * so a test importing a scripts/ helper ships an import with no target. That
   * is how test/unit/version-string.test.ts came to reference a missing
   * scripts/version-string.ts on public main.
   */
  test('every relative import in a shipped file resolves to a shipped file', async () => {
    const patterns = parseReleaseInclude(await readRepoFile('.releaseinclude'));
    const globs = patterns.map(p => new Bun.Glob(p));
    const generatedCopied = new Set(
      parseReleaseShGeneratedList(await readRepoFile('scripts/release.sh')).map(f => `src/${f}`)
    );

    /**
     * Root placeholder for `import ... with { type: 'file' }` in
     * src/capture/claude.ts. Gitignored and never archived, but package.json's
     * `prepare` hook (`ensure:agent-placeholder`) recreates it on `bun install`
     * in the public repo exactly as it does here — so it is present where it
     * needs to be, without being shipped.
     */
    const CREATED_BY_PREPARE = new Set(['lazy-agent']);

    const isShipped = (relPath: string): boolean =>
      generatedCopied.has(relPath) ||
      CREATED_BY_PREPARE.has(relPath) ||
      globs.some(g => g.match(relPath));

    const tracked = (
      await new Response(
        Bun.spawn(['git', 'ls-files'], { cwd: ROOT, stdout: 'pipe' }).stdout
      ).text()
    )
      .split('\n')
      .filter(Boolean);

    const shippedSources = tracked.filter(f => isShipped(f) && /\.(ts|tsx)$/.test(f));
    // Sanity: the allowlist really does ship a large source tree. A near-empty
    // list would make this check pass without examining anything.
    expect(shippedSources.length).toBeGreaterThan(100);

    // Static imports/exports, `import(...)`, and require(...) — the preload uses
    // require() to reach scripts/, so a static-import-only scan would miss it.
    const specifierRe =
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]*)['"]/g;
    const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.md', '.json', '/index.ts'];

    const missing: string[] = [];

    for (const file of shippedSources) {
      const source = await readFile(join(ROOT, file), 'utf-8');
      for (const match of source.matchAll(specifierRe)) {
        const target = resolve(join(ROOT, dirname(file)), match[1]);
        const resolved = CANDIDATE_SUFFIXES.map(s => `${target}${s}`).find(
          candidate => existsSync(candidate)
        );
        // Unresolvable in the DEV repo too — not this test's concern; the
        // ordinary typecheck already fails on it.
        if (!resolved) continue;

        const relPath = relative(ROOT, resolved);
        if (!isShipped(relPath)) missing.push(`${file} imports ${match[1]} -> ${relPath}`);
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * The two scripts/ helpers the shipped test tree needs. Named explicitly so
   * the failure message says what to do, rather than surfacing only as one line
   * in the broader import-resolution check above.
   */
  test('.releaseinclude ships the scripts/ helpers the shipped tests import', async () => {
    const patterns = parseReleaseInclude(await readRepoFile('.releaseinclude'));
    // test/unit/version-string.test.ts imports it directly.
    expect(patterns).toContain('scripts/version-string.ts');
    // test/preload-generate.ts (bunfig's preload, so it runs before EVERY test
    // in the public repo) require()s it; without it `bun test` cannot start.
    expect(patterns).toContain('scripts/generate-prompt-bundle.ts');
  });

  /**
   * INVARIANT: operators following public-docs/self-hosting-lazy-teams.md must
   * find lazy-teams/deploy/ in a lazy release tarball — not only in the dev repo.
   */
  test('.releaseinclude ships the lazy-teams self-host deploy bundle', async () => {
    const patterns = parseReleaseInclude(await readRepoFile('.releaseinclude'));
    expect(patterns).toContain('lazy-teams/deploy/**');
  });
});
