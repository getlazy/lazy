/**
 * The `--review*` flags, parsed once for every command that takes them.
 *
 * `lazy create`, `lazy start` and `lazy edit` all offer the same three, and a
 * per-command copy of the parsing is three chances for the accepted spellings
 * or the refusal wording to drift apart — which on these flags means a human
 * told `--review-gate` takes `on|off` on one command and `auto|always|never`
 * on the next.
 *
 * Each flag is INDEPENDENT: supplying one leaves the other two inherited
 * (task > parent task > project), which is why this returns a partial set
 * rather than a filled-in triple.
 */

import type { FlagDefinition } from './helpers';
import {
  REVIEW_GATE_INPUTS,
  REVIEW_MODE_INPUTS,
  REVIEW_TOGGLE_INPUTS,
  parseReviewGate,
  parseReviewMode,
  parseReviewToggle,
  type ReviewSettingsOverrides,
} from '../review/mode';

/**
 * Flag table entries shared by `lazy create`, `lazy start` and `lazy edit`.
 *
 * Spread into each command's `parseFlags` table rather than listed as names:
 * this used to be a `REVIEW_FLAG_NAMES` string array documented as "the entries
 * every command must register", which nothing imported and nothing asserted —
 * a contract in a comment, with three hand-written copies underneath it. The
 * shape here is the one CLAUDE.md sanctions for a shared table (see
 * `RAISED_RESOLUTION_FLAGS`): a plain exported array literal, imported directly
 * and spread, so the source scan in `cli-command-discoverability.test.ts` can
 * still follow the import and read each command's real flags.
 */
export const REVIEW_FLAGS: FlagDefinition[] = [
  { name: 'review', takesValue: true },
  { name: 'review-gate', takesValue: true },
  { name: 'review-auto-fix', takesValue: true },
];

/**
 * Read the three flags out of a parsed command line.
 *
 * Returns the overrides, or an error MESSAGE for the caller to print and exit
 * on. It does not exit itself: this lives outside `src/cli/commands/`, and a
 * helper that calls `process.exit` is a landmine for every long-lived process
 * that later reuses it (CLAUDE.md, "`process.exit()` belongs to CLI commands").
 */
export function parseReviewFlags(
  flags: Map<string, string | boolean | string[]>,
): { overrides: ReviewSettingsOverrides } | { error: string } {
  const overrides: ReviewSettingsOverrides = {};

  const modeValue = flags.get('review') as string | undefined;
  if (modeValue !== undefined) {
    const mode = parseReviewMode(modeValue);
    if (!mode) {
      return { error: `Invalid --review value '${modeValue}'. Must be one of: ${REVIEW_MODE_INPUTS.join(', ')}.` };
    }
    overrides.mode = mode;
  }

  const gateValue = flags.get('review-gate') as string | undefined;
  if (gateValue !== undefined) {
    const gate = parseReviewGate(gateValue);
    if (!gate) {
      return { error: `Invalid --review-gate value '${gateValue}'. Must be one of: ${REVIEW_GATE_INPUTS.join(', ')}.` };
    }
    overrides.gate = gate;
  }

  const autoFixValue = flags.get('review-auto-fix') as string | undefined;
  if (autoFixValue !== undefined) {
    const autoFix = parseReviewToggle(autoFixValue);
    if (autoFix === null) {
      return {
        error: `Invalid --review-auto-fix value '${autoFixValue}'. Must be one of: ${REVIEW_TOGGLE_INPUTS.join(', ')}.`,
      };
    }
    overrides.auto_fix = autoFix;
  }

  return { overrides };
}

/** The shared help block, so three usage texts cannot describe four things. */
export const REVIEW_FLAGS_USAGE = `  --review <mode>    How this task gets reviewed once it declares final:
                       low-high  (default) the writer self-reviews in its own
                                 session — a low-effort draft, a high-effort
                                 hostile self-review, one revise pass
                       separate  a reviewer runs afterwards in its own session
                                 and its verdict gates accept: 3-4x the
                                 wall-clock and tokens, for when it is worth it
                       off       no review at all
  --review-gate <g>  When a recorded review holds the merge: auto (default —
                     the mode decides, and a review you asked for with
                     'lazy review' always gates), always (any recorded review
                     gates, the low-high self-review included), or never.
  --review-auto-fix <on|off>
                     In 'separate' mode, whether a review that found something
                     starts a fix turn by itself. Default off: the task parks
                     with its findings and you decide whether a round is worth
                     it.
                     All three persist on the task and take effect next turn.
                     Omit any of them to inherit the parent task's value, or
                     the lazy.toml [review] default for a top-level task.`;
