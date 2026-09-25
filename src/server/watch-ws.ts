/**
 * Watch WebSocket upgrader: the daemon side of `lazy watch` in the browser.
 *
 * Route: `GET /tasks/:id/watch/ws`. On upgrade the daemon starts the same three
 * streams the CLI tails — proxy traffic (`net>`), supervisor stdout (`sup>`) and
 * the agent's own session JSONL, plus the five-second status header — and sends
 * the rendered lines to the browser's xterm.js panel. Read-only: nothing the
 * client sends is ever acted on.
 *
 * WHY IN-PROCESS AND NOT OVER RPC
 * The CLI reaches proxy traffic through the daemon's `watchProxyActivity` RPC.
 * Inside the daemon that round trip is not just wasted, it does not work —
 * `tryRpc` deliberately returns null in the daemon process. Here the activity
 * bus (src/proxy/activity.ts) is a local object, so the panel subscribes to it
 * directly and replays its ring for the lines that landed just before the
 * reviewer opened the panel.
 *
 * AUTHORIZATION
 * Every upgrade passes the caller's `guard` (in production `guardDashboardRequest`)
 * BEFORE the method or the task id is looked at, exactly as the shell upgrader
 * does — the upgrader runs ahead of the HTTP handler's dashboard gate, so a
 * route that skipped it would be the one unauthenticated route on the port.
 * Watch shows what an agent is doing, including its prompts and file contents,
 * so it is no less sensitive than the pages themselves.
 *
 * COLOR
 * The rendered lines carry ANSI, which xterm.js renders natively. The daemon's
 * own stdout is not a TTY, so every render goes through `renderWithColors`
 * (src/render/theme.ts) — otherwise the panel would show colorless text purely
 * because of which process built the string.
 *
 * Wire protocol: binary frames are output bytes to write verbatim; text frames
 * are JSON control messages ({@link WatchServerMessage}).
 */

import { open as openFile, stat } from 'fs/promises';
import type { Server, ServerWebSocket } from 'bun';
import type { Storage } from '../storage';
import type { Task } from '../types';
import type { FollowHandle, Runner } from '../runner/types';
import { createRunner } from '../runner';
import { taskRef, getWorktreePath, displayId } from '../task/identity';
import { findLatestSessionFile } from '../agent/session-discovery';
import { renderEntryLines, type RawLogEntry } from '../render/watch-renderer';
import { renderProxyActivity, credentialRefusalHint, PROXY_LINE_PREFIX } from '../render/proxy-activity-renderer';
import { proxyActivity, matchesFilter, type ProxyActivityEvent } from '../proxy/activity';
import { protocolDir as getProtocolDir, readStatus } from '../protocol';
import { renderStatusHeader } from '../render/status-header';
import { formatWorkingSubstate, type WorkingSubstate } from '../utils/working-substate';
import { readTaskWorkingSubstate } from '../utils/working-run';
import { dim, renderWithColors } from '../render/theme';
import { logger } from '../utils/logger';
import type { WebSocketUpgrader, UpgradeOutcome } from './ws';
import { decodePathSegment } from './task-urls';
import type { RpcAuthResult } from '../daemon/rpc-auth';
import { rpcAuthErrorMessage } from '../daemon/rpc-auth';

/** Same cadence as `lazy watch`, so the two surfaces feel identical. */
const POLL_INTERVAL_MS = 500;
const STATUS_CHECK_INTERVAL_MS = 5000;

/** How many replayed proxy lines a freshly-opened panel starts with. */
const REPLAY_LIMIT = 40;

/** Control messages the server sends as TEXT frames. */
export type WatchServerMessage =
  | { type: 'ready'; task: string }
  /** The task exists but nothing is running right now — the panel says so
   * rather than looking like a stream that has silently broken. */
  | { type: 'idle'; status: string }
  /** The task left `working` while the panel was open; the stream is over. */
  | { type: 'ended'; status: string }
  | { type: 'error'; message: string };

export function watchServerMessage(message: WatchServerMessage): string {
  return JSON.stringify(message);
}

/** Per-connection state carried by the WebSocket, set at upgrade time. */
interface WatchSocketData {
  root: string;
  taskId: string;
  getStorage: () => Promise<Storage>;
  stop: (() => void) | null;
}

