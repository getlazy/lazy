/**
 * The lazy checkout stage copies a MODULE GRAPH, and this is the scan that keeps
 * the two in agreement.
 *
 * The daemon image's `lazy-checkout` stage (which the self-host image copies)
 * copies a deliberately
 * narrow set of paths and then, in the same stage, runs
 * `bun run src/index.ts system source-id --write`. Bun resolves the whole CLI
 * module graph to do that, so anything `src/` imports from OUTSIDE `src/` must
 * have been copied — otherwise the image fails to build at that line.
 *
 * That is not hypothetical: the image shipped unbuildable because
 * `src/server/styles.ts` imports `design/industry/styles.css` as text and
 * `design/` was in nobody's COPY list. No test could see it — the import is
 * valid, the file exists in the repo, and every suite runs against the full
 * tree. It failed only when somebody built the image, which is the one thing
 * CI here does not do.
 */

import { describe, test, expect } from 'bun:test';
import { Glob } from 'bun';
import { join, dirname, resolve, relative } from 'path';

const repoRoot = resolve(import.meta.dir, '..', '..');
const srcDir = join(repoRoot, 'src');
// There is ONE checkout stage. There used to be two — the self-host image built
// its own — and they drifted: the daemon image shipped with the same missing
// stylesheet a week after the self-host image was fixed, and failed its first
// `lazy --version` on real hardware (run 20260920-081830). The self-host image
// now copies the daemon image's checkout instead; the last describe below keeps
// it from growing a second one again.
const DOCKERFILES: { label: string; path: string }[] = [
  { label: 'daemon image', path: join(repoRoot, 'lazy-teams', 'deploy', 'daemon-image', 'Dockerfile') },
];
const TEAMS_DOCKERFILE = join(repoRoot, 'lazy-teams', 'deploy', 'Dockerfile');

/**
 * Paths the stage does NOT copy and does not need to, each with the reason it
 * is nonetheless resolvable when the RUN line executes.
 *
 * Keyed by path, never by directory: a blanket exemption would hide the next
 * genuinely-missing file underneath it.
 */
const PROVIDED_BY_THE_RUN_LINE: { path: string; why: string }[] = [
  {
    path: 'lazy-agent',
    why: 'gitignored and .dockerignored; the same RUN line creates the placeholder via `bun run ensure:agent-placeholder` before any import resolves it',
  },
];

/** The source paths of every COPY in the `lazy-checkout` stage. */
async function checkoutStageCopies(dockerfile: string): Promise<string[]> {
  const text = await Bun.file(dockerfile).text();
  const start = text.indexOf('AS lazy-checkout');
  expect(start).toBeGreaterThan(-1);
  // The stage ends at the next FROM, so a COPY belonging to the runtime image
  // can never be miscounted as satisfying an import in this one.
  const rest = text.slice(start);
  const end = rest.indexOf('\nFROM ');
  const stage = end === -1 ? rest : rest.slice(0, end);

  const copies: string[] = [];
  for (const line of stage.split('\n')) {
    const m = line.match(/^\s*COPY\s+(.+)$/);
    if (!m) continue;
    const args = m[1]!.trim().split(/\s+/).filter((a) => !a.startsWith('--'));
    // The last argument is the destination inside the image.
    copies.push(...args.slice(0, -1));
  }
  expect(copies.length).toBeGreaterThan(0);
  return copies;
}

/** Resolve a relative import the way bun does, returning a repo-relative path. */
async function resolveTarget(fromFile: string, spec: string): Promise<string | null> {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts')];
  for (const c of candidates) {
    if (await Bun.file(c).exists()) return relative(repoRoot, c);
  }
  // A specifier that resolves to nothing is a different bug and not this
  // scan's to report — the type-checker owns it.
  return null;
}

/** Every path outside `src/` that `src/` imports, with the file that imports it. */
async function escapingImports(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for await (const rel of new Glob('**/*.ts').scan({ cwd: srcDir })) {
    const file = join(srcDir, rel);
    const text = await Bun.file(file).text();
    // Covers `import x from '…'`, `export … from '…'` and the
    // `with { type: 'text' }` asset imports, which is the shape that broke.
    const specs = [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const abs = resolve(dirname(file), spec);
      if (abs.startsWith(`${srcDir}/`)) continue;
      const target = await resolveTarget(file, spec);
      if (!target) continue;
      if (!out.has(target)) out.set(target, []);
      out.get(target)!.push(`src/${rel}`);
    }
  }
  return out;
}

function isCopied(target: string, copies: string[]): boolean {
  return copies.some((c) => target === c || target.startsWith(`${c}/`));
}

