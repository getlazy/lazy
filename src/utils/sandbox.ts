/**
 * Shared sandbox setup for task supervisors.
 *
 * Every code path that launches a supervisor (start, resume, sync, auto-resume,
 * auto-unblock) needs the same sandbox layout: a `.claude` directory and a
 * `.gitconfig` file inside the sandbox root. Without this, Docker creates
 * `.gitconfig` as an empty directory (because the bind-mount source doesn't
 * exist) and git operations inside the container have no user identity.
 */

import { join } from 'path';
import { mkdir, copyFile, writeFile, rm, appendFile } from 'fs/promises';
import { getHome } from './home';
import { pathExists, dirExists } from './fs';
import type { SandboxConfig } from '../capture/claude';

export const SANDBOX_DIR = '.lazy-task-sandbox';

const DEFAULT_GITCONFIG = '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n';

/** Appended to every sandbox gitconfig — see setupSandbox. */
const GC_OFF = '\n[gc]\n\tauto = 0\n';

/**
 * Create the sandbox directory layout for a worktree and return its config.
 *
 * Idempotent — safe to call repeatedly. Always rewrites `.gitconfig` to keep
 * it in sync with the host's, and removes any stale directory Docker may have
 * created at that path on a previous run.
 */
export async function setupSandbox(worktreePath: string): Promise<SandboxConfig> {
  const sandboxPath = join(worktreePath, SANDBOX_DIR);
  const claudeDir = join(sandboxPath, '.claude');
  await mkdir(claudeDir, { recursive: true });
  // Cursor's equivalent home-config dir. Created unconditionally (cheap, and
  // agent-agnostic callers don't need to know the task's agent): the container
  // bind-mounts it to /home/user/.cursor so a Cursor task's chat state lands in
  // the sandbox instead of vanishing with the container.
  await mkdir(join(sandboxPath, '.cursor'), { recursive: true });

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

  return { worktreePath, sandboxPath };
}
