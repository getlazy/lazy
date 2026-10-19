/**
 * E2E: `lazy loop` inside a clone bound to Lazy Teams.
 *
 * // INVARIANT: loop drives tasks through the daemon RPC only. It used to build a
 * LOCAL runner as a pre-flight, which asks for the live proxy address
 * (`getAuthEnv`) — an RPC Teams does not offer a bound clone — so it refused
 * before doing anything. The harness is the one the command inventory uses: a
 * managed daemon holds the project and `relayTeamsRpc` stands in for Teams'
 * RPC proxy, admitting exactly what the Rails tables admit.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { turnProtectionOff } from '../helpers/managed-protection';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';

const ALICE = 'alice@example.com';
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

describe('lazy loop in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;
  let target: string;
  let alice: string;
  const proxied: string[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzloop-'));
    ctx = await setupTestLazy({ withDaemon: true });
    // The loop's driving is the subject, not protection: the owner turns
    // `main`'s managed-mode default protection off, so its accept can land.
    await turnProtectionOff(join(ctx.root, 'lazy.toml'));
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MOCK_SHOULD_COMMIT: '1',
    });
    target = getDaemonTcpTarget(ctx.root)!;
    const rpc = (token: string, command: string, params: Record<string, unknown> = {}) =>
      DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
    const shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-loop' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-loop' });
    alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;

    clone = join(workDir, 'clone');
    await runGit(['init', clone], { cwd: workDir });
    await runGit(['config', 'user.email', ALICE], { cwd: clone });
    await runGit(['config', 'user.name', 'Alice'], { cwd: clone });
    await writeFile(join(clone, 'README.md'), '# lazy-toy\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'Initial commit'], { cwd: clone });
    unpinBase = pinDaemonBaseDir(join(workDir, 'laptop-daemon'));
    type Relay = { upstream: WebSocket; pending: Array<string | ArrayBuffer | Uint8Array> };
    teams = Bun.serve<Relay>({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const watch = new RegExp(`^/api/projects/${PROJECT}/tasks/([^/]+)/watch$`).exec(url.pathname);
        if (watch) {
          if (req.headers.get('authorization') !== `Bearer ${CLI_TOKEN}`) {
            return Response.json({ error: 'A CLI-scoped API token is required.' }, { status: 401 });
          }
          const upstream = new WebSocket(`${target.replace(/^http/, 'ws')}/rpc/tasks/${watch[1]}/watch/ws`, {
            headers: { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root },
          } as never);
          upstream.binaryType = 'arraybuffer';
          proxied.push(`watch ${watch[1]}`);
          return server.upgrade(req, { data: { upstream, pending: [] } }) ? undefined : new Response('upgrade failed', { status: 400 });
        }
        return (await relayTeamsRpc(req, {
          project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root, proxied,
          daemonTarget: () => target, memberToken: () => alice,
        })) ?? Response.json({ error: 'not found' }, { status: 404 });
      },
      websocket: {
        open(ws) {
          const { upstream } = ws.data;
          upstream.onmessage = (ev) => ws.send(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
          upstream.onclose = () => ws.close();
          upstream.onopen = () => { for (const m of ws.data.pending.splice(0)) upstream.send(m); };
        },
        message(ws, message) {
          const { upstream } = ws.data;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
          else ws.data.pending.push(message);
        },
        close(ws) { ws.data.upstream.close(); },
      },
    });
    await writeTeamsLogin(clone, {
      teamsUrl: `http://127.0.0.1:${teams.port}`, token: CLI_TOKEN, project: PROJECT, projectId: '42',
    });
  }, 120_000);

  afterAll(async () => {
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase();
    await rm(workDir, { recursive: true, force: true });
  });

  async function runLazy(args: string[], env: Record<string, string> = {}, timeout = 90_000) {
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
      cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout, killSignal: 'SIGKILL',
      env: {
        ...process.env, HOME: join(workDir, 'laptop-home'), LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '', LAZY_IS_DAEMON: '', LAZY_FORCE_TTY: '', LAZY_PROMPT_DEFAULTS: '', NO_COLOR: '1', ...env,
      },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  }

  test('a queued task is started through the daemon and is driven through to completion', async () => {
    const made = await runLazy(['create', '--goal', 'Loop seed', '--prompt', 'Seed.', '--code', 'loop-seed']);
    expect(made.exitCode).toBe(0);

    // The prompt seam always picks the first menu entry (feedback); with a no-op editor
    // that flow ends in the accept path, which is why the task reaches complete.
    const r = await runLazy(['loop', 'loop-seed'], {
      LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1', EDITOR: 'true', VISUAL: 'true',
    });
    expect(r.exitCode).toBe(0);
    expect(proxied).not.toContain('getAuthEnv');
    expect(proxied).toContain('startTask');
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toContain('could not resolve the live proxy address');
    expect(out).not.toContain('does not offer');
    expect(out).toContain('Starting loop-seed');
    expect(out).toContain('What would you like to do?');

    const shown = await runLazy(['show', 'loop-seed']);
    expect(shown.stdout).toMatch(/Status:\s+complete/);
  }, 180_000);

  test('reactive mode (no arguments) reaches the review menu for a blocked task', async () => {
    const made = await runLazy(['create', '--goal', 'Reactive seed', '--prompt', 'Seed.', '--code', 'loop-reactive']);
    expect(made.exitCode).toBe(0);
    expect((await runLazy(['start', 'loop-reactive'])).exitCode).toBe(0);
    expect((await runLazy(['wait', 'loop-reactive'])).exitCode).toBe(0);

    const proc = Bun.spawn(['bun', 'run', ENTRY, 'loop'], {
      cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', killSignal: 'SIGKILL',
      env: {
        ...process.env, HOME: join(workDir, 'laptop-home'), LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '', LAZY_IS_DAEMON: '', LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1', NO_COLOR: '1',
        EDITOR: 'true', VISUAL: 'true',
      },
    });
    // Reactive mode never exits on its own, so read until the menu shows, then stop it.
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 60_000;
    let seen = '';
    while (!seen.includes('What would you like to do?') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    proc.kill('SIGKILL');
    await proc.exited;
    expect(seen).toContain('What would you like to do?');
  }, 120_000);

  test('--follow streams the task through Teams\' Watch relay, with no local runner', async () => {
    // INVARIANT: in a bound clone `--follow` follows through the server, never a local container or runner. There is no local container to follow, and asking for one is what made loop fail before.
    const made = await runLazy(['create', '--goal', 'Follow seed', '--prompt', 'Seed.', '--code', 'loop-follow']);
    expect(made.exitCode).toBe(0);

    // An editor that gives feedback once and then returns the file untouched, so the
    // loop's next gate ends the run through the accept path instead of re-asking forever.
    const editor = join(workDir, 'editor.sh');
    const marker = join(workDir, 'editor-used');
    await writeFile(editor, `#!/bin/sh\nif [ ! -e "${marker}" ]; then touch "${marker}"; echo "Please also add a note." >> "$1"; fi\n`, { mode: 0o755 });

    const r = await runLazy(['loop', 'loop-follow', '--follow'], {
      LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1', EDITOR: editor, VISUAL: editor,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toContain('could not resolve the live proxy address');
    expect(out).not.toContain('not available in a clone bound');
    expect(out).toContain('unblocked');
    expect(proxied.some((c) => c.startsWith('watch '))).toBe(true);
    expect(proxied).not.toContain('getAuthEnv');
  }, 180_000);
});
