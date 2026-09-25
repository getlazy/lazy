/**
 * E2E: the WHOLE `lazy_*` MCP surface, driven from a clone bound to Lazy Teams.
 *
 * A person running their own Claude Code against a Teams project gets the
 * laptop MCP server (`lazy mcp --task-id '' --worktree <clone>`): no daemon
 * of its own, every tool resolving storage and RPCs through the Teams proxy
 * route. The claim is that this one seam carries the whole surface with no
 * per-tool work — which is exactly the claim that needs a test, not a sentence.
 *
 * What is real: the `lazy mcp` subprocess in a freshly bound clone (git init,
 * a Teams login record, no `lazy init`), spoken to over its own stdio JSON-RPC;
 * a MANAGED daemon holding the project, reached on the member's actor token.
 * What is stood in for: Teams' RPC proxy route (`teams-rpc-proxy-stub.ts`),
 * which admits exactly what the Rails tables admit, read off the Ruby source.
 *
 * The tool list comes from the server's own `tools/list` plus the registry
 * (`allTools`), never a hand list — a tool added tomorrow is swept tomorrow.
 * Each tool's OUTCOME is observed and then checked against {@link EXPECTED}:
 * a tool missing from that table fails the suite, so the classification of a
 * new tool is a decision somebody makes, not something that happens to it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { writeTeamsLogin } from '../../src/teams/login';
import { allTools } from '../../src/mcp/tools';
import { runGit } from '../../src/utils/git';

const ALICE = 'alice@example.com';
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const CONVERSATION_ID = '11111111-2222-3333-4444-555555555555';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

/**
 * How a tool may end in a bound clone.
 *
 * - `answers`   — the call reached the project and came back with a result.
 * - `domain`    — the project answered with its own refusal about THIS
 *                 task (it is not running, it is in backlog). Named per tool,
 *                 never a catch-all.
 * - `binding`   — refused, naming the Teams binding and what to do instead.
 * - `role`      — refused because the tool belongs to a task agent, not a
 *                 builder; true on any laptop, bound or not.
 * - `generic`   — the proxy's own "Unknown or unsupported command" 403/404.
 *                 Tracked separately on purpose: it is a refusal, but it
 *                 tells a person nothing about the binding.
 * - `obscure`   — anything else. Never acceptable.
 */
type Outcome = 'answers' | 'domain' | 'binding' | 'role' | 'generic' | 'obscure';

/** What each tool does in a bound clone, decided once and checked every run. */
const EXPECTED: Record<string, Outcome> = {
  // Reads: the whole read surface rides the proxy.
  lazy_search: 'answers',
  lazy_show: 'answers',
  lazy_list: 'answers',
  lazy_blocked: 'answers',
  lazy_active: 'answers',
  lazy_diff: 'answers',
  lazy_regions: 'answers',
  lazy_wait: 'answers',
  lazy_status: 'answers',
  lazy_memory_recall: 'answers',
  lazy_messages: 'answers',
  lazy_raised_items: 'answers',
  lazy_artifact_list: 'answers',
  lazy_artifact_get: 'answers',
  lazy_conversations: 'answers',
  lazy_conversation_search: 'answers',
  lazy_conversation_read: 'answers',
  // Task writes and the task lifecycle, each as the member.
  lazy_create: 'answers',
  lazy_edit: 'answers',
  lazy_clone: 'answers',
  lazy_comment: 'answers',
  lazy_tag: 'answers',
  lazy_untag: 'answers',
  lazy_journal: 'answers',
  lazy_artifact_add: 'answers',
  lazy_start: 'answers',
  lazy_unblock: 'answers',
  lazy_resume: 'answers',
  lazy_ask: 'answers',
  lazy_review: 'answers',
  // Swept against a parked task: the daemon's own "only running tasks can be stopped".
  lazy_stop: 'domain',
  lazy_accept: 'answers',
  lazy_reject: 'answers',
  lazy_close: 'answers',
  lazy_reopen: 'answers',
  lazy_sync: 'answers',
  // Refused by Teams — the browser cannot do them either — named by the client.
  lazy_memory_save: 'binding',
  lazy_scratch: 'binding',
  lazy_message_post: 'binding',
  lazy_message_dismiss: 'binding',
  lazy_submit: 'binding',
  lazy_reparent: 'binding',
  lazy_link: 'binding',
  lazy_raised_promote: 'binding',
  // Every member's readings: Teams relays neither usage RPC to a clone.
  lazy_usage_limits: 'binding',
  // Runs a model one-shot, which Teams does not offer to a clone.
  lazy_conversation_ask: 'binding',
  // Several writes Teams would relay only in part: refused before the first.
  lazy_redo: 'binding',
  // A task agent's own tools. A laptop MCP server has no task of its own.
  lazy_final: 'role',
  lazy_raise: 'role',
  lazy_raised_item_comment: 'role',
  lazy_report: 'role',
  lazy_justify_protected: 'role',
  lazy_justify_maintain: 'role',
  lazy_update_progress: 'role',
  lazy_commit: 'role',
};

