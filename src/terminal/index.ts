/**
 * Terminal abstraction — factory + re-exports.
 *
 * Usage:
 *   import { createTerminal } from '../terminal';
 *   const terminal = createTerminal();
 *   await terminal.watchTask(sessionName);
 */

export type { Terminal, WatchResult } from './interface';
export { TmuxDriver } from './tmux';
export { VanillaTerminalDriver } from './vanilla';

import { TmuxDriver } from './tmux';
import { VanillaTerminalDriver } from './vanilla';
import type { Terminal } from './interface';

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
