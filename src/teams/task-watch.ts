/**
 * A task's Watch stream on THIS machine, read through Lazy Teams' relay route:
 *
 *   GET <teams>/api/projects/<team>/<project>/tasks/<id>/watch   (upgrade)
 *   Authorization: Bearer <this clone's CLI-scoped ApiToken>
 *
 * Teams relays to the daemon's read-only watch stream (`/rpc/tasks/:id/watch/ws`,
 * src/server/watch-ws.ts): binary frames are rendered lines, text frames are
 * JSON control messages. This is what `--follow` runs in a bound clone, where
 * there is no local container whose output could be followed.
 */

import type { WatchServerMessage } from '../server/watch-ws';

export interface RemoteWatchUrlInput {
  teamsUrl: string;
  /** `<team>/<project>`, as the clone's binding records it. */
  project: string;
  projectId?: string;
  taskId: string;
}

export function remoteWatchUrl(input: RemoteWatchUrlInput): string {
  const base = new URL(input.teamsUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const projectPath = input.project.split('/').map(encodeURIComponent).join('/');
  const url = new URL(
    `${base.pathname.replace(/\/$/, '')}/api/projects/${projectPath}/tasks/${encodeURIComponent(input.taskId)}/watch`,
    base,
  );
  if (input.projectId) url.searchParams.set('project_id', input.projectId);
  return url.toString();
}

export type RemoteWatchOutcome =
  /** The task left `working` (or was never running): the stream is over. */
  | { kind: 'ended'; status: string | null }
  /** The server reported an error, or the connection failed. */
  | { kind: 'failed'; message: string };

/**
 * Stream the watch lines to `out` until the server says the task stopped
 * working, refuses, or the connection drops. Read-only: nothing is sent.
 */
export async function runRemoteWatch(opts: {
  url: string;
  token: string;
  out?: { write(chunk: Uint8Array | string): unknown };
  /** Test seam: the WebSocket constructor. */
  webSocket?: typeof WebSocket;
}): Promise<RemoteWatchOutcome> {
  const out = opts.out ?? process.stdout;
  const Ws = opts.webSocket ?? WebSocket;
  const ws = new Ws(opts.url, { headers: { Authorization: `Bearer ${opts.token}` } } as never);
  ws.binaryType = 'arraybuffer';

  return await new Promise<RemoteWatchOutcome>((resolve) => {
    let settled = false;
    let errorText: string | null = null;
    let ended: RemoteWatchOutcome | null = null;
    const finish = (outcome: RemoteWatchOutcome) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (err) {
        // Closing a socket that is already closing is the only way this throws;
        // the outcome is decided either way.
        void err;
      }
      resolve(outcome);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        out.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let msg: WatchServerMessage;
      try {
        msg = JSON.parse(ev.data) as WatchServerMessage;
      } catch {
        return; // A malformed control frame is ignored, never fatal.
      }
      if (msg.type === 'ended' || msg.type === 'idle') ended = { kind: 'ended', status: msg.status };
      if (msg.type === 'error') errorText = msg.message;
      if (ended) finish(ended);
    };
    ws.onerror = () => {
      errorText ??= 'Lazy Teams refused or could not complete the watch connection';
    };
    ws.onclose = (ev: CloseEvent) => {
      if (ended) return finish(ended);
      finish({ kind: 'failed', message: errorText ?? (ev.reason || `the connection closed (code ${ev.code})`) });
    };
  });
}
