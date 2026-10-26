/**
 * A task's tmux sessions, read by the daemon: which sessions its container
 * runs, and what each one shows and has printed.
 *
 * The sessions themselves live in the task's container (src/sessions/tmux.ts):
 * `services` runs the project's Start services command (./serve-run.ts), and
 * other names are long-running commands started in it. They outlive turns and
 * daemon restarts — a restart stops only the agent (src/runner/agent-stop.ts) —
 * so their output is something every surface wants to show without a terminal:
 * the Services tab, an agent checking whether its dev server came up
 * (`lazy_sessions`, a READ tool), the CLI.
 *
 * Both reads are a `docker exec` of a pure script into a RUNNING container.
 * Neither starts the container or anything in it: a task whose container is
 * not running answers `running: false` with no sessions — "nothing is running"
 * — while a container that could not be asked is an error, never an empty
 * list ("not known" is not "not running").
 *
 * Attaching a terminal goes through the session attach route
 * (`/rpc/sessions/:id/attach/ws?tmux=<name>`, src/server/session-attach-ws.ts);
 * the list answers the `sessionId` that route takes.
 */

import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { taskContainerTarget } from './serve-run';
import { displayId } from '../task/identity';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import type { Storage } from '../storage';
import type { Session, Task } from '../types';
import { memberEnvironmentsInTask } from '../server/member-terminals';
import type { AgentPresence, PresenceMember } from '../sessions/presence';
import {
  DEFAULT_SCREEN_LINES,
  MAX_SCREEN_LINES,
  isValidSessionName,
  listSessionsScript,
  parseSessionList,
  parseSessionOutput,
  readSessionScript,
  sessionLogPath,
  type SessionOutput,
  type TaskSessionInfo,
} from '../sessions/tmux';

/** How much of a session's log a read returns by default. */
export const DEFAULT_SESSION_LOG_BYTES = 16 * 1024;

/** The most of a session's log one read may ask for. */
export const MAX_SESSION_LOG_BYTES = 512 * 1024;

/** A read is a quick exec; one that hangs is reported, not waited on. */
const SESSION_READ_TIMEOUT_MS = 10_000;

export interface TaskSessionsDeps {
  getStorage?: () => Promise<Storage>;
  /** The task's running container, or null; defaults to {@link taskContainerTarget}. */
  containerTarget?: (projectRoot: string, task: Task, session: Session | null) => Promise<{ binary: string; name: string } | null>;
  exec?: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** The members inside the task; defaults to {@link memberEnvironmentsInTask}. */
  memberEnvironments?: typeof memberEnvironmentsInTask;
  /** Test seam for {@link MEMBER_SESSIONS_READ_TIMEOUT_MS}. */
  memberReadTimeoutMs?: number;
}

interface TaskSessionsBase {
  /** The task, as people name it. */
  task: string;
  /** The lazy session id — what the attach route takes. Null before the task's first turn. */
  sessionId: string | null;
  /** The task's container, when it is running. */
  container: string | null;
  /** Is the task's container running? Nothing runs in it otherwise. */
  running: boolean;
  /** Does the container have tmux? Null when it is not running (not asked). */
  tmux: boolean | null;
}

/**
 * A listed session, with when it last printed anything: the modification time
 * of its log (ISO 8601), or null when it has no log yet or that could not be
 * read. Taken from the log because every byte of output passes through it.
 */
export interface ListedTaskSession extends TaskSessionInfo {
  lastOutputAt: string | null;
}

export interface TaskSessionsList extends TaskSessionsBase {
  sessions: ListedTaskSession[];
  /**
   * Who else is in the task: the members with terminals in it (each in a
   * container of their own) — names, states and times only.
   */
  members: PresenceMember[];
  /** The agent, from the task's status. */
  agent: AgentPresence;
}

async function agentPresence(storage: Storage, task: Task, session: Session | null): Promise<AgentPresence> {
  const working = task.status === 'working';
  let turn: number | null = null;
  if (session) {
    const turns = await storage.getSessionTurns(session.id);
    const last = turns.reduce<number | null>((m, t) => (m === null || t.sequence > m ? t.sequence : m), null);
    // The number the Turns tab and `lazy show` print (Turn #<sequence>).
    turn = last;
  }
  const history = await storage.getStatusHistory(task.id);
  const entered = [...history].reverse().find((h) => h.status === task.status);
  return { status: task.status, working, turn, since: entered ? new Date(entered.timestamp).toISOString() : null };
}

/**
 * How long one member's container may take to say what sessions it has. The
 * list is beside a page and before a terminal opens, so a container that hangs
 * leaves that member's sessions unknown rather than holding everyone else up.
 */
export const MEMBER_SESSIONS_READ_TIMEOUT_MS = 3_000;

/** `promise`, or a rejection naming `what` after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function membersPresence(task: Task, deps: TaskSessionsDeps): Promise<PresenceMember[]> {
  const envs = await (deps.memberEnvironments ?? memberEnvironmentsInTask)(task.id);
  return Promise.all(envs.map(async (env): Promise<PresenceMember> => {
    let sessions: PresenceMember['sessions'] = env.container?.activity ? null : [];
    if (env.container?.activity) {
      try {
        const a = await withTimeout(env.container.activity(), deps.memberReadTimeoutMs ?? MEMBER_SESSIONS_READ_TIMEOUT_MS, `${env.email}'s environment`);
        sessions = (a.named ?? []).map((n) => ({
          name: n.name,
          attached: n.attachedClients > 0,
          lastActivityAt: new Date(n.lastActivityMs).toISOString(),
        }));
      } catch (err) {
        logger.warn(`taskSessions: could not list ${env.email}'s sessions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { member: env.email, openTerminals: env.openTerminals, sessions };
  }));
}

export interface TaskSessionRead extends TaskSessionsBase {
  /** The session's output; null when the container is not running. */
  output: SessionOutput | null;
}

