/**
 * Which member is inside which task's environment, on a shared daemon — and
 * the container of their own that their terminals run in.
 *
 * A member's terminals never run in the task's container: they run in a
 * container created for that member (src/daemon/member-container.ts) when
 * their first terminal gets past the entry, and every further terminal of
 * theirs joins it. It is theirs alone, which is why any number of their own
 * terminals may share it (one principal, one process space) and why nobody
 * else's may.
 *
 * ONE MEMBER AT A TIME per task. Not for the containers' sake — they are
 * separate — but for the worktree's: two people editing one checkout at once,
 * each through their own agent, is not something either of them asked for.
 *
 * The hold is also what keeps turns out. A member inside (`entered`) makes
 * every turn launch refuse (src/daemon/turn-credentials.ts,
 * `refuseLaunchWhileMemberInside`), and the entry itself is refused while a
 * turn runs (src/daemon/member-entry.ts) — both under the task's lifecycle
 * lock. The resource they would otherwise share is the worktree's files.
 *
 * When the member's LAST terminal closes, the hold lasts a grace period (the
 * same 30 seconds a dropped Pair keeps its lock, so a reload reattaches to the
 * same container), and then the vacate runs: the container is removed — every
 * process the member left running in it dies with it — and its credential is
 * revoked. Only after that does another member, or a turn, get in. While the
 * vacate runs every claim is refused, the same member's too. A hold whose
 * claims never got past the entry touched nothing and is freed the moment its
 * last claim is released.
 *
 * In memory and per daemon on purpose: it tracks live sockets, which die with
 * the process that holds them. What a restart leaves behind — the containers
 * and their credentials — is swept at daemon startup.
 */

import { logger } from '../utils/logger';

/** Matches WEB_PAIR_GRACE_MS (./shell-pair.ts); not imported, to keep this module leaf. */
export const MEMBER_VACATE_GRACE_MS = 30_000;

/** What a hold needs to know about the member's container. */
export interface HeldContainer {
  name: string;
  binary: string;
  remove: () => Promise<void>;
}

interface Hold {
  email: string;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether any terminal under this hold got past the entry. From then on
   * turns are refused, and releasing the last claim runs the vacate after the
   * grace; a hold that never entered is freed at once.
   */
  entered: boolean;
  /** The vacate is running. Every claim is refused until it finishes. */
  vacating: boolean;
  /** The member's container, once asked for — shared by all their terminals. */
  container: Promise<HeldContainer> | null;
  /**
   * Serialises {@link memberTerminalContainer} for this hold: one look at the
   * container, and at most one replace, at a time. Two terminals opened
   * together onto a dead container would otherwise both remove it and both
   * launch a new one, leaving one running that no hold owns.
   */
  queue: Promise<unknown>;
}

const holds = new Map<string, Hold>();

/**
 * Claim the task's environment for `email`, or return the member already
 * holding it. Every successful claim must be released exactly once.
 */
export function claimMemberTerminal(
  taskId: string,
  email: string,
): { ok: true } | { ok: false; holder: string; vacating?: boolean } {
  const held = holds.get(taskId);
  if (held?.vacating) return { ok: false, holder: held.email, vacating: true };
  if (held && held.email !== email) return { ok: false, holder: held.email };
  if (held) {
    if (held.timer) clearTimeout(held.timer);
    held.timer = null;
    held.count += 1;
  } else {
    holds.set(taskId, { email, count: 1, timer: null, entered: false, vacating: false, container: null, queue: Promise.resolve() });
  }
  return { ok: true };
}

/**
 * Record that a claim got past the entry. Called by the entry UNDER THE TASK'S
 * LIFECYCLE LOCK, so a turn launch taking the same lock sees it.
 */
export function markMemberTerminalEntered(taskId: string, email: string): void {
  const held = holds.get(taskId);
  if (held && held.email === email) held.entered = true;
}

/**
 * The member's container, created on first use and shared by all their
 * terminals under this hold. A launch that fails is forgotten, so the next
 * terminal tries again rather than inheriting the failure. A container that
 * has died since (`isRunning` false) is removed and replaced.
 */
export async function memberTerminalContainer(
  taskId: string,
  email: string,
  launch: () => Promise<HeldContainer>,
  isRunning: (c: HeldContainer) => Promise<boolean>,
): Promise<HeldContainer> {
  const held = holds.get(taskId);
  if (!held || held.email !== email) {
    throw new Error(`no terminal hold for ${email} on task ${taskId.substring(0, 8)}`);
  }
  const turn = held.queue.then(() => containerFor(taskId, held, launch, isRunning));
  // The next caller waits for this one whatever it ends with.
  held.queue = turn.then(() => undefined, () => undefined);
  return turn;
}

async function containerFor(
  taskId: string,
  held: Hold,
  launch: () => Promise<HeldContainer>,
  isRunning: (c: HeldContainer) => Promise<boolean>,
): Promise<HeldContainer> {
  if (held.container) {
    const existing = await held.container.catch(() => null);
    if (existing && (await isRunning(existing))) return existing;
    if (existing) await existing.remove();
    if (holds.get(taskId) === held) held.container = null;
  }
  const pending = launch();
  held.container = pending;
  try {
    return await pending;
  } catch (err) {
    if (held.container === pending) held.container = null;
    throw err;
  }
}

/**
 * How long to wait before each retry of a vacate that failed — the last
 * delay repeats until the removal succeeds. Seam for tests.
 */
