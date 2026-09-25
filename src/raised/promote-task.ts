/**
 * Helpers for promoting a raised item into a backlog task.
 *
 * Promotion is a deliberate human/builder act — it creates a vetted backlog task
 * (never auto-started) and records durable promoted state on the raised item.
 */

import type { ActorInput, RaisedItem, Task } from '../types';
import { isTerminalStatus } from '../types';
import type { Storage } from '../storage';
import { firstSentence, truncateAtWordBoundary, raisedDisplayBody } from './title';
import { parentTaskIdOf } from '../task-target';
import { deriveCode, validateCode, MAX_TASK_CODE_LENGTH } from '../task/identity';

function taskDisplayRef(task: Task): string {
  return task.code ?? task.id.slice(0, 8);
}

/**
 * Longer than a table heading, shorter than a paragraph. The observed
 * malformed promote used a hard 120-char mid-word slice; first sentences
 * around that length (file paths, CLI flags) must survive intact.
 */
export const MAX_PROMOTED_GOAL_LENGTH = 200;

/** Goal for a promoted task when the caller did not override --goal. */
export function defaultPromotedGoal(content: string): string {
  // First sentence, not a length prefix. Word-boundary + ellipsis only when
  // that sentence is longer than MAX_PROMOTED_GOAL_LENGTH.
  const sentence = firstSentence(content);
  if (!sentence) return '';
  return truncateAtWordBoundary(sentence, MAX_PROMOTED_GOAL_LENGTH);
}

/** Default promote goal from a raised item (title when structured). */
export function defaultPromotedGoalFromRaised(item: Pick<RaisedItem, 'title' | 'content'>): string {
  const seed = item.title?.trim() || item.content;
  return defaultPromotedGoal(seed);
}

/** Default promote code from a raised item (proposed code or derive from goal). */
export function defaultPromotedCodeFromRaised(item: RaisedItem, goal: string): string | undefined {
  const proposed = item.proposed_code?.trim();
  if (proposed) return proposed;
  return defaultPromotedCode(goal);
}

/** Default promote prompt (proposed prompt + provenance, else full body). */
export function defaultPromotedPromptFromRaised(item: RaisedItem, originatingTask: Task): string {
  const proposed = item.proposed_prompt?.trim();
  if (proposed) {
    return appendPromotedProvenance(proposed, item, originatingTask);
  }
  return buildPromotedTaskPrompt(item, originatingTask);
}

/**
 * Kebab-case code derived from the promoted goal when the caller omitted --code.
 * Listings show codes; a bare hex id is the defect this exists to prevent.
 * Returns undefined when the goal cannot yield a valid code (too short, reserved).
 */
export function defaultPromotedCode(goal: string): string | undefined {
  const direct = deriveCode(goal);
  if (direct) return direct;

  // "Lazy should…" would derive as reserved `lazy-should-…`. Strip the
  // reserved token and retry rather than silently shipping no code.
  const stripped = goal.replace(/^\s*lazy[\s\-_:./]+/i, '').trim();
  if (stripped && stripped !== goal.trim()) {
    const retry = deriveCode(stripped);
    if (retry) return retry;
  }
  return undefined;
}

/**
 * How many `-2`, `-3`, … codes to try before giving up. Same bound as the
 * Slack room provisioner: twenty collisions is a misconfiguration, not a
 * name that needs one more suffix.
 */
export const MAX_PROMOTED_CODE_ATTEMPTS = 20;

/**
 * Pick a code that no NON-TERMINAL task already holds. First try is `base`;
 * collisions get `-2`, `-3`, … (Slack room suffixing). An 80-char base is
 * trimmed so the suffix still fits. Never returns the colliding base — that
 * is what turned a working no-code promote into createTask's duplicate error.
 */
