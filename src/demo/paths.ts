/**
 * Where a demo environment lives on disk, and the manifest that describes it.
 *
 * EVERYTHING the demo creates lives under ONE root, with no exceptions: the
 * fixture repository, the external store, the daemon's socket/PID/token/log
 * directory, the fake agent's bin and state, the Teams app's data, and the
 * manifest. That is what makes `lazy playground down` a directory removal plus a
 * daemon stop, and it is why the daemon base dir is redirected here rather than
 * left at `~/.lazy/daemon`: a demo must not scatter state into the places a
 * human's real projects use.
 *
 * The root defaults to `~/.lazy-playground` and is overridable with `--root` (and,
 * for the e2e suite, `LAZY_PLAYGROUND_ROOT`). It is deliberately NOT inside any lazy
 * project: the demo's own repo is a lazy project, and nesting one inside
 * another makes `findLazyRoot()` answer differently depending on cwd.
 */

import { homedir } from 'os';
import { join, resolve } from 'path';
import { mkdir, readFile, rename, writeFile, rm, stat } from 'fs/promises';
import type { FleetManifest } from './fleet';

/** Manifest file name inside the demo root. */
export const MANIFEST_FILE = 'demo.json';

/**
 * Schema version of {@link DemoManifest}.
 *
 * Bumped when the layout changes incompatibly. `lazy playground status` refuses a
 * manifest it does not understand and points at `lazy playground down` rather than
 * guessing — a half-understood demo is worse than no demo, because the daemon
 * it describes is a real process holding a real port.
 */
export const MANIFEST_VERSION = 1;

/** What a provisioned demo environment recorded about itself. */
export interface DemoManifest {
  version: number;
  /** Absolute demo root. Recorded so a moved root is detected rather than half-used. */
  root: string;
  /** ISO timestamp of the `lazy playground up` that produced this environment. */
  createdAt: string;
  /** The lazy source entry point the demo daemon was started from. */
  lazyEntry: string;
  /** Dashboard base URL, e.g. `http://lazy.localhost:26024`. */
  dashboardUrl: string | null;
  /** Task codes seeded, in the order they were created. */
  seededTasks: string[];
  /**
   * The repository cloned as the project (`--repo`, or the published
   * playground), when one was; absent for the generated fixture. Its seeded
   * tasks are then the repository's starter tasks, not the fixture's states.
   */
  projectRepo?: string;
  /**
   * The fleet demo (`--fleet`), when this demo runs on a real backend rather
   * than in demo mode. Everything `status` and `down` need to reach the
   * machine without the shell that created it; never the credential value.
   */
  fleet?: FleetManifest;
  /** Teams details, when `--teams` provisioned one. */
  teams?: {
    url: string;
    pid: number;
    /**
     * Port the server was started on.
     *
     * Recorded separately from `url` because teardown identifies the process
     * before signalling it, and the port is what it matches against the
     * command line. Optional: manifests written before it was recorded fall
     * back to parsing `url`.
     */
    port?: number;
    /** Sign-in email of the seeded site admin. */
    email: string;
    password: string;
  };
}

/** The paths that make up a demo environment. */
export interface DemoPaths {
  root: string;
  /** The fixture git repository — a real repo with real history. */
  repo: string;
  /** External lazy store for the fixture project. */
  store: string;
  /** Daemon base dir (socket, PID, token, log, lock) for the demo daemon. */
  daemonBase: string;
  /** Fake agent state dir; its `bin/` goes on the demo daemon's PATH. */
  agent: string;
  /** Screenshots and other artifacts a demo run produces. */
  out: string;
  /** Teams working data (sqlite, logs, pid). */
  teams: string;
  /**
   * `HOME` for every process the demo starts.
   *
   * Redirected, not inherited, and that is load-bearing rather than tidiness.
   * A demo turn runs on the host-process runner against a real home directory,
   * and lazy writes an agent's MCP config to `$HOME/.claude.json`, merges a
   * tool allowlist into `$HOME/.claude/settings.json` and leaves session state
   * under `$HOME/.claude/projects/`. Inheriting the ambient home meant five
   * seeded turns rewrote the machine's own Claude Code config to point at the
   * demo's worktree — which teardown then deleted, leaving the entry dangling.
   * Claude Code reads ONE MCP config per home, so on a machine where an agent
   * is working, that is its live tool channel being repointed at a directory
   * that no longer exists.
   *
   * Under the root, those writes are disposable state teardown already removes,
   * and "everything the demo creates lives under one root" becomes true without
   * an exception.
   */
  home: string;
  manifest: string;
}

