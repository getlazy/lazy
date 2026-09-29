/**
 * Daemon-owned builder sessions — a session registry as a Storage entity, and
 * the launch that makes the container daemon-owned and DETACHED rather than
 * `-it --rm` in a client process's foreground.
 *
 * See docs/design/actor-identity-and-remote-clients.md §5.1–5.7 (Part C) for
 * the full rationale. This module is task 10 of that breakdown: the registry
 * and the detached launch, with per-member credential binding. The attach
 * ROUTE (a terminal reaching this container over the network) is a later task
 * — this module only gets the container running and the session recorded.
 *
 * ONE SESSION PER MEMBER PER PROJECT (§5.7): `startBuilderSession` is
 * idempotent per (projectRoot, memberEmail) — a second call finds the
 * existing non-ended session and reattaches (if running) or resumes it (if
 * stopped) rather than registering a second one.
 *
 * TWO WAYS TO PUT A SESSION DOWN, and the difference is the whole point of the
 * registry. `stopBuilderSession` takes the container away and keeps the
 * conversation: the row goes 'stopped' carrying the Claude session id, and the
 * next start relaunches with `--resume <that id>`. `endBuilderSession` is
 * TERMINAL (§5.7) — an ended session is never resumed. Both stop the container
 * the same way, through the same ownership guard, and release the same
 * per-launch resources.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { RpcError } from './rpc-error';
import { getOrCreateStorage, handleBuilderSlot, handleGetDaemonMcpConfig, handleRevokeDaemonMcpToken } from './rpc-handlers';
import {
  planTurnCredential,
  credentialEnvForPlan,
  releaseTurnCredential,
  TurnCredentialUnavailableError,
  type TurnCredentialPlan,
} from './turn-credentials';
import { actorEmail } from '../actor-ref';
import type { ActorInput } from '../types';
import { teamModeEnabled } from './user-credentials';
import { isManagedMode } from '../config/managed';

/**
 * Can another member exist on this daemon? Managed mode (per-user tokens are
 * accepted there, whether or not any member stored a credential) or team
 * mode. Every builder-session ownership rule keys on THIS, not on team mode
 * alone: a managed project running on the service credential only still has
 * several members, and keying on team mode let one of them list, stop and end
 * another's session.
 */
export async function multiMemberDaemon(projectRoot: string): Promise<boolean> {
  return isManagedMode() || (await teamModeEnabled(projectRoot));
}
import type { ActorIdentity } from './actor-tokens';
import type { BuilderSession, BuilderSessionUpdate } from '../storage/types';
import { loadConfig } from '../config/loader';
import { createRunner } from '../runner';
import { resolveRoleTarget } from '../utils/role-target';
import { withLiveProxyTarget } from './auth-env';
import { builderRunName } from '../builder/relaunch';
import { BuilderSessionActiveError, BuilderSessionStateConflictError } from '../storage/interface';
import { TaskMutex } from '../utils/task-mutex';
import { getLaunchAuthEnvVars } from '../capture/claude';
import { revokeBuilderCredentialGrant } from '../proxy/credential-broker';
import { assembleBuilderSystemPrompt } from '../builder/system-prompt';
import {
  ensureBuilderSessionHomeDir,
  resolveBuilderSessionHomeDir,
  builderClaudeConfigPath,
  builderClaudeSessionConfigPath,
  persistBuilderSessionClaudeConfig,
  builderSessionLaunchDir,
} from '../builder/claude-home';
import { rm } from 'fs/promises';
import {
  resolveBuilderProjectsDirForLaunch,
  isTrustedResumeProjectsDir,
  builderSessionProjectsRoot,
} from '../builder/projects-isolation';
import { logger } from '../utils/logger';
import { BuilderStartTrace } from './builder-start-trace';
import { describeLaunchWarmup } from './launch-warmup';
import { builderSupervisorLogHostPath } from '../builder/supervisor-log-path';
import { printableTail, TERMINAL_CONTROL } from '../utils/terminal-text';

function newBuilderId(): string {
  return randomUUID().split('-')[0]!;
}

/**
 * Refuse before launch when the member has no usable credential.
 *
 * Skipped entirely outside team mode (`planTurnCredential` returns
 * `daemon-env` there) — a single-person install keeps working exactly as
 * `lazy builder` does today. In team mode, a member with no stored credential
 * is refused with the existing `NO_OWNER_CREDENTIAL_MARKER` shape rather than
 * silently billed to the project's service credential: a builder session is a
 * human asking for something, not automation (§5.5).
 */
async function planSessionCredential(
  projectRoot: string,
  sessionRegistryId: string,
  memberEmail: string,
) {
  try {
    return await planTurnCredential(projectRoot, {
      taskId: sessionRegistryId,
      sessionId: sessionRegistryId,
      spender: { email: memberEmail },
    });
  } catch (err) {
    if (err instanceof TurnCredentialUnavailableError) throw new RpcError(400, err.message);
    throw err;
  }
}

/** The credential decision a launch needs, resolved before the claim row is written. */
interface SessionLaunchPlan {
  builderTarget: Awaited<ReturnType<typeof withLiveProxyTarget>>;
  /** Null outside team mode — the daemon-env launch needs no injected credential. */
  credentialPlan: TurnCredentialPlan | null;
}

/**
 * Decide (and, in team mode, bind) the session's credential BEFORE the claim
 * row is written — the MONEY BEFORE INFRASTRUCTURE order, and the invariant
 * the e2e suite pins: a member with no usable credential is refused with the
 * NO_OWNER_CREDENTIAL_MARKER shape before anything about this launch exists,
 * so a policy refusal leaves no registry row behind (a refused attempt is not
 * a launch attempt). The resolved plan is handed to launchDetachedContainer,
 * which would otherwise plan too late — after the claim.
 */
async function planSessionLaunchCredential(
  projectRoot: string,
  builderId: string,
  memberEmail: string | null,
): Promise<SessionLaunchPlan> {
  const config = await loadConfig(projectRoot);
  const builderTarget = await withLiveProxyTarget(resolveRoleTarget('builder', config), config);
  const credentialPlan = memberEmail ? await planSessionCredential(projectRoot, builderId, memberEmail) : null;
  return { builderTarget, credentialPlan };
}

/**
 * The `LaunchIdentity` label a daemon-owned builder LAUNCH mints its JIT
 * placeholder grant under — names the person (so the audit log can) AND the
 * launch (so the grant dies with it).
 *
 * Per launch, not per member: `mintCredentialGrant` hands back the existing
 * grant for an identical label, so a per-member label meant one placeholder
 * reused by every launch the member ever made, and nothing on release could
 * revoke it without also revoking whatever launch holds it now (a concurrent
 * start relaunching the session mints under the same label before the
 * outgoing launch's release runs). Keyed by builder id, the release of one
 * launch revokes exactly that launch's grant — see
 * releaseOutgoingSessionResources. A session with no member has no person to
 * name and keys by the launch alone.
 */
export function sessionLaunchGrantLabel(memberEmail: string | null, builderId: string): string {
  return memberEmail ? `member-builder:${memberEmail}:${builderId}` : `builder-session:${builderId}`;
}

/**
 * The three Storage-proxy reads through which one member can enumerate
 * another's sessions — emails, container names, Claude session ids — re-scoped
 * to the CALLER's own member in team mode.
 *
 * Every member holds a user-kind actor token that reaches `/rpc/storage`, and
 * these three entries went into `STORAGE_METHODS` with no per-member scoping:
 * member B could list every member's sessions and pick a target for
 * endBuilderSession. The scope comes from the CALLER's token
 * (`caller.email`), never from a request field — `getActiveBuilderSessionForMember`'s
 * `memberEmail` and `listBuilderSessions`'s `projectRoot` arguments are
 * FORCED to the caller's own member and this RPC's project root respectively,
 * which also keeps a caller from reaching other projects' rows in a shared
 * fleet store.
 *
 * Returns the scoped result, or `undefined` when the scoping does not apply
 * and the table entry in `STORAGE_METHODS` should run as before:
 * `undefined` is the fall-through sentinel and never a scoped answer — a
 * scoped "not found" is `null`.
 *
 * - Only where other members can exist ({@link multiMemberDaemon}: managed
 *   mode or team mode). Elsewhere identity is the daemon's own git config and
 *   every caller is the machine's owner, so the single-person path keeps
 *   reading exactly what it reads today.
 * - Control-kind callers keep the operator view, deliberately: the control
 *   plane already reads everything through this proxy (its writes on a managed
 *   host are refused as human-initiated), so narrowing these three would
 *   constrain nothing.
 * - The writes that could undo this scoping are not scoped but refused: no
 *   user-kind caller writes these rows through the proxy at all (see
 *   refuseMemberSessionStorageWrite below).
 */
