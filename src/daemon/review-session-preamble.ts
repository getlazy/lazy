/**
 * Mechanistic review preamble assembly for UI builder review sessions.
 *
 * One daemon-side function builds the markdown context injected into the first
 * builder turn so the reviewer does not burn a discovery loop on lazy_search /
 * lazy_show / lazy_diff. Web code never calls this — only the review-session
 * launch path (and optional CLI debug seams) do.
 *
 * Section order and byte budgets match docs/reviews/ui-builder-review-session.md §3.
 */

import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { displayId, getBranchNameFromId, getWorktreePath, shortId } from '../task/identity';
import { loadConfig } from '../config/loader';
import { latestAgentWorkTurn } from '../task/turn-context';
import { pathExists } from '../utils/fs';
import type { Storage } from '../storage';
import type { RaisedItem, ReviewComment, Session, Task, Turn } from '../types';
import { formatDate } from '../utils/format';
import { parentTaskIdOf, targetBranchOf } from '../task-target';
import {
  branchExists,
  getDiffFull,
  getDiffStat,
  getRemoteDefaultBranch,
  recoverMissingWorktreeWithFetch,
} from '../git/operations';
import { runGit } from '../utils/git';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';

/** Last agent turn body budget (12 KiB). */
export const REPORT_BUDGET = 12 * 1024;

/** Newest review chunks to include. */
export const CHUNKS_N = 3;

/** Inline unified diff when total patch bytes are at or below this (48 KiB). */
export const DIFF_INLINE_BUDGET = 48 * 1024;

/** Top changed paths by insertions + deletions when the full diff is omitted. */
export const KEY_FILES_N = 15;

/** Absolute preamble ceiling; trim chunks then key-file detail if still over. */
export const PREAMBLE_HARD_CAP = 96 * 1024;

const REPORT_TRUNCATED_MARKER =
  '[truncated — use lazy_show sections=turns]';

const CHUNKS_TRUNCATED_MARKER =
  '[truncated — recent chunks omitted to fit preamble budget; use lazy_show sections=turns]';

const KEY_FILES_TRUNCATED_MARKER =
  '[truncated — key-file list omitted to fit preamble budget; use lazy_diff full: true]';

/** Git reads the assembler needs — inject in unit tests. */
export interface ReviewPreambleGitOps {
  getDiffStat(fromRef: string, worktreePath: string, twoDot: boolean): Promise<string>;
  getDiffFull(fromRef: string, worktreePath: string, twoDot: boolean): Promise<string>;
  getDiffNumstat(fromRef: string, worktreePath: string, twoDot: boolean): Promise<string>;
  resolveParentTipSha(parentBranch: string, worktreePath: string): Promise<string | null>;
  branchExists(branch: string, worktreePath: string): Promise<boolean>;
}

/** Everything loaded from Storage + git before markdown formatting. */
export interface ReviewPreambleInputs {
  task: Task;
  session: Session;
  parentTask: Task | null;
  raisedItems: RaisedItem[];
  pendingAsks: ReviewComment[];
  turns: Turn[];
  worktreePath: string;
  parentBranch: string;
  fromRef: string;
  useTwoDotDiff: boolean;
  parentTipSha: string | null;
}

export interface ReviewPreambleSectionOptions {
  includeChunks?: boolean;
  includeKeyFiles?: boolean;
  includeInlineDiff?: boolean;
}

const defaultGitOps: ReviewPreambleGitOps = {
  async getDiffStat(fromRef, worktreePath, twoDot) {
    return getDiffStat(fromRef, 'HEAD', worktreePath, twoDot);
  },
  async getDiffFull(fromRef, worktreePath, twoDot) {
    return getDiffFull(fromRef, 'HEAD', worktreePath, twoDot);
  },
  async getDiffNumstat(fromRef, worktreePath, twoDot) {
    const range = twoDot ? `${fromRef}..HEAD` : `${fromRef}...HEAD`;
    const result = await runGit(['diff', '--no-color', '--numstat', range], { cwd: worktreePath });
    return result.exitCode === 0 ? result.stdout : '';
  },
  async resolveParentTipSha(parentBranch, worktreePath) {
    const result = await runGit(['rev-parse', '--short', parentBranch], { cwd: worktreePath });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  },
  branchExists,
};

