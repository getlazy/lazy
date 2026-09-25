/**
 * Per-project scratch state for machine one-shots, outside every repository.
 *
 * WHY THIS EXISTS
 * ---------------
 * A one-shot used to be a bare `claude -p` that inherited its caller's cwd — for
 * the accept-time fidelity summary that caller is the DAEMON, whose cwd is the
 * project root, checked out on the TARGET branch. The agent therefore ran a full
 * Claude Code session rooted in the user's main working tree while an accept was
 * in flight. An agent that writes a file and commits it (harmless-looking
 * housekeeping behavior, and exactly what a scripted agent does) lands a commit
 * on `main` mid-accept and manufactures a conflict with the branch being merged
 * — surfacing as `Session branch has conflicts with main` with nothing wrong on
 * the task branch at all.
 *
 * WHO USES IT NOW
 * ---------------
 * Container one-shots mount `<dir>/.claude` or `<dir>/.cursor` (whichever the
 * configured agent uses) at the container's agent home, so the run gets writable
 * agent state that is NOT the user's real one. Repo isolation comes from the
 * container's absent (or read-only) repo mount.
 *
 * WHY NOT THE DAEMON DIR: `~/.lazy/daemon/<slug>/` holds the bearer token, the
 * MCP token registry, and real user credentials. Handing an agent process a cwd
 * inside it would put those one `Read` away. This dir is deliberately its own.
 *
 * WHY NOT A FRESH TEMP DIR PER RUN: Claude Code writes a session JSONL into
 * `~/.claude/projects/<encoded-cwd>/`, so a unique cwd per run would leave one
 * new projects directory behind per accept, forever. A stable per-project path
 * keeps that to one.
 *
 * WHY NOT UNDER THE PROJECT ROOT (`.lazy/tmp`, say): a cwd inside the working
 * tree is inside the repo, so `git commit -am` from it still lands on the target
 * branch. Being outside every git tree is the whole guarantee — the same
 * structural reason the builder scratch dir lives outside the repo
 * (src/builder/scratch.ts).
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';
import { getHome } from '../utils/home';
import { projectSlug } from '../daemon/paths';

/**
 * Root holding every project's one-shot dir: `~/.lazy/oneshot/`.
 *
 * `LAZY_ONESHOT_BASE_DIR` overrides the location. Same seam (and same reason) as
 * `LAZY_DAEMON_BASE_DIR` and `LAZY_SCRATCH_BASE_DIR`: a test run must not create
 * directories in the developer's real `~/.lazy` — nor, by extension, a
 * `~/.claude/projects/` entry per test project.
 */
export function getOneshotBaseDir(): string {
  const override = process.env.LAZY_ONESHOT_BASE_DIR;
  if (override) return override;
  return join(getHome(), '.lazy', 'oneshot');
}

/**
 * This project's one-shot dir: `~/.lazy/oneshot/<project-slug>/`.
 *
 * Pure, so the path can be asserted without touching the filesystem. Callers
 * with no project root get a shared `default` dir — still outside every
 * repository, which is the property that matters.
 */
export function oneshotCwd(projectRoot?: string): string {
  return join(getOneshotBaseDir(), projectRoot ? projectSlug(projectRoot) : 'default');
}

/** Create the one-shot dir if needed and return its absolute path. */
export async function ensureOneshotCwd(projectRoot?: string): Promise<string> {
  const dir = oneshotCwd(projectRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Create and return the agent-state directory a CONTAINERIZED one-shot gets
 * mounted at `/home/user/<configDirName>` (`.claude` for Claude Code, `.cursor`
 * for Cursor).
 *
 * An empty directory is enough (the same is true of a task container's sandbox
 * mount, see src/utils/sandbox.ts). It must NOT be the host's real agent home:
 * that holds the user's credentials and every conversation they have had.
 */
export async function ensureOneshotAgentHome(
  projectRoot: string | undefined,
  configDirName: string,
): Promise<string> {
  const dir = join(oneshotCwd(projectRoot), configDirName);
  await mkdir(dir, { recursive: true });
  return dir;
}
