/**
 * The self-host image's checkout stage copies a MODULE GRAPH, and this is the
 * scan that keeps the two in agreement.
 *
 * `lazy-teams/deploy/Dockerfile`'s `lazy-checkout` stage copies a deliberately
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
// Both checkout stages copy the same module graph and must not drift apart: the
// daemon image (the image a project daemon runs in inside its VM) shipped with
// the same missing stylesheet a week after the self-host image was fixed, and
// failed its first `lazy --version` on real hardware (run 20260920-081830).
const DOCKERFILES: { label: string; path: string }[] = [
  { label: 'self-host image', path: join(repoRoot, 'lazy-teams', 'deploy', 'Dockerfile') },
  { label: 'daemon image', path: join(repoRoot, 'lazy-teams', 'deploy', 'daemon-image', 'Dockerfile') },
];

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
