/**
 * Which member is inside which task's environment, on a shared daemon — and
 * the container of their own that their terminals run in.
 *
 * A member's terminals never run in the task's container: they run in a
 * container created for that member (src/daemon/member-container.ts) when
 * their first terminal gets past the entry, and every further terminal of
 * theirs joins it. It is theirs alone, which is why any number of their own
 * terminals may share it (one principal, one process space) and why nobody
 * else's may. Their shell there is the container's `shell` tmux session
 * (src/terminal/shell-session.ts), so closing a terminal does not end it.
 *
 * ANY NUMBER OF MEMBERS may be inside one task at once, each with a hold and a
 * container of their own on the same worktree (engineer, 2026-10-21: "there
 * is one *agent* and it has its state machine … let's assume human developers
 * know what they are doing and they can coordinate"). Holds are keyed by task
 * AND member, so one member's grace, kept sessions or failed vacate never
 * touches another's.
 *
 * The hold does NOT keep turns out (engineer, 2026-10-21): a member and the
 * agent work the same worktree at the same time, exactly as solo
 * `lazy shell`. What it still answers is whether a member is inside
 * (`membersInsideTask`), which is what a reject or close of the task waits on
 * and which environments its accept's follow-through must end
 * (src/daemon/member-entry.ts).
 *
 * When the member's LAST terminal closes, the hold lasts a grace period (the
 * same 30 seconds a dropped Pair keeps its lock), and then their sessions are
 * looked at: while the container has a live tmux session it is KEPT — the
 * member comes back to it — and looked at again every
 * {@link MEMBER_SESSION_CHECK_MS}, until the member ends their last session.
 * Then the vacate
 * runs: the container is removed — every process the member left running in it
 * dies with it — and its credential is revoked. While the vacate runs that
 * member's claims are refused; other members are unaffected. A hold whose claims never got past
 * the entry touched nothing and is freed the moment its last claim is released.
 *
 * In memory and per daemon on purpose: it tracks live sockets, which die with
 * the process that holds them. A restart (an upgrade, a fleet roll) does NOT
 * end a member's environment: the daemon's startup sweep re-adopts every
 * member container it can (src/daemon/member-leftovers.ts) and rebuilds its
 * hold here ({@link adoptMemberTerminal}) as if the member's last terminal had
 * just closed — so the member's terminals reconnect to the same tmux sessions,
 * without an idle or lifetime limit.
 * Only what cannot be re-adopted is removed, with its credential.
 */

import { logger } from '../utils/logger';
import type { SessionActivity } from '../terminal/shell-session';

/** How often a kept environment's sessions are looked at again. */
export const MEMBER_SESSION_CHECK_MS = 10 * 60_000;

/** Matches WEB_PAIR_GRACE_MS (./shell-pair.ts); not imported, to keep this module leaf. */
export const MEMBER_VACATE_GRACE_MS = 30_000;

/** What a hold needs to know about the member's container. */
export interface HeldContainer {
  name: string;
  binary: string;
  /** Finish interrupted restart recovery before probing or exposing the container. */
  prepare?: () => Promise<void>;
  /** A terminal exec started successfully; persist the end of restart protection. */
  attached?: () => Promise<void>;
  /** Daemon-owned directory mounted read-only into only this member's container. */
  mcpDirectory?: string;
  /** Run on every attach, not only at creation (see MemberContainer.adopt). */
  adopt?: () => Promise<void>;
  /**
   * The container's tmux sessions right now. Throws when it cannot be asked
   * (the container is gone, or the runtime failed). Absent: no sessions are
   * ever kept, and the container goes with the last terminal.
   */
  activity?: () => Promise<SessionActivity>;
  remove: () => Promise<void>;
  /** Env entries each terminal exec adds (see MemberContainer.execEnv). */
  execEnv?: (profile?: string) => Promise<string[]>;
}

