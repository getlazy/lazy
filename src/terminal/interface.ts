/**
 * Terminal abstraction for managing window titles and observing agent sessions.
 *
 * Implementations:
 * - TmuxDriver: renames tmux windows to reflect activity, supports read-only watching
 * - VanillaTerminalDriver: no-op fallback for non-tmux environments
 */

export interface Terminal {
  /** Set the terminal/window title for the current activity (e.g. "lazy builder") */
  setActivity(activity: string): void;

  /** Restore the previous window title (call on exit/cleanup) */
  restoreTitle(): void;

  /** Whether this terminal supports rich features (tmux window naming, watching) */
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
