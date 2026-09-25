/**
 * The fake container runtime's Engine API half, and the seeds a docker-runner
 * builder launch needs, shared by the suites that attach a terminal to a
 * daemon-owned builder session (session-attach-route, teams-bound-clone-builder).
 * The CLI half of the fake runtime is ./fake-docker.ts.
 */

import { existsSync, readFileSync } from 'fs';
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
  stop(): void;
}

/**
 * `allowExec`: answer exec create/start the way a real engine does — the
 * started exec is hijacked, prints `exec:<container>` and then echoes — for
 * suites whose subject IS an exec (a task terminal). Off by default: the
 * builder-session suites assert an attach never execs.
 */
export function startFakeEngine(socketPath: string, opts: { allowExec?: boolean } = {}): FakeEngine {
  const attaches: string[] = [];
  const execCreates: string[] = [];
  const execEnvs: string[][] = [];
  const execTargets = new Map<string, string>();
  type Conn = { buf: Buffer; hijacked: boolean };
  const listener = Bun.listen<Conn>({
    unix: socketPath,
    socket: {
      open(sock) { sock.data = { buf: Buffer.alloc(0), hijacked: false }; },
      data(sock, chunk) {
        if (sock.data.hijacked) {
          sock.write(chunk); // echo keystrokes back as PTY output
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
          return reply('201 Created', JSON.stringify({ Id: id }));
        }
        const execStart = /^\/exec\/([^/]+)\/start$/.exec(pathname);
        if (method === 'POST' && execStart && opts.allowExec) {
          sock.data.hijacked = true;
          sock.write(
            'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n' +
            'Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n' + `exec:${execTargets.get(execStart[1]!) ?? '?'}\r\n`,
          );
          return;
        }
        if (method === 'GET' && /^\/exec\/[^/]+\/json$/.test(pathname)) {
          return reply('200 OK', '{"Running":true,"ExitCode":0}');
        }
        if (/\/resize$/.test(pathname)) return reply('200 OK', '');
        if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(pathname)) {
          return reply('200 OK', '{"State":{"Running":true,"ExitCode":0}}');
        }
        return reply('404 Not Found', '{"message":"unhandled by the fake engine"}');
      },
    },
  });
  return { socketPath, attaches, execCreates, execEnvs, stop: () => listener.stop(true) };
}

