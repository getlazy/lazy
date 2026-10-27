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
 *   control token) is refused (403). A running turn refuses nobody: a member
 *   and the agent work the worktree at the same time (./member-entry.ts).
 * - A COMMIT RUN (`run:<id>`, ./commit-run.ts). The target is the run's own
 *   container, named from its slug, and a Shell is the only mode. Unlike a
 *   task's, it is entered directly — not through a member container — because
 *   a member container exists to keep a member's credential away from an
 *   agent's processes, and a run's container holds no credential and runs no
 *   agent. Like its services, it is shared: what one person starts in it the
 *   others see.
 */

import type { Storage } from '../storage';
import { terminalEngineOf } from '../runner/container-cli';
import type { BuilderSession, CommitRun } from '../storage/types';
import { RUN_ATTACH_PREFIX, runContainerName } from '../run/identity';
import type { Session, Task, ActorInput } from '../types';
import type { Runner, RunnerType } from '../runner';
import { createInspectionRunner } from '../runner';
import { execContainerName } from '../server/shell-ws';
import { assertSessionRowActionable, multiMemberDaemon, probeBuilderRun, settleDeadBuilderSessions } from './builder-sessions';
import { RpcError } from './rpc-error';
import { logger } from '../utils/logger';
import { actorEmail } from '../actor-ref';
import { resolveGitIdentity } from '../identity/git-identity';
import { getOrCreateStorage } from './rpc-handlers';
import { memberCredentialMissingMessage, memberTerminalCredentialProblem, memberTerminalProfile } from '../server/member-exec-credential';
import { memberContainerSettingsRefusal, memberRuntimeRefusal, agentTranscriptTooLarge, knownRuntimeSocketPaths, activeRuntimeSockets } from './member-container';
import { getWorktreePath } from '../task/identity';
import { loadConfig } from '../config/loader';
import { profileForAgentNameOrNull } from '../config/agent-profiles';
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
      /** The runner's own Engine API socket (smolvm: the relay); unset → the client's engine. */
      engineSocket?: string;
    }
  | {
      kind: 'run';
      sessionId: string;
      run: CommitRun;
      container: string;
      binary: string;
      engineSocket?: string;
    };

export type SessionAttachResolution =
  | { ok: true; target: SessionAttachTarget }
  | { ok: false; status: number; message: string };

type RunnerView = Pick<Runner, 'type' | 'usesSandbox' | 'runNameForTask'>;

export interface ResolveSessionAttachOptions {
  projectRoot: string;
  storage: Pick<Storage, 'getBuilderSession' | 'getSession' | 'getTask' | 'getSessionByTaskId' | 'getSessionTurns' | 'getCommitRun'>;
  sessionId: string;
  /** The person the CALLER's credential names, or null when it names nobody. */
  callerEmail: string | null;
  /**
   * Whether other members can exist on this daemon — managed mode OR team
   * mode ({@link multiMemberDaemon}). Enforces builder-session ownership and
   * requires a named member for a task session.
   */
  multiMember: boolean;
  /** Seam for tests; defaults to the project's configured runner. */
  runnerFor?: (runnerType: RunnerType | undefined) => Promise<RunnerView>;
  /**
   * `tmux`: the attach is to one of the task container's named tmux sessions
   * (src/sessions/tmux.ts), not a terminal of the caller's own, so the
   * member-terminal entry check below does not apply to it; the route checks
   * the task's container is running instead. Every other check does.
   */
  purpose?: 'terminal' | 'tmux';
}

function binaryFor(runner: RunnerView): string {
  return terminalEngineOf(runner).binary;
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
  const runnerFor = opts.runnerFor ?? ((type) => createInspectionRunner(projectRoot, type));

  if (sessionId.startsWith(RUN_ATTACH_PREFIX)) {
    const run = await storage.getCommitRun(sessionId.slice(RUN_ATTACH_PREFIX.length));
    if (!run) return { ok: false, status: 404, message: `Run not found: ${sessionId}` };
    const runner = await runnerFor(undefined);
    if (!runner.usesSandbox()) {
      return { ok: false, status: 409, message: `This project runs on the ${runner.type} runner, which has no container to enter.` };
    }
    return {
      ok: true,
      target: { kind: 'run', sessionId, run, container: runContainerName(projectRoot, run.slug), ...terminalEngineOf(runner) },
    };
  }

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
            : builder.state === 'stopped'
              ? `Your builder is stopped. ${BUILDER_RESUME_HINT}`
              : `Your builder is still starting. Try again in a moment.`,
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
        message: `Builders can't run on this project's setup.`,
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
  // The entry's refusal, said early: a task that has not run a turn has no
  // environment of its own to open yet. A running turn is NOT a refusal. A tmux
  // attach checks its target container is running instead.
  if (multiMember && opts.purpose !== 'tmux') {
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
      ...terminalEngineOf(runner),
    },
  };
}

/**
 * Whether the target's container must already be running for an attach.
 * A member's task terminal gets a container of its own, created when it
 * opens, so there is nothing to find running beforehand.
 */
