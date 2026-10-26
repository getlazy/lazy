/**
 * A web terminal outlives a dropped connection, and comes back to its page.
 *
 * The relay (src/server/shell-ws.ts) over a REAL `ExecStream` against the fake
 * Engine API (test/helpers/fake-docker-engine.ts, which echoes keystrokes and
 * ends the program on `exit`), behind a minimal Bun server whose upgrade does
 * what the dashboard and attach routes do: a reattach first, otherwise a new
 * terminal with a resume owner.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';
import {
  createShellRelayHandler,
  tryResumeUpgrade,
  endDetachedTerminals,
  terminalHolds,
  TERMINAL_ENDED_MESSAGE,
  SHELL_CMD,
  type ShellSocketData,
} from '../../src/server/shell-ws';
import { OutputLog, TerminalHolds } from '../../src/server/terminal-hold';

let dir: string;
let engine: FakeEngine;
let server: ReturnType<typeof Bun.serve>;
const savedDockerHost = process.env.DOCKER_HOST;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lz-term-resume-'));
  engine = startFakeEngine(join(dir, 'docker.sock'), { allowExec: true });
  process.env.DOCKER_HOST = `unix://${engine.socketPath}`;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    websocket: createShellRelayHandler() as never,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const owner = `test:${url.searchParams.get('who') ?? 'alice'}`;
      const resumed = tryResumeUpgrade(req, srv as never, url, owner, { freshOnMiss: url.searchParams.get('fresh') === '1' });
      if (resumed) return resumed === 'upgraded' ? undefined : resumed;
      if (url.searchParams.get('pair') === '1') endDetachedTerminals(owner);
      const data: ShellSocketData = {
        socketPath: '', container: 'box', binary: 'docker', cols: 80, rows: 24, exec: null,
        cmd: SHELL_CMD, env: [], onClose: null, resumeOwner: owner,
      };
      return srv.upgrade(req, { data }) ? undefined : new Response('no', { status: 426 });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  engine.stop();
  if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedDockerHost;
  await rm(dir, { recursive: true, force: true });
});

/** A client that counts the output bytes it drew, as the pages do. */
function open(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?cols=80&rows=24${query}`);
  ws.binaryType = 'arraybuffer';
  const c = {
    ws,
    text: '',
    bytes: 0,
    frames: [] as Array<Record<string, unknown>>,
    closed: new Promise<number>((resolve) => { ws.onclose = (e) => resolve(e.code); }),
    async until(pred: () => boolean, what: string) {
      const deadline = Date.now() + 5000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(c.text)} ${JSON.stringify(c.frames)}`);
        await Bun.sleep(10);
      }
    },
    ready() { return c.frames.find((f) => f.type === 'ready'); },
    type(s: string) { ws.send(new TextEncoder().encode(s)); },
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') c.frames.push(JSON.parse(e.data));
    else { const b = new Uint8Array(e.data as ArrayBuffer); c.bytes += b.length; c.text += new TextDecoder().decode(b); }
  };
  return c;
}

