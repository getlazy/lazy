/**
 * A terminal on THIS machine attached to a session running on the server,
 * through Lazy Teams' relay route:
 *
 *   GET <teams>/api/projects/<team>/<project>/sessions/<id>/attach   (upgrade)
 *   Authorization: Bearer <this clone's CLI-scoped ApiToken>
 *
 * Teams authorizes the request with the same policy the browser's terminal
 * uses and relays frames verbatim to the daemon's own attach route
 * (`/rpc/sessions/:id/attach/ws`, src/server/session-attach-ws.ts). So the
 * framing here is the web shell's, unchanged — ../server/shell-protocol.ts:
 * binary frames are raw terminal bytes, text frames are JSON control. Nothing
 * in this module is a second terminal protocol; it is the protocol's client.
 *
 * What a bound clone's `lazy builder` / `pair` / `shell` run instead of
 * launching anything locally (design doc §5.1, §7.3 task 12). The session lives
 * on the server: leaving this terminal DETACHES, and the session keeps running
 * until somebody ends it explicitly.
 */

import {
  DEFAULT_TERM_COLS,
  DEFAULT_TERM_ROWS,
  MAX_TERM_COLS,
  MAX_TERM_ROWS,
  MIN_TERM_DIM,
  parseShellServerMessage,
  shellClientMessage,
} from '../server/shell-protocol';

/**
 * The local detach key: ctrl-] (0x1d), telnet's escape. Every other byte —
 * ctrl-c included — belongs to the remote session, so a key has to be reserved
 * for leaving it, and this is the one terminal users already know means "get me
 * out of this connection". Deliberately not Docker's ctrl-p ctrl-q, which the
 * daemon's attach moved off so the agent keeps ctrl-p.
 */
export const DETACH_BYTE = 0x1d;

/** Which terminal mode the daemon's attach route should plan for this session. */
export type RemoteAttachMode = 'attach' | 'shell' | 'pair' | 'chat';

export interface RemoteAttachUrlInput {
  teamsUrl: string;
  /** `<team>/<project>`, as the clone's binding records it. */
  project: string;
  sessionId: string;
  cols: number;
  rows: number;
  /** Omitted for a builder session, which is attached to rather than entered. */
  mode?: RemoteAttachMode;
}

/** The relay route on Teams for one session, as a ws:// or wss:// URL. */
export function remoteAttachUrl(input: RemoteAttachUrlInput): string {
  const base = new URL(input.teamsUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const projectPath = input.project.split('/').map(encodeURIComponent).join('/');
  const url = new URL(
    `${base.pathname.replace(/\/$/, '')}/api/projects/${projectPath}/sessions/${encodeURIComponent(input.sessionId)}/attach`,
    base,
  );
  url.searchParams.set('cols', String(input.cols));
  url.searchParams.set('rows', String(input.rows));
  if (input.mode && input.mode !== 'attach') url.searchParams.set('mode', input.mode);
  return url.toString();
}

function clamp(n: number | undefined, fallback: number, max: number): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, MIN_TERM_DIM), max);
}

/** The local terminal's size, clamped to what the protocol accepts. */
export function localTerminalSize(out: { columns?: number; rows?: number }): { cols: number; rows: number } {
  return {
    cols: clamp(out.columns, DEFAULT_TERM_COLS, MAX_TERM_COLS),
    rows: clamp(out.rows, DEFAULT_TERM_ROWS, MAX_TERM_ROWS),
  };
}

export type RemoteTerminalOutcome =
  /** The person pressed the detach key, or local input ended. The session keeps running. */
  | { kind: 'detached' }
  /** The remote process exited — the session's own program ended. */
  | { kind: 'exited'; code: number | null }
  /** The connection closed or failed from the far side. */
  | { kind: 'closed'; message: string };

export interface RemoteTerminalIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/**
 * Relay one remote session to this process's terminal until it ends, the
 * person detaches, or the connection drops.
 *
 * Raw mode is taken only on a TTY and always given back. Without a TTY (a
 * script, a test) bytes are relayed as they are, and the END of local input
 * detaches: a pipe that has nothing more to say has left the session, it has
 * not ended it.
 */
export async function runRemoteTerminal(opts: {
  url: string;
  token: string;
  io?: RemoteTerminalIo;
  /** Test seam: the WebSocket constructor. */
  webSocket?: typeof WebSocket;
}): Promise<RemoteTerminalOutcome> {
  const io = opts.io ?? { stdin: process.stdin, stdout: process.stdout };
  const Ws = opts.webSocket ?? WebSocket;
  // Bun's client takes headers on the constructor — the one reason the relay
  // route can be authenticated by a bearer token rather than a cookie.
  const ws = new Ws(opts.url, { headers: { Authorization: `Bearer ${opts.token}` } } as never);
  ws.binaryType = 'arraybuffer';

  const isTty = io.stdin.isTTY === true && typeof io.stdin.setRawMode === 'function';
  let rawTaken = false;
  let settled = false;
  let open = false;
  let exited: RemoteTerminalOutcome | null = null;
  let errorText: string | null = null;

  return await new Promise<RemoteTerminalOutcome>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const detachAt = isTty ? bytes.indexOf(DETACH_BYTE) : -1;
      const payload = detachAt === -1 ? bytes : bytes.subarray(0, detachAt);
      if (payload.length > 0 && open) ws.send(payload);
      if (detachAt !== -1) finish({ kind: 'detached' });
    };
    const onEnd = () => finish({ kind: 'detached' });
    const onResize = () => {
      if (!open) return;
      const size = localTerminalSize(io.stdout);
      ws.send(shellClientMessage({ type: 'resize', cols: size.cols, rows: size.rows }));
    };

    function finish(outcome: RemoteTerminalOutcome) {
      if (settled) return;
      settled = true;
      io.stdin.off('data', onData);
      io.stdin.off('end', onEnd);
      io.stdout.off('resize', onResize);
      if (rawTaken) io.stdin.setRawMode(false);
      io.stdin.pause();
      try {
        ws.close();
      } catch (err) {
        // Closing a socket that is already closing is the only way this
        // throws, and the outcome is decided either way — nothing to recover.
        void err;
      }
      resolve(outcome);
    }

    ws.onopen = () => {
      open = true;
      if (isTty) {
        io.stdin.setRawMode(true);
        rawTaken = true;
      }
      io.stdin.on('data', onData);
      io.stdin.on('end', onEnd);
      io.stdout.on('resize', onResize);
      io.stdin.resume();
      onResize();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        const parsed = parseShellServerMessage(ev.data);
        if (!parsed.ok) return; // A malformed control frame is ignored, never fatal.
        if (parsed.message.type === 'exit') exited = { kind: 'exited', code: parsed.message.code };
        if (parsed.message.type === 'error') errorText = parsed.message.message;
        return;
      }
      io.stdout.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => {
      errorText ??= open ? 'the connection to Lazy Teams failed' : 'Lazy Teams refused or could not complete the attach';
    };
    ws.onclose = (ev: CloseEvent) => {
      if (exited) return finish(exited);
      const why = errorText ?? (ev.reason || `the connection closed (code ${ev.code})`);
      finish({ kind: 'closed', message: why });
    };
  });
}