interface Hold {
  taskId: string;
  email: string;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether any terminal under this hold got past the entry. From then on the
   * member counts as inside (teardown waits), and releasing the last claim
   * runs the vacate after the grace; a hold that never entered is freed at once.
   */
  entered: boolean;
  /** A runtime stop lost the shells. Failed connection attempts do not end this protection. */
  waitForAttach?: boolean;
  /** The vacate is running. This member's claims are refused until it finishes. */
  vacating: boolean;
  /** How the member's environment is discarded (see releaseMemberTerminal). */
  onVacate: ((container: HeldContainer | null) => Promise<void>) | null;
  /** The member's container, once asked for — shared by all their terminals. */
  container: Promise<HeldContainer> | null;
  /** Whether {@link container} has settled — a launch still running has not. */
  containerSettled: boolean;
  /**
   * Set when the hold is let go while its container launch had not landed:
   * what that launch makes is removed through this as soon as it lands.
   */
  orphanVacate?: ((container: HeldContainer | null) => Promise<void>) | null;
  /**
   * Serialises {@link memberTerminalContainer} for this hold: one look at the
   * container, and at most one replace, at a time. Two terminals opened
   * together onto a dead container would otherwise both remove it and both
   * launch a new one, leaving one running that no hold owns.
   */
  queue: Promise<unknown>;
}

/** Holds by task and member — see {@link holdKey}. */
const holds = new Map<string, Hold>();

function holdKey(taskId: string, email: string): string {
  return `${taskId}\n${email}`;
}

/** MCP authority ends as soon as this member's environment starts vacating. */
export function memberTerminalAuthority(taskId: string, email: string): object | null {
  const held = holds.get(holdKey(taskId, email));
  // The container promise is the environment's incarnation. A token for an
  // old environment must never revive when the same member opens a new one.
  return held?.entered && !held.vacating ? held.container : null;
}

/** Every hold on one task, whoever's. */
function taskHolds(taskId: string): Hold[] {
  const prefix = `${taskId}\n`;
  return [...holds.entries()].filter(([k]) => k.startsWith(prefix)).map(([, h]) => h);
}

/**
 * Claim `email`'s environment in the task. Refused only while that member's
 * own previous environment is being discarded. Every successful claim must be
 * released exactly once.
 */
export function claimMemberTerminal(
  taskId: string,
  email: string,
  onVacate?: (container: HeldContainer | null) => Promise<void>,
): { ok: true } | { ok: false; vacating: true } {
  const held = holds.get(holdKey(taskId, email));
  if (held?.vacating) return { ok: false, vacating: true };
  if (held) {
    if (held.timer) clearTimeout(held.timer);
    held.timer = null;
    held.count += 1;
    if (onVacate) held.onVacate = onVacate;
  } else {
    holds.set(holdKey(taskId, email), { taskId, email, count: 1, timer: null, entered: false, vacating: false, onVacate: onVacate ?? null, container: null, containerSettled: false, queue: Promise.resolve() });
  }
  return { ok: true };
}

/**
 * Record that a claim got past the entry. Called by the entry UNDER THE TASK'S
 * LIFECYCLE LOCK, so a turn launch taking the same lock sees it.
 */
export function markMemberTerminalEntered(taskId: string, email: string): void {
  const held = holds.get(holdKey(taskId, email));
  if (held) held.entered = true;
}

/** A successful exec, rather than a claim or ownership check, ends restart protection. */
export async function markMemberTerminalAttached(taskId: string, email: string, container: HeldContainer): Promise<void> {
  const held = holds.get(holdKey(taskId, email));
  if (!held || held.vacating || !held.container || await held.container !== container) return;
  await container.attached?.();
  if (holds.get(holdKey(taskId, email)) === held) {
    held.waitForAttach = false;
    if (held.count === 0) releaseMemberTerminal(taskId, email);
  }
}

