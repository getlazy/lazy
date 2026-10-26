/**
 * E2E INVENTORY: every top-level `lazy` command (and the multiplexer
 * subcommands) run as a real CLI subprocess inside a clone bound to Lazy Teams,
 * classified works / fails / refuses / hangs.
 *
 * The harness is the one `teams-bound-clone-mcp-sweep.test.ts` built: a MANAGED
 * daemon holds the project and Teams' RPC proxy route is stood in for by
 * `relayTeamsRpc`, which admits exactly what the Rails tables admit. The clone
 * is a fresh `git init` with a Teams login record and no `lazy init`.
 *
 * The command list is read off `src/index.ts`'s dispatch table and the
 * subcommand lists off the commands' own usage maps, so a command added
 * tomorrow fails this suite until somebody classifies it in {@link EXPECTED}.
 *
 * This suite DESCRIBES; it does not fix. Entries marked `known-broken` are
 * `fails` that should become `works` (or a signed-off `refuses`) in a later
 * task — flip the entry when that lands. The human-readable table lives in
 * docs/bound-clone-command-inventory.md; set INVENTORY_DUMP=1 to print the
 * observed table (TSV) for regenerating it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';
import { daemonSubcommandUsage } from '../../src/cli/commands/daemon';
import { systemSubcommandUsage } from '../../src/cli/commands/system';
import { artifactSubcommandUsage } from '../../src/cli/commands/artifact';
import { memorySubcommandUsage } from '../../src/cli/commands/memory';
import { envSubcommandUsage } from '../../src/cli/commands/env';
import { statsSubcommandUsage } from '../../src/cli/commands/stats';
import { raisedSubcommandUsage } from '../../src/cli/commands/raised';
import { messagesSubcommandUsage } from '../../src/cli/commands/messages';
import { scratchSubcommandUsage } from '../../src/cli/commands/scratch';
import { conversationsSubcommandUsage } from '../../src/cli/commands/conversations';
import { customizeSubcommandUsage } from '../../src/cli/commands/customize';

const ALICE = 'alice@example.com';
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const ROOT = join(import.meta.dir, '..', '..');
const ENTRY = join(ROOT, 'src', 'index.ts');
const PER_COMMAND_TIMEOUT_MS = 30_000;

/**
 * - `works`   — exit 0.
 * - `refuses` — non-zero exit with a message naming the Teams binding (or
 *               otherwise explicitly saying this is not available here).
 * - `fails`   — non-zero exit with anything else: a crash, a transport error,
 *               advice that is wrong for a bound clone, a bare daemon refusal.
 * - `hangs`   — still running after the per-command timeout with no input.
 */
type Status = 'works' | 'refuses' | 'fails' | 'hangs';

interface Expectation {
  status: Status;
  /** A `fails`/`hangs` that is a defect to fix later (as opposed to a domain answer about the seed task). */
  knownBroken?: boolean;
}

const W: Expectation = { status: 'works' };
const R: Expectation = { status: 'refuses' };
const F: Expectation = { status: 'fails' };
/** A defect: should become `works` (or a signed-off refusal). */
const BROKEN: Expectation = { status: 'fails', knownBroken: true };
const HANGS: Expectation = { status: 'hangs', knownBroken: true };

/** Placeholders in an arg list: `{task}` a fresh parked-free task, `{started}` a started+parked one. */
const TASK = '{task}';
const STARTED = '{started}';

interface Probe { key: string; args: string[]; env?: Record<string, string> }

/** Top-level commands, parsed from the dispatch table so none is ever missed. */
async function topLevelCommands(): Promise<string[]> {
  const src = await readFile(ENTRY, 'utf8');
  const start = src.indexOf('const commandMap');
  const end = src.indexOf('\n};', start);
  const names = [...src.slice(start, end).matchAll(/^ {2}'([a-z][a-z-]*)':\s/gm)].map((m) => m[1]);
  return names;
}

