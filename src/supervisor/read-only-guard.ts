/**
 * Lazy's own enforcement of a READ-ONLY turn (ask, review, low-high
 * self-review), independent of whatever the harness promises.
 *
 * Why this exists: inside a task container a harness's own sandbox cannot be
 * relied on. Codex enforces `sandbox_mode="read-only"` with bubblewrap, and
 * bubblewrap cannot create a user namespace in our containers — so every Codex
 * read-only turn there ran with NO working shell and its lazy tools denied, and
 * reported "approved" having read nothing. Those turns now run with the same
 * sandbox bypass as work turns (the container is the isolation boundary), and
 * read-only is enforced by lazy instead:
 *
 *   1. the read-only / review MCP toolset (write tools are never advertised);
 *   2. the prompt;
 *   3. THIS write check — the worktree's HEAD and every dirty path's content
 *      are recorded before the turn and compared after. Any difference fails
 *      the turn, naming the files. Nothing is reverted: lazy cannot prove the
 *      reviewer made a change it did not watch being made, and destroying work
 *      on a guess is worse than a loud failure.
 *
 * And a review that inspected nothing is not a review:
 *   - a reviewer that SAYS it could not inspect the work (the
 *     {@link COULD_NOT_INSPECT_MARKER} line the prompts ask for), and
 *   - a reviewer that made NO tool call at all (a fresh review session holds no
 *     diff in its prompt, and the low-high self-review is told to re-read the
 *     work — an approval with zero tool calls read nothing)
 * are both failed reviews, never a pass and never a `needs_work` verdict.
 */

import { runGit } from '../utils/git';
import { logWarn } from './log';
import type { AgentActivityEvent, AgentActivityStream } from '../agent/activity-stream';
import type { RunnerType } from '../runner/types';

/**
 * The line a reviewer starts its reply with when it could not read the work.
 * Kept in sync with src/prompts/review-system-prompt.md and
 * src/prompts/low-high-loop-review.md.
 */
export const COULD_NOT_INSPECT_MARKER = 'REVIEW_COULD_NOT_INSPECT';

/**
 * Whether this runner already isolates the agent process (a task container),
 * so a harness's nested sandbox is redundant — and, for Codex, broken.
 * The host-process runner is the one that does not: there the harness's own
 * sandbox is the only thing between a read-only turn and the host.
 */
export function runnerIsExternallySandboxed(type: RunnerType | undefined): boolean {
  return type !== 'dangerously-host-process-without-any-isolation';
}

/** Paths lazy itself writes during a turn (handoff file, artifacts) — never the reviewer's doing. */
const LAZY_SANDBOX_PREFIX = '.lazy-task-sandbox/';

/** Paths per `git hash-object` call — keeps argv well under the OS limit. */
const HASH_BATCH = 200;

export interface WorktreeSnapshot {
  head: string;
  /** Dirty path → `<porcelain status> <content hash | missing>`. */
  dirty: Map<string, string>;
}

/** Record the worktree's HEAD and the content of every dirty path. Throws when git cannot answer. */
export async function snapshotWorktree(worktreePath: string): Promise<WorktreeSnapshot> {
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: worktreePath });
  if (head.exitCode !== 0) {
    throw new Error(`read-only write check: could not read HEAD in ${worktreePath}: ${head.stderr.trim()}`);
  }
  // porcelain v2: every record starts with a type token, so nothing depends
  // on a leading space surviving output trimming (v1's " M path" does not).
  const status = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: worktreePath });
  if (status.exitCode !== 0) {
    throw new Error(`read-only write check: git status failed in ${worktreePath}: ${status.stderr.trim()}`);
  }
  const entries: Array<[string, string]> = [];
  const parts = status.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    let code: string;
    let path: string;
    if (record.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI <path>
      const f = record.split(' ');
      code = f[1];
      path = f.slice(8).join(' ');
    } else if (record.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore <path>, then the source as the next NUL field.
      const f = record.split(' ');
      code = f[1];
      path = f.slice(9).join(' ');
      i++;
    } else if (record.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 <path>
      const f = record.split(' ');
      code = f[1];
      path = f.slice(10).join(' ');
    } else if (record.startsWith('? ')) {
      code = '??';
      path = record.slice(2);
    } else {
      continue;
    }
    if (path.startsWith(LAZY_SANDBOX_PREFIX)) continue;
    entries.push([path, code]);
  }
  const dirty = new Map<string, string>();
  if (entries.length > 0) {
    // `hash-object` without -w only computes the id: nothing is written.
    const present: string[] = [];
    for (const [path, code] of entries) {
      if (code.includes('D')) dirty.set(path, `${code} missing`);
      else present.push(path);
    }
    const codeOf = new Map(entries);
    // Bounded batches (argv length), and a failed batch falls back to one path
    // at a time so a single unhashable path (a dangling symlink, a submodule
    // directory) degrades only itself, never the whole content comparison.
    for (let start = 0; start < present.length; start += HASH_BATCH) {
      const batch = present.slice(start, start + HASH_BATCH);
      const hashes = await runGit(['hash-object', '--no-filters', '--', ...batch], { cwd: worktreePath });
      const ids = hashes.exitCode === 0 ? hashes.stdout.trim().split('\n') : null;
      for (let idx = 0; idx < batch.length; idx++) {
        const path = batch[idx];
        let id = ids?.[idx];
        if (!id) {
          const one = await runGit(['hash-object', '--no-filters', '--', path], { cwd: worktreePath });
          id = one.exitCode === 0 ? one.stdout.trim() : undefined;
        }
        if (!id) {
          // Still recorded by status, so a change of STATUS is still caught;
          // only an edit that keeps the status is invisible for this path.
          logWarn(`[read-only] write check: could not hash ${path} in ${worktreePath}; only its status is compared`);
        }
        dirty.set(path, `${codeOf.get(path)} ${id ?? 'unhashed'}`);
      }
    }
  }
  return { head: head.stdout.trim(), dirty };
}

