/**
 * Install helper for the compiled `lazy-agent` binary on the host.
 *
 * ## Why installs are content-addressed and immutable
 *
 * Every container bind-mounts a host file at `/usr/local/bin/lazy-agent`. For a
 * long time that host file was one fixed path, `~/.lazy/bin/lazy-agent`, and
 * every producer (embedded extraction, dev-mode compile, `lazy upgrade`)
 * replaced it with same-directory temp + chmod + rename(2). The comment that
 * used to live here claimed rename made the swap invisible to running
 * containers, because they hold the old inode.
 *
 * That claim is FALSE on Docker Desktop, and it was verified false on
 * 2026-09-01. A builder container created at 19:13 was inspected after an
 * upgrade rewrote the host file at 21:41: inside the container,
 * /usr/local/bin/lazy-agent was the NEW file (new inode, new size, new version
 * string). /proc/self/mountinfo showed why — the mount is a subpath of the
 * whole `/Users` virtiofs share:
 *
 *     0:44 /<user>/.lazy/bin/lazy-agent /usr/local/bin/lazy-agent ro … \
 *          fakeowner /run/host_mark/Users
 *
 * The guest resolves that PATH through the share on every access, so a host
 * rename over it swaps the binary under every running container, and a
 * container created around the swap can observe the transition — including,
 * apparently, a stale size attribute in the VM's cache. A Bun compiled
 * executable finds its embedded bundle through a trailer at the END of the
 * file, so a reader that sees a stale size misses the trailer and behaves as a
 * bare Bun runtime: exactly the `Script not found "selfcheck"` failure that
 * killed three builder relaunches (2026-08-29, 2026-09-01 twice).
 *
 * The fix is structural: **nothing ever writes to a path a container mounts.**
 * Binaries install as `~/.lazy/bin/lazy-agent-<content-id>` — a name derived
 * from the bytes — verified once at install and then never touched again.
 * Launches mount that concrete versioned file. A new version is a NEW path, so
 * a running container keeps its own file for its whole lifetime and no reader
 * can ever observe a half-swapped one.
 *
 * `~/.lazy/bin/lazy-agent-current` is a **pointer symlink** to the current
 * install, for humans and for tools (`lazy doctor`) that want "the current
 * agent binary" by a stable name. It is never a mount source — and it is
 * deliberately a NEW name: the old `lazy-agent` path is what every container
 * created before this layout still mounts, so nothing may write there either.
 * That file is only ever read (to adopt its bytes) and, once no running
 * container mounts it, garbage-collected like any other stale install.
 *
 * Two consequences worth stating, because both were real bugs:
 *
 *  - An install that already exists and verifies is NEVER rewritten. An older
 *    `lazy` process (the pre-upgrade `lazy builder` wrapper still running its
 *    relaunch loop) re-extracts its own embedded agent on every launch; under
 *    the single-path layout that re-extraction wrote 100MB over the freshly
 *    upgraded binary and silently downgraded it. Content addressing makes that
 *    write land on the old version's own path, where it changes nothing.
 *  - Old versions are garbage-collected (see {@link pruneAgentBinaries}) rather
 *    than overwritten, so disk does not grow without bound.
 *
 * In-place writes to any install path would still be wrong for the original
 * reason: Bun compiled output grows runtime-first, so truncating a file that a
 * reader shares would expose a bare Bun runtime to it.
 */