let vacateRetryDelaysMs = [5_000, 15_000, 30_000, 60_000];
export function setMemberVacateRetryDelaysForTests(delays: number[]): void {
  vacateRetryDelaysMs = delays;
}

/**
 * Run a vacate until it succeeds. The hold stays — `vacating`, refusing every
 * claim and keeping turns off the task — for as long as the member's container
 * may still be running: a process they left in it (a watcher, a dev server)
 * would otherwise keep writing into the worktree under the next turn. Each
 * failure is logged; the hold is freed only after a removal that worked.
 */
function vacateUntilGone(taskId: string, held: Hold, vacate: () => Promise<void>, attempt = 0): void {
  void (async () => {
    try {
      await vacate();
    } catch (err) {
      const delay = vacateRetryDelaysMs[Math.min(attempt, vacateRetryDelaysMs.length - 1)] ?? 60_000;
      logger.warn(
        `[${taskId.substring(0, 8)}] Could not discard the terminal environment ${held.email} left ` +
        `(attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}. ` +
        `Turns on this task stay held until it is gone; retrying in ${Math.round(delay / 1000)}s.`,
      );
      held.timer = setTimeout(() => {
        held.timer = null;
        vacateUntilGone(taskId, held, vacate, attempt + 1);
      }, delay);
      return;
    }
    const now = holds.get(taskId);
    if (now === held && held.count === 0) holds.delete(taskId);
  })();
}

/**
 * A member container the daemon found at startup and could not remove (the
 * previous daemon's; nobody's terminal is attached to it any more). Held like
 * a failed vacate — turns and members kept off the task — and retried until
 * it is gone.
 */
export function holdLeftoverMemberContainer(taskId: string, remove: () => Promise<void>): void {
  const held: Hold = { email: LEFTOVER_HOLDER, count: 0, timer: null, entered: true, vacating: true, container: null, queue: Promise.resolve() };
  holds.set(taskId, held);
  vacateUntilGone(taskId, held, remove);
}

/** Who a leftover container's hold names, in every refusal it causes. */
export const LEFTOVER_HOLDER = 'An earlier terminal session';

/**
 * Release one terminal. On the member's last one, start the grace; when it
 * lapses without a reclaim, remove the member's container (and anything else
 * `onVacate` does), retrying until the removal works (see vacateUntilGone),
 * and only then free the task. `onVacate` must THROW when the container may
 * still be running.
 */
export function releaseMemberTerminal(
  taskId: string,
  email: string,
  onVacate?: (container: HeldContainer | null) => Promise<void>,
  graceMs = MEMBER_VACATE_GRACE_MS,
): void {
  const held = holds.get(taskId);
  if (!held || held.email !== email) return;
  held.count = Math.max(0, held.count - 1);
  if (held.count > 0) return;
  if (held.timer) clearTimeout(held.timer);
  if (!held.entered || !held.container) {
    // Nothing of this member's ever got in — refused at the entry, or its
    // container never came up: there is nothing to discard, so free it now
    // rather than keep other members and turns out for the whole grace.
    holds.delete(taskId);
    return;
  }
  held.timer = setTimeout(() => {
    held.timer = null;
    held.vacating = true;
    vacateUntilGone(taskId, held, async () => {
      const container = held.container ? await held.container.catch(() => null) : null;
      await onVacate?.(container);
    });
  }, graceMs);
}

/** Who holds this task's environment right now (open terminals or grace), or null. */
export function memberTerminalHolder(taskId: string): string | null {
  return holds.get(taskId)?.email ?? null;
}

/**
 * The member whose terminals keep turns off this task right now — inside,
 * within the grace, or being vacated — or null. A claim that has not got past
 * the entry does not count: it may still be refused.
 */
export function memberInsideTask(taskId: string): string | null {
  const held = holds.get(taskId);
  return held && (held.entered || held.vacating) ? held.email : null;
}

/** Why nobody can enter while an environment is being discarded. */
export const MEMBER_VACATING_MESSAGE =
  "The last terminal environment on this task is being discarded. Open the terminal again in a moment.";

/** Why another member cannot enter right now — one sentence, shared with the preflight. */
export function memberHeldMessage(holder: string): string {
  return `${holder} has a terminal open on this task. Only one member can work in a task at a time — try again once they have closed their terminals (their session ends within 30 seconds of the last one closing).`;
}

/** Why a turn cannot start right now — one sentence for every launch path. */
export function memberInsideLaunchMessage(holder: string): string {
  return `${holder} has a terminal open on this task, and a turn cannot start while they are working in it. ` +
    `Try again once they have closed their terminals (their session ends within 30 seconds of the last one closing).`;
}

/** Why a sync, accept, close or reject cannot touch the task's worktree right now. */
export function memberInsideSyncMessage(holder: string): string {
  return `${holder} has a terminal open on this task, and its files cannot be merged into or cleaned up while they are ` +
    `working in them. Try again once they have closed their terminals (their session ends within 30 seconds of the last one closing).`;
}

/** Why the agent's environment cannot be brought up without a turn right now. */
export function memberInsideEnvironmentMessage(holder: string): string {
  return `${holder} has a terminal open on this task, and the agent's environment stays stopped while they are working in it. ` +
    `Try again once they have closed their terminals (their session ends within 30 seconds of the last one closing).`;
}

/** Test seam. */
export function resetMemberTerminalsForTests(): void {
  for (const held of holds.values()) if (held.timer) clearTimeout(held.timer);
  holds.clear();
  vacateRetryDelaysMs = [5_000, 15_000, 30_000, 60_000];
}
