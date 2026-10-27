/**
 * Web-shell WebSocket upgrader: the daemon side of `lazy shell --container` in
 * the browser.
 *
 * Route: `GET /tasks/:id/shell/ws` — and `GET /runs/:id/shell/ws` for a commit
 * run's own container (see {@link resolveRunShellTarget}). On upgrade the daemon opens a PTY
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
import type { CommitRun } from '../storage/types';
import { runContainerName } from '../run/identity';
import type { Runner, RunnerType } from '../runner';
import type { ShellUnavailableCode } from './shell-ui';
import { parseShellSessionMode, planPairOrChatExec } from './shell-pair';
import { logger } from '../utils/logger';
import { parseShellSessionName, shellSessionCommand } from '../terminal/shell-session';
import { attachSessionArgv, isValidSessionName } from '../sessions/tmux';
import { createInspectionRunner } from '../runner';
import { terminalEngineOf as engineOf } from '../runner/container-cli';
import { taskRef } from '../task/identity';
import { ExecStream, resolveDockerSocketPath } from '../runner/docker-exec-stream';
import { OutputLog, TerminalHolds, RESUME_TOKEN_RE, TERMINAL_RESUME_GRACE_MS } from './terminal-hold';
import type { WebSocketUpgrader, UpgradeOutcome } from './ws';
import { decodePathSegment } from './task-urls';
import { queueOrWriteSshInput, flushSshInput, startSshConnection, relaySshLog, relaySshOutput, finishSsh, logSshConnectionEnd, type SshConnectionData } from '../ssh/connection';
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
  /** The runner's own Engine API socket (smolvm: this process's relay); unset → the client's engine. */
  engineSocket?: string;
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
  /** Called only after the Engine API successfully starts the terminal exec. */
  onStarted?: () => Promise<void>;
  /**
   * Work that runs AFTER the upgrade was answered and before the exec starts
   * — a member's own container (./session-attach-ws.ts). `status` sends a
   * `status` frame. On success it has set {@link container}; on failure it has
   * already undone everything it held, and the socket gets its `error` frame.
   */
  prepare?: (status: (message: string) => void) => Promise<{ ok: true } | { ok: false; message: string; detail?: string }>;
  /** Set while {@link prepare} runs. */
  preparing?: boolean;
  /** The socket closed while {@link prepare} ran: nothing is started, and
   * {@link onClose} runs once preparation settles. */
  closedWhilePreparing?: boolean;
  /**
   * Called at once when the client closes during {@link prepare}: frees what
   * the socket held (a member's claim on the task) without waiting for the
   * preparation, which may be a minutes-long image build. Must be idempotent.
   */
  releaseNow?: (() => void) | null;
  /**
   * `?mode=ssh` (../ssh/connection.ts): the exec is `sshd -i` with no TTY,
   * binary frames are SSH bytes both ways, and the connection carries its own
   * audit.
   */
  ssh?: SshConnectionData;
  /**
   * Set by the route: who may reattach to this terminal after a dropped
   * connection (./terminal-hold.ts) — the route, its target and, on a shared
   * daemon, the person. Unset: the terminal ends with its socket, as before.
   */
  resumeOwner?: string;
  /** The current token for reattaching, once the terminal is ready. */
  resumeToken?: string | null;
  /** The socket the terminal is drawing to now; null while it is detached. */
  ws?: ServerWebSocket<ShellSocketData> | null;
  /** Recent output, for a reattaching page to catch up on. */
  log?: OutputLog;
  /** The program's exit code once it exited (undefined while it runs). */
  exitCode?: number | null;
  /** The page said it is done (`{type:"end"}`): a close ends the terminal. */
  endRequested?: boolean;
  /** This side is closing the socket for good (an error, an expiry). */
  ending?: boolean;
  /** Ended for good: the exec is closed and everything held released. */
  ended?: boolean;
  /** A reattach was claimed at upgrade and its socket has not opened yet. */
  reattaching?: boolean;
  /** How many output bytes the reattaching page already drew. */
  resumeOffset?: number;
  /** A refusal decided at upgrade, said as an error frame on the open socket. */
  refusal?: string;
}

