/**
 * How the host reaches a smolvm machine's dockerd: a unix socket this process
 * owns, relayed connection by connection through `smolvm machine exec -i --
 * docker system dial-stdio`.
 *
 * ## Why this channel
 *
 * The docker runner drives a Docker engine with the `docker` CLI (and, for the
 * web shell, the Engine API over a unix socket). The engine here is in the
 * guest, so something on the host must stand in for `/var/run/docker.sock`.
 * Publishing dockerd on a host TCP port would hand root in the guest — every
 * share, every task's MCP config — to any local user who can connect to
 * loopback. A unix socket in a fresh 0700 directory under the user's own
 * 0700 `/tmp/lazy-<uid>` can be reached only by that user (and root), which
 * is exactly who can already run lazy.
 *
 * Behind the socket, each connection is one `smolvm machine exec -i` running
 * `docker system dial-stdio` in the guest: the docker CLI's own "this stdio is
 * a connection to the engine" helper (what `DOCKER_HOST=ssh://…` runs on the
 * far side), so HTTP, hijacked streams (`exec -i`, `attach`, `logs -f`) and
 * half-closes are the engine's to handle, not lazy's. Nothing new listens in
 * the guest and nothing is published from it.
 *
 * smolvm has its own `docker_socket` Smolfile option that bridges the guest
 * socket over vsock (spike §4); it is not used because nothing here has
 * verified it on the pinned release, while `machine exec -i` streaming stdin is
 * measured (probe S16).
 *
 * The socket is PER PROCESS (named by pid): every lazy process that needs the
 * engine — the daemon, a CLI command — serves its own, so none depends on
 * another being alive. Files of dead processes are swept when a relay starts.
 *
 * Before a connection is relayed, the machine must be RUNNING
 * (`ensureServing`) — and that is all: the relay never creates or starts a
 * machine, and never applies a launch's checks (the smolvm pin, the
 * needs-recreate comparison). Those refuse LAUNCHES; refusing `ps`, `inspect`,
 * `stop` or `rm` as well would make live containers look dead and leave them
 * impossible to stop. When the machine is not running, the connection is
 * answered with an Engine-API error carrying the reason, so whichever docker
 * command asked prints "Error response from daemon: <why>" instead of an
 * opaque EOF.
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'fs/promises';
import { createServer, type Server, type Socket } from 'net';
import { dirname, join } from 'path';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { SMOLVM_ENV } from './smolvm-docker-machine';

/** The longest unix socket path macOS accepts is 103 bytes plus the NUL. */
export const MAX_SOCKET_PATH = 103;

/** Older Bun ignores allowHalfOpen on Unix sockets, truncating Docker attach streams. */
export const MIN_DOCKER_RELAY_BUN_VERSION = '1.4.3';

export function requireDockerRelayRuntime(version = Bun.version): void {
  if (!Bun.semver.satisfies(version, `>=${MIN_DOCKER_RELAY_BUN_VERSION}`)) {
    throw new RelaySocketError(
      `Bun ${version} cannot preserve attached Docker output on the Unix socket relay. ` +
      `Build lazy with Bun ${MIN_DOCKER_RELAY_BUN_VERSION} or newer (run mise install, then mise exec -- bun run build in the checkout).`,
    );
  }
}

export interface DialedProcess {
  stdin: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(): void;
}

export interface RelayOptions {
  socketPath: string;
  /**
   * The relay's ONLY precondition: the machine is running. Throws a
   * human-readable reason otherwise. Never pins, compares or creates —
   * inspecting and stopping what already runs must keep working whatever a
   * launch would refuse.
   */
  ensureServing: () => Promise<void>;
  /** One connection to the guest engine. */
  dial: () => DialedProcess;
  /** Called when a dial dies before saying anything, so the next connection re-checks the machine. */
  onDialFailed?: (stderr: string) => void;
}

