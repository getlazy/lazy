/**
 * Stream a PTY `docker exec` (or an attach to the container's own TTY — see
 * `ExecStreamOptions.attach`) to and from a container over the Docker Engine
 * API unix socket.
 *
 * WHY THE API AND NOT THE CLI. `lazy shell --container` runs `docker exec -it`
 * and hands the child the host TTY (`src/cli/commands/shell.ts`). The web shell
 * cannot: `docker exec -it` refuses a stdin that is not a TTY ("the input
 * device is not a TTY"), Bun has no PTY facility to hand it, and `node-pty` is
 * a native addon that cannot ride inside the compiled `lazy` binary. So for the
 * one thing the CLI cannot do — relay a PTY to a non-TTY process — we talk to
 * the Engine API directly:
 *
 *   POST /exec/create      { Tty: true, AttachStdin/out/err, Cmd }
 *   POST /exec/<id>/start   hijacked connection, raw bytes both ways
 *   POST /exec/<id>/resize  ?h=<rows>&w=<cols>
 *
 * The Docker CLI stays the source of truth for WHICH engine and for container
 * lifecycle everywhere else; this module only borrows its socket to stream. It
 * is the standard browser-terminal construction (Portainer, Dozzle, …).
 *
 * REAPING IS AUTOMATIC. The exec's PTY master is the hijacked socket. Closing
 * the socket sends the shell SIGHUP, so a dropped WebSocket cleans up its exec
 * with no bookkeeping. `close()` here closes the socket for exactly that
 * reason.
 */

import { stat } from 'fs/promises';
import { spawnSyncUnsupervised } from '../utils/spawn';
import { logger } from '../utils/logger';

/** Conventional Docker socket locations, tried in order after DOCKER_HOST and
 * `docker context`. Rootless Docker puts the socket under the user runtime dir. */
function conventionalSocketPaths(): string[] {
  const paths = ['/var/run/docker.sock'];
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) paths.push(`${runtimeDir}/docker.sock`);
  const home = process.env.HOME;
  if (home) paths.push(`${home}/.docker/run/docker.sock`); // Docker Desktop (macOS/Linux)
  return paths;
}

/** Strip a `unix://` prefix; return null for any non-unix DOCKER_HOST (tcp://,
 * ssh://) — those need a different transport this module deliberately does not
 * implement, and guessing a socket for them would be wrong. */
function unixPathFromDockerHost(dockerHost: string | undefined): string | null {
  if (!dockerHost) return null;
  if (dockerHost.startsWith('unix://')) return dockerHost.slice('unix://'.length);
  // A bare path (no scheme) is treated as a unix socket by the CLI too.
  if (dockerHost.startsWith('/')) return dockerHost;
  return null;
}

/** Ask `docker context inspect` for the current context's unix socket. Best
 * effort: any failure (no docker, tcp context) yields null and the caller falls
 * through to the conventional paths. */