import { createHash, randomUUID } from 'crypto';
import { chmod, lstat, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { spawn } from '../utils/spawn';
import { mkdir } from 'fs/promises';
import { verifyAgentBinary } from './binary-identity';

/** Temp-file prefix — tests assert on this for the temp+rename contract. */
export const AGENT_BINARY_TMP_PREFIX = '.tmp-lazy-agent-';

/** Prefix of an immutable, content-addressed install: `lazy-agent-<id>`. */
export const AGENT_BINARY_VERSIONED_PREFIX = 'lazy-agent-';

/**
 * Stable human-facing name in ~/.lazy/bin. A symlink; never a mount source.
 *
 * Deliberately NOT `lazy-agent`: that name IS the mount source of every
 * container created before this layout existed, and the mount tracks the host
 * path. Writing a symlink over it would replace their /usr/local/bin/lazy-agent
 * with a relative link to a file that does not exist inside the container —
 * the same swap-under-a-live-mount failure, moved to the migration moment.
 */
export const AGENT_BINARY_POINTER_NAME = 'lazy-agent-current';

/**
 * The pre-content-addressing install path. Read (to adopt its bytes) and
 * eventually garbage-collected once no running container mounts it, but never
 * written to: containers that predate the migration still resolve it by name.
 */
export const AGENT_BINARY_LEGACY_NAME = 'lazy-agent';

/**
 * Grace period before an unreferenced install becomes garbage.
 *
 * `docker ps` cannot see a container that is being created right now, and the
 * host mount source is chosen a moment before `docker run`. Never collecting a
 * recently-installed binary keeps that window from turning into a missing mount.
 */
export const AGENT_BINARY_GC_GRACE_MS = 60 * 60 * 1000;

/** Timeout for the docker queries that find binaries in use. */
const DOCKER_QUERY_TIMEOUT_MS = 15_000;

/**
 * Content id for a set of agent-binary bytes: first 16 hex of its SHA-256.
 *
 * 64 bits of collision resistance over a handful of ~100MB builds on one
 * machine, and short enough that `ls ~/.lazy/bin` stays readable.
 */
export function agentBinaryContentId(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Same id, computed by streaming a file rather than holding it in memory. */
export async function agentBinaryContentIdOfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = Bun.file(path).stream();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
  }
  return hash.digest('hex').slice(0, 16);
}

/** File name of the immutable install for `contentId`. */
export function versionedAgentBinaryName(contentId: string): string {
  return `${AGENT_BINARY_VERSIONED_PREFIX}${contentId}`;
}

/** Absolute path of the immutable install for `contentId` inside `binDir`. */
export function versionedAgentBinaryPath(binDir: string, contentId: string): string {
  return join(binDir, versionedAgentBinaryName(contentId));
}

/** Absolute path of the human-facing pointer symlink inside `binDir`. */
export function agentBinaryPointerPath(binDir: string): string {
  return join(binDir, AGENT_BINARY_POINTER_NAME);
}

/** Absolute path of the legacy single-path install inside `binDir`. */
export function legacyAgentBinaryPath(binDir: string): string {
  return join(binDir, AGENT_BINARY_LEGACY_NAME);
}

/**
 * Write `bytes` to `destPath` via temp file in the same directory, mode 0755,
 * then rename over the destination.
 *
 * Still temp+rename, because a reader must never see partial bytes at a path it
 * is about to exec. With content-addressed installs the destination is a NEW
 * path that no container has mounted, so the rename is not a swap under anyone.
 */