describe('a dropped terminal reattaches to the same program', () => {
  // INVARIANT: a socket that closes without the page saying it is done is a
  // dropped connection: the exec keeps running, and a reattach with the token
  // and the byte offset gets exactly the output it missed, then the live
  // stream — the same program, nothing drawn twice. "Reload to reattach"
  // used to open a NEW shell, because the drop had HUPped the old one.
  test('drop, output during the gap, reattach: same exec, missed bytes once', async () => {
    const execsBefore = engine.execCreates.length;
    const closedBefore = engine.streamsClosed();
    const a = open();
    await a.until(() => !!a.ready() && a.text.includes('exec:box'), 'ready');
    const token = a.ready()!.resume as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    a.type('one\r');
    await a.until(() => a.text.includes('one\r'), 'echo');
    const drawn = a.bytes;
    a.ws.close(); // no `end`: a drop
    await a.closed;
    await Bun.sleep(50);
    expect(engine.streamsClosed()).toBe(closedBefore); // not hung up

    const b = open(`&resume=${token}&offset=${drawn}`);
    await b.until(() => !!b.ready(), 'resumed ready');
    expect(b.ready()!.resumed).toBe(true);
    expect(b.ready()!.resume).not.toBe(token); // rotated
    expect(b.text).toBe(''); // nothing missed, nothing repeated
    b.type('two\r');
    await b.until(() => b.text.includes('two\r'), 'echo after reattach');
    expect(engine.execCreates.length).toBe(execsBefore + 1); // one program, ever

    // The old token is spent.
    const c = open(`&resume=${token}&offset=0`);
    await c.until(() => c.frames.some((f) => f.type === 'error'), 'refusal');
    expect(c.frames[0]).toEqual({ type: 'error', message: TERMINAL_ENDED_MESSAGE });
    expect(await c.closed).toBe(1008);

    b.ws.send(JSON.stringify({ type: 'end' }));
    b.ws.close();
    await b.closed;
    await Bun.sleep(50);
    expect(engine.streamsClosed()).toBe(closedBefore + 1);
  });

  test('a reattach from an earlier offset replays what the page had not drawn', async () => {
    const a = open();
    await a.until(() => !!a.ready() && a.text.includes('exec:box'), 'ready');
    const token = a.ready()!.resume as string;
    const before = a.bytes;
    a.type('lost-in-flight\r');
    await a.until(() => a.text.includes('lost-in-flight'), 'echo');
    a.ws.close();
    await a.closed;
    const b = open(`&resume=${token}&offset=${before}`);
    await b.until(() => b.text.includes('lost-in-flight\r'), 'replay');
    expect(b.text).toBe('lost-in-flight\r');
    b.ws.send(JSON.stringify({ type: 'end' }));
    b.ws.close();
    await b.closed;
  });

  // INVARIANT: a token reattaches only for the owner it was issued to — the
  // route, target and person; anyone else gets the same answer as a dead token.
  test("someone else's token is refused like a dead one, and the terminal stays theirs", async () => {
    const a = open();
    await a.until(() => !!a.ready(), 'ready');
    const token = a.ready()!.resume as string;
    a.ws.close();
    await a.closed;
    const mallory = open(`&who=mallory&resume=${token}&offset=0`);
    await mallory.until(() => mallory.frames.length > 0, 'refusal');
    expect(mallory.frames[0]).toEqual({ type: 'error', message: TERMINAL_ENDED_MESSAGE });
    const back = open(`&resume=${token}&offset=${a.bytes}`);
    await back.until(() => !!back.ready(), 'owner reattach');
    expect(back.ready()!.resumed).toBe(true);
    back.ws.send(JSON.stringify({ type: 'end' }));
    back.ws.close();
    await back.closed;
  });

  // INVARIANT: the person ending the terminal ends it — no hold.
  test('`end` then close hangs the program up at once and spends the token', async () => {
    await Bun.sleep(50); // the previous test's hangup settles first
    const closedBefore = engine.streamsClosed();
    const a = open();
    await a.until(() => !!a.ready(), 'ready');
    const token = a.ready()!.resume as string;
    a.ws.send(JSON.stringify({ type: 'end' }));
    a.ws.close();
    await a.closed;
    await Bun.sleep(50);
    expect(engine.streamsClosed()).toBe(closedBefore + 1);
    const b = open(`&resume=${token}&offset=0`);
    await b.until(() => b.frames.length > 0, 'refusal');
    expect(b.frames[0]!.type).toBe('error');
  });

  // INVARIANT: a program that exited while its page was away is reported as
  // exited on the reattach — never silently replaced by a new one.
  test('the program exiting while detached is reported on the reattach', async () => {
    const a = open();
    await a.until(() => !!a.ready() && a.text.includes('exec:box'), 'ready');
    const token = a.ready()!.resume as string;
    const drawn = a.bytes;
    a.ws.close();
    await a.closed;
    // Nobody is attached; make the program exit by talking to the held exec.
    const held = terminalHolds.claim(token, 'test:alice')!;
    held.value.exec!.write(new TextEncoder().encode('exit\r'));
    // Put it back as it was: held, detached.
    terminalHolds.detach(held.token);
    await Bun.sleep(100);
    const b = open(`&resume=${held.token}&offset=${drawn}`);
    await b.until(() => b.frames.some((f) => f.type === 'exit'), 'exit frame');
    expect(b.text).toBe('exit\r'); // the program's last output, once
    expect(await b.closed).toBe(1000);
  });

  // INVARIANT: a reattach while the old socket is still attached (a laptop
  // that slept: the server never saw it die) takes the terminal over.
  test('a reattach takes the terminal over from a socket that is still attached', async () => {
    const a = open();
    await a.until(() => !!a.ready() && a.text.includes('exec:box'), 'ready');
    const token = a.ready()!.resume as string;
    const b = open(`&resume=${token}&offset=${a.bytes}`);
    await b.until(() => !!b.ready(), 'takeover ready');
    expect(await a.closed).toBe(4001);
    b.type('mine\r');
    await b.until(() => b.text.includes('mine\r'), 'echo on the new socket');
    expect(a.text).not.toContain('mine');
    b.ws.send(JSON.stringify({ type: 'end' }));
    b.ws.close();
    await b.closed;
  });
});

