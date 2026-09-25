/**
 * The nav's counts — ONE computation behind two surfaces: the daemon
 * dashboard's `/api/nav-counts` (./index.ts) and the daemon's `navCounts` RPC,
 * which Lazy Teams' nav reads. Both used to be a question each client could
 * answer its own way; routing both through here is what keeps a Teams badge
 * and a dashboard badge from reporting different numbers for the same store.
 */

import type { Storage } from '../storage';
import { logger } from '../utils/logger';
import { isClusterTask } from '../types';
import { activeClusterCount } from '../task/cluster-entries';
import { unreadCount } from './messages';
import type { ReviewActions } from './review-actions';

/** What {@link computeNavCounts} answers. `null` on any field = "could not find out". */
export interface NavCounts {
  unread: number | null;
  review: number | null;
  clusters: number | null;
  raisedBlocking: number | null;
  raisedNonBlocking: number | null;
  followups: number | null;
  conversations: number | null;
  conversationsLatestAt: number;
}

/**
 * Every count the nav shows, in one response.
 *
 * ONE ENDPOINT, NOT FOUR: the badge script runs on EVERY page, so a fetch per
 * badge would multiply the dashboard's request count by four to fill four
 * numbers in the chrome. Each count is produced by the SAME query its own page
 * runs — the review queue through {@link ReviewActions}, open raised items with
 * the option set behind "Needs attention", unread through the inbox's own
 * `unreadCount` — so a badge can never quietly disagree with the page it points
 * at. Bodies and rows are never shipped; this route answers with numbers.
 *
 * CONVERSATIONS HAVE NO READ STATE. Nothing in the store records that a human
 * looked at a conversation, and inventing a server-side one would mean writing
 * on a surface that is read-only by construction (see ./conversations.ts). So
 * "new since you last looked" is the BROWSER's mark: it sends back the newest
 * `importedAt` it has already been shown, and this route counts what is newer.
 * No mark means that browser has never looked and every conversation is new —
 * which is why the count is a plain `> since` with `since` defaulting to 0.
 *
 * `importedAt` (not `startedAt`) is the basis deliberately: capture stamps it on
 * every write, so a conversation that GREW since the last visit counts as new
 * again. That over-counts a live builder session — and never misses one that was
 * captured late with an old start time, which the alternative would.
 *
 * NULL IS NOT ZERO. A count this route could not produce — a sub-query that
 * failed, or the review queue with no action port injected — is `null`, and the
 * script leaves that badge empty. Reporting 0 would state "nothing is waiting
 * for you", which is a different claim from "I could not find out" and the one
 * that costs the human something when it is wrong.
 *
 * `conversationsSince` is the caller's mark (NaN or 0 for none). The dashboard
 * keeps it in the browser; Teams keeps one per member per project server-side
 * and passes it over the `navCounts` RPC.
 */
export async function computeNavCounts(
  storage: Storage,
  actions: ReviewActions | undefined,
  conversationsSince: number,
): Promise<NavCounts> {
  const raw = conversationsSince;
  // Anything that is not a positive finite number is not a mark: absent, empty,
  // NaN, negative and Infinity all mean "this browser has not looked", and
  // everything counts as new. Over-counting is visible and self-corrects on the
  // next visit; under-counting hides work silently.
  const asked = Number.isFinite(raw) && raw > 0 ? raw : 0;

  // allSettled, not all: these are four independent stores of truth and one of
  // them failing must cost one badge, not the whole nav. A rejection here would
  // otherwise become a 500 and the script would render no numbers at all —
  // Review, Inbox and Raised would go dark because a conversation file is
  // corrupt.
  const [messages, raised, conversations, queue, liveTasks] = await Promise.allSettled([
    storage.listSystemMessages({ includeDismissed: false }),
    // The exact option set /raised uses for its default "Needs attention"
    // view, so the badge and that page report the same numbers.
    storage.listRaisedItems({ state: 'open', collapseExactDuplicates: true }),
    storage.listConversationSummaries(),
    // No action port means no review surface either (those routes answer 503),
    // so the badge reports nothing rather than counting the queue a second way
    // here — a number pointing at a page that will not load is worse than none.
    actions ? actions.listQueue() : Promise.resolve(null),
    // Clusters badge: live cluster TASKS. Non-terminal only, because the badge
    // asks "how many clusters are running", and a finished cluster is history the
    // page still lists.
    storage.listTasksWithOptions({ nonTerminalOnly: true }),
  ]);

  logRejected('nav counts', { messages, raised, conversations, queue, liveTasks });

  const summaries = conversations.status === 'fulfilled' ? conversations.value : null;
  const latestAt = summaries?.reduce((max, c) => Math.max(max, c.importedAt), 0) ?? 0;
  // A mark ahead of everything this store holds was not produced by this server
  // (a hand-edited value, or a store that has since been rebuilt or pruned).
  // Trusting it would leave the badge dark forever, and the only thing that
  // would repair it is a visit to the page the badge exists to send you to.
  const since = asked > latestAt ? 0 : asked;

  return {
    unread: messages.status === 'fulfilled' ? unreadCount(messages.value) : null,
    review: queue.status === 'fulfilled' ? (queue.value?.length ?? null) : null,
    clusters: liveTasks.status === 'fulfilled'
      ? activeClusterCount(liveTasks.value.filter((t) => isClusterTask(t)))
      : null,
    // Two numbers, one badge: blocking items hold up an accept and non-blocking
    // ones never do, so a single total would hide the only one that is urgent.
    raisedBlocking: raised.status === 'fulfilled' ? raised.value.total_open_blocking : null,
    raisedNonBlocking: raised.status === 'fulfilled' ? raised.value.total_open_non_blocking : null,
    // Pre-unification key, kept for one release so an older cached nav script
    // (or a Teams client reading this endpoint) still renders a number.
    followups: raised.status === 'fulfilled' ? raised.value.total : null,
    conversations: summaries ? summaries.filter((c) => c.importedAt > since).length : null,
    // The browser stores this as its next mark, so the mark is always a value
    // this server produced — a browser with a skewed clock still says exactly
    // what it was shown rather than guessing with its own `Date.now()`.
    conversationsLatestAt: latestAt,
  };
}

/**
 * Log whichever of a settled batch rejected, naming each one.
 *
 * A degraded badge is silent by design in the browser; it must not also be
 * silent in the daemon, or the first sign of a broken store is a number that
 * quietly stopped appearing.
 */
function logRejected(label: string, results: Record<string, PromiseSettledResult<unknown>>): void {
  for (const [name, result] of Object.entries(results)) {
    if (result.status !== 'rejected') continue;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    logger.warn(`${label}: ${name} count unavailable: ${reason}`);
  }
}
