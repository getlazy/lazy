/**
 * Terminal abstraction for observing agent sessions.
 *
 * Implementations:
 * - TmuxDriver: supports read-only watching of agent sessions inside tmux
 * - VanillaTerminalDriver: no-op fallback for non-tmux environments
 */

export interface Terminal {
  /** Whether this terminal supports rich features (e.g. tmux session watching) */
  readonly isRich: boolean;

  /**
   * Watch a task's agent session read-only.
   * @param tmuxSessionName - The tmux session name to attach to (e.g. "lazy-abc12345")
   * @returns Promise that resolves when the watch session ends
   */
  watchTask(tmuxSessionName: string): Promise<WatchResult>;
}

export interface WatchResult {
  /** Exit code of the tmux attach/switch command */
  exitCode: number;
  /** Error message if the watch failed to start */
  error?: string;
}
