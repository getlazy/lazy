/**
 * The wording of the sticky review bar's two comment counters — written once,
 * in two languages.
 *
 * The bar is rendered by the server and then rewritten in place by the poll
 * that refreshes the threads, so a label spelled in only one of the two places
 * flickers to the other spelling on the first poll. Both spellings live here
 * side by side, and `test/unit/status-bar-labels.test.ts` evaluates the JS
 * source against the TS functions so they cannot drift.
 *
 * They deliberately name WHAT is counted: "0 queued / 0 awaiting agent" reads
 * as a work queue on a page that is all about one task's work, which is not
 * what either number is. `queued` is review comments waiting to ride the next
 * unblock; `asks` is questions the reviewer sent that the agent has not
 * answered yet.
 */

export function queuedBarLabel(n: number): string {
  return `${n} comment${n === 1 ? '' : 's'} queued`;
}

export function asksBarLabel(n: number): string {
  return `${n} ask${n === 1 ? '' : 's'} awaiting an answer`;
}

/** Hover text for the queued counter — when the number moves, and where. */
export const QUEUED_BAR_TITLE =
  'Review comments you have written that have not been sent yet. They ride the next Unblock, all together.';

/** Hover text for the asks counter. */
export const ASKS_BAR_TITLE =
  'Questions you asked the agent that it has not answered yet. Goes back to zero when the agent replies.';

/**
 * The same two functions as JS source, inlined into the review island.
 * Keep the bodies character-for-character equivalent to the TS above.
 */
export const STATUS_BAR_LABELS_JS = `
  function queuedBarLabel(n) { return n + ' comment' + (n === 1 ? '' : 's') + ' queued'; }
  function asksBarLabel(n) { return n + ' ask' + (n === 1 ? '' : 's') + ' awaiting an answer'; }
`;
