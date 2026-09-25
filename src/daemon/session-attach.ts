/**
 * Which container a session attach reaches — resolved from the SESSION RECORD,
 * never from anything the client sends.
 *
 * The attach route (`GET /rpc/sessions/:id/attach/ws`, src/server/session-attach-ws.ts)
 * and its discovery RPC (`attachSession`) both call {@link resolveSessionAttachTarget}.
 * A client passes a session id and nothing else. See
 * docs/design/actor-identity-and-remote-clients.md §5.3.
 *
 * Two kinds of session answer to an id:
 *
 * - A daemon-owned BUILDER session (./builder-sessions.ts). The target is the
 *   container name recorded on the row — after `assertSessionRowActionable` has
 *   confirmed it is exactly this row's own `lazy-builder-<builderId>`, so a row
 *   naming someone else's container is refused rather than attached to. It is
 *   its member's: wherever other members can exist (managed mode, or team
 *   mode) a caller whose token names a different person (or no person — a
 *   control token) gets a 403.
 *   The terminal ATTACHES to the container's own TTY, because the session IS
 *   the container's main process.
 * - A TASK session. On a single-person daemon the target is
 *   `execContainerName(task, session, runner)`, the web shell's own
 *   derivation: the terminal enters the task's own container, exactly as the
 *   dashboard shell does. Where other members exist it NEVER does — the
 *   terminal runs AS the attaching member, in a container of their own built
 *   from the task's image on the task's worktree (./member-container.ts), on
 *   their own credential, and pair's rows name them. A caller naming nobody (a
 *   control token) is refused (403); so — with a 409 — is everyone while a
 *   turn is running, since member terminals and turns take turns with the
 *   worktree (./member-entry.ts).
 */

import type { Storage } from '../storage';
import type { BuilderSession } from '../storage/types';
import type { Session, Task, ActorInput } from '../types';
import type { Runner, RunnerType } from '../runner';
import { createRunner } from '../runner';
import { execContainerName } from '../server/shell-ws';
import { assertSessionRowActionable, multiMemberDaemon } from './builder-sessions';
import { RpcError } from './rpc-error';
import { actorEmail } from '../actor-ref';
import { resolveGitIdentity } from '../identity/git-identity';
import { getOrCreateStorage } from './rpc-handlers';
import { getTaskSessionBinding, type SessionCredentialBinding } from './session-credentials';
import { SERVICE_CREDENTIAL_USER_ID, getUserCredential } from './user-credentials';
import { memberCredentialMissingMessage } from '../server/member-exec-credential';
import { memberTerminalHolder, memberHeldMessage } from '../server/member-terminals';
import { memberContainerSettingsRefusal, memberRuntimeRefusal, agentTranscriptTooLarge, knownRuntimeSocketPaths, activeRuntimeSockets } from './member-container';
import { getWorktreePath } from '../task/identity';
import { loadConfig } from '../config/loader';
import { pairOrChatRefusal } from '../server/shell-pair';

// One definition of "can another member exist", shared with the session
// registry's own ownership checks (./builder-sessions.ts).
export { multiMemberDaemon };

/** The route a terminal upgrades on, for a session id. */
export function sessionAttachPath(sessionId: string): string {
  return `/rpc/sessions/${encodeURIComponent(sessionId)}/attach/ws`;
}

export type SessionAttachTarget =
  | {
      kind: 'builder';
      sessionId: string;
      builderSession: BuilderSession;
      container: string;
      binary: string;
    }
  | {
      kind: 'task';
      sessionId: string;
      task: Task;
      session: Session;
      container: string;
      binary: string;
    };

export type SessionAttachResolution =
  | { ok: true; target: SessionAttachTarget }
  | { ok: false; status: number; message: string };

type RunnerView = Pick<Runner, 'type' | 'usesSandbox' | 'runNameForTask'>;

export interface ResolveSessionAttachOptions {
  projectRoot: string;
  storage: Pick<Storage, 'getBuilderSession' | 'getSession' | 'getTask' | 'getSessionByTaskId' | 'getSessionTurns'>;
  sessionId: string;
  /** The person the CALLER's credential names, or null when it names nobody. */
  callerEmail: string | null;
  /**
   * Whether other members can exist on this daemon — managed mode OR team
   * mode ({@link multiMemberDaemon}). Enforces builder-session ownership and
   * requires a named member for a task session.
   */
  multiMember: boolean;
  /** The task's credential binding; seam for tests. */
  bindingFor?: (taskId: string) => Promise<Pick<SessionCredentialBinding, 'ownerUserId' | 'revokedAt'> | null>;
  /** Seam for tests; defaults to the project's configured runner. */
  runnerFor?: (runnerType: RunnerType | undefined) => Promise<RunnerView>;
}

