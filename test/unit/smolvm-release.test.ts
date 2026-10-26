/**
 * The smolvm pin as solo lazy checks it (src/vm/smolvm-release.ts): the same
 * vendoring manifest Lazy Teams' SmolvmRelease verifies, against the same pin.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmolvmPinError, forgetVerifiedSmolvmForTests, smolvmArchiveName, verifySmolvmBinary } from '../../src/vm/smolvm-release';
import { SMOLVM_RELEASE } from '../../src/vm/smolvm-docker-machine';

const PLATFORM = 'darwin-arm64';
let tree: string;
beforeEach(async () => {
  forgetVerifiedSmolvmForTests();
  tree = join(await realpath(await mkdtemp(join(tmpdir(), 'smolvm-pin-'))), 'smolvm-1.29.0');
  await mkdir(join(tree, 'lib'), { recursive: true });
});
afterEach(async () => { await rm(join(tree, '..'), { recursive: true, force: true }); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A vendored tree as bin/vendor-smolvm leaves it: launcher, a library, a symlink, a compressed template, the manifest. */
async function vendor(opts: { archive?: string; digest?: string } = {}): Promise<string> {
  const files: Record<string, string> = { smolvm: '#!/bin/sh\necho smolvm\n', 'smolvm-bin': 'bin', 'lib/libkrun.dylib': 'lib', 'storage-template.ext4.zst': 'zst' };
  for (const [p, body] of Object.entries(files)) await writeFile(join(tree, p), body);
  await chmod(join(tree, 'smolvm'), 0o755);
  await symlink('libkrun.dylib', join(tree, 'lib/libkrun.1.dylib'));
  const lines = [`archive ${opts.archive ?? smolvmArchiveName(PLATFORM)} ${opts.digest ?? SMOLVM_RELEASE.archiveSha256[PLATFORM]}`];
  for (const p of Object.keys(files).sort()) lines.push(`file ${sha(files[p]!)} ${p}`);
  lines.push('symlink lib/libkrun.1.dylib libkrun.dylib');
  await writeFile(join(tree, 'smolvm.sha256'), `${lines.join('\n')}\n`);
  return join(tree, 'smolvm');
}

describe('verifySmolvmBinary', () => {
  test('accepts the pinned release, vendored and unchanged', async () => {
    const launcher = await vendor();
    expect(await verifySmolvmBinary(launcher, PLATFORM)).toBe(launcher);
  });

  // INVARIANT: lazy never runs a smolvm found on PATH; only an absolute path to a vendored tree.
  test('refuses a bare command name', async () => {
    await expect(verifySmolvmBinary('smolvm', PLATFORM)).rejects.toThrow(/absolute path to a vendored copy/);
  });

  // INVARIANT: a tree vendored for another release is the wrong version, and is refused with the fix.
  test('refuses a tree vendored from another release', async () => {
    const launcher = await vendor({ archive: `smolvm-1.9.3-${PLATFORM}.tar.gz` });
    const err = await verifySmolvmBinary(launcher, PLATFORM).catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmPinError);
    expect(err.message).toContain(`lazy runs smolvm ${SMOLVM_RELEASE.version}`);
    expect(err.message).toContain('lazy system smolvm-install');
  });

  test('refuses an archive digest that is not the pin', async () => {
    const launcher = await vendor({ digest: 'f'.repeat(64) });
    await expect(verifySmolvmBinary(launcher, PLATFORM)).rejects.toThrow(/but the pin is/);
  });

  test('refuses a file changed after vendoring', async () => {
    const launcher = await vendor();
    await writeFile(join(tree, 'smolvm-bin'), 'swapped');
    await expect(verifySmolvmBinary(launcher, PLATFORM)).rejects.toThrow(/does not match the digest/);
  });

  test('refuses a file added beside it, but tolerates smolvm\'s own decompressed template', async () => {
    const launcher = await vendor();
    await writeFile(join(tree, 'storage-template.ext4'), 'decompressed by smolvm');
    expect(await verifySmolvmBinary(launcher, PLATFORM)).toBe(launcher);
    forgetVerifiedSmolvmForTests();
    await writeFile(join(tree, 'lib/extra.dylib'), 'planted');
    await expect(verifySmolvmBinary(launcher, PLATFORM)).rejects.toThrow(/manifest does not list \(lib\/extra.dylib\)/);
  });

  test('re-verifies once the tree changes after a success', async () => {
    const launcher = await vendor();
    await verifySmolvmBinary(launcher, PLATFORM);
    await writeFile(join(tree, 'lib/libkrun.dylib'), 'tampered later');
    await expect(verifySmolvmBinary(launcher, PLATFORM)).rejects.toThrow(/does not match the digest/);
  });

  test('refuses a tree with no manifest, and a platform with no release', async () => {
    await writeFile(join(tree, 'smolvm'), 'x');
    await chmod(join(tree, 'smolvm'), 0o755);
    await expect(verifySmolvmBinary(join(tree, 'smolvm'), PLATFORM)).rejects.toThrow(/no vendoring manifest/);
    await expect(verifySmolvmBinary(join(tree, 'smolvm'), null)).rejects.toThrow(/has no release for/);
  });
});