/** Where a stopped builder is resumed, for every refusal that names one. */
export const BUILDER_RESUME_HINT = 'Resume it with Resume on its page under Builders, or with `lazy builder`.';

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
  const runner = await createInspectionRunner(projectRoot, runnerType);
  if (target.kind === 'builder') {
    // Three-way: a runtime that did not answer is not a dead builder, and the
    // refusal must say which it was — the two used to read identically.
    const probe = await probeBuilderRun(runner, target.container);
    if (probe.state === 'running') return { ok: true };
    if (probe.state === 'unknown') {
      logger.warn(`Attach to builder session ${target.sessionId}: liveness unknown: ${probe.reason}`);
      return {
        ok: false,
        status: 503,
        message: 'Could not check whether your builder is running right now. Try again in a moment.',
      };
    }
    // Record what the listings will say from now on (stopped, with how it
    // ended), so the badge never keeps saying "Running" beside this refusal.
    await settleDeadBuilderSessions(projectRoot);
    const storage = await getOrCreateStorage();
    const now = await storage.getBuilderSession(target.sessionId);
    const how = now?.lastExit ? ` ${now.lastExit.split('\n')[0]}` : '';
    return {
      ok: false,
      status: 409,
      message: `Your builder is not running any more.${how} ${BUILDER_RESUME_HINT}`,
    };
  }
  if (await runner.isRunning(target.container)) return { ok: true };
  return {
    ok: false,
    status: 409,
    message: target.kind === 'run'
      ? "This run's container is not running. Run services (or Start container) starts it."
      : `Container for this task is not running.`,
  };
}

export interface AttachSessionInfo {
  sessionId: string;
  kind: 'builder' | 'task' | 'run';
  /** Path of the WebSocket route, on this daemon's `/rpc` port. */
  attachPath: string;
  /** Terminal modes the route accepts for this session (`?mode=`). */
  modes: string[];
  container: string;
  taskId?: string;
  runId?: string;
  /**
   * Task sessions: per-mode reasons the upgrade would be refused for THIS
   * caller right now (absent key = that mode would open). The upgrade stays
   * the authority; this exists because a refused WebSocket reaches a browser
   * with no readable reason, so a client must be able to say it first.
   */
  refusals?: Partial<Record<'shell' | 'pair' | 'chat' | 'ssh', string>>;
  /** True when a refusal is the caller having no Claude credential stored. */
  credentialMissing?: boolean;
}

/**
 * The per-mode refusals `attachSession` reports for a task session. Mirrors
 * what the upgrade enforces: a container
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
    const problem = deps.credentialMissing
      ? (await deps.credentialMissing(callerEmail) ? memberCredentialMissingMessage(callerEmail) : null)
      : await memberTerminalCredentialProblem(projectRoot, callerEmail, await memberTerminalProfile(projectRoot, task.agent_id));
    if (problem) return { refusals: all(problem), credentialMissing: true };
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
      const harness = profileForAgentNameOrNull(await loadConfig(projectRoot), t.agent_id)?.harness ?? 'claude-code';
      return agentTranscriptTooLarge(getWorktreePath(projectRoot, t), session?.agent_session_id, harness);
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
    // A member may run several builders: with no id, the answer is their one
    // running builder (or their one not-ended session), and more than one is
    // a question for the caller, never a pick made here.
    const mine = (await storage.listBuilderSessions(projectRoot))
      .filter((s) => s.memberEmail === callerEmail && s.state !== 'ended');
    const live = mine.filter((s) => s.state === 'running' || s.state === 'starting');
    const only = live.length === 1 ? live[0] : live.length === 0 && mine.length === 1 ? mine[0] : null;
    if (!only) {
      if (mine.length === 0) {
        throw new RpcError(404, 'attachSession: no active builder session for you on this project. Start one with startBuilderSession.');
      }
      throw new RpcError(
        409,
        `attachSession: you have ${live.length || mine.length} builder sessions on this project ` +
        `(${(live.length ? live : mine).map((s) => s.id).join(', ')}); name the one to attach to.`,
      );
    }
    sessionId = only.id;
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
    modes: target.kind === 'builder' ? ['attach'] : target.kind === 'run' ? ['shell'] : ['shell', 'pair', 'chat', 'ssh'],
    container: target.container,
    ...(target.kind === 'task' ? { taskId: target.task.id } : {}),
    ...(target.kind === 'run' ? { runId: target.run.id } : {}),
    // SSH lands where the Shell lands, under the same rules.
    ...(preflight ? {
      refusals: { ...preflight.refusals, ...(preflight.refusals.shell ? { ssh: preflight.refusals.shell } : {}) },
      credentialMissing: preflight.credentialMissing,
    } : {}),
  };
}

export interface SshHostKeyInfo {
  /** `ssh-ed25519 AAAA…` — the key the caller's SSH connections to this task present. */
  hostKey: string;
  /** The login name every lazy SSH config uses. */
  user: string;
  taskId: string;
}

/**
 * `sshHostKey` — the public half of the stable host key an SSH connection to
 * this task presents to THE CALLER (one per member on a shared daemon, one per
 * task solo; ../ssh/host-keys.ts), made on first ask. Resolved exactly as an
 * attach is, so a caller who could not connect is not handed a key either.
 */
export async function handleSshHostKey(projectRoot: string, params: Record<string, unknown>): Promise<SshHostKeyInfo> {
  const sessionId = typeof params.id === 'string' && params.id ? params.id : null;
  if (!sessionId) throw new RpcError(400, 'sshHostKey: id (a task session id) is required.');
  const storage = await getOrCreateStorage();
  const multiMember = await multiMemberDaemon(projectRoot);
  const callerEmail = actorEmail(params.actor as ActorInput | undefined) ?? null;
  const resolved = await resolveSessionAttachTarget({ projectRoot, storage, sessionId, callerEmail, multiMember });
  if (!resolved.ok) throw new RpcError(resolved.status, resolved.message);
  if (resolved.target.kind !== 'task') throw new RpcError(400, 'sshHostKey: SSH opens into a task session only.');
  const { ensureSshHostKey } = await import('../ssh/host-keys');
  const { SSH_LOGIN_USER } = await import('../ssh/keys');
  const pair = await ensureSshHostKey(projectRoot, resolved.target.task.id, multiMember ? callerEmail : null);
  return { hostKey: pair.publicKey, user: SSH_LOGIN_USER, taskId: resolved.target.task.id };
}