/** Startup retries must recognize an environment this daemon already recovered. */
export async function heldMemberContainerName(taskId: string, email: string): Promise<string | null> {
  const held = holds.get(holdKey(taskId, email));
  return held && !held.vacating && held.container ? (await held.container).name : null;
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
  const held = holds.get(holdKey(taskId, email));
  if (!held) {
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
  // Let go before this launch even started (its terminal closed): start nothing.
  if (holds.get(holdKey(taskId, held.email)) !== held) throw new Error(ABANDONED_LAUNCH);
  if (held.container) {
    const existing = await held.container.catch(() => null);
    // A failed restart is not permission to replace the member's environment.
    // Preparation throws before the destructive dead-container path below.
    await existing?.prepare?.();
    if (existing && (await isRunning(existing))) return existing;
    if (existing) await existing.remove();
    if (holds.get(holdKey(taskId, held.email)) === held) held.container = null;
  }
  const pending = launch();
  held.container = pending;
  held.containerSettled = false;
  try {
    const container = await pending;
    if (held.orphanVacate) {
      // Nobody is waiting for it any more: remove it, retrying like any vacate.
      const vacate = held.orphanVacate;
      vacateUntilGone(taskId, held, () => vacate(container));
      throw new Error(ABANDONED_LAUNCH);
    }
    return container;
  } catch (err) {
    if (held.container === pending) held.container = null;
    throw err;
  } finally {
    if (held.container === pending) held.containerSettled = true;
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
 * Run a vacate until it succeeds. The hold stays — `vacating`, refusing this
 * member's claims and keeping a reject or close waiting — for as long as the
 * member's container may still be running: a process they left in it (a
 * watcher, a dev server) would otherwise keep writing into the worktree after
 * it was removed. Each
 * failure is logged; the hold is freed only after a removal that worked.
 */
function vacateUntilGone(taskId: string, held: Hold, vacate: () => Promise<void>, attempt = 0): void {
  void (async () => {
    try {
      await vacate();
    } catch (err) {
      const delay = vacateRetryDelaysMs[Math.min(attempt, vacateRetryDelaysMs.length - 1)] ?? 60_000;
      logger.warn(
        `[${taskId.substring(0, 8)}] Could not discard the terminal environment ${isLeftover(held) ? LEFTOVER_HOLDER.toLowerCase() : held.email} left ` +
        `(attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}. ` +
        `The task's worktree is not removed until it is gone; retrying in ${Math.round(delay / 1000)}s.`,
      );
      held.timer = setTimeout(() => {
        held.timer = null;
        vacateUntilGone(taskId, held, vacate, attempt + 1);
      }, delay);
      return;
    }
    const key = holdKey(taskId, held.email);
    if (holds.get(key) === held && held.count === 0) holds.delete(key);
  })();
}

/**
 * A member container the daemon found at startup and could not remove (the
 * previous daemon's; nobody's terminal is attached to it any more). Held like
 * a failed vacate — the task's worktree kept until it is gone — and retried
 * until it is gone. Several leftovers on one task each get their own hold.
 */
let leftoverSeq = 0;
export function holdLeftoverMemberContainer(taskId: string, remove: () => Promise<void>): void {
  const held: Hold = { taskId, email: `${LEFTOVER_HOLDER}\u0000${++leftoverSeq}`, count: 0, timer: null, entered: true, vacating: true, onVacate: null, container: null, containerSettled: false, queue: Promise.resolve() };
  holds.set(holdKey(taskId, held.email), held);
  vacateUntilGone(taskId, held, remove);
}

/**
 * Rebuild the hold of a member container a previous daemon left running, once
 * the startup sweep has re-adopted it (its credential still resolving, its home
 * kept). The hold starts where a released one stands: no terminal open,
 * entered (teardown waits for it), and after the grace its sessions are looked
 * at exactly as {@link releaseMemberTerminal} would — kept while one is live,
 * vacated (removed, credential revoked, home handed back) once the member ends
 * their last session. The member's next
 * terminal claims it and joins the same container. False when this member
 * already holds the task (nothing is replaced). A stopped container whose
 * shells were lost waits for its next attach before session checks resume.
 */
export function adoptMemberTerminal(
  taskId: string,
  email: string,
  container: HeldContainer,
  graceMs = MEMBER_VACATE_GRACE_MS,
  timing: { checkEveryMs?: number; waitForAttach?: boolean } = {},
): boolean {
  const key = holdKey(taskId, email);
  if (holds.has(key)) return false;
  const held: Hold = {
    taskId, email, count: 0, timer: null, entered: true, vacating: false, onVacate: null,
    waitForAttach: timing.waitForAttach,
    container: Promise.resolve(container), containerSettled: true, queue: Promise.resolve(),
  };
  holds.set(key, held);
  // Restarting a stopped container loses its shells, not its installed tools
  // or files. No empty-session check until the member next opens a terminal.
  if (timing.waitForAttach) return true;
  held.timer = setTimeout(() => {
    held.timer = null;
    void settleReleasedHold(taskId, held, held.onVacate ?? (async (c: HeldContainer | null) => { await c?.remove(); }), timing);
  }, graceMs);
  return true;
}

/** Who a leftover container's hold names, in every refusal it causes. */
export const LEFTOVER_HOLDER = 'An earlier terminal session';

/**
 * Release one terminal. On the member's last one, start the grace; when it
 * lapses without a reclaim, keep the member's container while it has live
 * sessions ({@link settleReleasedHold}), and otherwise remove it (and anything
 * else `onVacate` does), retrying until the removal works (see
 * vacateUntilGone), and only then free the task. `onVacate` must THROW when
 * the container may still be running.
 */
export function releaseMemberTerminal(
  taskId: string,
  email: string,
  onVacate?: (container: HeldContainer | null) => Promise<void>,
  graceMs = MEMBER_VACATE_GRACE_MS,
  timing: { checkEveryMs?: number } = {},
): void {
  const held = holds.get(holdKey(taskId, email));
  if (!held) return;
  if (onVacate) held.onVacate = onVacate;
  held.count = Math.max(0, held.count - 1);
  if (held.count > 0) return;
  if (held.timer) clearTimeout(held.timer);
  if (held.waitForAttach) return;
  const vacateFn = held.onVacate ?? (async (c: HeldContainer | null) => { await c?.remove(); });
  if (!held.entered || !held.container || !held.containerSettled) {
    // No terminal of this member's ever ran: refused at the entry, or they
    // left while their container was still being made (an image build can
    // take minutes). Nothing of theirs can be running, so free the hold NOW
    // rather than keep the task's teardown waiting for the grace — or for the
    // rest of a build. A launch not started yet never starts, and one still running is
    // removed as soon as it lands (containerFor, through `orphanVacate`,
    // retried like any vacate; the detached hold holds nothing). The build
    // itself is not cancelled: the image is shared with turn launches. A
    // terminal reopened meanwhile starts its own launch, and member container
    // names are unique, so this removal can never reach it.
    holds.delete(holdKey(taskId, email));
    held.orphanVacate = vacateFn;
    return;
  }
  held.timer = setTimeout(() => {
    held.timer = null;
    void settleReleasedHold(taskId, held, vacateFn, timing);
  }, graceMs);
}

/**
 * A hold with no terminal open: keep it while its container has a session
 * worth coming back to, else vacate. Looked at again every
 * `checkEveryMs` while kept; a reclaim (the member coming back) cancels it.
 */
async function settleReleasedHold(
  taskId: string,
  held: Hold,
  vacate: (container: HeldContainer | null) => Promise<void>,
  timing: { checkEveryMs?: number },
): Promise<void> {
  if (holds.get(holdKey(taskId, held.email)) !== held || held.count > 0 || held.vacating || held.waitForAttach) return;
  const container = held.container ? await held.container.catch(() => null) : null;
  let keep = false;
  if (container?.activity) {
    try {
      const a = await container.activity();
      keep = a.sessions > 0;
    } catch (err) {
      // A failed probe does not prove the member ended their sessions.
      keep = true;
      logger.warn(`[${taskId.substring(0, 8)}] Could not list ${held.email}'s sessions: ${err instanceof Error ? err.message : String(err)}. Keeping their environment and retrying.`);
    }
  }
  // Reclaimed while we were asking.
  if (holds.get(holdKey(taskId, held.email)) !== held || held.count > 0 || held.vacating) return;
  if (keep) {
    held.timer = setTimeout(() => {
      held.timer = null;
      void settleReleasedHold(taskId, held, vacate, timing);
    }, timing.checkEveryMs ?? MEMBER_SESSION_CHECK_MS);
    return;
  }
  held.vacating = true;
  vacateUntilGone(taskId, held, async () => {
    const c = held.container ? await held.container.catch(() => null) : null;
    await vacate(c);
  });
}

/**
 * End EVERY member's sessions on this task now — their containers removed,
 * their credentials revoked — whether or not their terminals are open: the
 * explicit confirmation of a reject or close that would otherwise wait for
 * them. Resolves once every environment is gone (or there was none); throws
 * when any removal failed, leaving that hold vacating and its removal retried.
 */
export async function endMemberSessions(taskId: string): Promise<void> {
  const failures: string[] = [];
  for (const held of taskHolds(taskId)) {
    if (held.timer) clearTimeout(held.timer);
    held.timer = null;
    if (isLeftover(held)) {
      failures.push('an earlier terminal environment is still being removed');
      continue;
    }
    held.vacating = true;
    const vacate = held.onVacate ?? (async (c: HeldContainer | null) => { await c?.remove(); });
    const run = async () => {
      const c = held.container ? await held.container.catch(() => null) : null;
      await vacate(c);
    };
    try {
      await run();
    } catch (err) {
      vacateUntilGone(taskId, held, run, 1);
      failures.push(`${held.email}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const key = holdKey(taskId, held.email);
    if (holds.get(key) === held) holds.delete(key);
  }
  if (failures.length > 0) {
    throw new Error(`on task ${taskId.substring(0, 8)}: ${failures.join('; ')}`);
  }
}

/**
 * End ONE member's environments on every task of this daemon now — containers
 * removed, credentials revoked, open terminals included — for a member who has
 * left the team. Same teardown as {@link endMemberSessions}, scoped to the
 * member instead of the task. Throws when any removal failed; that hold stays
 * vacating and its removal is retried.
 */
export async function endMemberEnvironmentsOf(email: string): Promise<void> {
  const who = email.trim().toLowerCase();
  const failures: string[] = [];
  for (const held of [...holds.values()]) {
    if (isLeftover(held) || held.email.toLowerCase() !== who) continue;
    if (held.timer) clearTimeout(held.timer);
    held.timer = null;
    held.vacating = true;
    const vacate = held.onVacate ?? (async (c: HeldContainer | null) => { await c?.remove(); });
    const run = async () => {
      const c = held.container ? await held.container.catch(() => null) : null;
      await vacate(c);
    };
    try {
      await run();
    } catch (err) {
      vacateUntilGone(held.taskId, held, run, 1);
      failures.push(`task ${held.taskId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const key = holdKey(held.taskId, held.email);
    if (holds.get(key) === held) holds.delete(key);
  }
  if (failures.length > 0) throw new Error(`could not remove ${email}'s environments: ${failures.join('; ')}`);
}

/** Every member holding an environment in this task (open terminals, grace, kept sessions, or vacating), entered or not. */
export function memberTerminalHolders(taskId: string): string[] {
  return taskHolds(taskId).map((h) => (isLeftover(h) ? LEFTOVER_HOLDER : h.email));
}

function isLeftover(held: Hold): boolean {
  return held.email.startsWith(`${LEFTOVER_HOLDER}\u0000`);
}

/**
 * The members inside this task's environment right now — terminals open,
 * sessions kept, within the grace, or being vacated — in the order they
 * first claimed; empty when nobody is. A claim that has not got past the entry does
 * not count: it may still be refused. A leftover container from an earlier
 * daemon is named {@link LEFTOVER_HOLDER}. Turns never read this; teardown
 * does (src/daemon/member-entry.ts).
 */
export function membersInsideTask(taskId: string): string[] {
  const names = taskHolds(taskId)
    .filter((h) => h.entered || h.vacating)
    .map((h) => (isLeftover(h) ? LEFTOVER_HOLDER : h.email));
  return [...new Set(names)];
}

/**
 * Each member inside this task (as {@link membersInsideTask} counts them,
 * leftovers and vacating holds excepted), with how many terminals they have
 * open and their container once it exists — what "who else is here" lists.
 */
export async function memberEnvironmentsInTask(
  taskId: string,
): Promise<Array<{ email: string; openTerminals: number; container: HeldContainer | null }>> {
  const out: Array<{ email: string; openTerminals: number; container: HeldContainer | null }> = [];
  for (const h of taskHolds(taskId)) {
    if (!h.entered || h.vacating || isLeftover(h)) continue;
    const container = h.container && h.containerSettled ? await h.container.catch(() => null) : null;
    out.push({ email: h.email, openTerminals: h.count, container });
  }
  return out;
}

/** Why a launch was dropped: the terminal that asked for it is gone. */
export const ABANDONED_LAUNCH = 'the terminal closed before its environment was ready';

/** Why a member cannot enter while their own environment is being discarded. */
export const MEMBER_VACATING_MESSAGE =
  "Your last terminal environment on this task is still being discarded. Open the terminal again in a moment.";

/**
 * The members inside this task as one phrase ("a", "a and b", "a, b and c"),
 * or null when nobody is — for messages and notes that name them all.
 */
export function memberNamesInsideTask(taskId: string): string | null {
  const names = membersInsideTask(taskId);
  return names.length === 0 ? null : joinNames(names);
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Why a reject, close or redo cannot remove the task's worktree right now. */
export function memberInsideTeardownMessage(holders: string[]): string {
  const who = `${joinNames(holders)} ${holders.length === 1 ? 'has' : 'have'}`;
  return `${who} sessions open in this task, and its files cannot be removed from under them. ` +
    `Try again once they have ended their sessions, or end them first: tick "End open sessions first" in Lazy Teams, or pass --end-sessions.`;
}

/** Test seam. */
export function resetMemberTerminalsForTests(): void {
  for (const held of holds.values()) if (held.timer) clearTimeout(held.timer);
  holds.clear();
  vacateRetryDelaysMs = [5_000, 15_000, 30_000, 60_000];
}
