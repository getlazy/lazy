/**
 * Doctor remedy flags — preview and apply, with no CLI, no prompts, no
 * process.exit.
 *
 * The CLI (`src/cli/commands/doctor-remedies.ts`) still owns printing and
 * confirmation. This module is what the daemon (and so the Settings page)
 * calls: list what a flag would touch, then act. Detection stays in
 * `./findings.ts` so a check can never report something a flag would not
 * act on.
 *
 * Apply never asks. The caller (CLI prompt, web dialog confirm) decides
 * whether to call it. Destructive flags are marked so the web dialog can
 * show the dry-run list and require an extra click.
 */

import { join } from 'path';
import { loadConfig } from '../config/loader';
import { cleanupWorktree } from '../task/cleanup';
import { createRunnerFromType } from '../runner';
import { removeLazyImage, resolveImageName } from '../capture/claude';
import { runGit } from '../utils/git';
import {
  listMissingConversationsByImportability,
  reimportConversations,
} from '../import/reimport-conversations';
import { countImportableMemories, importHarnessMemory } from '../import/import-harness-memory';
import { applyLocalCommandCleanup, elideSummary } from '../import/local-command-cleanup';
import type { Storage } from '../storage/interface';
import {
  describeWorktreeReclaim,
  findOrphanedContainers,
  findResumableTasks,
  findStaleLazyImages,
  findLocalCommandConversations,
  findTerminalTaskWorktrees,
  findTrackedTaskBranches,
  formatDiskBytes,
  StaleImageScanError,
} from './findings';

/** Every `lazy doctor --<flag>` the Settings page can run. */
export const DOCTOR_REMEDY_FLAGS = [
  'clean-worktrees',
  'clean-docker-images',
  'clean-orphaned-containers',
  'unset-upstream-tracking',
  'resume-interrupted-tasks',
  'reimport-conversations',
  'import-memory',
  'clean-local-command-conversations',
] as const;

export type DoctorRemedyFlag = (typeof DOCTOR_REMEDY_FLAGS)[number];

/**
 * Flags that remove disk, containers, or stored content — the dialog must show
 * the list first.
 *
 * The conversation cleanup is here because it drops messages out of rows that
 * are already in the store. It never deletes a row (see
 * `src/import/local-command-cleanup.ts`), but "fewer messages than before" is
 * still a one-way edit to stored history, and a human should see which
 * conversations before clicking.
 */
export const DESTRUCTIVE_REMEDY_FLAGS: ReadonlySet<DoctorRemedyFlag> = new Set([
  'clean-worktrees',
  'clean-docker-images',
  'clean-orphaned-containers',
  'clean-local-command-conversations',
]);

const REMEDY_TITLES: Record<DoctorRemedyFlag, string> = {
  'clean-worktrees': 'Remove finished-task worktrees',
  'clean-docker-images': 'Remove stale lazy images',
  'clean-orphaned-containers': 'Remove orphaned lazy containers',
  'unset-upstream-tracking': 'Unset leftover upstream tracking',
  'resume-interrupted-tasks': 'Resume interrupted tasks now',
  'reimport-conversations': 'Re-import missing conversations',
  'import-memory': 'Import harness memory records',
  'clean-local-command-conversations': 'Clean local-command noise out of stored conversations',
};

export function isDoctorRemedyFlag(value: string): value is DoctorRemedyFlag {
  return (DOCTOR_REMEDY_FLAGS as readonly string[]).includes(value);
}

export function isDestructiveRemedy(flag: DoctorRemedyFlag): boolean {
  return DESTRUCTIVE_REMEDY_FLAGS.has(flag);
}

export function remedyTitle(flag: DoctorRemedyFlag): string {
  return REMEDY_TITLES[flag];
}

/** One line of live narration while a remedy runs. */
export interface DoctorRemedyProgressEvent {
  label: string;
  state: 'start' | 'ok' | 'error' | 'done';
  detail?: string;
}

/** What a flag would touch — the dry-run the dialog shows before acting. */
export interface DoctorRemedyPreview {
  flag: DoctorRemedyFlag;
  title: string;
  items: string[];
  notes: string[];
  empty: boolean;
  emptyMessage: string;
  destructive: boolean;
}

/** Outcome after apply. `failed` is true when anything in the batch did not land. */
export interface DoctorRemedyResult {
  flag: DoctorRemedyFlag;
  message: string;
  done: number;
  total: number;
  failed: boolean;
  lines: string[];
}