export interface WatchUpgraderDeps {
  /** Resolves the daemon's storage. A thunk, not a value, because the upgrader
   * is constructed at bind time — before storage initialization completes. */
  getStorage: () => Promise<Storage>;
  root: string;
  /** The dashboard's auth gate, applied to every upgrade request BEFORE the
   * task is even looked up. Returns a denial Response (sign-in 401, wrong-host,
   * managed-mode 404) or null to let the upgrade proceed. */
  guard: (req: Request) => Promise<Response | null>;
  /** The route this upgrader answers; defaults to the dashboard's. */
  path?: RegExp;
}

const WATCH_WS_PATH_RE = /^\/tasks\/([^/]+)\/watch\/ws$/;

/**
 * The same stream on an AUTHENTICATED route that is not the dashboard's —
 * what a Teams relay opens, since the dashboard's routes 404 in managed mode.
 * Gated exactly as the session-attach route is (./session-attach-ws.ts):
 * `/rpc/*` actor-token authentication and the project header, applied before
 * the task is looked up. Read-only either way.
 */
export const RPC_WATCH_WS_PATH_RE = /^\/rpc\/tasks\/([^/]+)\/watch\/ws$/;

export function rpcWatchPath(taskId: string): string {
  return `/rpc/tasks/${encodeURIComponent(taskId)}/watch/ws`;
}

export function createRpcWatchUpgrader(deps: {
  getStorage: () => Promise<Storage>;
  root: string;
  authenticate: (req: Request) => Promise<RpcAuthResult>;
}): WebSocketUpgrader {
  return createWatchUpgrader({
    getStorage: deps.getStorage,
    root: deps.root,
    path: RPC_WATCH_WS_PATH_RE,
    guard: async (req) => {
      const auth = await deps.authenticate(req);
      if (!auth.ok) return Response.json({ error: rpcAuthErrorMessage(auth.failure) }, { status: 401 });
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      if (reqProject !== deps.root) {
        return Response.json(
          { error: `Project mismatch: daemon serves ${deps.root}, request is for ${reqProject}` },
          { status: 400 },
        );
      }
      return null;
    },
  });
}

