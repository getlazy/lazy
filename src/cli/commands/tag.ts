import { requireStorage, displayId, parseFlags, resolveTaskOrExit } from '../helpers';
import { getActor } from '../../constants';
import { normalizeTag } from '../../utils/tags';
import { theme } from '../theme';

/**
 * `lazy tag <task_id> <tag> [<tag>...]`
 *
 * Adds one or more tags to a task. Tags are normalized (lowercase, alphanumeric
 * + hyphens). Idempotent — re-tagging an existing tag is a no-op. Every add is
 * recorded in the task's append-only tag history, attributed to the human actor
 * (CLI channel).
 */
export async function commandTag(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'tag');
  const taskId = parsed.positional[0];
  const rawTags = parsed.positional.slice(1);

  if (!taskId || rawTags.length === 0) {
    tagUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);

    for (const raw of rawTags) {
      const normalized = normalizeTag(raw);
      if (!normalized) {
        console.error(`Skipping invalid tag '${raw}': normalizes to an empty string.`);
        continue;
      }
      const alreadyTagged = task.tags.includes(normalized);
      const updated = await storage.addTaskTag(task.id, normalized, getActor());
      task.tags = updated.tags;
      if (alreadyTagged) {
        console.log(`Task ${displayId(task)} already has tag ${theme.tag('#' + normalized)}`);
      } else {
        console.log(`Tagged ${displayId(task)} with ${theme.tag('#' + normalized)}`);
      }
    }

    console.log(`  Tags: ${task.tags.length > 0 ? task.tags.map(t => theme.tag('#' + t)).join(' ') : '(none)'}`);
  } finally {
    await storage.close();
  }
}

/**
 * `lazy untag <task_id> <tag> [<tag>...]`
 *
 * Removes one or more tags from a task. Idempotent — untagging a tag the task
 * doesn't have is a no-op. Untagging appends an 'untag' event to the history; it
 * never erases the earlier 'tag' event.
 */
export async function commandUntag(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'untag');
  const taskId = parsed.positional[0];
  const rawTags = parsed.positional.slice(1);

  if (!taskId || rawTags.length === 0) {
    untagUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);

    for (const raw of rawTags) {
      const normalized = normalizeTag(raw);
      if (!normalized) {
        console.error(`Skipping invalid tag '${raw}': normalizes to an empty string.`);
        continue;
      }
      const hadTag = task.tags.includes(normalized);
      const updated = await storage.removeTaskTag(task.id, normalized, getActor());
      task.tags = updated.tags;
      if (hadTag) {
        console.log(`Removed tag ${theme.tag('#' + normalized)} from ${displayId(task)}`);
      } else {
        console.log(`Task ${displayId(task)} does not have tag ${theme.tag('#' + normalized)}`);
      }
    }

    console.log(`  Tags: ${task.tags.length > 0 ? task.tags.map(t => theme.tag('#' + t)).join(' ') : '(none)'}`);
  } finally {
    await storage.close();
  }
}

export function tagUsage(): void {
  console.log(`Usage: lazy tag <task_id> <tag> [<tag>...]

Add one or more tags to a task for lightweight, non-hierarchical grouping.

Arguments:
  <task_id>    ID or code of the task to tag (can be shortened)
  <tag>        One or more tags. Normalized to lowercase alphanumerics + hyphens
               (e.g. "[Onboarding]" becomes "onboarding").

Tags let you group work into efforts (onboarding, launch, infra) without a
parent/child relationship — a task can carry multiple tags at once. Every
tag/untag is recorded in an append-only, actor-attributed history
(see \`lazy show <task_id>\`).

Examples:
  lazy tag abc12345 onboarding
  lazy tag abc1 launch infra
  lazy untag abc1 infra`);
}

export function untagUsage(): void {
  console.log(`Usage: lazy untag <task_id> <tag> [<tag>...]

Remove one or more tags from a task. Untagging is recorded in the task's
append-only tag history — it never erases the earlier tagging event.

Arguments:
  <task_id>    ID or code of the task to untag (can be shortened)
  <tag>        One or more tags to remove.

Examples:
  lazy untag abc12345 onboarding
  lazy untag abc1 launch infra`);
}
