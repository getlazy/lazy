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
import { setOfflineMode, resolveOfflineStatus, formatOfflineExpiry } from '../../utils/offline';
import { theme } from '../theme';

export async function commandOffline(_args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const config = await loadConfig(root);
  const status = await resolveOfflineStatus(dataDir, config.remote.offline);

  // Permanent offline is configured — the temporary command is a no-op. Tell
  // the user how to leave it rather than writing a redundant temporary file.
  if (status.permanent) {
    console.log('Already offline — permanently, via lazy.toml.');
    console.log(`  ${theme.label('[remote] offline = true')} keeps remote operations off indefinitely.`);
    console.log(`  Remove that flag from lazy.toml to go back online (this command would not change anything).`);
    return;
  }

  if (status.temporary) {
    console.log(`Already in offline mode — ${formatOfflineExpiry(status)}.`);
    console.log(`  Run ${theme.command('lazy system online')} to restore remote operations now.`);
    return;
  }

  const driver = config.remote.driver;
  await setOfflineMode(dataDir, true, driver);
  const enabled = await resolveOfflineStatus(dataDir, config.remote.offline);

  console.log(theme.success(`Offline mode enabled — ${formatOfflineExpiry(enabled)}.`));
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
  console.log(`  This is temporary: it auto-recovers at local midnight, or run`);
  console.log(`  ${theme.command('lazy system online')} to restore remote operations sooner.`);
  console.log(`  To stay offline permanently, set ${theme.label('offline = true')} under ${theme.label('[remote]')} in lazy.toml.`);
}

export async function commandOnline(_args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const config = await loadConfig(root);
  const status = await resolveOfflineStatus(dataDir, config.remote.offline);

  // Clear any temporary offline file first (cheap, idempotent). This never
  // touches lazy.toml — permanent offline is the user's config to remove.
  await setOfflineMode(dataDir, false);

  if (status.permanent) {
    // Principle of least surprise: do NOT silently rewrite lazy.toml.
    console.log(theme.warning('Still offline — permanent offline is set in lazy.toml.'));
    console.log(`  ${theme.label('[remote] offline = true')} keeps remote operations off and does not auto-recover.`);
    console.log(`  To go online, remove that flag from lazy.toml.`);
    return;
  }

  if (!status.temporary) {
    console.log('Already online.');
    return;
  }

  console.log(theme.success('Online mode restored.'));
  if (status.configuredDriver && status.configuredDriver !== 'local') {
    console.log(`  Remote driver "${status.configuredDriver}" operations will resume.`);
    console.log(`  The daemon will sync on the next tick.`);
  }
}

export function offlineUsage(): void {
  console.log(`Usage: lazy system offline

Enable offline mode for this project. All remote operations (push, fetch,
sync, PR creation) are skipped. Tasks start from local HEAD, accept
performs local squash merge.

This is TEMPORARY: offline mode auto-recovers at the next local midnight, so
you can't get stranded offline after forgetting to come back. The output and
'lazy system status' always show when it expires. Run 'lazy system online' to
restore remote operations sooner.

To stay offline PERMANENTLY (e.g. an air-gapped or Ollama-only project), set
'offline = true' under '[remote]' in lazy.toml instead. That is not subject to
the midnight auto-expiry, and 'lazy system online' will not clear it — remove
the flag from lazy.toml to go back online.

What works offline:
  - Creating and starting tasks
  - Running agents (requires Ollama or local models)
  - Accepting tasks (local squash merge)
  - Reviewing, rejecting, closing tasks

What is deferred:
  - Branch pushing, PR creation, remote sync

Equivalent to: lazy config set offline on

Examples:
  lazy system offline           # Enable temporary offline (auto-recovers at midnight)
  lazy system online            # Restore remote operations now`);
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
