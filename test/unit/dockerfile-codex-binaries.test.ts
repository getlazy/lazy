import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CODEX_INSTALL_HINT, CodexPackaging } from '../../src/agent/codex-packaging';

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
 * INVARIANT: the image installs BOTH codex binaries, from the ONE release.
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

  test('the release tag is resolved once and every download names it', () => {
    expect(instructions.match(/openai\/codex\/releases\/latest/g)?.length).toBe(1);
    const urls = [...instructions.matchAll(/openai\/codex\/releases\/download\/([^/"\s]+)/g)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const tag of urls) {
      expect(
        tag,
        'Dockerfile.lazy downloads a codex release other than the one resolved once as $tag. ' +
          'The CLI and its code-mode host must come from the same release.',
      ).toBe('$tag');
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

// INVARIANT: every Codex download is checked against the sha256 digest the same release
// publishes before it is extracted. Codex is deliberately unpinned ("latest"), so the
// checksum is the only thing between a tampered asset and the runner image.
describe('codex downloads are checksum-verified', () => {
  const sources: Record<string, string> = {
    'CODEX_INSTALL_HINT': CODEX_INSTALL_HINT,
    'dockerInstallCommand()': new CodexPackaging().dockerInstallCommand(),
    ...(dockerfile === null ? {} : { 'Dockerfile.lazy': instructions }),
  };
  for (const [name, text] of Object.entries(sources)) {
    test(name, () => {
      expect(text).toContain('sha256sum -c');
      expect(text).toContain('startswith("sha256:")');
      expect(text, 'curl must not pipe straight into tar').not.toMatch(/curl[^\n]*\|\s*tar/);
    });
  }
});

// INVARIANT: the install hint FAILS when a download does not match its
// published digest. It used to `|| break` out of its loop, which exits 0, so
// a human pasting it saw success with no codex installed.
describe('the codex install hint fails on a checksum mismatch', () => {
  const tools = ['jq', 'sha256sum', 'bash'].every(t => Bun.which(t));
  test.skipIf(!tools)('exits non-zero', async () => {
    const { mkdtemp, writeFile, chmod, rm, mkdir } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'lazy-codex-hint-'));
    try {
      const bin = join(dir, 'bin');
      await mkdir(bin);
      await mkdir(join(dir, '.local', 'bin'), { recursive: true });
      // A fake curl: the latest tag, a release whose digests match nothing,
      // and an asset download with arbitrary bytes.
      await writeFile(join(bin, 'curl'), `#!/bin/bash
case "$*" in
  *-fsSLI*) printf 'https://github.com/openai/codex/releases/tag/rust-v9.9.9' ;;
  *api.github.com*) printf '{"assets":[{"name":"codex-%s-unknown-linux-musl.tar.gz","digest":"sha256:%064d"},{"name":"codex-code-mode-host-%s-unknown-linux-musl.tar.gz","digest":"sha256:%064d"}]}' "$(uname -m | sed 's/^arm64$/aarch64/')" 0 "$(uname -m | sed 's/^arm64$/aarch64/')" 0 ;;
  *) while [ "$1" != "-o" ]; do shift; done; echo tampered > "$2" ;;
esac
`);
      await chmod(join(bin, 'curl'), 0o755);
      const proc = Bun.spawn(['bash', '-c', CODEX_INSTALL_HINT.replace(/^[^:]*: /, '')], {
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir }, stdout: 'ignore', stderr: 'ignore',
      });
      expect(await proc.exited).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