async function defaultExec(argv: string[], timeoutMs: number) {
  const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: timeoutMs });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function intParam(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new RpcError(400, `${name} must be a positive whole number, got ${JSON.stringify(value)}.`);
  }
  return Math.min(n, max);
}

async function resolve(projectRoot: string, params: Record<string, unknown>, deps: TaskSessionsDeps) {
  const ref = params.taskId;
  if (typeof ref !== 'string' || ref.trim() === '') throw new RpcError(400, 'taskId is required.');
  const storage = await (deps.getStorage ?? getOrCreateStorage)();
  const resolved = await storage.resolveTask(ref);
  if (!resolved.task) throw new RpcError(404, `Task not found: ${ref}`);
  const task = resolved.task;
  const session = await storage.getSessionByTaskId(task.id);
  const target = await (deps.containerTarget ?? taskContainerTarget)(projectRoot, task, session);
  return { task, session, target, storage };
}

async function execRead(
  deps: TaskSessionsDeps,
  target: { binary: string; name: string },
  script: string,
  args: string[],
  what: string,
): Promise<string> {
  const result = await (deps.exec ?? defaultExec)(
    [target.binary, 'exec', target.name, 'sh', '-c', script, 'lazy-sessions', ...args],
    SESSION_READ_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    const detail = result.exitCode === null
      ? `it did not answer within ${SESSION_READ_TIMEOUT_MS / 1000} seconds`
      : (result.stderr.trim() || `exit ${result.exitCode}`);
    throw new RpcError(502, `Could not read ${what} in ${target.name}: ${detail}`);
  }
  return result.stdout;
}

/**
 * Prints `<name> <epoch seconds>` for each named session whose log exists.
 * The names arrive as arguments, never in the script text.
 */
export function lastOutputScript(): string {
  const log = sessionLogPath('NAME').replace('NAME', '$n');
  return `for n in "$@"; do f="${log}"; if [ -f "$f" ]; then printf '%s %s\\n' "$n" "$(stat -c %Y "$f" 2>/dev/null || date -r "$f" +%s)"; fi; done`;
}

/** Parse {@link lastOutputScript}'s answer into name → ISO 8601 time. */
export function parseLastOutput(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+) (\d+)$/.exec(line.trim());
    if (m) out.set(m[1]!, new Date(Number(m[2]) * 1000).toISOString());
  }
  return out;
}

/** `taskSessions` — the sessions running in a task's container. */
export async function listTaskSessions(
  projectRoot: string,
  params: Record<string, unknown>,
  deps: TaskSessionsDeps = {},
): Promise<TaskSessionsList> {
  const { task, session, target, storage } = await resolve(projectRoot, params, deps);
  const [members, agent] = await Promise.all([membersPresence(task, deps), agentPresence(storage, task, session)]);
  const base = { task: displayId(task), sessionId: session?.id ?? null, members, agent };
  if (!target) return { ...base, container: null, running: false, tmux: null, sessions: [] };
  const parsed = parseSessionList(await execRead(deps, target, listSessionsScript(), [], 'the tmux sessions'));
  // When each last printed is a detail beside the list: failing to read it
  // leaves the times unknown (null) and is logged, never fails the list.
  let lastOutput = new Map<string, string>();
  const names = parsed.sessions.map(s => s.name).filter(isValidSessionName);
  if (names.length > 0) {
    try {
      lastOutput = parseLastOutput(await execRead(deps, target, lastOutputScript(), names, 'when the sessions last printed'));
    } catch (err) {
      logger.warn(`taskSessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const sessions = parsed.sessions.map(s => ({ ...s, lastOutputAt: lastOutput.get(s.name) ?? null }));
  return { ...base, container: target.name, running: true, tmux: parsed.tmux, sessions };
}

/**
 * `taskSessionOutput` — one session's live screen (with up to `lines` lines of
 * scrollback) and the tail of its bounded log (`logBytes`).
 */
export async function readTaskSession(
  projectRoot: string,
  params: Record<string, unknown>,
  deps: TaskSessionsDeps = {},
): Promise<TaskSessionRead> {
  const name = params.name;
  if (typeof name !== 'string' || !isValidSessionName(name)) {
    throw new RpcError(400, `name must be a session name (letters, digits, '.', '_' and '-', starting with a letter or digit), got ${JSON.stringify(name)}.`);
  }
  const lines = intParam(params.lines, 'lines', DEFAULT_SCREEN_LINES, MAX_SCREEN_LINES);
  const logBytes = intParam(params.logBytes, 'logBytes', DEFAULT_SESSION_LOG_BYTES, MAX_SESSION_LOG_BYTES);
  const { task, session, target } = await resolve(projectRoot, params, deps);
  const base = { task: displayId(task), sessionId: session?.id ?? null };
  if (!target) return { ...base, container: null, running: false, tmux: null, output: null };
  const stdout = await execRead(deps, target, readSessionScript(lines, logBytes), [name], `the "${name}" session`);
  const { tmux, ...output } = parseSessionOutput(name, stdout);
  return { ...base, container: target.name, running: true, tmux, output };
}