/** Every resumable terminal on this daemon. */
export const terminalHolds = new TerminalHolds<ShellSocketData>();

/** What a page reads when the terminal it tries to reattach to is gone. */
export const TERMINAL_ENDED_MESSAGE =
  `This terminal has ended: it was closed, its program exited, or nothing reconnected to it within ${Math.round(TERMINAL_RESUME_GRACE_MS / 60_000)} minutes. Open a new one.`;

/**
 * End a terminal for good: stop its watch, close the exec (which HUPs the
 * program — or, for an attach, detaches from it), forget its token and release
 * whatever the route held. Idempotent.
 */
export function endTerminal(data: ShellSocketData): void {
  if (data.ended) return;
  data.ended = true;
  data.exec?.close();
  terminalHolds.release(data.resumeToken);
  data.resumeToken = null;
  try { data.onClose?.(); } catch { /* lock release is best-effort */ }
}

/**
 * Offer a reattach (`?resume=<token>&offset=<n>`) to the terminal it names.
 * Returns null when the request is not a reattach. Called by each route AFTER
 * its own authorization and target resolution, with the owner it would give a
 * new terminal — so a token is only ever claimed back through the same gate,
 * by the same caller. A token that is unknown, expired, malformed or someone
 * else's gets the same answer: an `error` frame on an accepted socket, which
 * the page reads as a real end and stops retrying.
 */
export function tryResumeUpgrade(
  req: Request,
  server: Server<unknown>,
  url: URL,
  owner: string,
  opts: { freshOnMiss?: boolean } = {},
): UpgradeOutcome | null {
  const token = url.searchParams.get('resume');
  if (token === null) return null;
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const claimed = RESUME_TOKEN_RE.test(token) && Number.isSafeInteger(offset) && offset >= 0
    ? terminalHolds.claim(token, owner)
    : null;
  if (!claimed || claimed.value.ended) {
    // A target that outlives every socket (a builder: an attach, not an
    // exec) is simply attached to again — its session is still running.
    if (opts.freshOnMiss) return null;
    const data = { refusal: TERMINAL_ENDED_MESSAGE, onClose: null } as unknown as ShellSocketData;
    return server.upgrade(req, { data }) ? 'upgraded' : refusal(426, 'Expected a WebSocket upgrade request.');
  }
  const data = claimed.value;
  data.resumeToken = claimed.token;
  data.resumeOffset = offset;
  data.cols = clampDim(url.searchParams.get('cols'), data.cols, MAX_TERM_COLS);
  data.rows = clampDim(url.searchParams.get('rows'), data.rows, MAX_TERM_ROWS);
  data.reattaching = true;
  if (!server.upgrade(req, { data })) {
    data.reattaching = false;
    if (!data.ws) terminalHolds.detach(claimed.token);
    return refusal(426, 'Expected a WebSocket upgrade request.');
  }
  return 'upgraded';
}

/**
 * A NEW Pair or Chat from the owner of a detached one ends the detached one
 * first: its page lost the token (a reload while reconnecting), and it would
 * otherwise hold the lock the new one needs for the whole grace. Ending it
 * starts the lock's own short grace, which the same person then resumes.
 */
export function endDetachedTerminals(owner: string): void {
  terminalHolds.endWhere(owner, (d) => !d.ws && !d.reattaching);
}

/** The second half of a reattach: point the terminal at its new socket and catch the page up. */
function reattach(ws: ServerWebSocket<ShellSocketData>): void {
  const data = ws.data;
  data.reattaching = false;
  const previous = data.ws;
  data.ws = ws;
  // Still attached to an old socket the server never saw die (a laptop that
  // slept): this page takes the terminal over.
  if (previous && previous !== ws) {
    try { previous.close(4001, 'reattached elsewhere'); } catch { /* already closed */ }
  }
  const { bytes, lost } = data.log?.since(data.resumeOffset ?? 0) ?? { bytes: new Uint8Array(0), lost: 0 };
  try {
    ws.send(JSON.stringify({ type: 'ready', container: data.container, resume: data.resumeToken, resumed: true, ...(lost ? { lost } : {}) }));
    if (bytes.length) ws.sendBinary(bytes);
    void data.exec?.resize(data.cols, data.rows);
    if (data.exitCode !== undefined) {
      ws.send(shellServerMessage({ type: 'exit', code: data.exitCode }));
      ws.close(1000, 'shell exited');
    }
  } catch { /* socket closing */ }
}