/** Paths whose state differs between two snapshots (sorted), plus whether HEAD moved. */
export function diffSnapshots(before: WorktreeSnapshot, after: WorktreeSnapshot): { headMoved: boolean; files: string[] } {
  const files = new Set<string>();
  for (const [path, state] of after.dirty) {
    if (before.dirty.get(path) !== state) files.add(path);
  }
  for (const path of before.dirty.keys()) {
    if (!after.dirty.has(path)) files.add(path);
  }
  return { headMoved: before.head !== after.head, files: [...files].sort() };
}

/**
 * Compare the worktree against `before` and throw when a read-only turn
 * changed it. The message names HEAD's movement and every changed path, and
 * says nothing was reverted.
 */
export async function assertWorktreeUnchanged(
  worktreePath: string,
  before: WorktreeSnapshot,
  turnLabel: string,
): Promise<void> {
  const after = await snapshotWorktree(worktreePath);
  const { headMoved, files } = diffSnapshots(before, after);
  if (!headMoved && files.length === 0) return;
  const parts: string[] = [];
  if (headMoved) parts.push(`HEAD moved ${before.head.slice(0, 12)} → ${after.head.slice(0, 12)}`);
  if (files.length > 0) {
    const shown = files.slice(0, 50).join(', ');
    parts.push(`changed: ${shown}${files.length > 50 ? ` (+${files.length - 50} more)` : ''}`);
  }
  throw new Error(
    `${turnLabel} is read-only but the worktree changed during it — ${parts.join('; ')}. ` +
    `Nothing was reverted; inspect the worktree and discard or keep the changes yourself.`,
  );
}

/**
 * Wrap an activity stream so the caller can read how many tool calls the agent
 * made. A call counts once whether it is seen starting, finishing, or both
 * (distinct tool ids), so a tool a harness reports only on completion is not
 * mistaken for "no tool called".
 */
export function countingActivityStream(inner: AgentActivityStream): AgentActivityStream & { toolCalls: () => number } {
  const ids = new Set<string>();
  let anonymous = 0;
  return {
    parseLine(line: string): AgentActivityEvent | null {
      const event = inner.parseLine(line);
      if (event?.kind === 'tool_start' || event?.kind === 'tool_end') {
        if (event.toolUseId) ids.add(event.toolUseId);
        else if (event.kind === 'tool_start') anonymous++;
      }
      return event;
    },
    toolCalls: () => ids.size + anonymous,
  };
}

/**
 * Whether a reviewer's reply declares it could not inspect the work: any line
 * that STARTS with the marker (markdown emphasis stripped). Any line, not just
 * the first, because some harnesses (Codex) join every message of the turn, so
 * narration ("Inspecting the diff…") can precede the final message.
 */
export function reportsCouldNotInspect(reply: string): boolean {
  return reply
    .split('\n')
    .some((line) => line.trim().replace(/^[`*_>\s]+/, '').startsWith(COULD_NOT_INSPECT_MARKER));
}
