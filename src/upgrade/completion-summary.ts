/**
 * Final completion block for `lazy upgrade` and `lazy upgrade --images`.
 *
 * Image builds stream progress for minutes and scroll earlier prompts (press
 * Enter, working-task choices) off screen. The command must never end on build
 * noise alone — this block is printed last, after every rebuild and daemon
 * restart, so the human always sees what happened and what to expect next.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { getDaemonDir } from '../daemon/paths';
import { theme } from '../render/theme';
import {
  formatAgentBinaryRebuildSuccessLine,
  formatEmbeddedBuildProvenance,
  readEmbeddedBuildProvenance,
  type BuildInfoValues,
} from '../utils/build-provenance';

const MARKER_FILE = 'daemon-last-version.json';

interface VersionMarker {
  version: string;
}

/** Read the daemon version recorded at the previous startup, if any. */
export async function readPreviousDaemonVersion(projectRoot: string): Promise<string | null> {
  const markerPath = join(getDaemonDir(projectRoot), MARKER_FILE);
  try {
    const raw = await readFile(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as VersionMarker;
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unreadable marker — treat as unknown previous version rather than
      // fabricating a transition the upgrade notice would also skip.
    }
  }
  return null;
}

export interface FullUpgradeCompletionContext {
  previousVersion: string | null;
  currentVersion: string;
  /** Canonical image tag(s) promoted, or null when runner has no container image. */
  imageTags: string[] | null;
  /** Wall-clock seconds for the image rebuild step, when a container image was rebuilt. */
  imageBuildSeconds: number | null;
  /** Provenance from a source checkout compile in this process, when available. */
  agentBinaryProvenance: Pick<
    BuildInfoValues,
    'buildSourcePath' | 'buildBranch' | 'buildSha' | 'buildDirty'
  > | null;
  daemonRestarted: boolean;
  interruptedTaskCount: number;
  builderSessionCount: number;
  interactiveSessionCount: number;
}

export interface ImageRefreshCompletionContext {
  currentVersion: string;
  imageTags: string[];
}

function formatVersionTransition(previous: string | null, current: string): string {
  if (previous && previous !== current) return `${previous} → ${current}`;
  if (previous) return previous;
  return current;
}

async function formatEmbeddedBuildProvenanceLine(): Promise<string | null> {
  const embedded = await readEmbeddedBuildProvenance();
  if (!embedded) return null;
  const suffix = formatEmbeddedBuildProvenance(embedded);
  return suffix.length > 0 ? suffix.trim().replace(/^\(/, '').replace(/\)$/, '') : null;
}

function printCompletionHeader(title: string): void {
  console.log('');
  console.log(theme.separator('────────────────────────────────────────────────────────'));
  console.log(theme.success(theme.header(title)));
  console.log(theme.separator('────────────────────────────────────────────────────────'));
  console.log('');
}

/**
 * Print the load-bearing final block for a full `lazy upgrade`.
 * Call this as the last stdout write before the command returns.
 */
export async function printFullUpgradeCompletionSummary(
  ctx: FullUpgradeCompletionContext,
): Promise<void> {
  printCompletionHeader('Upgrade complete');

  console.log(`  ${theme.label('Version:')}     ${formatVersionTransition(ctx.previousVersion, ctx.currentVersion)}`);

  if (ctx.imageTags && ctx.imageTags.length > 0) {
    const timing = ctx.imageBuildSeconds != null ? ` (rebuilt in ${ctx.imageBuildSeconds}s)` : ' (rebuilt)';
    console.log(`  ${theme.label('Container image:')} ${ctx.imageTags.join(', ')}${timing}`);
  } else {
    console.log(`  ${theme.label('Container image:')} not rebuilt (host-process runner — no image)`);
  }

  const agentLine = formatAgentBinaryRebuildSuccessLine(ctx.agentBinaryProvenance);
  console.log(`  ${theme.label('Agent binary:')} ${agentLine}`);

  if (!ctx.agentBinaryProvenance) {
    const buildProvenance = await formatEmbeddedBuildProvenanceLine();
    if (buildProvenance) {
      console.log(`  ${theme.label('Build source:')} ${buildProvenance}`);
    }
  }

  if (ctx.daemonRestarted) {
    console.log(`  ${theme.label('Daemon:')} restarted with version ${ctx.currentVersion}`);
  } else {
    console.log(`  ${theme.label('Daemon:')} started with version ${ctx.currentVersion}`);
  }

  console.log('');

  const nextActions: string[] = [];
  if (ctx.builderSessionCount > 0) {
    const noun = ctx.builderSessionCount === 1 ? 'session' : 'sessions';
    nextActions.push(
      `${ctx.builderSessionCount} builder ${noun} will resume in place automatically`,
    );
  }
  if (ctx.interactiveSessionCount > 0) {
    const noun = ctx.interactiveSessionCount === 1 ? 'session' : 'sessions';
    nextActions.push(
      `${ctx.interactiveSessionCount} interactive ${noun} restart against the new daemon on their own`,
    );
  }
  if (ctx.interruptedTaskCount > 0) {
    const noun = ctx.interruptedTaskCount === 1 ? 'task' : 'tasks';
    nextActions.push(
      `${ctx.interruptedTaskCount} interrupted ${noun} will auto-resume within ~10 seconds`,
    );
  }

  if (nextActions.length > 0) {
    console.log(`  ${theme.label('Next:')}`);
    for (const line of nextActions) {
      console.log(`    • ${line}`);
    }
    console.log('');
    console.log('  Working agents and blocked tasks keep their current container until it is');
    console.log('  recreated — see when each session picks up the new image above.');
  } else {
    console.log(`  ${theme.label('Next:')} nothing else to do — new and resumed tasks use the rebuilt image.`);
  }

  console.log('');
}

/**
 * Print the final block for `lazy upgrade --images`.
 * Call this as the last stdout write before the command returns.
 */
export function printImageRefreshCompletionSummary(ctx: ImageRefreshCompletionContext): void {
  printCompletionHeader('Image refresh complete');

  console.log(`  ${theme.label('Version:')}     ${ctx.currentVersion} (lazy binary unchanged)`);
  console.log(`  ${theme.label('Container image:')} ${ctx.imageTags.join(', ')} (rebuilt with --no-cache)`);
  console.log(`  ${theme.label('Daemon:')} not restarted — running sessions unchanged`);
  console.log(`  ${theme.label('Agent binary:')} not rebuilt`);
  console.log('');
  console.log(`  ${theme.label('Next:')} running builders and agents were NOT touched. New, queued, and`);
  console.log('  interrupted-then-resumed tasks use the refreshed image immediately; everything');
  console.log('  else adopts it when its container is next recreated.');
  console.log('');
  console.log(`  For an immediate switch of everything, run ${theme.command('lazy upgrade')}.`);
  console.log('');
}
