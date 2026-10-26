/**
 * Session attach: a terminal reaches a daemon-owned session over an
 * AUTHENTICATED route that is not the dashboard's.
 *
 * Route: `GET /rpc/sessions/:id/attach/ws`, with `Authorization: Bearer <actor
 * token>` and `X-Lazy-Project: <root>` — the `/rpc/*` credentials, checked by
 * `resolveRpcActor` exactly as every other `/rpc/*` request is. The dashboard's
 * shell (`/tasks/:id/shell/ws`, ./shell-ws.ts) answers 404 in managed mode by
 * design, and stays exactly as it is for local installs; this route is what a
 * Teams relay and the CLI use instead. A browser never reaches it: it cannot
 * set an Authorization header on an upgrade, and no browser holds a daemon
 * credential. See docs/design/actor-identity-and-remote-clients.md §5.3.
 *
 * NOTHING HERE IS A SECOND TERMINAL TRANSPORT. Framing is ./shell-protocol.ts,
 * the relay is the web shell's own handler (`createShellRelayHandler`, over
 * `ExecStream`), and a task session's shell/pair/chat planning, locks and
 * 30-second grace are ./shell-pair.ts. Only the gate and the target resolution
 * are this module's.
 *
 * On a shared daemon a task session is entered AS the member whose token
 * opened it, and NEVER in the task's own container: the exec lands in a
 * container of the member's own, built from the task's image on the task's
 * worktree and carrying only their credential (src/daemon/member-container.ts),
 * and pair's rows name them.
 *
 * The exec target has NO client-derived input: it is resolved from the session
 * record by `resolveSessionAttachTarget` (src/daemon/session-attach.ts), and a
 * session the caller does not own is a 403. Pinned by
 * test/unit/session-attach-target.test.ts.
 */

import type { Server } from 'bun';
import type { Storage } from '../storage';
import type { RpcAuthResult } from '../daemon/rpc-auth';
import { rpcAuthErrorMessage } from '../daemon/rpc-auth';
import type { WebSocketUpgrader, UpgradeOutcome } from './ws';
import { decodePathSegment } from './task-urls';
import { createShellRelayHandler, clampDim, refusal, SHELL_CMD, tryResumeUpgrade, endDetachedTerminals, type ShellSocketData } from './shell-ws';
import { parseShellSessionMode, planPairOrChatExec, type PairExecPlan } from './shell-pair';
import {
  resolveSessionAttachTarget,
  confirmAttachTargetRunning,
  attachNeedsRunningContainer,
  taskModeRefusals,
  type ResolveSessionAttachOptions,
  type SessionAttachTarget,
} from '../daemon/session-attach';
import { attachSessionArgv, isValidSessionName } from '../sessions/tmux';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  memberTerminalContainer,
  markMemberTerminalAttached,
  MEMBER_VACATING_MESSAGE,
  ABANDONED_LAUNCH,
  type HeldContainer,
} from './member-terminals';
import { enterTaskAsMember } from '../daemon/member-entry';
import { launchMemberContainer, memberContainerRunning } from '../daemon/member-container';
import { memberTerminalProfile } from './member-exec-credential';
import { logger } from '../utils/logger';
import { parseShellSessionName, shellSessionCommand } from '../terminal/shell-session';
import { listTaskSessions, withTimeout, type TaskSessionsDeps } from '../daemon/task-sessions';

/** The most a shell's entry notice may add to opening it. */
export const ENTRY_NOTICE_TIMEOUT_MS = 3_000;
import { presenceNotice } from '../sessions/presence';

/**
 * The one-line "who else is here" a shell shows on entry, or null. A notice
 * that cannot be read is logged and left out: it never stops the terminal.
 */