/** UTF-8 byte length — budgets are in bytes, not code points. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = new TextEncoder().encode(text);
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function truncateWithMarker(
  text: string,
  budget: number,
  marker: string,
): { text: string; truncated: boolean } {
  if (utf8ByteLength(text) <= budget) {
    return { text, truncated: false };
  }
  const markerBytes = utf8ByteLength(`\n\n${marker}`);
  const bodyBudget = Math.max(0, budget - markerBytes);
  return {
    text: `${truncateUtf8(text, bodyBudget)}\n\n${marker}`,
    truncated: true,
  };
}

/** One-line preview for chunk / ask lines — first line, whitespace collapsed. */
export function oneLinePreview(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function boundaryActorLabel(turn: Turn): string {
  if (turn.role !== 'human') return turn.role;
  if (turn.actor && turn.actor !== 'human') return turn.actor;
  return 'human';
}

function formatIdentitySection(input: ReviewPreambleInputs): string {
  const { task, session, parentTask, turns, parentBranch, parentTipSha } = input;
  const lastAgent = latestAgentWorkTurn(turns);
  const model = lastAgent?.model ?? task.model ?? 'unknown';
  const effort = lastAgent?.effort ?? task.metadata?.effort ?? 'unknown';

  const lines: string[] = ['### Identity'];
  lines.push(`- **code:** ${task.code ?? '(none)'}`);
  lines.push(`- **id:** ${task.id}`);
  lines.push(`- **type:** ${task.type}`);
  lines.push(`- **status:** ${task.status}`);
  lines.push(`- **agent:** ${task.agent_id}`);
  lines.push(`- **model:** ${model}`);
  lines.push(`- **effort:** ${effort}`);
  lines.push(`- **goal:** ${task.goal}`);
  if (parentTask) {
    lines.push(`- **parent:** ${displayId(parentTask)} — ${parentTask.goal}`);
  } else {
    lines.push('- **parent:** top-level');
  }
  lines.push(`- **branch:** ${session.git_branch}`);
  lines.push(`- **parent branch:** ${parentBranch}${parentTipSha ? ` @ ${parentTipSha}` : ''}`);
  return lines.join('\n');
}

function formatOpenItemsSection(input: ReviewPreambleInputs): string | null {
  const { raisedItems, pendingAsks } = input;
  const open = raisedItems.filter(i => i.status === 'open');
  // Blocking first: those are the ones accept refuses on, so the reviewer must
  // see them before the orthogonal notes.
  const blocking = open.filter(i => i.blocking);
  const nonBlocking = open.filter(i => !i.blocking);
  if (open.length === 0 && pendingAsks.length === 0) {
    return null;
  }

  const lines: string[] = ['### Open items'];
  if (blocking.length > 0) {
    lines.push('- **raised items (blocking — accept refuses while open):**');
    for (const item of blocking) {
      lines.push(`  - ${shortId(item.id)} (${formatDate(item.created_at)}) ${item.content}`);
    }
  }
  if (nonBlocking.length > 0) {
    lines.push('- **raised items (non-blocking):**');
    for (const item of nonBlocking) {
      lines.push(`  - ${shortId(item.id)} (${formatDate(item.created_at)}) ${item.content}`);
    }
  }
  if (pendingAsks.length > 0) {
    lines.push(`- **pending review-ask threads:** ${pendingAsks.length}`);
    for (const ask of pendingAsks) {
      lines.push(`  - \`${ask.file}:${ask.line}\` — ${oneLinePreview(ask.content)}`);
    }
  }
  return lines.join('\n');
}

function formatLatestAgentReportSection(turns: Turn[]): string {
  // The WORK turn. The reviewer is being shown what the implementer said about
  // its work, and every turn ends with supervised closing steps whose replies
  // are newer and say nothing about it (latestAgentWorkTurn).
  const lastAgent = latestAgentWorkTurn(turns);
  const body = lastAgent?.content ?? '(no agent turn yet)';
  const { text } = truncateWithMarker(body, REPORT_BUDGET, REPORT_TRUNCATED_MARKER);
  return ['### Latest agent report', text].join('\n\n');
}

function formatRecentChunksSection(turns: Turn[]): string | null {
  const ascending = [...turns].sort((a, b) => a.sequence - b.sequence);
  const chunks = groupTurnsIntoChunks(ascending);
  if (chunks.length === 0) return null;

  const selected = chunks.slice(-CHUNKS_N).reverse();
  const lines: string[] = [
    `### Recent review chunks (newest first, max ${CHUNKS_N})`,
  ];

  for (const chunk of selected) {
    const chunkNum = chunk.index + 1;
    const boundary = chunk.boundary;
    if (boundary) {
      const actor = boundaryActorLabel(boundary);
      lines.push(
        `- **Chunk ${chunkNum}** — ${actor}: ${oneLinePreview(boundary.content)}`,
      );
    } else {
      lines.push(`- **Chunk ${chunkNum}** — (leading automation, no human boundary)`);
    }
    for (const turn of chunk.turns) {
      if (boundary && turn.id === boundary.id) continue;
      if (turn.role === 'agent') {
        lines.push(`  - agent: ${oneLinePreview(turn.content)}`);
      } else if (turn.role === 'human') {
        const actor = boundaryActorLabel(turn);
        const auto = turn.auto_triggered ? ' (auto)' : '';
        lines.push(`  - ${actor}${auto}: ${oneLinePreview(turn.content)}`);
      }
    }
  }

  lines.push('');
  lines.push('Full turn bodies: `lazy_show sections=turns`.');
  return lines.join('\n');
}

/** Parse `git diff --numstat` lines into path → insertions + deletions. */
export function parseNumstatChurn(numstat: string): Array<{ path: string; churn: number }> {
  const files: Array<{ path: string; churn: number }> = [];
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) continue;
    const ins = match[1] === '-' ? 0 : Number.parseInt(match[1], 10);
    const del = match[2] === '-' ? 0 : Number.parseInt(match[2], 10);
    const path = match[3].includes(' => ')
      ? match[3].split(' => ').pop()!.trim()
      : match[3].trim();
    files.push({ path, churn: ins + del });
  }
  files.sort((a, b) => b.churn - a.churn);
  return files;
}

