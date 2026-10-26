/**
 * The fake container runtime's Engine API half, and the seeds a docker-runner
 * builder launch needs, shared by the suites that attach a terminal to a
 * daemon-owned builder session (session-attach-route, teams-bound-clone-builder).
 * The CLI half of the fake runtime is ./fake-docker.ts.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkdir, rename, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { agentBinaryContentIdOfFile, versionedAgentBinaryName } from '../../src/agent/binary-install';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Mirror of the private `calculateSourceHash` — see builder-session-start-proof.test.ts. */
function mirrorSourceHash(sourceRoot: string): string {
  const hash = createHash('sha256');
  const packageJson = join(sourceRoot, 'package.json');
  if (existsSync(packageJson)) hash.update(readFileSync(packageJson, 'utf-8'));
  const srcDir = join(sourceRoot, 'src');
  const files = Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: srcDir, absolute: true })).sort();
  for (const file of files) hash.update(readFileSync(file, 'utf-8'));
  return hash.digest('hex');
}

/** Seed the dev-mode agent-binary stamp so no source compile runs. */
export async function seedAgentBinaryStamp(agentHome: string): Promise<void> {
  const binDir = join(agentHome, '.lazy', 'bin');
  await mkdir(binDir, { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(2048, 0x2a),
    Buffer.from('lazy-agent ok'),
    Buffer.alloc(2048, 0x21),
  ]);
  const seedPath = join(binDir, 'stamp-seed-elf');
  await writeFile(seedPath, bytes);
  const installName = versionedAgentBinaryName(await agentBinaryContentIdOfFile(seedPath));
  await rename(seedPath, join(binDir, installName));
  const stamp = `${mirrorSourceHash(REPO_ROOT)}:${process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'}`;
  await writeFile(join(binDir, 'lazy-agent.hash'), `${stamp}\n${installName}\n`);
}

/**
 * The Docker Engine API side of the fake runtime: answers exactly the calls
 * `ExecStream` makes, and records attaches and exec creations by container.
 * An attach is hijacked (101) and then echoes, prefixed by a banner naming the
 * container — so the client can see WHICH container its bytes reached.
 */
export interface FakeEngine {
  socketPath: string;
  attaches: string[];
  execCreates: string[];
  /** With `allowExec`: the `Env` of every exec created, in order. */
  execEnvs: string[][];
  /** With `allowExec`: the `Cmd` of every exec created, in order. */
  execCmds: string[][];
  /** Every resize request's path and query (`/exec/<id>/resize?h=…&w=…`), in order. */
  resizes: string[];
  /** How many hijacked streams (attaches and execs) have been closed — a hangup. */
  streamsClosed(): number;
  stop(): void;
}

/**
 * `allowExec`: answer exec create/start the way a real engine does — the
 * started exec is hijacked, prints `exec:<container>` and then echoes — for
 * suites whose subject IS an exec (a task terminal). Off by default: the
 * builder-session suites assert an attach never execs.
 */
/**
 * `runExecs`: a NON-TTY exec (what an SSH connection asks for) really RUNS its
 * `Cmd` here, on this machine, as the container would — stdin from the socket,
 * stdout and stderr multiplexed back in the engine's 8-byte frames. The
 * container's view of the network is emulated: `host.docker.internal` in the
 * exec's environment is the host itself (127.0.0.1), and `lazy-agent` on PATH
 * runs this checkout's agent entry. TTY execs keep the echo behaviour.
 */
export interface RunExecsOptions {
  /**
   * A directory for the `lazy-agent` shim, and for the files that stand in
   * for the container's own `/etc/hosts` and `/etc/passwd` (`hosts`,
   * `passwd`): an exec that edits "its" system files edits these, never this
   * machine's.
   */
  shimDir: string;
  /**
   * Make the shim `passwd` the file the exec's programs actually READ (glibc
   * NSS via libnss-wrapper's LD_PRELOAD): it is seeded with the invoking
   * user's own line, so `getent passwd lazy` and sshd's account lookup see
   * exactly what the login-alias step wrote and nothing else.
   */
  nssWrapperLib?: string;
}