export async function scopeBuilderSessionStorageRead(
  projectRoot: string,
  method: string,
  args: Record<string, unknown>,
  caller: ActorIdentity | undefined,
): Promise<BuilderSession | BuilderSession[] | null | undefined> {
  if (!(await multiMemberDaemon(projectRoot))) return undefined;
  if (caller?.kind !== 'user') return undefined;
  const memberEmail = caller.email;
  const storage = await getOrCreateStorage();

  switch (method) {
    case 'getBuilderSession': {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id) return null;
      const session = await storage.getBuilderSession(id);
      // Same two predicates endBuilderSession enforces: the row must belong
      // to this project (a fleet store serves many projects) and to this
      // member. Anything else reads as "not found" — existence is not
      // revealed to a non-owner.
      return session && session.projectRoot === projectRoot && session.memberEmail === memberEmail
        ? session
        : null;
    }
    case 'getActiveBuilderSessionForMember': {
      // Both arguments are forced: the member to the caller's own, the root to
      // the project this RPC serves.
      return storage.getActiveBuilderSessionForMember(projectRoot, memberEmail);
    }
    case 'listBuilderSessions': {
      const sessions = await storage.listBuilderSessions(projectRoot);
      return sessions.filter((s) => s.memberEmail === memberEmail);
    }
    default:
      return undefined;
  }
}

/**
 * Builder-session rows are written by the DAEMON and nobody else: through the
 * Storage proxy, a user-kind caller may not create or update one at all.
 *
 * `startBuilderSession`, `stopBuilderSession` and `endBuilderSession` are the
 * member's interface to a session. No client writes these rows directly — the
 * only writers in src/ are those handlers, through the daemon's own storage,
 * and neither RemoteStorage method has a caller outside tests. An earlier
 * version scoped proxy writes to the caller's own row with an allowlist of
 * patch keys, and that allowlist is exactly how the row reached the host: a
 * member could set `builderId: '../../..'` on their own row and have
 * `stopBuilderSession` pass it to `rm -rf`, or set `containerName` to another
 * member's container and have the daemon `docker stop` it. The fields the
 * daemon acts on are not the member's to choose, so no write is.
 *
 * Refused regardless of team mode: user-kind tokens exist only where a control
 * plane minted them. Control-kind callers (the operator and the test harness's
 * fixture seeding) are unaffected. The use sites also validate what they act
 * on (assertSessionRowActionable), so a bad row is refused there too, however
 * it got into the store.
 */
export function refuseMemberSessionStorageWrite(
  method: string,
  caller: ActorIdentity | undefined,
): void {
  if (caller?.kind !== 'user') return;
  throw new RpcError(
    403,
    `${method}: builder sessions are written by the daemon, not through the storage proxy. ` +
    `Use startBuilderSession, stopBuilderSession or endBuilderSession.`,
  );
}

/** Exactly the shape newBuilderId produces: the first group of a UUID, 8 lowercase hex. */
const BUILDER_ID_SHAPE = /^[0-9a-f]{8}$/;

/**
 * Refuse to act on a session row whose builder id or container name the daemon
 * did not produce.
 *
 * Both values reach the host: the builder id becomes a path under the member's
 * home that is removed recursively, and names the MCP token and credential
 * binding that are revoked; the container name is handed to `docker stop` and
 * `docker rm`. A traversal id (`../../..`) or a container name belonging to
 * someone else would make the daemon delete or stop what it was never asked
 * to. Checked at every use site, whatever wrote the row — the storage proxy
 * refuses member writes, but this must hold even if that ever changes, or if a
 * row arrives some other way.
 *
 * The container name must be exactly this row's own `lazy-builder-<builderId>`,
 * not merely the right shape: a well-formed name of ANOTHER launch is the
 * foreign-container case.
 */
export function assertSessionRowActionable(session: BuilderSession): void {
  if (typeof session.builderId !== 'string' || !BUILDER_ID_SHAPE.test(session.builderId)) {
    logger.error(`Refusing to act on builder session ${session.id}: invalid builder id ${JSON.stringify(session.builderId)}`);
    throw new RpcError(
      409,
      `Builder session ${session.id} carries an invalid builder id ${JSON.stringify(session.builderId)} ` +
      `(expected 8 lowercase hex characters). The daemon will not stop containers, delete files or ` +
      `revoke tokens on its behalf; the row needs repair.`,
    );
  }
  if (session.containerName !== null && session.containerName !== builderRunName(session.builderId)) {
    logger.error(`Refusing to act on builder session ${session.id}: foreign container name ${JSON.stringify(session.containerName)}`);
    throw new RpcError(
      409,
      `Builder session ${session.id} names container ${JSON.stringify(session.containerName)}, but its own ` +
      `container is ${builderRunName(session.builderId)}. The daemon will not stop or remove a container ` +
      `this session did not launch; the row needs repair.`,
    );
  }
}

