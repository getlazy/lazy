/**
 * The released binary must not contain lazy's prompt test seams.
 *
 * LAZY_FORCE_TTY, LAZY_PROMPT_DEFAULTS and LAZY_PROMPT_SECRET together are a
 * complete non-interactive route to any prompt — including the approval
 * passphrase `lazy accept` demands on a protected merge. In the tree they have
 * to keep working (that is how accept's protected prompt is e2e-tested), so the
 * guard that protects users lives in the BUILD: `scripts/build.ts` passes
 * `--define LAZY_RELEASE_BUILD=true --minify-syntax`, which folds every seam
 * branch in src/cli/editor.ts to a constant and eliminates it. A runtime check
 * would be one an agent could satisfy too; a removed branch cannot be.
 *
 * These tests are the drift guard for that arrangement, from both ends: the
 * build still passes the flags, and the flags still actually remove the code.
 *
 * Both ENDS also means both BUILDERS. `scripts/build.ts` is what a local
 * `bun run build` runs, but the binaries a user actually downloads are compiled
 * by .github/workflows/build.yml, which deliberately does not route through that
 * script — it calls `bun build --compile` itself. The flags are therefore
 * duplicated, and the workflow half is checked PER INVOCATION below: a
 * whole-file grep would be satisfied by one hardened step sitting next to one
 * bare step, which is precisely the state that ships an unhardened binary.
 */
import { describe, test, expect } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const projectRoot = join(import.meta.dir, '..', '..');
const workflowsDir = join(projectRoot, '.github', 'workflows');

/** Every environment variable that must not survive into a released binary. */
const PROMPT_SEAMS = ['LAZY_FORCE_TTY', 'LAZY_PROMPT_DEFAULTS', 'LAZY_PROMPT_SECRET'];

async function bundleEditor(release: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(projectRoot, 'src', 'cli', 'editor.ts')],
    target: 'bun',
    minify: { syntax: true, whitespace: false, identifiers: false },
    ...(release ? { define: { LAZY_RELEASE_BUILD: 'true' } } : {}),
  });
  expect(result.success).toBe(true);
  const js = result.outputs.find((o) => o.path.endsWith('.js'));
  expect(js).toBeDefined();
  return await js!.text();
}

/**
 * Every `bun build` command line in a GitHub workflow, one string per
 * invocation. Shell comments are dropped and backslash continuations are joined,
 * so a flag on a continuation line still counts as part of its invocation.
 */
function bunBuildInvocations(yaml: string): string[] {
  const joined = yaml
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')
    .replace(/\\\n/g, ' ');
  return joined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /(^|[\s'"(])bun\s+build\b/.test(line));
}

describe('release build strips the prompt test seams', () => {
  // INVARIANT: the seams are ABSENT from a released binary, not merely disabled.
  // A runtime "am I released?" check is something an agent can satisfy too.
  test('the release bundle contains no read of a prompt seam variable', async () => {
    const bundled = await bundleEditor(true);
    for (const seam of PROMPT_SEAMS) {
      expect(bundled).not.toContain(seam);
    }
  });

  // The other half: without the define the seams must still be there, or the
  // test above would pass for the wrong reason (e.g. someone deleted them).
  test('a source build keeps the seams so tests can still drive prompts', async () => {
    const bundled = await bundleEditor(false);
    for (const seam of PROMPT_SEAMS) {
      expect(bundled).toContain(seam);
    }
  });

  // INVARIANT: --define alone is not enough. On bun 1.4.0 it folds the constant
  // but KEEPS the branch; --minify-syntax is what removes it. Dropping either
  // flag from scripts/build.ts silently reopens the env route in the binary.
  test('scripts/build.ts passes both the define and --minify-syntax', async () => {
    const script = await readFile(join(projectRoot, 'scripts', 'build.ts'), 'utf-8');
    expect(script).toContain('LAZY_RELEASE_BUILD=true');
    expect(script).toContain('--minify-syntax');
  });

  // INVARIANT: the CI workflow compiles the binaries users download, and it does
  // so itself rather than through scripts/build.ts — so hardening the script
  // alone hardens nothing that ships. Asserted per invocation, across every
  // workflow: a new compile step added anywhere under .github/workflows is
  // caught the same way, and one bare step next to one hardened step fails here
  // instead of shipping.
  test('every `bun build --compile` in CI carries both hardening flags', async () => {
    const files = (await readdir(workflowsDir)).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    let compiles = 0;
    for (const file of files) {
      const yaml = await readFile(join(workflowsDir, file), 'utf-8');
      for (const invocation of bunBuildInvocations(yaml)) {
        // A non-compiling `bun build` produces no shipped artifact (e.g. the
        // bundle-only sanity check in scripts/release.sh), so it needs nothing.
        if (!invocation.includes('--compile')) continue;
        compiles++;
        expect(`${file}: ${invocation}`).toContain('--define LAZY_RELEASE_BUILD=true');
        expect(`${file}: ${invocation}`).toContain('--minify-syntax');
      }
    }

    // Both binaries — the host CLI and the cross-compiled Linux agent — or the
    // loop above passed by finding nothing to check.
    expect(compiles).toBeGreaterThanOrEqual(2);
  });

  // The parser earns its keep only if it can tell the two cases apart; without
  // this, a bug that returned [] would make the guard above vacuous for a real
  // regression while still satisfying the count.
  test('the per-invocation parser fails a bare step beside a hardened one', () => {
    const yaml = [
      '        run: |',
      '          bun build --compile --define LAZY_RELEASE_BUILD=true --minify-syntax a.ts',
      '          bun build --compile b.ts',
      '          # bun build --compile commented.ts',
    ].join('\n');

    const invocations = bunBuildInvocations(yaml);
    expect(invocations.length).toBe(2);
    expect(invocations.filter((i) => i.includes('--minify-syntax')).length).toBe(1);
  });
});
