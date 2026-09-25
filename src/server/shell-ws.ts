/**
 * Web-shell WebSocket upgrader: the daemon side of `lazy shell --container` in
 * the browser.
 *
 * Route: `GET /tasks/:id/shell/ws`. On upgrade the daemon opens a PTY
 * `docker exec` into the task's OWN container (resolved server-side, never from
 * a client string) and relays bytes to the browser's xterm.js terminal. See
 * docs/web-shell.md for the decision record and threat model.
 *
 * Authorization is the dashboard's own gate: every upgrade passes the caller's
 * `guard` (in production `guardDashboardRequest`, src/daemon/dashboard-auth.ts)
 * BEFORE anything else is looked at, so the shell requires the same signed-in
 * browser session as every dashboard page — on every bind, per that module's
 * contract ("a shell into a task container is the single most valuable thing on
 * this port"), and it answers 404 in managed mode like the rest of the
 * dashboard. The session cookie rides the WebSocket upgrade request like any
 * other, so no separate credential is needed. There is deliberately no MCP
 * surface (see public-docs/surface-asymmetries.md).
 *
 * The exec target can only ever be the task's container: it is derived from the
 * task's session (`container_name ?? runner.runNameForTask(taskRef(task))`),
 * exactly as the CLI derives it. A unit test pins that the client cannot steer
 * the exec at the host or another container.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { Storage } from '../storage';
import type { Task, Session } from '../types';
import type { Runner } from '../runner';
import type { ShellUnavailableCode } from './shell-ui';
import { parseShellSessionMode, planPairOrChatExec } from './shell-pair';
import { logger } from '../utils/logger';
import { watchTerminalIdle, terminalExpiredMessage, type TerminalLimits, type IdleWatch } from './terminal-idle';
import { createRunner } from '../runner';
import { taskRef } from '../task/identity';
import { ExecStream, resolveDockerSocketPath } from '../runner/docker-exec-stream';
import type { WebSocketUpgrader, UpgradeOutcome } from './ws';
import { decodePathSegment } from './task-urls';
import {
  parseShellClientMessage,
  shellServerMessage,
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
  MAX_TERM_COLS,
  MAX_TERM_ROWS,
  MIN_TERM_DIM,
} from './shell-protocol';

/** The command the container shell runs — identical to `lazy shell --container`:
 * prefer bash, fall back to sh, decided inside the container. No login shell:
 * the container's workdir is already the worktree. */
export const SHELL_CMD = ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; fi; exec sh'];

/** Per-connection state carried by the WebSocket, set at upgrade time. Shared
 * with the session attach route (./session-attach-ws.ts), which relays through
 * the same handler. */
export interface ShellSocketData {
  socketPath: string;
  container: string;
  binary: string;
  cols: number;
  rows: number;
  exec: ExecStream | null;
  /** In-container argv. Pair/Chat swap the default shell for `lazy-agent pair`. */
  cmd: string[];
  /** Attach to the container's own TTY rather than exec `cmd` (see ExecStream). */
  attach?: boolean;
  env: string[];
  /** Releases the Pair/Chat lock after the socket closes. */
  onClose: (() => void) | null;
  /**
   * Close the terminal when idle or open too long (a member's terminal on a
   * shared daemon — see ./terminal-idle.ts). Unset: no limit, as before.
   */
  limits?: TerminalLimits;
  /** The running watch, when {@link limits} is set. */
  idle?: IdleWatch | null;
}

export interface ShellUpgraderDeps {
  /** Resolves the daemon's storage. A thunk, not a value, because the upgrader
   * is constructed at bind time — before storage initialization completes. */
  getStorage: () => Promise<Storage>;
  root: string;
  /** The dashboard's auth gate, applied to every upgrade request BEFORE the
   * task is even looked up. Returns a denial Response (sign-in 401, wrong-host,
   * managed-mode 404) or null to let the upgrade proceed. In production this is
   * `guardDashboardRequest` with the same dashboard host as the page routes, so
   * the shell and the pages agree on exactly who is signed in. */
  guard: (req: Request) => Promise<Response | null>;
}

const SHELL_WS_PATH_RE = /^\/tasks\/([^/]+)\/shell\/ws$/;