/**
 * What a remedy is allowed to see.
 *
 * `storage` is the caller's handle — the daemon passes the one it already
 * holds so we never open a second FileStorage against that lock. `resumeTask`
 * is injected because starting a turn is a daemon operation; the CLI supplies
 * the same RPC `lazy resume` uses, the daemon supplies `resumeTask` in-process.
 */
export interface RemedyContext {
  root: string;
  storage: Storage;
  onProgress?: (event: DoctorRemedyProgressEvent) => void;
  resumeTask?: (taskId: string) => Promise<{ warnings: string[] }>;
}

function emit(ctx: RemedyContext, event: DoctorRemedyProgressEvent): void {
  ctx.onProgress?.(event);
}

function previewOf(
  flag: DoctorRemedyFlag,
  items: string[],
  notes: string[],
  emptyMessage: string,
): DoctorRemedyPreview {
  return {
    flag,
    title: remedyTitle(flag),
    items,
    notes,
    empty: items.length === 0,
    emptyMessage,
    destructive: isDestructiveRemedy(flag),
  };
}

function resultOf(
  flag: DoctorRemedyFlag,
  verb: string,
  done: number,
  total: number,
  noun: string,
  lines: string[],
): DoctorRemedyResult {
  return {
    flag,
    message: `${verb} ${done} of ${total} ${noun}.`,
    done,
    total,
    failed: done < total,
    lines,
  };
}

