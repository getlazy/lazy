/**
 * Fuzzy command matching for CLI typo correction.
 *
 * When a user types an unknown command in interactive mode (no additional args),
 * this module finds the closest matching command and either:
 * - Auto-executes it (high confidence, unambiguous match)
 * - Offers to run it with y/N prompt (medium confidence)
 * - Suggests it without running (low confidence)
 */

import { promptYesNo } from './editor';
import { levenshteinDistance } from '../utils/levenshtein';

interface FuzzyMatch {
  command: string;
  distance: number;
  similarity: number;
}

/**
 * Find the best and second-best fuzzy matches for an input.
 * Returns [best, secondBest] where either can be null.
 */
function findMatches(input: string, commands: string[]): [FuzzyMatch | null, FuzzyMatch | null] {
  const lowerInput = input.toLowerCase();
  let best: FuzzyMatch | null = null;
  let secondBest: FuzzyMatch | null = null;

  for (const cmd of commands) {
    const distance = levenshteinDistance(lowerInput, cmd.toLowerCase());
    const maxLen = Math.max(lowerInput.length, cmd.length);
    const similarity = maxLen === 0 ? 0 : 1 - distance / maxLen;

    const match: FuzzyMatch = { command: cmd, distance, similarity };

    if (!best || similarity > best.similarity) {
      secondBest = best;
      best = match;
    } else if (!secondBest || similarity > secondBest.similarity) {
      secondBest = match;
    }
  }

  return [best, secondBest];
}

export type FuzzyResult =
  | { action: 'execute'; command: string }
  | { action: 'skip' }
  | { action: 'none' };

/**
 * Handle an unknown command with fuzzy matching.
 *
 * Only operates in interactive mode (TTY + no additional arguments).
 * Returns the action to take: execute a matched command, or skip/none.
 *
 * Confidence levels:
 * - High (auto-execute): best match has similarity >= 0.75 AND is clearly better
 *   than the second-best match (gap >= 0.15). This handles common typos like
 *   "blocke" → "blocked", "creat" → "create".
 * - Medium (prompt y/N): best match has similarity >= 0.5 but doesn't meet
 *   the auto-execute criteria (either too ambiguous or not similar enough).
 * - Low (suggest only): best match has similarity >= 0.4 but < 0.5.
 * - No match: similarity < 0.4.
 */
export async function handleFuzzyCommand(
  input: string,
  args: string[],
  commands: string[],
): Promise<FuzzyResult> {
  // Only apply fuzzy matching in interactive mode:
  // - Must have a TTY (interactive terminal)
  // - Must have no additional arguments beyond the command itself
  if (!process.stdin.isTTY || args.length > 1) {
    return { action: 'none' };
  }

  const [best, secondBest] = findMatches(input, commands);

  if (!best || best.similarity < 0.4) {
    return { action: 'none' };
  }

  // How much better is the best match compared to the second-best?
  const gap = secondBest ? best.similarity - secondBest.similarity : 1;
  const unambiguous = gap >= 0.15;

  // High confidence: auto-execute when the match is good and unambiguous
  if (best.similarity >= 0.75 && unambiguous) {
    console.log(`Interpreting as: lazy ${best.command}`);
    return { action: 'execute', command: best.command };
  }

  // Medium confidence: offer to run with y/N
  if (best.similarity >= 0.5) {
    const confirmed = await promptYesNo(`Did you mean \`lazy ${best.command}\`?`, false);
    if (confirmed) {
      return { action: 'execute', command: best.command };
    }
    return { action: 'skip' };
  }

  // Low confidence: just suggest
  console.error(`Unknown command: ${input}`);
  console.error(`Did you mean \`lazy ${best.command}\`?`);
  return { action: 'skip' };
}
