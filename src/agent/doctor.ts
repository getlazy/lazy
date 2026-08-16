/**
 * `lazy-agent doctor` — MCP diagnosis from INSIDE an agent container.
 *
 * This command exists because `claude mcp list` cannot answer the question that
 * actually matters. `mcp list` prints "✔ Connected" for any server that starts
 * and answers `initialize` — it never prints a tool count, and it never says
 * anything about what Claude Code loaded into the AGENT's own process. A server
 * that registers zero tools, and a server the agent never loaded at all, both
 * render as "✔ Connected". That is exactly the state a real incident sat in:
 * `mcp list` green in the container while the agent failed every call with
 * `No such tool available: lazy_status`.
 *
 * So each check here is chosen to break that ambiguity into named links:
 * config file → ~/.claude.json entry → permissions → the server's OWN tool
 * count → a real daemon round-trip → (opt-in) what Claude Code itself loads.
 * Whichever link fails names the cause without further guessing.
 *
 * Deliberately self-contained: it must run from a bare
 * `docker exec -it <container> bash` with no arguments and no daemon-side
 * imports. The host-side `lazy doctor` (src/cli/commands/doctor.ts) pulls in
 * storage, config, docker and remote drivers — none of which exist or make
 * sense in here.
 *
 * SECURITY: the daemon MCP bearer token is read by several of these checks and
 * is NEVER printed, in text or in --json output. Only its presence and length.
 */

import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import { join, isAbsolute } from 'path';
import { hostname } from 'os';
import { which } from 'bun';
import { spawn } from '../utils/spawn';
import { getHome } from '../utils/home';
import { READ_ONLY_TOOL_NAMES, TOOL_ACCESS } from '../mcp/tool-access';

/** One diagnosed link in the chain. */
export interface DoctorCheck {
  /** Stable machine-readable id (used by --json). */
  id: string;
  /** Human label printed next to the ✓/✗. */
  label: string;
  /**
   * `false` means this link is provably broken and the command exits non-zero.
   * A check that cannot determine anything reports ok with a `warning` instead
   * — the same "absence of evidence is not evidence of absence" rule the
   * session-start verification uses (src/supervisor/mcp-verify.ts).
   */
  ok: boolean;
  /** What was observed. */
  detail: string;
  /** What the human should do about it. Present on failures and on warnings. */
  remedy?: string;
  /** Set when the check ran but could not conclude. */
  warning?: boolean;
  /** Extra machine-readable fields for --json. Never contains secrets. */
  data?: Record<string, unknown>;
}

export interface AgentDoctorResult {
  host: string;
  taskId: string | null;
  checks: DoctorCheck[];
  /** True when every check concluded ok (warnings do not fail). */
  ok: boolean;
}

export interface AgentDoctorOptions {
  /** Run check 7: start a real `claude` process and read its init line. */
  probeAgent?: boolean;
  /** Emit JSON instead of the human report. */
  json?: boolean;
}

/** The MCP server entry lazy writes into ~/.claude.json. */
interface ClaudeJsonLazyEntry {
  command: string;
  args: string[];
}

