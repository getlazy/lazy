/**
 * Shared sandbox setup for task supervisors.
 *
 * Every code path that launches a supervisor (start, resume, sync, auto-resume,
 * auto-unblock) needs the same sandbox layout: a `.claude` directory and a
 * `.gitconfig` file inside the sandbox root. Without this, Docker creates
 * `.gitconfig` as an empty directory (because the bind-mount source doesn't
 * exist) and git operations inside the container have no user identity.
 */

import { join, dirname } from 'path';
import { mkdir, copyFile, writeFile, rm, appendFile } from 'fs/promises';
import { getHome } from './home';
import { pathExists, dirExists } from './fs';
import { runGit } from './git';
import { logger } from './logger';
import type { SandboxConfig } from '../capture/claude';
import type { Storage } from '../storage/interface';
import { ensureTaskClaudeConfig } from '../task/claude-home';

export const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Where a task's artifacts are materialized inside its worktree, relative to
 * the worktree root.
 *
 * Deliberately under the sandbox dir rather than a new top-level `.lazy-artifacts/`:
 * `.lazy-task-sandbox/` is already written into the project `.gitignore` by
 * `lazy init` and is already excluded from every dirtiness check by pathspec, so
 * materializing here cannot dirty a task's diff and needs no new git mechanics.
 */
export const ARTIFACTS_SUBDIR = `${SANDBOX_DIR}/artifacts`;

const DEFAULT_GITCONFIG = '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n';

/** Appended to every sandbox gitconfig — see setupSandbox. */
const GC_OFF = '\n[gc]\n\tauto = 0\n';

/**
 * Quote a path as a git config value.
 *
 * Unquoted values run to end of line and treat `#` and `;` as comment starts,
 * and trailing whitespace is stripped — all of which a real filesystem path may
 * contain. Inside double quotes git only honours `\\` and `\"`.
 */