/** Extract per-file stat lines from `git diff --stat` (excludes the summary line). */
export function parseDiffStatFileLines(stat: string): string[] {
  return stat
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.includes('|') && !l.includes('files changed'));
}

export async function formatDiffOverviewSection(
  input: ReviewPreambleInputs,
  git: ReviewPreambleGitOps,
  options: ReviewPreambleSectionOptions = {},
): Promise<string> {
  const includeInline = options.includeInlineDiff !== false;
  const includeKeyFiles = options.includeKeyFiles !== false;
  const { fromRef, useTwoDotDiff, worktreePath, parentBranch, session } = input;
  const diffRange = useTwoDotDiff ? `${fromRef}..HEAD` : `${fromRef}...HEAD`;

  const [stat, fullDiff, numstat] = await Promise.all([
    git.getDiffStat(fromRef, worktreePath, useTwoDotDiff),
    includeInline ? git.getDiffFull(fromRef, worktreePath, useTwoDotDiff) : Promise.resolve(''),
    includeKeyFiles ? git.getDiffNumstat(fromRef, worktreePath, useTwoDotDiff) : Promise.resolve(''),
  ]);

  const lines: string[] = ['### Diff overview'];
  lines.push(`- **range:** \`${diffRange}\` (branch \`${session.git_branch}\` vs \`${parentBranch}\`)`);

  if (stat.trim()) {
    lines.push('');
    lines.push('```');
    lines.push(stat.trimEnd());
    lines.push('```');
  } else {
    lines.push('');
    lines.push('(no diff stat — tree matches base or diff unavailable)');
  }

  const fileLines = parseDiffStatFileLines(stat);
  if (fileLines.length > 0) {
    lines.push('');
    lines.push('- **changed files:**');
    for (const fl of fileLines) {
      lines.push(`  - ${fl.trim()}`);
    }
  }

  const diffBytes = utf8ByteLength(fullDiff);
  if (includeInline && fullDiff && diffBytes <= DIFF_INLINE_BUDGET) {
    lines.push('');
    lines.push('**Full diff (inline):**');
    lines.push('');
    lines.push('```diff');
    lines.push(fullDiff.trimEnd());
    lines.push('```');
  } else if (fullDiff) {
    lines.push('');
    lines.push(
      `Full diff omitted (${diffBytes} bytes). Use \`lazy_diff\` with \`full: true\` or Read on paths below.`,
    );
    if (includeKeyFiles) {
      const top = parseNumstatChurn(numstat).slice(0, KEY_FILES_N);
      if (top.length > 0) {
        lines.push('');
        lines.push(`**Top ${Math.min(KEY_FILES_N, top.length)} paths by churn:**`);
        for (const { path, churn } of top) {
          lines.push(`- \`${path}\` (+/- ${churn})`);
        }
      }
    } else {
      lines.push('');
      lines.push(KEY_FILES_TRUNCATED_MARKER);
    }
  }

  return lines.join('\n');
}

