/** Fake Engine API on stdio, for the real Docker CLI's attach/exec protocol. */
import { access, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

const mode = process.argv[2];
const completed = process.argv[3]!;
let pending = Buffer.alloc(0);
let upgraded = false;
let tty = false;
const input: Buffer[] = [];

function reply(body: unknown, status = '200 OK'): void {
  const json = JSON.stringify(body);
  process.stdout.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function frame(channel: number, body: string): Buffer {
  const bytes = Buffer.from(body);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

for await (const chunk of Bun.stdin.stream()) {
  if (upgraded) { input.push(Buffer.from(chunk)); continue; }
  pending = Buffer.concat([pending, chunk]);
  while (!upgraded) {
    const end = pending.indexOf('\r\n\r\n');
    if (end < 0) break;
    const headers = pending.subarray(0, end).toString();
    const size = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
    if (pending.length < end + 4 + size) break;
    const body = pending.subarray(end + 4, end + 4 + size).toString();
    pending = pending.subarray(end + 4 + size);
    const [method, path] = headers.split('\r\n')[0]!.split(' ');
    if (path!.endsWith('/_ping')) {
      // HEAD carries the length of GET's body, but no body of its own.
      process.stdout.write(`HTTP/1.1 200 OK\r\nApi-Version: 1.52\r\nContent-Length: 2\r\n\r\n${method === 'HEAD' ? '' : 'OK'}`);
    } else if (mode === 'launch') {
      if (path!.endsWith('/info')) reply({ ServerVersion: '27.0.0', OSType: 'linux' });
      else if (/\/images\/.*\/json$/.test(path!)) reply({ Id: 'sha256:fixture', Os: 'linux' });
      else if (path!.includes('/containers/create')) {
        const config = JSON.parse(body);
        const configPath = config.Env.find((env: string) => env.startsWith('LAZY_DAEMON_CONFIG='))?.slice('LAZY_DAEMON_CONFIG='.length);
        const bound = config.HostConfig.Binds.includes(`${configPath}:${configPath}:ro`);
        const file = configPath ? await stat(configPath) : null;
        // Model native Docker's different UID at the external Engine boundary.
        // Only the file is mounted: its private host ancestor is not traversed
        // inside the container. Other-user read permission must allow the read.
        const guestUid = file?.uid === 1000 ? 1001 : 1000;
        if (!bound || !file || !(file.mode & 0o004)) {
          reply({ message: 'EACCES: guest user cannot read its mounted MCP handoff' }, '500 Internal Server Error');
        } else {
          await writeFile(completed, JSON.stringify({ hostUid: file.uid, guestUid,
            hostDirectoryMode: (await stat(dirname(configPath))).mode & 0o777,
            binds: config.HostConfig.Binds, configPath, content: await readFile(configPath, 'utf8') }));
          reply({ Id: 'c', Warnings: [] }, '201 Created');
        }
      } else if (path!.endsWith('/containers/c/start')) process.stdout.write('HTTP/1.1 204 No Content\r\n\r\n');
      else reply({ message: `unexpected launch request: ${method} ${path}` }, '404 Not Found');
    } else if (mode === 'liveness') {
      const state = (await readFile(completed, 'utf8')).trim();
      if (state === 'broken') {
        reply({ message: 'guest engine unavailable' }, '503 Service Unavailable');
      } else if (/\/containers\/json\?/.test(path!)) {
        const filters = JSON.parse(new URL(path!, 'http://engine').searchParams.get('filters') ?? '{}');
        const names = Array.isArray(filters.name) ? filters.name : Object.keys(filters.name ?? {});
        if (!names.includes('^/lazy-live$')) {
          reply([]);
        } else {
          reply(state === 'running' ? [{ Id: 'a'.repeat(64), Names: ['/lazy-live'], State: 'running', Status: 'Up' }] : []);
        }
      } else if (/\/containers\/lazy-live\/json$/.test(path!)) {
        if (state === 'missing') reply({ message: 'No such container: lazy-live' }, '404 Not Found');
        else reply({ Id: 'a'.repeat(64), State: { Running: state === 'running', ExitCode: 0, OOMKilled: false,
          FinishedAt: state === 'running' ? '0001-01-01T00:00:00Z' : '2026-10-23T10:00:00Z' } });
      } else reply({ message: `unexpected liveness request: ${method} ${path}` }, '404 Not Found');
    } else if (path!.includes('/attach?') || /\/exec\/e\/start$/.test(path!)) {
      upgraded = true;
      tty = body ? JSON.parse(body).Tty : mode === 'tty';
      process.stdout.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      input.push(pending);
    } else if (/\/containers\/create/.test(path!)) {
      await rm(completed, { force: true });
      reply({ Id: 'c', Warnings: [] }, '201 Created');
    } else if (/\/containers\/c\/exec$/.test(path!)) {
      reply({ Id: 'e' }, '201 Created');
    } else if (/\/containers\/c\/json$/.test(path!)) {
      reply({ Id: 'c', State: { Running: true }, Config: { Tty: mode === 'tty', OpenStdin: mode === 'stdin' } });
    } else if (/\/exec\/e\/json$/.test(path!)) {
      reply({ ID: 'e', Running: false, ExitCode: 0 });
    } else if (/\/containers\/c\/wait/.test(path!)) {
      while (!(await access(completed).then(() => true, err => {
        if (err.code === 'ENOENT') return false;
        throw new Error(`fake engine cannot read completion: ${err.message}`);
      }))) await Bun.sleep(5);
      reply({ StatusCode: 0, Error: null });
    } else if (/\/containers\/c\/start$/.test(path!) || method === 'DELETE') {
      // Container completion is independent of whether its attach reader
      // survived: the broken relay still gets exit zero from wait.
      if (method !== 'DELETE') setTimeout(async () => { await writeFile(completed, 'done'); }, 100);
      process.stdout.write('HTTP/1.1 204 No Content\r\n\r\n');
    } else {
      reply({ message: `unimplemented fake engine request: ${method} ${path}` }, '404 Not Found');
    }
  }
}

if (upgraded) {
  // Require an actual half-close, then emit AFTER it. An engine that emits
  // everything alongside the upgrade can conceal a prematurely closed relay.
  await Bun.sleep(25);
  const stdout = mode === 'stdin' ? Buffer.concat(input).toString() : mode === 'bulk' ? 'x'.repeat(512 * 1024) + '\n' : 'hi\n';
  process.stdout.write(tty ? stdout : Buffer.concat([frame(1, stdout), frame(2, 'stderr\n')]));
  await writeFile(completed, 'done');
}
