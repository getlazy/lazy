/**
 * Unit tests for the machine-global approval passphrase store
 * (src/protection/passphrase-store.ts).
 *
 * These cover the properties that made the passphrase worth moving out of the
 * repository at all: what is written is a hash, the file is owner-only, and a
 * store anyone else can read is REFUSED rather than warned about.
 *
 * The store is redirected with `LAZY_PASSPHRASE_BASE_DIR` — its own seam, not
 * `LAZY_DAEMON_BASE_DIR` — so nothing here can touch the developer's own
 * enrollment at ~/.lazy/passphrase.json.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  passphraseStorePath,
  readPassphraseEnrollment,
  isPassphraseEnrolled,
  verifyPassphrase,
  writePassphrase,
  normalizePassphrase,
  deletePassphrase,
  legacyPassphraseFileExists,
  legacyPassphrasePath,
  removeLegacyPassphraseFile,
} from '../../src/protection/passphrase-store';

const PASSPHRASE = 'correct-horse-battery';

describe('approval passphrase store', () => {
  let baseDir: string;
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'passphrase-store-'));
    previousBaseDir = process.env.LAZY_PASSPHRASE_BASE_DIR;
    process.env.LAZY_PASSPHRASE_BASE_DIR = baseDir;
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) delete process.env.LAZY_PASSPHRASE_BASE_DIR;
    else process.env.LAZY_PASSPHRASE_BASE_DIR = previousBaseDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  test('nothing is enrolled on a fresh machine', async () => {
    expect(await isPassphraseEnrolled()).toBe(false);
    const enrollment = await readPassphraseEnrollment();
    expect(enrollment.enrolled).toBe(false);
    expect(enrollment.updatedAt).toBeNull();
    expect(enrollment.path).toBe(join(baseDir, 'passphrase.json'));
  });

  // INVARIANT: the store holds a HASH. A host-process agent shares the user's
  // HOME and can read this file — reading it must not recover the passphrase.
  test('writePassphrase stores an argon2 hash, never the passphrase', async () => {
    await writePassphrase(PASSPHRASE);

    const raw = await readFile(passphraseStorePath(), 'utf-8');
    expect(raw).not.toContain(PASSPHRASE);
    expect(JSON.parse(raw).hash).toStartWith('$argon2');
  });

  // INVARIANT: mode 0600 on BOTH create and overwrite. writeFile's `mode`
  // applies only on creation, so a rotation over a loosened file would
  // otherwise silently keep the loose mode.
  test('the store is 0600 on create and stays 0600 on rotation', async () => {
    await writePassphrase(PASSPHRASE);
    expect(((await stat(passphraseStorePath())).mode & 0o777).toString(8)).toBe('600');

    await chmod(passphraseStorePath(), 0o644);
    await writePassphrase('a-different-passphrase');
    expect(((await stat(passphraseStorePath())).mode & 0o777).toString(8)).toBe('600');
  });

  // INVARIANT: REFUSE, don't warn. A hash other accounts can read is one they
  // can attack offline; continuing would leave the human believing the gate is
  // intact. Every read path goes through the same assertion.
  test('a group- or world-readable store is refused, not warned about', async () => {
    await writePassphrase(PASSPHRASE);
    await chmod(passphraseStorePath(), 0o644);

    for (const call of [
      () => isPassphraseEnrolled(),
      () => readPassphraseEnrollment(),
      () => verifyPassphrase(PASSPHRASE),
    ]) {
      await expect(call()).rejects.toThrow(/readable by other accounts/);
    }

    // And the fix is in the message, with the exact path.
    const err = await verifyPassphrase(PASSPHRASE).catch((e) => e as Error);
    expect((err as Error).message).toContain(`chmod 600 ${passphraseStorePath()}`);
  });

  test('verifyPassphrase accepts the enrolled phrase and rejects anything else', async () => {
    await writePassphrase(PASSPHRASE);

    expect(await verifyPassphrase(PASSPHRASE)).toBe(true);
    expect(await verifyPassphrase('not-the-passphrase')).toBe(false);
    // Nothing enrolled is a plain false — callers that need to tell the two
    // apart probe enrollment first (the accept pre-flight does).
    await deletePassphrase();
    expect(await verifyPassphrase(PASSPHRASE)).toBe(false);
  });

  // INVARIANT: the store is the ONE place a passphrase is normalized, and it
  // normalizes both sides — what it hashes and what it checks. A masked prompt
  // shows the human nothing, so a stray space is invisible at enrollment and at
  // every later attempt; when callers trimmed independently, one path trimmed
  // and the other did not and the passphrase rotated fine but could never
  // satisfy a merge. Do NOT re-add a trim in a caller: that is how that split
  // came back last time.
  test('enrollment and verification agree on surrounding whitespace', async () => {
    await writePassphrase(`  ${PASSPHRASE}\t`);

    // Enrolled padded, verified clean — and every other combination.
    expect(await verifyPassphrase(PASSPHRASE)).toBe(true);
    expect(await verifyPassphrase(` ${PASSPHRASE} `)).toBe(true);

    // And the reverse direction: enrolled clean, verified padded.
    await writePassphrase(PASSPHRASE);
    expect(await verifyPassphrase(`\n${PASSPHRASE}  `)).toBe(true);

    // Normalization is trimming only — inner whitespace is part of the phrase.
    expect(await verifyPassphrase(PASSPHRASE.replace('-', ' - '))).toBe(false);
  });

  test('normalizePassphrase is what both sides apply', () => {
    expect(normalizePassphrase(`  ${PASSPHRASE}\n`)).toBe(PASSPHRASE);
    expect(normalizePassphrase(PASSPHRASE)).toBe(PASSPHRASE);
  });

  test('enrollment reports the rotation timestamp, and delete clears it', async () => {
    await writePassphrase(PASSPHRASE);
    const enrolled = await readPassphraseEnrollment();
    expect(enrolled.enrolled).toBe(true);
    expect(Number.isNaN(Date.parse(enrolled.updatedAt!))).toBe(false);

    expect(await deletePassphrase()).toBe(true);
    expect(await isPassphraseEnrolled()).toBe(false);
    // Deleting nothing is not an error — `status` and `delete` both rely on it.
    expect(await deletePassphrase()).toBe(false);
  });

  // Found-but-broken must not read as "nothing enrolled": that would send the
  // human re-enrolling over a file they may not be able to write.
  test('a corrupt store is an error naming the file, not a silent not-enrolled', async () => {
    await writeFile(passphraseStorePath(), '{ not json', { mode: 0o600 });
    await expect(isPassphraseEnrolled()).rejects.toThrow(/Failed to parse/);

    await writeFile(passphraseStorePath(), JSON.stringify({ updated_at: 'x' }), { mode: 0o600 });
    await expect(isPassphraseEnrolled()).rejects.toThrow(/missing its hash/);
  });

  describe('the legacy in-repo plaintext file', () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'passphrase-legacy-'));
      await mkdir(join(projectRoot, '.lazy'), { recursive: true });
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
    });

    test('is located at the fixed path and can be removed', async () => {
      expect(await legacyPassphraseFileExists(projectRoot)).toBe(false);
      expect(await removeLegacyPassphraseFile(projectRoot)).toBe(false);

      await writeFile(legacyPassphrasePath(projectRoot), 'old-plaintext\n');
      expect(await legacyPassphraseFileExists(projectRoot)).toBe(true);

      expect(await removeLegacyPassphraseFile(projectRoot)).toBe(true);
      expect(await legacyPassphraseFileExists(projectRoot)).toBe(false);
    });

    // INVARIANT: the migration is HARD. The old file is never consulted, so its
    // contents cannot satisfy the gate no matter what they are.
    test('never satisfies verification, even holding the right phrase', async () => {
      await writeFile(legacyPassphrasePath(projectRoot), `${PASSPHRASE}\n`);

      expect(await isPassphraseEnrolled()).toBe(false);
      expect(await verifyPassphrase(PASSPHRASE)).toBe(false);
    });
  });
});