/** A JSON-RPC reply from the MCP server, as far as doctor cares. */
interface RpcReply {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const LAZY_SERVER_NAME = 'lazy';
const LAZY_TOOL_PREFIX = 'mcp__lazy__';

/** How long the live MCP self-test waits for the server to answer. */
const MCP_SELFTEST_TIMEOUT_MS = 20_000;
/** How long `--probe-agent` waits for Claude Code's first stream-json line. */
const PROBE_AGENT_TIMEOUT_MS = 90_000;

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as T;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    // Any failure here (ENOENT, EACCES) means the caller cannot use the path,
    // which is all this helper claims to answer.
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Value of `--flag` in an argv array, or undefined. */
function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Check 1 — the daemon MCP config the container was launched with
// ---------------------------------------------------------------------------

interface DaemonConfigFacts {
  path?: string;
  projectRoot?: string;
  taskId?: string;
  target?: string;
}

async function checkDaemonConfig(): Promise<{ check: DoctorCheck; facts: DaemonConfigFacts }> {
  const path = process.env.LAZY_DAEMON_CONFIG;
  if (!path) {
    return {
      facts: {},
      check: {
        id: 'daemon-config',
        label: 'LAZY_DAEMON_CONFIG',
        ok: false,
        detail: 'not set in this environment',
        remedy:
          'The container was launched without a daemon MCP config. Agent turns cannot reach ' +
          'the daemon at all. Stop the task and start it again so the runner re-launches the ' +
          'container, and check `lazy daemon status` on the host.',
      },
    };
  }

  let raw: { token?: string; projectRoot?: string; taskId?: string; target?: string };
  try {
    raw = await readJsonFile(path);
  } catch (err) {
    return {
      facts: { path },
      check: {
        id: 'daemon-config',
        label: 'LAZY_DAEMON_CONFIG',
        ok: false,
        detail: `${path} — could not read or parse: ${errText(err)}`,
        remedy:
          'The config is mounted from the host. If the file is missing, the mount is wrong or ' +
          'the daemon removed it; restart the task so the host rewrites and remounts it.',
        data: { path },
      },
    };
  }

  const missing: string[] = [];
  if (!raw.token) missing.push('token');
  if (!raw.projectRoot) missing.push('projectRoot');
  if (!raw.target) missing.push('target');
  // taskId is legitimately empty in builder/project-wide mode, so it is not required.

  const facts: DaemonConfigFacts = {
    path,
    projectRoot: raw.projectRoot,
    taskId: raw.taskId,
    target: raw.target,
  };

  if (missing.length > 0) {
    return {
      facts,
      check: {
        id: 'daemon-config',
        label: 'LAZY_DAEMON_CONFIG',
        ok: false,
        detail: `${path} parses but is missing: ${missing.join(', ')}`,
        remedy: 'Restart the task so the host rewrites the config.',
        data: { path, projectRoot: raw.projectRoot, taskId: raw.taskId, target: raw.target },
      },
    };
  }

  return {
    facts,
    // NEVER print the token. Its length is enough to tell "present" from
    // "empty string" without putting a live credential in a pasted transcript.
    check: {
      id: 'daemon-config',
      label: 'LAZY_DAEMON_CONFIG',
      ok: true,
      detail:
        `${path}\n    projectRoot=${raw.projectRoot}\n    taskId=${raw.taskId || '(none — builder mode)'}\n` +
        `    target=${raw.target}\n    token=present (${raw.token!.length} chars, not shown)`,
      data: {
        path,
        projectRoot: raw.projectRoot,
        taskId: raw.taskId ?? '',
        target: raw.target,
        tokenLength: raw.token!.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Check 2 — ~/.claude.json: the entry Claude Code actually reads
// ---------------------------------------------------------------------------

async function checkClaudeJson(
  facts: DaemonConfigFacts,
): Promise<{ check: DoctorCheck; entry?: ClaudeJsonLazyEntry }> {
  const path = join(getHome(), '.claude.json');
  let config: { mcpServers?: Record<string, ClaudeJsonLazyEntry> };
  try {
    config = await readJsonFile(path);
  } catch (err) {
    return {
      check: {
        id: 'claude-json',
        label: '~/.claude.json mcpServers.lazy',
        ok: false,
        detail: `${path} — could not read or parse: ${errText(err)}`,
        remedy:
          'Lazy writes this file before every turn. If it is missing, no turn has started in ' +
          'this container yet; if it is corrupt, delete it and start a turn to have it rewritten.',
        data: { path },
      },
    };
  }

  const entry = config.mcpServers?.[LAZY_SERVER_NAME];
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) {
    const names = Object.keys(config.mcpServers ?? {});
    return {
      check: {
        id: 'claude-json',
        label: '~/.claude.json mcpServers.lazy',
        ok: false,
        detail:
          `no usable "lazy" server entry. Servers present: ${names.length ? names.join(', ') : '(none)'}`,
        remedy:
          'The turn launched without writing the lazy MCP entry. Start a fresh turn; if it is ' +
          'still absent, the supervisor failed before `prepareTurnMcp` — check the task turn error.',
        data: { path, servers: names },
      },
    };
  }

  const problems: string[] = [];
  const resolved = isAbsolute(entry.command) ? entry.command : which(entry.command);
  if (!resolved || !(await exists(resolved))) {
    problems.push(`command '${entry.command}' does not resolve on PATH`);
  }
  const daemonConfigArg = argValue(entry.args, '--daemon-config');
  if (daemonConfigArg && !(await exists(daemonConfigArg))) {
    problems.push(`--daemon-config path '${daemonConfigArg}' does not exist in this container`);
  }
  const taskIdArg = argValue(entry.args, '--task-id');
  // A mismatch here is the shape of a stale entry left by a PREVIOUS task in a
  // reused container: the server starts fine (so `mcp list` is green) but every
  // call is scoped to, or refused for, the wrong task.
  if (taskIdArg && facts.taskId && taskIdArg !== facts.taskId) {
    problems.push(
      `--task-id ${taskIdArg} does not match this container's task ${facts.taskId} (stale entry)`,
    );
  }

  const argvLine = [entry.command, ...entry.args].join(' ');
  if (problems.length > 0) {
    return {
      entry,
      check: {
        id: 'claude-json',
        label: '~/.claude.json mcpServers.lazy',
        ok: false,
        detail: `${argvLine}\n    ${problems.join('\n    ')}`,
        remedy:
          'Restart the task so the host rewrites ~/.claude.json and remounts the config; if the ' +
          'command itself does not resolve, the lazy-agent binary is missing from the image.',
        data: { path, command: entry.command, args: entry.args, problems },
      },
    };
  }

  return {
    entry,
    check: {
      id: 'claude-json',
      label: '~/.claude.json mcpServers.lazy',
      ok: true,
      detail: argvLine,
      data: { path, command: entry.command, args: entry.args },
    },
  };
}

// ---------------------------------------------------------------------------
// Check 3 — tool permissions
// ---------------------------------------------------------------------------

async function checkToolPermissions(): Promise<DoctorCheck> {
  const path = join(getHome(), '.claude', 'settings.json');
  let settings: { permissions?: { allow?: unknown } };
  try {
    settings = await readJsonFile(path);
  } catch (err) {
    return {
      id: 'tool-permissions',
      label: '~/.claude/settings.json permissions',
      ok: false,
      detail: `${path} — could not read or parse: ${errText(err)}`,
      remedy:
        'Lazy writes the mcp__lazy__* allow entries before every turn. Start a fresh turn to ' +
        'have it rewritten.',
      data: { path },
    };
  }

  const allow = Array.isArray(settings.permissions?.allow)
    ? (settings.permissions!.allow as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const lazyEntries = allow.filter(v => v.startsWith(LAZY_TOOL_PREFIX));

  if (lazyEntries.length === 0) {
    return {
      id: 'tool-permissions',
      label: '~/.claude/settings.json permissions',
      ok: false,
      detail: `no ${LAZY_TOOL_PREFIX}* entries in permissions.allow (${allow.length} entries total)`,
      remedy:
        'Without these the agent is prompted for, or denied, every lazy tool call. Start a ' +
        'fresh turn so lazy rewrites the permissions.',
      data: { path, allowCount: allow.length, lazyAllowCount: 0 },
    };
  }

  return {
    id: 'tool-permissions',
    label: '~/.claude/settings.json permissions',
    ok: true,
    detail: `${lazyEntries.length} ${LAZY_TOOL_PREFIX}* entries allowed`,
    data: { path, allowCount: allow.length, lazyAllowCount: lazyEntries.length },
  };
}

// ---------------------------------------------------------------------------
// Check 4 — read-only mode
// ---------------------------------------------------------------------------

function checkReadOnlyMode(entry?: ClaudeJsonLazyEntry): DoctorCheck {
  const envReadOnly = process.env.LAZY_MCP_READ_ONLY === '1';
  const argvReadOnly = entry?.args.includes('--read-only') ?? false;
  const readOnly = envReadOnly || argvReadOnly;
  const allToolCount = Object.keys(TOOL_ACCESS).length;

  // Not a failure in either state — an ask turn is SUPPOSED to be read-only.
  // It is reported because it changes what a healthy tool count looks like,
  // and a reader comparing counts needs to know which set to expect.
  return {
    id: 'read-only',
    label: 'Read-only (ask) mode',
    ok: true,
    detail: readOnly
      ? `on (env=${envReadOnly ? '1' : 'unset'}, argv ${argvReadOnly ? 'has' : 'lacks'} --read-only) — ` +
        `expect ${READ_ONLY_TOOL_NAMES.length} read-only tools`
      : `off — expect the full set of ${allToolCount} tools`,
    data: {
      readOnly,
      env: envReadOnly,
      argv: argvReadOnly,
      expectedToolCount: readOnly ? READ_ONLY_TOOL_NAMES.length : allToolCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Checks 5 and 6 — live MCP session against the real server
// ---------------------------------------------------------------------------

/**
 * Drive one stdio MCP session: `initialize`, `tools/list`, and one read-only
 * `tools/call`. Returns both checks, because they share a process — the point
 * of the round-trip check is that it uses the SAME server the agent gets.
 *
 * MCP stdio framing is newline-delimited JSON (src/mcp/server.ts).
 */
async function checkLiveMcp(entry: ClaudeJsonLazyEntry | undefined): Promise<DoctorCheck[]> {
  if (!entry) {
    const skipped = (id: string, label: string): DoctorCheck => ({
      id,
      label,
      ok: true,
      warning: true,
      detail: 'skipped — no usable ~/.claude.json entry to spawn',
      remedy: 'Fix the ~/.claude.json check above, then run doctor again.',
    });
    return [
      skipped('mcp-selftest', 'Live MCP self-test (tools/list)'),
      skipped('daemon-roundtrip', 'Daemon round-trip (lazy_status)'),
    ];
  }

  const argv = [entry.command, ...entry.args];
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    proc = spawn(argv, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: MCP_SELFTEST_TIMEOUT_MS,
    }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  } catch (err) {
    const failed = (id: string, label: string): DoctorCheck => ({
      id,
      label,
      ok: false,
      detail: `could not spawn the MCP server: ${errText(err)}`,
      remedy: 'The lazy-agent binary in this image cannot start. Rebuild the agent image.',
    });
    return [
      failed('mcp-selftest', 'Live MCP self-test (tools/list)'),
      failed('daemon-roundtrip', 'Daemon round-trip (lazy_status)'),
    ];
  }

  const replies = new Map<number, RpcReply>();
  const stderrChunks: string[] = [];

  const readStderr = (async () => {
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        stderrChunks.push(new TextDecoder().decode(chunk));
      }
    } catch {
      // The stream closes when the child exits; nothing here is diagnostic on
      // its own — whatever was captured before the close is still reported.
    }
  })();

  const readStdout = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as RpcReply;
            if (typeof msg.id === 'number') replies.set(msg.id, msg);
          } catch {
            // Non-JSON on stdout is a protocol violation by the server, not
            // something doctor can act on per-line. The waiting request will
            // time out and report that instead.
          }
        }
      }
    } catch {
      // Same as stderr: a closed stream just ends collection.
    }
  })();

  const write = (msg: unknown) => {
    proc.stdin.write(JSON.stringify(msg) + '\n');
    proc.stdin.flush();
  };

  async function request(id: number, method: string, params: unknown): Promise<RpcReply | null> {
    write({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + MCP_SELFTEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const reply = replies.get(id);
      if (reply) return reply;
      await new Promise(r => setTimeout(r, 25));
    }
    return null;
  }

  const checks: DoctorCheck[] = [];
  try {
    const initReply = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lazy-agent-doctor', version: '1' },
    });

    if (!initReply || initReply.error) {
      const why = initReply?.error?.message ?? 'no reply within the timeout';
      checks.push({
        id: 'mcp-selftest',
        label: 'Live MCP self-test (tools/list)',
        ok: false,
        detail: `initialize failed: ${why}${stderrTail(stderrChunks)}`,
        remedy:
          'The MCP server process starts but cannot complete a handshake. The stderr tail above ' +
          'names the cause; a missing/unreadable daemon config is the usual one.',
      });
      checks.push(roundTripSkipped('the MCP handshake failed'));
      return checks;
    }

    write({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listReply = await request(2, 'tools/list', {});
    const tools = extractToolNames(listReply?.result);

    if (!listReply || listReply.error || tools === null) {
      checks.push({
        id: 'mcp-selftest',
        label: 'Live MCP self-test (tools/list)',
        ok: false,
        detail:
          `tools/list failed: ${listReply?.error?.message ?? 'no usable reply'}` +
          stderrTail(stderrChunks),
        remedy: 'The server answers `initialize` but cannot list tools — this is the exact state ' +
          '`claude mcp list` reports as "✔ Connected". Report the stderr tail above.',
      });
      checks.push(roundTripSkipped('tools/list failed'));
      return checks;
    }

    // THE check this command exists for: a tool COUNT, which `claude mcp list`
    // never prints.
    if (tools.length === 0) {
      checks.push({
        id: 'mcp-selftest',
        label: 'Live MCP self-test (tools/list)',
        ok: false,
        detail: `the server registered ZERO tools${stderrTail(stderrChunks)}`,
        remedy:
          'This is the failure `claude mcp list` cannot see: the server connects and advertises ' +
          'nothing. Report this output — it means the tool registry came up empty in the ' +
          'container, not that the daemon is down.',
        data: { toolCount: 0 },
      });
    } else {
      checks.push({
        id: 'mcp-selftest',
        label: 'Live MCP self-test (tools/list)',
        ok: true,
        detail: `${tools.length} tools: ${tools.join(', ')}`,
        data: { toolCount: tools.length, tools },
      });
    }

    // Check 6: one real read-only call. This is what separates "the server
    // starts" from "the server can reach the daemon" — it exercises the config
    // mount, the bearer token, and the host.docker.internal route end to end.
    if (!tools.includes('lazy_status')) {
      checks.push(roundTripSkipped('lazy_status is not among the advertised tools'));
      return checks;
    }

    const callReply = await request(3, 'tools/call', { name: 'lazy_status', arguments: {} });
    if (!callReply) {
      checks.push({
        id: 'daemon-roundtrip',
        label: 'Daemon round-trip (lazy_status)',
        ok: false,
        detail: `no reply within ${MCP_SELFTEST_TIMEOUT_MS}ms${stderrTail(stderrChunks)}`,
        remedy:
          'The server accepted the call but never answered — the daemon is unreachable from this ' +
          'container. Check `lazy daemon status` on the host and that the target in check 1 is ' +
          'routable from here.',
      });
      return checks;
    }
    if (callReply.error) {
      checks.push({
        id: 'daemon-roundtrip',
        label: 'Daemon round-trip (lazy_status)',
        ok: false,
        detail: `lazy_status failed: ${callReply.error.message ?? 'unknown error'}`,
        remedy:
          'The tool exists but the daemon refused or could not be reached. A 401/403 means a ' +
          'stale token or a task-id mismatch (see checks 1 and 2); a connection error means the ' +
          'daemon is down or the target is not routable from this container.',
      });
      return checks;
    }

    // A tool error is reported in-band as `isError` on a successful reply.
    const result = callReply.result as { isError?: boolean; content?: unknown } | undefined;
    if (result?.isError) {
      checks.push({
        id: 'daemon-roundtrip',
        label: 'Daemon round-trip (lazy_status)',
        ok: false,
        detail: `lazy_status answered with an error: ${firstText(result.content) ?? '(no text)'}`,
        remedy:
          'The transport works — the daemon answered — but the call itself was rejected. The ' +
          'message above is the daemon\'s own diagnosis.',
      });
      return checks;
    }

    checks.push({
      id: 'daemon-roundtrip',
      label: 'Daemon round-trip (lazy_status)',
      ok: true,
      detail: 'the daemon answered a real tool call through this container\'s MCP server',
    });
    return checks;
  } finally {
    try {
      proc.stdin.end();
    } catch {
      // Already closed if the child exited first — nothing to recover.
    }
    proc.kill();
    await Promise.allSettled([proc.exited, readStdout, readStderr]);
  }
}