export function startFakeEngine(socketPath: string, opts: { allowExec?: boolean; runExecs?: RunExecsOptions } = {}): FakeEngine {
  const attaches: string[] = [];
  const execCreates: string[] = [];
  const execEnvs: string[][] = [];
  const execCmds: string[][] = [];
  const resizes: string[] = [];
  let closedStreams = 0;
  const execTargets = new Map<string, string>();
  const execSpecs = new Map<string, { tty: boolean; cmd: string[]; env: string[] }>();
  const execExit = new Map<string, number | null>();
  if (opts.runExecs) {
    mkdirSync(opts.runExecs.shimDir, { recursive: true });
    const shim = join(opts.runExecs.shimDir, 'lazy-agent');
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} run ${join(REPO_ROOT, 'src', 'agent-entry.ts')} "$@"\n`);
    chmodSync(shim, 0o755);
    writeFileSync(join(opts.runExecs.shimDir, 'hosts'), '127.0.0.1 localhost\n');
    const seed = (db: string, key: string) => (opts.runExecs?.nssWrapperLib
      ? Bun.spawnSync(['getent', db, key]).stdout.toString() : '');
    const passwdSeed = seed('passwd', String(process.getuid?.() ?? ''));
    if (opts.runExecs.nssWrapperLib && !passwdSeed) throw new Error(`getent found no passwd entry for uid ${process.getuid?.()}; the nss_wrapper passwd cannot be seeded`);
    writeFileSync(join(opts.runExecs.shimDir, 'passwd'), passwdSeed);
    writeFileSync(join(opts.runExecs.shimDir, 'group'), seed('group', String(process.getgid?.() ?? '')));
  }
  type Conn = { buf: Buffer; hijacked: boolean; child?: ReturnType<typeof Bun.spawn>; pending: Uint8Array[]; endWhenDrained?: boolean };
  // A socket write may take only part of what it is given; the rest waits
  // for `drain`, in order (an SSH stream with a hole in it is corrupt).
  const writeAll = (sock: import('bun').Socket<Conn>, bytes: Uint8Array) => {
    if (sock.data.pending.length > 0) { sock.data.pending.push(bytes); return; }
    const sent = sock.write(bytes);
    if (sent < bytes.length) sock.data.pending.push(bytes.subarray(Math.max(0, sent)));
  };
  const listener = Bun.listen<Conn>({
    unix: socketPath,
    socket: {
      open(sock) { sock.data = { buf: Buffer.alloc(0), hijacked: false, pending: [] }; },
      drain(sock) {
        while (sock.data.pending.length > 0) {
          const head = sock.data.pending[0]!;
          const sent = sock.write(head);
          if (sent < head.length) { sock.data.pending[0] = head.subarray(Math.max(0, sent)); return; }
          sock.data.pending.shift();
        }
        if (sock.data.endWhenDrained) sock.end();
      },
      // The client hanging up ends the exec, as the real engine's HUP does.
      close(sock) {
        if (sock.data?.hijacked) closedStreams++;
        const child = sock.data.child;
        if (!child) return;
        // The exec's stdin reaches EOF, as the real engine closes it.
        try { (child.stdin as import('bun').FileSink).end(); } catch (err) { void err; }
        child.kill();
      },
      data(sock, chunk) {
        if (sock.data.hijacked) {
          const child = sock.data.child;
          if (child) {
            (child.stdin as import('bun').FileSink).write(chunk);
            (child.stdin as import('bun').FileSink).flush();
            return;
          }
          sock.write(chunk); // echo keystrokes back as PTY output
          // `exit` + Enter ends the program, as a shell would.
          if (Buffer.from(chunk).toString('latin1').includes('exit\r')) sock.end();
          return;
        }
        sock.data.buf = Buffer.concat([sock.data.buf, Buffer.from(chunk)]);
        const end = sock.data.buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = sock.data.buf.subarray(0, end).toString('latin1');
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (sock.data.buf.length < end + 4 + length) return;
        const body = sock.data.buf.subarray(end + 4, end + 4 + length).toString('utf-8');
        const [method, path] = head.split('\r\n')[0]!.split(' ');
        const pathname = decodeURIComponent((path ?? '').split('?')[0]!);
        const attach = /^\/containers\/([^/]+)\/attach$/.exec(pathname);
        if (method === 'POST' && attach) {
          attaches.push(attach[1]!);
          sock.data.hijacked = true;
          sock.write(
            'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n' +
            'Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n' + `attached:${attach[1]}\r\n`,
          );
          return;
        }
        const reply = (status: string, body: string) => {
          sock.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          sock.end();
        };
        const execCreate = /^\/containers\/([^/]+)\/exec$/.exec(pathname);
        if (method === 'POST' && execCreate) {
          execCreates.push(execCreate[1]!);
          if (!opts.allowExec) return reply('404 Not Found', '{"message":"exec is not expected on an attach"}');
          const id = `exec-${execCreates.length}`;
          execTargets.set(id, execCreate[1]!);
          execEnvs.push(((JSON.parse(body || '{}') as { Env?: string[] }).Env) ?? []);
          execCmds.push(((JSON.parse(body || '{}') as { Cmd?: string[] }).Cmd) ?? []);
          const spec = JSON.parse(body || '{}') as { Cmd?: string[]; Env?: string[]; Tty?: boolean };
          execSpecs.set(id, { tty: spec.Tty !== false, cmd: spec.Cmd ?? [], env: spec.Env ?? [] });
          return reply('201 Created', JSON.stringify({ Id: id }));
        }
        const execStart = /^\/exec\/([^/]+)\/start$/.exec(pathname);
        if (method === 'POST' && execStart && opts.allowExec && opts.runExecs && execSpecs.get(execStart[1]!)?.tty === false) {
          const execId = execStart[1]!;
          const spec = execSpecs.get(execId)!;
          sock.data.hijacked = true;
          sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
          const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${opts.runExecs.shimDir}:${process.env.PATH ?? ''}` };
          if (opts.runExecs.nssWrapperLib) {
            env.LD_PRELOAD = opts.runExecs.nssWrapperLib;
            env.NSS_WRAPPER_PASSWD = join(opts.runExecs.shimDir, 'passwd');
            env.NSS_WRAPPER_GROUP = join(opts.runExecs.shimDir, 'group');
          }
          for (const e of spec.env) {
            const i = e.indexOf('=');
            env[e.slice(0, i)] = e.slice(i + 1).replaceAll('host.docker.internal', '127.0.0.1');
          }
          const shimDir = opts.runExecs.shimDir;
          const cmd = spec.cmd.map((a) => a.replaceAll('/etc/hosts', join(shimDir, 'hosts')).replaceAll('/etc/passwd', join(shimDir, 'passwd')));
          const child = Bun.spawn(cmd, { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
          sock.data.child = child;
          const frame = (stream: number, data: Uint8Array) => {
            const head = Buffer.alloc(8);
            head[0] = stream;
            head.writeUInt32BE(data.length, 4);
            writeAll(sock, Buffer.concat([head, Buffer.from(data)]));
          };
          const pump = async (s: ReadableStream<Uint8Array>, n: number) => {
            for await (const chunk of s) {
              if (n === 2) appendFileSync(join(shimDir, 'exec-stderr.log'), chunk);
              frame(n, chunk);
            }
          };
          void Promise.all([pump(child.stdout as ReadableStream<Uint8Array>, 1), pump(child.stderr as ReadableStream<Uint8Array>, 2), child.exited])
            .then(([, , code]) => {
              execExit.set(execId, code);
              if (sock.data.pending.length > 0) sock.data.endWhenDrained = true;
              else sock.end();
            });
          return;
        }
        if (method === 'POST' && execStart && opts.allowExec) {
          sock.data.hijacked = true;
          sock.write(
            'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n' +
            'Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n' + `exec:${execTargets.get(execStart[1]!) ?? '?'}\r\n`,
          );
          return;
        }
        const execJson = /^\/exec\/([^/]+)\/json$/.exec(pathname);
        if (method === 'GET' && execJson) {
          const code = execExit.get(execJson[1]!);
          return reply('200 OK', code === undefined ? '{"Running":true,"ExitCode":0}' : JSON.stringify({ Running: false, ExitCode: code }));
        }
        if (/\/resize$/.test(pathname)) { resizes.push(path ?? ''); return reply('200 OK', ''); }
        if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(pathname)) {
          return reply('200 OK', '{"State":{"Running":true,"ExitCode":0}}');
        }
        return reply('404 Not Found', '{"message":"unhandled by the fake engine"}');
      },
    },
  });
  return { socketPath, attaches, execCreates, execEnvs, execCmds, resizes, streamsClosed: () => closedStreams, stop: () => listener.stop(true) };
}

