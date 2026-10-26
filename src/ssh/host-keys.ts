/**
 * The stable SSH host key of a task's environment
 * (docs/design/task-sessions-and-ssh.md §5, "Stable host key").
 *
 * Member containers are removed at their idle limit and made again, and a task
 * container is recreated by a Restart; a key generated per container would
 * change with each and break every saved `~/.ssh/config`. So the key lives
 * DAEMON-side, one per (member, task) on a shared daemon and one per task
 * solo, beside the member homes (relocated with them under
 * `LAZY_BUILDER_STATE_DIR`, so a Teams machine replacement keeps it), and is
 * handed to each connection's `sshd -i` in its environment.
 *
 * `--ssh-config --install` pins the PUBLIC half from the authenticated lazy
 * channel (`sshHostKey`), so the first connection is already verified.
 */

import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { mkdir, readdir, readFile, rename, writeFile, rm } from 'fs/promises';
import { getDaemonBaseDir, projectSlug } from '../daemon/paths';
import { BUILDER_STATE_DIR_ENV, builderStateRoot } from '../builder/state-root';
import { generateEd25519KeyPair, parsePublicKeyLine, type OpenSshKeyPair } from './keys';

/** Where one project's host keys live. */
export function sshHostKeysDir(projectRoot: string): string {
  if (process.env[BUILDER_STATE_DIR_ENV]) return join(builderStateRoot(), 'ssh-host-keys', projectSlug(projectRoot));
  return join(dirname(getDaemonBaseDir()), 'ssh-host-keys', projectSlug(projectRoot));
}

/** The file stem for a task (and member, on a shared daemon). Emails are hashed, never spelled into a path. */
export function hostKeyStem(taskId: string, memberEmail: string | null): string {
  if (!/^[A-Za-z0-9-]+$/.test(taskId)) throw new Error(`not a task id: ${JSON.stringify(taskId)}`);
  if (!memberEmail) return taskId;
  const member = createHash('sha256').update(memberEmail.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `${taskId}.${member}`;
}

const inFlight = new Map<string, Promise<OpenSshKeyPair>>();

/**
 * The host key for (task, member), made on first use. Concurrent callers for
 * the same key share one creation; the file is written beside and renamed into
 * place, so a reader never sees half a key.
 */
export async function ensureSshHostKey(projectRoot: string, taskId: string, memberEmail: string | null): Promise<OpenSshKeyPair> {
  const dir = sshHostKeysDir(projectRoot);
  const stem = hostKeyStem(taskId, memberEmail);
  const key = join(dir, stem);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    try {
      const [privateKey, publicKey] = await Promise.all([
        readFile(key, 'utf8'),
        readFile(`${key}.pub`, 'utf8'),
      ]);
      if (privateKey.includes('BEGIN OPENSSH PRIVATE KEY') && parsePublicKeyLine(publicKey)) {
        return { privateKey, publicKey: publicKey.trim() };
      }
      throw new Error(`SSH host key ${key} is unreadable; remove it (and its .pub) to make a new one`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const pair = generateEd25519KeyPair(`lazy-host-${stem.slice(0, 8)}`);
    const tmp = `${key}.${process.pid}.tmp`;
    await writeFile(`${tmp}.pub`, `${pair.publicKey}\n`, { mode: 0o644 });
    await writeFile(tmp, pair.privateKey, { mode: 0o600 });
    // The public half first: a key file with no .pub would read as broken.
    await rename(`${tmp}.pub`, `${key}.pub`);
    await rename(tmp, key);
    return pair;
  })();
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/** Remove a task's host keys, every member's. A missing directory is fine. */
export async function removeTaskSshHostKeys(projectRoot: string, taskId: string): Promise<void> {
  hostKeyStem(taskId, null);
  const dir = sshHostKeysDir(projectRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const mine = names.filter((n) => n === taskId || n.startsWith(`${taskId}.`));
  await Promise.all(mine.map((n) => rm(join(dir, n), { force: true })));
}
