/**
 * WebSocket for one in-flight task-page action.
 *
 * Route: `GET /tasks/:id/action-runs/:runId/ws`. On upgrade the daemon replays
 * every {@link ProgressEvent} already recorded, then pushes each new one, then
 * a terminal `done` / `failed` frame. The HTTP POST that started the run
 * returns immediately (accept can run for minutes); this socket is how the
 * open dialog follows along without sitting on a request that
 * `WEB_REQUEST_DEADLINE_MS` would kill.
 *
 * Same authorization posture as the watch and shell upgraders: the dashboard
 * gate runs BEFORE the task id is looked at, because this upgrader sits ahead
 * of the HTTP handler's gate.
 *
 * Wire protocol: text frames, JSON {@link ActionRunServerMessage}.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { Storage } from '../storage';
import type { ProgressEvent } from '../daemon/progress';
import type { AcceptRemedy } from '../types/accept-remedy';
import type { WebSocketUpgrader, UpgradeOutcome } from './ws';
import { decodePathSegment } from './task-urls';
import { actionRunMatchesPath, getActionRun, subscribeActionRun, type ActionRunState } from './action-run';

export type ActionRunServerMessage =
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'done'; redirect: string }
  | { type: 'failed'; error: string; remedy?: AcceptRemedy }
  | { type: 'error'; message: string };

export function actionRunServerMessage(message: ActionRunServerMessage): string {
  return JSON.stringify(message);
}

interface ActionRunSocketData {
  taskId: string;
  runId: string;
  stop: (() => void) | null;
}

export interface ActionRunUpgraderDeps {
  getStorage: () => Promise<Storage>;
  /** Dashboard auth gate, applied to every upgrade BEFORE the run is looked up. */
  guard: (req: Request) => Promise<Response | null>;
}

const ACTION_RUN_WS_PATH_RE = /^\/tasks\/([^/]+)\/action-runs\/([^/]+)\/ws$/;

function refusal(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function framesFor(run: ActionRunState, alreadySent: number): ActionRunServerMessage[] {
  const out: ActionRunServerMessage[] = [];
  for (let i = alreadySent; i < run.events.length; i++) {
    out.push({ type: 'progress', event: run.events[i]! });
  }
  if (run.status === 'done' && run.redirect) {
    out.push({ type: 'done', redirect: run.redirect });
  } else if (run.status === 'failed') {
    out.push({
      type: 'failed',
      error: run.error ?? 'The action failed.',
      ...(run.remedy ? { remedy: run.remedy } : {}),
    });
  }
  return out;
}

export function createActionRunUpgrader(deps: ActionRunUpgraderDeps): WebSocketUpgrader {
  const handler = {
    open(ws: ServerWebSocket<ActionRunSocketData>) {
      const { taskId, runId } = ws.data;
      const run = getActionRun(runId);
      if (!run || run.taskId !== taskId) {
        try {
          ws.send(actionRunServerMessage({
            type: 'error',
            message: run ? 'This run does not belong to that task.' : 'Action run not found.',
          }));
        } catch { /* socket closing */ }
        ws.close(1008, 'run not found');
        return;
      }

      let sent = 0;
      const push = (state: ActionRunState) => {
        const frames = framesFor(state, sent);
        sent = state.events.length;
        for (const frame of frames) {
          try { ws.send(actionRunServerMessage(frame)); } catch { /* socket closing */ }
        }
        if (state.status !== 'running') {
          ws.data.stop?.();
          ws.data.stop = null;
          try { ws.close(1000, state.status); } catch { /* already closing */ }
        }
      };

      ws.data.stop = subscribeActionRun(runId, push);
    },

    // One-way: the client has nothing to say. Drop rather than parse.
    message() { /* intentionally ignored */ },

    close(ws: ServerWebSocket<ActionRunSocketData>) {
      ws.data.stop?.();
      ws.data.stop = null;
    },
  };

  return {
    handler: handler as unknown as import('bun').WebSocketHandler<unknown>,

    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      const url = new URL(req.url);
      const match = ACTION_RUN_WS_PATH_RE.exec(url.pathname);
      if (!match) return null;

      const denial = await deps.guard(req);
      if (denial) return denial;

      if (req.method !== 'GET') return refusal(405, 'Method not allowed');

      const taskIdParam = decodePathSegment(match[1]!);
      const runId = decodePathSegment(match[2]!);
      const run = getActionRun(runId);
      if (!run) return refusal(404, 'Action run not found.');

      // Same keying as the HTTP poll: a Link run is stored under a
      // per-request UUID before any task exists. A real task id (or short
      // id / code) still has to resolve and match that run's task.
      let runTaskId = run.taskId;
      if (run.taskId !== taskIdParam) {
        const storage = await deps.getStorage();
        const resolved = await storage.resolveTask(taskIdParam);
        if (!actionRunMatchesPath(run, taskIdParam, resolved.task?.id ?? null)) {
          return refusal(404, 'Action run not found.');
        }
        runTaskId = resolved.task!.id;
      }

      const data: ActionRunSocketData = {
        taskId: runTaskId,
        runId,
        stop: null,
      };
      const ok = server.upgrade(req, { data });
      if (!ok) return refusal(426, 'Expected a WebSocket upgrade request.');
      return 'upgraded';
    },
  };
}
