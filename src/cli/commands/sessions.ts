import { parseFlags } from '../helpers';
import { queryTaskSessions } from '../../daemon/rpc-fallback';
import type { TaskSessionRead, TaskSessionsList } from '../../daemon/task-sessions';
import { describeAgent, describeMember, presenceBanner, presenceNotice } from '../../sessions/presence';

/**
 * The "who else is here" lines `lazy shell` prints on entering a task: the
 * members inside it, the task container's sessions, and the agent. A banner
 * that cannot be read says so in one line and never stops the entry. Answers
 * the one-line form for the shell's status line.
 */
export async function printPresenceBanner(taskId: string, write: (line: string) => void = console.log): Promise<string | null> {
  let list: TaskSessionsList;
  try {
    list = await queryTaskSessions({ taskId }) as TaskSessionsList;
  } catch (err) {
    write(`(Could not tell who else is in this task: ${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  const presence = {
    task: list.task,
    members: list.members ?? [],
    sessions: list.running ? list.sessions : null,
    agent: list.agent ?? null,
  };
  for (const line of presenceBanner(presence)) write(line);
  // The one-line form, for tmux's status line once it has taken the screen.
  return presenceNotice(presence);
}

/** "42m", "3h", "2d" — how long ago an ISO time was, for a table column. */
function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '-';
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 172800) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function intFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    console.error(`Invalid --${name}: ${value}. Expected a positive whole number.`);
    process.exit(1);
  }
  return Number(value);
}

/**
 * `lazy sessions <task> [name]` — the named tmux sessions running in a task's
 * own container (its `services`, any long-running command): the list, or one
 * session's live screen and the tail of its log. A read: it starts nothing.
 * Attaching a terminal is the Services tab's (dashboard and Lazy Teams).
 */
export async function commandSessions(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'lines', aliases: ['n'], takesValue: true },
    { name: 'log-bytes', takesValue: true },
    { name: 'json', takesValue: false },
  ], 'sessions');

  const taskId = parsed.positional[0];
  if (!taskId) {
    sessionsUsage();
    process.exit(1);
  }
  const name = parsed.positional[1];
  const lines = intFlag(parsed.flags.get('lines') as string | undefined, 'lines');
  const logBytes = intFlag(parsed.flags.get('log-bytes') as string | undefined, 'log-bytes');
  const json = parsed.flags.get('json') === true;

  const result = await queryTaskSessions({
    taskId,
    ...(name !== undefined ? { name } : {}),
    ...(lines !== undefined ? { lines } : {}),
    ...(logBytes !== undefined ? { logBytes } : {}),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (name === undefined) {
    // Who else is here — the members inside the task (each in a container of
    // their own) and the agent — before the task container's own sessions.
    const list = result as TaskSessionsList;
    const now = Date.now();
    for (const m of list.members ?? []) console.log(`member  ${describeMember(m, now)}`);
    if (list.agent) console.log(`agent   ${describeAgent(list.agent, now)}`);
    if ((list.members ?? []).length > 0 || list.agent) console.log('');
  }
  if (!result.running) {
    console.log(`${result.task}: the task's environment is not running, so nothing is running in it.`);
    return;
  }
  if (result.tmux === false) {
    console.log(`${result.task}: this task's environment has no tmux (built from an older image), so it has no sessions.`);
    return;
  }

  if (name === undefined) {
    const list = result as TaskSessionsList;
    if (list.sessions.length === 0) {
      console.log(`${list.task}: no sessions are running in the task's environment.`);
      return;
    }
    const rows = list.sessions.map(s => [
      s.name,
      s.alive ? 'running' : (s.exitCode === null ? 'exited' : `exited (${s.exitCode})`),
      s.alive ? ago(s.createdAt) : '-',
      s.lastOutputAt ? `${ago(s.lastOutputAt)} ago` : '-',
      String(s.attachedClients),
    ]);
    const header = ['SESSION', 'STATE', 'UP', 'LAST OUTPUT', 'ATTACHED'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
    const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
    console.log(line(header));
    for (const r of rows) console.log(line(r));
    return;
  }

  const output = (result as TaskSessionRead).output;
  if (!output || !output.exists) {
    console.log(`${result.task}: no session named ${name} is running.`);
    if (output?.log) console.log(`\n--- log (from when it last ran) ---\n${output.log.replace(/\n$/, '')}`);
    return;
  }
  console.log(`--- ${name}: screen ---`);
  console.log(output.screen.replace(/\n$/, ''));
  if (output.log) {
    console.log(`\n--- ${name}: log${output.logTruncated ? ' (last part)' : ''} ---`);
    console.log(output.log.replace(/\n$/, ''));
  }
}

export function sessionsUsage(): void {
  console.log(`Usage: lazy sessions <task_id> [name] [--lines <n>] [--log-bytes <n>] [--json]

Show who else is in a task and what runs in its own environment. People: the
members with terminals in it, by session name and attached or idle (never what
they run), and whether the agent is running a turn. Sessions: its services
(the "services" session that Start services runs) and any long-running
command, with whether each is running or how it exited, how long it has been
up, and when it last printed. With a session name, print that session's live
screen and the tail of its log instead.

Sessions keep running between the agent's turns and across a restart of lazy.
This only reads them; it starts nothing. To watch or type into one, open the
task's Services tab (Attach, Take control).

Options:
  -n, --lines <n>      Lines of the screen's scrollback to include (default 200)
  --log-bytes <n>      How much of the end of the log to print (default 16 KiB)
  --json               Print the daemon's answer as JSON
`);
}
