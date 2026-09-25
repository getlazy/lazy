import type { Task } from '../types';
import type { Storage } from '../storage';
import { VALID_EFFORT_LEVELS, type EffortLevel, type ResolvedConfig } from '../config/types';
import { parentTaskIdOf } from '../task-target';
import {
  resolveReviewSettingsWithSources,
  reviewSettingsMetadata,
  reviewSourcesMetadata,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from '../review/mode';

/**
 * Resolve the effort level for a task launch, writing NOTHING.
 *
 * Precedence: `--effort` override > task metadata > config default. The one
 * rule; {@link resolveAndPersistEffort} is this plus the write-back, and a
 * ONE-OFF turn (an ask, a machine one-shot) calls this directly — its
 * `--effort` applies to that invocation only and must not become the task's.
 */
export function resolveEffort(
  task: Task,
  override: string | undefined,
  configDefault: EffortLevel,
): EffortLevel {
  return (override ?? task.metadata?.effort ?? configDefault) as EffortLevel;
}

/**
 * Task metadata key recording that somebody chose THIS TASK's effort.
 *
 * It exists because `resolveAndPersistEffort` pins the resolved effort on every
 * task at its first launch — so `metadata.effort` alone cannot tell "somebody
 * asked for medium on this task" from "nobody said anything and medium is what
 * the project resolves to". One consumer needs that distinction and it is
 * load-bearing there: `low_high` mode substitutes `[review] draft_effort` for
 * the work phase, and doing that to an effort somebody deliberately set is
 * silently downgrading their task (engineer, 2026-09-21: "the task's configured
 * effort must not be discarded in low_high mode").
 *
 * PER TASK ONLY, and deliberately not "the project stated `[agent] effort`".
 * That wider reading made `draft_effort` dead on every project that states an
 * effort at all — which is most of them — so the key it was meant to serve
 * would have had no effect anywhere it mattered. A project-wide effort is the
 * fallback the review and revise phases use; the DRAFT is the phase the mode
 * exists to make cheap, and only a choice about this task outranks it.
 *
 * Sticky, last action wins, exactly like the value it qualifies: an `--effort`
 * sets it true and it stays true for later turns that pass nothing.
 */
export const EFFORT_EXPLICIT_METADATA_KEY = 'effort_explicit';

/**
 * Pin a per-task effort CHOICE — the one write every surface that lets somebody
 * choose an effort must go through.
 *
 * It writes both keys: the value and the marker that somebody chose it. Four
 * surfaces choose an effort (`lazy create --effort`, `lazy edit --effort`, the
 * MCP `lazy_edit` effort argument, and a `--effort` reaching a launch), and
 * three of them used to write `metadata.effort` directly and leave the marker
 * unset — so `lazy create --effort high` then `lazy start` resolved `high` with
 * `effortWasChosen() === false` and drafted at `low`. That is the silent
 * downgrade the marker exists to prevent, reached through the most ordinary way
 * of choosing an effort.
 *
 * One helper rather than four call sites remembering two writes: a fifth
 * surface cannot miss half of it.
 *
 * Mutates `task.metadata` in place when given a task, so a caller's local view
 * matches what was just written.
 */
export async function pinChosenEffort(
  storage: Storage,
  taskId: string,
  effort: EffortLevel | string,
  task?: Task,
): Promise<void> {
  await storage.updateTaskMetadata(taskId, 'effort', effort);
  await storage.updateTaskMetadata(taskId, EFFORT_EXPLICIT_METADATA_KEY, 'true');
  if (task) {
    if (!task.metadata) task.metadata = {};
    task.metadata.effort = effort;
    task.metadata[EFFORT_EXPLICIT_METADATA_KEY] = 'true';
  }
}

/**
 * Resolve the effort level for a task launch and persist it on task metadata.
 *
 * Precedence: CLI `--effort` override > task metadata > config default.
 *
 * Any of the three launch paths (launchTask, launchUnblockTask, resumeTask)
 * can be the first to run for a given task — for example, a task created
 * before the effort feature landed may hit launchUnblockTask first with no
 * metadata set. Whichever path runs first MUST persist the resolved value
 * so later turns don't re-read config mid-task and observe a changed default.
 *
 * Mutates `task.metadata.effort` in place so the caller's local view matches
 * what was just written to storage.
 */
export async function resolveAndPersistEffort(
  task: Task,
  override: string | undefined,
  configDefault: EffortLevel,
  storage: Storage,
): Promise<EffortLevel> {
  const resolved = resolveEffort(task, override, configDefault);

  // An `--effort` reaching a launch is a CHOICE and goes through the shared
  // pin, which writes the marker with the value. Once true it stays true: a
  // later turn passing no `--effort` is continuing the choice, not withdrawing
  // it (the turn-stickiness rule), and there is no act that means "un-choose my
  // effort" — you choose a different one.
  if (override !== undefined) {
    await pinChosenEffort(storage, task.id, resolved, task);
    return resolved;
  }

  // No override: pin the resolved value so later turns do not re-read a config
  // default that may have moved, and leave the marker exactly as it was.
  if (task.metadata?.effort !== resolved) {
    await storage.updateTaskMetadata(task.id, 'effort', resolved);
    if (!task.metadata) task.metadata = {};
    task.metadata.effort = resolved;
  }

  return resolved;
}

/**
 * Did anybody choose THIS TASK's effort?
 *
 * The task's own marker and nothing else — see the key's doc comment for why a
 * project-wide `[agent] effort` deliberately does not count.
 */
export function effortWasChosen(task: Task): boolean {
  return task.metadata?.[EFFORT_EXPLICIT_METADATA_KEY] === 'true';
}

/** Resolved low-high phase efforts for a work-turn launch (undefined = not that mode). */
export interface LowHighLoopResolution {
  /** Effort for the draft and revise phases — sent as the command's `effort`. */
  draftEffort: EffortLevel;
  /** Effort for the self-review phase. */
  reviewEffort: EffortLevel;
}

/**
 * Resolve a task's REVIEW SETTINGS for a launch and persist all three.
 *
 * THE THREE LEVELS, per key independently (see `resolveReviewSettings`):
 * explicit override > this task's own recorded value > its PARENT task's CHOICE
 * (never a value the parent merely ended up with — see `reviewSettingsChosenBy`)
 * > the project's. Persistence mirrors `resolveAndPersistEffort`: whichever
 * launch path resolves first writes them back, so later turns cannot silently
 * switch arms because a project default changed mid-task, and a per-task
 * `--review` sticks without a second flag on every later command.
 *
 * The parent is read from storage HERE and nowhere else, because this is the
 * one place that runs once per launch rather than once per gate check — and a
 * parent's persisted values already encode its own inheritance, so one lookup
 * carries the whole chain.
 *
 * Never throws on the parent lookup: a missing or unreadable parent degrades to
 * "no parent level", which resolves to the project default. Refusing to launch a
 * task because its parent row could not be read would be a far worse failure
 * than reviewing it under the project's own setting.
 */
export async function resolveAndPersistReviewSettings(
  task: Task,
  overrides: ReviewSettingsOverrides | undefined,
  config: ResolvedConfig,
  storage: Storage,
): Promise<ReviewSettings> {
  let parentMetadata: Record<string, string> | null = null;
  let parentCode: string | null = null;
  // Only when there is something to inherit: a task that already states all
  // three, or an override that supplies them, does not need the read.
  const parentId = parentTaskIdOf(task);
  if (parentId) {
    try {
      const parent = await storage.getTask(parentId);
      parentMetadata = parent?.metadata ?? null;
      // Named in the provenance the surfaces print, so "inherited" says from
      // WHERE rather than leaving the human to find the parent themselves.
      parentCode = parent?.code ?? null;
    } catch {
      // Deliberately swallowed, with the reason in the doc comment above: the
      // parent level is an enrichment, and the project default is a correct
      // answer without it.
      parentMetadata = null;
    }
  }

  const { settings: resolved, sources } = resolveReviewSettingsWithSources({
    overrides,
    own: task.metadata,
    parent: parentMetadata,
    parentCode,
    project: config.review,
  });

  // Values AND their provenance: a pinned value with no source marker is
  // indistinguishable from a decision one generation later, which is exactly
  // how a hub's legacy default reached every task created under it.
  const writes = { ...reviewSettingsMetadata(resolved), ...reviewSourcesMetadata(sources) };
  for (const [key, value] of Object.entries(writes)) {
    if (task.metadata?.[key] === value) continue;
    await storage.updateTaskMetadata(task.id, key, value);
    if (!task.metadata) task.metadata = {};
    task.metadata[key] = value;
  }

  return resolved;
}

/**
 * The low-high phase efforts for a launch, or undefined when this task is not
 * in `low_high` mode.
 *
 * THE DRAFT RUNS AT THE TASK'S OWN EFFORT WHEN SOMEBODY CHOSE ONE FOR IT.
 * `draft_effort` is the fallback for a task nobody has expressed an opinion
 * about, never a substitute for one they have: running a task somebody set to
 * `high` at `low` because the project switched review modes is a silent
 * downgrade of their work, visible only in the per-turn effort label.
 *
 * "Chose one for it" means a `--effort` on THIS TASK, not a project-wide
 * `[agent] effort` — see `EFFORT_EXPLICIT_METADATA_KEY`. A project effort is
 * the fallback the review and revise phases use; the draft is the phase this
 * mode exists to make cheap, and a project-wide default is not somebody
 * deciding that this particular task deserves more thinking.
 *
 * The revise phase follows the draft, as it always has — it is the same agent
 * applying the review's instructions to the same work.
 *
 * The efforts are NOT persisted per task — they are read at each launch and
 * recorded on the turns that ran, which is the durable label. Only the
 * SETTINGS are pinned, because only they decide what runs.
 */
export async function resolveAndPersistLowHighLoop(
  task: Task,
  overrides: ReviewSettingsOverrides | undefined,
  config: ResolvedConfig,
  storage: Storage,
  /** The effort this launch resolved, from `resolveAndPersistEffort`. */
  taskEffort?: EffortLevel,
): Promise<LowHighLoopResolution | undefined> {
  const settings = await resolveAndPersistReviewSettings(task, overrides, config, storage);
  if (settings.mode !== 'low_high') return undefined;
  const chosen = taskEffort !== undefined && effortWasChosen(task);
  const draftEffort = chosen ? taskEffort : config.review.draft_effort;
  // INVARIANT: a review never runs at a weaker effort than the draft it reviews
  // (engineer rule: the reviewer is never weaker than the writer). The rule used
  // to hold by construction, when the draft was always `draft_effort`; once a
  // task's own chosen effort could raise the draft, `--effort max` drafted at
  // `max` and self-reviewed at the `xhigh` default — a weaker reviewer. The
  // configured `review_effort` is therefore a FLOOR, not the value.
  return { draftEffort, reviewEffort: maxEffort(draftEffort, config.review.review_effort) };
}

/** The stronger of two efforts on the `VALID_EFFORT_LEVELS` ordering. */
function maxEffort(a: EffortLevel, b: EffortLevel): EffortLevel {
  return VALID_EFFORT_LEVELS.indexOf(a) >= VALID_EFFORT_LEVELS.indexOf(b) ? a : b;
}

