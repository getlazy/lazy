import { describe, test, expect } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

/**
 * INVARIANT: no package.json script may invoke a dependency's CLI by its bare
 * `node_modules/.bin` name.
 *
 * There is no `node` in the agent image (`Dockerfile.lazy` has never installed
 * one) and bun does not put a `node` shim on PATH for `bun run`. Every binary in
 * `node_modules/.bin` starts with `#!/usr/bin/env node`, so a script spelled
 * `tsc --noEmit` dies at the shebang with exit 127 before the compiler reads a
 * single file.
 *
 * That is how `[checks] post_turn = "bun run build && bun run typecheck"` sat
 * dead: both halves 127'd every turn, the gate checked nothing, and the failure
 * read as noise rather than as "the gate is not running". It never reproduced on
 * a dev Mac, where mise.toml provisions node.
 *
 * The fix is to hand the compiler's entry module to bun directly
 * (`bun node_modules/typescript/lib/tsc.js --noEmit`), which needs no node, uses
 * the PINNED typescript rather than whatever `bun x` fetches, and behaves the
 * same on the engineer's Mac. This test pins the shape so the next dependency
 * with a CLI cannot quietly reintroduce a gate that exits 127.
 */
describe('package.json scripts are node-free', () => {
  test('no script invokes a node-shebang binary by its bare .bin name', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
    const scripts: Record<string, string> = pkg.scripts ?? {};

    // Every name that `node_modules/.bin` would put on PATH. Read from disk
    // rather than hardcoded, so a newly added dependency is covered for free.
    let binNames: string[] = [];
    try {
      binNames = await readdir(join(ROOT, 'node_modules', '.bin'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`failed to read node_modules/.bin: ${String(err)}`);
      // Dependencies are not installed — nothing to check against. Not a
      // failure: this file is also read by tooling that runs before install.
      return;
    }

    for (const [name, body] of Object.entries(scripts)) {
      for (const bin of binNames) {
        // A bare invocation: the bin name at the start of a command segment
        // (script start, or after &&/||/;/|), not as part of a longer path.
        const bare = new RegExp(String.raw`(^|&&|\|\||;|\|)\s*${bin}(\s|$)`);
        expect(
          bare.test(body),
          `package.json script "${name}" invokes "${bin}" from node_modules/.bin. ` +
            `That binary is #!/usr/bin/env node and there is no node in the agent ` +
            `image, so this exits 127 without running. Point bun at the package's ` +
            `entry module instead, e.g. "bun node_modules/typescript/lib/tsc.js".`,
        ).toBe(false);
      }
    }
  });

  test('typecheck actually runs the pinned typescript compiler', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
    // Not `bun x tsc`: `bun x` may fetch the LATEST typescript from the
    // registry, which is a different compiler from the one a public user gets.
    // scripts/release.sh depends on this script using the pinned one.
    expect(pkg.scripts.typecheck).toBe('bun node_modules/typescript/lib/tsc.js --noEmit');
  });
});