/** Arguments for each top-level command: safe, and enough to reach its real work. */
const TOP_ARGS: Record<string, string[]> = {
  link: [TASK, 'https://example.com/acme/lazy-toy/pull/1'],
  describe: [TASK],
  'import-conversation': ['/nonexistent/conversation.jsonl'],
  init: ['--non-interactive', '--skip-auth-check', '--skip-remote-check', '--skip-completion-check'],
  create: ['--goal', 'Inventory create', '--prompt', 'Do nothing.', '--code', 'inv-create'],
  edit: [TASK, '--goal', 'Edited'],
  clone: [TASK],
  list: [],
  active: [],
  blocked: [],
  show: [TASK],
  search: ['inventory'],
  comment: [TASK, 'a comment'],
  tag: [TASK, 'inv'],
  untag: [TASK, 'inv'],
  journal: [TASK, 'a journal entry'],
  memory: [],
  scratch: [],
  artifact: [],
  messages: [],
  raised: [],
  conversations: [],
  start: [TASK],
  unblock: [STARTED, '-m', 'continue', '--yes'],
  resume: [STARTED],
  reopen: [TASK],
  branch: [TASK],
  diff: [STARTED],
  regions: [STARTED],
  status: [TASK],
  shell: [TASK],
  dashboard: [],
  playground: ['status'],
  url: [TASK],
  forward: [TASK, '3000'],
  pair: [TASK],
  chat: [TASK],
  accept: [STARTED, '--yes'],
  protect: [],
  close: [TASK, '--reason', 'inventory', '--yes'],
  reject: [STARTED, '--reason', 'inventory', '--yes'],
  stop: [TASK, '--reason', 'inventory', '--yes'],
  revert: [STARTED],
  wait: [STARTED],
  builder: [],
  doctor: [],
  auth: [],
  login: [],
  logout: [],
  loop: [],
  submit: [STARTED, '--yes'],
  sync: [STARTED],
  reparent: [TASK, '--parent', 'main', '--yes'],
  completion: ['--bash'],
  review: [STARTED],
  browse: [],
  ask: [STARTED, 'What changed?'],
  redo: [TASK],
  upgrade: ['--dry-run'],
  stats: [],
  env: [],
  customize: [],
  system: [],
  document: ['--goal', 'Inventory document'],
  refactor: ['--goal', 'Inventory refactor'],
  fix: ['--goal', 'Inventory fix'],
  rework: [TASK],
  daemon: [],
  watch: [TASK],
  config: [],
  report: [],
};

/**
 * Subcommands. Arguments after `<cmd> <sub>`; absent means none. Anything that
 * would change the machine for real (passphrase set/delete, eject, apply
 * flags) is given a safe or read-only spelling.
 */
const SUB_ARGS: Record<string, string[]> = {
  'artifact add': [TASK, '{note}'],
  'artifact list': [TASK],
  'artifact get': [TASK, 'note.txt'],
  'artifact rm': [TASK, 'note.txt'],
  'memory show': ['nonexistent-record'],
  'memory save': ['inv-record', '--description', 'inventory record'],
  'memory rm': ['nonexistent-record', '--yes'],
  'memory history': ['nonexistent-record'],
  'env set': [TASK, 'INV_VAR=x'],
  'env list': [TASK],
  'env ls': [TASK],
  'env unset': [TASK, 'INV_VAR'],
  'env rm': [TASK, 'INV_VAR'],
  'env clear': [TASK],
  'raised respond': [TASK, '00000000', 'ok'],
  'raised acknowledge': [TASK, '00000000'],
  'raised ack': [TASK, '00000000'],
  'raised dismiss': [TASK, '00000000'],
  'raised promote': [TASK, '00000000'],
  'raised blocking': [TASK, '00000000', 'true'],
  'messages read': ['00000000'],
  'messages dismiss': ['00000000'],
  'scratch show': ['nonexistent-note'],
  'scratch rm': ['nonexistent-note', '--yes'],
  'conversations search': ['inventory'],
  'conversations show': ['00000000'],
  'conversations promote': ['00000000'],
  'stats tools': [TASK],
  'stats timings': [TASK],
  'daemon logs': ['--lines', '5'],
  'daemon auto-budget': [],
  'daemon config': [],
  'system agent': [],
  'system passphrase': ['status'],
  'system source-id': ['.'],
  // Machine-local and project-free: --id answers without writing to /run.
  'system guest-init-script': ['--id'],
  // Machine-local and project-free: prints the pinned builder image and builds nothing.
  'system smolvm-build-image': ['--print-builder-image'],
  'system repair-commits': ['--all'],
  'system store-check': ['/nonexistent-store'],
  'system store-backup': ['--store', '/nonexistent-store'],
  'system store-backups': ['--store', '/nonexistent-store'],
  'system store-restore': ['no-such-backup', '--store', '/nonexistent-store', '--yes'],
  'system runner-image': [],
  'system machine': [],
  'system export-dockerfile': ['--stdout'],
  'system eject-dockerfile': ['--stdout'],
  'customize proxy-plugin': [],
};

