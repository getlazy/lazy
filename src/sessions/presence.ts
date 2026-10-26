/**
 * Who else is in a task right now: the members with terminals in it, the
 * named sessions of the task's own container (`services` and any other), and
 * whether the agent is running a turn. The daemon answers it beside the
 * session list (`taskSessions`, src/daemon/task-sessions.ts); every surface
 * renders that answer — the banner `lazy shell` prints on entry, `lazy
 * sessions`, the Services tab.
 *
 * Several people and the agent may work one task at once and nothing makes
 * them take turns, so coordinating is theirs to do; this is what they need for
 * it. It carries NAMES, STATES AND TIMES ONLY — never what a member typed or
 * what their sessions printed, which are theirs.
 *
 * Pure: no I/O, safe from any layer.
 */

import type { ListedTaskSession } from '../daemon/task-sessions';

/** One of a member's named sessions, in their own container. */
export interface PresenceMemberSession {
  name: string;
  /** Has it a client attached right now? */
  attached: boolean;
  /** Its last activity (ISO 8601). */
  lastActivityAt: string | null;
}

/** A member inside the task. */
export interface PresenceMember {
  /** Who, as they signed in (an email address). */
  member: string;
  /** Terminals of theirs open right now (0: their sessions are kept, nobody attached). */
  openTerminals: number;
  /** Their sessions; null when their container could not be asked. */
  sessions: PresenceMemberSession[] | null;
}

/** The agent, from the task's status. */
export interface AgentPresence {
  /** The task's status. */
  status: string;
  /** Is a turn running? */
  working: boolean;
  /** The sequence number of the turn running, or the last one (as the Turns tab numbers it); null before the first. */
  turn: number | null;
  /** When the task entered this status (ISO 8601). */
  since: string | null;
}

export interface TaskPresence {
  task: string;
  members: PresenceMember[];
  /** The task container's sessions; null when the container is not running. */
  sessions: ListedTaskSession[] | null;
  agent: AgentPresence | null;
}

/** "20s", "4m", "2h", "3d". */
export function shortAgo(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 172800) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** "ada (shell, vscode-server · attached)" / "bo (shell · idle 3m)". */
export function describeMember(m: PresenceMember, now: number): string {
  if (m.sessions === null) return `${m.member} (${m.openTerminals > 0 ? 'attached' : 'sessions kept'})`;
  const names = m.sessions.map((s) => s.name);
  const attached = m.openTerminals > 0 || m.sessions.some((s) => s.attached);
  let state: string;
  if (attached) {
    state = 'attached';
  } else {
    const last = m.sessions.map((s) => s.lastActivityAt).filter((t): t is string => !!t).sort().pop() ?? null;
    const ago = shortAgo(last, now);
    state = ago ? `idle ${ago}` : 'idle';
  }
  return names.length > 0 ? `${m.member} (${names.join(', ')} · ${state})` : `${m.member} (${state})`;
}

/** "web (running 2h, last output 20s ago)" / "worker (exited 1, 5m ago)" / "shell (1 attached)". */
export function describeSession(s: ListedTaskSession, now: number): string {
  const parts: string[] = [];
  const out = shortAgo(s.lastOutputAt, now);
  if (s.alive) {
    const up = shortAgo(s.createdAt, now);
    parts.push(up ? `running ${up}` : 'running');
    if (out) parts.push(`last output ${out} ago`);
  } else {
    parts.push(s.exitCode === null ? 'exited' : `exited ${s.exitCode}`);
    if (out) parts.push(`${out} ago`);
  }
  if (s.attachedClients > 0) parts.push(`${s.attachedClients} attached`);
  return `${s.name} (${parts.join(', ')})`;
}

/** "working on turn #13 (started 4m ago)" / "not running a turn — blocked (since 2h ago)". */
export function describeAgent(a: AgentPresence, now: number): string {
  const ago = shortAgo(a.since, now);
  if (a.working) {
    const what = a.turn !== null ? `working on turn #${a.turn}` : 'working';
    return ago ? `${what} (started ${ago} ago)` : what;
  }
  const what = `not running a turn — ${a.status}`;
  return ago ? `${what} (since ${ago} ago)` : what;
}

/**
 * The lines shown on entering a task. `viewer` (the person entering) is left
 * out of the members. Always names the agent; a line per kind only when there
 * is something to say.
 */
export function presenceBanner(p: TaskPresence, opts: { viewer?: string | null; now?: number } = {}): string[] {
  const now = opts.now ?? Date.now();
  const others = p.members.filter((m) => !opts.viewer || m.member !== opts.viewer);
  const lines = [`In ${p.task} with you:`];
  if (others.length > 0) lines.push(`  members: ${others.map((m) => describeMember(m, now)).join(' · ')}`);
  if (p.sessions && p.sessions.length > 0) lines.push(`  sessions: ${p.sessions.map((s) => describeSession(s, now)).join(' · ')}`);
  if (p.agent) lines.push(`  agent: ${describeAgent(p.agent, now)}`);
  if (lines.length === 1) lines.push('  nobody else');
  return lines;
}

/**
 * The same as {@link presenceBanner} on ONE line, for a terminal's status line
 * once tmux has taken the screen. Null when nobody but `viewer` is there and
 * no agent is known.
 */
export function presenceNotice(p: TaskPresence, opts: { viewer?: string | null; now?: number } = {}): string | null {
  const lines = presenceBanner(p, opts);
  if (lines.length === 2 && lines[1] === '  nobody else') return null;
  return `${lines[0]} ${lines.slice(1).map((l) => l.trim()).join(' | ')}`;
}