function roundTripSkipped(why: string): DoctorCheck {
  return {
    id: 'daemon-roundtrip',
    label: 'Daemon round-trip (lazy_status)',
    ok: true,
    warning: true,
    detail: `skipped — ${why}`,
    remedy: 'Fix the self-test above first; this check needs a working tool list.',
  };
}

/** Tool names out of a `tools/list` result, or null when the shape is wrong. */
function extractToolNames(result: unknown): string[] | null {
  if (!result || typeof result !== 'object') return null;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return null;
  return tools
    .map(t => (t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/** First text block of an MCP tool result's content array. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      return ((block as { text: string }).text).slice(0, 400);
    }
  }
  return undefined;
}

/** Last few stderr lines, for failure details. Never long enough to bury the report. */
function stderrTail(chunks: string[]): string {
  const text = chunks.join('').trim();
  if (!text) return '';
  const lines = text.split('\n').slice(-5);
  return `\n    server stderr: ${lines.join('\n                   ')}`;
}

// ---------------------------------------------------------------------------
// Check 7 — opt-in: what Claude Code itself loads
// ---------------------------------------------------------------------------

/**
 * Start a real `claude` process in exactly the mode agent turns use, read ONLY
 * its first stream-json line, and kill it.
 *
 * This is the only check that observes what Claude Code loaded into its OWN
 * process — every other check observes what lazy wrote or what the MCP server
 * can do when driven directly. It is opt-in because it really does start an
 * agent process (and can bill a request).
 */
async function checkProbeAgent(): Promise<DoctorCheck> {
  const claudeBin = which('claude');
  if (!claudeBin) {
    return {
      id: 'probe-agent',
      label: 'Agent probe (claude init line)',
      ok: false,
      detail: '`claude` not found on PATH',
      remedy: 'The agent binary is missing from this image. Rebuild the agent image.',
    };
  }

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = spawn([claudeBin, '-p', 'ok', '--output-format', 'stream-json', '--verbose'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PROBE_AGENT_TIMEOUT_MS,
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  } catch (err) {
    return {
      id: 'probe-agent',
      label: 'Agent probe (claude init line)',
      ok: false,
      detail: `could not start claude: ${errText(err)}`,
      remedy: 'Fix the agent binary in this image, then re-run with --probe-agent.',
    };
  }

  try {
    const line = await firstStdoutLine(proc, PROBE_AGENT_TIMEOUT_MS);
    if (!line) {
      return {
        id: 'probe-agent',
        label: 'Agent probe (claude init line)',
        ok: false,
        detail: `claude produced no stream-json line within ${PROBE_AGENT_TIMEOUT_MS}ms`,
        remedy:
          'The agent could not start a session at all — usually credentials or network. Check ' +
          'the proxy and auth setup for this container.',
      };
    }

    let init: { type?: string; subtype?: string; tools?: unknown; mcp_servers?: unknown };
    try {
      init = JSON.parse(line);
    } catch (err) {
      return {
        id: 'probe-agent',
        label: 'Agent probe (claude init line)',
        ok: false,
        detail: `first stream-json line is not JSON (${errText(err)}): ${line.slice(0, 200)}`,
        remedy: 'This is an agent-version change, not a lazy misconfiguration. Report the line above.',
      };
    }

    const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : undefined;
    const tools = Array.isArray(init.tools)
      ? init.tools.filter((t): t is string => typeof t === 'string')
      : undefined;

    // Same absence-of-evidence rule as the supervisor check: a release that
    // stops reporting these fields must read as "unknown", never as "zero".
    if (!servers && !tools) {
      return {
        id: 'probe-agent',
        label: 'Agent probe (claude init line)',
        ok: true,
        warning: true,
        detail: 'the init line reports neither `mcp_servers` nor `tools` — cannot conclude anything',
        remedy: 'This agent version does not report its loaded tools. Rely on the self-test above.',
      };
    }

    const lazyServer = servers?.find(
      (s): s is { name: string; status?: string } =>
        !!s && typeof s === 'object' && (s as { name?: unknown }).name === LAZY_SERVER_NAME,
    );
    const lazyTools = tools?.filter(t => t.startsWith(LAZY_TOOL_PREFIX)) ?? [];
    const serverStatus = lazyServer ? (lazyServer.status ?? 'unreported') : 'absent';
    const detail =
      `mcp_servers: lazy=${serverStatus}` +
      (tools ? `, ${LAZY_TOOL_PREFIX}* tools loaded: ${lazyTools.length} of ${tools.length}` : ', tools not reported');

    if (tools && lazyTools.length === 0) {
      return {
        id: 'probe-agent',
        label: 'Agent probe (claude init line)',
        ok: false,
        detail,
        remedy:
          'Claude Code itself loaded no lazy tools. This is the incident state exactly. If the ' +
          'self-test above passed, the server is fine and Claude Code is not loading it — ' +
          'report both results together.',
        data: { serverStatus, lazyToolCount: lazyTools.length, totalToolCount: tools.length },
      };
    }

    if (!tools && serverStatus !== 'connected') {
      return {
        id: 'probe-agent',
        label: 'Agent probe (claude init line)',
        ok: false,
        detail,
        remedy: 'Claude Code reports the lazy MCP server as not connected. See the self-test above.',
        data: { serverStatus },
      };
    }

    return {
      id: 'probe-agent',
      label: 'Agent probe (claude init line)',
      ok: true,
      detail,
      data: {
        serverStatus,
        lazyToolCount: lazyTools.length,
        totalToolCount: tools?.length ?? null,
      },
    };
  } finally {
    proc.kill();
    await proc.exited.catch(() => undefined);
  }
}

/** First complete stdout line, or null on timeout/EOF. */
async function firstStdoutLine(
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  timeoutMs: number,
): Promise<string | null> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    while (Date.now() < deadline) {
      const timer = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), deadline - Date.now()));
      const next = await Promise.race([reader.read(), timer]);
      if (next === 'timeout') return null;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const idx = buffer.indexOf('\n');
      if (idx !== -1) return buffer.slice(0, idx).trim();
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return buffer.trim() || null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAgentDoctor(opts: AgentDoctorOptions = {}): Promise<AgentDoctorResult> {
  const checks: DoctorCheck[] = [];

  const { check: configCheck, facts } = await checkDaemonConfig();
  checks.push(configCheck);

  const { check: claudeJsonCheck, entry } = await checkClaudeJson(facts);
  checks.push(claudeJsonCheck);

  checks.push(await checkToolPermissions());
  checks.push(checkReadOnlyMode(entry));
  checks.push(...(await checkLiveMcp(entry)));

  if (opts.probeAgent) checks.push(await checkProbeAgent());

  return {
    host: hostname(),
    taskId: facts.taskId || argValue(entry?.args ?? [], '--task-id') || null,
    checks,
    ok: checks.every(c => c.ok),
  };
}

/** Human-readable report. Printed to stdout so a transcript can be pasted whole. */
export function formatAgentDoctorReport(result: AgentDoctorResult): string {
  const lines: string[] = [];
  // Header first so a pasted transcript identifies itself without the reader
  // having to ask "which container was this?".
  lines.push(`lazy-agent doctor — container ${result.host}`);
  lines.push(`task: ${result.taskId ?? '(none — builder or project-wide mode)'}`);
  lines.push('');

  for (const check of result.checks) {
    const mark = check.ok ? (check.warning ? '!' : '✓') : '✗';
    lines.push(`${mark} ${check.label}`);
    for (const line of check.detail.split('\n')) lines.push(`    ${line}`);
    if (check.remedy && (!check.ok || check.warning)) lines.push(`    → ${check.remedy}`);
    lines.push('');
  }

  if (result.ok) {
    lines.push('All checks passed.');
  } else {
    const failed = result.checks.filter(c => !c.ok).map(c => c.label);
    lines.push(`FAILED: ${failed.join(', ')}`);
  }
  return lines.join('\n');
}
