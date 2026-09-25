/**
 * WHO ASKED FOR THIS TURN — the one record, and the two questions it answers.
 *
 * A turn is launched because somebody asked for it: ivan unblocked the task,
 * pete accepted it, a person pressed retry on the review page. Everything the
 * agent then does for the length of that turn is that person's work
 * (docs/design/actor-identity-and-remote-clients.md §3.3 case 2). Two different
 * consumers need to know who they were:
 *
 *   BILLING — which credential the turn spends. Answered from the pending
 *   owner of the REQUEST the launch runs inside (below), and only for an owner
 *   whose identity came from a per-user TOKEN (see `spendable`).
 *
 *   ATTRIBUTION — whose name goes on the rows the agent writes. Answered from
 *   the SESSION, where the owner is recorded durably at launch, because an
 *   agent writes for the whole length of a turn and a daemon restarted in the
 *   middle of one has no memory left. That gap is the reason this half is on
 *   disk rather than in the request scope.
 *
 * The two are ordered: the RPC layer runs a turn-launching command as its
 * caller's request (the PENDING owner), and the launch path promotes that owner
 * to the session (see {@link recordSessionTurnOwner}, called from
 * planTurnCredential — the one function every launch path goes through). A launch that finds no pending
 * owner records NONE, which keeps meaning system-initiated: the reconciler's
 * auto-resume, auto-deliver and a sync nobody asked for record no ASKER, rather
 * than inheriting whichever human touched the task last.
 *
 * "Nobody asked" is not the same as "nobody is named". The rows those turns
 * write name the account that CONFIGURED the automation, under the role
 * `system` (§3.3 case 3, ../identity/system-identity.ts) — resolved when the
 * row is written rather than stored on the session, so that the record of who
 * ASKED stays exactly what it says it is: empty.
 *
 * IDENTITY IS NEVER A REQUEST FIELD. The pending owner is derived from the
 * caller's user token, or — on a laptop, where there is no control plane — from
 * the daemon's own git config, exactly as `applyCallerActor` derives the person
 * it stamps. An agent never sends an identity and could not: the daemon looks
 * the owner up from the task it has already authenticated the agent as
 * (`authorizeMcpCall`).
 */

import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../utils/logger';
import { actorEmail, actorRole, canonicalPersonEmail } from '../actor-ref';
import { AGENT_ACTOR, SYSTEM_ACTOR } from '../constants';
import { shortId } from '../task/identity';
import type { CreateTurnOptions, Storage } from '../storage/interface';
import type { Actor, ActorInput, Turn, TurnAttribution, TurnOwner } from '../types';

/**
 * A pending turn owner: the person, plus whether their identity is one this
 * daemon may SPEND.
 *
 * `spendable` is true only for a token-derived owner — a member a control plane
 * authenticated and provisioned a credential for. A laptop's git identity names
 * the same person for attribution but is not an account the per-user credential
 * registry knows, so billing must keep its existing answer for it (the daemon's
 * own env, or the service credential) rather than refusing the turn because
 * nobody put a credential under that address.
 */
export interface PendingTurnOwner extends TurnOwner {
  spendable: boolean;
}

/**
 * The turn-launching request currently being served, for code running inside
 * it — the ONLY place a pending owner lives.
 *
 * `handleRpc` runs every turn-launching command inside
 * {@link runAsTurnOwnerRequest}, and a launch reads its owner from HERE:
 * directly, or in work that request queued and performs after returning (an
 * ask dispatched in the background), because an async context follows the
 * work that was started in it.
 *
 * THERE IS DELIBERATELY NO SHARED RECORD BEHIND IT. There used to be a per-task
 * slot, written when a request arrived and cleared when it ended, which a
 * launch outside any request fell back to. But a launch outside any request is
 * a turn the daemon started by itself — auto-deliver, auto-resume, the
 * pending-sync retry loop, a cluster restart — and its right answer is ALWAYS
 * "nobody asked". The slot could only ever give it a wrong one: for the whole
 * length of a member's request on the same task, it billed that member for the
 * daemon's turn and stamped them on its rows. So the fallback is gone, not
 * narrowed: outside the request that asked, nobody asked.
 */
