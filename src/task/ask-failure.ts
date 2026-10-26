/**
 * The headings lazy writes on an ask's AGENT turn when no answer came: the
 * agent crashed, the watchdog killed it, or its run died and the claim was
 * abandoned. One home so the writers and the readers (the task's Chat, which
 * must show "not answered" rather than a crash dump) cannot drift apart.
 */
import { WATCHDOG_TURN_HEADING } from '../utils/watchdog-turn';

export const AGENT_CRASHED_HEADING = '[Agent crashed]';
export const ASK_ABANDONED_HEADING = '[Ask abandoned]';

const FAILURE_HEADINGS = [AGENT_CRASHED_HEADING, WATCHDOG_TURN_HEADING, ASK_ABANDONED_HEADING];

/** Is this ask agent turn a failure notice rather than an answer? */
export function isAskFailureContent(content: string): boolean {
  const trimmed = content.trimStart();
  return FAILURE_HEADINGS.some((h) => trimmed.startsWith(h));
}

/** One line saying why: the notice's `Error:` line, or its heading. */
export function askFailureSummary(content: string): string {
  const lines = content.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const error = lines.find((l) => l.startsWith('Error: '));
  if (error) return error.slice('Error: '.length);
  return lines[1] ?? lines[0]?.replace(/^\[|\]$/g, '') ?? 'the ask did not finish';
}
