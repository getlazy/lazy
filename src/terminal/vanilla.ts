/**
 * VanillaTerminalDriver — no-op Terminal for non-tmux environments.
 *
 * Zero overhead by design.
 */

import type { Terminal, WatchResult } from './interface';

export class VanillaTerminalDriver implements Terminal {
  readonly isRich = false;

  async watchTask(_tmuxSessionName: string): Promise<WatchResult> {
    return {
      exitCode: 1,
      error: 'tmux is required for `lazy watch`. Install tmux and run inside a tmux session.',
    };
  }
}