describe('TerminalHolds', () => {
  test('a detached terminal ends when its grace runs out, and its token dies with it', async () => {
    const holds = new TerminalHolds<string>(() => 30);
    let expired = 0;
    const token = holds.register('o', 'v', () => { expired++; });
    holds.detach(token);
    await Bun.sleep(80);
    expect(expired).toBe(1);
    expect(holds.claim(token, 'o')).toBeNull();
  });

  test('a claim stops the grace', async () => {
    const holds = new TerminalHolds<string>(() => 30);
    let expired = 0;
    const token = holds.register('o', 'v', () => { expired++; });
    holds.detach(token);
    const claimed = holds.claim(token, 'o');
    expect(claimed?.value).toBe('v');
    await Bun.sleep(80);
    expect(expired).toBe(0);
  });

  test('endWhere ends only the matching terminals of that owner, at once', () => {
    const holds = new TerminalHolds<{ detached: boolean }>();
    const ended: string[] = [];
    holds.register('o', { detached: true }, () => ended.push('o-detached'));
    holds.register('o', { detached: false }, () => ended.push('o-attached'));
    holds.register('p', { detached: true }, () => ended.push('p-detached'));
    holds.endWhere('o', (v) => v.detached);
    expect(ended).toEqual(['o-detached']);
    expect(holds.size).toBe(2);
  });
});

describe('a reload while reconnecting, and a builder past its hold', () => {
  // INVARIANT: a NEW Pair/Chat from the same owner ends that owner's DETACHED
  // one first — its page lost the token (a reload during "Reconnecting…"), and
  // the held one would keep the Pair lock for the whole 5-minute grace.
  test('a fresh open by the same owner ends the detached terminal, hanging it up', async () => {
    await Bun.sleep(50);
    const closedBefore = engine.streamsClosed();
    const a = open('&who=pairer');
    await a.until(() => !!a.ready() && a.text.includes('exec:box'), 'ready');
    const token = a.ready()!.resume as string;
    a.ws.close();
    await a.closed;
    const b = open('&who=pairer&pair=1');
    await b.until(() => !!b.ready(), 'the new terminal');
    await Bun.sleep(50);
    expect(engine.streamsClosed()).toBe(closedBefore + 1);
    expect(terminalHolds.claim(token, 'test:pairer')).toBeNull();
    b.ws.send(JSON.stringify({ type: 'end' }));
    b.ws.close();
    await b.closed;
  });

  // INVARIANT: for a target that outlives its sockets (a builder), an expired
  // token is not "this terminal has ended" — the page is attached afresh.
  test('freshOnMiss turns an unknown token into a fresh terminal, not a refusal', async () => {
    const c = open(`&fresh=1&resume=${'Z'.repeat(32)}&offset=5`);
    await c.until(() => !!c.ready(), 'a fresh ready');
    expect(c.ready()!.resumed).toBeUndefined();
    expect(c.frames.some((f) => f.type === 'error')).toBe(false);
    c.ws.send(JSON.stringify({ type: 'end' }));
    c.ws.close();
    await c.closed;
  });
});

describe('OutputLog', () => {
  test('replays from an offset and reports what is no longer kept', () => {
    const log = new OutputLog(8);
    for (const s of ['abcd', 'efgh', 'ijkl']) log.append(new TextEncoder().encode(s));
    expect(log.total).toBe(12);
    expect(new TextDecoder().decode(log.since(10).bytes)).toBe('kl');
    const old = log.since(0);
    expect(old.lost).toBe(log.start);
    expect(new TextDecoder().decode(old.bytes)).toBe('abcdefghijkl'.slice(log.start));
    expect(log.since(12).bytes.length).toBe(0);
    expect(log.since(99).bytes.length).toBe(0);
  });
});