function formatHeaderSection(task: Task): string {
  const code = displayId(task);
  return [
    `## Review session — ${code} (${shortId(task.id)})`,
    '',
    'You are reviewing this task. The context below was assembled by lazy from',
    'store + git — do NOT spend a turn rediscovering it. Use tools only to drill',
    'into specifics (a file\'s full diff, an older turn, a sibling task).',
  ].join('\n');
}

function formatHowToUseSection(): string {
  return [
    '### How to use this session',
    '- Answer the human\'s questions about THIS task.',
    '- Prefer the injected context; tool-call only to drill down.',
    '- You may leave journal notes; do not accept/reject unless the human asks.',
  ].join('\n');
}

function formatFixedCloserSection(): string {
  return 'Open items and initial read first; then wait for the human.';
}

/**
 * Build markdown sections from loaded inputs. Used by production and unit tests.
 */
export async function buildReviewPreambleSections(
  input: ReviewPreambleInputs,
  git: ReviewPreambleGitOps = defaultGitOps,
  options: ReviewPreambleSectionOptions = {},
): Promise<string[]> {
  const sections: string[] = [
    formatHeaderSection(input.task),
    formatIdentitySection(input),
  ];

  const openItems = formatOpenItemsSection(input);
  if (openItems) sections.push(openItems);

  sections.push(formatLatestAgentReportSection(input.turns));

  if (options.includeChunks !== false) {
    const chunks = formatRecentChunksSection(input.turns);
    if (chunks) sections.push(chunks);
  }

  sections.push(await formatDiffOverviewSection(input, git, options));
  sections.push(formatHowToUseSection());
  sections.push(formatFixedCloserSection());

  return sections;
}

/**
 * Apply PREAMBLE_HARD_CAP: drop chunks, then key-file detail, never silently.
 */
export function applyPreambleHardCap(sections: string[]): string {
  let working = [...sections];
  let markdown = working.join('\n\n');
  if (utf8ByteLength(markdown) <= PREAMBLE_HARD_CAP) {
    return markdown;
  }

  const hadChunks = working.some(s => s.startsWith('### Recent review chunks'));
  if (hadChunks) {
    working = working.filter(s => !s.startsWith('### Recent review chunks'));
    const openIdx = working.findIndex(s => s.startsWith('### Open items'));
    const insertAt = openIdx >= 0
      ? openIdx + 1
      : working.findIndex(s => s.startsWith('### Latest agent report')) + 1;
    working.splice(Math.max(insertAt, 1), 0, CHUNKS_TRUNCATED_MARKER);
    markdown = working.join('\n\n');
    if (utf8ByteLength(markdown) <= PREAMBLE_HARD_CAP) {
      return markdown;
    }
  }

  const diffIdx = working.findIndex(s => s.startsWith('### Diff overview'));
  if (diffIdx >= 0) {
    const diffLines = working[diffIdx].split('\n');
    const trimmed = diffLines.filter(
      l =>
        !l.startsWith('**Top ') &&
        !l.startsWith('- `') &&
        !l.includes('paths by churn') &&
        l !== KEY_FILES_TRUNCATED_MARKER,
    );
    trimmed.push('');
    trimmed.push(KEY_FILES_TRUNCATED_MARKER);
    working[diffIdx] = trimmed.join('\n');
  }

  return working.join('\n\n');
}