async function launchDetachedContainer(opts: {
  projectRoot: string;
  memberEmail: string | null;
  builderId: string;
  resumeSessionId: string | null;
  launchPlan: SessionLaunchPlan;
  trace: BuilderStartTrace;
}): Promise<{ containerName: string; resumed: string | null }> {
  const { projectRoot, memberEmail, builderId, resumeSessionId, launchPlan, trace } = opts;
  const config = await loadConfig(projectRoot);
  const runner = await createRunner(projectRoot);
  if (!runner.usesSandbox() || !runner.launchBuilderDetached) {
    throw new RpcError(
      400,
      'Daemon-owned builder sessions require the docker/podman runner. This project is ' +
      'configured for a runner that cannot host a detached, daemon-owned container.',
    );
  }

  // MONEY BEFORE INFRASTRUCTURE: the credential was decided (and, in team
  // mode, bound) by the caller BEFORE the claim row was written — see
  // planSessionLaunchCredential. Nothing about this launch is created before
  // that gate clears, so a member with no credential leaves no registry row
  // and nothing to unwind on refusal.
  const builderTarget = launchPlan.builderTarget;
  const plan = launchPlan.credentialPlan;

  const daemonMcpName = `builder-${builderId}`;
  const { configPath: daemonConfigPath } = await trace.phase('daemon MCP config', () => handleGetDaemonMcpConfig(projectRoot, { name: daemonMcpName }));

  // This code runs INSIDE the daemon (a dispatchRpc handler), never as a
  // separate client process — `resolveAuthEnvFromDaemon` is for the latter and
  // takes a self-referential bypass when called from the daemon's own
  // process, which would skip JIT placeholder minting entirely.
  // `getLaunchAuthEnvVars` (src/capture/claude.ts) is the daemon-internal
  // equivalent every other daemon-side launch (review sessions included) uses.
  const identity = {
    role: 'builder' as const, taskId: null,
    label: sessionLaunchGrantLabel(memberEmail, builderId), profile: builderTarget.profile,
  };
  const credEnv = memberEmail ? credentialEnvForPlan(plan!) : null;
  // Route the plan's credential through getLaunchAuthEnvVars rather than
  // bypassing it: a session placeholder handed to the container on its own left
  // it with no ANTHROPIC_BASE_URL — that env comes from targetEnvVars, which
  // runs only inside getLaunchAuthEnvVars — so the container dialled
  // api.anthropic.com directly with a token only lazy's proxy can resolve and
  // died on its first request. `injectedCreds` is the parameter for exactly
  // this: the lazy-sess-… placeholder passes through unchanged (it is already
  // bound to a member; JIT placeholderization would replace it with an
  // unresolvable grant) and the proxy address is stamped alongside it.
  const authEnvVars = await trace.phase('credential env', () => getLaunchAuthEnvVars(
    identity,
    builderTarget,
    { role: 'builder' },
    'container',
    credEnv ?? undefined,
  ));

  const dataDirAbs = join(projectRoot, config.data.path);
  const homeDirAbs = await ensureBuilderSessionHomeDir(projectRoot, memberEmail);

  // Member-scoped projects isolation (the transcript-exposure fix): the per-run
  // dirs root under THIS member's own home rather than <dataDir>/builder-projects,
  // which every builder container mounts read-write via the data-dir mount. With
  // the root inside the member home, only the one run dir this launch resolves is
  // ever bind-mounted, and seeding unions only this member's own prior runs — one
  // member's conversation JSONLs can neither be read nor seeded into another
  // member's container. See builderSessionProjectsRoot and claude-home.ts.
  const resolveProjects = (resumeId: string | null) => resolveBuilderProjectsDirForLaunch({
    dataDirAbs,
    lazyRoot: projectRoot,
    resumeId,
    homeDirAbs,
    projectsRootAbs: builderSessionProjectsRoot(homeDirAbs),
  });
  // Whether the conversation can really be resumed is decided in ONE place,
  // the runner (launchBuilderDetached), once it knows which projects dir the
  // container actually mounts; it reports back what it resumed.
  const projectsHostDir = await resolveProjects(resumeSessionId);
  const projects = projectsHostDir
    ? {
        hostDir: projectsHostDir,
        trustWritable: await isTrustedResumeProjectsDir({ hostDir: projectsHostDir, lazyRoot: projectRoot, resumeId: resumeSessionId }),
      }
    : undefined;

  const systemPrompt = await trace.phase('system prompt', () => buildSystemPrompt(projectRoot, runner));

  try {
    const { containerName, resumed } = await runner.launchBuilderDetached({
      lazyRoot: projectRoot,
      systemPrompt,
      builderId,
      daemonConfigPath,
      projects,
      authEnvVars,
      homeDirAbs,
      resumeSessionId,
      trace,
    });
    return { containerName, resumed };
  } catch (err) {
    // The launch failed — this MCP token and slot were minted for a container
    // that will never exist. Release both rather than leaking them; a live
    // session's own slot/token are released by endBuilderSession instead.
    await handleRevokeDaemonMcpToken(projectRoot, { name: daemonMcpName }).catch(() => {});
    if (memberEmail) {
      await releaseTurnCredential(projectRoot, builderId).catch(() => {});
    }
    // The launch wrote its per-launch files before `docker run` failed.
    await rm(builderSessionLaunchDir(homeDirAbs, builderId), { recursive: true, force: true })
      .catch((rmErr: unknown) => logger.warn(
        `Could not remove per-launch files of failed builder launch ${builderId}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
      ));
    throw err;
  }
}

async function buildSystemPrompt(projectRoot: string, runner: Awaited<ReturnType<typeof createRunner>>): Promise<string> {
  const storage = await getOrCreateStorage();
  // Always the detached launch, whose scratch is a container-only path.
  return assembleBuilderSystemPrompt({ lazyRoot: projectRoot, runner, storage, scratchAccess: 'store' });
}

/**
 * Release the three resources ONE launch holds, keyed by its builder id: the
 * daemon MCP token `builder-<id>` (full project write access through the lazy
 * tools), the builder slot, and — in team mode — the proxy's binding of the
 * member's real credential behind the session placeholder.
 *
 * THE ORDER IS THE FIX. A resume OVERWRITES `session.builderId` with the new
 * launch's id, so anything still held under the outgoing id must be released
 * BEFORE the row forgets it: once the id is gone, the token and the
 * credential binding can no longer be named, let alone revoked, and anything
 * that saw the dead container's environment can keep spending that member's
 * credential and writing to the project store indefinitely. This is exactly
 * the three calls endBuilderSession makes — mirrored here, because a resume
 * discards a launch just as an end does.
 *
 * Best-effort with a logged failure: a hiccup revoking must not strand the
 * resume, and the row cannot carry the debt forward because it is about to
 * forget the only id that could name these resources. Each call is idempotent
 * for an id whose resources are already gone (revoke reports not-found, the
 * slot release is an in-memory delete, the binding release no-ops), so a
 * call that runs the stale branch and then the resume branch releases the
 * same outgoing id twice without harm.
 */
async function releaseOutgoingSessionResources(
  projectRoot: string,
  session: BuilderSession,
): Promise<void> {
  // Throws, unlike the best-effort releases below: acting on an unvalidated
  // builder id revokes and deletes another launch's resources.
  assertSessionRowActionable(session);
  const id = session.id;
  const outgoing = session.builderId;
  const warn = (what: string, err: unknown) => {
    logger.warn(
      `Could not release the outgoing ${what} of builder session ${id} ` +
      `(builder id ${outgoing}): ${err instanceof Error ? err.message : String(err)}. ` +
      `The session row is about to forget this builder id, so it cannot be revoked later — ` +
      `clear it with a daemon restart if the MCP token registry still holds it.`,
    );
  };
  await handleRevokeDaemonMcpToken(projectRoot, { name: `builder-${outgoing}` })
    .catch((err: unknown) => warn('daemon MCP token', err));
  await handleBuilderSlot(projectRoot, { action: 'release', builderId: outgoing })
    .catch((err: unknown) => warn('builder slot', err));
  // The JIT placeholder grant this launch minted when no member credential
  // was injected (outside team mode). The MCP-token revoke above clears only
  // the `builder-<id>` label, which this launch never minted under — without
  // this the placeholder stayed spendable after stop/end. In team mode the
  // plan's own placeholder was injected, nothing was minted under this label,
  // and the revoke is a no-op.
  await revokeBuilderCredentialGrant(projectRoot, sessionLaunchGrantLabel(session.memberEmail, outgoing))
    .catch((err: unknown) => warn('credential grant', err));
  if (session.memberEmail) {
    await releaseTurnCredential(projectRoot, outgoing)
      .catch((err: unknown) => warn('credential binding', err));
  }
  await removeSessionLaunchFiles(projectRoot, session);
}

/**
 * Move a claimed 'starting' row to 'running' after a successful launch — and
 * stand down when the member ended the session while the launch was in
 * flight. endBuilderSession does not take the start mutex, so an explicit end
 * can land on the claimed row at any point before this reconcile; a session
 * the member ended must never be brought back (§5.7 — "a session ends
 * explicitly, and not otherwise"). When that happened, the just-launched
 * container is torn down and the launch's resources released, and the ended
 * row is returned untouched.
 *
 * The re-read below NARROWS the race; the CAS guard on the update CLOSES it:
 * the patch lands only while the row still says 'starting', decided inside
 * the same locked critical section as the write. A refusal means the row
 * moved out of 'starting' under the launch — in practice the member's
 * explicit end, the only non-start writer that does not hold the start mutex
 * — and takes the same standing-down path as the ended branch.
 */
async function reconcileClaimedSession(
  projectRoot: string,
  claimed: BuilderSession,
  containerName: string,
  extra: BuilderSessionUpdate = {},
): Promise<BuilderSession> {
  const storage = await getOrCreateStorage();
  const current = await storage.getBuilderSession(claimed.id);
  if (!current || current.state === 'ended') {
    return standDownLaunchedSession(projectRoot, claimed, containerName, current);
  }
  try {
    // CAS against the state the claim wrote: the member's end (or any other
    // writer) between the re-read above and this write is refused inside the
    // storage lock, closing the window the re-read only narrowed.
    return await storage.updateBuilderSession(claimed.id, { ...extra, state: 'running', containerName }, 'starting');
  } catch (err) {
    if (!(err instanceof BuilderSessionStateConflictError)) throw err;
    // The row moved on while the launch was in flight — the member's end
    // won, and the container this call just produced must go the same way it
    // would have on the ended branch above: same teardown, same release.
    const now = await storage.getBuilderSession(claimed.id);
    return standDownLaunchedSession(projectRoot, claimed, containerName, now);
  }
}

/**
 * The standing-down half of reconcileClaimedSession, shared by its ended
 * branch and its CAS-refusal catch: the member's decision outranks the
 * launch that just produced a container, so the container is torn down
 * (stopSessionContainer tolerates an already-gone container) and the
 * launch's own cleanup (releaseOutgoingSessionResources) mirrors what a
 * launch failure would have done. A failed stop is logged, not thrown — the
 * member's end has already decided the session's fate, and the row no longer
 * names a container, so there is nothing left to strand a retry on. Returns
 * the row as it now stands, for the caller to hand back to the member.
 */
async function standDownLaunchedSession(
  projectRoot: string,
  claimed: BuilderSession,
  containerName: string,
  current: BuilderSession | null,
): Promise<BuilderSession> {
  const stopped = await stopSessionContainer(projectRoot, { ...claimed, containerName });
  if (!stopped.ok) {
    // The member's end already decided this container's fate, so an answer we
    // could not get is no reason to leave it: remove it anyway, best effort.
    const runner = await createRunner(projectRoot);
    await runner.removeRun(containerName).catch((err: unknown) => logger.warn(
      `Could not remove container ${containerName} of ended builder session ${claimed.id}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    ));
    logger.warn(
      `Builder session ${claimed.id} was ended while its launch was in flight; ` +
      `the just-launched container could not be stopped (${stopped.reason}). ` +
      `A container may be running that no registry row names.`,
    );
  }
  await releaseOutgoingSessionResources(projectRoot, claimed);
  return current ?? claimed;
}

/**
 * Demote a claimed row whose launch failed BEFORE any container existed
 * (`launchedContainer` was still null at the call site). The claim's purpose —
 * a record the launch cannot outrun — is discharged by recording the outcome:
 * a fresh claim becomes 'ended', a resume claim 'stopped' keeping its
 * conversation id so the member can retry; both carry the launch error as
 * `lastExit`.
 *
 * The launch's own catch has already released the MCP token and credential
 * binding it minted; this also calls releaseOutgoingSessionResources because
 * that release is itself best-effort — a second, idempotent pass makes the
 * demotion robust against the inner release having failed too.
 *
 * Only a row that still says 'starting' (this call's own claim, untouched by
 * a concurrent writer) is demoted; anything else means someone else decided
 * the row's state meanwhile and is respected. The re-read below is the cheap
 * gate; the CAS guard on the update CLOSES the gap between it and the write
 * — without it, a member's end landing in that window would be overwritten
 * (a resume demote writing 'stopped' over 'ended' resurrects the session it
 * was ending), and the refusal here means the row's outcome was decided by
 * someone else, which is exactly the outcome recording was meant to avoid
 * clobbering.
 */
