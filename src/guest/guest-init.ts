/**
 * lazy-guest-init, as the lazy binary carries it.
 *
 * The daemon image's per-boot preparation script (port forwarder, docker
 * data-root, dockerd and its watchdog) used to be baked into the image, so
 * every change to it needed a new guest ABI and replaced every machine — its
 * docker images, its build cache, the tools a project had installed. It is
 * lazy's own logic, not an OS package, so it now travels with the binary the
 * fleet already swaps in place: embedded here, written out on demand by
 * `lazy system guest-init-script`, and run by the image's stable shim
 * (lazy-teams/deploy/daemon-image/lazy-guest-init). docs/design/lazy-daemon-image.md
 * "What travels with the binary" has the reasoning.
 */
import { createHash } from 'crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import GUEST_INIT_SCRIPT from './lazy-guest-init' with { type: 'text' };

export { GUEST_INIT_SCRIPT };

/**
 * The script's id: the first 16 hex of its sha256 — the same number the script
 * prints as `guest_init_id` for itself, so an in-place roll can prove the
 * guest runs the script of the binary it just swapped in.
 */
export function guestInitId(script: string = GUEST_INIT_SCRIPT): string {
  return createHash('sha256').update(script).digest('hex').slice(0, 16);
}

/**
 * Write the embedded script to `<runDir>/lazy-guest-init.<id>` (0755) unless an
 * identical copy is already there, and return its path. Written to a temp name
 * and renamed, so a concurrent caller never runs a half-written file; a copy
 * whose bytes differ (a damaged tmpfs file) is rewritten, never trusted by name.
 */
export async function materializeGuestInit(runDir: string, script: string = GUEST_INIT_SCRIPT): Promise<string> {
  const target = join(runDir, `lazy-guest-init.${guestInitId(script)}`);
  let existing: string | null = null;
  try {
    existing = await readFile(target, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`could not read ${target}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (existing === script) {
    // Only touched when wrong: the copy is root's in the guest, and a caller
    // that may read but not chmod it must still get its path.
    try {
      if (((await stat(target)).mode & 0o777) !== 0o755) await chmod(target, 0o755);
    } catch (err) {
      throw new Error(`could not make ${target} executable: ${err instanceof Error ? err.message : err}`);
    }
    return target;
  }
  await mkdir(runDir, { recursive: true });
  const temp = `${target}.tmp.${process.pid}`;
  try {
    await writeFile(temp, script, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw new Error(`could not write lazy-guest-init to ${target}: ${err instanceof Error ? err.message : err}`);
  }
  return target;
}
