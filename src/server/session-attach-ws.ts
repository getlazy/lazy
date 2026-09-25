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
import { createShellRelayHandler, clampDim, refusal, SHELL_CMD, type ShellSocketData } from './shell-ws';
import { parseShellSessionMode, planPairOrChatExec } from './shell-pair';
import {
  resolveSessionAttachTarget,
  confirmAttachTargetRunning,
  attachNeedsRunningContainer,
  taskModeRefusals,
  type ResolveSessionAttachOptions,
} from '../daemon/session-attach';
import {
  claimMemberTerminal,
  releaseMemberTerminal,
  memberTerminalContainer,
  memberHeldMessage,
  MEMBER_VACATING_MESSAGE,
  type HeldContainer,
} from './member-terminals';
import { enterTaskAsMember } from '../daemon/member-entry';
import { launchMemberContainer, memberContainerRunning } from '../daemon/member-container';
import { logger } from '../utils/logger';
import { MEMBER_TERMINAL_IDLE_MS, MEMBER_TERMINAL_MAX_MS, type TerminalLimits } from './terminal-idle';

import { DEFAULT_TERM_COLS, DEFAULT_TERM_ROWS, MAX_TERM_COLS, MAX_TERM_ROWS } from './shell-protocol';

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
  /** Binding seam for tests; see ResolveSessionAttachOptions.bindingFor. */
  bindingFor?: ResolveSessionAttachOptions['bindingFor'];
  /** Member-entry seam for tests; defaults to `enterTaskAsMember`. */
  enterAsMember?: typeof enterTaskAsMember;
  /** Member preflight seam for tests; defaults to `taskModeRefusals`. */
  memberPreflight?: typeof taskModeRefusals;
  /** The member's own container; defaults to `launchMemberContainer`. */
  launchMemberContainer?: (opts: Parameters<typeof launchMemberContainer>[0]) => Promise<
    { ok: true; container: HeldContainer } | { ok: false; status: number; message: string }
  >;
  /** Liveness of a reused member container; defaults to `docker ps`. */
  memberContainerRunning?: (container: HeldContainer) => Promise<boolean>;
  /** What runs when a member's last terminal has gone; defaults to removing their container. */
  onMemberVacate?: (container: HeldContainer | null) => Promise<void>;
  /** Grace seam for tests; defaults to MEMBER_VACATE_GRACE_MS. */
  memberGraceMs?: number;
  /** Idle/max seam for tests; defaults to MEMBER_TERMINAL_IDLE_MS / _MAX_MS. */
  memberTerminalLimits?: TerminalLimits;
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

      const sessionId = decodePathSegment(match[1]);
      const storage = await deps.getStorage();
      // The PERSON comes from the token, never from the request.
      const caller = auth.actor.kind === 'user' ? auth.actor : null;
      const multiMember = await deps.multiMember();
      const resolved = await resolveSessionAttachTarget({
        projectRoot: deps.root,
        storage,
        sessionId,
        callerEmail: caller?.email ?? null,
        multiMember,
        runnerFor: deps.runnerFor,
        bindingFor: deps.bindingFor,
      });
      if (!resolved.ok) return refusal(resolved.status, resolved.message);
      const { target } = resolved;

      const requestedMode = url.searchParams.get('mode');
      if (target.kind === 'builder' && requestedMode !== null && requestedMode !== 'attach') {
        return refusal(400, `A builder session is attached to, not entered in "${requestedMode}" mode. Omit ?mode.`);
      }

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
      if (target.kind === 'task') {
        const mode = parseShellSessionMode(requestedMode);
        // On a shared daemon the terminal runs AS the attaching member —
        // billed to them, and pair's rows name them. Locally the single person
        // is the daemon's own, exactly as the dashboard shell.
        const member = multiMember && caller
          ? { email: caller.email, ...(caller.name ? { name: caller.name } : {}) }
          : null;
        // The resolver already refused a nameless caller on a shared daemon;
        // restated here because the fallback below is the TASK's container,
        // which a shared daemon must never hand a terminal.
        if (multiMember && !member) return refusal(403, 'A task terminal on a shared daemon is opened as a member.');
        // Everything acquired from here on is undone if ANY later step refuses
        // or throws: the claim, pair/chat's locks. A leaked claim would lock
        // every other member (and every turn) out of the task until the daemon
        // restarted.
        const undo: Array<() => void> = [];
        // The member's container is removed once their last terminal has gone
        // (after the grace): every process they left running in it dies with
        // it, and its credential is revoked. A removal that fails THROWS, so
        // the hold stays and the removal is retried (./member-terminals.ts).
        const vacate = deps.onMemberVacate ?? (async (container: HeldContainer | null) => {
          if (container) await container.remove();
        });
        const fail = (status: number, message: string) => {
          for (const u of undo.reverse()) {
            try {
              u();
            } catch (err) {
              // Already refusing; one failed undo must not skip the rest.
              logger.warn(`terminal refusal cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return refusal(status, message);
        };
        try {
          if (member) {
            // One member in a task at a time (./member-terminals.ts).
            const claimed = claimMemberTerminal(target.task.id, member.email);
            if (!claimed.ok) {
              return refusal(409, claimed.vacating ? MEMBER_VACATING_MESSAGE : memberHeldMessage(claimed.holder));
            }
            undo.push(() => releaseMemberTerminal(target.task.id, member.email, vacate, deps.memberGraceMs));
            // EVERY CHECK THAT CAN REFUSE runs before the entry, which keeps
            // turns off the task from the moment it succeeds: a Pair on an
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
            // Under the task's lifecycle lock: no turn running, and from here
            // on no turn starts until this member's session ends.
            const entered = await (deps.enterAsMember ?? enterTaskAsMember)({
              projectRoot: deps.root,
              storage,
              taskId: target.task.id,
              email: member.email,
            });
            if (!entered.ok) return fail(entered.status, entered.message);
            // The member's own container: created for their first terminal,
            // joined by every later one while the hold lasts.
            const launch = deps.launchMemberContainer ?? launchMemberContainer;
            let launchRefusal: { status: number; message: string } | null = null;
            let container: HeldContainer;
            try {
              container = await memberTerminalContainer(
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
                  });
                  if (!launched.ok) {
                    launchRefusal = launched;
                    throw new Error(launched.message);
                  }
                  return launched.container;
                },
                deps.memberContainerRunning ?? ((c) => memberContainerRunning(c.binary, c.name)),
              );
            } catch (err) {
              const r = launchRefusal as { status: number; message: string } | null;
              if (r) return fail(r.status, r.message);
              throw err;
            }
            execTarget = container.name;
          }
          if (mode !== 'shell') {
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
          const release = () => releaseMemberTerminal(target.task.id, member.email, vacate, deps.memberGraceMs);
          const [close0, abort0] = [onClose, abort];
          onClose = () => { release(); close0?.(); };
          abort = () => { release(); abort0?.(); };
        }
      }

      const data: ShellSocketData = {
        socketPath: '',
        container: execTarget,
        binary: target.binary,
        cols,
        rows,
        exec: null,
        cmd,
        env,
        attach: target.kind === 'builder',
        onClose,
        // A member's open terminal keeps every turn off the task, so a
        // forgotten one is closed (./terminal-idle.ts).
        ...(target.kind === 'task' && multiMember ? { limits: deps.memberTerminalLimits ?? { idleMs: MEMBER_TERMINAL_IDLE_MS, maxMs: MEMBER_TERMINAL_MAX_MS } } : {}),
      };
      if (!server.upgrade(req, { data })) {
        abort?.();
        return refusal(426, 'Expected a WebSocket upgrade request.');
      }
      return 'upgraded';
    },
  };
}