async function demoteFailedLaunch(projectRoot: string, claimed: BuilderSession, launchError: unknown): Promise<void> {
  const storage = await getOrCreateStorage();
  const current = await storage.getBuilderSession(claimed.id);
  if (!current || current.state !== 'starting') return;
  await releaseOutgoingSessionResources(projectRoot, claimed);
  // A resume claim keeps its conversation id — the member can retry the
  // resume. A fresh claim has nothing to resume: 'ended' is terminal (§5.7).
  // Either way the row records WHY as `lastExit`: the start's caller may be
  // gone by now (a connection that dropped mid-launch), and the row is then
  // the only place the failure can still be read.
  const message = (launchError instanceof Error ? launchError.message : String(launchError)).trim();
  const [first, ...rest] = message.split('\n');
  const lastExit = [`Your builder could not be started: ${first}`, ...rest].join('\n');
  try {
    await storage.updateBuilderSession(claimed.id, claimed.agentSessionId
      ? { state: 'stopped', containerName: null, lastExit }
      : { state: 'ended', containerName: null, endedAt: new Date().toISOString(), lastExit }, 'starting');
  } catch (err) {
    if (!(err instanceof BuilderSessionStateConflictError)) throw err;
    // The row moved on between the re-read above and this write — the CAS
    // guard closed that window. The member's end (or whoever moved the row)
    // outranks the demotion; recording the outcome is moot when the outcome
    // was decided by someone else. Return normally: this is not the failure
    // the caller's warn is for.
  }
}

/**
 * Start (or reattach/resume) this member's builder session for a project.
 *
 * `actor` is the daemon-resolved caller identity (`applyCallerActor` has
 * already run by the time this handler is reached — see rpc-handlers.ts) —
 * never a client-supplied field. Its email is the member this session is
 * attributed to and billed to (§3.3 case 1, §5.5).
 */
/**
 * One start at a time per (project, member) within this daemon. The
 * storage-level claim (createBuilderSession's active-session refusal) is the
 * DURABLE half of the exclusion — it holds across daemon restarts and covers
 * callers this process never saw, including the raw storage proxy; this mutex
 * is the in-daemon half that also serializes the RESUME path, which updates an
 * existing row and so cannot rely on create's refusal. Without it, two
 * concurrent starts on a stopped row would both read 'stopped' and both
 * launch, splitting the conversation across two containers; on the fresh path
 * the read-then-create race let both register a row. A second daemon on the
 * same store is out of scope — one daemon serves a store, and even then the
 * durable refusal still guards the fresh path there.
 */
const builderStartMutex = new TaskMutex();

function builderStartLockKey(projectRoot: string, memberEmail: string | null): string {
  return `builder-start:${projectRoot}:${memberEmail ?? '(no member)'}`;
}

/** Longest container-output tail kept on a row. */
const LAST_EXIT_LOG_LINES = 40;
/**
 * How much raw TTY output is read to find those lines: a builder's last screen
 * can be nothing but escape codes, so a short raw tail strips to nothing.
 */
const LAST_EXIT_RAW_LOG_LINES = 500;

/**
 * Sessions a member's stop or end is putting down RIGHT NOW, in this daemon.
 * Neither takes the start mutex (a stop can take ten seconds and must not hold
 * a start up), and between the container exiting and their guarded write the
 * row still says `running` over a container that is gone — which a settle
 * must not take over. An identity held for exactly the stop's duration, never
 * a timestamp: one daemon serves a store.
 */
const releasingSessions = new Map<string, number>();

/**
 * Counted, not a set: two overlapping releases of one session (a double-
 * clicked Stop, a Stop then an End) must keep the guard until the LAST ends.
 */
async function whileReleasing<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  releasingSessions.set(sessionId, (releasingSessions.get(sessionId) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const left = (releasingSessions.get(sessionId) ?? 1) - 1;
    if (left <= 0) releasingSessions.delete(sessionId);
    else releasingSessions.set(sessionId, left);
  }
}

/**
 * Whether a builder's container is running, as a THREE-way answer. A runtime
 * that did not answer (docker unreachable, a timed-out inspect) is `unknown`,
 * never "dead": `isRunning` folds every failure into `false`, and acting on
 * that would stop a live builder because one `docker ps` was slow. Runners
 * without a three-way probe (host-process, where nothing can time out) fall
 * back to `isRunning`.
 */
export type BuilderRunProbe =
  | { state: 'running' }
  | { state: 'gone'; exitCode: number | null }
  | { state: 'unknown'; reason: string };

export async function probeBuilderRun(
  runner: Awaited<ReturnType<typeof createRunner>>,
  containerName: string,
): Promise<BuilderRunProbe> {
  if (!runner.probeRunInfo) {
    return (await runner.isRunning(containerName)) ? { state: 'running' } : { state: 'gone', exitCode: null };
  }
  const probe = await runner.probeRunInfo(containerName);
  if (probe.kind === 'no-answer') return { state: 'unknown', reason: probe.reason };
  if (probe.info?.running) return { state: 'running' };
  return { state: 'gone', exitCode: probe.info && Number.isFinite(probe.info.exitCode) ? probe.info.exitCode : null };
}

/**
 * One line (plus an output tail) saying how a builder container that nobody
 * stopped ended. A detached builder is launched without `--rm`, so its output
 * is still readable until the recovery removes it.
 */
