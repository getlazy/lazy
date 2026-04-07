/**
 * Terminal abstraction — factory + re-exports.
 *
 * Usage:
 *   import { createTerminal } from '../terminal';
 *   const terminal = createTerminal();
 *   terminal.setActivity('lazy builder');
 */

export type { Terminal, WatchResult } from './interface';
export { TmuxDriver } from './tmux';
export { VanillaTerminalDriver } from './vanilla';

import { TmuxDriver } from './tmux';
import { VanillaTerminalDriver } from './vanilla';
import type { Terminal } from './interface';
import { spawnSync } from '../utils/spawn';
import { which } from 'bun';

/**
 * Create a Terminal instance based on the current environment.
 * Returns TmuxDriver if running inside tmux, VanillaTerminalDriver otherwise.
 */
export function createTerminal(): Terminal {
  if (process.env.TMUX) {
    return new TmuxDriver();
  }
  return new VanillaTerminalDriver();
}

/**
 * Generate a predictable tmux session name for a task.
 * Used by the supervisor when creating agent sessions, and by `lazy watch` to find them.
 */
export function tmuxSessionName(taskShortId: string): string {
  return `lazy-${taskShortId}`;
}

/**
 * Create a detached tmux session for a task's agent run.
 * The session follows the container/process output, allowing `lazy watch` to attach.
 * No-op if tmux is not installed.
 *
 * @param sessionName  - Tmux session name (from tmuxSessionName())
 * @param followCmd    - Command to run in the session (e.g., ['docker', 'logs', '-f', containerName])
 */
export function createTmuxWatchSession(sessionName: string, followCmd: string[]): boolean {
  if (!which('tmux')) return false;

  try {
    // Kill any existing session with the same name (stale from previous run)
    spawnSync(['tmux', 'kill-session', '-t', sessionName], {
      stdout: 'pipe', stderr: 'pipe',
    });
  } catch {
    // No existing session — fine
  }

  try {
    const result = spawnSync(
      ['tmux', 'new-session', '-d', '-s', sessionName, ...followCmd],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Kill a detached tmux watch session for a task.
 * Called during cleanup when a task finishes.
 */
export function killTmuxWatchSession(sessionName: string): void {
  if (!which('tmux')) return;

  try {
    spawnSync(['tmux', 'kill-session', '-t', sessionName], {
      stdout: 'pipe', stderr: 'pipe',
    });
  } catch {
    // Best effort — session may already be gone
  }
}
