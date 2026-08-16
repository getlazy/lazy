/**
 * Prove the builder's lazy MCP credential is actually reachable — on the host
 * before the container starts, and inside the container before Claude Code does.
 *
 * WHY THIS EXISTS. Claude Code discovers the lazy MCP server from
 * `~/.claude.json`, whose `mcpServers.lazy.args` carry
 * `--daemon-config <path>`. If that path is not readable where the MCP child
 * runs, the child exits immediately and Claude Code reports nothing more useful
 * than "Failed to reconnect to lazy" in a log the human never opens. The builder
 * then runs a whole session with NO `lazy_*` tools and the human finds out
 * several turns later, when the builder says it cannot call lazy.
 *
 * That is exactly what a stable, project-shared `~/.claude.json` produced: a
 * second builder launch rewrote the per-launch `--daemon-config` path in place,
 * and the first container — which had a DIFFERENT token file bind-mounted — was
 * left naming a path that did not exist inside it. The ordering bug itself is
 * fixed in claude-home.ts (per-launch mounted copy); this module is the loud
 * failure that makes any future recurrence obvious at launch instead of silent.
 *
 * Both checks compare the SAME two things: the `--daemon-config` path recorded
 * in the Claude config, and the file that path names. The in-container check
 * additionally pins it against the path the supervisor was launched with, which
 * is the mount the container really got.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { spawn } from '../utils/spawn';

/** The `mcpServers.lazy` entry Claude Code will spawn. */
export interface LazyMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The `mcpServers.lazy` server spec recorded in a Claude config, or null. */
export function lazyMcpEntryFromClaudeConfig(doc: unknown): LazyMcpEntry | null {
  const servers = (doc as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  const lazy = servers?.lazy as { command?: unknown; args?: unknown; env?: unknown } | undefined;
  if (!lazy || typeof lazy.command !== 'string') return null;
  const args = Array.isArray(lazy.args) ? lazy.args.filter((a): a is string => typeof a === 'string') : [];
  const env = lazy.env && typeof lazy.env === 'object'
    ? Object.fromEntries(
        Object.entries(lazy.env as Record<string, unknown>)
          .filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : undefined;
  return { command: lazy.command, args, ...(env ? { env } : {}) };
}

/** The `--daemon-config <path>` recorded in a Claude config's lazy MCP entry. */
export function daemonConfigPathFromClaudeConfig(doc: unknown): string | null {
  const servers = (doc as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  const lazy = servers?.lazy as { args?: unknown } | undefined;
  if (!lazy || !Array.isArray(lazy.args)) return null;
  const idx = lazy.args.indexOf('--daemon-config');
  if (idx === -1 || idx + 1 >= lazy.args.length) return null;
  const value = lazy.args[idx + 1];
  return typeof value === 'string' ? value : null;
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Host-side pre-launch check: the MCP config file the container is about to be
 * pointed at exists and is readable, and the Claude config the container mounts
 * names that exact file.
 *
 * Throws — never warns. A builder with no lazy tools is not a degraded builder,
 * it is a builder that cannot do its job, and per CLAUDE.md silence is the bug.
 */
export async function assertDaemonMcpConfigMounted(
  daemonConfigPath: string,
  claudeConfigPath: string,
): Promise<void> {
  try {
    await readJson(daemonConfigPath);
  } catch (err) {
    throw new Error(
      `Builder MCP credential is missing or unreadable, so the builder would start ` +
      `with no lazy_* tools.\n` +
      `  expected: ${daemonConfigPath}\n` +
      `  error:    ${err instanceof Error ? err.message : String(err)}\n` +
      `The daemon mints this file when the builder asks for a credential; if it is ` +
      `gone, restart the daemon (lazy daemon restart) and relaunch the builder.`,
    );
  }

  let recorded: string | null;
  try {
    recorded = daemonConfigPathFromClaudeConfig(await readJson(claudeConfigPath));
  } catch (err) {
    throw new Error(
      `Could not read the builder's Claude config ${claudeConfigPath}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (recorded !== daemonConfigPath) {
    throw new Error(
      `The builder's Claude config names a different MCP credential than the one ` +
      `being mounted, so the builder would start with no lazy_* tools.\n` +
      `  config:  ${claudeConfigPath}\n` +
      `  names:   ${recorded ?? '(no lazy MCP entry)'}\n` +
      `  mounted: ${daemonConfigPath}\n` +
      `This means two builder launches wrote the same Claude config. Report it — ` +
      `the mounted copy is supposed to be per-launch.`,
    );
  }
}

/**
 * In-container preflight, run by the builder supervisor before it hands the
 * terminal to Claude Code.
 *
 * This is the only check that sees what the container ACTUALLY got: a host-side
 * check passes on paths the host can read, and a bind mount that silently did
 * not materialize is invisible from there. Verifies (a) the `--daemon-config`
 * the supervisor was launched with is readable here, and (b) the `~/.claude.json`
 * Claude Code is about to read names that same file.
 *
 * Throws with expected-vs-actual. Called only in daemon-proxy mode; the legacy
 * builder-server path has no daemon config.
 */
export async function preflightBuilderMcpConfig(opts: {
  daemonConfigPath: string;
  claudeConfigPath: string;
}): Promise<void> {
  try {
    await readJson(opts.daemonConfigPath);
  } catch (err) {
    throw new Error(
      `Builder preflight failed: the lazy MCP credential is not readable inside the ` +
      `container, so every lazy_* tool would be unavailable for this whole session.\n` +
      `  expected at: ${opts.daemonConfigPath}\n` +
      `  error:       ${err instanceof Error ? err.message : String(err)}\n` +
      `The host bind-mounts this file into the container by absolute path; a missing ` +
      `file here means the mount did not happen or the host file was removed. ` +
      `Relaunch the builder (lazy builder --resume <id>).`,
    );
  }

  let recorded: string | null;
  try {
    recorded = daemonConfigPathFromClaudeConfig(await readJson(opts.claudeConfigPath));
  } catch (err) {
    throw new Error(
      `Builder preflight failed: could not read ${opts.claudeConfigPath}, which is where ` +
      `Claude Code discovers the lazy MCP server: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (recorded !== opts.daemonConfigPath) {
    throw new Error(
      `Builder preflight failed: Claude Code would start the lazy MCP server against a ` +
      `credential this container does not have, leaving the session with no lazy_* tools.\n` +
      `  ${opts.claudeConfigPath} names: ${recorded ?? '(no lazy MCP entry)'}\n` +
      `  this container was mounted:     ${opts.daemonConfigPath}\n` +
      `The mounted Claude config is per-launch, so a mismatch means another builder ` +
      `launch wrote this container's copy. Relaunch the builder and report this.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Startup probe — the general net
// ---------------------------------------------------------------------------

/**
 * The MCP `initialize` handshake, verbatim. Sent to the probe child exactly as
 * Claude Code would send it, so a server that answers this will answer Claude's.
 */
const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lazy-builder-preflight', version: '1' },
  },
}) + '\n';

/** How long the probe waits for the server to answer `initialize`. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Start the lazy MCP server the way Claude Code will, and prove it answers.
 *
 * WHY A PROBE AND NOT MORE CHECKS. The two preflights above each catch one
 * KNOWN cause (wrong binary, wrong credential). This catches the rest by not
 * enumerating them: it runs the exact `mcpServers.lazy` command line from the
 * same `~/.claude.json` Claude Code reads, in the same cwd, and requires a real
 * `initialize` response. Anything that stops the server starting — a bad daemon
 * target, an unreachable host, a revoked token, a permissions problem, a future
 * cause nobody has thought of — fails here instead of at handoff.
 *
 * WHY IT HAS TO BE A CHILD WE OWN. Claude Code's own MCP child is a GRANDCHILD
 * of this supervisor, and its stderr is a pipe Claude Code owns: Claude drains
 * it into `~/.cache/claude-cli-nodejs/<cwd-slug>/mcp-logs-lazy/<ts>.jsonl` as
 * `{"error":"Server stderr: …"}` and never re-emits it. Inheriting stdio does
 * not reach it and neither does anything else in this process tree — which is
 * precisely why the failure has always been silent. Spawning the server
 * ourselves is the only way to hold its stderr, so the probe reports the
 * server's own words rather than Claude's opaque "-32000: Connection closed".
 *
 * Cost is one short-lived process and one daemon round-trip per builder launch.
 * The child is killed as soon as it answers; `initialize` has no side effects.
 */
export async function probeLazyMcpServerStartup(opts: {
  claudeConfigPath: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<void> {
  let entry: LazyMcpEntry | null;
  try {
    entry = lazyMcpEntryFromClaudeConfig(await readJson(opts.claudeConfigPath));
  } catch (err) {
    throw new Error(
      `Builder preflight failed: could not read ${opts.claudeConfigPath}, which is where ` +
      `Claude Code discovers the lazy MCP server: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!entry) {
    throw new Error(
      `Builder preflight failed: ${opts.claudeConfigPath} has no lazy MCP entry, so Claude ` +
      `Code would start with no lazy_* tools. The launch config is written by lazy itself ` +
      `(see src/builder/claude-home.ts) — report this.`,
    );
  }

  const result = await runMcpHandshake(entry, opts.cwd, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (result.ok) return;

  const stderr = result.stderr.trim();
  throw new Error(
    `Builder preflight failed: the lazy MCP server did not start, so this session would ` +
    `have no lazy_* tools — announced only as "Failed to reconnect to lazy: -32000" in a ` +
    `log nobody opens.\n` +
    `  command: ${entry.command} ${entry.args.join(' ')}\n` +
    `  result:  ${result.detail}\n` +
    `  server output:\n${stderr ? indent(stderr) : '    <none>'}`,
  );
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n');
}

interface HandshakeResult {
  ok: boolean;
  /** One line saying how it failed (exit code, timeout, spawn error). */
  detail: string;
  /** Everything the server wrote to stderr — its own account of the failure. */
  stderr: string;
}

/**
 * Spawn one MCP server, send `initialize`, and wait for a JSON-RPC response.
 *
 * Exported for testing: the suite drives it with scripted fake servers (one that
 * answers, one that dies, one that hangs) rather than the real agent binary.
 */
export async function runMcpHandshake(
  entry: LazyMcpEntry,
  cwd: string,
  timeoutMs: number,
): Promise<HandshakeResult> {
  let proc: ReturnType<typeof spawn<'pipe', 'pipe', 'pipe'>>;
  try {
    proc = spawn([entry.command, ...entry.args], {
      cwd,
      env: { ...process.env, ...(entry.env ?? {}) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // The probe owns its own deadline below; the spawn wrapper's default
      // timeout would race it and report a less specific failure.
      timeout: 0,
    });
  } catch (err) {
    return {
      ok: false,
      detail: `could not spawn the server (${err instanceof Error ? err.message : String(err)})`,
      stderr: '',
    };
  }

  // Drain stderr concurrently into a buffer we can read at ANY moment. It is the
  // payload we exist to capture, and a server that fills the pipe buffer would
  // otherwise block instead of dying. Deliberately not `new Response(...).text()`:
  // that only resolves when the pipe closes, and a killed shell whose own child
  // still holds the fd never closes it — the probe would hang forever waiting for
  // the very output it is trying to report.
  const stderrChunks: string[] = [];
  void drainInto(proc.stderr, stderrChunks);

  try {
    proc.stdin.write(INITIALIZE_REQUEST);
    proc.stdin.flush();
  } catch {
    // A server that already died gives EPIPE here. The exit path below reports
    // it with its stderr, which is far more useful than the write error.
  }

  const answered = readFirstJsonRpcResponse(proc.stdout);
  const exited = proc.exited.then(code => ({ exited: code }));
  const timedOut = new Promise<{ timeout: true }>(resolve =>
    setTimeout(() => resolve({ timeout: true }), timeoutMs),
  );

  const race = await Promise.race([
    answered.then(ok => ({ answered: ok })),
    exited,
    timedOut,
  ]) as { answered?: boolean; exited?: number | null; timeout?: true };

  // Always reap the child: it is a real MCP server holding a daemon connection.
  try { proc.kill(); } catch { /* already gone — nothing to signal */ }
  // A short grace so a server that died mid-sentence still gets its last words
  // in. Bounded, because the drain above may never finish (see the note there).
  await new Promise(resolve => setTimeout(resolve, 50));
  const stderr = stderrChunks.join('');

  if (race.answered) return { ok: true, detail: 'ok', stderr };
  if (race.timeout) {
    return {
      ok: false,
      detail: `no response to the MCP initialize handshake within ${timeoutMs}ms`,
      stderr,
    };
  }
  return {
    ok: false,
    detail: `the server exited (code ${race.exited ?? 'unknown'}) before answering initialize`,
    stderr,
  };
}

/**
 * Resolve true on the first line of `stream` that parses as a JSON-RPC response.
 *
 * Never resolves false on end-of-stream: the caller races this against the
 * child's exit and its own deadline, both of which describe the failure better
 * than "the stream ended" would.
 */
async function readFirstJsonRpcResponse(stream: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new Promise<boolean>(() => {});
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown };
          // Any well-formed JSON-RPC message answering our id means the server
          // came up and is speaking the protocol. An error RESULT is still a
          // live server — that is Claude Code's problem, not a startup failure.
          if (msg.jsonrpc === '2.0' && msg.id === 1) return true;
        } catch {
          // Not JSON — MCP servers are supposed to keep stdout clean, but a
          // stray line is not itself a startup failure. Keep reading.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Post-session scan — the only thing that can see a MID-session failure
// ---------------------------------------------------------------------------

/**
 * Where Claude Code parks its MCP children's stderr.
 *
 * Empirically verified, not assumed: Claude Code owns the MCP child's stderr
 * pipe and drains it, verbatim, into
 *   $HOME/.cache/claude-cli-nodejs/<cwd-slug>/mcp-logs-<server>/<ISO>.jsonl
 * as `{"error":"Server stderr: …"}` lines, alongside its own
 * `{"error":"Connection failed (-32000): … Connection closed"}`. The slug is the
 * absolute cwd with every non-alphanumeric run replaced by `-`.
 */
export function mcpLogDirFor(home: string, cwd: string, serverName = 'lazy'): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(home, '.cache', 'claude-cli-nodejs', slug, `mcp-logs-${serverName}`);
}

/**
 * Claude Code's debug echo of a tool call that came back an error.
 *
 * EMPIRICAL, not assumed. Claude Code writes BOTH kinds of trouble into the same
 * `mcp-logs-lazy/<ISO>.jsonl` as `{"error": …}` lines: the server being
 * unreachable, and a perfectly healthy server answering a tool call with
 * `isError`. Reading the shipped binary (2.1.227) and reproducing it live:
 *
 *   {"debug":"Calling MCP tool: lazy_show", …}
 *   {"error":"{\"error\":\"Task not found: …\"}", …}
 *   {"debug":"Tool 'lazy_show' failed after 0s: {\"error\":\"Task not found: …\"}", …}
 *
 * The error entry is written by Claude's tool-result handler (it logs the
 * result's text, then throws); the catch that receives that throw logs the
 * SAME text as `Tool '<name>' failed after <duration>: <text>`. That debug echo
 * is the structural marker: an error entry whose text is also the payload of a
 * tool-failure debug line in the same log came from a tool RESULT, not from the
 * transport. Availability failures have no such pairing — they are emitted from
 * the connection paths (`Server stderr: …`, `Connection failed …`,
 * `Error during reconnection: …`, `Failed to reconnect to …`) with no tool in
 * scope at all.
 *
 * This is why we do not match on lazy's own error strings: the noisy entries
 * (the two-step confirmation gates, validation rejections) are ordinary tool
 * results, and they are recognised as such by Claude's own framing rather than
 * by anything lazy wrote. Anything we cannot classify stays reported — the
 * default here is still fail-loud.
 */
const TOOL_FAILURE_DEBUG = /^Tool '[^']*' failed after [^:]*: /;

interface McpLogEntry {
  error?: unknown;
  debug?: unknown;
}

/**
 * The error texts in one log file that a tool-failure debug line accounts for.
 *
 * Compared verbatim: both entries are written from the same string, so equality
 * is exact. A near-miss (Claude reformatting one side) simply means the entry
 * stays reported, which is the safe direction.
 */
function toolResultErrorTexts(entries: McpLogEntry[]): Set<string> {
  const texts = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.debug !== 'string') continue;
    const match = TOOL_FAILURE_DEBUG.exec(entry.debug);
    if (!match) continue;
    const payload = entry.debug.slice(match[0].length).trim();
    if (payload) texts.add(payload);
  }
  return texts;
}

/**
 * Report lazy MCP server errors Claude Code logged during this run.
 *
 * WHY THIS EXISTS ALONGSIDE THE LAUNCH PROBE. The probe proves the server can
 * start at launch. It structurally cannot see a loss that happens LATER — the
 * daemon restarting, the token being evicted, the server crashing on its tenth
 * tool call. In those cases the human's tools vanish mid-session with no signal
 * at all. This scan is what turns that into a line they actually see.
 *
 * AVAILABILITY ONLY. Claude Code logs tool-call error RESULTS into this same
 * file, so a raw scan reports every confirmation gate and validation rejection
 * as a connectivity failure. Those are filtered out structurally — see
 * TOOL_FAILURE_DEBUG above. What is left is connection/spawn/transport trouble
 * plus anything unrecognised, which stays reported on purpose.
 *
 * DELIBERATELY TOLERANT. The log format belongs to Claude Code, not to lazy: a
 * missing directory, an unreadable file, or a shape change must degrade to
 * today's silence, never to a false alarm on an otherwise fine session. So every
 * failure mode here returns "nothing to report" rather than throwing.
 *
 * @param since Only entries from files modified at/after this time — i.e. this
 *              run's, not a previous session's leftovers.
 */
export async function collectMcpServerErrors(opts: {
  home: string;
  cwd: string;
  since: number;
  serverName?: string;
  limit?: number;
}): Promise<string[]> {
  const dir = mcpLogDirFor(opts.home, opts.cwd, opts.serverName ?? 'lazy');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No log dir: Claude Code never had cause to write one, or its layout moved.
    // Either way there is nothing to report and nothing to complain about.
    return [];
  }

  const errors: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (info.mtimeMs < opts.since) continue;
      const raw = await readFile(file, 'utf-8');
      const entries: McpLogEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as McpLogEntry);
        } catch {
          // A partial or non-JSON line. Claude Code owns this format; skip.
        }
      }

      // Drop the entries a tool CALL accounted for. A server answering
      // `lazy_accept` with its confirmation-code gate, or rejecting an
      // over-long memory description, is the server working — reporting it as
      // "your lazy_* tools may have been unavailable" is a false alarm, and in
      // the v0.21 beta it fired on nearly every session.
      const fromToolResults = toolResultErrorTexts(entries);
      for (const entry of entries) {
        if (typeof entry.error !== 'string') continue;
        const text = entry.error.trim();
        if (!text || fromToolResults.has(text)) continue;
        errors.push(text);
      }
    } catch {
      // Unreadable/vanished file — skip it rather than fail the whole scan.
    }
  }

  const limit = opts.limit ?? 10;
  return errors.length > limit ? errors.slice(-limit) : errors;
}

/**
 * Accumulate a stream's text into `sink` as it arrives.
 *
 * Never rejects and is never awaited: the caller reads whatever has landed by
 * the time it decides, because a stream that outlives the process it belongs to
 * must not be able to stall the probe.
 */
async function drainInto(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      sink.push(decoder.decode(chunk, { stream: true }));
    }
  } catch {
    // The pipe closed under us (killed child, gone fd). Whatever we already
    // collected is still the useful part.
  }
}