/** Probe the container runtime the way the CLI remedies do — never a silent empty list. */
async function runtimeUnavailable(binary: 'docker' | 'podman'): Promise<string | null> {
  try {
    await createRunnerFromType(binary).checkAvailability();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function dataDirAbs(root: string): Promise<string> {
  const config = await loadConfig(root);
  return join(root, config.data.path);
}

async function runnerTypeOf(root: string): Promise<string> {
  const config = await loadConfig(root);
  return config.runner?.type ?? 'docker';
}

export async function previewRemedy(flag: DoctorRemedyFlag, ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  switch (flag) {
    case 'clean-worktrees': return previewCleanWorktrees(ctx);
    case 'clean-docker-images': return previewCleanDockerImages(ctx);
    case 'clean-orphaned-containers': return previewCleanOrphanedContainers(ctx);
    case 'unset-upstream-tracking': return previewUnsetUpstream(ctx);
    case 'resume-interrupted-tasks': return previewResumeInterrupted(ctx);
    case 'reimport-conversations': return previewReimportConversations(ctx);
    case 'import-memory': return previewImportMemory(ctx);
    case 'clean-local-command-conversations': return previewCleanLocalCommandConversations(ctx);
  }
}

export async function applyRemedy(flag: DoctorRemedyFlag, ctx: RemedyContext): Promise<DoctorRemedyResult> {
  switch (flag) {
    case 'clean-worktrees': return applyCleanWorktrees(ctx);
    case 'clean-docker-images': return applyCleanDockerImages(ctx);
    case 'clean-orphaned-containers': return applyCleanOrphanedContainers(ctx);
    case 'unset-upstream-tracking': return applyUnsetUpstream(ctx);
    case 'resume-interrupted-tasks': return applyResumeInterrupted(ctx);
    case 'reimport-conversations': return applyReimportConversations(ctx);
    case 'import-memory': return applyImportMemory(ctx);
    case 'clean-local-command-conversations': return applyCleanLocalCommandConversations(ctx);
  }
}

async function previewCleanWorktrees(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const worktrees = await findTerminalTaskWorktrees(ctx.root, ctx.storage);
  return previewOf(
    'clean-worktrees',
    worktrees.map(w => `${w.taskCode} ${w.status} — ${w.path} (${formatDiskBytes(w.sizeBytes)})`),
    worktrees.length > 0
      ? [`${describeWorktreeReclaim(worktrees)} for tasks that are finished.`, 'Branches are kept — only the working trees are removed.']
      : [],
    'No worktrees for finished tasks — nothing to clean up.',
  );
}

async function applyCleanWorktrees(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const worktrees = await findTerminalTaskWorktrees(ctx.root, ctx.storage);
  emit(ctx, { label: `Removing ${worktrees.length} worktree(s)`, state: 'start' });
  const lines: string[] = [];
  let done = 0;
  for (const w of worktrees) {
    try {
      await cleanupWorktree(w.path, ctx.root, ctx.storage, w.taskId, w.sessionId);
      const line = `Removed ${w.path} (${formatDiskBytes(w.sizeBytes)})`;
      lines.push(line);
      emit(ctx, { label: w.taskCode, state: 'ok', detail: line });
      done++;
    } catch (err) {
      const line = `Failed to remove ${w.path}: ${err instanceof Error ? err.message : String(err)}`;
      lines.push(line);
      emit(ctx, { label: w.taskCode, state: 'error', detail: line });
    }
  }
  const result = resultOf('clean-worktrees', 'Removed', done, worktrees.length, 'worktree(s)', lines);
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

async function previewCleanDockerImages(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const runnerType = await runnerTypeOf(ctx.root);
  if (runnerType !== 'docker' && runnerType !== 'podman') {
    return previewOf('clean-docker-images', [], [], `Runner is ${runnerType} — there are no lazy container images to clean up.`);
  }
  const unavailable = await runtimeUnavailable(runnerType);
  if (unavailable) {
    throw new Error(`Cannot reach ${runnerType} — ${unavailable}`);
  }
  const imageName = await resolveImageName(ctx.root);
  let stale;
  try {
    stale = await findStaleLazyImages(imageName, runnerType, ctx.root, ctx.storage);
  } catch (err) {
    throw new Error(
      err instanceof StaleImageScanError
        ? `Cannot list stale images — ${err.message}`
        : `Cannot list stale images — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return previewOf(
    'clean-docker-images',
    stale.map(image => `${image.ref} (${image.size})`),
    stale.length > 0
      ? [`${imageName}, the daemon-adopted image and every task-pinned image are excluded.`]
      : [],
    'No stale lazy images — nothing to clean up.',
  );
}

async function applyCleanDockerImages(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const runnerType = await runnerTypeOf(ctx.root);
  if (runnerType !== 'docker' && runnerType !== 'podman') {
    return resultOf('clean-docker-images', 'Removed', 0, 0, 'image(s)', [
      `Runner is ${runnerType} — there are no lazy container images to clean up.`,
    ]);
  }
  const unavailable = await runtimeUnavailable(runnerType);
  if (unavailable) {
    throw new Error(`Cannot reach ${runnerType} — ${unavailable}`);
  }
  const imageName = await resolveImageName(ctx.root);
  const stale = await findStaleLazyImages(imageName, runnerType, ctx.root, ctx.storage);
  emit(ctx, { label: `Removing ${stale.length} image(s)`, state: 'start' });
  const lines: string[] = [];
  let done = 0;
  for (const image of stale) {
    const removal = await removeLazyImage(image.ref, runnerType);
    if (removal.ok) {
      const line = `Removed ${image.ref} (${image.size})`;
      lines.push(line);
      emit(ctx, { label: image.ref, state: 'ok', detail: line });
      done++;
    } else {
      const line = `Failed to remove ${image.ref}: ${removal.error.split('\n')[0]}`;
      lines.push(line);
      emit(ctx, { label: image.ref, state: 'error', detail: line });
    }
  }
  const result = resultOf('clean-docker-images', 'Removed', done, stale.length, 'image(s)', lines);
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

async function previewCleanOrphanedContainers(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const runnerType = await runnerTypeOf(ctx.root);
  if (runnerType !== 'docker' && runnerType !== 'podman') {
    return previewOf('clean-orphaned-containers', [], [], `Runner is ${runnerType} — there are no lazy containers to clean up.`);
  }
  const unavailable = await runtimeUnavailable(runnerType);
  if (unavailable) {
    throw new Error(`Cannot reach ${runnerType} — ${unavailable}`);
  }
  const orphans = await findOrphanedContainers(ctx.root, ctx.storage, runnerType);
  return previewOf(
    'clean-orphaned-containers',
    orphans.map(o => {
      const why = o.running
        ? `running for ${o.taskStatus} task ${o.taskCode}`
        : `${o.state}, task ${o.taskCode} is ${o.taskStatus}`;
      return `${o.name} — ${why}`;
    }),
    [],
    'No orphaned lazy containers — nothing to clean up.',
  );
}

async function applyCleanOrphanedContainers(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const runnerType = await runnerTypeOf(ctx.root);
  if (runnerType !== 'docker' && runnerType !== 'podman') {
    return resultOf('clean-orphaned-containers', 'Removed', 0, 0, 'container(s)', [
      `Runner is ${runnerType} — there are no lazy containers to clean up.`,
    ]);
  }
  const unavailable = await runtimeUnavailable(runnerType);
  if (unavailable) {
    throw new Error(`Cannot reach ${runnerType} — ${unavailable}`);
  }
  const orphans = await findOrphanedContainers(ctx.root, ctx.storage, runnerType);
  // Config-free constructor: removing a container needs no proxy, and a cleanup
  // that only works while the daemon is reachable would be useless in the
  // wedged state this flag exists for.
  const runner = createRunnerFromType(runnerType);
  emit(ctx, { label: `Removing ${orphans.length} container(s)`, state: 'start' });
  const lines: string[] = [];
  let done = 0;
  for (const o of orphans) {
    try {
      await runner.removeRun(o.name);
      if (await runner.runExists(o.name)) {
        const line = `Failed to remove ${o.name} — still present afterwards`;
        lines.push(line);
        emit(ctx, { label: o.name, state: 'error', detail: line });
        continue;
      }
      if (o.sessionId) await ctx.storage.updateSessionContainerName(o.sessionId, null);
      const line = `Removed ${o.name}`;
      lines.push(line);
      emit(ctx, { label: o.name, state: 'ok', detail: line });
      done++;
    } catch (err) {
      const line = `Failed to remove ${o.name}: ${err instanceof Error ? err.message : String(err)}`;
      lines.push(line);
      emit(ctx, { label: o.name, state: 'error', detail: line });
    }
  }
  const result = resultOf('clean-orphaned-containers', 'Removed', done, orphans.length, 'container(s)', lines);
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

async function previewUnsetUpstream(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const tracked = await findTrackedTaskBranches(ctx.root);
  return previewOf(
    'unset-upstream-tracking',
    tracked.map(t => {
      const target = t.merge ?? '(no merge ref)';
      const flag = t.mismatched ? ' ← a git pull on this branch merges a DIFFERENT branch' : '';
      return `${t.branch} → ${t.remote} ${target}${flag}`;
    }),
    tracked.length > 0
      ? ['Unsetting only removes .git/config entries. No branch, commit or remote ref is touched.']
      : [],
    'No task branches have upstream tracking — nothing to unset.',
  );
}

async function applyUnsetUpstream(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const tracked = await findTrackedTaskBranches(ctx.root);
  emit(ctx, { label: `Unsetting tracking on ${tracked.length} branch(es)`, state: 'start' });
  const lines: string[] = [];
  let done = 0;
  for (const t of tracked) {
    const failures: string[] = [];
    for (const key of [`branch.${t.branch}.remote`, `branch.${t.branch}.merge`]) {
      const why = await unsetLocalGitKey(ctx.root, key);
      if (why) failures.push(why);
    }
    if (failures.length === 0) {
      const line = `Unset tracking on ${t.branch}`;
      lines.push(line);
      emit(ctx, { label: t.branch, state: 'ok', detail: line });
      done++;
    } else {
      const line = `Failed to unset ${t.branch}: ${failures[0]}`;
      lines.push(line);
      emit(ctx, { label: t.branch, state: 'error', detail: line });
    }
  }
  const result = resultOf('unset-upstream-tracking', 'Unset tracking on', done, tracked.length, 'branch(es)', lines);
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

/**
 * Remove one git config key from the repository, or say why it is still there.
 * Returns null on success (including "was already absent"). Same read-back as
 * the CLI: `--unset-all`, then confirm the key is gone.
 */
async function unsetLocalGitKey(root: string, key: string): Promise<string | null> {
  const unset = await runGit(['config', '--unset-all', key], { cwd: root, timeout: 5_000 });
  const after = await runGit(['config', '--show-origin', '--get-all', key], {
    cwd: root,
    stderr: 'ignore',
    timeout: 5_000,
  });
  if (after.exitCode !== 0 || !after.stdout.trim()) return null;
  const origin = after.stdout.trim().split('\n')[0]?.split(/\s+/)[0] ?? 'an unknown config file';
  const stderr = unset.stderr.trim().split('\n')[0];
  return (
    `${key} is still set in ${origin}` +
    (stderr ? ` (${stderr})` : '') +
    ` — remove it there, e.g. \`git config --global --unset-all ${key}\``
  );
}

async function previewResumeInterrupted(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const resumable = await findResumableTasks(ctx.storage);
  return previewOf(
    'resume-interrupted-tasks',
    resumable.map(t => `${t.taskCode}${t.runName ? ` (last run ${t.runName})` : ''}`),
    resumable.length > 0
      ? [
          'A running daemon re-offers these each tick; a stop, the interruption circuit breaker or the auto-react budget can veto it. This starts them now.',
        ]
      : [],
    'No interrupted tasks — nothing to resume.',
  );
}

async function applyResumeInterrupted(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  if (!ctx.resumeTask) {
    throw new Error('Resuming interrupted tasks is not available from this server.');
  }
  const resumable = await findResumableTasks(ctx.storage);
  emit(ctx, { label: `Resuming ${resumable.length} task(s)`, state: 'start' });
  const lines: string[] = [];
  let done = 0;
  for (const t of resumable) {
    try {
      const result = await ctx.resumeTask(t.taskId);
      for (const warning of result.warnings) lines.push(warning);
      const line = `Resumed ${t.taskCode}`;
      lines.push(line);
      emit(ctx, { label: t.taskCode, state: 'ok', detail: line });
      done++;
    } catch (err) {
      const line = `Failed to resume ${t.taskCode}: ${err instanceof Error ? err.message : String(err)}`;
      lines.push(line);
      emit(ctx, { label: t.taskCode, state: 'error', detail: line });
    }
  }
  const result = resultOf('resume-interrupted-tasks', 'Resumed', done, resumable.length, 'task(s)', lines);
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

async function previewReimportConversations(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  // reimportConversations always writes. Preview uses the sweep's own
  // non-writing discovery so opening the dialog cannot import anything.
  const dataDir = await dataDirAbs(ctx.root);
  const { recoverable } = await listMissingConversationsByImportability({
    lazyRoot: ctx.root,
    dataDirAbs: dataDir,
    storage: ctx.storage,
  });
  return previewOf(
    'reimport-conversations',
    recoverable.map(m => m.sessionId),
    recoverable.length > 0
      ? ['Already-imported sessions are skipped. Empty session files are skipped.']
      : [],
    'No conversations on disk are missing from the store — nothing to import.',
  );
}

async function applyReimportConversations(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const dataDir = await dataDirAbs(ctx.root);
  emit(ctx, { label: 'Re-importing conversations from disk', state: 'start' });
  const report = await reimportConversations({
    lazyRoot: ctx.root,
    dataDirAbs: dataDir,
    storage: ctx.storage,
    onImported: (info) => {
      emit(ctx, {
        label: info.sessionId,
        state: 'ok',
        detail: `${info.messageCount} message(s)`,
      });
    },
  });
  const lines: string[] = [
    `Imported ${report.imported.length}.`,
    report.skippedAlready.length ? `Skipped ${report.skippedAlready.length} already imported.` : '',
    report.skippedEmpty.length ? `Skipped ${report.skippedEmpty.length} empty.` : '',
    report.errors.length ? `${report.errors.length} failed.` : '',
  ].filter(Boolean);
  for (const err of report.errors) {
    lines.push(`${err.sessionId}: ${err.error.message}`);
    emit(ctx, { label: err.sessionId, state: 'error', detail: err.error.message });
  }
  const total = report.imported.length + report.errors.length;
  const result = resultOf(
    'reimport-conversations',
    'Imported',
    report.imported.length,
    total === 0 ? report.imported.length : total,
    'conversation(s)',
    lines,
  );
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

async function previewImportMemory(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const dataDir = await dataDirAbs(ctx.root);
  const missing = await countImportableMemories({
    lazyRoot: ctx.root,
    dataDirAbs: dataDir,
    storage: ctx.storage,
  });
  return previewOf(
    'import-memory',
    missing > 0 ? [`${missing} harness memory record(s) not yet in lazy's shared memory`] : [],
    missing > 0 ? ['Already-present names are skipped. Records are stored as written.'] : [],
    'No harness memory records found on disk that lazy is missing — nothing to import.',
  );
}

async function applyImportMemory(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const dataDir = await dataDirAbs(ctx.root);
  emit(ctx, { label: 'Importing harness memory records', state: 'start' });
  const report = await importHarnessMemory({
    lazyRoot: ctx.root,
    dataDirAbs: dataDir,
    storage: ctx.storage,
    onImported: (info) => {
      emit(ctx, { label: info.name, state: 'ok' });
    },
  });
  const lines: string[] = [
    `Imported ${report.imported.length}.`,
    report.skippedExisting.length ? `Skipped ${report.skippedExisting.length} already present.` : '',
    report.skippedEmpty.length ? `Skipped ${report.skippedEmpty.length} empty.` : '',
    report.errors.length ? `${report.errors.length} failed.` : '',
  ].filter(Boolean);
  for (const err of report.errors) {
    lines.push(`${err.name}: ${err.error.message}`);
    emit(ctx, { label: err.name, state: 'error', detail: err.error.message });
  }
  const total = report.imported.length + report.errors.length;
  const result = resultOf(
    'import-memory',
    'Imported',
    report.imported.length,
    total === 0 ? report.imported.length : total,
    'record(s)',
    lines,
  );
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}

/**
 * Preview the local-command conversation cleanup.
 *
 * Rows that would be left with nothing at all are NOT in `items`: they are not
 * acted on. They are named in the notes so the count a human sees here matches
 * the count doctor's check reports, and so nobody has to wonder whether the
 * remedy quietly deleted them.
 *
 * Deleting those rows is deliberately NOT reachable from here. The daemon path
 * behind this module is what the Settings page's one-click remedy calls, and a
 * permanent delete belongs behind a flag typed on purpose — same posture as
 * `--purge-housekeeping-conversations`, which has no web surface either.
 */
async function previewCleanLocalCommandConversations(ctx: RemedyContext): Promise<DoctorRemedyPreview> {
  const plan = await findLocalCommandConversations(ctx.storage);
  const notes: string[] = [];
  if (plan.rewrites.length > 0) {
    notes.push(
      'Only Claude Code local-command scaffolding is dropped — the caveat, a built-in slash ' +
      'command and its output. Every other message is kept, and each summary becomes the ' +
      'first thing the human actually said.',
    );
  }
  if (plan.emptied.length > 0) {
    notes.push(
      `${plan.emptied.length} conversation(s) hold nothing but scaffolding. They are left exactly ` +
      `as they are: this path never deletes a stored conversation. Deleting them is opt-in on ` +
      `the CLI only — lazy doctor --clean-local-command-conversations ` +
      `--delete-empty-local-command-conversations.`,
    );
  }
  return previewOf(
    'clean-local-command-conversations',
    plan.rewrites.map(
      item => `${item.sessionId.substring(0, 8)} — ${item.removed} scaffolding message(s); ` +
        `summary becomes "${elideSummary(item.cleaned!.summary)}"`,
    ),
    notes,
    plan.emptied.length > 0
      ? `No stored conversation would gain a real summary (${plan.emptied.length} hold nothing but ` +
        `scaffolding and are never touched).`
      : `No stored conversation carries local-command scaffolding — nothing to clean up.`,
  );
}

async function applyCleanLocalCommandConversations(ctx: RemedyContext): Promise<DoctorRemedyResult> {
  const plan = await findLocalCommandConversations(ctx.storage);
  emit(ctx, { label: `Cleaning ${plan.rewrites.length} conversation(s)`, state: 'start' });
  const lines: string[] = [];
  const { rewritten, errors } = await applyLocalCommandCleanup(ctx.storage, plan, item => {
    const line = `Cleaned ${item.sessionId.substring(0, 8)} (${item.removed} message(s) dropped)`;
    lines.push(line);
    emit(ctx, { label: item.sessionId.substring(0, 8), state: 'ok', detail: line });
  });
  for (const { sessionId, error } of errors) {
    const line = `Failed to clean ${sessionId.substring(0, 8)}: ${error.message}`;
    lines.push(line);
    emit(ctx, { label: sessionId.substring(0, 8), state: 'error', detail: line });
  }
  if (plan.emptied.length > 0) {
    lines.push(
      `${plan.emptied.length} conversation(s) hold nothing but scaffolding and were left untouched.`,
    );
  }
  const result = resultOf(
    'clean-local-command-conversations',
    'Cleaned',
    rewritten,
    plan.rewrites.length,
    'conversation(s)',
    lines,
  );
  emit(ctx, { label: result.message, state: 'done' });
  return result;
}
