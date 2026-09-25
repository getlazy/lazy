import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CODEX_PINNED_VERSION } from '../../src/agent/codex-packaging';

const ROOT = join(import.meta.dir, '..', '..');
const DOCKERFILE = join(ROOT, 'Dockerfile.lazy');

/** File content, or null when the file is not in this checkout. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`failed to read ${path}: ${String(err)}`);
  }
}

/**
 * `test/**` ships in the public release; `Dockerfile.lazy` does not
 * (`.releaseinclude` does not match it). So in a clone of the published repo the
 * subject of this guard is absent, and a hard failure there would be a red suite
 * nobody who sees it can fix — it gates on presence, and says so, because a skip
 * is not a pass. Same shape as test/unit/dockerfile-ruby-version.test.ts.
 */
const dockerfile = await readIfPresent(DOCKERFILE);
if (dockerfile === null) {
  console.log(
    'skipped: Dockerfile.lazy is not in this checkout (it does not ship in a public release) ' +
      '— nothing to compare',
  );
}

/**
 * INVARIANT: the image installs BOTH codex binaries, from the ONE pinned release.
 *
 * `codex-code-mode-host` is a separate release asset, and it is not optional.
 * When the model a turn runs on declares `tool_mode = "code_mode_only"` — which
 * the ChatGPT subscription backend's default model does — codex routes every
 * tool call through that helper, spawning it BY NAME from its own directory.
 * With only `codex` installed, a task authenticated, reached the model, and then
 * died on `failed to spawn code-mode host
 * /home/user/.local/bin/codex-code-mode-host: No such file or directory`,
 * having read no file and called no tool. That is the whole failure: the image
 * looked fine, `codex --version` worked, and every codex task was useless.
 *
 * The version coupling is the other half. The two binaries are one program split
 * across two files and handshake on a versioned protocol, so a mixed pair fails
 * at RUNTIME, inside a turn, rather than at build time.
 *
 * This file exists because `Dockerfile.lazy` keeps its own hand-written copy of
 * the install step that `CodexPackaging.dockerInstallCommand()` generates for
 * everyone else — the original bug was in both copies at once.
 */
/**
 * The Dockerfile with COMMENT lines removed.
 *
 * Every assertion below reads this, not the raw file. The comment above the
 * install step explains at length why both binaries are needed and names them —
 * so matching the raw file, this guard passed against a Dockerfile that had been
 * edited back down to installing one. A test that its own documentation
 * satisfies is worse than no test.
 */
const instructions = (dockerfile ?? '')
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n');

describe.skipIf(dockerfile === null)('Dockerfile.lazy codex install', () => {
  test('installs the code-mode host alongside the CLI', () => {
    expect(
      instructions,
      'Dockerfile.lazy installs `codex` without `codex-code-mode-host`. A codex task will ' +
        'authenticate and then fail to run a single tool — see this file\'s header.',
    ).toContain('codex-code-mode-host');
  });

  test('every codex release URL names the pinned version', () => {
    const versions = [...instructions.matchAll(/openai\/codex\/releases\/download\/rust-v([0-9][^/"\s]*)/g)]
      .map(m => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(
        { version, pinned: CODEX_PINNED_VERSION },
        'Dockerfile.lazy downloads a codex release that CODEX_PINNED_VERSION does not name. ' +
          'The CLI and its code-mode host must come from the same release.',
      ).toEqual({ version: CODEX_PINNED_VERSION, pinned: CODEX_PINNED_VERSION });
    }
  });

  // Both tarballs contain a single arch-suffixed file, so each needs a rename to
  // the bare name codex looks for. An unrenamed `codex-code-mode-host-<triple>`
  // is present on disk and still not found — the same failure, one step later.
  test('the arch-suffixed tarball entry is renamed to a bare name', () => {
    // `mv <path>-<arch suffix> <path>`, in either the looped or the spelled-out
    // form. What matters is that a rename happens at all; which spelling the
    // step uses is not this guard's business.
    expect(
      /mv\s+"[^"]*\$\{?triple\}?"\s+"[^"]*"/.test(instructions),
      'Dockerfile.lazy downloads the codex tarballs but never renames the arch-suffixed ' +
        'entries to the bare names codex spawns by.',
    ).toBe(true);
  });

  // The names must be the ones codex actually looks for. This is the assertion
  // that fails if a future edit installs, say, only `codex` in the loop.
  test('the install step names both binaries', () => {
    for (const bin of ['codex', 'codex-code-mode-host']) {
      // Standalone token: `codex` must be named in its own right, so a match
      // inside `codex-code-mode-host` does not count for it.
      const named = new RegExp(`(?<![\\w-])${bin}(?![\\w-])`).test(instructions);
      expect({ bin, named }, `Dockerfile.lazy never names ${bin}`).toEqual({ bin, named: true });
    }
  });
});