function refusal(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Where the watch stream writes its lines, and how it reports the end. */
export interface WatchSink {
  /** One rendered line (may itself contain newlines). */
  line: (text: string) => void;
  /** A control message. */
  control: (message: WatchServerMessage) => void;
}

/**
 * Start streaming a task's activity into `sink`. Returns a stop function that
 * tears down every stream it started.
 *
 * Exported for testing: it takes its storage, root and sink as parameters and
 * touches no daemon globals other than the proxy activity bus.
 */
export function startTaskWatchStream(opts: {
  root: string;
  storage: Storage;
  task: Task;
  sink: WatchSink;
}): () => void {
  const { root, storage, task, sink } = opts;
  const protoDir = getProtocolDir(task.id);
  const worktreePath = getWorktreePath(root, task);

  let running = true;
  let followHandle: FollowHandle | null = null;
  let unsubscribe: (() => void) | null = null;

  const emit = (text: string) => { if (running) sink.line(text); };

  const stop = () => {
    if (!running) return;
    running = false;
    try { unsubscribe?.(); } catch { /* already gone */ }
    try { followHandle?.process.kill(); } catch { /* best effort */ }
  };

  // ── Proxy traffic: the one agent-agnostic signal (see src/cli/commands/watch.ts).
  const seen = new Set<string>();
  const paint = (event: ProxyActivityEvent) => {
    const key = `${event.kind}:${event.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Every field here can originate in the agent's own request; the renderer's
    // `safe()` strips control characters before any of it reaches a terminal.
    emit(renderWithColors(() => renderProxyActivity(event, { includeTask: false })));
    const hint = renderWithColors(() => credentialRefusalHint(event));
    if (hint) emit(hint);
  };

  // The proxy stamps events with the REF the agent was launched under (a code,
  // or a short id), never necessarily the full id we hold here — so pass every
  // form this task answers to, exactly as ProxyActivityFilter asks callers to.
  const taskForms = [...new Set([task.id, displayId(task), taskRef(task), task.code]
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0))];
  const proxyFilter = { taskIds: taskForms };

  emit(renderWithColors(() => dim(`${PROXY_LINE_PREFIX} agent API requests through lazy's proxy`)));
  for (const event of proxyActivity.recentEvents(proxyFilter).slice(-REPLAY_LIMIT)) {
    paint(event);
  }
  unsubscribe = proxyActivity.subscribe((event) => {
    if (!running) return;
    if (!matchesFilter(event, proxyFilter)) return;
    paint(event);
  });

  // ── Supervisor stdout and the agent JSONL, both behind the runner.
  void (async () => {
    let runner: Runner;
    try {
      runner = await createRunner(root);
    } catch (err) {
      emit(renderWithColors(() => dim(`(supervisor and agent streams unavailable: ${err instanceof Error ? err.message : String(err)})`)));
      return;
    }
    if (!running) return;

    let runName: string | null = null;
    try {
      const session = await storage.getSessionByTaskId(task.id);
      runName = session?.container_name ?? runner.runNameForTask(taskRef(task));
      followHandle = runner.followOutput(runName);
    } catch {
      // Supervisor follow unavailable (e.g. Docker daemon down) — the agent
      // stream still works because it reads the JSONL off the filesystem.
    }
    if (!running) { try { followHandle?.process.kill(); } catch { /* best effort */ } return; }

    void streamSupervisor(followHandle, emit, () => running);
    const substate = () => readTaskWorkingSubstate(root, storage, task.id, runner);
    await printHeader(protoDir, substate, emit);
    await tailAgentSession(runner.agentSessionProjectDir(worktreePath), {
      protoDir,
      runner,
      runName,
      storage,
      task,
      substate,
      sink,
      emit,
      isRunning: () => running,
      stop,
    });
  })();

  return stop;
}

async function streamSupervisor(
  followHandle: FollowHandle | null,
  emit: (line: string) => void,
  isRunning: () => boolean,
): Promise<void> {
  const stdout = followHandle?.stdout;
  if (!stdout) return;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (isRunning()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        emit(renderWithColors(() => dim(`sup> ${line}`)));
      }
    }
    if (buffer.trim()) emit(renderWithColors(() => dim(`sup> ${buffer}`)));
  } catch {
    // Stream ended — normal on supervisor exit.
  }
}

