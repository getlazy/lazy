/**
 * Test helpers for the machine-global approval passphrase store.
 *
 * The store is deliberately unreachable from the CLI in a non-interactive way
 * (`lazy system passphrase set` is TTY-only, with no flag, env var, or stdin
 * route, and refuses outright when a prompt test seam is set — see
 * src/cli/commands/system-passphrase.ts), so a suite that needs an ENROLLED
 * machine writes the store directly, exactly as the command would:
 * a `Bun.password` hash at `<base>/passphrase.json`, mode 0600.
 *
 * Always keyed to `ctx.passphraseBaseDir`, the temp dir `setupTestLazy` pins as
 * `LAZY_PASSPHRASE_BASE_DIR` for every process it spawns — never the real
 * ~/.lazy, which holds the developer's own passphrase.
 */

import { join } from 'path';
import { mkdir, writeFile, chmod, rm, stat } from 'fs/promises';
import { normalizePassphrase } from '../../src/protection/passphrase-store';

/** Path of the store inside a test context's pinned base dir. */
export function passphraseStorePathFor(baseDir: string): string {
  return join(baseDir, 'passphrase.json');
}

/**
 * Enroll `passphrase` into the store at `baseDir`, the way the command does.
 * Pass `ctx.passphraseBaseDir`.
 */
export async function enrollPassphrase(baseDir: string, passphrase: string): Promise<string> {
  const path = passphraseStorePathFor(baseDir);
  const record = {
    // Through the store's own normalization, so a helper-enrolled passphrase is
    // byte-for-byte what `lazy system passphrase set` would have hashed.
    hash: await Bun.password.hash(normalizePassphrase(passphrase)),
    updated_at: new Date().toISOString(),
  };
  await mkdir(baseDir, { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/** Remove any enrollment, leaving the machine looking freshly-installed. */
export async function clearPassphrase(baseDir: string): Promise<void> {
  await rm(passphraseStorePathFor(baseDir), { force: true });
}

/** True when a store file exists in `baseDir`. */
export async function passphraseStoreExists(baseDir: string): Promise<boolean> {
  try {
    await stat(passphraseStorePathFor(baseDir));
    return true;
  } catch {
    // stat only fails here when the file is absent or its directory is — both
    // mean "nothing enrolled" for a test's purposes.
    return false;
  }
}

/** Octal permission string of the store file, e.g. '600'. */
export async function passphraseStoreMode(baseDir: string): Promise<string> {
  const info = await stat(passphraseStorePathFor(baseDir));
  return (info.mode & 0o777).toString(8).padStart(3, '0');
}