export async function atomicInstallAgentBinary(destPath: string, bytes: Buffer): Promise<void> {
  const destDir = dirname(destPath);
  await mkdir(destDir, { recursive: true });

  const tmpPath = join(destDir, `${AGENT_BINARY_TMP_PREFIX}${randomUUID()}`);
  try {
    await writeFile(tmpPath, bytes, { mode: 0o755 });
    // writeFile mode applies on create; chmod covers replace of a loose target.
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, destPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (unlinkErr) {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(
          `Failed to extract the embedded agent binary to ${destPath}: ` +
          `${err instanceof Error ? err.message : String(err)} ` +
          `(also failed to remove temp file ${tmpPath}: ` +
          `${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)})`,
        );
      }
    }
    throw new Error(
      `Failed to extract the embedded agent binary to ${destPath}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface VersionedInstallResult {
  /** Absolute path of the immutable install containers will mount. */
  path: string;
  contentId: string;
  /** False when a verified install for these bytes was already present. */
  installed: boolean;
}

/**
 * Install `bytes` as an immutable, content-addressed agent binary.
 *
 * An existing install for the same content id that still verifies is returned
 * untouched — this is the rule that stops an older `lazy` process from
 * rewriting (and, under the old single-path layout, downgrading) a binary that
 * is already correct. An existing file that does NOT verify is replaced: it can
 * only be a truncated or interrupted earlier install of the same content.
 */
export async function installVersionedAgentBinary(
  binDir: string,
  bytes: Buffer,
  contentId: string = agentBinaryContentId(bytes),
): Promise<VersionedInstallResult> {
  await mkdir(binDir, { recursive: true });
  const destPath = versionedAgentBinaryPath(binDir, contentId);

  const existing = await verifyAgentBinary(destPath);
  if (existing.ok) {
    return { path: destPath, contentId, installed: false };
  }

  await atomicInstallAgentBinary(destPath, bytes);
  return { path: destPath, contentId, installed: true };
}

/**
 * Move an already-built, already-verified temp file into its immutable install
 * path. Used by the dev-mode compile, whose output is a file, not bytes.
 *
 * When a verified install for the same content already exists the temp file is
 * discarded rather than renamed over it — same never-rewrite rule as above.
 */
export async function adoptVersionedAgentBinary(
  binDir: string,
  tmpPath: string,
  contentId: string,
): Promise<VersionedInstallResult> {
  await mkdir(binDir, { recursive: true });
  const destPath = versionedAgentBinaryPath(binDir, contentId);

  const existing = await verifyAgentBinary(destPath);
  if (existing.ok) {
    try {
      await unlink(tmpPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { path: destPath, contentId, installed: false };
  }

  await chmod(tmpPath, 0o755);
  await rename(tmpPath, destPath);
  return { path: destPath, contentId, installed: true };
}

export interface UpdatePointerOptions {
  /**
   * Advance the pointer even when it already names a resolvable install.
   *
   * Pass the install's `installed` flag: only a process that actually put new
   * bytes on disk has a claim to say what "current" is. Without this, an OLD
   * `lazy` process (the pre-upgrade `lazy builder` wrapper re-extracting its
   * own embedded agent on every relaunch) repoints the pointer BACK to its
   * version while the daemon flips it forward — harmless for mounts, which
   * never use the pointer, but it makes `lazy doctor` and the image-tag
   * selfcheck probe flap between versions.
   */
  force?: boolean;
}

/**
 * Point `~/.lazy/bin/lazy-agent-current` at the given install.
 *
 * Written as a relative symlink (temp + rename, so the name is never missing)
 * so ~/.lazy stays relocatable. Nothing mounts this path; it exists so a human
 * running `ls -l ~/.lazy/bin` or `lazy doctor` can see which install is current.
 */
export async function updateAgentBinaryPointer(
  binDir: string,
  versionedPath: string,
  opts: UpdatePointerOptions = {},
): Promise<void> {
  const pointer = agentBinaryPointerPath(binDir);
  const target = basename(versionedPath);

  const current = await readPointerTarget(pointer);
  if (current === target) return;

  // A pointer that already resolves belongs to whoever last installed bytes.
  // Take it over only on a real install, or when it is missing/dangling.
  if (!opts.force && current !== null && (await resolveInstalledAgentBinary(binDir))) return;

  const tmpPath = join(binDir, `${AGENT_BINARY_TMP_PREFIX}link-${randomUUID()}`);
  try {
    await symlink(target, tmpPath);
    await rename(tmpPath, pointer);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (unlinkErr) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `Failed to update the agent binary pointer ${pointer} -> ${target}: ` +
          `${err instanceof Error ? err.message : String(err)} ` +
          `(also failed to remove ${tmpPath}: ` +
          `${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)})`,
        );
      }
    }
    throw new Error(
      `Failed to update the agent binary pointer ${pointer} -> ${target}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readPointerTarget(pointer: string): Promise<string | null> {
  try {
    const st = await lstat(pointer);
    if (!st.isSymbolicLink()) return null;
    return await readlink(pointer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Failed to read the agent binary pointer ${pointer}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve the install the pointer names, or null when there is none.
 *
 * Returns the CONCRETE versioned path (symlinks resolved), because a mount
 * source must never be a name that can be repointed later.
 */
export async function resolveInstalledAgentBinary(binDir: string): Promise<string | null> {
  const pointer = agentBinaryPointerPath(binDir);
  try {
    const resolved = await realpath(pointer);
    const st = await stat(resolved);
    if (!st.isFile()) return null;
    return resolved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Failed to resolve the agent binary pointer ${pointer}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Adopt a legacy single-path `~/.lazy/bin/lazy-agent` REGULAR FILE into the
 * content-addressed layout, so a machine upgrading into this scheme does not
 * have to rebuild ~100MB to keep working.
 *
 * The legacy file is COPIED and then LEFT EXACTLY AS IT WAS — not renamed, not
 * replaced by a symlink, not touched at all. Containers launched before the
 * migration still resolve that path through the host mount, so any write there
 * (including a one-byte symlink) is the swap-under-a-live-mount failure this
 * layout exists to prevent; a symlink is worse than a binary, because its
 * relative target does not exist inside the container at all. The copy is what
 * future launches mount, and the legacy file is eventually removed by GC once
 * no running container mounts it.
 *
 * Returns the adopted install, or null when there is no legacy file (or it does
 * not verify, in which case the caller's normal extract/build path handles it).
 */
export async function adoptLegacyAgentBinary(binDir: string): Promise<VersionedInstallResult | null> {
  const legacy = legacyAgentBinaryPath(binDir);
  let st;
  try {
    st = await lstat(legacy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Failed to inspect ${legacy}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // A symlink here is a pre-release layout, not a legacy install; nothing to adopt.
  if (!st.isFile()) return null;

  const verdict = await verifyAgentBinary(legacy);
  if (!verdict.ok) return null;

  const contentId = await agentBinaryContentIdOfFile(legacy);
  const destPath = versionedAgentBinaryPath(binDir, contentId);
  const existing = await verifyAgentBinary(destPath);
  if (!existing.ok) {
    const bytes = Buffer.from(await Bun.file(legacy).arrayBuffer());
    await atomicInstallAgentBinary(destPath, bytes);
  }
  return { path: destPath, contentId, installed: !existing.ok };
}

/**
 * Every content-addressed install currently in `binDir`.
 *
 * The pointer shares the versioned prefix (`lazy-agent-current`) and is
 * excluded by name — it is a symlink, not an install.
 */
export async function listInstalledAgentBinaries(binDir: string): Promise<string[]> {
  try {
    const entries = await readdir(binDir);
    return entries
      .filter((name) => name.startsWith(AGENT_BINARY_VERSIONED_PREFIX))
      .filter((name) => name !== AGENT_BINARY_POINTER_NAME)
      .map((name) => join(binDir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Failed to list agent binaries in ${binDir}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface PruneAgentBinariesOptions {
  /** Paths that must survive regardless of age (the current install). */
  keep?: string[];
  /**
   * Host paths bind-mounted by running containers, or null when that could not
   * be determined — in which case NOTHING is collected. Deleting a file a live
   * container resolves by path is exactly the failure mode being fixed.
   */
  referenced: string[] | null;
  graceMs?: number;
  now?: number;
}

/**
 * Delete content-addressed installs that no running container mounts, that are
 * not the current one, and that are older than the grace period.
 *
 * The legacy `lazy-agent` regular file is collected by the same rules. That is
 * the ONLY way it is ever removed: it is never written over, because containers
 * created before the migration mount it by path, and `referenced` is what keeps
 * it alive for exactly as long as one of them is running.
 *
 * Best-effort by contract: the caller treats a failure as a disk-space problem,
 * never as a launch failure.
 */
export async function pruneAgentBinaries(
  binDir: string,
  opts: PruneAgentBinariesOptions,
): Promise<string[]> {
  if (opts.referenced === null) return [];

  const keep = new Set(opts.keep ?? []);
  const referenced = new Set(opts.referenced);
  const graceMs = opts.graceMs ?? AGENT_BINARY_GC_GRACE_MS;
  const now = opts.now ?? Date.now();

  const candidates = await listInstalledAgentBinaries(binDir);
  const legacy = legacyAgentBinaryPath(binDir);
  if (await isRegularFile(legacy)) candidates.push(legacy);

  const removed: string[] = [];
  for (const path of candidates) {
    if (keep.has(path) || referenced.has(path)) continue;
    const st = await stat(path);
    if (now - st.mtimeMs < graceMs) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Failed to inspect ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Host paths that running containers bind-mount, or null when the container
 * runtime could not answer. Null means "unknown", and callers must not collect.
 */
export async function listContainerMountSources(
  dockerBinary: string = 'docker',
): Promise<string[] | null> {
  try {
    const ps = spawn([dockerBinary, 'ps', '--quiet', '--no-trunc'], {
      stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_QUERY_TIMEOUT_MS,
    });
    const [psOut] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (ps.exitCode !== 0) return null;

    const ids = psOut.split('\n').map((l) => l.trim()).filter(Boolean);
    if (ids.length === 0) return [];

    const inspect = spawn(
      [dockerBinary, 'inspect', '--format', '{{range .Mounts}}{{println .Source}}{{end}}', ...ids],
      { stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_QUERY_TIMEOUT_MS },
    );
    const [out] = await Promise.all([new Response(inspect.stdout).text(), inspect.exited]);
    if (inspect.exitCode !== 0) return null;

    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // The runtime is missing or unreachable. Unknown, not empty — collecting on
    // an unanswered query could delete a binary a live container is mounting.
    return null;
  }
}