/** Subcommands that are not in a usage map but are real (the multiplexers' lifecycle verbs). */
const EXTRA_SUBS: Record<string, string[]> = {
  daemon: ['start', 'stop', 'status', 'restart'],
};

/** Commands whose subcommand listing is a usage map: [command, subcommand names]. */
const SUB_MAPS: Record<string, Record<string, () => void>> = {
  daemon: daemonSubcommandUsage,
  system: systemSubcommandUsage,
  artifact: artifactSubcommandUsage,
  memory: memorySubcommandUsage,
  env: envSubcommandUsage,
  stats: statsSubcommandUsage,
  raised: raisedSubcommandUsage,
  messages: messagesSubcommandUsage,
  scratch: scratchSubcommandUsage,
  conversations: conversationsSubcommandUsage,
  customize: customizeSubcommandUsage,
};

/**
 * What every probe does TODAY in a bound clone. A probe missing from this map
 * fails the suite — classifying it is a decision. `BROKEN`/`HANGS` entries are
 * the defects the follow-up fix tasks should flip.
 */
const EXPECTED: Record<string, Expectation> = {
  'link': F,
  'describe': R,
  'import-conversation': W,
  'init': R,
  'create': W,
  'edit': W,
  'clone': W,
  'list': W,
  'active': W,
  'blocked': W,
  'show': W,
  'search': W,
  'comment': F,
  'tag': W,
  'untag': W,
  'journal': W,
  'memory': W,
  'scratch': W,
  'artifact': F,
  'messages': W,
  'raised': W,
  'conversations': W,
  'start': W,
  'unblock': W,
  'resume': W,
  'reopen': F,
  'branch': F,
  'diff': W,
  'regions': W,
  'status': W,
  'shell': F,
  'dashboard': R,
  'playground': W,
  'url': F,
  'forward': { status: 'refuses' },
  'pair': F,
  'chat': F, // attaches to the task's session on the server, as `pair` does; the seed task has none yet — domain answer
  'accept': R, // the seed task targets `main`, protected by default on a Teams project: only a member's Accept in Teams merges it, and the refusal says so
  'protect': W,
  'close': W,
  'reject': W,
  'stop': F,
  'revert': R, // refused before anything is written: Teams cannot record reverts_task_id, and the browser has no revert
  'wait': W,
  'builder': F,
  'doctor': R,
  'auth': W,
  'login': W,
  'loop': F,
  'submit': R, // a Teams-hosted repo has no PRs; the refusal explains where the work goes
  'sync': W,
  'reparent': W,
  'completion': W,
  'review': W,
  'browse': F,
  'ask': F,
  'redo': W,
  'upgrade': { status: 'refuses' },
  'stats': F,
  'env': F,
  'customize': F,
  'system': F,
  'document': W,
  'refactor': W,
  'fix': W,
  'rework': R, // refused before anything is written: Teams cannot record rework_of, and the browser has no rework
  'daemon': W,
  'watch': F,
  'config': W,
  'report': W, // its one-shots run in the daemon on the member's own credential (runOneshot at the ask_agent? bar)
  'daemon logs': { status: 'refuses' },
  'daemon auto-budget': W,
  'daemon config': R,
  'daemon resume-queue': W,
  'daemon health': R,
  'daemon reload': R,
  'daemon start': R,
  'daemon stop': R,
  'daemon status': R,
  'daemon restart': R,
  'system build': F,
  'system status': W,
  'system agent': W,
  'system passphrase': W,
  'system source-id': W,
  'system guest-init-script': W,
  'system smolvm-build-image': W,
  'system repair-commits': R,
  'system store-check': F,
  'system store-backup': F,
  'system store-backups': W,
  'system store-restore': F,
  'system runner-image': W,
  'system machine': R,
  'system offline': { status: 'refuses' },
  'system online': { status: 'refuses' },
  'system export-dockerfile': W,
  'system eject-dockerfile': W,
  'artifact list': W,
  'artifact add': W,
  'artifact get': F,
  'artifact rm': R,
  'memory list': W,
  'memory show': F,
  'memory save': F,
  'memory rm': F,
  'memory history': W,
  'memory compact': W,
  'env set': R,
  'env list': R,
  'env ls': R,
  'env unset': R,
  'env rm': R,
  'env clear': R,
  'stats tokens': W,
  'stats tools': W,
  'stats timings': R,
  'stats latency': W,
  'stats audit': W,
  'stats limits': W,
  'stats budget': W,
  'raised list': W,
  'raised respond': F,
  'raised acknowledge': F,
  'raised ack': F,
  'raised dismiss': F,
  'raised promote': F,
  'raised blocking': F,
  'messages list': W,
  'messages read': F,
  'messages dismiss': F,
  'scratch list': W,
  'scratch show': F,
  'scratch sync': R,
  'scratch rm': R,
  'scratch path': W,
  'conversations list': W,
  'conversations search': W,
  'conversations show': F,
  'conversations promote': F,
  'customize proxy-plugin': F,
  'loop (forced tty)': { status: 'works' },
  'loop (forced tty, queue)': R, // drives the task to its accept, which `main`'s default protection refuses, pointing at Teams' Accept
  'logout': W,
};

