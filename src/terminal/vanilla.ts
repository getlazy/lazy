/**
 * VanillaTerminalDriver — no-op Terminal for non-tmux environments.
 *
 * All methods are no-ops or return appropriate error messages.
 * Zero overhead by design.
 */

import type { Terminal, WatchResult } from './interface';

export class VanillaTerminalDriver implements Terminal {
  readonly isRich = false;

  setActivity(_activity: string): void {
    // No-op outside tmux
  }

  restoreTitle(): void {
    // No-op outside tmux
  }

  async watchTask(_tmuxSessionName: string): Promise<WatchResult> {
    return {
      exitCode: 1,
      error: 'tmux is required for `lazy watch`. Install tmux and run inside a tmux session.',
    };
  }
}