/** `smolvm machine exec -i --name <m> -- docker system dial-stdio`, with lazy's smolvm environment. */
export function smolvmDial(smolvm: string, machine: string): () => DialedProcess {
  return () => spawn([smolvm, 'machine', 'exec', '-i', '--name', machine, '--', 'docker', 'system', 'dial-stdio'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    // A relayed connection lives as long as the docker command using it
    // (`logs -f`, an attached exec); the command's own timeout bounds it.
    timeout: 0,
    env: { ...process.env, ...SMOLVM_ENV },
  }) as unknown as DialedProcess;
}

/** An Engine-API error response: the docker CLI prints `message` as "Error response from daemon: …". */
export function engineErrorResponse(message: string): string {
  const body = JSON.stringify({ message });
  return `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

async function pipeOut(stream: ReadableStream<Uint8Array>, sock: Socket, onChunk: () => void): Promise<void> {
  for await (const chunk of stream) {
    onChunk();
    if (sock.destroyed) return;
    if (!sock.write(chunk)) await new Promise<void>((r) => { sock.once('drain', r); sock.once('close', r); });
  }
}

function handle(sock: Socket, opts: RelayOptions): void {
  sock.once('error', (err) => logger.debug(`docker relay: client socket: ${err.message}`));
  sock.pause();
  void (async () => {
    try {
      await opts.ensureServing();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // Answer the request the client already sent, then close.
      sock.once('data', () => sock.end(engineErrorResponse(why)));
      sock.resume();
      return;
    }
    let proc: DialedProcess;
    try { proc = opts.dial(); }
    catch (err) {
      sock.destroy();
      logger.warn(`docker relay: could not start smolvm machine exec: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let sawOutput = false;
    let stderr = '';
    // A dial that already exited (machine exec refused, engine down) makes the
    // write fail with EPIPE. That is not this connection's error to throw — an
    // uncaught throw here took the whole process down — and the exit path
    // below answers it: the client is ended and the failure logged.
    let stdinClosed = false;
    const stdinFailed = (err: unknown) => {
      if (stdinClosed) return;
      stdinClosed = true;
      logger.debug(`docker relay: dial-stdio stopped reading: ${err instanceof Error ? err.message : String(err)}`);
    };
    sock.on('data', (chunk: Buffer) => {
      if (stdinClosed) return;
      try {
        proc.stdin.write(chunk);
        const flushed = proc.stdin.flush();
        if (flushed instanceof Promise) { sock.pause(); void flushed.catch(stdinFailed).finally(() => sock.resume()); }
      } catch (err) { stdinFailed(err); }
    });
    // The client half-closed: the engine sees EOF on dial-stdio's stdin.
    sock.on('end', () => {
      if (stdinClosed) return;
      try { void Promise.resolve(proc.stdin.end()).catch(stdinFailed); } catch (err) { stdinFailed(err); }
    });
    sock.on('close', () => proc.kill());
    void (async () => { for await (const c of proc.stderr) stderr += new TextDecoder().decode(c); })();
    sock.resume();
    try { await pipeOut(proc.stdout, sock, () => { sawOutput = true; }); }
    finally {
      const code = await proc.exited;
      if (!sawOutput && code !== 0) {
        opts.onDialFailed?.(stderr.trim());
        logger.warn(`docker relay: smolvm machine exec … docker system dial-stdio exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
      }
      sock.end();
    }
  })();
}

export interface RelayHandle {
  socketPath: string;
  close(): Promise<void>;
}

export class RelaySocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelaySocketError';
  }
}

/**
 * Listen on `socketPath` and relay every connection. The socket's directory
 * must already be private ({@link makeRelaySocketDir}): the socket exists for
 * an instant before its 0600 chmod, and only the directory keeps other users
 * out in that instant.
 */
export async function startDockerRelay(opts: RelayOptions): Promise<RelayHandle> {
  requireDockerRelayRuntime();
  if (Buffer.byteLength(opts.socketPath) > MAX_SOCKET_PATH) {
    throw new RelaySocketError(`the docker relay socket path ${opts.socketPath} is longer than a unix socket allows (${MAX_SOCKET_PATH} bytes)`);
  }
  await rm(opts.socketPath, { force: true });
  const server: Server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (sock) => handle(sock, opts));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => { server.off('error', reject); resolveListen(); });
  });
  await chmod(opts.socketPath, 0o600);
  // The relay serves whatever this process does; it must never be the reason
  // a CLI command does not exit.
  server.unref();
  return {
    socketPath: opts.socketPath,
    close: () => new Promise<void>((r) => server.close(() => r())).then(() => rm(opts.socketPath, { force: true })),
  };
}

/** The per-process shim a relay leaves in its machine's state dir: `docker-<pid>`. */
export function relayShimPath(stateDir: string, pid: number = process.pid): string {
  return join(stateDir, `docker-${pid}`);
}

/**
 * A short, per-user, private base for relay sockets: `/tmp/lazy-<uid>`. Short
 * because a unix socket path is capped at 103 bytes and a home
 * directory path is not; private because /tmp is shared — a directory that
 * already exists must be a real directory (not a symlink), owned by this user,
 * with no group or other access, or it is refused rather than used.
 */
export async function relaySocketBase(root = '/tmp', uid: number = process.getuid?.() ?? -1): Promise<string> {
  if (uid < 0) throw new RelaySocketError('cannot tell which user this process runs as, so there is no private directory for the docker relay socket');
  const base = join(root, `lazy-${uid}`);
  try { await mkdir(base, { mode: 0o700 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  const st = await lstat(base);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new RelaySocketError(
      `${base} is not a private directory of this user (it must be a real directory owned by uid ${uid} with mode 0700); ` +
      `lazy will not put its docker relay socket there. Remove it, or make it so: chmod 700 ${base}`,
    );
  }
  return base;
}

/**
 * A fresh directory for one relay socket under the private base: created by
 * mkdtemp (0700, never pre-existing), named for this pid so a dead process's
 * leftovers can be swept.
 */
export async function makeRelaySocketDir(base: string, pid: number = process.pid): Promise<{ dir: string; socket: string }> {
  const dir = await mkdtemp(join(base, `r-${pid}-`));
  await chmod(dir, 0o700);
  return { dir, socket: join(dir, 'd.sock') };
}

/** Remove relay files left by processes that no longer exist: `docker-<pid>` shims and `r-<pid>-*` socket dirs. */
export async function sweepDeadRelayFiles(dir: string, alive: (pid: number) => boolean = pidAlive): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  for (const name of names) {
    const m = /^docker-(\d+)(\.sock)?$/.exec(name) ?? /^r-(\d+)-[A-Za-z0-9]+$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && !alive(pid)) await rm(join(dir, name), { recursive: true, force: true });
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * The `docker` the runner invokes: a script that points the host's docker CLI
 * at this process's relay socket. The docker runner passes its binary to every
 * helper that shells out (`ensureImage`, `removeContainer`, …), so making the
 * binary this script is how ALL of them drive the guest engine without a
 * parallel implementation. `DOCKER_CONTEXT` is unset so a user's active
 * context cannot point a command anywhere else.
 */
export function shimScript(dockerCli: string | null, socketPath: string, missingCliMessage: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (!dockerCli) {
    return `#!/bin/sh\n# Written by lazy's smolvm runner.\necho ${q(`lazy: ${missingCliMessage}`)} >&2\nexit 127\n`;
  }
  return `#!/bin/sh\n# Written by lazy's smolvm runner: the host's docker CLI, aimed at the project's smolvm machine.\n` +
    `unset DOCKER_CONTEXT\nDOCKER_HOST=${q(`unix://${socketPath}`)}\nexport DOCKER_HOST\nexec ${q(dockerCli)} "$@"\n`;
}

export async function writeShim(path: string, script: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, script, { mode: 0o700 });
  await rename(`${path}.tmp`, path);
}
