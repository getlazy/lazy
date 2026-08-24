/**
 * The approval passphrase store — global to the machine, hashed, and outside
 * every repository.
 *
 * WHY GLOBAL (not per-project): keying the credential to a project needs a
 * stable project identity, and the only identity available is the path — which
 * changes the moment the repo is cloned, moved, or opened from a worktree.
 * A passphrase that silently stops working after `git clone` is worse than one
 * shared across the machine's projects, and the passphrase is FRICTION (proof a
 * human is at the keyboard), not a per-repo secret.
 *
 * WHY OUTSIDE THE REPO: it used to live at `<project>/.lazy/approve-passphrase`
 * in PLAINTEXT, at a path `[protection].passphrase_file` let the repository
 * itself choose. Both halves were bugs. Every task container bind-mounts the
 * project root (`-v <repoRoot>:<repoRoot>:ro`), and a host-process agent simply
 * reads the tree — so the secret that gates merges was readable by every agent
 * it was meant to gate. And a repo-controlled path meant an agent could point
 * the key at a file it had just written and approve itself.
 *
 * WHY NOT UNDER THE DAEMON DIR: `~/.lazy/daemon/<slug>/` is daemon RUNTIME
 * state, and `LAZY_DAEMON_BASE_DIR` relocates all of it together (socket, PID,
 * token, log, lock — see src/daemon/paths.ts). A human credential that moves
 * when a test or an operator sets an env var is a footgun: enrollment would
 * land in one place and verification look in another. This store therefore
 * sits at `~/.lazy/passphrase.json`, one level ABOVE the daemon dir, governed
 * by its own seam and nothing else.
 *
 * WHY A HASH: an agent under the host-process runner shares the user's HOME,
 * so it can read this file. Storing a hash means reading it does not recover
 * the passphrase. Hashing is `Bun.password` (argon2id by default). There is no
 * recovery path — a forgotten passphrase is re-enrolled, never recovered.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, chmod, stat, unlink } from 'fs/promises';
import { getHome } from '../utils/home';

const STORE_FILENAME = 'passphrase.json';

/**
 * Base directory of the passphrase store. `LAZY_PASSPHRASE_BASE_DIR` overrides
 * it, deliberately as its OWN seam rather than riding on
 * `LAZY_DAEMON_BASE_DIR`: tests (and operators with a non-standard HOME) need
 * to redirect this store without dragging daemon runtime state along, and vice
 * versa. Every path below flows through here, so the override is honored
 * everywhere — enrollment (CLI) and verification (daemon) alike.
 */
export function getPassphraseBaseDir(): string {
  const override = process.env.LAZY_PASSPHRASE_BASE_DIR;
  if (override) return override;
  return join(getHome(), '.lazy');
}

/** Absolute path of the passphrase store: ~/.lazy/passphrase.json */
export function passphraseStorePath(): string {
  return join(getPassphraseBaseDir(), STORE_FILENAME);
}

/**
 * Pre-v0.23 home of the passphrase: a PLAINTEXT file inside the repository.
 * Never consulted for verification any more — it is only located so the human
 * can be told to delete it (and so `lazy system passphrase set` and
 * `lazy doctor` can remove/flag it). The path is fixed: the configurable
 * `[protection].passphrase_file` key is gone.
 */
export const LEGACY_PASSPHRASE_RELPATH = '.lazy/approve-passphrase';

/** Absolute path of the legacy in-repo plaintext passphrase file. */
export function legacyPassphrasePath(projectRoot: string): string {
  return join(projectRoot, LEGACY_PASSPHRASE_RELPATH);
}

/** True when the legacy plaintext file is still sitting in the project. */
export async function legacyPassphraseFileExists(projectRoot: string): Promise<boolean> {
  try {
    await stat(legacyPassphrasePath(projectRoot));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Failed to check for the legacy passphrase file ${legacyPassphrasePath(projectRoot)}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Delete the legacy plaintext file. Returns true when a file was removed.
 * The whole point of the move is that a live secret must not stay behind in a
 * tree every agent can read, so a failure here is surfaced, never swallowed.
 */
export async function removeLegacyPassphraseFile(projectRoot: string): Promise<boolean> {
  const path = legacyPassphrasePath(projectRoot);
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Failed to remove the legacy plaintext passphrase file ${path}: ` +
      `${err instanceof Error ? err.message : err}. Delete it by hand — it holds your ` +
      `old passphrase in the clear.`,
    );
  }
}

interface PassphraseRecord {
  /** Bun.password hash (argon2id). Never the passphrase itself. */
  hash: string;
  /** ISO timestamp of the last enrollment/rotation, for `status`. */
  updated_at: string;
}

/** What `status` (and the enrollment probe) can say without a token in hand. */
export interface PassphraseEnrollment {
  enrolled: boolean;
  path: string;
  /** ISO timestamp of the last enrollment. Null when nothing is enrolled. */
  updatedAt: string | null;
}

function isRecord(value: unknown): value is PassphraseRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as PassphraseRecord).hash === 'string' &&
    (value as PassphraseRecord).hash.length > 0
  );
}

/**
 * Refuse — not warn — when the store is readable by anyone but its owner.
 *
 * A hash that other accounts on the machine can read is a hash they can attack
 * offline at their leisure. Continuing with a warning would leave the human
 * believing the gate is intact, so this is a hard error with the exact fix.
 */
async function assertOwnerOnly(path: string): Promise<void> {
  const info = await stat(path);
  const groupOrWorld = info.mode & 0o077;
  if (groupOrWorld !== 0) {
    throw new Error(
      `Refusing to use the approval passphrase store ${path}: it is mode ` +
      `${(info.mode & 0o777).toString(8).padStart(3, '0')}, readable by other accounts on this ` +
      `machine.\nFix it with:\n\n  chmod 600 ${path}\n\n` +
      `If the hash may already have leaked, re-enroll afterwards with \`lazy system passphrase set\`.`,
    );
  }
}