/** Arguments beyond the schema's required ones, where a placeholder would not reach the tool's real work. */
const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  lazy_edit: { goal: 'Edited through Teams' },
  lazy_artifact_add: { content: 'hello from a bound clone', name: 'note.txt' },
  lazy_reject: { reason: 'Swept' },
  lazy_close: { reason: 'Swept' },
  lazy_stop: { reason: 'Swept' },
  lazy_message_dismiss: { id: '00000000-0000-0000-0000-000000000000' },
  lazy_wait: { timeout: 5 },
  lazy_artifact_get: { name: 'note.txt' },
};

/** Tools with a `task_id` that is a FILTER, not a target — swept project-wide. */
const UNSCOPED = new Set(['lazy_list', 'lazy_active']);

/** Tools whose real work needs a task that has had a turn — swept against a started, parked one. */
const NEEDS_A_TURN = new Set([
  'lazy_unblock', 'lazy_ask', 'lazy_review', 'lazy_accept', 'lazy_reject', 'lazy_resume',
  'lazy_diff', 'lazy_regions', 'lazy_wait', 'lazy_sync', 'lazy_submit',
]);

/**
 * Failure text that means the call never got a real answer: a transport
 * failure, a crash, or advice that is wrong for a bound clone (there is no
 * local daemon to start and no project to initialize).
 */
const OBSCURE = [
  /Forbidden|may not act as|cannot carry|\b40[13]\b/,
  /fetch failed|ECONNREFUSED|Unable to connect|socket/i,
  /Daemon is not running|lazy daemon (start|status|restart)|lazy init|not in a lazy project/i,
  /TypeError|ReferenceError|SyntaxError|Cannot read propert|is not a function|undefined is not/,
  /failed: 5\d\d|Internal Server Error/,
  /ENOENT|no such file or directory|lazy\.toml/i,
];

function classify(r: { isError: boolean; text: string }): Outcome {
  // A refusal naming the binding may quote the route's reason ("cannot carry
  // …"), so it is recognised before the obscure patterns are.
  if (r.isError && /bound to Lazy Teams \(acme\/lazy-toy on http:\/\/127\.0\.0\.1:\d+\)/.test(r.text) && /lazy builder/.test(r.text)) {
    return 'binding';
  }
  if (OBSCURE.some((re) => re.test(r.text))) return 'obscure';
  if (!r.isError) return 'answers';
  if (/Unknown or unsupported command/.test(r.text)) return 'generic';
  if (/not available in builder mode/.test(r.text)) return 'role';
  return 'domain';
}

interface Observed { tool: string; outcome: Outcome; isError: boolean; text: string }

