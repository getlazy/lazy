/**
 * Purge pre-v0.20 per-task MCP configs that leaked the shared daemon token into
 * the repository, and rotate the token they leaked.
 *
 * THE LEAK. Before v0.20 (commit 01bd53f5) the daemon wrote each launch's MCP
 * config to `<project>/<dataDir>/tmp/daemon-mcp-<name>.json` — inside the repo,
 * at the default 0644, and containing the SHARED daemon bearer token. Three
 * facts make that live rather than historical:
 *
 *   - the shared token is reused across daemon restarts and never rotates;
 *   - every task container bind-mounts the whole repo read-only, so every agent
 *     that has ever run can read every one of those files;
 *   - `/rpc/*` on the TCP transport accepts `Bearer <shared token>`.
 *
 * So any agent could lift the token and call `/rpc/acceptTask`, `/rpc/closeTask`
 * and friends AS THE DAEMON. One project in the wild has 820 of these files.
 * v0.20 moved new configs to the daemon state dir (`~/.lazy/daemon/<slug>/mcp/`,
 * never mounted into an agent), but it left the old ones sitting in the repo.
 *
 * WHY THIS RIDES `lazy upgrade` rather than running on daemon start or as a
 * one-off command: deleting files and rotating a credential are exactly the kind
 * of side effect that must not surprise anyone mid-session. Upgrade is already
 * the moment when everything stops and restarts, and it is the human's explicit
 * action.
 *
 * WHY THE ROTATION IS SAFE HERE (blast radius). Deleting the files does not
 * un-leak a credential that has been readable by every agent for months, so the
 * token has to be replaced too — but a rotation that stranded a live session
 * would be worse than the leak. Who holds the shared token?
 *
 *   - Host CLI clients heal by themselves: `DaemonClient` re-reads the token
 *     file on a 401 and retries (src/daemon/client.ts).
 *   - Task and builder AGENTS do not hold it at all. Their `lazy_*` tools go to
 *     `/mcp/*`, which authenticates against the per-identity token registry
 *     (`~/.lazy/daemon/<slug>/mcp-tokens.json`) and REFUSES the shared token
 *     outright. Rotation cannot touch them.
 *   - That leaves in-container holders of the shared token — the only class
 *     that cannot re-read a host-side file. `purgeAndRotate` is called from the
 *     one point in the upgrade where that class is empty by construction: after
 *     every task and builder container has been stopped, and after the old
 *     daemon has fully exited, but before the new one starts and adopts a token.
 *
 * IDEMPOTENT: a project with no legacy files removes nothing and rotates
 * nothing, so the second upgrade in a row is a no-op.
 */

import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../cli/init';
import { generateToken } from '../daemon/lifecycle';

/**
 * Filename prefix of the leaked configs.
 *
 * Deliberately NOT imported from `src/daemon/task-launcher.ts`: this is a fixed
 * historical shape written by code that no longer exists, and it must keep
 * matching those files even if the live prefix is ever renamed.
 */
const LEGACY_PREFIX = 'daemon-mcp-';

/** Directory the pre-v0.20 daemon wrote per-launch MCP configs into. */
export function legacyMcpConfigDir(projectRoot: string): string {
  return join(projectRoot, getDataDir(projectRoot), 'tmp');
}

export interface LegacyMcpPurgeResult {
  /** Files successfully deleted. */
  removed: number;
  /** Files that matched but could not be deleted, with the reason. */
  failed: { path: string; reason: string }[];
  /** True when the shared daemon token was replaced. */
  rotated: boolean;
}

/**
 * List the legacy config files present. Used by `--dry-run` and by the purge.
 *
 * Only the in-repo legacy path is ever considered. The live per-identity configs
 * under `~/.lazy/daemon/<slug>/mcp/` are NOT touched: they are bind-mounted into
 * running containers, and deleting one breaks a live agent's tools.
 */
export async function findLegacyDaemonMcpConfigs(projectRoot: string): Promise<string[]> {
  const dir = legacyMcpConfigDir(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // No tmp dir at all is the normal case for a project that never ran a
    // pre-v0.20 daemon (or that has been cleaned already) — nothing to purge.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Failed to scan ${dir} for leaked MCP configs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return entries
    .filter(name => name.startsWith(LEGACY_PREFIX) && name.endsWith('.json'))
    .sort()
    .map(name => join(dir, name));
}

/**
 * Delete the legacy configs and, if any existed, rotate the shared daemon token.
 *
 * The rotation is conditional on an actual removal on purpose: a project that
 * never leaked has no credential to replace, and churning its token on every
 * upgrade would be an unexplained side effect. A project that DID leak gets
 * exactly one rotation, on the upgrade that cleans it up.
 *
 * MUST be called with every container for this project stopped and the old
 * daemon exited — see the blast-radius note at the top of this file.
 */
export async function purgeLegacyDaemonMcpConfigs(projectRoot: string): Promise<LegacyMcpPurgeResult> {
  const paths = await findLegacyDaemonMcpConfigs(projectRoot);
  const failed: { path: string; reason: string }[] = [];
  let removed = 0;

  for (const path of paths) {
    try {
      await unlink(path);
      removed++;
    } catch (err) {
      // Another process winning the race is a success, not a failure: the file
      // is gone, which is the whole objective.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        removed++;
        continue;
      }
      // Anything else (a read-only mount, a permission problem) is reported
      // rather than thrown: a file we could not delete must not abort an
      // upgrade that has already stopped every container.
      failed.push({ path, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Rotate only if the leak was real AND we actually closed it. Rotating while
  // unreadable copies of the old token remain would claim a fix we did not make.
  const rotated = removed > 0 && failed.length === 0;
  if (rotated) generateToken(projectRoot);

  return { removed, failed, rotated };
}

/**
 * Run the purge and report it. "Transparent over terse" (CLAUDE.md): removing
 * hundreds of files from someone's repo silently is not acceptable, and a
 * credential rotation must be stated outright.
 */
export async function purgeLegacyDaemonMcpConfigsReporting(
  projectRoot: string,
  out: (line: string) => void = console.log,
): Promise<LegacyMcpPurgeResult> {
  const result = await purgeLegacyDaemonMcpConfigs(projectRoot);
  if (result.removed === 0 && result.failed.length === 0) return result;

  const dir = legacyMcpConfigDir(projectRoot);
  if (result.removed > 0) {
    out(`\nRemoved ${result.removed} leaked pre-v0.20 MCP config(s) from ${dir}`);
    out('  (each contained the shared daemon token and was readable by every agent).');
  }
  for (const f of result.failed) {
    out(`  could not remove ${f.path}: ${f.reason}`);
  }
  if (result.rotated) {
    out('  Rotated the shared daemon token — the leaked one no longer works.');
  } else if (result.failed.length > 0) {
    out('  Shared daemon token NOT rotated: leaked copies remain. Fix the errors above and re-run `lazy upgrade`.');
  }
  return result;
}