export function clampDim(value: string | null, fallback: number, max: number): number {
  const n = value === null ? NaN : parseInt(value, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(MIN_TERM_DIM, Math.min(max, n));
}

/**
 * Whether a task can have a web shell opened into it, and why not when it can't.
 * The reason strings are user-facing: the UI shows them on the disabled button
 * and the upgrader returns them as the refusal body.
 */
export type ShellTarget =
  | { available: true; container: string; binary: string }
  | { available: false; reason: string; code: ShellUnavailableCode };

/**
 * The exec target for a task's web shell — the one place the container name is
 * decided, and the whole security guarantee of this surface.
 *
 * It has NO client-derived input: the name comes only from the task's own
 * session (`container_name`), or is derived from the task itself
 * (`runner.runNameForTask(taskRef(task))`) exactly as `lazy shell --container`
 * derives it. A browser passes no container string anywhere, so it can only ever
 * reach the task's own container — never the host, never another task's. Pinned
 * by test/unit/shell-target.test.ts.
 */
export function execContainerName(
  task: Task,
  session: Session,
  runner: Pick<Runner, 'runNameForTask'>,
): string {
  return session.container_name ?? runner.runNameForTask(taskRef(task));
}

/**
 * The half of shell resolution that costs NOTHING at render time: does the task
 * have a session, and does its runner even have a container? Both are answered
 * from storage and config — `createRunner` loads config and resolves the agent
 * profile, it never spawns docker.
 *
 * This is what the PAGE calls. The remaining question — is that container
 * running right now — is deliberately not asked here: `runner.isRunning` shells
 * out to `docker ps` with a ten-second cap, so asking it on every task page
 * render made the whole page wait on a wedged Docker Desktop before a byte of
 * HTML existed, on tabs that have nothing to do with containers. The page no
 * longer needs the answer either: Shell/Pair/Chat/Watch bring the container up
 * themselves when the user opens them (`POST /tasks/:id/container/ensure`), so
 * "not running" is a transient the action resolves, not a state to render.
 */
export async function resolveShellContainer(
  root: string,
  task: Task,
  session: Session | null,
): Promise<ShellTarget> {
  if (!session) {
    return { available: false, code: 'no-session', reason: `Task has no session — start it first.` };
  }
  const runner = await createRunner(root, session.runner_type ?? task.runner_type ?? undefined);
  if (!runner.usesSandbox()) {
    return {
      available: false,
      code: 'no-container-runner',
      reason: `Task runs on the ${runner.type} runner, which has no container to enter.`,
    };
  }
  const container = execContainerName(task, session, runner);
  const binary = runner.type === 'podman' ? 'podman' : 'docker';
  return { available: true, container, binary };
}

/**
 * Resolve the task's container and running state, applying the same rules as
 * `lazy shell --container`. The exec target is derived ENTIRELY from the task's
 * own session (see {@link execContainerName}) — never from any client-supplied
 * string — so a browser can only ever reach the task's own container, never the
 * host or another task's.
 *
 * This is the UPGRADER's resolver: it adds the `docker ps` probe on top of
 * {@link resolveShellContainer}, which is affordable here because it runs on a
 * user's explicit action rather than on a page render. The client is expected to
 * have ensured the container first, so a `not-running` refusal at this point
 * means the ensure did not take — a real error worth surfacing, not a state to
 * paper over with a silent auto-start inside the upgrade handshake.
 */
export async function resolveShellTarget(
  root: string,
  task: Task,
  session: Session | null,
): Promise<ShellTarget> {
  const resolved = await resolveShellContainer(root, task, session);
  if (!resolved.available) return resolved;
  const runner = await createRunner(root, session!.runner_type ?? task.runner_type ?? undefined);
  if (!(await runner.isRunning(resolved.container))) {
    return { available: false, code: 'not-running', reason: `Container for this task is not running.` };
  }
  return resolved;
}

export function refusal(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * The Bun WebSocket handler that relays one terminal: opens the `ExecStream`
 * on connect, forwards binary frames to the PTY and text frames as control,
 * and closes the exec (and releases any Pair/Chat hold) when the socket goes.
 * ONE relay for every terminal route — the dashboard shell and the session
 * attach route differ only in how they authorize and resolve the target.
 */
/**
 * Relay a chunk of terminal OUTPUT to the browser. Output is not activity: it
 * never touches the idle watch (see the keystroke branch of the handler).
 */
export function relayTerminalOutput(ws: Pick<ServerWebSocket<ShellSocketData>, 'sendBinary'>, bytes: Uint8Array): void {
  // Raw terminal output rides binary frames untouched.
  try { ws.sendBinary(bytes); } catch { /* socket closing */ }
}

export function createShellRelayHandler(): import('bun').WebSocketHandler<unknown> {
  const handler = {
    async open(ws: ServerWebSocket<ShellSocketData>) {
      const data = ws.data;
      let socketPath: string;
      try {
        socketPath = await resolveDockerSocketPath(data.binary);
      } catch (err) {
        ws.send(shellServerMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
        ws.close(1011, 'docker socket');
        return;
      }
      data.socketPath = socketPath;
      const exec = new ExecStream({
        socketPath,
        container: data.container,
        cmd: data.cmd,
        attach: data.attach,
        cols: data.cols,
        rows: data.rows,
        env: data.env,
        onData: (bytes) => relayTerminalOutput(ws, bytes),
        onExit: (code) => {
          try {
            ws.send(shellServerMessage({ type: 'exit', code }));
            ws.close(1000, 'shell exited');
          } catch { /* already closed */ }
        },
      });
      data.exec = exec;
      if (data.limits) {
        const limits = data.limits;
        data.idle = watchTerminalIdle(limits, (reason) => {
          try {
            ws.send(shellServerMessage({ type: 'error', message: terminalExpiredMessage(reason, limits) }));
            ws.close(4000, reason === 'idle' ? 'idle' : 'max session');
          } catch { /* already closed */ }
        });
      }
      try {
        await exec.start();
        ws.send(shellServerMessage({ type: 'ready', container: data.container }));
      } catch (err) {
        logger.warn(`web-shell exec failed to start: ${err instanceof Error ? err.message : err}`);
        ws.send(shellServerMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
        ws.close(1011, 'exec start');
      }
    },

    message(ws: ServerWebSocket<ShellSocketData>, message: string | Buffer) {
      const exec = ws.data.exec;
      if (!exec) return;
      if (typeof message === 'string') {
        // TEXT frame — a JSON control message.
        const parsed = parseShellClientMessage(message);
        if (!parsed.ok) {
          logger.debug(`web-shell ignoring bad control frame: ${parsed.error}`);
          return;
        }
        if (parsed.message.type === 'resize') {
          void exec.resize(parsed.message.cols, parsed.message.rows);
        }
        return;
      }
      // BINARY frame — raw keystrokes for the PTY stdin. The ONLY thing that
      // counts as somebody using the terminal (./terminal-idle.ts): not its
      // output — a dev server printing away with nobody at the keyboard would
      // otherwise hold every turn off the task for the whole maximum — and
      // not a resize, which a browser sends by itself.
      ws.data.idle?.touch();
      exec.write(new Uint8Array(message));
    },

    close(ws: ServerWebSocket<ShellSocketData>) {
      // Closing the exec closes the hijacked docker socket, which HUPs the
      // process inside the container — orphan reaping with no bookkeeping.
      ws.data.idle?.stop();
      ws.data.exec?.close();
      try { ws.data.onClose?.(); } catch { /* lock release is best-effort */ }
    },
  };
  return handler as unknown as import('bun').WebSocketHandler<unknown>;
}

export function createShellUpgrader(deps: ShellUpgraderDeps): WebSocketUpgrader {
  return {
    handler: createShellRelayHandler(),

    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const url = new URL(req.url);
      const match = SHELL_WS_PATH_RE.exec(url.pathname);
      if (!match) return null; // not our route

      // Authorization FIRST — before the method or the task id says anything.
      // The upgrader runs ahead of the HTTP handler's dashboard gate, so it
      // must apply the same gate itself or the shell would be the one
      // unauthenticated route on the port.
      const denial = await deps.guard(req);
      if (denial) return denial;

      if (req.method !== 'GET') return refusal(405, 'Method not allowed');

      // Same rule as the HTTP router: a malformed escape must 404, not throw
      // out of the upgrade (decodeURIComponent raises URIError on '%zz').
      const taskIdParam = decodePathSegment(match[1]);
      const storage = await deps.getStorage();
      const task = await storage.getTask(taskIdParam);
      if (!task) return refusal(404, `Task not found: ${taskIdParam}`);
      const session = await storage.getSessionByTaskId(task.id);

      const resolved = await resolveShellTarget(deps.root, task, session);
      if (!resolved.available) return refusal(409, resolved.reason);

      const cols = clampDim(url.searchParams.get('cols'), DEFAULT_TERM_COLS, MAX_TERM_COLS);
      const rows = clampDim(url.searchParams.get('rows'), DEFAULT_TERM_ROWS, MAX_TERM_ROWS);
      const mode = parseShellSessionMode(url.searchParams.get('mode'));

      let cmd = SHELL_CMD;
      let env = ['TERM=xterm-256color'];
      let onClose: (() => void) | null = null;
      let abort: (() => void) | null = null;
      if (mode !== 'shell') {
        // session is non-null here: resolveShellTarget refused no-session.
        const planned = await planPairOrChatExec({
          root: deps.root,
          storage,
          task,
          session: session!,
          mode,
        });
        if (!planned.ok) return refusal(planned.status, planned.message);
        cmd = planned.plan.cmd;
        env = planned.plan.env;
        onClose = planned.plan.onClose;
        abort = planned.plan.abort;
      }

      const data: ShellSocketData = {
        socketPath: '',
        container: resolved.container,
        binary: resolved.binary,
        cols,
        rows,
        exec: null,
        cmd,
        env,
        onClose,
      };
      const ok = server.upgrade(req, { data });
      if (!ok) {
        abort?.();
        return refusal(426, 'Expected a WebSocket upgrade request.');
      }
      return 'upgraded';
    },
  };
}