/** Read the stored record, or null when nothing is enrolled. */
async function readRecord(): Promise<PassphraseRecord | null> {
  const path = passphraseStorePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Failed to read the approval passphrase store ${path}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }

  // Found-but-broken is an error the human must see: treating it as "nothing
  // enrolled" would send them re-enrolling over a file they cannot write.
  await assertOwnerOnly(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse the approval passphrase store ${path}: ` +
      `${err instanceof Error ? err.message : err}.\n` +
      `Delete the file and re-enroll with \`lazy system passphrase set\`.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `The approval passphrase store ${path} is missing its hash.\n` +
      `Delete the file and re-enroll with \`lazy system passphrase set\`.`,
    );
  }

  return parsed;
}

/** Enrollment state, for `lazy system passphrase status` and doctor. */
export async function readPassphraseEnrollment(): Promise<PassphraseEnrollment> {
  const record = await readRecord();
  return {
    enrolled: record !== null,
    path: passphraseStorePath(),
    updatedAt: record?.updated_at ?? null,
  };
}

/** True when this machine has an approval passphrase enrolled. */
export async function isPassphraseEnrolled(): Promise<boolean> {
  return (await readRecord()) !== null;
}

/**
 * The ONE normalization the passphrase gets, applied on both sides.
 *
 * A masked prompt shows the human nothing, so a stray leading or trailing
 * space is invisible at enrollment AND at every later attempt. Normalizing in
 * exactly one place is what keeps "what rotation accepts" and "what accept
 * accepts" the same string: when callers trimmed independently, one path
 * trimmed and the other did not, and the result was a passphrase that rotated
 * fine but could never satisfy a merge — with no error that could explain why.
 * Callers pass the raw input; nobody else trims.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.trim();
}

/** Internal shorthand for the export above. */
const normalize = normalizePassphrase;

/**
 * Verify a candidate passphrase against the stored hash.
 *
 * Returns false when nothing is enrolled — callers that need to distinguish
 * "wrong" from "nothing enrolled" probe enrollment first (which is what the
 * accept pre-flight does, so the prompt is never a dead end).
 */
export async function verifyPassphrase(candidate: string): Promise<boolean> {
  const record = await readRecord();
  if (!record) return false;
  try {
    return await Bun.password.verify(normalize(candidate), record.hash);
  } catch (err) {
    // A hash Bun cannot parse is a corrupt store, not a failed attempt — say
    // so rather than reporting an endless stream of "does not match".
    throw new Error(
      `The approval passphrase store ${passphraseStorePath()} holds an unreadable hash ` +
      `(${err instanceof Error ? err.message : err}).\n` +
      `Delete the file and re-enroll with \`lazy system passphrase set\`.`,
    );
  }
}

/**
 * Hash and store a new passphrase, replacing whatever was there. Mode 0600 on
 * both create and overwrite (writeFile's mode only applies on creation).
 *
 * Callers are responsible for the human ceremony around this — confirming the
 * passphrase twice, and proving knowledge of the current one before rotating.
 * See src/cli/commands/system-passphrase.ts.
 *
 * What is hashed is the NORMALIZED passphrase, the same string verifyPassphrase
 * checks against — see normalize().
 */
export async function writePassphrase(passphrase: string): Promise<string> {
  const path = passphraseStorePath();
  const record: PassphraseRecord = {
    hash: await Bun.password.hash(normalize(passphrase)),
    updated_at: new Date().toISOString(),
  };
  await mkdir(getPassphraseBaseDir(), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/** Remove the enrolled passphrase. Returns true when a store was deleted. */
export async function deletePassphrase(): Promise<boolean> {
  const path = passphraseStorePath();
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Failed to delete the approval passphrase store ${path}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
}