export async function presenceEntryNotice(
  root: string,
  storage: Storage,
  taskId: string,
  viewer: string | null,
  opts: { deps?: TaskSessionsDeps; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    // Bounded: it runs before the terminal's upgrade is answered, and Lazy
    // Teams' relay waits only seconds for that answer.
    const list = await withTimeout(
      listTaskSessions(root, { taskId }, { getStorage: async () => storage, ...opts.deps }),
      opts.timeoutMs ?? ENTRY_NOTICE_TIMEOUT_MS,
      'who else is in the task',
    );
    return presenceNotice({ task: list.task, members: list.members, sessions: list.running ? list.sessions : null, agent: list.agent }, { viewer });
  } catch (err) {
    logger.warn(`shell entry notice for task ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
import { getWorktreePath } from '../task/identity';
import { sshdExecCommand, sshdExecEnv } from '../ssh/sshd-command';
import { ensureSshHostKey } from '../ssh/host-keys';
import { soloAuthorizedKeys } from '../ssh/local-files';
import { parseAuthorizedKeysHeader, SSH_AUTHORIZED_KEYS_HEADER } from '../ssh/connection';
import { declaredServices, mintForwardGrant, revokeForwardGrant, serviceHostNames } from '../ssh/service-forward';
import { daemonMcpTarget } from '../daemon/task-launcher';

import { DEFAULT_TERM_COLS, DEFAULT_TERM_ROWS, MAX_TERM_COLS, MAX_TERM_ROWS } from './shell-protocol';

/** What a member's terminal reads when their environment could not be made. */
export const MEMBER_LAUNCH_FAILED_MESSAGE =
  'Your terminal environment for this task could not be started. Try again, and if it keeps failing ask your administrator.';

/**
 * How long a member's terminal may wait with NO progress from its container
 * launch before it is answered with an error. Everything slow in image
 * resolution narrates through `ensureImage`'s notify: each build line and the
 * build's 20-second "still building … (elapsed)" heartbeat — for the project
 * image and for a base image built first — and a 20-second heartbeat while it
 * waits behind another caller's build of the same image. So only a launch that
 * genuinely says nothing for this long ends here; a build that hangs keeps
 * showing its elapsed time instead, because builds are unbounded by policy.
 */
export const MEMBER_PREPARE_STALL_MS = 10 * 60_000;

export const MEMBER_PREPARE_STALLED_MESSAGE =
  'Preparing your terminal environment stopped making progress. Try again, and if it keeps happening ask your administrator.';

type MemberPrepared =
  | { ok: true; container: string; plan: PairExecPlan | null; env: string[]; onStarted: () => Promise<void> }
  | { ok: false; message: string; detail?: string };

export const SESSION_ATTACH_WS_PATH_RE = /^\/rpc\/sessions\/([^/]+)\/attach\/ws$/;

export interface SessionAttachUpgraderDeps {
  getStorage: () => Promise<Storage>;
  root: string;
  /** The `/rpc/*` actor resolution for a request — `resolveRpcActor` in production. */
  authenticate: (req: Request) => Promise<RpcAuthResult>;
  /** Whether other members can exist — `multiMemberDaemon` in production. */
  multiMember: () => Promise<boolean>;
  /** Liveness seam for tests; defaults to `confirmAttachTargetRunning` (`docker ps`). */
  confirmRunning?: typeof confirmAttachTargetRunning;
  /** Runner seam for tests; see ResolveSessionAttachOptions.runnerFor. */
  runnerFor?: ResolveSessionAttachOptions['runnerFor'];
  /** Member-entry seam for tests; defaults to `enterTaskAsMember`. */
  enterAsMember?: typeof enterTaskAsMember;
  /** Member preflight seam for tests; defaults to `taskModeRefusals`. */
  /** The one-line "who else is here" a shell shows on entry; defaults to {@link presenceEntryNotice}. */
  entryNotice?: (root: string, storage: Storage, taskId: string, viewer: string | null) => Promise<string | null>;
  memberPreflight?: typeof taskModeRefusals;
  /** The member's own container; defaults to `launchMemberContainer`. */
  launchMemberContainer?: (opts: Parameters<typeof launchMemberContainer>[0]) => Promise<
    { ok: true; container: HeldContainer } | { ok: false; status: number; message: string }
  >;
  /** Pair/Chat planner seam for tests; defaults to `planPairOrChatExec`. */
  planPairOrChat?: typeof planPairOrChatExec;
  /** Liveness of a reused member container; defaults to `docker ps`. */
  memberContainerRunning?: (container: HeldContainer) => Promise<boolean>;
  /** What runs when a member's last terminal has gone; defaults to removing their container. */
  onMemberVacate?: (container: HeldContainer | null) => Promise<void>;
  /** Grace seam for tests; defaults to MEMBER_VACATE_GRACE_MS. */
  memberGraceMs?: number;
  /** Stall seam for tests; defaults to MEMBER_PREPARE_STALL_MS. */
  memberPrepareStallMs?: number;
  /**
   * The web port this daemon bound, which a member's SSH service forwards dial
   * back on (`host.docker.internal:<port>`). Read from the daemon's memory;
   * null (or unset, as in tests) before the bind: forwards are then not offered.
   */
  webPort?: () => number | null;
  /** Solo SSH keys seam for tests; defaults to the daemon user's `~/.lazy/ssh` files. */
  soloAuthorizedKeys?: typeof soloAuthorizedKeys;
}

export function createSessionAttachUpgrader(deps: SessionAttachUpgraderDeps): WebSocketUpgrader {
  return {
    handler: createShellRelayHandler(),

    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const url = new URL(req.url);
      const match = SESSION_ATTACH_WS_PATH_RE.exec(url.pathname);
      if (!match) return null;

      // Authentication FIRST, the same gate and the same answers as /rpc/*:
      // the upgrader runs ahead of the HTTP handler, so it must apply that
      // gate itself or this would be an unauthenticated /rpc route.
      const auth = await deps.authenticate(req);
      if (!auth.ok) {
        return Response.json({ error: rpcAuthErrorMessage(auth.failure) }, { status: 401 });
      }
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== deps.root) {
        return Response.json(
          { error: `Project mismatch: daemon serves ${deps.root}, request is for ${reqProject}` },
          { status: 400 },
        );
      }
      if (req.method !== 'GET') return refusal(405, 'Method not allowed');

      const attachStarted = Date.now();
      const sessionId = decodePathSegment(match[1]);
      const storage = await deps.getStorage();
      // The PERSON comes from the token, never from the request.
      const caller = auth.actor.kind === 'user' ? auth.actor : null;
      const multiMember = await deps.multiMember();
      // `?tmux=<name>`: attach to one of the task container's named tmux
      // sessions (src/sessions/tmux.ts) — its services, a long-running command
      // — instead of opening a terminal of one's own. `&readonly=1` watches
      // without typing (`attach -r`).
      const tmuxName = url.searchParams.get('tmux');
      const resolved = await resolveSessionAttachTarget({
        purpose: tmuxName !== null ? 'tmux' : 'terminal',
        projectRoot: deps.root,
        storage,
        sessionId,
        callerEmail: caller?.email ?? null,
        multiMember,
        runnerFor: deps.runnerFor,
      });
      if (!resolved.ok) return refusal(resolved.status, resolved.message);
      const { target } = resolved;

      const requestedMode = url.searchParams.get('mode');
      if (target.kind === 'builder' && requestedMode !== null && requestedMode !== 'attach') {
        return refusal(400, `A builder session is attached to, not entered in "${requestedMode}" mode. Omit ?mode.`);
      }
      // A commit run's container is entered with a shell, and only a shell:
      // there is no agent in it to pair or chat with.
      if (target.kind === 'run' && requestedMode !== null && requestedMode !== 'shell') {
        return refusal(400, `A run is entered with a shell, not in "${requestedMode}" mode.`);
      }
      // SSH lands in a TASK's environment only, exactly where its Shell lands.
      const ssh = requestedMode === 'ssh';
      if (ssh && target.kind !== 'task') return refusal(400, 'SSH opens into a task session only.');

      if (tmuxName !== null) {
        return attachTmuxSession({ req, server, url, deps, target, tmuxName, requestedMode, multiMember, caller });
      }

      // A reattach after a dropped connection goes back to the terminal it
      // names, which is still running — before the claim and the planning
      // below, which would refuse it (it still holds both) or start another.
      // The owner carries the person, so only whoever opened it gets it back.
      const owner = `attach:${target.kind}:${sessionId}:${requestedMode ?? ''}:${caller?.email ?? ''}`;
      const resumed = tryResumeUpgrade(req, server, url, owner, { freshOnMiss: target.kind === 'builder' });
      if (resumed) return resumed;
      if (requestedMode === 'pair' || requestedMode === 'chat') endDetachedTerminals(owner);

      // A member's task terminal needs nothing running beforehand: its
      // container is its own, created below.
      if (attachNeedsRunningContainer(target, multiMember)) {
        const running = await (deps.confirmRunning ?? confirmAttachTargetRunning)(deps.root, target);
        if (!running.ok) return refusal(running.status, running.message);
      }

      const cols = clampDim(url.searchParams.get('cols'), DEFAULT_TERM_COLS, MAX_TERM_COLS);
      const rows = clampDim(url.searchParams.get('rows'), DEFAULT_TERM_ROWS, MAX_TERM_ROWS);

      // What the exec reaches. For a member on a shared daemon this becomes
      // their OWN container — never the task's.
      let execTarget = target.container;
      let cmd = SHELL_CMD;
      let env = ['TERM=xterm-256color'];
      let onClose: (() => void) | null = null;
      let abort: (() => void) | null = null;
      // A member's own container, made after the upgrade (see below).
      let memberLaunch: ((status: (message: string) => void, abandoned: () => boolean) => Promise<MemberPrepared>) | null = null;
      // Releases this terminal's claim on the task (members only; once).
      let releaseClaim: (() => void) | null = null;
      // `?mode=ssh`: the bounds and audit this connection carries (below).
      let sshConnection: ShellSocketData['ssh'] = undefined;
      // The service-forward grant this connection holds, revoked when it ends.
      let sshForwardToken: string | null = null;
      if (target.kind === 'task') {
        // SSH is a Shell in every respect but its command: same container,
        // same claim and preflight, same credential (docs/design/task-sessions-and-ssh.md §5).
        const mode = ssh ? 'shell' : parseShellSessionMode(requestedMode);
        // A person's shell is the `shell` tmux session of the container it
        // lands in, so a reconnect finds what they left running
        // (../terminal/shell-session.ts).
        // On a shared daemon the terminal runs AS the attaching member —
        // billed to them, and pair's rows name them. Locally the single person
        // is the daemon's own, exactly as the dashboard shell.
        const member = multiMember && caller
          ? { email: caller.email, ...(caller.name ? { name: caller.name } : {}) }
          : null;
        if (mode === 'shell' && !ssh) {
          const name = parseShellSessionName(url.searchParams.get('session'));
          if (!name) return refusal(400, 'session must be lowercase letters, digits and dashes (at most 32).');
          // Who else is in the task, shown once tmux has the screen — every
          // terminal that opens a shell comes through here (Teams, the
          // dashboard, a Teams-linked `lazy shell`), so the person entering is
          // left out by who the daemon authenticated, not by what a client says.
          cmd = shellSessionCommand(name, await (deps.entryNotice ?? presenceEntryNotice)(deps.root, storage, target.task.id, member?.email ?? null));
        }
        // The resolver already refused a nameless caller on a shared daemon;
        // restated here because the fallback below is the TASK's container,
        // which a shared daemon must never hand a terminal.
        if (multiMember && !member) return refusal(403, 'A task terminal on a shared daemon is opened as a member.');
        if (ssh) {
          // Which keys may log in: on a shared daemon the ones Lazy Teams
          // holds for THIS member, sent by its relay; solo, the daemon's own
          // user's lazy key files — never anything the SSH client sends.
          const keys = multiMember
            ? parseAuthorizedKeysHeader(req.headers.get(SSH_AUTHORIZED_KEYS_HEADER))
            : await (deps.soloAuthorizedKeys ?? soloAuthorizedKeys)();
          if (!keys.ok) return refusal(400, keys.error);
          if (keys.keys.length === 0) {
            return refusal(400, multiMember
              ? 'You have no SSH keys registered. Run `lazy shell <task> --ssh-config --install`, or add one under Account settings → SSH keys.'
              : 'No SSH key to accept. Run `lazy shell <task> --ssh-config --install` first.');
          }
          let hostKey;
          try {
            hostKey = await ensureSshHostKey(deps.root, target.task.id, member?.email ?? null);
          } catch (err) {
            return refusal(500, `Could not read this task's SSH host key: ${err instanceof Error ? err.message : String(err)}`);
          }
          // A member's container cannot reach the task's published ports
          // itself: while this connection lives it gets a forwarder and a
          // grant for them (../ssh/service-forward.ts). Solo, the services are
          // on the task container's own loopback already.
          let forward: Parameters<typeof sshdExecEnv>[0]['forward'];
          if (member) {
            const services = await declaredServices(deps.root);
            const webPort = deps.webPort?.() ?? null;
            if (services.length > 0 && webPort !== null) {
              const token = mintForwardGrant({ taskId: target.task.id, memberEmail: member.email });
              sshForwardToken = token;
              forward = {
                url: daemonMcpTarget(webPort),
                token,
                ports: services.map((s) => s.port),
                hosts: serviceHostNames(services),
              };
            }
          }
          cmd = sshdExecCommand();
          env = sshdExecEnv({
            hostKey: hostKey.privateKey,
            authorizedKeys: keys.keys.map((k) => k.line),
            workdir: getWorktreePath(deps.root, target.task),
            forward,
            // Built here, from the member the daemon authenticated, and left out.
            notice: await (deps.entryNotice ?? presenceEntryNotice)(deps.root, storage, target.task.id, member?.email ?? null),
          });
          sshConnection = {
            who: member?.email ?? 'local user',
            task: target.task.code ?? target.task.id.slice(0, 8),
          };
        }
        // Everything acquired from here on is undone if ANY later step refuses
        // or throws: the claim, pair/chat's locks. A leaked claim would keep
        // this member counted as inside — holding off the task's teardown —
        // until the daemon restarted.
        const undo: Array<() => void> = [];
        if (sshForwardToken) {
          const t = sshForwardToken;
          undo.push(() => revokeForwardGrant(t));
        }
        // The member's container is removed once their last terminal has gone
        // (after the grace): every process they left running in it dies with
        // it, and its credential is revoked. A removal that fails THROWS, so
        // the hold stays and the removal is retried (./member-terminals.ts).
        const vacate = deps.onMemberVacate ?? (async (container: HeldContainer | null) => {
          if (container) await container.remove();
        });
        const undoAll = () => {
          for (const u of undo.reverse()) {
            try {
              u();
            } catch (err) {
              // Already refusing; one failed undo must not skip the rest.
              logger.warn(`terminal refusal cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          undo.length = 0;
        };
        const fail = (status: number, message: string) => {
          undoAll();
          return refusal(status, message);
        };
        try {
          if (member) {
            // Each member has their own hold; any number may be inside (./member-terminals.ts).
            const claimed = claimMemberTerminal(target.task.id, member.email, vacate);
            if (!claimed.ok) {
              return refusal(409, MEMBER_VACATING_MESSAGE);
            }
            // Released exactly once per terminal, whichever path gets there first:
            // a refusal, a failed or stalled launch, the client closing while its
            // container is still being made, or the socket's own close. Releasing
            // twice would count down ANOTHER of this member's terminals.
            let claimReleased = false;
            releaseClaim = () => {
              if (claimReleased) return;
              claimReleased = true;
              releaseMemberTerminal(target.task.id, member.email, vacate, deps.memberGraceMs);
            };
            undo.push(releaseClaim);
            // EVERY CHECK THAT CAN REFUSE runs before the entry, which marks
            // her inside the task from the moment it succeeds: a Pair on an
            // agent that cannot pair, a Chat on a working task, or a member
            // with no credential must not hold anything. Same rules the page
            // preflight shows (`taskModeRefusals`), against a fresh read.
            const freshTask = (await storage.getTask(target.task.id)) ?? target.task;
            const pre = await (deps.memberPreflight ?? taskModeRefusals)({
              projectRoot: deps.root,
              task: freshTask,
              callerEmail: member.email,
              multiMember: true,
              binary: target.binary,
            });
            const preRefusal = pre.refusals[mode];
            if (preRefusal) return fail(pre.credentialMissing ? 400 : 409, preRefusal);
            // Under the task's lifecycle lock, so a teardown starting now sees
            // the member inside. Turns are neither checked nor held off.
            const entered = await (deps.enterAsMember ?? enterTaskAsMember)({
              projectRoot: deps.root,
              storage,
              taskId: target.task.id,
              email: member.email,
            });
            if (!entered.ok) return fail(entered.status, entered.message);
            // The member's own container: created for their first terminal,
            // joined by every later one while the hold lasts. It is made
            // AFTER the upgrade is answered (`prepare`, run by the relay
            // handler on open): resolving its image is a build or a pull —
            // minutes after an upgrade replaced the VM — and a relay in front
            // of this daemon waits a bounded time for the 101. Until then the
            // socket is told what is happening in `status` frames, and a
            // launch that fails is its `error` frame. A dead session is still
            // refused above, as an HTTP answer a CLI can read.
            // Nothing is exec'd until then — least of all the TASK's container.
            execTarget = '';
            const launch = deps.launchMemberContainer ?? launchMemberContainer;
            const stallMs = deps.memberPrepareStallMs ?? MEMBER_PREPARE_STALL_MS;
            memberLaunch = async (report, closed) => {
              // Bounded by SILENCE, not by total time: image builds are
              // unbounded by lazy's policy and narrate every line plus a
              // heartbeat, so a long build that is alive keeps this open,
              // while one that has stopped saying anything ends in an error
              // frame instead of "Preparing…" forever.
              let stalled = false;
              let stallTimer: ReturnType<typeof setTimeout> | null = null;
              let onStall: (() => void) | null = null;
              const stall = new Promise<MemberPrepared>((resolve) => {
                onStall = () => {
                  stalled = true;
                  undoAll();
                  logger.warn(`member terminal preparation for task ${target.task.id.substring(0, 8)} made no progress for ${Math.round(stallMs / 1000)}s`);
                  resolve({
                    ok: false,
                    message: MEMBER_PREPARE_STALLED_MESSAGE,
                    detail: `no progress from the container launch for ${Math.round(stallMs / 1000)}s`,
                  });
                };
              });
              const arm = () => {
                if (stallTimer) clearTimeout(stallTimer);
                stallTimer = setTimeout(() => onStall?.(), stallMs);
              };
              const status = (message: string) => {
                if (stalled) return;
                arm();
                report(message);
              };
              // Nothing more is done for a terminal nobody is waiting on: a
              // client that left, or a preparation already answered as stalled.
              const abandoned = () => stalled || closed();
              status('Preparing your terminal environment…');
              try {
                return await Promise.race([work(status, abandoned), stall]);
              } finally {
                if (stallTimer) clearTimeout(stallTimer);
              }
            };
            const work = async (status: (message: string) => void, abandoned: () => boolean): Promise<MemberPrepared> => {
              let launchRefusal: { status: number; message: string } | null = null;
              try {
                const container = await memberTerminalContainer(
                  target.task.id,
                  member.email,
                  async () => {
                    const launched = await launch({
                      projectRoot: deps.root,
                      storage,
                      task: freshTask,
                      session: target.session,
                      memberEmail: member.email,
                      binary: target.binary,
                      notify: (detail) => status(`Preparing your terminal: ${detail}…`),
                    });
                    if (!launched.ok) {
                      launchRefusal = launched;
                      throw new Error(launched.message);
                    }
                    return launched.container;
                  },
                  deps.memberContainerRunning ?? ((c) => memberContainerRunning(c.binary, c.name)),
                );
                // A reused container too: the guest daemon keeps writing into
                // the worktree as root (a sync merge, a restore creating log/),
                // so ownership is re-aligned on EVERY attach, before the shell.
                // A failure is the terminal's to survive: the shell still opens.
                try {
                  if (container.adopt && !abandoned()) {
                    // Narrated: preparation is bounded by silence, and a chown
                    // over a large worktree must not read as a stall.
                    status('Preparing your terminal: checking file ownership…');
                    await container.adopt();
                  }
                } catch (err) {
                  logger.warn(`member terminal for task ${target.task.id.substring(0, 8)} could not take ownership of the worktree: ${err instanceof Error ? err.message : String(err)}`);
                }
                // A container a previous daemon made still names that daemon's
                // proxy port; every exec carries the live one (Shell, Pair, Chat).
                let execEnv: string[] = [];
                if (container.execEnv) {
                  try {
                    execEnv = await container.execEnv(mode === 'shell' ? undefined : await memberTerminalProfile(deps.root, freshTask.agent_id));
                  } catch (err) {
                    undoAll();
                    return { ok: false, message: `Could not prepare your terminal credentials: ${err instanceof Error ? err.message : String(err)}` };
                  }
                }
                // Prepare the member's tools only once their container exists.
                // A failed or abandoned launch must not mint MCP authority or
                // spend a usage-pause override. Members take no task-wide lock.
                if (mode !== 'shell' && !abandoned()) {
                  const planned = await (deps.planPairOrChat ?? planPairOrChatExec)({
                    root: deps.root,
                    storage,
                    task: target.task,
                    session: target.session,
                    mode,
                    member,
                    memberMcpDirectory: container.mcpDirectory,
                  });
                  if (abandoned()) {
                    if (planned.ok) planned.plan.abort();
                    return { ok: false, message: 'The terminal connection ended while its tools were being prepared.' };
                  }
                  if (!planned.ok) {
                    undoAll();
                    return { ok: false, message: planned.message };
                  }
                  return { ok: true, container: container.name, plan: planned.plan, env: execEnv, onStarted: () => markMemberTerminalAttached(target.task.id, member.email, container) };
                }
                return { ok: true, container: container.name, plan: null, env: execEnv, onStarted: () => markMemberTerminalAttached(target.task.id, member.email, container) };
              } catch (err) {
                undoAll();
                const r = launchRefusal as { status: number; message: string } | null;
                // A refusal the member can act on is theirs to read as it is;
                // what failed underneath is for god mode (the relay withholds
                // `detail` from everyone else).
                if (r && r.status < 500) return { ok: false, message: r.message };
                const detail = r ? r.message : (err instanceof Error ? err.message : String(err));
                // The member left before their environment was ready: nothing failed.
                if (!r && err instanceof Error && err.message === ABANDONED_LAUNCH) {
                  logger.debug(`member terminal launch dropped: ${detail}`);
                  return { ok: false, message: detail };
                }
                logger.warn(`member terminal launch failed: ${detail}`);
                return { ok: false, message: MEMBER_LAUNCH_FAILED_MESSAGE, detail };
              }
            };
          }
          if (mode !== 'shell' && !member) {
            const planned = await planPairOrChatExec({
              root: deps.root,
              storage,
              task: target.task,
              session: target.session,
              mode,
              member,
            });
            if (!planned.ok) return fail(planned.status, planned.message);
            ({ cmd, env, onClose, abort } = planned.plan);
            undo.push(() => planned.plan.abort());
          }
        } catch (err) {
          return fail(500, `Could not open a terminal in this task's environment: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (member) {
          const release = releaseClaim ?? (() => {});
          const [close0, abort0] = [onClose, abort];
          onClose = () => { release(); close0?.(); };
          abort = () => { release(); abort0?.(); };
        }
        if (sshForwardToken) {
          const t = sshForwardToken;
          const [close1, abort1] = [onClose, abort];
          onClose = () => { revokeForwardGrant(t); close1?.(); };
          abort = () => { revokeForwardGrant(t); abort1?.(); };
        }
      }

      const data: ShellSocketData = {
        socketPath: '',
        container: execTarget,
        binary: target.binary,
        ...(target.kind !== 'builder' && target.engineSocket ? { engineSocket: target.engineSocket } : {}),
        cols,
        rows,
        exec: null,
        cmd,
        env,
        attach: target.kind === 'builder',
        ...(sshConnection ? { ssh: sshConnection } : {}),
        onClose,
        resumeOwner: owner,
        // No idle or lifetime close on a member's terminal: it holds no turn
        // off the task. Its environment ends with its sessions, membership,
        // or task (./member-terminals.ts).
      };
      if (memberLaunch) {
        const launchIt = memberLaunch;
        // The client leaving mid-preparation releases this terminal's claim AT
        // ONCE (./shell-ws.ts calls this from close), rather than when a launch
        // that may be a minutes-long image build settles. What the launch makes
        // is still the hold's, and the hold's vacate removes it.
        data.releaseNow = releaseClaim;
        data.prepare = async (status) => {
          const launched = await launchIt(status, () => data.closedWhilePreparing === true);
          if (!launched.ok) return launched;
          data.container = launched.container;
          data.onStarted = launched.onStarted;
          const plan = launched.plan;
          if (plan) {
            data.cmd = plan.cmd;
            data.env = plan.env;
            const release = data.onClose;
            data.onClose = () => { release?.(); plan.onClose(); };
          }
          if (launched.env.length > 0) data.env = [...data.env, ...launched.env];
          return { ok: true };
        };
      }
      // The last leg of a builder start: how long the terminal's attach took to
      // resolve and confirm its container before the socket opens.
      if (target.kind === 'builder') {
        logger.info(`builder terminal attach [run ${target.sessionId}]: container ${target.container} ready to attach after ${Date.now() - attachStarted}ms`);
      }
      if (!server.upgrade(req, { data })) {
        abort?.();
        return refusal(426, 'Expected a WebSocket upgrade request.');
      }
      return 'upgraded';
    },
  };
}

/**
 * Attach to a named tmux session in the TASK's own container — on a shared
 * daemon too, where a terminal of one's own never lands there. What the
 * socket runs is `tmux attach` and nothing else: the session's command is
 * whatever lazy (Start services) or a person started in it, and nothing is
 * started here. It takes no member claim and no turn exclusion: a tmux
 * session runs whether anybody watches it, so watching or typing into it
 * never blocks a turn and a turn never blocks it
 * (docs/design/task-sessions-and-ssh.md §1, §4).
 */
async function attachTmuxSession(opts: {
  req: Request;
  server: Server<unknown>;
  url: URL;
  deps: SessionAttachUpgraderDeps;
  target: SessionAttachTarget;
  tmuxName: string;
  requestedMode: string | null;
  multiMember: boolean;
  caller: { email: string } | null;
}): Promise<UpgradeOutcome> {
  const { req, server, url, deps, target, tmuxName } = opts;
  if (target.kind !== 'task') return refusal(400, 'Only a task has tmux sessions to attach to.');
  if (opts.requestedMode !== null) return refusal(400, 'Attach to a tmux session (?tmux=) or open a terminal (?mode=), not both.');
  if (!isValidSessionName(tmuxName)) return refusal(400, `Not a session name: ${JSON.stringify(tmuxName)}.`);
  // Restated from the resolver: the target below is the TASK's container,
  // which a shared daemon hands only to a named member.
  if (opts.multiMember && !opts.caller) return refusal(403, 'A task session on a shared daemon is attached to as a member.');
  const running = await (deps.confirmRunning ?? confirmAttachTargetRunning)(deps.root, target);
  if (!running.ok) return refusal(running.status, running.message);
  const data: ShellSocketData = {
    socketPath: '',
    container: target.container,
    binary: target.binary,
    cols: clampDim(url.searchParams.get('cols'), DEFAULT_TERM_COLS, MAX_TERM_COLS),
    rows: clampDim(url.searchParams.get('rows'), DEFAULT_TERM_ROWS, MAX_TERM_ROWS),
    exec: null,
    cmd: attachSessionArgv(tmuxName, { readOnly: url.searchParams.get('readonly') === '1' }),
    env: ['TERM=xterm-256color'],
    attach: false,
    onClose: null,
  };
  if (!server.upgrade(req, { data })) return refusal(426, 'Expected a WebSocket upgrade request.');
  return 'upgraded';
}
