/**
 * "Am I running inside a container?" — a small, best-effort probe.
 *
 * Used by surfaces that must only ever run on the human's own machine, where
 * "inside a container" almost always means "inside a task agent's container"
 * (`lazy system passphrase`). It is a guard rail, not a security boundary: the
 * markers below are conventions, and a determined process inside a container
 * can hide them. The real boundaries elsewhere are the read-only mounts and the
 * daemon's own checks; this exists so an agent that reaches for a human-only
 * command gets a clear refusal instead of half-performing it.
 *
 * Deliberately probes the FILESYSTEM rather than an env var lazy sets itself:
 * an env var is trivially inherited by host processes a container spawned back
 * out (and trivially unset), whereas `/.dockerenv` and `/run/.containerenv` are
 * created by the runtime inside the container and nowhere else.
 */

import { readFile, stat } from 'fs/promises';

/** Marker files each runtime drops at the root of a container it starts. */
const MARKER_FILES = [
  '/.dockerenv',        // Docker
  '/run/.containerenv', // Podman
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // A permissions error on a path we are only probing tells us nothing —
    // treat it as "no marker" rather than failing the caller's command.
    return false;
  }
}

/**
 * True when this process appears to be running inside a container.
 *
 * Checks, in order: the runtime marker files, then `/proc/1/cgroup` for a
 * container-runtime path segment (the classic Linux tell). Anything unreadable
 * counts as "not a container" — a probe that cannot answer must not block a
 * human on their own machine.
 */
export async function isRunningInContainer(): Promise<boolean> {
  // Test-only override, same family as LAZY_FORCE_TTY and never set in
  // production: e2e suites for lazy itself run INSIDE a container, so without
  // this the human-only commands could only ever be observed refusing. '1'
  // forces the refusal path, '0' forces the host path.
  const forced = process.env.LAZY_FORCE_CONTAINER;
  if (forced === '1') return true;
  if (forced === '0') return false;

  for (const marker of MARKER_FILES) {
    if (await exists(marker)) return true;
  }

  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf-8');
    if (/\b(docker|containerd|podman|lxc|kubepods)\b/.test(cgroup)) return true;
  } catch {
    // No procfs (macOS) or unreadable — no verdict from this probe.
  }

  return false;
}
