/**
 * `lazy system offline` / `lazy system online` commands
 *
 * Toggle offline mode for working without network access.
 * Offline mode is per-project (${projectRoot}/.lazy/offline.json) — each
 * project has its own toggle since different projects may use different
 * services (GitLab vs Ollama).
 *
 * When offline mode is enabled:
 * - Remote operations (push, fetch, sync, PR creation) are skipped
 * - Task start uses local HEAD instead of fetching from remote
 * - Accept performs local squash merge (no remote API calls)
 * - Submit is blocked with a clear error
 * - The daemon stops sync/push background operations
 *
 * Use `lazy system offline` before boarding a plane, `lazy system online` when
 * you land.
 */

import { join } from 'path';
import { requireLazyRoot } from '../helpers';
import { loadConfig } from '../../config/loader';
import { setOfflineMode, getOfflineStatus } from '../../utils/offline';
import { theme } from '../theme';

export async function commandOffline(_args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const status = await getOfflineStatus(dataDir);
  if (status.enabled) {
    console.log('Already in offline mode.');
    console.log(`  Run ${theme.command('lazy system online')} when network is available.`);
    return;
  }

  const config = await loadConfig(root);
  const driver = config.remote.driver;
  await setOfflineMode(dataDir, true, driver);

  console.log(theme.success('Offline mode enabled.'));
  if (driver !== 'local') {
    console.log(`  Remote driver "${driver}" operations will be skipped.`);
  }
  console.log('');
  console.log('  What works offline:');
  console.log('    - Creating and starting tasks (local HEAD)');
  console.log('    - Running agents (with Ollama or cached models)');
  console.log('    - Accepting tasks (local squash merge)');
  console.log('    - Reviewing, rejecting, closing tasks');
  console.log('');
  console.log('  What is deferred until online:');
  console.log('    - Pushing branches to remote');
  console.log('    - Creating/updating PRs');
  console.log('    - Syncing with upstream');
  console.log('');
  console.log('  The daemon will stop remote operations on the next tick.');
  console.log(`  Run ${theme.command('lazy system online')} to restore remote operations.`);
}

export async function commandOnline(_args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const status = await getOfflineStatus(dataDir);
  if (!status.enabled) {
    console.log('Already online.');
    return;
  }

  await setOfflineMode(dataDir, false);

  console.log(theme.success('Online mode restored.'));
  if (status.configured_driver && status.configured_driver !== 'local') {
    console.log(`  Remote driver "${status.configured_driver}" operations will resume.`);
    console.log(`  The daemon will sync on the next tick.`);
  }
}

export function offlineUsage(): void {
  console.log(`Usage: lazy system offline

Enable offline mode for this project. All remote operations (push, fetch,
sync, PR creation) are skipped. Tasks start from local HEAD, accept
performs local squash merge.

Use before going offline (e.g., boarding a plane). Run 'lazy system online'
when network access is restored.

What works offline:
  - Creating and starting tasks
  - Running agents (requires Ollama or local models)
  - Accepting tasks (local squash merge)
  - Reviewing, rejecting, closing tasks

What is deferred:
  - Branch pushing, PR creation, remote sync

Equivalent to: lazy config set offline on

Examples:
  lazy system offline           # Enable offline mode
  lazy system online            # Restore remote operations`);
}

export function onlineUsage(): void {
  console.log(`Usage: lazy system online

Disable offline mode and restore remote operations (push, fetch, sync,
PR creation). The daemon will resume syncing on the next tick.

Equivalent to: lazy config set offline off

Examples:
  lazy system online            # Restore remote operations
  lazy system offline           # Go back to offline mode`);
}
