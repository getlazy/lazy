/**
 * The isolated `CODEX_HOME` a Codex builder runs in.
 *
 * Codex keeps everything a session is in one home: its rollouts (the
 * conversation it resumes from, under `sessions/YYYY/MM/DD/`), its state
 * database and the `config.toml` lazy rewrites before every launch. So:
 *
 *  - ONE HOME PER BUILDER RUN, never one per project or per member. Two
 *    builders of the same person running at once would otherwise write their
 *    rollouts side by side, and the capture monitor's "newest rollout since
 *    launch" would name the other builder's conversation as this one's resume
 *    target. Per run, ownership is the directory, not a guess.
 *  - RESUME FINDS THE HOME THAT HOLDS THE ROLLOUT. `codex resume <id>` only
 *    sees its own home, so a resumed conversation must run in the home it was
 *    recorded in, whichever run created it.
 *  - Homes live under a builder home OUTSIDE the project's data dir
 *    (src/builder/claude-home.ts explains why): only the one home a launch
 *    resolves is ever mounted into a container.
 *
 * Never the operator's real `~/.codex`: lazy owns this home's config.toml
 * outright (src/agent/codex-config.ts refuses to overwrite a file it did not
 * write), and a builder must not pick up the human's own Codex login.
 */

import { mkdir, readdir } from 'fs/promises';
import { join } from 'path';

/** Directory (under a builder home) holding one CODEX_HOME per builder run. */
export function codexHomesRoot(builderHomeDir: string): string {
  return join(builderHomeDir, 'codex-homes');
}

async function holdsRollout(dir: string, sessionId: string, depth = 0): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    // Bounded: rollouts live exactly at sessions/YYYY/MM/DD/.
    if (entry.isDirectory() && depth < 3) {
      if (await holdsRollout(join(dir, entry.name), sessionId, depth + 1)) return true;
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`${sessionId}.jsonl`)) {
      return true;
    }
  }
  return false;
}

/**
 * The CODEX_HOME for builder run `builderId`, created if needed. With
 * `resumeSessionId`, the existing home that already holds that conversation's
 * rollout wins, so `codex resume <id>` finds it.
 */
export async function resolveBuilderCodexHome(
  builderHomeDir: string,
  builderId: string,
  resumeSessionId: string | null,
): Promise<{ codexHome: string; holdsResume: boolean }> {
  if (resumeSessionId) {
    const holding = await findBuilderCodexHome(builderHomeDir, resumeSessionId);
    if (holding) return { codexHome: holding, holdsResume: true };
  }
  const codexHome = join(codexHomesRoot(builderHomeDir), builderId);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  return { codexHome, holdsResume: false };
}

/** The CODEX_HOME under `builderHomeDir` holding conversation `sessionId`'s rollout, or null. Creates nothing. */
export async function findBuilderCodexHome(builderHomeDir: string, sessionId: string): Promise<string | null> {
  const root = codexHomesRoot(builderHomeDir);
  let runs: string[] = [];
  try {
    runs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const run of runs) {
    const candidate = join(root, run);
    if (await holdsRollout(join(candidate, 'sessions'), sessionId)) return candidate;
  }
  return null;
}

/** Container path a Codex builder's home is mounted at. */
export const CONTAINER_CODEX_HOME = '/home/user/.codex';

/**
 * Host-side: the Codex conversation a builder run was on, from the rollouts in
 * its CODEX_HOME — the Codex half of src/builder/session-detect.ts, for the
 * same reason (a killed container never reaches the supervisor's exit stamp).
 * The newest rollout written since launch; else the resumed one, when it is
 * there; else null.
 */
export async function detectCodexBuilderSessionId(opts: {
  codexHome: string;
  launchedAtMs: number;
  resumeId: string | null;
}): Promise<string | null> {
  const { discoverCodexRollouts } = await import('../import/codex-builder-logs');
  const rollouts = await discoverCodexRollouts(opts.codexHome);
  const written = rollouts.filter((r) => r.mtimeMs >= opts.launchedAtMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (written[0]) return written[0].sessionId;
  if (opts.resumeId && rollouts.some((r) => r.sessionId === opts.resumeId)) return opts.resumeId;
  return null;
}
