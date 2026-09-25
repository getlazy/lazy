/**
 * Prompt assembly and answer parsing for a linked task's generated description.
 *
 * Pure on purpose: what a `lazy link` one-shot is SHOWN (and what lazy accepts
 * back from it) is assertable without a daemon, a forge or a model. The daemon
 * side — gathering the material and persisting the result — lives in
 * src/daemon/link-describe.ts.
 *
 * Every section is budgeted. The material comes from someone else's branch, so
 * its size is not ours to bound at the source: a 900-file diff or a PR with two
 * hundred comments is an ordinary thing to link, and an unbudgeted prompt would
 * simply fail the call for the branches that need describing most.
 */

import linkDescriptionPrompt from '../prompts/link-description.md' with { type: 'text' };

/** Characters of PR/MR body kept. Generous: this is the author's own summary. */
export const PR_DESCRIPTION_BUDGET = 8_000;
/** Characters kept per imported comment. */
export const COMMENT_BUDGET = 2_000;
/** Characters kept across ALL comments. */
export const COMMENTS_TOTAL_BUDGET = 12_000;
/** Characters of `git log` kept. */
export const COMMIT_LOG_BUDGET = 8_000;
/** Characters of diff (stat + patch) kept — the largest and least dense input. */
export const DIFF_BUDGET = 40_000;

export interface LinkDescriptionInput {
  /** The task's goal as link created it — a PR title, or the branch name. */
  goal: string;
  /** The adopted branch. */
  branch: string;
  /** Branch the work is measured against, when one is known. */
  baseBranch?: string;
  prUrl?: string | null;
  prState?: string | null;
  /** PR/MR body, when a forge supplied one. */
  prDescription?: string;
  /** Imported PR/MR comments, oldest first. */
  comments?: string[];
  /** `git log` of the branch against its base, newest first. */
  commitLog?: string;
  /** `git diff --stat` against the base. */
  diffStat?: string;
  /** The patch itself, against the base. */
  diffPatch?: string;
  /**
   * True when the patch was cut off at the READER's byte cap rather than by the
   * budget below — the daemon stops reading a huge diff instead of buffering it.
   * Without this the text would look complete at exactly the budget.
   */
  diffTruncated?: boolean;
}

function truncate(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;
  return `${trimmed.slice(0, budget)}\n\n[… truncated, ${trimmed.length - budget} more characters]`;
}

function orNone(text: string, none: string): string {
  return text.trim() ? text : none;
}

function formatComments(comments: string[]): string {
  if (comments.length === 0) return '';
  const kept: string[] = [];
  let used = 0;
  for (const comment of comments) {
    if (used >= COMMENTS_TOTAL_BUDGET) {
      kept.push(`[… ${comments.length - kept.length} further comment(s) omitted]`);
      break;
    }
    const one = truncate(comment, COMMENT_BUDGET);
    used += one.length;
    kept.push(one);
  }
  return kept.join('\n\n---\n\n');
}

function formatDiff(input: LinkDescriptionInput): string {
  const stat = input.diffStat?.trim() ?? '';
  const patch = input.diffPatch?.trim() ?? '';
  if (!stat && !patch) return '';
  // The stat is never dropped for the patch's sake: it is the only input that
  // describes the change's SHAPE once the patch has been cut off.
  const patchBudget = Math.max(0, DIFF_BUDGET - stat.length);
  let body = patch ? truncate(patch, patchBudget) : '';
  // The reader stopped at the byte cap, so the patch fits the budget while still
  // being incomplete: nothing in the text would say so. Say it here — the prompt
  // tells the model to report a truncated section, and it can only do that if
  // the marker is present.
  if (body && input.diffTruncated && !body.includes('[… truncated')) {
    body += `\n\n[… truncated, the diff is larger than ${DIFF_BUDGET} characters]`;
  }
  return [stat, body].filter(Boolean).join('\n\n');
}

