/**
 * `[remote] <driver>_auto_push` — the one place the auto-push opt-out is read.
 *
 * WHAT THE SETTING MEANS: "do not push my task branches behind my back". It
 * governs the AUTOMATIC pushes only — the ones lazy fires on its own schedule,
 * with no user command behind them:
 *
 *   - the post-turn push from the daemon's reconcile loop (src/daemon/push.ts)
 *   - the background sync tick's branch export (src/daemon/remote-sync.ts)
 *   - the best-effort push at the end of a pairing session
 *
 * It is deliberately NOT a global "never push". Pushes a merge depends on for
 * correctness stay unconditional: `lazy accept` must push the parent branch
 * before (and after) a merge or origin drifts permanently behind local — see
 * the "Fail hard on remote failures" invariant in CLAUDE.md — and `lazy submit`
 * cannot open a PR for a branch the forge cannot see. Those are the user asking
 * for a remote operation by name, which is the opposite of "behind my back".
 *
 * Keys are per-driver (`github_auto_push`, `gitlab_auto_push`) because each
 * driver's `validateConfig` advertises its own; a driver with no such key —
 * the local driver, which never pushes at all — is simply always enabled here
 * and short-circuits later on `needsSync`.
 */

import type { ResolvedConfig } from '../config/types';

/**
 * Whether lazy may push task branches automatically for this project.
 *
 * @param config - The resolved project config.
 * @returns false only when the active driver's `_auto_push` key is set to false.
 */
export function autoPushEnabled(config: ResolvedConfig): boolean {
  switch (config.remote.driver) {
    case 'github':
      return config.remote.github_auto_push;
    case 'gitlab':
      return config.remote.gitlab_auto_push;
    default:
      return true;
  }
}

/**
 * Human-readable name of the key that turned auto-push off, for log lines that
 * explain a skipped push. Returns null when the active driver has no such key.
 */
export function autoPushConfigKey(config: ResolvedConfig): string | null {
  switch (config.remote.driver) {
    case 'github':
      return '[remote] github_auto_push';
    case 'gitlab':
      return '[remote] gitlab_auto_push';
    default:
      return null;
  }
}