export async function assembleReviewPreambleFromInputs(
  input: ReviewPreambleInputs,
  git: ReviewPreambleGitOps = defaultGitOps,
): Promise<string> {
  const sections = await buildReviewPreambleSections(input, git);
  return applyPreambleHardCap(sections);
}

/**
 * Resolve diff base the same way as handleDiff in rpc-handlers.ts — do not
 * fork this logic elsewhere.
 */
export async function resolveReviewDiffBase(
  projectRoot: string,
  task: Task,
  session: Session,
  storage: Storage,
  worktreePath: string,
  git: ReviewPreambleGitOps = defaultGitOps,
): Promise<{ fromRef: string; useTwoDotDiff: boolean; parentBranch: string }> {
  const parentId = parentTaskIdOf(task);
  const diffConfig = await loadConfig(projectRoot);
  const parentBranch = parentId
    ? await getBranchNameFromId(parentId, storage)
    : (targetBranchOf(task) ?? await getRemoteDefaultBranch(projectRoot, diffConfig.remote.git_remote));

  if (await git.branchExists(parentBranch, worktreePath)) {
    return { fromRef: parentBranch, useTwoDotDiff: false, parentBranch };
  }
  if (session.upstream_merge_sha) {
    return { fromRef: session.upstream_merge_sha, useTwoDotDiff: true, parentBranch };
  }
  return { fromRef: parentBranch, useTwoDotDiff: false, parentBranch };
}

export async function loadReviewPreambleInputs(
  projectRoot: string,
  taskId: string,
  storage: Storage,
  git: ReviewPreambleGitOps = defaultGitOps,
): Promise<ReviewPreambleInputs> {
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) {
    throw new RpcError(404, `Task not found: ${taskId}`);
  }
  const task = resolved.task;

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    throw new RpcError(400, `Task ${displayId(task)} has no session`);
  }

  const worktreePath = getWorktreePath(projectRoot, task);
  if (!(await pathExists(worktreePath))) {
    const branchName = session.git_branch;
    const config = await loadConfig(projectRoot);
    try {
      const recovery = await recoverMissingWorktreeWithFetch(
        worktreePath,
        branchName,
        config.remote.git_remote,
        projectRoot,
      );
      if (!recovery.recovered) {
        throw new RpcError(
          400,
          `Worktree is gone and branch '${branchName}' not found locally or on remote.`,
        );
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(
        400,
        `Failed to recover worktree: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { fromRef, useTwoDotDiff, parentBranch } = await resolveReviewDiffBase(
    projectRoot,
    task,
    session,
    storage,
    worktreePath,
    git,
  );

  const parentId = parentTaskIdOf(task);
  const parentTask = parentId ? await storage.getTask(parentId) : null;

  const [raisedItems, reviewComments, turns, parentTipSha] = await Promise.all([
    storage.getTaskRaisedItems(task.id),
    storage.getTaskReviewComments(task.id),
    storage.getSessionTurns(session.id),
    git.resolveParentTipSha(parentBranch, worktreePath),
  ]);

  const pendingAsks = reviewComments.filter(
    c => c.role === 'human' && c.intent !== 'comment' && c.ask_state === 'pending',
  );

  return {
    task,
    session,
    parentTask,
    raisedItems,
    pendingAsks,
    turns,
    worktreePath,
    parentBranch,
    fromRef,
    useTwoDotDiff,
    parentTipSha,
  };
}

/**
 * Assemble the full review preamble markdown for a task.
 *
 * Daemon-side only. Reads Storage + git; web code never calls this.
 */
export async function assembleReviewPreamble(
  projectRoot: string,
  taskId: string,
): Promise<string> {
  const storage = await getOrCreateStorage();
  const input = await loadReviewPreambleInputs(projectRoot, taskId, storage);
  return assembleReviewPreambleFromInputs(input);
}