/**
 * Resolve the demo root.
 *
 * Precedence is explicit-flag, then env, then the default — the env var exists
 * for the e2e suite, which must never touch a developer's `~/.lazy-playground`.
 * `LAZY_DEMO_ROOT` is its old spelling from before the command was renamed to
 * `lazy playground`, honoured for one release.
 */
export function resolveDemoRoot(explicit?: string): string {
  const raw = explicit || process.env.LAZY_PLAYGROUND_ROOT || process.env.LAZY_DEMO_ROOT || join(homedir(), '.lazy-playground');
  return resolve(raw);
}

/**
 * The environment an old `lazy demo up` left at `~/.lazy-demo`, when the caller
 * would otherwise get the NEW default root and never hear about it.
 *
 * Only for the implicit default: an explicit root or either env var already
 * says where to look. Never acted on — the CLI prints how to tear it down; it
 * does not switch roots on its own.
 */
export async function findLegacyDemoRoot(explicit?: string, home: string = homedir()): Promise<string | null> {
  if (explicit || process.env.LAZY_PLAYGROUND_ROOT || process.env.LAZY_DEMO_ROOT) return null;
  const root = join(home, '.lazy-demo');
  try {
    await stat(join(root, MANIFEST_FILE));
    return root;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to check for an old lazy demo environment at ${root}: ${(err as Error).message}`);
  }
}

export function demoPaths(explicitRoot?: string): DemoPaths {
  const root = resolveDemoRoot(explicitRoot);
  return {
    root,
    repo: join(root, 'repo'),
    store: join(root, 'store'),
    daemonBase: join(root, 'daemon'),
    agent: join(root, 'agent'),
    out: join(root, 'out'),
    teams: join(root, 'teams'),
    home: join(root, 'home'),
    manifest: join(root, MANIFEST_FILE),
  };
}

export async function readManifest(paths: DemoPaths): Promise<DemoManifest | null> {
  let raw: string;
  try {
    raw = await readFile(paths.manifest, 'utf-8');
  } catch (err) {
    // No manifest is the normal "no demo here" state, not a fault.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read the playground manifest at ${paths.manifest}: ${(err as Error).message}`);
  }

  let parsed: DemoManifest;
  try {
    parsed = JSON.parse(raw) as DemoManifest;
  } catch (err) {
    // A manifest that exists but will not parse is never "no demo" — say so,
    // because a daemon it describes may still be running and holding a port.
    throw new Error(
      `The playground manifest at ${paths.manifest} exists but is not valid JSON: ${(err as Error).message}\n` +
      `Tear the playground down and start again: lazy playground down --root ${paths.root}`,
    );
  }
  return parsed;
}

/**
 * Write the manifest ATOMICALLY — temp file, then rename.
 *
 * The manifest is the marker that authorises `lazy playground down` to remove a root,
 * and a reader now REQUIRES it to parse (see `classifyRoot`). A plain
 * `writeFile` truncates in place, so a crash mid-write would leave a demo whose
 * marker is invalid and whose root is therefore un-removable — wedging the user
 * with a live daemon they cannot tear down. `rename` within one directory is
 * atomic, so a reader sees either the old manifest or the new one and never a
 * half-written file. It is rewritten several times during `up`, which is what
 * makes the window real rather than theoretical.
 */
export async function writeManifest(paths: DemoPaths, manifest: DemoManifest): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const temp = `${paths.manifest}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temp, paths.manifest);
}

export async function removeManifest(paths: DemoPaths): Promise<void> {
  await rm(paths.manifest, { force: true });
}
