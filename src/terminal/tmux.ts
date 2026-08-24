/**
 * TmuxDriver — Terminal implementation for tmux environments.
 *
 * Detects tmux via $TMUX env var. Supports read-only watching of agent sessions.
 */

import { spawnSyncInteractive, spawnSyncUnsupervised } from '../utils/spawn';
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
      // Interactive by construction: both calls below hand the terminal to tmux
      // for as long as the human watches, so they must never be timed out —
      // killing a live session mid-use is a bug, not a backstop.
      // Inside tmux: switch to the target session in read-only mode
      const result = spawnSyncInteractive(
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
      const result = spawnSyncInteractive(
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
      // Unsupervised, unlike the attach/switch calls above: nobody is watching
      // this probe, and a hung tmux server must not wedge the CLI. 5s overrides
      // the (much longer) default backstop — a `has-session` is instant or broken.
      const result = spawnSyncUnsupervised(
        ['tmux', 'has-session', '-t', sessionName],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