async function tailAgentSession(
  projectDir: string,
  ctx: {
    protoDir: string;
    runner: Runner;
    runName: string | null;
    storage: Storage;
    task: Task;
    /** The task's live working substate, probed the reconciler's way. */
    substate: () => Promise<WorkingSubstate | null>;
    sink: WatchSink;
    emit: (line: string) => void;
    isRunning: () => boolean;
    stop: () => void;
  },
): Promise<void> {
  let currentFile: string | null = null;
  let lastFileSize = 0;
  let partialLine = '';
  let lastStatusCheck = Date.now();
  let lastHeaderPrint = Date.now();
  let announcedIdle = false;

  while (ctx.isRunning()) {
    const newest = (await findLatestSessionFile(projectDir))?.path ?? null;
    if (newest && newest !== currentFile) {
      currentFile = newest;
      lastFileSize = 0;
      partialLine = '';
    }

    if (currentFile) {
      let fileSize: number | null = null;
      try {
        fileSize = (await stat(currentFile)).size;
      } catch {
        // File vanished mid-turn (worktree cleanup); pick it up again next tick.
      }
      if (fileSize !== null && fileSize > lastFileSize) {
        const newBytes = await readTail(currentFile, lastFileSize, fileSize);
        lastFileSize = fileSize;
        if (newBytes) {
          const chunk = partialLine + newBytes;
          const lines = chunk.split('\n');
          partialLine = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let entry: RawLogEntry;
            try {
              entry = JSON.parse(line) as RawLogEntry;
            } catch {
              continue; // Malformed JSON — agent may be mid-write.
            }
            for (const rendered of renderWithColors(() => renderEntryLines(entry))) {
              ctx.emit(rendered);
            }
          }
        }
      }
    }

    const now = Date.now();
    if (now - lastHeaderPrint >= STATUS_CHECK_INTERVAL_MS) {
      lastHeaderPrint = now;
      await printHeader(ctx.protoDir, ctx.substate, ctx.emit);
    }

    if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL_MS) {
      lastStatusCheck = now;
      try {
        const current = await ctx.storage.getTask(ctx.task.id);
        const status = current?.status ?? 'unknown';
        if (status !== 'working') {
          // A panel opened on a task that is not running is the ordinary case —
          // the reviewer clicked Watch on a blocked task. Say so once and keep
          // the socket open, because an unblock can start a turn at any moment
          // and the reviewer should see it without reconnecting.
          if (!announcedIdle) {
            announcedIdle = true;
            ctx.sink.control({ type: 'idle', status });
            ctx.emit(renderWithColors(() => dim(`Task ${displayId(ctx.task)} is not running (status: ${status}).`)));
          }
        } else if (announcedIdle) {
          announcedIdle = false;
          ctx.sink.control({ type: 'ready', task: displayId(ctx.task) });
        }
      } catch {
        // Storage query failed — non-fatal, retry next tick.
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function printHeader(
  protoDir: string,
  liveSubstate: () => Promise<WorkingSubstate | null>,
  emit: (line: string) => void,
): Promise<void> {
  const status = readStatus(protoDir);
  let line = renderWithColors(() => renderStatusHeader(status));
  try {
    // The reconciler's own liveness question — see src/utils/working-run.ts.
    const substate = await liveSubstate();
    const suffix = substate && substate.kind === 'harness' && substate.retry
      ? formatWorkingSubstate({ ...substate, retry: undefined })
      : substate && formatWorkingSubstate(substate);
    if (suffix) line += `  [${suffix}]`;
  } catch {
    // Liveness probe failed — the header half is still useful on its own.
  }
  if (!line.trim()) return;
  emit(renderWithColors(() => dim(line)));
}

async function readTail(filePath: string, start: number, end: number): Promise<string | null> {
  let fh;
  try {
    fh = await openFile(filePath, 'r');
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, end - start, start);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWatchUpgrader(deps: WatchUpgraderDeps): WebSocketUpgrader {
  const handler = {
    async open(ws: ServerWebSocket<WatchSocketData>) {
      const data = ws.data;
      const encoder = new TextEncoder();
      const sink: WatchSink = {
        line: (text) => {
          try { ws.sendBinary(encoder.encode(text + '\r\n')); } catch { /* socket closing */ }
        },
        control: (message) => {
          try { ws.send(watchServerMessage(message)); } catch { /* socket closing */ }
        },
      };
      try {
        const storage = await data.getStorage();
        const task = await storage.getTask(data.taskId);
        if (!task) {
          sink.control({ type: 'error', message: `Task not found: ${data.taskId}` });
          ws.close(1011, 'task not found');
          return;
        }
        sink.control({ type: 'ready', task: task.code ?? task.id });
        data.stop = startTaskWatchStream({ root: data.root, storage, task, sink });
      } catch (err) {
        logger.warn(`web-watch failed to start: ${err instanceof Error ? err.message : err}`);
        sink.control({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        ws.close(1011, 'watch start');
      }
    },

    // Read-only surface: the client has nothing to say, and anything it sends is
    // dropped rather than parsed. Nothing here can reach a shell or a filesystem.
    message() { /* intentionally ignored — watch is one-way */ },

    close(ws: ServerWebSocket<WatchSocketData>) {
      ws.data.stop?.();
      ws.data.stop = null;
    },
  };

  return {
    handler: handler as unknown as import('bun').WebSocketHandler<unknown>,

    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const url = new URL(req.url);
      const match = (deps.path ?? WATCH_WS_PATH_RE).exec(url.pathname);
      if (!match) return null; // not our route

      // Authorization FIRST — before the method or the task id says anything,
      // exactly as the shell upgrader does.
      const denial = await deps.guard(req);
      if (denial) return denial;

      if (req.method !== 'GET') return refusal(405, 'Method not allowed');

      const taskIdParam = decodePathSegment(match[1]);
      const storage = await deps.getStorage();
      const task = await storage.getTask(taskIdParam);
      if (!task) return refusal(404, `Task not found: ${taskIdParam}`);

      const data: WatchSocketData = {
        root: deps.root,
        taskId: task.id,
        getStorage: deps.getStorage,
        stop: null,
      };
      const ok = server.upgrade(req, { data });
      if (!ok) return refusal(426, 'Expected a WebSocket upgrade request.');
      return 'upgraded';
    },
  };
}