function gitConfigValue(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Mark the paths lazy itself created and mounts as trusted for the container's git.
 *
 * WHY THIS EXISTS: the agent container runs as its own uid (`user`, from
 * Dockerfile.lazy) against a worktree the HOST user owns. git compares the
 * repository directory's owner against the uid running git and refuses on
 * mismatch — `fatal: detected dubious ownership in repository at ...` — which
 * kills every git command in the worktree, not just the merge phase where it was
 * first reported. Docker Desktop for macOS happens to mount binds as `fakeowner`
 * (stat reports the caller's own uid), which made the check vacuous and hid this
 * for as long as that was the only runtime in use; podman, Colima and plain
 * Docker on a Linux host whose uid is not the image's do not fake it.
 *
 * SCOPE, deliberately: exactly the worktree and the two git dirs lazy resolves
 * and bind-mounts (see src/capture/git-mounts.ts) — never `*`. These are paths
 * lazy created, owns and mounted into a container it launched; trusting them is
 * trusting lazy's own worktree, and every OTHER repository the container can see
 * still gets git's ownership check in full. The entries land ONLY in
 * `<worktree>/.lazy-task-sandbox/.gitconfig`, which is bind-mounted to
 * `/home/user/.gitconfig` inside the container; the human's real `~/.gitconfig`
 * is never modified, so no trust is granted anywhere on the host.
 */
async function safeDirectoryStanza(worktreePath: string): Promise<string> {
  // The worktree itself needs no git call, and it is the path in the observed
  // failure — resolve the git dirs on top of it, best effort.
  const paths = [worktreePath];

  const resolved = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'],
    { cwd: worktreePath },
  );
  if (resolved.exitCode === 0) {
    for (const line of resolved.stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
      if (!paths.includes(line)) paths.push(line);
    }
  } else {
    // Not fatal, and not swallowed: the worktree entry above still goes in, and a
    // worktree whose git dirs cannot be resolved has a larger problem that the
    // caller's own git commands will report with full context. Warn so this is
    // visible if a container later refuses the gitdir.
    logger.warn(
      `setupSandbox: could not resolve the git dirs for ${worktreePath}, so only the worktree ` +
      `itself is marked safe.directory in the container gitconfig: ` +
      `${resolved.stderr || 'git rev-parse failed'}`,
    );
  }

  return '\n[safe]\n' + paths.map(p => `\tdirectory = ${gitConfigValue(p)}\n`).join('');
}

/**
 * Create the sandbox directory layout for a worktree and return its config.
 *
 * Idempotent — safe to call repeatedly. Always rewrites `.gitconfig` to keep
 * it in sync with the host's, and removes any stale directory Docker may have
 * created at that path on a previous run.
 */
export async function setupSandbox(
  worktreePath: string,
  artifacts?: { storage: Storage; taskId: string },
): Promise<SandboxConfig> {
  const sandboxPath = join(worktreePath, SANDBOX_DIR);
  const claudeDir = join(sandboxPath, '.claude');
  await mkdir(claudeDir, { recursive: true });
  // Cursor's equivalent home-config dir. Created unconditionally (cheap, and
  // agent-agnostic callers don't need to know the task's agent): the container
  // bind-mounts it to /home/user/.cursor so a Cursor task's chat state lands in
  // the sandbox instead of vanishing with the container.
  await mkdir(join(sandboxPath, '.cursor'), { recursive: true });
  // pi's home-config dir (~/.pi/agent: sessions, models.json, the lazy MCP
  // bridge extension). Same unconditional-create rationale as .cursor.
  await mkdir(join(sandboxPath, '.pi'), { recursive: true });
  // Codex's home-config dir, same arrangement: bind-mounted to
  // /home/user/.codex so a Codex task's config.toml, auth state and session
  // rollouts persist in the sandbox across the task's containers.
  await mkdir(join(sandboxPath, '.codex'), { recursive: true });

  const hostGitconfig = join(getHome(), '.gitconfig');
  const sandboxGitconfig = join(sandboxPath, '.gitconfig');
  if (await dirExists(sandboxGitconfig)) {
    await rm(sandboxGitconfig, { recursive: true });
  }

  if (await pathExists(hostGitconfig)) {
    await copyFile(hostGitconfig, sandboxGitconfig);
  } else {
    await writeFile(sandboxGitconfig, DEFAULT_GITCONFIG);
  }
  // Belt and braces for the split .git mount: the container sees the shared git
  // dir read-only, so an auto-gc triggered in there could only fail (it wants to
  // repack objects and rewrite packed-refs). Disabling it keeps that failure from
  // ever surfacing as a confusing error on an unrelated git command.
  await appendFile(sandboxGitconfig, GC_OFF);
  // Trust for lazy's own worktree and git dirs. Must be in this file (a GLOBAL
  // config from the container's point of view): git deliberately ignores
  // `safe.directory` from repository-local config and from `-c` on the command
  // line, so there is no other place it can be set.
  await appendFile(sandboxGitconfig, await safeDirectoryStanza(worktreePath));

  if (artifacts) {
    await materializeArtifacts(worktreePath, artifacts.storage, artifacts.taskId);
  }

  // Seed the sandbox copy of ~/.claude.json (onboarding, theme, folder trust)
  // before the first container bind-mounts it. MCP entries are merged per turn.
  await ensureTaskClaudeConfig(sandboxPath);

  return { worktreePath, sandboxPath };
}

/**
 * Write a task's artifacts into `<worktree>/.lazy-task-sandbox/artifacts/`.
 *
 * Wipe-and-rewrite, so the directory is always a faithful mirror of the store:
 * an artifact removed since the last turn disappears, and an agent's local edit
 * to a materialized file does not survive to look like an input. The store is
 * the source of truth; this directory is derived.
 *
 * Failures are NOT swallowed — an agent that silently loses its inputs will
 * produce confidently wrong work, so a launch that cannot deliver them fails.
 */
export async function materializeArtifacts(
  worktreePath: string,
  storage: Storage,
  taskId: string,
): Promise<number> {
  const dir = join(worktreePath, ARTIFACTS_SUBDIR);
  let artifacts;
  try {
    artifacts = await storage.listTaskArtifacts(taskId);
  } catch (err) {
    throw new Error(
      `Failed to list artifacts for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await rm(dir, { recursive: true, force: true });
  if (artifacts.length === 0) return 0;
  await mkdir(dir, { recursive: true });

  for (const meta of artifacts) {
    const full = await storage.getTaskArtifact(taskId, meta.name);
    if (!full) {
      // Listed a moment ago but gone now — a concurrent remove, not corruption.
      continue;
    }
    const dest = join(dir, meta.name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(full.content_base64, 'base64'));
  }
  return artifacts.length;
}
