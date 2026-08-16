/**
 * `lazy system status` — print the current system state for this project.
 *
 * A compact, scannable readout of the project-wide state that isn't otherwise
 * visible from any single command:
 *
 *   - Offline vs online (the reason this exists — offline mode silently forces
 *     the LocalDriver, so sync/push become no-ops and there was no way to see it).
 *   - The remote driver in effect (and the configured driver when offline
 *     suspends it), plus the git remote name.
 *   - Whether the daemon is running.
 *   - The storage backend.
 *   - lazy version and project root.
 *
 * This is a read-only diagnostic. For the full health sweep (Docker, locks,
 * orphaned containers, etc.) use `lazy doctor`.
 */

import { join } from 'path';
import { requireLazyRoot } from '../helpers';
import { loadConfig } from '../../config/loader';
import { resolveOfflineStatus, formatOfflineExpiry } from '../../utils/offline';
import { isDaemonRunning, readPid } from '../../daemon';
import { theme } from '../theme';
import { VERSION } from '../../version';
import { builderScratchDir } from '../../builder/scratch';

const LABEL_WIDTH = 11;

function line(label: string, value: string): void {
  console.log(`  ${(label + ':').padEnd(LABEL_WIDTH)} ${value}`);
}

export async function commandSystemStatus(_args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const config = await loadConfig(root);
  const offline = await resolveOfflineStatus(dataDir, config.remote.offline);
  const configuredDriver = config.remote.driver;

  console.log(theme.header('System status'));
  console.log('');

  line('Version', `v${VERSION}`);
  line('Project', root);
  console.log('');

  // ── Offline/online — the headline state ──────────────────────────────────
  // Always surface when offline expires (or that it never will) — no silent
  // indefinite offline.
  if (offline.offline) {
    const suspended = offline.configuredDriver ?? configuredDriver;
    // e.g. "OFFLINE — auto-resumes in 6h (00:00 local)" or, for the config
    // flag, "OFFLINE — permanent (set in lazy.toml) — does not auto-resume".
    line('Mode', theme.warning(`OFFLINE — ${formatOfflineExpiry(offline)}`));
    const since = offline.enabledAt ? ` since ${offline.enabledAt}` : '';
    console.log(`              Remote operations are skipped${since}.`);
    if (suspended && suspended !== 'local') {
      console.log(`              Configured driver "${suspended}" is suspended.`);
    }
    if (offline.permanent) {
      console.log(`              Remove ${theme.command('[remote] offline')} from lazy.toml to go back online.`);
    } else {
      console.log(`              Run ${theme.command('lazy system online')} to restore remote operations.`);
    }
  } else {
    line('Mode', theme.success('ONLINE'));
  }
  console.log('');

  // ── Remote driver / git remote ───────────────────────────────────────────
  // Offline mode forces the LocalDriver regardless of configuration, so the
  // effective driver is what actually runs — surface both when they differ.
  if (offline.offline && configuredDriver !== 'local') {
    line('Driver', `local (offline — configured: ${configuredDriver})`);
  } else {
    line('Driver', configuredDriver);
  }
  line('Remote', config.remote.git_remote);

  // ── Storage backend ──────────────────────────────────────────────────────
  line('Storage', config.storage.backend);

  // ── Builder scratch dir ──────────────────────────────────────────────────
  // Where builder artifacts land. Named here because it lives outside the repo,
  // so nothing else would ever lead the human to it. Size and cleanup guidance
  // belong to `lazy doctor` (single warning surface), not here.
  line('Scratch', builderScratchDir(root));

  // ── Daemon ───────────────────────────────────────────────────────────────
  // Cheap liveness check (flock + PID alive) — no socket RPC. Use
  // `lazy daemon status` for uptime/web port/health details.
  if (isDaemonRunning(root)) {
    const pid = readPid(root);
    line('Daemon', theme.success(`running${pid ? ` (PID ${pid})` : ''}`));
  } else {
    line('Daemon', 'not running');
  }
}

export function systemStatusUsage(): void {
  console.log(`Usage: lazy system status

Print the current system state for this project: offline/online mode,
remote driver, git remote, storage backend, daemon, and lazy version.

This is a read-only diagnostic. For a full health sweep (Docker, locks,
orphaned containers, image freshness), use ${theme.command('lazy doctor')}.

Examples:
  lazy system status            # Show current system state`);
}