export function allocatePromotedCode(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  let previous = base;
  for (let n = 2; n <= MAX_PROMOTED_CODE_ATTEMPTS; n++) {
    const suffix = `-${n}`;
    const stem = base
      .slice(0, MAX_TASK_CODE_LENGTH - suffix.length)
      .replace(/[-.]+$/, '');
    const candidate = `${stem}${suffix}`;
    if (candidate === previous) {
      throw new Error(
        `Code '${base}' is taken, and it is already at the ${MAX_TASK_CODE_LENGTH}-character ` +
          `limit so there is no room for a uniqueness suffix`,
      );
    }
    previous = candidate;
    if (validateCode(candidate) !== null) continue;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(
    `Every code from '${base}' to -${MAX_PROMOTED_CODE_ATTEMPTS} is already taken`,
  );
}

/**
 * Prompt body for a promoted task: full raised-item text plus provenance so
 * `buildPromotionIndex` can still match heuristic promotions on older records.
 */
export function buildPromotedTaskPrompt(item: RaisedItem, originatingTask: Task): string {
  return appendPromotedProvenance(raisedDisplayBody(item).trim(), item, originatingTask);
}

/** Append promotion provenance to an agent-authored proposed prompt. */
export function appendPromotedProvenance(
  promptBody: string,
  item: RaisedItem,
  originatingTask: Task,
): string {
  const ref = taskDisplayRef(originatingTask);
  const goal = originatingTask.goal.trim();
  const provenance =
    `Promoted from raised item ${item.id} on task ${ref}` +
    (goal ? `: ${goal}` : '.');
  return `${promptBody.trim()}\n\n---\n\n${provenance}`;
}

/**
 * Default parent for a promoted task: same hub as the originating task
 * (mirror `lazy redo` — a release-hub child's raised item lands on that hub).
 */
export function defaultPromoteParentTaskId(originatingTask: Task): string | undefined {
  return parentTaskIdOf(originatingTask) ?? undefined;
}

/**
 * Create the backlog task a promotion produces — parentage, code allocation,
 * prompt and inherited launch settings, in that order.
 *
 * ONE seeding path, deliberately. Raised-item promotion (Storage.promoteRaisedItem)
 * and discussion promotion (the review service) both go through this: they
 * differ only in where the goal, code and prompt TEXT come from, and a second
 * hand-rolled createTask/updateTaskPrompt pair is how one of them would quietly
 * stop allocating codes or stop inheriting the model.
 *
 * NEVER started. Promotion creates a vetted backlog task; starting work is a
 * separate, explicit act.
 *
 * `originatingTask` is OPTIONAL because not every promotable thing happened on
 * a task: a stored builder conversation is project-scoped, so there is no task
 * to be a peer or a subtask of and nothing to inherit a model from. Such a
 * promotion is parented by `parent` alone, or lands at top level. It stays on
 * this one path rather than hand-rolling a createTask pair for the same reason
 * the other two do — code allocation and the prompt version are here.
 */
export async function createPromotedTask(
  storage: Storage,
  opts: {
    originatingTask?: Task;
    relation?: 'peer' | 'subtask';
    /** Explicit parent override; empty/absent uses the relation's default. */
    parent?: string;
    goal: string;
    prompt: string;
    /** Explicit code from the caller — used as-is, so a duplicate is an error. */
    code?: string;
    /**
     * A suggested code (an agent's `proposed_code`) to use instead of deriving
     * one from the goal. De-duped like a derived code: it is a suggestion, not
     * the human's instruction, so a collision suffixes rather than throws.
     */
    codeSuggestion?: string;
    actor: ActorInput;
    /** Codes already taken, for the derived-code collision suffix. */
    takenCodes?: ReadonlySet<string>;
  },
): Promise<Task> {
  const { originatingTask, relation, actor } = opts;

  if (!originatingTask && relation === 'subtask') {
    throw new Error('A promotion with no originating task cannot create a subtask of one');
  }

  // Peer = sibling of the originating task (mirrors `lazy redo`). Subtask =
  // child of it. With no originating task there is neither, and `parent` below
  // (or top level) decides.
  let parentTaskId = !originatingTask
    ? undefined
    : relation === 'subtask'
      ? originatingTask.id
      : defaultPromoteParentTaskId(originatingTask);
  if (opts.parent !== undefined && opts.parent.trim() !== '') {
    const resolved = await storage.resolveTask(opts.parent.trim());
    if (!resolved.task) {
      if (resolved.ambiguousMatches?.length) {
        throw new Error(
          `Ambiguous parent '${opts.parent}'. Matches: ${resolved.ambiguousMatches.map(t => `${t.id.slice(0, 8)} (${t.goal})`).join(', ')}`,
        );
      }
      throw new Error(`Parent task not found: ${opts.parent}`);
    }
    parentTaskId = resolved.task.id;
  }

  const goal = opts.goal.trim();
  if (!goal) {
    throw new Error('Promoted task goal cannot be empty');
  }

  // An explicit code goes to createTask as-is (a duplicate is an error the
  // caller asked for). A DERIVED default that collides is suffixed (-2, -3, …)
  // so near-duplicate items — the common case, they recur — still promote
  // instead of throwing. Never silently drop the code on a collision.
  const explicitCode = opts.code?.trim();
  let code = explicitCode || opts.codeSuggestion?.trim() || defaultPromotedCode(goal);
  if (!explicitCode && code) {
    const taken = opts.takenCodes ?? new Set(
      (await storage.listTasks())
        .filter(t => t.code && !isTerminalStatus(t.status))
        .map(t => t.code as string),
    );
    code = allocatePromotedCode(code, taken);
  }

  // createTask → updateTaskPrompt → inherit are sequential, not one atomic
  // write: a crash mid-flight can leave an orphan backlog task. OK.
  const created = await storage.createTask(
    goal,
    parentTaskId,
    undefined,
    code,
    undefined,
    originatingTask?.agent_id,
    actor,
  );
  await storage.updateTaskPrompt(created.id, opts.prompt.trim());
  if (originatingTask) {
    await inheritOriginatingLaunchSettings(storage, created.id, originatingTask);
  }

  const task = await storage.getTask(created.id);
  if (!task) {
    throw new Error(`Promoted task ${created.id.slice(0, 8)} could not be read back after creation`);
  }
  return task;
}

/**
 * Copy agent/model/effort from the originating task onto a promoted task.
 *
 * INVARIANT: promotion must not silently drop launch identity — a promoted task
 * that inherits only the project default model/effort while the originating
 * task had explicit settings is a surprise at `lazy start`.
 */
export async function inheritOriginatingLaunchSettings(
  storage: Storage,
  createdTaskId: string,
  originating: Task,
): Promise<void> {
  if (originating.model) {
    await storage.updateTaskModel(createdTaskId, originating.model);
  }
  const effort = originating.metadata?.effort;
  if (effort) {
    await storage.updateTaskMetadata(createdTaskId, 'effort', effort);
  }
}
