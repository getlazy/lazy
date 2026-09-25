/**
 * Seed a new task from a discussion — the question a reviewer asked about a
 * task and the answer they got.
 *
 * A discussion is where the work a task did NOT do usually gets named: the
 * reviewer asks "why isn't the retry path bounded?", the agent explains, and
 * the next task is sitting there in plain text with nobody to write it down.
 * Promotion writes it down.
 *
 * This module owns only the TEXT — what the new task's goal, code and prompt
 * should say. Creating the task (parentage, code allocation, prompt version,
 * inherited launch settings) is the shared seeding path in
 * src/raised/promote-task.ts, the same one raised-item promotion uses: two
 * hand-rolled createTask pairs is how one of them quietly stops allocating
 * codes.
 */

import { defaultPromotedGoal, defaultPromotedCode } from '../raised/promote-task';
import type { ReviewComment, Task } from '../types';

function taskDisplayRef(task: Task): string {
  return task.code ?? task.id.slice(0, 8);
}

/** The reviewer's first question in a thread, which is what the thread is about. */
export function discussionQuestion(messages: readonly ReviewComment[]): ReviewComment | null {
  return messages.find(m => m.role === 'human' && !m.withdrawn_at) ?? null;
}

/**
 * Default goal: the first sentence of the reviewer's question.
 *
 * The QUESTION, not the answer — a reviewer recognises their own words, and a
 * goal lifted from the middle of a model's reply reads like something nobody
 * decided. Falls back to the task's own goal when the question is unusable
 * (a bare "why?"), because an empty goal cannot be promoted at all.
 */
export function defaultDiscussionGoal(messages: readonly ReviewComment[], originatingTask: Task): string {
  const question = discussionQuestion(messages);
  const fromQuestion = question ? defaultPromotedGoal(question.content) : '';
  if (fromQuestion.trim().length >= 12) return fromQuestion;
  return defaultPromotedGoal(`Follow up on the discussion about ${originatingTask.goal}`);
}

/** Default kebab-case code for the promoted task, or undefined when none derives. */
export function defaultDiscussionCode(goal: string): string | undefined {
  return defaultPromotedCode(goal);
}

/**
 * The seeded prompt: the whole discussion, verbatim, plus where it came from.
 *
 * Verbatim and WHOLE — not a summary. The reviewer edits this before the task
 * is created, and an agent's own words about its own work are the best prompt
 * material there is; paraphrasing them here would lose exactly the detail the
 * promotion exists to keep. Withdrawn messages are left out: they are retracted
 * words, and a retracted question must not become someone's brief.
 */
export function buildDiscussionTaskPrompt(
  messages: readonly ReviewComment[],
  originatingTask: Task,
): string {
  const body = messages
    .filter(m => !m.withdrawn_at)
    .map(m => `**${m.role === 'human' ? 'Reviewer asked' : 'The answer'}:**\n\n${m.content.trim()}`)
    .join('\n\n');

  const ref = taskDisplayRef(originatingTask);
  const goal = originatingTask.goal.trim();
  const provenance =
    `Promoted from a review discussion on task ${ref}` + (goal ? `: ${goal}` : '.');

  return `${body}\n\n---\n\n${provenance}`;
}

/** What the "Promote to a task" control needs for one discussion. */
export interface DiscussionPromoteSeed {
  goal: string;
  code: string;
  prompt: string;
  promotedTaskId: string | null;
  promotedTaskCode: string | null;
}

/**
 * What the Promote control needs to render, for one discussion — or null when
 * there is nothing to promote yet (no answer, or a thread with no messages).
 *
 * One computation for every renderer: the daemon dashboard's form, its poll
 * island, and the `reviewComments` RPC that Lazy Teams draws its form from all
 * read this, so a promoted task is seeded with the same words whichever
 * surface drew the button.
 */
export function discussionPromoteSeed(
  task: Task,
  threadId: string,
  messages: readonly ReviewComment[],
): DiscussionPromoteSeed | null {
  const root = messages.find((m) => m.id === threadId) ?? messages[0];
  if (!root) return null;
  if (root.promoted_task_id) {
    return {
      goal: '', code: '', prompt: '',
      promotedTaskId: root.promoted_task_id,
      promotedTaskCode: root.promoted_task_code ?? null,
    };
  }
  // Nothing to promote until the discussion HAS both halves: a question with
  // no answer yet is a question, not a decision worth a task.
  if (!messages.some((m) => m.role === 'agent')) return null;
  const goal = defaultDiscussionGoal(messages, task);
  return {
    goal,
    code: defaultDiscussionCode(goal) ?? '',
    prompt: buildDiscussionTaskPrompt(messages, task),
    promotedTaskId: null,
    promotedTaskCode: null,
  };
}
