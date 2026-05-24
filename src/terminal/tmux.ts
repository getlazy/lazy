/**
 * TmuxDriver — Terminal implementation for tmux environments.
 *
 * Detects tmux via $TMUX env var. Supports read-only watching of agent sessions.
 */

import { spawnSync } from '../utils/spawn';
import type { Terminal, WatchResult } from './interface';

export class TmuxDriver implements Terminal {
  readonly isRich = true;

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