/**
 * The placeholders {@link buildLinkDescriptionPrompt} fills, and nothing else.
 *
 * Substitution is ONE pass over this set with a replacer FUNCTION, which is the
 * whole point: the values here are a stranger's PR body, review comments and
 * diff, and two properties of `String.replace` bite a chain of per-key calls.
 * A replacement STRING treats `$'`, `$&` and `$1` as instructions — a PR body
 * containing `$'` (any branch touching shell scripts) would splice the rest of
 * the prompt back into itself. And each later `.replace()` re-scans text already
 * substituted, so a PR body or diff containing the literal text `{{comments}}`
 * would consume the real comments placeholder and delete that section silently.
 */
const LINK_DESCRIPTION_PLACEHOLDERS = [
  'goal', 'branch', 'base', 'pr', 'description', 'comments', 'commits', 'diff',
] as const;

/** Compose the one-shot prompt for a linked task's description. */
export function buildLinkDescriptionPrompt(input: LinkDescriptionInput): string {
  const values: Record<(typeof LINK_DESCRIPTION_PLACEHOLDERS)[number], string> = {
    goal: input.goal.trim() || '(none)',
    branch: input.branch,
    base: input.baseBranch ?? '(unknown)',
    pr: input.prUrl
      ? `${input.prUrl}${input.prState ? ` (${input.prState})` : ''}`
      : 'none — this is a branch with no pull request',
    description: orNone(
      truncate(input.prDescription ?? '', PR_DESCRIPTION_BUDGET),
      '_(no pull request description)_',
    ),
    comments: orNone(formatComments(input.comments ?? []), '_(no comments)_'),
    commits: orNone(
      truncate(input.commitLog ?? '', COMMIT_LOG_BUDGET),
      '_(no commits readable on this branch)_',
    ),
    diff: orNone(formatDiff(input), '_(no diff readable against the base branch)_'),
  };

  const pattern = new RegExp(`\\{\\{(${LINK_DESCRIPTION_PLACEHOLDERS.join('|')})\\}\\}`, 'g');
  return linkDescriptionPrompt.replace(
    pattern,
    (_match, key: (typeof LINK_DESCRIPTION_PLACEHOLDERS)[number]) => values[key],
  );
}

export interface ParsedLinkDescription {
  /** The generated one-line goal, when the answer carried a usable one. */
  goal?: string;
  /** The description body — always non-empty when parsing succeeded. */
  prompt: string;
}

/** Longest generated goal kept; anything past this is the model ignoring format. */
export const GENERATED_GOAL_MAX_CHARS = 200;

/**
 * Read `GOAL: …` / `---` / body out of a one-shot answer.
 *
 * Deliberately forgiving in one direction only: an answer with no GOAL line
 * still yields a prompt (the description is the valuable half, and the task
 * already has the PR title as its goal), but an EMPTY answer is a failure the
 * caller must see rather than a task whose prompt is the empty string.
 */
export function parseLinkDescription(raw: string): ParsedLinkDescription | null {
  const text = stripCodeFence(raw.trim());
  if (!text) return null;

  const lines = text.split('\n');
  let goal: string | undefined;
  let bodyStart = 0;

  const goalMatch = lines[0]?.match(/^\s*(?:\*\*)?GOAL(?:\*\*)?\s*:\s*(.+?)\s*$/i);
  if (goalMatch) {
    goal = goalMatch[1].replace(/\*\*/g, '').trim().slice(0, GENERATED_GOAL_MAX_CHARS);
    bodyStart = 1;
    if (lines[bodyStart]?.trim() === '---') bodyStart += 1;
  }

  const prompt = lines.slice(bodyStart).join('\n').trim();
  if (!prompt) return null;
  return goal ? { goal, prompt } : { prompt };
}

/**
 * Drop a single fenced block wrapping the whole answer — the format in the
 * prompt is shown inside a fence, and models routinely echo the fence with it.
 */
function stripCodeFence(text: string): string {
  const match = text.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : text;
}