function binaryFor(runner: RunnerView): string {
  return runner.type === 'podman' ? 'podman' : 'docker';
}

/**
 * Resolve an attach target, or the refusal a route should answer with.
 * Liveness (`docker ps`) is deliberately NOT asked here — see
 * {@link confirmAttachTargetRunning}.
 */
export async function resolveSessionAttachTarget(
  opts: ResolveSessionAttachOptions,
): Promise<SessionAttachResolution> {
  const { projectRoot, storage, sessionId, callerEmail, multiMember } = opts;
  const runnerFor = opts.runnerFor ?? ((type) => createRunner(projectRoot, type));

  const builder = await storage.getBuilderSession(sessionId);
  // A fleet store serves many projects; another project's row is "not found".
  if (builder && builder.projectRoot === projectRoot) {
    if (multiMember && callerEmail !== builder.memberEmail) {
      return {
        ok: false,
        status: 403,
        message: `Builder session ${sessionId} belongs to ${builder.memberEmail ?? 'no member'}; only its own member may attach to it.`,
      };
    }
    if (builder.state !== 'running' || !builder.containerName) {
      return {
        ok: false,
        status: 409,
        message:
          builder.state === 'ended'
            ? `Builder session ${sessionId} has ended and cannot be attached to.`
            : `Builder session ${sessionId} is ${builder.state}, not running. Start it with startBuilderSession, then attach.`,
      };
    }
    try {
      assertSessionRowActionable(builder);
    } catch (err) {
      return { ok: false, status: 409, message: err instanceof Error ? err.message : String(err) };
    }
    const runner = await runnerFor(undefined);
    if (!runner.usesSandbox()) {
      return {
        ok: false,
        status: 409,
        message: `This project runs on the ${runner.type} runner, which has no container to attach to.`,
      };
    }
    return {
      ok: true,
      target: {
        kind: 'builder',
        sessionId,
        builderSession: builder,
        container: builder.containerName,
        binary: binaryFor(runner),
      },
    };
  }

  const session = await storage.getSession(sessionId);
  const task = session ? await storage.getTask(session.task_id) : null;
  if (!session || !task) {
    return { ok: false, status: 404, message: `Session not found: ${sessionId}` };
  }
  // On a shared daemon a task session is entered AS A MEMBER: the terminal
  // runs in their own container on their own credential
  // (./member-container.ts) and pair's rows name them. A credential naming
  // nobody — a control token — has nobody to bill or name, so it is refused.
  if (multiMember && !callerEmail) {
    return {
      ok: false,
      status: 403,
      message:
        `Session ${sessionId} is a task session. On a shared daemon a task session is entered as a ` +
        `member, and this credential names no member.`,
    };
  }
  // Member terminals and turns take turns with the worktree: while a turn is
  // RUNNING (the binding is live, or the task is working) nobody opens one —
  // the route re-checks this under the task's lifecycle lock
  // (`enterTaskAsMember`, ./member-entry.ts), and a turn launch refuses while a
  // member is in. This early answer is what `attachSession` reports before a
  // socket opens.
  if (multiMember) {
    const binding = await (opts.bindingFor ?? ((id) => getTaskSessionBinding(projectRoot, id)))(task.id);
    if ((binding && binding.revokedAt === null) || task.status === 'working') {
      const owner = binding?.ownerUserId;
      return {
        ok: false,
        status: 409,
        message:
          `Task ${task.code ?? task.id} is running a turn` +
          (owner ? ` on ${owner === SERVICE_CREDENTIAL_USER_ID ? "the project's service" : `${owner}'s`} credential` : '') +
          `. A terminal opens once the turn has ended.`,
      };
    }
    // The entry's other refusal, said early too: a task that has not run a
    // turn has no environment of its own to open yet.
    if (task.status === 'backlog' || (await storage.getSessionTurns(session.id)).length === 0) {
      return {
        ok: false,
        status: 409,
        message: `Task ${task.code ?? task.id} has not run a turn yet. Start it, then open the terminal.`,
      };
    }
  }
  // Only the task's CURRENT session, the one the dashboard shell resolves:
  // planning pair/chat against a superseded record would reach the wrong
  // container or resume a stale agent session.
  const current = await storage.getSessionByTaskId(task.id);
  if (!current || current.id !== session.id) {
    return {
      ok: false,
      status: 409,
      message:
        `Session ${sessionId} is not the current session of task ${task.code ?? task.id}` +
        (current ? ` (that is ${current.id}). Attach to that one instead.` : '.'),
    };
  }
  const runner = await runnerFor(session.runner_type ?? task.runner_type ?? undefined);
  if (!runner.usesSandbox()) {
    return {
      ok: false,
      status: 409,
      message: `Task runs on the ${runner.type} runner, which has no container to enter.`,
    };
  }
  return {
    ok: true,
    target: {
      kind: 'task',
      sessionId,
      task,
      session,
      container: execContainerName(task, session, runner),
      binary: binaryFor(runner),
    },
  };
}

/**
 * Whether the target's container must already be running for an attach.
 * A member's task terminal gets a container of its own, created when it
 * opens, so there is nothing to find running beforehand.
 */
export function attachNeedsRunningContainer(target: SessionAttachTarget, multiMember: boolean): boolean {
  return !(target.kind === 'task' && multiMember);
}

/**
 * The `docker ps` half, asked only on an explicit attach — never on a render.
 * A builder session's container outlives every socket, so "not running" here
 * means the session died underneath its row; it is reported, not restarted.
 */
export async function confirmAttachTargetRunning(
  projectRoot: string,
  target: SessionAttachTarget,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const runnerType = target.kind === 'task'
    ? target.session.runner_type ?? target.task.runner_type ?? undefined
    : undefined;
  const runner = await createRunner(projectRoot, runnerType);
  if (await runner.isRunning(target.container)) return { ok: true };
  return {
    ok: false,
    status: 409,
    message: target.kind === 'builder'
      ? `Container for builder session ${target.sessionId} is not running.`
      : `Container for this task is not running.`,
  };
}

export interface AttachSessionInfo {
  sessionId: string;
  kind: 'builder' | 'task';
  /** Path of the WebSocket route, on this daemon's `/rpc` port. */
  attachPath: string;
  /** Terminal modes the route accepts for this session (`?mode=`). */
  modes: string[];
  container: string;
  taskId?: string;
  /**
   * Task sessions: per-mode reasons the upgrade would be refused for THIS
   * caller right now (absent key = that mode would open). The upgrade stays
   * the authority; this exists because a refused WebSocket reaches a browser
   * with no readable reason, so a client must be able to say it first.
   */
  refusals?: Partial<Record<'shell' | 'pair' | 'chat', string>>;
  /** True when a refusal is the caller having no Claude credential stored. */
  credentialMissing?: boolean;
}

/**
 * The per-mode refusals `attachSession` reports for a task session. Mirrors
 * what the upgrade enforces: another member working in the task, a container
 * runtime member containers cannot run on, container settings that would let a
 * turn see the member's container, the caller having
 * no credential to bill, and pair/chat's own locks and states.
 */
export async function taskModeRefusals(opts: {
  projectRoot: string;
  task: Task;
  callerEmail: string | null;
  multiMember: boolean;
  /** The task's container runtime binary (the attach target's). */
  binary: string;
  deps?: {
    holder?: (taskId: string) => string | null;
    runArgsRefusal?: () => Promise<string | null>;
    credentialMissing?: (email: string) => Promise<boolean>;
    pairOrChat?: typeof pairOrChatRefusal;
    /** Seam for tests: whether the agent's transcript is too large to carry into a member's home. */
    transcriptTooLarge?: (task: Task) => Promise<boolean>;
  };
}): Promise<{ refusals: Partial<Record<'shell' | 'pair' | 'chat', string>>; credentialMissing: boolean }> {
  const { projectRoot, task, callerEmail, multiMember } = opts;
  const deps = opts.deps ?? {};
  const all = (message: string) => ({ shell: message, pair: message, chat: message });
  if (multiMember && callerEmail) {
    const holder = (deps.holder ?? memberTerminalHolder)(task.id);
    if (holder && holder !== callerEmail) return { refusals: all(memberHeldMessage(holder)), credentialMissing: false };
    const runtime = memberRuntimeRefusal(opts.binary);
    if (runtime) return { refusals: all(runtime), credentialMissing: false };
    const runArgs = await (deps.runArgsRefusal ?? (async () => {
      const config = await loadConfig(projectRoot);
      return memberContainerSettingsRefusal(
        config.docker.run_args, config.mounts,
        [...knownRuntimeSocketPaths(), ...(await activeRuntimeSockets(config.runner.type === 'podman' ? 'podman' : 'docker'))],
      );
    }))();
    if (runArgs) return { refusals: all(runArgs), credentialMissing: false };
    // Whatever team mode says: outside it the only credential is the
    // daemon's own, and a member's terminal never falls back to it
    // (../server/member-exec-credential.ts refuses at the upgrade too).
    const missing = await (deps.credentialMissing ?? (async (email: string) =>
      !(await getUserCredential(projectRoot, email))))(callerEmail);
    if (missing) {
      return { refusals: all(memberCredentialMissingMessage(callerEmail)), credentialMissing: true };
    }
  }
  const refusals: Partial<Record<'shell' | 'pair' | 'chat', string>> = {};
  const pairOrChat = deps.pairOrChat ?? pairOrChatRefusal;
  const member = multiMember ? callerEmail : null;
  const pair = await pairOrChat(projectRoot, task, 'pair', member);
  if (pair) refusals.pair = pair;
  const chat = await pairOrChat(projectRoot, task, 'chat', member);
  if (chat) refusals.chat = chat;
  // Pair and Chat resume the agent's conversation in the member's own home,
  // which cannot carry one this large (./member-container.ts). A Shell never
  // reads it, and is not refused for it.
  if (member && (!refusals.pair || !refusals.chat)) {
    const tooLarge = await (deps.transcriptTooLarge ?? (async (t: Task) => {
      const session = await (await getOrCreateStorage()).getSessionByTaskId(t.id);
      return agentTranscriptTooLarge(getWorktreePath(projectRoot, t), session?.agent_session_id);
    }))(task);
    if (tooLarge) {
      const why = "The agent's conversation on this task is too large to open in a terminal of your own. Open a Shell instead.";
      refusals.pair ??= why;
      refusals.chat ??= why;
    }
  }
  return { refusals, credentialMissing: false };
}

/**
 * `attachSession` — discovery for the attach route: which session, where to
 * upgrade, in which modes. With no `id`, the caller's own active builder
 * session. Runs the same resolution and liveness check the upgrade does, so a
 * client learns a refusal before it opens a socket.
 */
export async function handleAttachSession(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<AttachSessionInfo> {
  const storage = await getOrCreateStorage();
  const multiMember = await multiMemberDaemon(projectRoot);
  let callerEmail = actorEmail(params.actor as ActorInput | undefined) ?? null;
  // This is a READ, so the identity gate never stamps the daemon's git
  // identity onto it — but `startBuilderSession` (a write) recorded the row
  // under exactly that identity. On a single-person daemon, resolve it the
  // same way so discovery finds the session; never on a shared daemon, where
  // the person comes from the caller's token and nowhere else. An unset git
  // identity stays null: a read keeps working with none configured.
  if (!callerEmail && !multiMember) {
    const git = await resolveGitIdentity(projectRoot);
    callerEmail = git.configured ? git.identity.email : null;
  }

  let sessionId = typeof params.id === 'string' && params.id ? params.id : null;
  if (!sessionId) {
    const active = await storage.getActiveBuilderSessionForMember(projectRoot, callerEmail);
    if (!active) {
      throw new RpcError(404, 'attachSession: no active builder session for you on this project. Start one with startBuilderSession.');
    }
    sessionId = active.id;
  }

  const resolved = await resolveSessionAttachTarget({
    projectRoot,
    storage,
    sessionId,
    callerEmail,
    multiMember,
  });
  if (!resolved.ok) throw new RpcError(resolved.status, resolved.message);
  // `checkRunning: false` skips the runtime query (`docker ps`) for a
  // client that asks on a page RENDER — the upgrade still checks it. A
  // member's task terminal has nothing to check: its container is its own,
  // created when it opens.
  if (params.checkRunning !== false && attachNeedsRunningContainer(resolved.target, multiMember)) {
    const running = await confirmAttachTargetRunning(projectRoot, resolved.target);
    if (!running.ok) throw new RpcError(running.status, running.message);
  }

  const { target } = resolved;
  const preflight = target.kind === 'task'
    ? await taskModeRefusals({ projectRoot, task: target.task, callerEmail, multiMember, binary: target.binary })
    : null;
  return {
    sessionId: target.sessionId,
    kind: target.kind,
    attachPath: sessionAttachPath(target.sessionId),
    modes: target.kind === 'builder' ? ['attach'] : ['shell', 'pair', 'chat'],
    container: target.container,
    ...(target.kind === 'task' ? { taskId: target.task.id } : {}),
    ...(preflight ? { refusals: preflight.refusals, credentialMissing: preflight.credentialMissing } : {}),
  };
}
