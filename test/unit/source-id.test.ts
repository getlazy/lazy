/**
 * The one algorithm for "which lazy code is this?".
 *
 * It exists because the question used to have three answers — a git SHA, a shell
 * pipeline in the self-host Dockerfile, and a `sed` fallback in its entrypoint —
 * and none of them was comparable to the others. A fleet compares a daemon's
 * answer against a checkout's on every tick, so any drift between two
 * implementations would make every daemon look permanently stale (restart the
 * world, every minute) or permanently current (never roll at all). These tests
 * are about the properties that comparison depends on.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  computeSourceFingerprint,
  computeSourceIdentityOf,
  readBakedFingerprint,
  sourceIdentityOf,
  FINGERPRINT_FILE,
} from '../../src/utils/source-id';

let root: string;

/** A minimal tree shaped like the parts of a lazy checkout the id covers. */
async function seedCheckout(dir: string): Promise<void> {
  await mkdir(join(dir, 'src', 'daemon'), { recursive: true });
  await writeFile(join(dir, 'src', 'index.ts'), 'export const entry = 1;\n');
  await writeFile(join(dir, 'src', 'daemon', 'server.ts'), 'export const serve = 1;\n');
  await writeFile(join(dir, 'package.json'), '{"name":"lazy"}\n');
  await writeFile(join(dir, 'bun.lock'), 'lockfile\n');
  await writeFile(join(dir, 'Dockerfile.lazy'), 'FROM debian\n');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-source-id-'));
  await seedCheckout(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('source fingerprint', () => {
  test('the same tree yields the same id', async () => {
    expect(await computeSourceFingerprint(root)).toBe(await computeSourceFingerprint(root));
  });

  // The property a git SHA does NOT have, and the reason the fleet compares
  // content: a development checkout spends most of its day dirty, and a fleet
  // that called an edited tree "unchanged" would report daemons current while
  // they served different code.
  test('an uncommitted edit changes the id', async () => {
    const before = await computeSourceFingerprint(root);
    await writeFile(join(root, 'src', 'daemon', 'server.ts'), 'export const serve = 2;\n');

    expect(await computeSourceFingerprint(root)).not.toBe(before);
  });

  test('adding a file changes the id, and removing it puts the id back', async () => {
    const before = await computeSourceFingerprint(root);
    const extra = join(root, 'src', 'daemon', 'extra.ts');
    await writeFile(extra, 'export const x = 1;\n');
    expect(await computeSourceFingerprint(root)).not.toBe(before);

    await rm(extra);
    expect(await computeSourceFingerprint(root)).toBe(before);
  });

  // INVARIANT: the id covers the FILE SET, not just the bytes. Moving content
  // between two files leaves every byte in the tree accounted for, so an
  // implementation hashing only concatenated contents would call this the same
  // code — and it is not.
  test('moving content between files changes the id', async () => {
    const before = await computeSourceFingerprint(root);
    await writeFile(join(root, 'src', 'index.ts'), '');
    await writeFile(join(root, 'src', 'daemon', 'server.ts'), 'export const serve = 1;\nexport const entry = 1;\n');

    expect(await computeSourceFingerprint(root)).not.toBe(before);
  });

  // `Dockerfile.lazy` is the agent container image, so a change there changes
  // what a turn executes just as surely as a change under src/.
  test('the id covers the container Dockerfile and the lockfile, not only src', async () => {
    const before = await computeSourceFingerprint(root);
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM debian\nRUN apt-get install -y curl\n');
    const afterDockerfile = await computeSourceFingerprint(root);
    expect(afterDockerfile).not.toBe(before);

    await writeFile(join(root, 'bun.lock'), 'lockfile v2\n');
    expect(await computeSourceFingerprint(root)).not.toBe(afterDockerfile);
  });

  // node_modules is an install artifact, not lazy's source, and hashing it would
  // make the id depend on which machine ran `bun install`.
  test('installed dependencies are not part of the identity', async () => {
    const before = await computeSourceFingerprint(root);
    await mkdir(join(root, 'src', 'node_modules', 'thing'), { recursive: true });
    await writeFile(join(root, 'src', 'node_modules', 'thing', 'index.js'), 'module.exports = 1;\n');

    expect(await computeSourceFingerprint(root)).toBe(before);
  });

  // A checkout that does not ship one of the covered paths still gets an id: a
  // fingerprint that refuses to exist is worse than one covering slightly less,
  // because every caller reads "no id" as "stale".
  test('a missing covered path is skipped rather than fatal', async () => {
    await rm(join(root, 'bun.lock'));

    expect(await computeSourceFingerprint(root)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the baked fingerprint', () => {
  test('a baked value is used verbatim, without reading the tree', async () => {
    const baked = 'a'.repeat(16);
    await writeFile(join(root, FINGERPRINT_FILE), `${baked}\n`);

    const identity = await sourceIdentityOf(root);
    expect(identity.id).toBe(baked);
    expect(identity.kind).toBe('baked');
  });

  test('with no baked file the tree is hashed and says so', async () => {
    const identity = await sourceIdentityOf(root);
    expect(identity.kind).toBe('computed');
    expect(identity.id).toBe(await computeSourceFingerprint(root));
  });

  // INVARIANT: the baked file is VALIDATED, not trusted. It is written by a
  // build and read at runtime; a truncated or garbage value would compare
  // unequal to every real id forever, so the fleet would restart every daemon
  // every minute and never converge.
  test('a garbage or truncated baked value is ignored and the tree is hashed', async () => {
    for (const bad of [ '', 'not-a-hash', 'abc', 'A'.repeat(16), `${'a'.repeat(64)}` ]) {
      await writeFile(join(root, FINGERPRINT_FILE), `${bad}\n`);
      expect(await readBakedFingerprint(root)).toBeNull();
      expect((await sourceIdentityOf(root)).kind).toBe('computed');
    }
  });

  test('surrounding whitespace in the baked file is tolerated', async () => {
    const baked = 'b'.repeat(16);
    await writeFile(join(root, FINGERPRINT_FILE), `  ${baked}  \n\n`);

    expect(await readBakedFingerprint(root)).toBe(baked);
  });

  // INVARIANT: the WRITE path always hashes the tree and never reads the baked
  // file. Every other reader prefers the baked value — that is what baking it is
  // for — but a writer that did the same could only ever rewrite a stale file
  // with itself, so a `.source-fingerprint` left behind by an old build would
  // pin that checkout's identity for ever and no re-bake could dislodge it.
  // Both halves of that hide staleness rather than over-report it, which is the
  // direction nobody notices until a feature "does not exist" on a daemon.
  test('computing for a write ignores a baked value and reads the tree', async () => {
    const stale = 'c'.repeat(16);
    await writeFile(join(root, FINGERPRINT_FILE), `${stale}\n`);

    // The readers still prefer it — that half is deliberate.
    expect((await sourceIdentityOf(root)).id).toBe(stale);

    const computed = await computeSourceIdentityOf(root);
    expect(computed.id).not.toBe(stale);
    expect(computed.kind).toBe('computed');
    expect(computed.id).toBe(await computeSourceFingerprint(root));
  });
});