describe('the lazy_* MCP surface in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let target: string;
  let alice: string;
  let teams: ReturnType<typeof Bun.serve>;
  let unpinBase: () => void;
  const proxied: string[] = [];
  const observed: Observed[] = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzmcps-'));
    ctx = await setupTestLazy({ withDaemon: true });
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      // Every mocked turn commits, so accept has something to merge.
      LAZY_MOCK_SHOULD_COMMIT: '1',
    });
    target = getDaemonTcpTarget(ctx.root)!;
    const shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-sweep' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-sweep' });
    alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;

    clone = join(workDir, 'clone');
    await runGit(['init', clone], { cwd: workDir });
    await runGit(['config', 'user.email', ALICE], { cwd: clone });
    await runGit(['config', 'user.name', 'Alice'], { cwd: clone });
    await writeFile(join(clone, 'README.md'), '# lazy-toy\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'Initial commit'], { cwd: clone });
    unpinBase = pinDaemonBaseDir(join(workDir, 'laptop-daemon'));
    teams = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => (await relayTeamsRpc(req, {
        project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root, proxied,
        daemonTarget: () => target, memberToken: () => alice,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
    });
    await writeTeamsLogin(clone, {
      teamsUrl: `http://127.0.0.1:${teams.port}`, token: CLI_TOKEN, project: PROJECT, projectId: '42',
    });
    mcp = startMcp();
    const init = await mcp.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sweep', version: '1' },
    });
    if (init.error) throw new Error(`the laptop MCP server refused to initialize: ${JSON.stringify(init.error)}`);

    // What the read/promote tools need to reach their real work: a stored
    // conversation, and a task with a raised item. Seeded on the daemon
    // directly — the laptop surface under test may not be able to write them.
    const now = new Date().toISOString();
    await rpc(alice, 'storage', { method: 'saveConversation', args: { conversation: {
      sessionId: CONVERSATION_ID, projectPath: 'lazy-toy', cwd: null, version: null, gitBranch: null,
      startedAt: now, endedAt: now, importedAt: Date.now(), summary: 'A seeded conversation',
      stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 0 },
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      messages: [{ uuid: 'm1', parentUuid: null, timestamp: now, role: 'user', text: 'Hello from the seed.', model: null, usage: null }],
      subagents: [],
    } } });
  }, 120_000);

  afterAll(async () => {
    if (mcp) await mcp.stop();
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase();
    await rm(workDir, { recursive: true, force: true });
  });

  /** A `lazy mcp` server in the clone, exactly as Claude Code would spawn it. */
  function startMcp() {
    const proc = Bun.spawn(['bun', 'run', ENTRY, 'mcp', '--task-id', '', '--worktree', clone], {
      cwd: clone,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: join(workDir, 'laptop-home'),
        LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '',
        LAZY_IS_DAEMON: '',
        LAZY_MCP_EXPECTED_TASK_ID: '',
        LAZY_MCP_EXPECTED_WORKTREE: '',
      },
    });
    const pending = new Map<number, (msg: any) => void>();
    let nextId = 1;
    let buffer = '';
    const decoder = new TextDecoder();
    const reader = (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          }
        }
      }
    })();
    const request = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      const id = nextId++;
      const reply = new Promise<any>((resolve) => pending.set(id, resolve));
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      await proc.stdin.flush();
      return await Promise.race([
        reply,
        Bun.sleep(60_000).then(() => { throw new Error(`MCP ${method} ${JSON.stringify(params).slice(0, 200)} never answered`); }),
      ]);
    };
    const stop = async () => {
      await proc.stdin.end();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      await reader;
      return stderr;
    };
    return { request, stop };
  }

  let mcp: ReturnType<typeof startMcp>;

  async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const reply = await mcp.request('tools/call', { name, arguments: args });
    if (reply.error) return { isError: true, text: String(reply.error.message) };
    const text = (reply.result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    return { isError: reply.result.isError === true, text };
  }

  /** A two-step tool answers its first call with a code; echo it, because the step that WRITES must survive the proxy. */
  async function callThrough(name: string, args: Record<string, unknown>) {
    const first = await call(name, args);
    const code = /confirmation_code: \\?"([^"\\]+)/.exec(first.text)?.[1];
    return code ? await call(name, { ...args, confirmation_code: code }) : first;
  }

  let seq = 0;
  /** A fresh task, created through the same surface — and, when asked, started and parked. */
  async function freshTask(started = false): Promise<string> {
    const code = `sweep-${++seq}`;
    const made = await call('lazy_create', { goal: `Sweep target ${seq}`, prompt: 'Sweep the surface.', code });
    if (made.isError) throw new Error(`could not seed a task through lazy_create: ${made.text}`);
    if (started) {
      const start = await call('lazy_start', { task_id: code });
      if (start.isError) throw new Error(`could not start ${code} through lazy_start: ${start.text}`);
      const waited = await call('lazy_wait', { task_id: code, timeout: 60 });
      if (waited.isError) throw new Error(`lazy_wait on ${code} failed: ${waited.text}`);
    }
    return code;
  }

  async function taskCount(): Promise<number> {
    return (await rpc(alice, 'storage', { method: 'listTasks', args: {} }) as unknown[]).length;
  }

  // INVARIANT: every registered lazy_* tool, driven through a clone bound to
  // Teams, either does its work or refuses naming the install and the way
  // forward — never a transport error, a crash, a 403 the person cannot act on,
  // or the proxy's own generic wording. A bound clone is how people use their
  // own Claude Code against a Teams project; an obscure failure there is a
  // dead end with nobody to ask.
  test('every tool either answers or refuses naming the binding — none fails obscurely', async () => {
    const listed = await mcp.request('tools/list');
    const advertised = (listed.result.tools as Array<{ name: string }>).map((t) => t.name);
    // The server advertises from the registry; the sweep enumerates the
    // registry itself, so a tool hidden from a builder is swept too.
    expect(advertised.every((name) => allTools.some((t) => t.name === name))).toBe(true);

    for (const tool of allTools) {
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, any> };
      const args: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const prop = schema.properties?.[key] ?? {};
        if (key === 'task_id') continue;
        if (Array.isArray(prop.enum)) args[key] = prop.enum[0];
        else if (prop.type === 'boolean') args[key] = false;
        else if (prop.type === 'array') args[key] = [];
        else if (prop.type === 'object') args[key] = {};
        else if (prop.type === 'number' || prop.type === 'integer') args[key] = 1;
        else args[key] = 'sweep';
      }
      if (Object.hasOwn(schema.properties ?? {}, 'task_id') && !UNSCOPED.has(tool.name)) {
        args.task_id = await freshTask(NEEDS_A_TURN.has(tool.name));
      }
      Object.assign(args, ARG_OVERRIDES[tool.name] ?? {});
      if (tool.name === 'lazy_conversation_read' || tool.name === 'lazy_conversation_ask') {
        args.session_id = CONVERSATION_ID;
      }
      if (tool.name === 'lazy_artifact_get') {
        const added = await call('lazy_artifact_add', { task_id: args.task_id, content: 'fetch me', name: 'note.txt' });
        if (added.isError) throw new Error(`could not attach an artifact to fetch: ${added.text}`);
      }
      if (tool.name === 'lazy_raised_promote') {
        const resolved = await rpc(alice, 'storage', { method: 'resolveTask', args: { input: args.task_id } }) as { task: { id: string } };
        const item = await rpc(alice, 'storage', {
          method: 'createRaisedItem', args: { taskId: resolved.task.id, input: { content: 'Worth a follow-up', blocking: false } },
        }) as { id: string };
        args.item_id = item.id;
      }
      if (tool.name === 'lazy_reopen') {
        // Reopen answers only for a closed task — close it first, through the same surface.
        const closed = await callThrough('lazy_close', { task_id: args.task_id, reason: 'To be reopened' });
        if (closed.isError) throw new Error(`could not close ${String(args.task_id)} to reopen it: ${closed.text}`);
      }
      const r = await callThrough(tool.name, args);
      observed.push({ tool: tool.name, outcome: classify(r), isError: r.isError, text: r.text });
    }

    if (process.env.SWEEP_DUMP) {
      for (const o of observed) console.log(`${o.tool}\t${o.outcome}\t${o.text.replace(/\s+/g, ' ').slice(0, 240)}`);
    }

    const byTool = Object.fromEntries(observed.map((o) => [o.tool, o.outcome]));
    // Every registered tool is classified, and nothing is classified that no
    // longer exists — a new tool fails here until someone decides its row.
    expect(Object.keys(byTool).sort()).toEqual(Object.keys(EXPECTED).sort());
    const wrong = observed
      .filter((o) => o.outcome !== EXPECTED[o.tool])
      .map((o) => `${o.tool}: expected ${EXPECTED[o.tool]}, observed ${o.outcome} — ${o.text.slice(0, 400)}`);
    expect(wrong).toEqual([]);
    // The two outcomes that are never acceptable, stated on their own so a
    // table edit cannot quietly admit them.
    expect(observed.filter((o) => o.outcome === 'obscure').map((o) => o.tool)).toEqual([]);
    expect(observed.filter((o) => o.outcome === 'generic').map((o) => o.tool)).toEqual([]);
    // And it all went through Teams: the laptop has no daemon to reach.
    expect(proxied).toContain('startTask');
    expect(proxied).toContain('storage:createTask');
  }, 600_000);

  // INVARIANT: in a bound clone, a write made through the MCP surface is the
  // MEMBER's, on the member's token, with the member's role — never the
  // `builder` channel, which nothing on that wire could prove and which the
  // daemon refuses on a per-user token.
  test('a write through the laptop MCP server is attributed to the member', async () => {
    const code = await freshTask();
    const commented = await call('lazy_comment', { task_id: code, message: 'Written from my own Claude Code.' });
    expect(commented.isError).toBe(false);

    const resolved = await rpc(alice, 'storage', { method: 'resolveTask', args: { input: code } }) as { task: { id: string } };
    const comments = await rpc(alice, 'storage', { method: 'getTaskComments', args: { taskId: resolved.task.id } }) as Array<Record<string, unknown>>;
    const comment = comments.find((c) => c.content === 'Written from my own Claude Code.');
    expect(comment).toBeDefined();
    expect(comment!.actor).toBe('human');
    expect(comment!.actor_email).toBe(ALICE);
  }, 120_000);

  // INVARIANT: a tool whose writes Teams would relay only in part refuses
  // BEFORE the first one — never leaves a replacement task beside an original
  // it could not close, or a task created without the setting it was asked for.
  test('multi-step writes Teams would stop halfway refuse before writing anything', async () => {
    const original = await freshTask();
    const before = await taskCount();

    const redo = await callThrough('lazy_redo', { task_id: original });
    expect(classify(redo)).toBe('binding');
    const withRunner = await call('lazy_create', { goal: 'Pinned runner', runner: 'docker' });
    expect(classify(withRunner)).toBe('binding');
    const withReview = await call('lazy_create', { goal: 'Reviewed separately', review: 'separate' });
    expect(classify(withReview)).toBe('binding');
    const edited = await call('lazy_edit', { task_id: original, goal: 'Should not land', review: 'separate' });
    expect(classify(edited)).toBe('binding');
    const switched = await call('lazy_edit', { task_id: original, goal: 'Should not land', agent: 'cursor' });
    expect(classify(switched)).toBe('binding');
    const onBranch = await call('lazy_create', { goal: 'On a branch', parent: 'master' });
    expect(classify(onBranch)).toBe('binding');

    expect(await taskCount()).toBe(before);
    const shown = await call('lazy_show', { task_id: original });
    expect(shown.text).toContain('Sweep target');
    expect(shown.text).not.toContain('Should not land');
    expect(shown.text).not.toContain('"status": "abandoned"');
  }, 120_000);

  // INVARIANT: an opt-in flag (`forceLocal`, `retargetOrphan`,
  // `acceptDirtyWorktree`, …) is left out of a request unless it is set. The
  // Teams proxy refuses those keys by NAME, whatever their value, so sending
  // `false` got an ordinary `lazy start` refused in every bound clone.
  test('lazy start, unblock and accept from the CLI in a bound clone reach the project', async () => {
    const code = await freshTask();
    const env = {
      HOME: join(workDir, 'laptop-home'), LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
      LAZY_TEST: '', LAZY_IS_DAEMON: '',
    };
    proxied.length = 0;

    const started = await ctx.lazy(['start', code], { cwd: clone, env });
    expect(started.stderr).not.toContain('cannot carry');
    expect(started.exitCode).toBe(0);
    expect(proxied).toContain('startTask');
    const waited = await call('lazy_wait', { task_id: code, timeout: 60 });
    expect(waited.isError).toBe(false);

    const unblocked = await ctx.lazy(['unblock', code, '-m', 'One more pass.'], { cwd: clone, env });
    expect(unblocked.stderr).not.toContain('cannot carry');
    expect(unblocked.exitCode).toBe(0);
    expect(proxied).toContain('unblockTask');
    await call('lazy_wait', { task_id: code, timeout: 60 });

    const accepted = await ctx.lazy(['accept', code, '--yes'], { cwd: clone, env });
    expect(accepted.stderr).not.toContain('cannot carry');
    expect(accepted.exitCode).toBe(0);
    expect(proxied).toContain('acceptTask');
  }, 240_000);
});
