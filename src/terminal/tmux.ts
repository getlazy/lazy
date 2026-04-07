/**
 * TmuxDriver — Terminal implementation for tmux environments.
 *
 * Detects tmux via $TMUX env var. Renames windows to reflect lazy activity,
 * restores them on exit, and supports read-only watching of agent sessions.
 */

import { spawnSync } from '../utils/spawn';
import type { Terminal, WatchResult } from './interface';

export class TmuxDriver implements Terminal {
  readonly isRich = true;

  private savedWindowName: string | null = null;
  private hasSetActivity = false;

  setActivity(activity: string): void {
    // Save original window name on first call
    if (!this.hasSetActivity) {
      this.savedWindowName = this.getCurrentWindowName();
      this.hasSetActivity = true;
    }

    this.tmuxRenameWindow(activity);
  }

  restoreTitle(): void {
    if (!this.hasSetActivity) return;

    if (this.savedWindowName !== null) {
      this.tmuxRenameWindow(this.savedWindowName);
    } else {
      // If we couldn't read the original name, re-enable automatic renaming
      this.tmuxSetAutomaticRename();
    }

    this.hasSetActivity = false;
    this.savedWindowName = null;
  }

  async watchTask(tmuxSessionName: string): Promise<WatchResult> {
    // Check if the target tmux session exists
    if (!this.tmuxSessionExists(tmuxSessionName)) {
      return {
        exitCode: 1,
        error: `Tmux session '${tmuxSessionName}' not found. The agent may have just finished.`,
      };
    }

    // Determine approach: if we're inside tmux, use switch-client.
    // Otherwise, attach to the session.
    const insideTmux = !!process.env.TMUX;

    if (insideTmux) {
      // Inside tmux: switch to the target session in read-only mode
      const result = spawnSync(
        ['tmux', 'switch-client', '-t', tmuxSessionName, '-r'],
        { stdin: 'inherit', stdout: 'inherit', stderr: 'pipe' },
      );
      const stderr = result.stderr.toString().trim();
      if (result.exitCode !== 0 && stderr) {
        return { exitCode: result.exitCode, error: stderr };
      }
      return { exitCode: result.exitCode };
    } else {
      // Outside tmux: attach read-only
      const result = spawnSync(
        ['tmux', 'attach-session', '-t', tmuxSessionName, '-r'],
        { stdin: 'inherit', stdout: 'inherit', stderr: 'pipe' },
      );
      const stderr = result.stderr.toString().trim();
      if (result.exitCode !== 0 && stderr) {
        return { exitCode: result.exitCode, error: stderr };
      }
      return { exitCode: result.exitCode };
    }
  }

  private getCurrentWindowName(): string | null {
    try {
      const result = spawnSync(
        ['tmux', 'display-message', '-p', '#{window_name}'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if (result.exitCode === 0) {
        return result.stdout.toString().trim() || null;
      }
    } catch {
      // tmux command failed — swallow
    }
    return null;
  }

  private tmuxRenameWindow(name: string): void {
    try {
      spawnSync(
        ['tmux', 'rename-window', name],
        { stdout: 'pipe', stderr: 'pipe' },
      );
    } catch {
      // Swallow errors — tmux may have died
    }
  }

  private tmuxSetAutomaticRename(): void {
    try {
      spawnSync(
        ['tmux', 'set-option', '-w', 'automatic-rename', 'on'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
    } catch {
      // Swallow errors
    }
  }

  private tmuxSessionExists(sessionName: string): boolean {
    try {
      const result = spawnSync(
        ['tmux', 'has-session', '-t', sessionName],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