describe.each(DOCKERFILES)('the $label copies what src imports', ({ path: dockerfile }) => {
  // INVARIANT: every path `src/` imports from outside `src/` is copied into the
  // `lazy-checkout` stage, or is created by that stage's own RUN line. The
  // stage runs the CLI to compute the source fingerprint, so a missing path is
  // not a latent problem — it is a build failure at that line, discovered only
  // by building the image.
  test('no import escapes src/ without being in the checkout stage', async () => {
    const copies = await checkoutStageCopies(dockerfile);
    const escaping = await escapingImports();
    expect(escaping.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [target, importers] of escaping) {
      if (isCopied(target, copies)) continue;
      if (PROVIDED_BY_THE_RUN_LINE.some((p) => p.path === target)) continue;
      missing.push(`${target} (imported by ${importers.join(', ')})`);
    }

    expect(missing).toEqual([]);
  });

  // The proof that the scan can fail: drop the design stylesheet's COPY and the
  // import that broke the image must be reported again. Without this, a scan
  // that silently stopped finding anything would read as a pass forever.
  test('the scan reports a path once its COPY is removed', async () => {
    const copies = (await checkoutStageCopies(dockerfile)).filter((c) => !c.includes('design/'));
    const escaping = await escapingImports();

    const missing = [...escaping.keys()].filter(
      (t) => !isCopied(t, copies) && !PROVIDED_BY_THE_RUN_LINE.some((p) => p.path === t),
    );

    expect(missing).toContain('design/industry/styles.css');
  });

  // An exemption whose reason has expired is worse than no exemption: it is a
  // claim nobody re-checks. If a path here becomes copied, delete the entry.
  test('every run-line exemption is still uncopied', async () => {
    const copies = await checkoutStageCopies(dockerfile);
    for (const { path } of PROVIDED_BY_THE_RUN_LINE) {
      expect(isCopied(path, copies)).toBe(false);
    }
  });
});

describe('the self-host image builds no lazy checkout of its own', () => {
  // INVARIANT: lazy is built once per release. The self-host image copies its
  // checkout (and bun) out of the daemon image named by LAZY_DAEMON_IMAGE, so
  // the app and the daemons it launches cannot run different lazy bytes, and
  // the module-graph COPY list above exists in exactly one place.
  test('takes /lazy from the daemon image and never runs bun install', async () => {
    const text = await Bun.file(TEAMS_DOCKERFILE).text();
    expect(text).toMatch(/^ARG LAZY_DAEMON_IMAGE=$/m);
    // A global ARG: it must come before the first FROM to be usable in one.
    expect(text.indexOf('ARG LAZY_DAEMON_IMAGE=')).toBeLessThan(text.search(/^FROM /m));
    expect(text).toMatch(/^FROM \$\{LAZY_DAEMON_IMAGE\} AS lazy-daemon$/m);
    expect(text).toContain('COPY --from=lazy-daemon --chown=rails:rails /opt/lazy /lazy');
    expect(text).toContain('COPY --from=lazy-daemon /usr/local/bin/bun /usr/local/bin/bun');
    expect(text).not.toMatch(/^RUN .*bun install/m);
    expect(text).not.toMatch(/^COPY src /m);
    expect(text).not.toContain('bun.sh/install');
    // And it proves the copied lazy runs here, as rails, from the baked id.
    expect(text).toMatch(/^RUN gosu rails bun run \/lazy\/src\/index\.ts system source-id --json .*baked/m);
  });

  // INVARIANT: the fingerprint RollsFleet compares is written by lazy itself,
  // never by a hand-rolled shell pipeline (src/utils/source-id.ts). The
  // assertion is scoped to the fingerprint's subject — the lazy-checkout stage,
  // plus any RUN that mentions the source id or fingerprint — because other
  // stages legitimately use hash tools for something else entirely (verifying
  // pinned checksums of downloaded release tarballs), and banning the tool
  // image-wide made that unrelated verification trip this rule.
  test('the daemon image bakes the fingerprint with lazy, not a pipeline', async () => {
    const text = await Bun.file(DOCKERFILES[0]!.path).text();
    const HASH_TOOL = /\b(sha\d*sum|md5sum|shasum|b2sum|openssl\s+dgst)\b/;

    const start = text.search(/^FROM .* AS lazy-checkout$/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = text.slice(start + 1).search(/^FROM /m);
    const stage = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
    expect(stage).toContain('bun run src/index.ts system source-id --write');
    expect(stage).not.toMatch(HASH_TOOL);

    // Anywhere in the image, a RUN (continuations joined) that touches the
    // source id or fingerprint must not reach for a hash tool.
    const runs = text.replace(/\\\n/g, ' ').split('\n').filter((l) => l.startsWith('RUN '));
    const fingerprintRuns = runs.filter((r) => /source-id|fingerprint/i.test(r));
    expect(fingerprintRuns.length).toBeGreaterThan(0);
    for (const run of fingerprintRuns) {
      expect(run).not.toMatch(HASH_TOOL);
    }
  });
});
