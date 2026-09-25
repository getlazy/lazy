/**
 * The port through which the web layer reads and designates the project's
 * Start services command.
 *
 * Same shape as DoctorActions / TaskActions: the web handler never opens the
 * store or lazy.toml for this itself and never shells out to a CLI. The daemon
 * injects an implementation over the project store (see src/serve/start-cmd.ts).
 * Without an injected port there is no Start services button, the designate
 * form is hidden and the POST answers 503.
 */

export interface ServeActions {
  /** The command Start services runs, or '' when none is designated. */
  getStartServicesCmd(): Promise<string>;
  /**
   * Persist a non-empty command as the project-wide Start services command.
   * Returns the trimmed value that was saved.
   */
  setStartServicesCmd(command: string): Promise<{ command: string }>;
  /**
   * Clear the project-wide command: no Start services until one is designated
   * again (and lazy.toml's old key is not read back). Returns `{ command: '' }`.
   */
  clearStartServicesCmd(): Promise<{ command: string }>;
}