describe('inventory of every lazy command in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let target: string;
  let alice: string;
  let shared: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;
  const proxied: string[] = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzinv-'));
    ctx = await setupTestLazy({ withDaemon: true });
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MOCK_SHOULD_COMMIT: '1',
    });
    target = getDaemonTcpTarget(ctx.root)!;
    shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-inv' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-inv' });
    alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;

    clone = join(workDir, 'clone');
    await runGit(['init', '-b', 'main', clone], { cwd: workDir });
    await runGit(['config', 'user.email', ALICE], { cwd: clone });
    await runGit(['config', 'user.name', 'Alice'], { cwd: clone });
    await writeFile(join(clone, 'README.md'), '# lazy-toy\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'Initial commit'], { cwd: clone });
    await writeFile(join(workDir, 'note.txt'), 'inventory artifact\n');
    unpinBase = pinDaemonBaseDir(join(workDir, 'laptop-daemon'));
    teams = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => (await relayTeamsRpc(req, {
        project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root, proxied,
        usageViews: { controlToken: () => shared, memberEmail: ALICE },
        daemonTarget: () => target, memberToken: () => alice,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
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

  /** One real `lazy` subprocess in the bound clone, stdin closed, bounded. */
  async function runLazy(args: string[], extraEnv: Record<string, string> = {}): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
    // INVARIANT: a probe's outcome never depends on the caller's environment. Strip every
    // ambient LAZY_* seam that steers a command (scratch dir, config, MCP role, forced
    // gates, ...) before pinning the ones the probe owns; a caller exporting
    // LAZY_SCRATCH_DIR once flipped `scratch sync` from works to refuses.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAZY_')));
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
      cwd: clone,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PER_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        ...inherited,
        HOME: join(workDir, 'laptop-home'),
        LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '',
        LAZY_IS_DAEMON: '',
        LAZY_FORCE_TTY: '',
        LAZY_PROMPT_DEFAULTS: '',
        NO_COLOR: '1',
        ...extraEnv,
      },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode, timedOut: proc.signalCode === 'SIGKILL', stdout, stderr };
  }

  const notePath = () => join(workDir, 'note.txt');
  let seq = 0;
  async function freshTask(started: boolean): Promise<string> {
    const code = `inv-${++seq}`;
    const made = await runLazy(['create', '--goal', `Inventory seed ${seq}`, '--prompt', 'Seed.', '--code', code]);
    if (made.exitCode !== 0) return code; // The probe will then report the failure itself.
    if (started) {
      await runLazy(['start', code]);
      await runLazy(['wait', code]);
    }
    return code;
  }

  async function expand(args: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const a of args) {
      if (a === TASK) out.push(await freshTask(false));
      else if (a === STARTED) out.push(await freshTask(true));
      else out.push(a === '{note}' ? notePath() : a);
    }
    return out;
  }

  function classify(r: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }): Status {
    if (r.timedOut) return 'hangs';
    if (r.exitCode === 0) return 'works';
    const text = `${r.stderr}\n${r.stdout}`;
    // A deliberate refusal names the binding, the install, or `lazy logout`.
    if (/bound to Lazy Teams|bound to https?:\/\/|lazy logout|not available in a clone bound|Lazy Teams/i.test(text)) return 'refuses';
    return 'fails';
  }

  test('every command and subcommand is classified, and the classification is the expected one', async () => {
    const top = await topLevelCommands();
    // Sanity: the parse found the real table, not nothing.
    expect(top.length).toBeGreaterThan(60);
    for (const must of ['list', 'loop', 'system', 'accept']) expect(top).toContain(must);

    const probes: Probe[] = [];
    for (const cmd of top) {
      if (!Object.hasOwn(TOP_ARGS, cmd)) throw new Error(`top-level command '${cmd}' has no entry in TOP_ARGS — add safe arguments for it and classify it in EXPECTED`);
      probes.push({ key: cmd, args: [cmd, ...TOP_ARGS[cmd]] });
    }
    for (const [cmd, map] of Object.entries(SUB_MAPS)) {
      for (const sub of [...Object.keys(map), ...(EXTRA_SUBS[cmd] ?? [])]) {
        const key = `${cmd} ${sub}`;
        probes.push({ key, args: [cmd, sub, ...(SUB_ARGS[key] ?? [])] });
      }
    }

    // `lazy loop` is TTY-only: the plain probe records the non-interactive refusal, this one
    // forces the TTY seam (a test-only env var) to reach what the loop actually does bound.
    probes.push({ key: 'loop (forced tty)', args: ['loop', '--backlog'], env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline', EDITOR: 'true', VISUAL: 'true' } });
    probes.push({ key: 'loop (forced tty, queue)', args: ['loop', TASK], env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'n', EDITOR: 'true', VISUAL: 'true' } });

    // `login` and `logout` mutate the binding itself; run them last.
    const ordered = [...probes.filter((p) => p.key !== 'logout'), ...probes.filter((p) => p.key === 'logout')];
    const observed: Array<Probe & { status: Status; text: string }> = [];
    for (const p of ordered) {
      const r = await runLazy(await expand(p.args), p.env);
      const text = `${r.stderr}\n${r.stdout}`.replace(/\s+/g, ' ').trim().slice(0, 300);
      observed.push({ ...p, status: classify(r), text: r.timedOut ? 'timed out' : text });
    }

    if (process.env.INVENTORY_DUMP) {
      for (const o of observed) console.log(`${o.key}\t${o.status}\t${o.text}`);
    }

    const wrong = observed.filter((o) => EXPECTED[o.key]?.status !== o.status).map((o) => `${o.key}: expected ${EXPECTED[o.key]?.status ?? '(unclassified)'}, observed ${o.status} — ${o.text}`);
    // INVARIANT: commands that operate this machine refuse BY NAME in a bound clone. classify() alone
    // cannot tell that refusal from any other Teams-mentioning failure (e.g. the old getAuthEnv error).
    const byName = ['forward', 'upgrade', 'daemon logs', 'system offline', 'system online', 'scratch sync'];
    const notByName = observed
      .filter((o) => byName.includes(o.key) && !(o.text.includes('operates this machine') && !/getAuthEnv|lazy daemon start/.test(o.text)))
      .map((o) => `${o.key}: ${o.text}`);
    expect(notByName).toEqual([]);
    const stale = Object.keys(EXPECTED).filter((k) => !observed.some((o) => o.key === k));
    expect({ wrong, stale }).toEqual({ wrong: [], stale: [] });
  }, 1_800_000);
});