async function describeDeadContainer(
  runner: Awaited<ReturnType<typeof createRunner>>,
  containerName: string,
  exitCode: number | null,
  runId?: string,
  supervisorLogHostFile?: string,
): Promise<string> {
  const head0 = exitCode === null
    ? 'The builder stopped unexpectedly.'
    : `The builder stopped unexpectedly (exit code ${exitCode}).`;
  if (runner.describeExitedRun) {
    // Every part of the evidence, each saying why when it is missing: a
    // builder that died with exit 1 once showed nothing at all, because a
    // failed `docker logs` and an empty one read the same.
    const evidence = await runner.describeExitedRun(containerName, { rawLines: LAST_EXIT_RAW_LOG_LINES, keepLines: LAST_EXIT_LOG_LINES, supervisorLogHostFile }).catch((err: unknown) =>
      [`Could not read how it ended: ${err instanceof Error ? err.message : String(err)}`]);
    const body = evidence.join('\n').replace(/\r\n?/g, '\n').replace(TERMINAL_CONTROL, '').trim();
    logger.warn(`${runId ? `builder start [run ${runId}]: ` : ''}Builder container ${containerName} exited on its own: ${head0}\n${body}`);
    return `${head0}\n${body.slice(-6000)}`;
  }
  const logs = await runner.getRunLogs(containerName, LAST_EXIT_RAW_LOG_LINES).catch((err: unknown) => {
    // The output is a courtesy on top of the exit code; losing it must not
    // stop the row from being recorded truthfully, but it is said.
    logger.warn(`Could not read the output of stopped builder container ${containerName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const head = exitCode === null
    ? 'The builder stopped unexpectedly.'
    : `The builder stopped unexpectedly (exit code ${exitCode}).`;
  const tail = logs ? printableTail(logs, LAST_EXIT_LOG_LINES) : '';
  return tail ? `${head}\n${tail.slice(-4000)}` : head;
}

/**
 * ONE ANSWER TO "IS THIS BUILDER RUNNING". The row's `running` is a claim the
 * daemon wrote at launch; the container can die underneath it (a crash, a
 * daemon roll, a VM restart) and nothing is watching. The attach route asks
 * the runtime, so a list that reported the row's word said "Running" beside a
 * terminal refusing with "not running any more".
 *
 * Every read of a project's builder runs calls this first (the registry reads
 * and `listBuilders`/`getBuilder` through the storage RPC, `builderTranscript`,
 * the daemon dashboard's Builders pages, and the attach liveness check): a
 * `running` row whose container the runtime SAYS is gone is recovered exactly
 * as the next start would recover it — exit reason recorded, resources
 * released, row `stopped` and resumable.
 *
 * It acts only on a definite answer and never gets in anyone's way:
 * - a runtime that does not answer leaves every row as it is;
 * - a row whose start is in flight (the start mutex is held) is skipped rather
 *   than waited for — that start owns it, and a page read must not wait out a
 *   launch;
 * - a row with a stop/end in flight (`releasingSessions`; neither takes the
 *   start mutex) is left to that stop, whose capture and write it would
 *   otherwise take over.
 * Never throws.
 */
export async function settleDeadBuilderSessions(projectRoot: string): Promise<void> {
  let rows: BuilderSession[];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  try {
    const storage = await getOrCreateStorage();
    rows = (await storage.listBuilderSessions(projectRoot))
      .filter((r) => r.state === 'running' && r.containerName);
    if (rows.length === 0) return;
    runner = await createRunner(projectRoot);
  } catch (err) {
    logger.warn(`Could not check builder sessions for dead containers: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const row of rows) {
    const lockKey = builderStartLockKey(projectRoot, row.memberEmail);
    try {
      if (builderStartMutex.isLocked(lockKey) || releasingSessions.has(row.id)) continue;
      const first = await probeBuilderRun(runner, row.containerName!);
      if (first.state === 'unknown') {
        logger.warn(`Could not tell whether builder session ${row.id} is running: ${first.reason}. Left as it is.`);
        continue;
      }
      if (first.state === 'running') continue;
      if (builderStartMutex.isLocked(lockKey)) continue;
      await builderStartMutex.withLock(lockKey, async () => {
        const storage = await getOrCreateStorage();
        const current = await storage.getBuilderSession(row.id);
        // Re-read under the start lock: a start may have recovered or relaunched it.
        if (!current || current.state !== 'running' || current.builderId !== row.builderId || !current.containerName) return;
        if (releasingSessions.has(current.id)) return;
        const probe = await probeBuilderRun(runner, current.containerName);
        if (probe.state !== 'gone') return;
        assertSessionRowActionable(current);
        const lastExit = await describeDeadContainer(runner, current.containerName, probe.exitCode, current.id, await supervisorLogHostFileFor(projectRoot, current));
        const stopResult = await stopSessionContainer(projectRoot, current, { knownGone: true });
        await releaseOutgoingSessionResources(projectRoot, current);
        try {
          await storage.updateBuilderSession(current.id, {
            state: 'stopped',
            containerName: null,
            agentSessionId: (stopResult.ok ? stopResult.agentSessionId : null) ?? current.agentSessionId,
            lastExit,
          }, 'running', current.builderId);
        } catch (err) {
          // Ended or stopped meanwhile by its member: that decision stands.
          if (!(err instanceof BuilderSessionStateConflictError)) throw err;
        }
      });
    } catch (err) {
      logger.warn(
        `Could not settle builder session ${row.id} whose container may be gone: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function handleStartBuilderSession(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<BuilderSession> {
  const memberEmail = actorEmail(params.actor as ActorInput | undefined) ?? null;
  // Every phase of this start, and how long it took, lands in the daemon log
  // under one prefix carrying the run id and builder id (BuilderStartTrace).
  // How long a start took, success or not, is also the other half of reading a
  // start whose caller's connection was cut (the RPC route logs that).
  const trace = new BuilderStartTrace(newBuilderId(), memberEmail);
  trace.begin();
  const warmup = describeLaunchWarmup();
  if (warmup) trace.note(warmup);
  try {
    const lockKey = builderStartLockKey(projectRoot, memberEmail);
    if (builderStartMutex.isLocked(lockKey)) trace.note('waiting for this member\'s previous start to finish');
    const row = await builderStartMutex.withLock(
      lockKey,
      () => startBuilderSessionLocked(projectRoot, memberEmail, trace),
    );
    trace.setRunId(row.id, row.builderId);
    const launchedHere = row.builderId === trace.builderId;
    trace.finish(`startBuilderSession: builder session ${row.id} is ${row.state}` +
      (launchedHere ? '' : ' (already running; nothing launched)'));
    if (launchedHere) await persistTimeline(trace);
    if (row.state === 'running' && launchedHere && row.containerName) {
      watchLaunchedBuilder(projectRoot, row, trace);
    }
    return row;
  } catch (err) {
    trace.fail(err);
    await persistTimeline(trace);
    throw err;
  }
}

/**
 * Record the start's timeline on its run row — only while the row is still on
 * the builder THIS start launched (compare-and-set on the builder id), so a
 * later start's timeline, or a running builder's from a rejoin that failed, is
 * never overwritten. A no-op before the row exists or once it moved on.
 */
function persistTimeline(trace: BuilderStartTrace): Promise<void> {
  if (!trace.ownsRun()) return Promise.resolve();
  return trace.persist(async (runId, startTimeline) => {
    try {
      await (await getOrCreateStorage()).updateBuilderSession(runId, { startTimeline }, undefined, trace.builderId);
    } catch (err) {
      if (!(err instanceof BuilderSessionStateConflictError)) throw err;
    }
  });
}

/**
 * How long after `docker run` returns the daemon keeps an eye on a freshly
 * launched builder. `docker run -d` returning says the container was CREATED;
 * a builder that dies in its first seconds (a failed preflight, Claude Code
 * exiting) used to leave no trace until somebody next opened a page, and then
 * only on that page. Each check is one `docker inspect`.
 */
export const LAUNCH_WATCH_CHECKS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Follow a just-launched builder through its first minute and write what
 * happened into the start's trail: still up at each check, or dead — in which
 * case the dead-builder recovery runs at once, recording the container's
 * exit evidence on the row and in the log before the container is removed.
 * Fire-and-forget; never throws.
 */
function watchLaunchedBuilder(projectRoot: string, row: BuilderSession, trace: BuilderStartTrace): void {
  const containerName = row.containerName!;
  void (async () => {
    try {
      const runner = await createRunner(projectRoot);
      let waited = 0;
      for (const at of LAUNCH_WATCH_CHECKS_MS) {
        await new Promise((r) => { setTimeout(r, at - waited).unref?.(); });
        waited = at;
        const probe = await probeBuilderRun(runner, containerName);
        if (probe.state === 'running') {
          if (at === LAUNCH_WATCH_CHECKS_MS[LAUNCH_WATCH_CHECKS_MS.length - 1]) {
            trace.note(`container ${containerName} still running ${at / 1000}s after launch`);
            await persistTimeline(trace);
          }
          continue;
        }
        if (probe.state === 'unknown') {
          trace.note(`could not tell whether ${containerName} is running ${at / 1000}s after launch: ${probe.reason}`);
          continue;
        }
        // Gone because its member stopped or ended it is not a crash: only a
        // row still `running` on THIS launch's container is reported and settled.
        const storage = await getOrCreateStorage();
        const current = await storage.getBuilderSession(row.id);
        // Already settled as a crash by the reconcile tick (same builder, now
        // stopped, with how it ended): that IS the crash — record it as one.
        if (current && current.state === 'stopped' && current.builderId === row.builderId && current.lastExit) {
          logger.warn(
            `builder start [run ${row.id}, builder ${row.builderId}]: container ${containerName} EXITED by ` +
            `${at / 1000}s after launch; ${current.lastExit.split('\n')[0]}`,
          );
          trace.record('failed', 'builder container', current.lastExit);
          await persistTimeline(trace);
          return;
        }
        if (!current || current.state !== 'running' || current.builderId !== row.builderId
          || current.containerName !== containerName || releasingSessions.has(row.id)) {
          trace.note(`container ${containerName} is gone ${at / 1000}s after launch because the builder was ${current?.state ?? 'removed'} (not a crash)`);
          await persistTimeline(trace);
          return;
        }
        const exited = `container ${containerName} EXITED within ${at / 1000}s of launch ` +
          `(exit code ${probe.exitCode ?? 'unknown'}); its exit evidence is recorded on the run`;
        logger.warn(`builder start [run ${row.id}, builder ${row.builderId}]: ${exited}`);
        trace.record('failed', 'builder container', exited);
        await settleDeadBuilderSessions(projectRoot);
        await persistTimeline(trace);
        return;
      }
    } catch (err) {
      trace.note(`launch watch stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

async function startBuilderSessionLocked(
  projectRoot: string,
  memberEmail: string | null,
  trace: BuilderStartTrace,
): Promise<BuilderSession> {
  const storage = await getOrCreateStorage();

  let existing = await storage.getActiveBuilderSessionForMember(projectRoot, memberEmail);
  if (existing) trace.setRunId(existing.id, existing.builderId);
  // Everything below acts on this row's builder id and container name.
  if (existing) assertSessionRowActionable(existing);
  if (existing && existing.containerName && (existing.state === 'running' || existing.state === 'starting')) {
    // A daemon restart or roll can reap this container (fleet-version-rollout,
    // `lazy upgrade`'s builder discovery — both find it under the SAME
    // `lazy-builder-<id>` naming the CLI-launched path uses) without this row
    // ever hearing about it, since nothing here was watching. Verify liveness
    // rather than trusting the record: a dead container behind a 'running' or
    // 'starting' row must fall through to the resume path below, capturing
    // whatever the resume-intent handshake stamped on the way out. A 'starting'
    // row exists between this function's claim and its post-launch reconcile
    // — reached here only when the daemon died in that window (the start mutex
    // serializes live starts), so the same treatment is the recovery path for
    // both row states.
    const runner = await createRunner(projectRoot);
    // Three-way, like every other reader (probeBuilderRun): a runtime that did
    // not answer is refused, never read as "dead" — that reading stopped and
    // relaunched a LIVE builder because one probe was slow.
    const liveness = await probeBuilderRun(runner, existing.containerName);
    if (liveness.state === 'unknown') {
      logger.warn(`startBuilderSession: liveness of ${existing.containerName} unknown: ${liveness.reason}`);
      throw new RpcError(503, 'Could not check whether your builder is running right now. Try again in a moment.');
    }
    if (liveness.state === 'running') {
      if (existing.state === 'starting') {
        // The container from a crashed start is already up; reconcile the row
        // rather than racing a second launch underneath it.
        return reconcileClaimedSession(projectRoot, existing, existing.containerName);
      }
      // Already up — the attach route (a later task) is what actually connects
      // a terminal to it; this call is idempotent discovery until then.
      return existing;
    }
    // Read how it ended BEFORE the cleanup below removes the container.
    const lastExit = existing.state === 'running'
      ? await describeDeadContainer(runner, existing.containerName, liveness.exitCode, existing.id, await supervisorLogHostFileFor(projectRoot, existing))
      : null;
    // Already confirmed dead above, so this is cleanup (release any lingering
    // resources, capture the resume intent) rather than a stop that can fail
    // the way endBuilderSession's can — a hiccup capturing the intent must
    // not block starting a fresh session underneath a container that is
    // already gone.
    const stopResult = await stopSessionContainer(projectRoot, existing, { knownGone: true });
    // The outgoing launch is confirmed dead. Release what it held NOW, while
    // the row still carries the builder id those resources are keyed by —
    // releaseOutgoingSessionResources would otherwise only run on the resume
    // below, and if THAT launch failed the row would sit stopped holding a
    // live MCP token and credential binding until some later resume.
    await releaseOutgoingSessionResources(projectRoot, existing);
    // CAS on the state the liveness check saw. endBuilderSession does not take
    // the start mutex, so a member's end can land anywhere in this branch —
    // and against a container that is already gone it SUCCEEDS. An unguarded
    // write here then overwrote that 'ended' with 'stopped', and the resume
    // below relaunched a session its member had ended (§5.7). Same shape as
    // the resume claim's guard.
    const expectedState = existing.state;
    try {
      existing = await storage.updateBuilderSession(existing.id, {
        state: 'stopped',
        containerName: null,
        agentSessionId: (stopResult.ok ? stopResult.agentSessionId : null) ?? existing.agentSessionId,
        ...(lastExit ? { lastExit } : {}),
      }, expectedState);
    } catch (err) {
      if (!(err instanceof BuilderSessionStateConflictError)) throw err;
      throw new RpcError(
        409,
        `Builder session ${existing.id} was ended while this start was recovering its dead container ` +
        `(expected '${expectedState}', found '${err.actualState}'). The ended session is terminal; ` +
        `start again to create a fresh session.`,
      );
    }
  }

  // Credential gate BEFORE the claim (MONEY BEFORE INFRASTRUCTURE): a member
  // with no usable credential is refused here, before any registry row exists
  // — a policy refusal is not a launch attempt and leaves nothing behind. The
  // resolved plan rides into the launch so the credential is decided exactly
  // once. Failure past this point releases the admitted slot in the catch
  // below; nothing else exists yet to unwind.
  const builderId = trace.builderId;
  const admission = await handleBuilderSlot(projectRoot, { action: 'admit', builderId });
  if (!admission.admitted) {
    throw new RpcError(
      429,
      `Builder concurrency limit reached (${admission.running}/${admission.limit} slots in use). ` +
      `Wait for another builder session to finish, then retry.`,
    );
  }
  const launchPlan = await trace.phase('credential plan', () => planSessionLaunchCredential(projectRoot, builderId, memberEmail));

  // Register the claim BEFORE the launch. This row is what keeps the
  // container from ever outrunning its record: a crash (write failure, daemon
  // death) after the launch leaves a 'starting' row naming the container, so
  // endBuilderSession and the next start's liveness check can still reach it —
  // instead of a detached container with a live daemon MCP token and no row
  // at all. The container name is the one launch will use — `builderRunName`
  // is the same derivation `lazy-builder-<id>` uses everywhere else — and the
  // post-launch reconcile stamps the runner-confirmed name.
  let claimed: BuilderSession | null = null;
  let launchedContainer: string | null = null;
  try {
    if (existing && existing.state === 'stopped') {
      // Reached either straight from the stale branch above — where these
      // calls are idempotent no-ops — or on a row left stopped by an earlier
      // call, whose outgoing token/slot/credential binding are still live.
      // In BOTH cases they must go BEFORE the claim below replaces the row's
      // builderId: the replacement is what makes the outgoing id unrevokable
      // forever.
      await releaseOutgoingSessionResources(projectRoot, existing);
      const resumeSessionId = existing.agentSessionId;
      try {
        // CAS on the resume claim: the member may end the STOPPED session
        // while this start is claiming it (endBuilderSession accepts a
        // stopped row — a stopped session is resumable until explicitly
        // ended). Without the guard the claim would overwrite the member's
        // end and the launch below would resurrect the ended session.
        claimed = await storage.updateBuilderSession(existing.id, {
          state: 'starting',
          containerName: builderRunName(builderId),
          builderId,
          lastExit: null,
        }, 'stopped');
      } catch (err) {
        if (!(err instanceof BuilderSessionStateConflictError)) throw err;
        // Refuse loudly rather than resurrect or silently invent a fresh
        // session: the ended row is terminal (§5.7), and the NEXT start finds
        // no active row and creates one. The slot this call admitted is
        // released by the outer catch below; nothing was claimed or launched.
        throw new RpcError(
          409,
          `Builder session ${existing.id} was ended while this start was in flight ` +
          `(expected 'stopped', found '${err.actualState}'). The ended session is terminal; ` +
          `start again to create a fresh session.`,
        );
      }
      trace.setRunId(claimed.id);
      trace.note(`resuming stopped builder session ${claimed.id}`);
      const launched = await launchDetachedContainer({
        projectRoot,
        memberEmail,
        builderId,
        resumeSessionId,
        launchPlan,
        trace,
      });
      launchedContainer = launched.containerName;
      // A conversation that could not be resumed is forgotten, or the next
      // start would try it again.
      return await reconcileClaimedSession(projectRoot, claimed, launched.containerName,
        launched.resumed === resumeSessionId ? {} : { agentSessionId: null });
    }

    const now = new Date().toISOString();
    try {
      claimed = await storage.createBuilderSession({
        id: randomUUID(),
        projectRoot,
        memberEmail,
        kind: 'interactive',
        state: 'starting',
        containerName: builderRunName(builderId),
        builderId,
        agentSessionId: null,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      });
    } catch (err) {
      if (!(err instanceof BuilderSessionActiveError)) throw err;
      // Lost a race the durable refusal just settled. The mutex serializes
      // starts inside this daemon, so reaching here means the rival came from
      // outside this handler — the storage proxy, or (defensively) a second
      // daemon on the same store. It is the SAME member's session, so the
      // right answer to "start a session" is the session that already exists:
      // return the winner as-is. Its state is what it really is — 'running'
      // means adopt it; 'stopped' means the rival's launch failed and this
      // call's retry path (resume) applies. Nothing was claimed or launched
      // here, so nothing needs unwinding; the admitted slot is released by
      // the outer catch below.
      const winner = await storage.getActiveBuilderSessionForMember(projectRoot, memberEmail);
      if (!winner) throw err;
      return winner;
    }
    trace.setRunId(claimed.id);
    const { containerName } = await launchDetachedContainer({
      projectRoot,
      memberEmail,
      builderId,
      resumeSessionId: null,
      launchPlan,
      trace,
    });
    launchedContainer = containerName;
    return await reconcileClaimedSession(projectRoot, claimed, containerName);
  } catch (err) {
    await handleBuilderSlot(projectRoot, { action: 'release', builderId }).catch(() => {});
    // Demote only a launch that never produced a container. Once the container
    // is up, the row's job is to NAME it — the slot count derives from live
    // containers, so releasing the reservation below is self-correcting, and a
    // failed reconcile leaves the 'starting' row for the next start's liveness
    // check to adopt. Demoting a live container would recreate the orphan this
    // claim exists to prevent.
    if (claimed && !launchedContainer) {
      await demoteFailedLaunch(projectRoot, claimed, err).catch((demoteErr) =>
        logger.warn(
          `Failed to demote builder session ${claimed?.id} after a failed launch: ` +
          `${demoteErr instanceof Error ? demoteErr.message : String(demoteErr)}. ` +
          `The row stays 'starting' and names a container that was never launched; ` +
          `the next start's liveness check will treat it as dead and recover.`,
        ),
      );
    }
    throw err;
  }
}

/**
 * End a member's builder session explicitly. Terminal — an ended session is
 * never resumed (§5.7: "a session ends explicitly, and not otherwise").
 *
 * Stops the container with a graceful SIGTERM window so the in-container
 * supervisor's exit handler stamps the live Claude session id onto its
 * `BuilderResumeIntent` (the same mechanism `lazy upgrade` already relies on —
 * see src/builder/relaunch.ts) before it is captured onto this row.
 */
export async function handleEndBuilderSession(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<BuilderSession> {
  const id = params.id;
  if (typeof id !== 'string' || !id) throw new RpcError(400, 'endBuilderSession: `id` is required');
  // Held for the whole end: a settle stays off this row until it is written.
  return whileReleasing(id, () => endBuilderSessionHeld(projectRoot, params));
}

async function endBuilderSessionHeld(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<BuilderSession> {
  const id = params.id;
  if (typeof id !== 'string' || !id) throw new RpcError(400, 'endBuilderSession: `id` is required');

  const storage = await getOrCreateStorage();
  const session = await storage.getBuilderSession(id);
  if (!session || session.projectRoot !== projectRoot) {
    throw new RpcError(404, `Builder session not found: ${id}`);
  }

  await assertSessionBelongsToCaller(projectRoot, session, params, 'end');

  if (session.state === 'ended') return session;

  // FAIL HARD ON A FAILED STOP (CLAUDE.md: no silent fallbacks). The daemon
  // now owns this container's lifetime — endBuilderSession is the only stop
  // path a member has — so `success: true` on a stop that did not actually
  // happen would leave the container running, the registry saying the
  // session is over, and no way to reach it through lazy again (a retry short
  // -circuits on `state === 'ended'`). Only mark the row 'ended', and only
  // revoke its token/slot/credential binding, once the container is
  // confirmed gone.
  const stopResult = await stopSessionContainer(projectRoot, session);
  if (!stopResult.ok) {
    throw new RpcError(
      502,
      `endBuilderSession: could not stop container ${session.containerName} for session ${id}: ` +
      `${stopResult.reason}. The session was NOT marked ended — it may still be running. Retry once ` +
      `the runner is reachable.`,
    );
  }

  // Only now is it safe to revoke: the container is confirmed stopped, so
  // nothing is still relying on this MCP token / credential binding.
  await releaseOutgoingSessionResources(projectRoot, session);

  return writeReleasedSession(session, 'end', {
    state: 'ended',
    containerName: null,
    agentSessionId: stopResult.agentSessionId ?? session.agentSessionId,
    endedAt: new Date().toISOString(),
  });
}

/**
 * The final write of stop/end, guarded on the LAUNCH that was read — its state
 * AND its builder id. Neither handler takes the start mutex, and the graceful
 * stop above can take ten seconds: a concurrent start that finds the container
 * dead recovers the row, claims it and relaunches under a NEW builder id,
 * leaving it 'running' again. State alone cannot see that (running → … →
 * running), and an unguarded write then stamped 'ended'/'stopped' with no
 * container over a live launch, whose container, MCP token and credential
 * binding no row named any more. On a conflict the row is left exactly as the
 * start wrote it and the caller is refused: the resources released above
 * belonged to the launch this call stopped, never to the new one.
 */
async function writeReleasedSession(
  session: BuilderSession,
  verb: 'stop' | 'end',
  patch: BuilderSessionUpdate,
): Promise<BuilderSession> {
  const storage = await getOrCreateStorage();
  try {
    return await storage.updateBuilderSession(session.id, patch, session.state, session.builderId);
  } catch (err) {
    if (!(err instanceof BuilderSessionStateConflictError)) throw err;
    const now = await storage.getBuilderSession(session.id);
    throw new RpcError(
      409,
      `Builder session ${session.id} changed while this ${verb} was in flight ` +
      `(it is now '${now?.state ?? 'gone'}'${now && now.builderId !== session.builderId ? ', relaunched by a concurrent start' : ''}). ` +
      `The launch this ${verb} read was stopped and released; the session's current state was left as is. ` +
      `Retry the ${verb} if you still want it.`,
    );
  }
}

/**
 * Stop a member's builder session WITHOUT ending it: the container goes away,
 * the conversation id is captured, and the session stays RESUMABLE — the next
 * `startBuilderSession` for this member relaunches it with `--resume <that
 * id>` rather than opening a fresh conversation.
 *
 * This is the operation the 'stopped' state was declared for, and without it
 * that state — and the whole resume path under it — was unreachable by design
 * rather than by accident. `endBuilderSession` is TERMINAL (§5.7), so an
 * end-then-start always produced a new conversation; the only other route to
 * 'stopped' was a container dying unobserved, where nothing could have armed
 * the handshake that captures the id. A session the daemon "can hand back
 * after a restart" therefore never actually handed anything back.
 *
 * The two differ in exactly one thing — whether the session may be resumed —
 * so everything else is shared: the same ownership guard, the same fail-hard
 * stop, the same release of the launch's token/slot/credential binding (the
 * LAUNCH is over either way; only the SESSION survives here).
 */
export async function handleStopBuilderSession(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<BuilderSession> {
  const id = params.id;
  if (typeof id !== 'string' || !id) throw new RpcError(400, 'stopBuilderSession: `id` is required');
  // Held for the whole stop: a settle stays off this row until it is written.
  return whileReleasing(id, () => stopBuilderSessionHeld(projectRoot, params));
}

async function stopBuilderSessionHeld(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<BuilderSession> {
  const id = params.id;
  if (typeof id !== 'string' || !id) throw new RpcError(400, 'stopBuilderSession: `id` is required');

  const storage = await getOrCreateStorage();
  const session = await storage.getBuilderSession(id);
  if (!session || session.projectRoot !== projectRoot) {
    throw new RpcError(404, `Builder session not found: ${id}`);
  }

  await assertSessionBelongsToCaller(projectRoot, session, params, 'stop');

  // An ended session is terminal and cannot be reopened by stopping it — say
  // so rather than quietly writing 'stopped' over 'ended', which would
  // resurrect a session the member deliberately finished (§5.7).
  if (session.state === 'ended') {
    throw new RpcError(
      409,
      `Builder session ${id} has ended. An ended session is terminal and cannot be resumed; ` +
      `start again to create a fresh session.`,
    );
  }
  if (session.state === 'stopped') return session;

  const stopResult = await stopSessionContainer(projectRoot, session);
  if (!stopResult.ok) {
    throw new RpcError(
      502,
      `stopBuilderSession: could not stop container ${session.containerName} for session ${id}: ` +
      `${stopResult.reason}. The session was NOT marked stopped — it may still be running. Retry ` +
      `once the runner is reachable.`,
    );
  }

  await releaseOutgoingSessionResources(projectRoot, session);

  // The captured conversation id is the whole point of stopping rather than
  // ending: it is what the next start hands to `--resume`. Falling back to
  // whatever the row already held keeps an earlier capture rather than
  // blanking it when this stop caught nothing (an already-dead container).
  return writeReleasedSession(session, 'stop', {
    state: 'stopped',
    containerName: null,
    agentSessionId: stopResult.agentSessionId ?? session.agentSessionId,
    lastExit: null,
  });
}

/**
 * A SESSION IS ITS MEMBER'S TO STOP OR END (§5.5), enforced identically for
 * both — a stop a non-owner could call is the same hostile interruption as an
 * end, one word softer.
 */
async function assertSessionBelongsToCaller(
  projectRoot: string,
  session: BuilderSession,
  params: Record<string, unknown>,
  verb: 'stop' | 'end',
): Promise<void> {
  // The caller's member is DERIVED
  // from the daemon-resolved actor — the same derivation
  // handleStartBuilderSession used to name the session — never from a request
  // field: a caller may name the role, never the person (§3.4). In team mode
  // every member holds a user-kind actor token that reaches every RPC, so
  // without this check member B could pass member A's session id and kill A's
  // running builder container mid-conversation; A's only recovery would be
  // starting over.
  //
  // Keyed on whether another member CAN exist ({@link multiMemberDaemon}) —
  // managed mode or team mode. It was team mode alone, which left a managed
  // project on the service credential open: its members all hold user tokens,
  // and any of them could stop or end another's session. On a single-person
  // install there IS no other member — identity is the daemon's own git
  // config, the caller IS the machine's owner, and these calls must keep
  // working exactly as they do today, including when that identity drifts
  // between the start and the stop. Where members exist, a row without a
  // member email cannot be proven to belong to the caller and is refused (the
  // restrictive side of the unclear case).
  //
  // There is no admin exception on top of this, deliberately: what identifies
  // an operator in this codebase is a control-kind token, and both callers are
  // classified HUMAN-INITIATED (./rpc-command-kinds.ts), so on a managed host
  // that token is already refused upstream (assertHumanActionCarriesAPerson)
  // before this check ever runs — an operator exception here would be dead
  // code in the only mode where other members exist.
  if (await multiMemberDaemon(projectRoot)) {
    const callerMember = actorEmail(params.actor as ActorInput | undefined) ?? null;
    if (callerMember !== session.memberEmail) {
      throw new RpcError(
        403,
        `Builder session ${session.id} belongs to ${session.memberEmail ?? 'no member'}; ` +
        `only its own member may ${verb} it.`,
      );
    }
  }
}

type StopSessionContainerResult =
  | { ok: true; agentSessionId: string | null }
  | { ok: false; reason: string };

/**
 * Stop a session's container and return whatever Claude session id the
 * resume-intent handshake captured.
 *
 * Distinguishes "already gone" (fine — a daemon roll or a prior stop already
 * reaped it, so there is nothing left to stop) from "the stop failed" (docker
 * unreachable, a hung container) by checking liveness FIRST: `stopRun`'s own
 * contract reports both as a bare `false` (see its doc comment), which is
 * right for its other callers but would be exactly the silent-success bug
 * this function exists to avoid.
 */
async function stopSessionContainer(
  projectRoot: string,
  session: BuilderSession,
  opts: { knownGone?: boolean } = {},
): Promise<StopSessionContainerResult> {
  assertSessionRowActionable(session);
  if (!session.containerName) return { ok: true, agentSessionId: null };
  const runner = await createRunner(projectRoot);

  // Three-way: a runtime that does not answer is NOT "already gone" —
  // reading it that way recorded a possibly live container as stopped, with
  // no conversation captured. Refuse instead; the caller reports it. A caller
  // that already had a definite "gone" (settle, start's recovery) says so and
  // is not re-asked: a third probe that happened not to answer must not skip
  // the removal and the config fold-back below.
  let wasRunning = false;
  if (!opts.knownGone) try {
    const probe = await probeBuilderRun(runner, session.containerName);
    if (probe.state === 'unknown') {
      return { ok: false, reason: `could not determine whether the container is running: ${probe.reason}` };
    }
    wasRunning = probe.state === 'running';
  } catch (err) {
    return {
      ok: false,
      reason: `could not determine whether the container is running: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (wasRunning) {
    // ARM THE HANDSHAKE BEFORE THE SIGNAL. The in-container supervisor's
    // stamp (`stampSessionIdOnStorage`, src/supervisor/builder.ts) updates an
    // intent that ALREADY EXISTS and deliberately never creates one — an
    // intent it invented would make the host `lazy builder` wrapper relaunch
    // after an ordinary quit. Its producer used to be `lazy upgrade`, which
    // wrote an intent before stopping each builder container; upgrade no
    // longer stops builders at all ("builder session(s) stay running — they
    // reconnect when the daemon restarts"), so for a daemon-owned session
    // nothing wrote one and the stamp took its no-intent branch on every
    // stop. The result was silent and total: the session id was never
    // captured, the row's `agentSessionId` stayed null, and every "resume"
    // launched a FRESH conversation — the one thing a session the daemon can
    // hand back after a restart exists to prevent.
    //
    // `reason: 'daemon-restart'` deliberately, not 'upgrade' (the default
    // when absent): the only reader of that field is the host wrapper's
    // relaunch loop, where 'upgrade' means "block until the daemon comes back
    // with a new version". This daemon is serving right now, so if such a
    // wrapper ever met this intent it must not wait.
    //
    // Best-effort: a store hiccup here costs the conversation id, which the
    // member can still reach through `/resume` in a fresh session — it must
    // not turn an explicit end into a 502 with the container already
    // signalled.
    await armResumeIntent(projectRoot, session);
    // 10s grace, same window `lazy upgrade` used for its builder stop: enough
    // for the supervisor's SIGTERM handler to flush capture and stamp the
    // resume intent armed above before escalating to SIGKILL.
    const stopped = await runner.stopRun(session.containerName, { gracefulTimeoutSeconds: 10 });
    if (!stopped) {
      return { ok: false, reason: 'the runner refused or could not reach the container to stop it' };
    }
  }

  try {
    await runner.removeRun(session.containerName);
  } catch (err) {
    // The container is confirmed STOPPED at this point — removal failing
    // (already removed, a transient docker hiccup) leaves a stopped
    // container behind but does not strand a live one, so it is logged and
    // does not block ending the session.
    logger.warn(
      `Could not remove stopped builder session container ${session.containerName}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // SAVE WHAT THE SESSION WROTE. Reached only past a confirmed stop (a stop
  // that failed returned above), so the container can no longer be writing
  // the mounted config — and before the per-launch files are removed, which
  // is the caller's next step. Without this, onboarding, folder trust and the
  // model choice Claude Code wrote into the mounted copy were discarded on
  // every stop and each resume re-seeded from scratch.
  await persistSessionClaudeConfig(projectRoot, session);

  const intent = await storageTakeResumeIntent(session.builderId);
  return { ok: true, agentSessionId: intent?.sessionId ?? null };
}

async function storageTakeResumeIntent(builderId: string) {
  const storage = await getOrCreateStorage();
  return storage.takeBuilderResumeIntent(builderId);
}

/**
 * Write the empty resume intent the in-container supervisor stamps its live
 * Claude session id onto during the SIGTERM window. See the call site for why
 * this must exist before the signal and why nothing else writes it.
 *
 * Keyed by the SHORT builder id, which is what `stampSessionIdOnStorage`
 * compares against (`i.builderId === builderId`, an exact match on the
 * supervisor's own `--builder-id`) — `matchIntentForBuilder`'s tolerance of the
 * `lazy-builder-<id>` spelling is the host wrapper's, not the stamp's, so the
 * run-name spelling would be written, never stamped, and read back empty.
 *
 * An intent left behind by a stop that then failed is harmless: the save
 * replaces by builder id rather than accumulating, the next successful stop
 * consumes it, and an unstamped intent yields a null session id, which the
 * caller already treats as "keep whatever the row had".
 */
async function armResumeIntent(projectRoot: string, session: BuilderSession): Promise<void> {
  try {
    const storage = await getOrCreateStorage();
    await storage.saveBuilderResumeIntent({
      builderId: session.builderId,
      projectRoot,
      createdAt: new Date().toISOString(),
      reason: 'daemon-restart',
    });
  } catch (err) {
    logger.warn(
      `Could not arm the resume-intent handshake for builder session ${session.id} ` +
      `(builder id ${session.builderId}): ${err instanceof Error ? err.message : String(err)}. ` +
      `The stop continues, but this session's conversation id will not be captured, so ` +
      `resuming it starts a new conversation.`,
    );
  }
}

/**
 * Fold the stopped launch's mounted `~/.claude.json` back into the member's
 * persisted per-member state — the file the NEXT launch seeds from (see
 * writeBuilderSessionClaudeConfig). The CLI builder does the same on container
 * exit; a daemon-owned container has no foreground process to do it, so the
 * stop does.
 *
 * Never throws (persistBuilderSessionClaudeConfig warns and returns false): a
 * housekeeping failure must not turn a completed stop into an error, and a
 * launch whose container never wrote a config simply has nothing to fold.
 */
async function persistSessionClaudeConfig(projectRoot: string, session: BuilderSession): Promise<void> {
  assertSessionRowActionable(session);
  const homeDirAbs = resolveBuilderSessionHomeDir(projectRoot, session.memberEmail);
  await persistBuilderSessionClaudeConfig({
    sessionPath: builderClaudeSessionConfigPath(await sessionLaunchDir(projectRoot, session), session.builderId),
    persistedPath: builderClaudeConfigPath(homeDirAbs),
    onWarn: (message) => logger.warn(message),
  });
}

/** Where one launch's per-launch files live — the member's own launch dir (see launchBuilderDetached). */
async function sessionLaunchDir(projectRoot: string, session: BuilderSession): Promise<string> {
  return builderSessionLaunchDir(resolveBuilderSessionHomeDir(projectRoot, session.memberEmail), session.builderId);
}

/** The persistent host copy of this launch's supervisor log (see launchBuilderDetached). */
async function supervisorLogHostFileFor(projectRoot: string, session: BuilderSession): Promise<string> {
  return builderSupervisorLogHostPath(await sessionLaunchDir(projectRoot, session), session.builderId);
}

/**
 * Delete one launch's per-launch files. Called wherever the launch's resources
 * are released — stop, end, the stale-container recovery, a failed launch —
 * and always AFTER persistSessionClaudeConfig has had its chance to fold the
 * mounted config back (stopSessionContainer runs first on every path that
 * stops a container). Idempotent: a launch whose files are already gone is
 * a no-op, which is what makes the release safe to repeat.
 *
 * Logged, not thrown, on failure: the directory holds nothing another member
 * can reach (it is under this member's home and mounted nowhere as a whole),
 * so a leftover is litter rather than exposure, and it must not strand a stop.
 */
async function removeSessionLaunchFiles(projectRoot: string, session: BuilderSession): Promise<void> {
  assertSessionRowActionable(session);
  const dir = await sessionLaunchDir(projectRoot, session);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      `Could not remove the per-launch files of builder session ${session.id} at ${dir}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