export interface TurnOwnerRequest {
  taskId: string;
  owner: PendingTurnOwner;
}

const requestScope = new AsyncLocalStorage<TurnOwnerRequest>();

/**
 * Run `fn` as the request that asked for a turn on `request.taskId`: every
 * launch for that task inside it — including work it queues — answers for this
 * request alone. A concurrent request on the same task runs in its own scope.
 */
export function runAsTurnOwnerRequest<T>(request: TurnOwnerRequest, fn: () => Promise<T>): Promise<T> {
  return requestScope.run(
    { ...request, owner: { ...request.owner, email: canonicalPersonEmail(request.owner.email) } },
    fn,
  );
}

/**
 * The owner of the turn about to launch for `taskId` (a UUID), or null.
 *
 * Answered from the calling code's request scope and nothing else: null outside
 * a request, and null inside a request for a DIFFERENT task — an accept that
 * unblocks its destination's owner to reconcile a worktree launches a turn its
 * caller did not ask for.
 */
export function getPendingTurnOwner(taskId: string): PendingTurnOwner | null {
  const scope = requestScope.getStore();
  return scope && scope.taskId === taskId ? scope.owner : null;
}

/**
 * The PERSON in the pending record, without the billing half.
 *
 * For a caller that has to CAPTURE who owns the turn it is about to start —
 * `claimSyncTurn` stamps it on the in-flight record so the row written when
 * that turn ends names the person who asked for it, not whoever owns the
 * session by then.
 */
export function pendingTurnOwnerPerson(taskId: string): TurnOwner | null {
  const pending = getPendingTurnOwner(taskId);
  if (!pending) return null;
  return { email: pending.email, ...(pending.name ? { name: pending.name } : {}) };
}

/**
 * Raised when a system-initiated turn could not have the PREVIOUS turn's owner
 * cleared off its session — see {@link recordSessionTurnOwner}.
 *
 * It refuses the launch rather than the attribution, because those are the only
 * two options and the other one is worse: the turn would run with a person's
 * address still on the session and durably stamp every append-only row it
 * writes with somebody who did not ask for the work. A refused launch is
 * retried (the reconciler's next pass, the caller's next attempt); a
 * misattributed record is not repairable.
 */
export class TurnOwnerNotClearedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnOwnerNotClearedError';
  }
}

/** Attempts at clearing, including the first. Bounded — a launch may not hang. */
const CLEAR_ATTEMPTS = 3;

/** Backoff before clear attempts 2 and 3. Short: this is a local write. */
const CLEAR_RETRY_DELAY_MS = [25, 75];

/**
 * Promote the pending owner onto the SESSION — the durable half.
 *
 * Called from `planTurnCredential`, which is the one function every turn-launch
 * path calls with the task and session about to run. Writing it there rather
 * than at each launch site is what makes the record complete: a launch path
 * added later gets it without knowing this exists.
 *
 * ALWAYS WRITES, including the null that means "nobody asked for this one".
 * The owner belongs to the TURN, not to the task, so a turn the daemon starts
 * by itself must CLEAR the person the previous turn recorded — otherwise an
 * auto-deliver or a sync would quietly attribute its work to whoever unblocked
 * the task last (§3.3 case 3).
 *
 * THE TWO DIRECTIONS FAIL DIFFERENTLY, and that asymmetry is the whole point:
 *
 *   WRITING A PERSON is best-effort, and stays best-effort only because its
 *   failure degrades to NOBODY. That is not automatic: the record it failed to
 *   overwrite may be the PREVIOUS turn's, including a previous turn's
 *   system-initiated mark, and leaving that standing would attribute this
 *   person's work to the account the automation is configured under, under a
 *   role saying nobody asked for it. So a failed person write is FOLLOWED by a
 *   best-effort clear, which is what makes "the rows will name nobody" true.
 *   Warn and carry on either way; attribution must not be the reason a person's
 *   own turn fails to launch.
 *
 *   MARKING A TURN SYSTEM-INITIATED clears the owner and rides the same write,
 *   so the two halves can never disagree. The mark is what
 *   {@link personForCurrentTurn} reads: "the daemon started this turn itself"
 *   is a recorded fact, never inferred from a missing owner, because every
 *   failure above produces a missing owner too.
 *
 *   CLEARING A PERSON fails CLOSED. If it fails, the previous human's address
 *   stays on the session and every row this system-initiated turn writes is
 *   durably stamped with someone who did not ask for it. So it is retried, and
 *   then — verified. A write that REPORTED success is not proof it happened:
 *   `FileStorage.setSessionTurnOwner` returns silently when it cannot resolve
 *   the session, and `RemoteStorage` refuses the call outright. The read-back
 *   is what covers all three routes to the same stale value with one mechanism.
 *   Still stale after that, and the launch is refused
 *   ({@link TurnOwnerNotClearedError}).
 */
