/**
 * Ask a TASK a question when its live agent session cannot be resumed.
 *
 * The task ask everyone knows (`launchAskTask`) resumes the agent's live
 * session inside the task's worktree: it needs an unended session, an
 * `agent_session_id`, a worktree that still exists, and a task paused at
 * `blocked`/`conflict`. For a finished task — accepted, closed, or merely
 * complete — those are exactly the things that are gone, and the surfaces used
 * to answer with a refusal telling the reviewer to "re-send it once the task is
 * blocked", advice a completed task can never satisfy.
 *
 * This module is the other half. It answers from what lazy STORED about the
 * task — its goal and prompt, every turn of its conversation, its raised items,
 * its commits, and its diff where one can still be produced — by handing that
 * record to a throwaway read-only one-shot, exactly as the stored-conversation
 * ask does (src/conversation/ask.ts). The map-reduce is shared between them
 * (src/oneshot/ask-engine.ts).
 *
 * TWO RULES, both load-bearing:
 *
 * 1. **It never pretends to be the live agent.** The answer is derived from the
 *    record, and every surface says so — the prompt tells the model it is
 *    reading history, and `AskTaskResult.derivedFrom` carries the provenance to
 *    the CLI, the MCP tool and the web thread.
 *
 * 2. **It writes nothing to the task.** No turn is created (the session may
 *    have ended, and an ended session must not grow new turns), no status is
 *    touched, no worktree lock is taken, no queued feedback is consumed. A
 *    question about a finished task is a READ of it. The web surface persists
 *    its own question and answer as review comments, which is a separate
 *    durable channel that starts no turn.
 */

import { loadConfig } from '../config/loader';
import { getDiffFull } from '../git/operations';
import { chunkParts, runAskEngine, type AskChunk, type AskPart } from '../oneshot/ask-engine';
import { raisedDisplayBody } from '../raised/title';
import { resolveTaskDiffBase } from '../task-diff-base';
import { logger } from '../utils/logger';
import { pathExists } from '../utils/fs';
import { getWorktreePathForRef, taskRef, displayId } from './identity';
import { currentPromptOf } from '../task-prompt';
import type { Storage } from '../storage/interface';
import type { Commit, RaisedItem, Session, Task, TokenUsage, Turn } from '../types';

import singleTemplate from '../prompts/task-record-ask-single.md' with { type: 'text' };
import mapTemplate from '../prompts/task-record-ask-map.md' with { type: 'text' };
import reduceTemplate from '../prompts/task-record-ask-reduce.md' with { type: 'text' };

/**
 * Cap on the diff text handed to the ask, in characters.
 *
 * A diff is the one part of a task's record with no natural bound — a
 * dependency bump or a generated-file churn can be megabytes. Past this, the
 * diff is replaced by its file list: dozens of map passes over vendored lock
 * files answer no question and cost real money, and the commit SHAs are in the
 * prompt so the model can read any file it actually needs read-only.
 */
export const DIFF_CHARS_BUDGET = 400_000;

export interface TaskRecordAskResult {
  answer: string;
  chunks: number;
  relevantChunks: number;
  usage: TokenUsage;
  warnings: string[];
}

export interface TaskRecordAskOptions {
  /** Progress sink; one short line per milestone. */
  onProgress?: (message: string) => void;
}

/** One line per identifying fact, so the model can place what it is reading. */
function renderMetadata(task: Task, session: Session | null, turnCount: number): string {
  const lines = [
    `- Task: ${displayId(task)}`,
    `- Goal: ${task.goal}`,
    `- Status: ${task.status}`,
    `- Branch: ${taskRef(task)}`,
  ];
  if (task.type) lines.push(`- Type: ${task.type}`);
  if (task.created_at) lines.push(`- Created: ${new Date(task.created_at).toISOString()}`);
  if (task.completed_at) lines.push(`- Completed: ${new Date(task.completed_at).toISOString()}`);
  lines.push(`- Turns recorded: ${turnCount}`);
  if (session?.ended_at) {
    lines.push(`- Agent session: ended ${new Date(session.ended_at).toISOString()} (not resumable)`);
  } else if (session) {
    lines.push('- Agent session: open, but not resumable for this question');
  }
  return lines.join('\n');
}

function renderTurn(turn: Turn, index: number): string {
  const who = turn.role === 'human' ? `human${turn.actor ? ` (${turn.actor})` : ''}` : turn.role;
  const when = turn.timestamp ? ` (${new Date(turn.timestamp).toISOString().replace('T', ' ').substring(0, 19)})` : '';
  const kind = turn.turn_type ? ` [${turn.turn_type}]` : '';
  return `--- turn ${index}: ${who}${kind}${when} ---\n${turn.content ?? ''}`;
}

function renderRaisedItem(item: RaisedItem): string {
  const head = `--- raised item ${item.id.substring(0, 8)} (${item.blocking ? 'blocking' : 'non-blocking'}, ${item.status}) ---`;
  return `${head}\n${raisedDisplayBody(item)}`;
}

function renderCommits(commits: Commit[]): string {
  const lines = commits.map(c => `- ${c.sha.substring(0, 12)} ${c.message.split('\n')[0]}`);
  return `--- commits (${commits.length}) ---\n${lines.join('\n')}`;
}