function socketFromDockerContext(binary: string): string | null {
  try {
    const res = spawnSyncUnsupervised(
      [binary, 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: 10_000 },
    );
    if (res.exitCode !== 0) return null;
    const host = new TextDecoder().decode(res.stdout ?? new Uint8Array()).trim();
    return unixPathFromDockerHost(host);
  } catch (err) {
    logger.debug(`docker context inspect failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Resolve the Docker Engine unix socket path.
 *
 * Order mirrors the CLI's own resolution as closely as we can from outside it:
 * an explicit `DOCKER_HOST=unix://…`, then the active `docker context`, then
 * the conventional socket locations. A non-unix DOCKER_HOST (tcp/ssh) is a hard
 * error — this module streams over a unix socket only, and silently guessing a
 * local socket for a remote engine would exec into the wrong host.
 */
export async function resolveDockerSocketPath(binary: string = 'docker'): Promise<string> {
  const fromHost = unixPathFromDockerHost(process.env.DOCKER_HOST);
  if (fromHost) return fromHost;
  if (process.env.DOCKER_HOST && !fromHost) {
    throw new Error(
      `DOCKER_HOST is set to a non-unix endpoint (${process.env.DOCKER_HOST}); the web shell ` +
      `can only stream over a local unix socket. Unset DOCKER_HOST or point it at a unix:// socket.`,
    );
  }
  const fromContext = socketFromDockerContext(binary);
  if (fromContext) {
    if (await socketExists(fromContext)) return fromContext;
  }
  for (const candidate of conventionalSocketPaths()) {
    if (await socketExists(candidate)) return candidate;
  }
  throw new Error(
    `Could not find the Docker Engine socket. Tried the active docker context and ` +
    `${conventionalSocketPaths().join(', ')}. Is Docker running?`,
  );
}

async function socketExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isSocket();
  } catch {
    // ENOENT and friends — the socket is not at this path.
    return false;
  }
}

/** Minimal HTTP-over-unix-socket request/response for the JSON control calls
 * (create, resize, inspect). The streaming start call is handled separately in
 * {@link ExecStream} because it hijacks the connection. */
async function dockerApiRequest(
  socketPath: string,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { Host: 'docker' };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  const requestLine =
    `${method} ${apiPath} HTTP/1.1\r\n` +
    Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
    `\r\nConnection: close\r\n\r\n` +
    (payload ?? '');

  return await new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const socket = Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(requestLine);
        },
        data(_sock, data) {
          chunks.push(data);
        },
        close() {
          if (settled) return;
          settled = true;
          resolve(parseHttpResponse(Buffer.concat(chunks)));
        },
        error(_sock, err) {
          if (settled) return;
          settled = true;
          reject(err);
        },
      },
    });
    socket.catch((err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Parse a `Connection: close` HTTP/1.1 response. We control the request and
 * ask for close+no keep-alive, so the whole response is one buffer — enough for
 * the small JSON control replies; the streaming path never comes through here. */
function parseHttpResponse(raw: Buffer): { status: number; body: string } {
  const text = raw.toString('latin1');
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd === -1) return { status: 0, body: '' };
  const statusLine = text.slice(0, text.indexOf('\r\n'));
  const status = parseInt(statusLine.split(' ')[1] ?? '0', 10);
  let body = text.slice(headerEnd + 4);
  // De-chunk if the response used Transfer-Encoding: chunked.
  if (/transfer-encoding:\s*chunked/i.test(text.slice(0, headerEnd))) {
    body = dechunk(body);
  }
  return { status, body: Buffer.from(body, 'latin1').toString('utf8') };
}

function dechunk(body: string): string {
  let out = '';
  let rest = body;
  while (rest.length > 0) {
    const nl = rest.indexOf('\r\n');
    if (nl === -1) break;
    const size = parseInt(rest.slice(0, nl).trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += rest.slice(nl + 2, nl + 2 + size);
    rest = rest.slice(nl + 2 + size + 2);
  }
  return out;
}

/**
 * The engine's detach sequence for an attached stream. Docker's default is
 * ctrl-p ctrl-q, and ctrl-p is a key an interactive agent uses — the engine
 * would swallow it. A detach is only ever a socket close here, so the sequence
 * is set to one nobody types.
 */
const ATTACH_DETACH_KEYS = 'ctrl-^,ctrl-_';

export interface ExecStreamOptions {
  socketPath: string;
  container: string;
  /** In-container argv for a new exec. Ignored when `attach` is set. */
  cmd: string[];
  /**
   * Attach to the container's OWN TTY (`POST /containers/<c>/attach`) instead
   * of creating a new exec. A daemon-owned builder session runs its agent as
   * the container's main process, so an exec would start a second process
   * beside the session rather than reach it. The relay, the hijack and the
   * framing are identical; only the endpoint differs. Closing an attach
   * detaches — the container's process keeps running, which is what lets a
   * dropped socket reattach to the same session.
   */
  attach?: boolean;
  cols: number;
  rows: number;
  env?: string[];
  /** Called with raw output bytes from the exec's PTY. */
  onData: (data: Uint8Array) => void;
  /** Called once when the exec's stream ends; `code` is the exec exit code. */
  onExit: (code: number | null) => void;
}

/**
 * A live PTY exec against a container. Construct it, `await start()`, then feed
 * keystrokes with `write()` and geometry with `resize()`. `close()` tears the
 * connection down, which HUPs the shell.
 */
export class ExecStream {
  private socket: Bun.Socket<undefined> | null = null;
  private execId: string | null = null;
  private started = false;
  private closed = false;
  private sawHijackHeader = false;
  private headerBuffer = Buffer.alloc(0);

  constructor(private readonly opts: ExecStreamOptions) {}

  /** Create the exec and open the hijacked stream. Resolves once bytes can flow. */
  async start(): Promise<void> {
    if (this.opts.attach) {
      await this.openHijacked(
        `/containers/${encodeURIComponent(this.opts.container)}/attach` +
          `?stream=1&stdin=1&stdout=1&stderr=1&detachKeys=${encodeURIComponent(ATTACH_DETACH_KEYS)}`,
        '',
      );
      // Attaching does not repaint: the process drew its screen long ago. A
      // geometry change delivers SIGWINCH, which makes a full-screen program
      // redraw; resizing to the SAME size can be a no-op, so step through a
      // neighbouring size first.
      if (this.opts.rows > 1) await this.resize(this.opts.cols, this.opts.rows - 1);
      await this.resize(this.opts.cols, this.opts.rows);
      return;
    }
    const createRes = await dockerApiRequest(
      this.opts.socketPath,
      'POST',
      `/containers/${encodeURIComponent(this.opts.container)}/exec`,
      {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: this.opts.cmd,
        Env: this.opts.env,
      },
    );
    if (createRes.status !== 201) {
      throw new Error(`docker exec create failed (HTTP ${createRes.status}): ${createRes.body.trim()}`);
    }
    const parsed = JSON.parse(createRes.body) as { Id?: string };
    if (!parsed.Id) throw new Error('docker exec create returned no exec Id');
    this.execId = parsed.Id;

    await this.openHijacked(`/exec/${this.execId}/start`, JSON.stringify({ Detach: false, Tty: true }));
    // Apply the initial geometry now that the exec exists.
    await this.resize(this.opts.cols, this.opts.rows);
  }

  private openHijacked(apiPath: string, body: string): Promise<void> {
    const request =
      `POST ${apiPath} HTTP/1.1\r\n` +
      `Host: docker\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: Upgrade\r\n` +
      `Upgrade: tcp\r\n\r\n` +
      body;

    return new Promise((resolve, reject) => {
      let opened = false;
      const conn = Bun.connect({
        unix: this.opts.socketPath,
        socket: {
          open: (sock) => {
            this.socket = sock;
            this.started = true;
            opened = true;
            sock.write(request);
            resolve();
          },
          data: (_sock, data) => this.onSocketData(data),
          close: () => this.handleClose(),
          error: (_sock, err) => {
            if (!opened) reject(err);
            else logger.debug(`web-shell exec socket error: ${err instanceof Error ? err.message : err}`);
          },
        },
      });
      conn.catch((err) => { if (!opened) reject(err); });
    });
  }

  /** Consume the hijack's HTTP response header (up to the blank line) once,
   * then treat everything after as raw PTY output. With Tty:true there is no
   * multiplexing frame header — the bytes are the terminal stream verbatim. */
  private onSocketData(data: Uint8Array): void {
    if (this.sawHijackHeader) {
      this.opts.onData(data);
      return;
    }
    this.headerBuffer = Buffer.concat([this.headerBuffer, Buffer.from(data)]);
    const marker = this.headerBuffer.indexOf('\r\n\r\n');
    if (marker === -1) return; // header still arriving
    this.sawHijackHeader = true;
    const rest = this.headerBuffer.subarray(marker + 4);
    this.headerBuffer = Buffer.alloc(0);
    if (rest.length > 0) this.opts.onData(rest);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    void this.reportExit();
  }

  /** After the stream closes, inspect the exec for its exit code. Best effort —
   * a gone container just yields null, which the caller renders as "ended". */
  private async reportExit(): Promise<void> {
    let code: number | null = null;
    try {
      if (this.opts.attach) {
        // The attached stream ends when the container's process does.
        const res = await dockerApiRequest(
          this.opts.socketPath,
          'GET',
          `/containers/${encodeURIComponent(this.opts.container)}/json`,
        );
        if (res.status === 200) {
          const info = JSON.parse(res.body) as { State?: { Running?: boolean; ExitCode?: number | null } };
          code = info.State?.Running ? null : info.State?.ExitCode ?? null;
        }
      } else if (this.execId) {
        const res = await dockerApiRequest(this.opts.socketPath, 'GET', `/exec/${this.execId}/json`);
        if (res.status === 200) {
          const info = JSON.parse(res.body) as { ExitCode?: number | null };
          code = info.ExitCode ?? null;
        }
      }
    } catch (err) {
      logger.debug(`web-shell exec inspect failed: ${err instanceof Error ? err.message : err}`);
    }
    this.opts.onExit(code);
  }

  /** Forward keystroke bytes to the exec's stdin. */
  write(data: Uint8Array): void {
    if (this.socket && this.started && !this.closed) {
      this.socket.write(data);
    }
  }

  /** Resize the exec's PTY. Sent as a separate control request per the API. */
  async resize(cols: number, rows: number): Promise<void> {
    if (this.closed) return;
    const base = this.opts.attach
      ? `/containers/${encodeURIComponent(this.opts.container)}`
      : this.execId ? `/exec/${this.execId}` : null;
    if (!base) return;
    try {
      await dockerApiRequest(
        this.opts.socketPath,
        'POST',
        `${base}/resize?h=${Math.floor(rows)}&w=${Math.floor(cols)}`,
      );
    } catch (err) {
      // A resize race against a just-exited exec is harmless; log and move on.
      logger.debug(`web-shell exec resize failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Close the hijacked connection — HUPs the shell inside the container. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.end();
    } catch (err) {
      logger.debug(`web-shell exec close failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