export async function recordSessionTurnOwner(
  input: { taskId: string; sessionId: string; storage?: Storage },
): Promise<void> {
  const storage = await storageForRecording(input);
  if (!storage) return;

  const pending = getPendingTurnOwner(input.taskId);
  if (pending) {
    try {
      await storage.setSessionTurnOwner(
        input.sessionId,
        { email: pending.email, ...(pending.name ? { name: pending.name } : {}) },
        false,
      );
    } catch (err) {
      await degradeToNobody(storage, input, pending.email, errorText(err));
    }
    return;
  }

  await clearSessionTurnOwner(storage, input);
}

/**
 * A person's launch could not be recorded — leave the session naming NOBODY.
 *
 * Not decoration, and not the same as doing nothing: whatever the failed write
 * did not overwrite is still there, and it may be the previous turn's
 * system-initiated mark. Reading that back would put this person's work on rows
 * saying the daemon did it by itself, on the configured account — one specific
 * person's work attributed to another specific person, which is exactly the
 * outcome the asymmetry above exists to avoid.
 *
 * Best-effort in turn, because refusing here would refuse a turn a real person
 * asked for over attribution alone. If even this does not land, the warning
 * says so honestly rather than promising a state nobody verified.
 */
async function degradeToNobody(
  storage: Storage,
  input: { taskId: string; sessionId: string },
  email: string,
  failure: string,
): Promise<void> {
  const preamble =
    `Could not record ${email} as the owner of task ${shortId(input.taskId)}'s turn: ${failure}.`;
  try {
    await storage.setSessionTurnOwner(input.sessionId, null, false);
    logger.warn(
      `${preamble} The rows this turn writes will name nobody, as they did before attribution ` +
      `existed — no other person, and no automation account, is named by this.`,
    );
  } catch (err) {
    logger.warn(
      `${preamble} Clearing the record instead also failed (${errorText(err)}), so the rows this ` +
      `turn writes may carry whatever the PREVIOUS turn recorded — a different person, or the ` +
      `configured automation account. The store is the thing to fix.`,
    );
  }
}

/**
 * Clear the previous turn's owner and mark the turn system-initiated, and prove
 * the clearing half. See the asymmetry above.
 *
 * @throws TurnOwnerNotClearedError when the session still names a person after
 *         every attempt — the launch must not proceed.
 */