/**
 * The task's diff, when one can still be produced, or null with a reason.
 *
 * INVARIANT (CLAUDE.md — one resolver decides a task's diff base): the base ref
 * comes from `resolveTaskDiffBase` and nowhere else. When the worktree is gone
 * — the ordinary state of an accepted task — no base is invented here: the ask
 * falls back to the task's commit list, which is stored, plus the model's
 * read-only access to the repository for anything it wants to inspect itself.
 */
async function loadDiff(
  projectRoot: string,
  storage: Storage,
  task: Task,
  session: Session | null,
): Promise<{ text: string | null; warning: string | null }> {
  const worktreePath = getWorktreePathForRef(projectRoot, taskRef(task));
  if (!await pathExists(worktreePath)) {
    return {
      text: null,
      warning:
        `The task's worktree no longer exists, so its diff could not be rendered — ` +
        `the answer is based on the stored turns, raised items and commit list.`,
    };
  }
  try {
    const config = await loadConfig(projectRoot);
    const base = await resolveTaskDiffBase({
      task,
      session: { upstream_merge_sha: session?.upstream_merge_sha ?? null },
      storage,
      projectRoot,
      worktreePath,
      config,
    });
    const diff = await getDiffFull(base.ref, 'HEAD', worktreePath, base.twoDot);
    if (!diff.trim()) return { text: null, warning: null };
    if (diff.length > DIFF_CHARS_BUDGET) {
      const files = diff
        .split('\n')
        .filter(l => l.startsWith('diff --git '))
        .map(l => `- ${l.replace('diff --git a/', '').split(' b/')[0]}`);
      return {
        text: `--- changed files (${files.length}); the diff itself is ${diff.length} characters, too large to include ---\n${files.join('\n')}`,
        warning:
          `The diff is ${diff.length} characters — too large to read in full, so only the file list was included. ` +
          `Ask about a specific file to have it read.`,
      };
    }
    return { text: diff, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`record ask: diff unavailable for ${displayId(task)}: ${message}`);
    return {
      text: null,
      warning: `The task's diff could not be rendered (${message}) — the answer is based on the rest of the record.`,
    };
  }
}

/** Split a diff into per-file parts so chunk boundaries land between files. */
function diffParts(diff: string): AskPart[] {
  const segments = diff.split(/\n(?=diff --git )/);
  return segments
    .filter(s => s.trim().length > 0)
    .map(s => ({ text: s, noun: 'file diff', warningSubject: 'One file diff' }));
}

/**
 * Everything lazy stored about the task, as parts the engine may chunk between.
 *
 * Exported for tests: what the answer is allowed to be built from is the part
 * of this module a reader most needs pinned.
 */
export async function renderTaskRecordParts(
  projectRoot: string,
  storage: Storage,
  task: Task,
): Promise<{ metadata: string; parts: AskPart[]; turnCount: number; warnings: string[] }> {
  const warnings: string[] = [];
  const session = await storage.getSessionByTaskId(task.id);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const parts: AskPart[] = [];

  const prompt = currentPromptOf(task);
  if (prompt) {
    parts.push({
      text: `--- the task's prompt, as given to the agent ---\n${prompt}`,
      noun: 'task prompt',
      warningSubject: "The task's prompt",
    });
  }

  turns.forEach((turn, i) => {
    parts.push({
      text: renderTurn(turn, i + 1),
      noun: 'turn',
      warningSubject: `Turn ${i + 1} (${turn.role})`,
    });
  });

  const raised = await storage.getTaskRaisedItems(task.id);
  for (const item of raised) {
    parts.push({
      text: renderRaisedItem(item),
      noun: 'raised item',
      warningSubject: `Raised item ${item.id.substring(0, 8)}`,
    });
  }

  const commits = session ? await storage.getSessionCommits(session.id) : [];
  if (commits.length > 0) {
    parts.push({
      text: renderCommits(commits),
      noun: 'commit list',
      warningSubject: 'The commit list',
    });
  }

  const diff = await loadDiff(projectRoot, storage, task, session);
  if (diff.warning) warnings.push(diff.warning);
  if (diff.text) parts.push(...diffParts(diff.text));

  return { metadata: renderMetadata(task, session, turns.length), parts, turnCount: turns.length, warnings };
}

/**
 * Answer a question about a task from its stored record.
 *
 * Throws when there is nothing stored to answer from — a task that never ran
 * has no record, and inventing an answer from its goal alone would be worse
 * than saying so.
 */
export async function askTaskRecord(
  projectRoot: string,
  storage: Storage,
  task: Task,
  question: string,
  opts: TaskRecordAskOptions = {},
): Promise<TaskRecordAskResult> {
  const { metadata, parts, turnCount, warnings } = await renderTaskRecordParts(projectRoot, storage, task);

  if (parts.length === 0) {
    throw new Error(
      `Task ${displayId(task)} has nothing recorded yet — no turns, no raised items and no commits — ` +
      `so there is nothing to answer from.`,
    );
  }

  const chunks: AskChunk[] = chunkParts(parts);
  const result = await runAskEngine({
    subject: `task ${displayId(task)}`,
    sizeLabel: `${turnCount} turn${turnCount === 1 ? '' : 's'}`,
    metadata,
    question,
    chunks,
    templates: { single: singleTemplate, map: mapTemplate, reduce: reduceTemplate },
    onProgress: opts.onProgress,
  });

  return { ...result, warnings: [...warnings, ...result.warnings] };
}
