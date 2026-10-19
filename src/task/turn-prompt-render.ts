import { buildPromptWithInstructions } from './turn-context';
import goalContextStartText from '../prompts/goal-context-start.md' with { type: 'text' };

export interface TaskTurnPromptParts {
  /** A task's first turn frames the goal; later turns carry history and instructions. */
  firstTurn?: boolean;
  userPrompt: string;
  goal: string;
  lazyRoot: string;
  turnHistory?: string;
  notesContext?: string;
  remoteCommentsContext?: string;
  journalNotice?: string;
  artifactNotice?: string;
}

/**
 * The full prompt for a task work turn, whole. Nothing is dropped or replaced
 * with a pointer for size: the prompt reaches every harness on stdin, never
 * argv (the argv rule in src/agent/argv-safety.ts), so there is no argv limit
 * for it to fit under.
 */
export function renderTaskTurnPrompt(parts: TaskTurnPromptParts): string {
  return parts.firstTurn
    ? goalContextStartText.replace(/\{\{goal\}\}/g, parts.goal) + '\n\n' +
      (parts.notesContext ?? '') + (parts.journalNotice ?? '') + (parts.artifactNotice ?? '') + parts.userPrompt
    : buildPromptWithInstructions(
      parts.userPrompt, parts.goal, parts.lazyRoot, parts.turnHistory, parts.notesContext,
      parts.remoteCommentsContext, parts.journalNotice, parts.artifactNotice,
    );
}