async function clearSessionTurnOwner(
  storage: Storage,
  input: { taskId: string; sessionId: string },
): Promise<void> {
  let lastFailure: string | null = null;

  for (let attempt = 1; attempt <= CLEAR_ATTEMPTS; attempt++) {
    try {
      await storage.setSessionTurnOwner(input.sessionId, null, true);
    } catch (err) {
      lastFailure = errorText(err);
    }

    // The proof. A session the store does not know reads as no owner, which is
    // the right answer for it too: there is no stale person on a record that
    // does not exist (the review-session launch path deliberately passes an id
    // no task session has).
    try {
      const session = await storage.getSession(input.sessionId);
      if (!turnOwnerOfSession(session)) {
        // The MARK is not worth refusing a launch over: without it these rows
        // name nobody, which is the pre-identity shape. Only a stale PERSON is
        // unrepairable, and that is what the loop above proves is gone.
        if (!session?.turn_system_initiated) {
          logger.warn(
            `Task ${shortId(input.taskId)}: could not mark this turn system-initiated, so the rows ` +
            `it writes will name nobody rather than the configured automation account. Nothing is ` +
            `misattributed by this — the previous turn's owner is provably gone.`,
          );
        }
        return;
      }
      lastFailure ??= 'the write reported success, but the session still names a person';
    } catch (err) {
      lastFailure = `could not read the session back: ${errorText(err)}`;
    }

    const delayMs = CLEAR_RETRY_DELAY_MS[attempt - 1];
    if (delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new TurnOwnerNotClearedError(
    `Refusing to launch a system-initiated turn for task ${shortId(input.taskId)}: the previous ` +
    `turn's owner could not be cleared from session ${shortId(input.sessionId)} after ` +
    `${CLEAR_ATTEMPTS} attempts (${lastFailure}). Nobody asked for this turn, so running it ` +
    `would stamp every row it writes with a person who did not — which is not repairable ` +
    `afterwards, while this refusal is retried on the next pass. The store is the thing to fix.`,
  );
}

/**
 * The Storage to record through, or null when there is none to record against.
 *
 * The caller's own handle when it has one — a launch outside the daemon (the
 * reconciler run as a subprocess) has no singleton to reach for. Otherwise the
 * daemon's, imported dynamically so this module stays importable from
 * ./rpc-handlers, which owns it — the same cycle-avoidance the regions service
 * uses, and nothing else about it is special.
 *
 * Null ONLY for "the daemon's storage was never initialized", which is not the
 * dangerous case the clearing direction guards: with no store there is no
 * session record holding a stale person, and nothing writing rows against one.
 * A test driving the credential plan directly, or a process that is not the
 * daemon, takes this path. Anything else is rethrown.
 */
async function storageForRecording(
  input: { taskId: string; storage?: Storage },
): Promise<Storage | null> {
  if (input.storage) return input.storage;
  try {
    return await (await import('./rpc-handlers')).getOrCreateStorage();
  } catch (err) {
    if (errorText(err).includes('Daemon storage not initialized')) {
      logger.debug(`No daemon storage to record the turn owner for task ${shortId(input.taskId)}`);
      return null;
    }
    throw err;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The person whose turn this session is currently running, or null when the
 * turn is system-initiated.
 *
 * The ONE read behind every attributed agent write: the agent's own turn row
 * ({@link createAgentTurn}, below) and every row an agent writes over its MCP
 * token (src/daemon/mcp-routes.ts) resolve the person through here, so they
 * cannot disagree about who is acting.
 *
 * Null for a session that predates the field, for a turn nobody asked for, and
 * for a session id the store does not know — all of which mean the same thing
 * downstream: record no person, exactly as a pre-identity row does.
 */
export async function sessionTurnOwner(
  storage: Storage,
  sessionId: string,
): Promise<TurnOwner | null> {
  try {
    const session = await storage.getSession(sessionId);
    return turnOwnerOfSession(session);
  } catch (err) {
    logger.debug(
      `Could not resolve the turn owner for session ${shortId(sessionId)}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** The same answer, for a caller that already holds the session record. */
export function turnOwnerOfSession(
  session: { turn_owner_email?: string | null; turn_owner_name?: string | null } | null,
): TurnOwner | null {
  const email = session?.turn_owner_email;
  if (!email) return null;
  const name = session?.turn_owner_name;
  return { email, ...(name ? { name } : {}) };
}

/**
 * Write an AGENT turn, attributed to whoever asked for it.
 *
 * Every `role: 'agent'` turn goes through here rather than straight to
 * `storage.createTurn`, and `test/unit/turn-owner.test.ts` scans the source to
 * keep it that way. The reason is the question this answers for
 * `stats-attribute-turn-spend` (§7.4): a turn's token usage lives on the agent
 * turn, and now so does the person whose account paid for it — a derivation
 * nobody has to invent as long as every agent turn carries it.
 *
 * The ROLE is `agent` — the channel — for a turn somebody asked for. A turn
 * NOBODY asked for is the one exception and records the configured system
 * identity under the role `system` (see below); with no identity configured it
 * carries no person at all, exactly as every agent turn did before this
 * existed. Surfaces that read `actor` only for `role === 'human'` turns are
 * untouched either way.
 */
export async function createAgentTurn(
  storage: Storage,
  options: CreateTurnOptions,
  projectRoot?: string,
): Promise<Turn> {
  const person = await personForCurrentTurn(storage, options.sessionId, projectRoot);
  if (!person) return storage.createTurn(options);
  if (!person.system) return createRecoveredAgentTurn(storage, options, person);

  // NOBODY ASKED FOR THIS TURN — the reconciler resumed it, auto-deliver
  // launched it, a sync ran that nothing typed. The row names the account that
  // CONFIGURED the automation, under the role `system` (§3.3 case 3): on a
  // laptop that is the same person who shows up as `human` and `agent`
  // elsewhere, and the role is the only thing that tells the three apart.
  //
  // The CHANNEL therefore moves here and only here. A turn somebody asked for
  // keeps `agent` above, so "ivan's agent decided this" stays distinguishable
  // from "ivan typed this" — and from "the daemon did this by itself", which
  // is the distinction this branch adds.
  return createRecoveredAgentTurn(storage, { ...options, actor: SYSTEM_ACTOR }, person);
}

/**
 * The actor for a row the daemon writes on a CHANNEL of its own — today the
 * `supervisor` announcement of a merge lazy performed during a sync.
 *
 * The channel is a fact about who did the work and never moves: it is what
 * `recordSyncTurns`' idempotency check reads back, and a role that changed
 * between two passes over the same response would record the same merge twice.
 * What the person answers is whose turn the row belongs to — the human who
 * typed `lazy sync`, or, when nobody did, the configured system identity.
 */
export async function turnChannelActor(
  storage: Storage,
  sessionId: string,
  role: Actor,
  projectRoot?: string,
): Promise<ActorInput> {
  const person = await personForCurrentTurn(storage, sessionId, projectRoot);
  if (!person) return role;
  return { role, email: person.email, ...(person.name ? { name: person.name } : {}) };
}

/**
 * WHO A ROW WRITTEN FOR THIS SESSION'S CURRENT TURN NAMES, and whether nobody
 * asked for that turn.
 *
 * One resolution behind both writers above, so an agent's own turn row and the
 * supervisor's announcement beside it cannot disagree. Null means there is
 * nobody to name at all — no owner recorded AND no configured system identity —
 * which is the pre-identity shape every one of these rows had.
 */
export async function personForCurrentTurn(
  storage: Storage,
  sessionId: string,
  projectRoot?: string,
): Promise<TurnAttribution | null> {
  const session = await readSession(storage, sessionId);
  const owner = turnOwnerOfSession(session);
  if (owner) return { ...owner, system: false };

  // THE MARK, NOT THE ABSENCE. A missing owner is also what a failed
  // best-effort person write, a session predating the field, and a store that
  // never got the write all look like — so naming the configured account on
  // that evidence would be a claim about a person derived from silence.
  if (!session?.turn_system_initiated) return null;

  const identity = await systemIdentityFor(projectRoot);
  return identity ? { ...identity, system: true } : null;
}

/** The session record, or null when it cannot be read. Never throws. */
async function readSession(storage: Storage, sessionId: string) {
  try {
    return await storage.getSession(sessionId);
  } catch (err) {
    logger.debug(`Could not read session ${shortId(sessionId)}: ${errorText(err)}`);
    return null;
  }
}

/** WHO ASKED for the task's current turn, or null when nobody did. */
export async function taskTurnOwner(storage: Storage, taskId: string): Promise<TurnOwner | null> {
  try {
    return turnOwnerOfSession(await storage.getSessionByTaskId(taskId));
  } catch (err) {
    logger.debug(`Could not resolve the turn owner for task ${shortId(taskId)}: ${errorText(err)}`);
    return null;
  }
}

/**
 * The configured system identity, for a call site that may not know the project
 * root.
 *
 * Every launch path inside the daemon does know it and passes it; the fallback
 * is the daemon's own root, for the handful of recorders reached from code that
 * carries a Storage and nothing else. Null when there is no root to resolve
 * against — a process that is not the daemon — which records nobody, exactly as
 * an unconfigured install does.
 */
async function systemIdentityFor(projectRoot?: string): Promise<TurnOwner | null> {
  const root = projectRoot ?? await daemonProjectRoot();
  if (!root) return null;
  return (await import('../identity/system-identity')).resolveSystemIdentity(root);
}

/** The daemon's own project root, or null outside the daemon process. */
async function daemonProjectRoot(): Promise<string | null> {
  try {
    return (await import('./rpc-handlers')).getDaemonProjectRoot();
  } catch (err) {
    logger.debug(`No daemon project root to resolve a system identity against: ${errorText(err)}`);
    return null;
  }
}

/**
 * Write an agent turn for a turn that is NOT the one the session is running
 * now, attributed to the owner the CALLER captured — or to nobody.
 *
 * THE SESSION IS THE WRONG SOURCE HERE, and that is the whole reason this
 * exists. Several recorders run late by construction: a displaced response is
 * swept up after a newer turn has already been launched and recorded, so by the
 * time the row is written the session names the person who asked for the NEWER
 * turn. Resolving at record time therefore puts ivan's work — and ivan's token
 * usage — on a row that says pete. That is strictly worse than the stale-owner
 * case the clearing direction refuses a launch to avoid, because it names a
 * specific wrong person rather than an out-of-date one, and the row is
 * append-only.
 *
 * Callers pass either the owner captured when the turn was CLAIMED (the
 * in-flight record carries it — see `claimSyncTurn`), or `null` when nothing
 * that survived the turn names anybody. Null is the honest answer: an
 * unattributed row reads exactly like every agent row did before attribution
 * existed, and "nobody" can be corrected later, while "pete" cannot be
 * recognised as wrong at all.
 */
export async function createRecoveredAgentTurn(
  storage: Storage,
  options: CreateTurnOptions,
  owner: TurnOwner | null,
): Promise<Turn> {
  assertOneNamedPerson(options.actor, owner);
  if (!owner) return storage.createTurn(options);
  const role = actorRole(options.actor) ?? AGENT_ACTOR;
  return storage.createTurn({
    ...options,
    actor: { role, email: owner.email, ...(owner.name ? { name: owner.name } : {}) },
  });
}

/**
 * Refuse a row that is handed TWO different people.
 *
 * The actor and the owner are different facts — the CHANNEL a write came
 * through, and whose turn it belongs to — and the helper merges them by keeping
 * the actor's role and the owner's person. That is right when the actor names
 * only a role. When it names a PERSON as well, the merge silently discards one
 * of two humans, and which one it discards depends on whether the other
 * argument happens to be set: `lazy stop` passed the stopper's identity while
 * the claim carried the person who had asked for the turn, so the row said
 * "Stopped by user: …" under a name that belonged to somebody who had not
 * stopped anything — and would have said the stopper's name instead, for the
 * same call, had the claim predated the captured-owner field.
 *
 * So the combination is refused rather than resolved. A caller holding two
 * people has to say which one the row is about: pass the owner and no actor
 * person (the row is the TURN's, as `abandonDeadClaimedTurn` does), or pass the
 * actor and a null owner (the row is the ACTION's, as `stopClaimedTurn` does).
 * Same move as `mcpRole` / `mcpActor`: make the choice explicit at the call
 * site instead of letting a helper guess.
 */
function assertOneNamedPerson(actor: ActorInput | undefined, owner: TurnOwner | null): void {
  const namedByActor = actorEmail(actor);
  if (!namedByActor || !owner) return;
  if (canonicalPersonEmail(namedByActor) === canonicalPersonEmail(owner.email)) return;

  throw new Error(
    `Refusing to record an agent turn that names two people: the actor is ` +
    `'${namedByActor}' and the turn owner is '${owner.email}'. These are different ` +
    `facts and this row can only carry one — decide what it records. If it is the ` +
    `TURN, pass the owner and leave the actor's person off; if it is an ACTION ` +
    `somebody took (a stop), pass that actor and a null owner. See ` +
    `createRecoveredAgentTurn.`,
  );
}

/**
 * The person an in-flight claim captured when its turn was launched, or null.
 *
 * The claim is per TURN and is written before the command goes out, so it still
 * names the right person when that turn's ending is recorded later — which is
 * exactly when the session no longer does.
 */
export function turnOwnerOfClaim(
  record: { turn_owner_email?: string; turn_owner_name?: string } | null | undefined,
): TurnOwner | null {
  const email = record?.turn_owner_email;
  if (!email) return null;
  const name = record?.turn_owner_name;
  return { email, ...(name ? { name } : {}) };
}