/**
 * Run a socket's {@link ShellSocketData.prepare}, if any. Returns whether the
 * exec should start. A client that left meanwhile gets nothing started, and
 * its release runs now that the hold it would release exists.
 */
async function runPreparation(ws: ServerWebSocket<ShellSocketData>): Promise<boolean> {
  const data = ws.data;
  if (!data.prepare) return true;
  data.preparing = true;
  let outcome: { ok: true } | { ok: false; message: string; detail?: string };
  try {
    outcome = await data.prepare((message) => {
      if (data.closedWhilePreparing) return;
      try { ws.send(shellServerMessage({ type: 'status', message })); } catch { /* socket closing */ }
    });
  } catch (err) {
    // `prepare` reports its own failures; a throw here is a bug in it, still
    // answered on the socket rather than left as an unhandled rejection.
    outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    data.preparing = false;
  }
  if (!outcome.ok) {
    // Everything held was already undone by `prepare`: nothing to release twice.
    data.onClose = null;
    if (!data.closedWhilePreparing) {
      try {
        ws.send(shellServerMessage({ type: 'error', message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) }));
        ws.close(1011, 'terminal could not be prepared');
      } catch { /* already closed */ }
    }
    return false;
  }
  if (data.closedWhilePreparing) {
    try {
      data.onClose?.();
    } catch (err) {
      logger.warn(`terminal release after an early close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    data.onClose = null;
    return false;
  }
  return true;
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
/** A commit run's shell (src/daemon/commit-run.ts), from its dashboard page. */
const RUN_SHELL_WS_PATH_RE = /^\/runs\/([^/]+)\/shell\/ws$/;

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
  | { available: true; container: string; binary: string; engineSocket?: string }
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
 * from storage and config — `createInspectionRunner` loads config and resolves the agent
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
  runnerFor: (type: RunnerType | undefined) => Promise<Pick<Runner, 'type' | 'usesSandbox' | 'runNameForTask'>> = (type) => createInspectionRunner(root, type),
): Promise<ShellTarget> {
  if (!session) {
    return { available: false, code: 'no-session', reason: `Task has no session — start it first.` };
  }
  const runner = await runnerFor(session.runner_type ?? task.runner_type ?? undefined);
  if (!runner.usesSandbox()) {
    return {
      available: false,
      code: 'no-container-runner',
      reason: `Task runs on the ${runner.type} runner, which has no container to enter.`,
    };
  }
  const container = execContainerName(task, session, runner);
  return { available: true, container, ...engineOf(runner) };
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
  const runner = await createInspectionRunner(root, session!.runner_type ?? task.runner_type ?? undefined);
  if (!(await runner.isRunning(resolved.container))) {
    return { available: false, code: 'not-running', reason: `Container for this task is not running.` };
  }
  return resolved;
}

/**
 * The exec target for a COMMIT RUN's web shell: the run's own container, named
 * from its slug by the one naming rule (`runContainerName`,
 * src/run/identity.ts) — exactly as the attach route's `run:<id>` resolution
 * and the run's Start services name it. Nothing from the client: the run is
 * looked up by the id in the path and everything after comes from its record.
 *
 * Entered directly, not through a member container: a run's container holds
 * no credential and runs no agent (docs/design/run-any-commit.md, "Shell").
 * The liveness probe is affordable here for the same reason as
 * {@link resolveShellTarget}'s: it runs on a user's explicit action, after
 * the client ensured the container.
 */
export async function resolveRunShellTarget(
  root: string,
  run: Pick<CommitRun, 'slug'>,
  runnerFor: () => Promise<Pick<Runner, 'type' | 'usesSandbox' | 'isRunning'>> = () => createInspectionRunner(root),
): Promise<ShellTarget> {
  const runner = await runnerFor();
  if (!runner.usesSandbox()) {
    return {
      available: false,
      code: 'no-container-runner',
      reason: `This project runs on the ${runner.type} runner, which has no container to enter.`,
    };
  }
  const container = runContainerName(root, run.slug);
  if (!(await runner.isRunning(container))) {
    return { available: false, code: 'not-running', reason: `The run's environment is not running.` };
  }
  return { available: true, container, ...engineOf(runner) };
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
 * Relay a chunk of terminal output to the browser.
 */
export function relayTerminalOutput(ws: Pick<ServerWebSocket<ShellSocketData>, 'sendBinary'>, bytes: Uint8Array): void {
  // Raw terminal output rides binary frames untouched.
  try { ws.sendBinary(bytes); } catch { /* socket closing */ }
}

export function createShellRelayHandler(): import('bun').WebSocketHandler<unknown> {
  const handler = {
    async open(ws: ServerWebSocket<ShellSocketData>) {
      const data = ws.data;
      if (data.refusal) {
        try {
          ws.send(shellServerMessage({ type: 'error', message: data.refusal }));
          ws.close(1008, 'refused');
        } catch { /* already closed */ }
        return;
      }
      if (data.reattaching) {
        reattach(ws);
        return;
      }
      data.ws = ws;
      // From the first byte: the page counts every byte it draws, and a
      // reattach replays from that count.
      if (data.resumeOwner) data.log = new OutputLog();
      if (!(await runPreparation(ws))) return;
      let socketPath: string;
      try {
        socketPath = data.engineSocket ?? await resolveDockerSocketPath(data.binary);
      } catch (err) {
        data.ending = true;
        ws.send(shellServerMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
        ws.close(1011, 'docker socket');
        return;
      }
      data.socketPath = socketPath;
      const ssh = data.ssh;
      if (ssh) startSshConnection(ssh);
      const exec = new ExecStream({
        socketPath,
        container: data.container,
        cmd: data.cmd,
        attach: data.attach,
        cols: data.cols,
        rows: data.rows,
        env: data.env,
        ...(ssh ? { tty: false, onStderr: (bytes: Uint8Array) => relaySshLog(ws, ssh, bytes) } : {}),
        // Output goes to whichever socket the terminal is drawing to NOW —
        // after a reattach, not the one that opened it — and into the log a
        // reattaching page catches up from. SSH is never resumable: its bytes
        // go to the socket that carries the connection.
        onData: (bytes) => {
          if (ssh) return relaySshOutput(ws, bytes);
          data.log?.append(bytes);
          if (data.ws) relayTerminalOutput(data.ws, bytes);
        },
        onExit: (code) => {
          if (ssh) return finishSsh(ws, ssh, code);
          data.exitCode = code;
          const current = data.ws;
          // Exited while detached: kept until the page comes back to read
          // that it exited, or the grace runs out.
          if (!current) {
            if (!data.resumeToken) endTerminal(data);
            return;
          }
          try {
            current.send(shellServerMessage({ type: 'exit', code }));
            current.close(1000, 'shell exited');
          } catch { /* already closed */ }
        },
      });
      data.exec = exec;
      try {
        await exec.start();
        await data.onStarted?.();
        if (ssh) flushSshInput(ssh, exec);
        // An SSH connection cannot be picked up again mid-protocol: never resumable.
        if (data.resumeOwner && !data.ended && !ssh) {
          data.resumeToken = terminalHolds.register(data.resumeOwner, data, () => endTerminal(data));
        }
        const current = data.ws;
        if (current) {
          current.send(shellServerMessage({ type: 'ready', container: data.container, ...(data.resumeToken ? { resume: data.resumeToken } : {}) }));
        } else {
          // The socket closed while the exec was starting; its close already
          // ended the terminal (nothing was resumable yet).
          endTerminal(data);
        }
      } catch (err) {
        data.ending = true;
        logger.warn(`web-shell exec failed to start: ${err instanceof Error ? err.message : err}`);
        ws.send(shellServerMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
        ws.close(1011, 'exec start');
      }
    },

    message(ws: ServerWebSocket<ShellSocketData>, message: string | Buffer) {
      // A socket another page took the terminal over from says nothing more.
      if (ws.data.ws && ws.data.ws !== ws) return;
      if (typeof message === 'string') {
        const parsed = parseShellClientMessage(message);
        if (parsed.ok && parsed.message.type === 'end') {
          ws.data.endRequested = true;
          return;
        }
      }
      const exec = ws.data.exec;
      if (ws.data.ssh) {
        // SSH: binary frames are the protocol's bytes; there is nothing to
        // control (no PTY to resize). The client speaks FIRST (its banner),
        // usually while the member's container is still being made, so input
        // that arrives before sshd runs is held, never dropped.
        if (typeof message === 'string') return;
        queueOrWriteSshInput(ws, ws.data.ssh, exec, new Uint8Array(message));
        return;
      }
      if (!exec) {
        // Still preparing: keystrokes have nowhere to go, but a resize is kept
        // so the PTY opens at the size the terminal has NOW, not the one in
        // the URL minutes ago.
        if (typeof message === 'string') {
          const parsed = parseShellClientMessage(message);
          if (parsed.ok && parsed.message.type === 'resize') {
            ws.data.cols = parsed.message.cols;
            ws.data.rows = parsed.message.rows;
          }
        }
        return;
      }
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
      // BINARY frame — raw keystrokes for the PTY stdin.
      exec.write(new Uint8Array(message));
    },

    close(ws: ServerWebSocket<ShellSocketData>) {
      // Still preparing: nothing is running to close. What the socket holds
      // is released now (`releaseNow`); anything the preparation takes after
      // this is released by runPreparation once it settles.
      if (ws.data.preparing) {
        ws.data.closedWhilePreparing = true;
        try {
          ws.data.releaseNow?.();
        } catch (err) {
          logger.warn(`terminal release on an early close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      const data = ws.data;
      if (data.refusal) return;
      // The terminal moved to another socket (a reattach took it over).
      if (data.ws !== ws) return;
      data.ws = null;
      if (data.ended || data.reattaching) return;
      // A dropped connection: the program keeps running for its page to
      // reattach (./terminal-hold.ts). Everything else ends it — the page
      // said it is done, this side closed it, the program exited, or it never
      // became resumable.
      if (!data.endRequested && !data.ending && data.exitCode === undefined && data.resumeToken && data.exec) {
        terminalHolds.detach(data.resumeToken);
        return;
      }
      // Closing the exec closes the hijacked docker socket, which HUPs the
      // process inside the container — orphan reaping with no bookkeeping.
      if (data.ssh) logSshConnectionEnd(data.ssh, data.container);
      endTerminal(data);
    },
  };
  return handler as unknown as import('bun').WebSocketHandler<unknown>;
}

export function createShellUpgrader(deps: ShellUpgraderDeps): WebSocketUpgrader {
  return {
    handler: createShellRelayHandler(),

    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const url = new URL(req.url);
      const runMatch = RUN_SHELL_WS_PATH_RE.exec(url.pathname);
      const match = runMatch ? null : SHELL_WS_PATH_RE.exec(url.pathname);
      if (!match && !runMatch) return null; // not our route

      // Authorization FIRST — before the method or the task id says anything.
      // The upgrader runs ahead of the HTTP handler's dashboard gate, so it
      // must apply the same gate itself or the shell would be the one
      // unauthenticated route on the port.
      const denial = await deps.guard(req);
      if (denial) return denial;

      if (req.method !== 'GET') return refusal(405, 'Method not allowed');

      const cols = clampDim(url.searchParams.get('cols'), DEFAULT_TERM_COLS, MAX_TERM_COLS);
      const rows = clampDim(url.searchParams.get('rows'), DEFAULT_TERM_ROWS, MAX_TERM_ROWS);

      if (runMatch) {
        // A run is entered with a shell and only a shell: there is no agent
        // session in it to pair with or chat to.
        const runMode = url.searchParams.get('mode');
        if (runMode !== null && runMode !== 'shell') {
          return refusal(400, `A run is entered with a shell, not in "${runMode}" mode.`);
        }
        const runId = decodePathSegment(runMatch[1]!);
        const storage = await deps.getStorage();
        const run = await storage.getCommitRun(runId);
        if (!run) return refusal(404, `Run not found: ${runId}`);
        const runOwner = `dash:run:${run.id}`;
        const runResume = tryResumeUpgrade(req, server, url, runOwner);
        if (runResume) return runResume;
        const target = await resolveRunShellTarget(deps.root, run);
        if (!target.available) return refusal(409, target.reason);
        const runData: ShellSocketData = {
          socketPath: '',
          container: target.container,
          binary: target.binary,
          engineSocket: target.engineSocket,
          cols,
          rows,
          exec: null,
          cmd: SHELL_CMD,
          env: ['TERM=xterm-256color'],
          onClose: null,
          resumeOwner: runOwner,
        };
        if (!server.upgrade(req, { data: runData })) return refusal(426, 'Expected a WebSocket upgrade request.');
        return 'upgraded';
      }
      if (!match) return null;

      // Same rule as the HTTP router: a malformed escape must 404, not throw
      // out of the upgrade (decodeURIComponent raises URIError on '%zz').
      const taskIdParam = decodePathSegment(match[1]);
      const storage = await deps.getStorage();
      const task = await storage.getTask(taskIdParam);
      if (!task) return refusal(404, `Task not found: ${taskIdParam}`);
      const session = await storage.getSessionByTaskId(task.id);
      const mode = parseShellSessionMode(url.searchParams.get('mode'));

      // A reattach goes back to the terminal it names — before anything below
      // that would plan a NEW one (Pair's lock, which the held one still has).
      const owner = `dash:task:${task.id}:${mode}`;
      const resumed = tryResumeUpgrade(req, server, url, owner);
      if (resumed) return resumed;
      if (mode !== 'shell') endDetachedTerminals(owner);

      const resolved = await resolveShellTarget(deps.root, task, session);
      if (!resolved.available) return refusal(409, resolved.reason);

      // `?tmux=<name>`: attach to one of the container's named tmux sessions
      // (the Services tab's Attach / Take control) instead of a shell of one's
      // own; `&readonly=1` watches without typing (`attach -r`). Nothing is
      // started and no turn is waited for, as on the session attach route.
      const tmuxName = url.searchParams.get('tmux');
      if (tmuxName !== null) {
        if (url.searchParams.get('mode') !== null || url.searchParams.get('session') !== null) {
          return refusal(400, 'Attach to a tmux session (?tmux=) or open a terminal (?mode=, ?session=), not both.');
        }
        if (!isValidSessionName(tmuxName)) return refusal(400, `Not a session name: ${JSON.stringify(tmuxName)}.`);
        const tmuxData: ShellSocketData = {
          socketPath: '',
          container: resolved.container,
          binary: resolved.binary,
          engineSocket: resolved.engineSocket,
          cols,
          rows,
          exec: null,
          cmd: attachSessionArgv(tmuxName, { readOnly: url.searchParams.get('readonly') === '1' }),
          env: ['TERM=xterm-256color'],
          onClose: null,
        };
        if (!server.upgrade(req, { data: tmuxData })) return refusal(426, 'Expected a WebSocket upgrade request.');
        return 'upgraded';
      }


      // The Shell is the container's `shell` tmux session: a reconnect or a
      // reload lands back in it (../terminal/shell-session.ts).
      const sessionName = parseShellSessionName(url.searchParams.get('session'));
      if (!sessionName) return refusal(400, 'session must be lowercase letters, digits and dashes (at most 32).');
      let cmd = mode === 'shell' ? shellSessionCommand(sessionName) : SHELL_CMD;
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
        engineSocket: resolved.engineSocket,
        cols,
        rows,
        exec: null,
        cmd,
        env,
        onClose,
        resumeOwner: owner,
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
