/**
 * The Services tab's Sessions panel on the daemon dashboard: the task
 * container's named tmux sessions (src/daemon/task-sessions.ts) with their run
 * state, live screen and log tail, and an Attach (read-only) / Take control
 * (read-write) terminal on each — the same thing Lazy Teams' Services tab
 * shows.
 *
 * The page ships an EMPTY panel and its script fills it from
 * `GET /tasks/:id/container/sessions` (an HTML fragment), then asks again on a
 * timer. Reading the sessions is a `docker exec`, so a page render never pays
 * for it (the same reason the shell never probes the container on render).
 *
 * The terminals open in the page's shell panel (./shell-ui.ts), mounted in
 * place under the session, over `/tasks/:id/shell/ws?tmux=<name>[&readonly=1]`.
 * The poll leaves a session's block alone while a terminal is open in it, so
 * refreshing the screens never closes an attached terminal.
 */

import { escapeHtml } from './escape';
import { listTaskSessions, readTaskSession, type TaskSessionsDeps } from '../daemon/task-sessions';
import type { SessionOutput } from '../sessions/tmux';
import type { Storage } from '../storage';
import type { ListedTaskSession } from '../daemon/task-sessions';
import { describeAgent, describeMember, type AgentPresence, type PresenceMember } from '../sessions/presence';

/** Lines of each screen and bytes of each log the panel shows. */
const SCREEN_LINES = 60;
const LOG_BYTES = 16 * 1024;
/** Sessions past this many are listed without their screen (one exec each). */
const MAX_SCREENS = 8;
/** Seconds between polls. */
export const SESSIONS_POLL_SECONDS = 3;

/** ANSI escapes stripped: the screen is shown as text; a terminal is one click away. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\s+$/, '');
}

export function stateLabel(s: Pick<ListedTaskSession, 'alive' | 'exitCode'>): string {
  if (s.alive) return 'running';
  return s.exitCode === null ? 'exited' : `exited (${s.exitCode})`;
}

/** "42 minutes", "3 hours", "under a minute" — rough on purpose. */
export function roughDuration(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return '—';
  const secs = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (secs < 60) return 'under a minute';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** The empty panel the Services tab renders; its script fills it. */
export function taskSessionsPanelHtml(taskSeg: string): string {
  const url = `/tasks/${taskSeg}/container/sessions`;
  return `<section class="card lz-sessions" data-lz-sessions data-lz-sessions-url="${escapeHtml(url)}" id="task-sessions">` +
    `<h3>Sessions</h3>` +
    `<p class="rv-hint">Who else is in the task right now, and what runs in its own environment: the services, and any long-running command. ` +
    `Attach watches a session without typing into it; Take control types into it. Either keeps working while the ` +
    `agent runs, and closing it leaves the session running.</p>` +
    `<div data-lz-sessions-body><p class="rv-hint">Reading the task's sessions…</p></div>` +
    `</section>`;
}

export interface SessionsFragmentInput {
  state: 'available' | 'not_running' | 'no_tmux' | 'unreadable';
  message?: string;
  sessions?: Array<ListedTaskSession & { output: SessionOutput | null; readError: string | null }>;
  /** The task's segment, for the shell panel the terminals open in. */
  taskSeg: string;
  /** Whether this page has a shell to open terminals in. */
  canAttach: boolean;
  /** Who else is in the task: members with terminals in it, and the agent. */
  members?: PresenceMember[];
  agent?: AgentPresence | null;
}

/** "Who's here": each member (session names and state only) and the agent. */
export function presenceHtml(members: PresenceMember[], agent: AgentPresence | null, now = Date.now()): string {
  const items = members.map(m => `<li data-presence-member="${escapeHtml(m.member)}">${escapeHtml(describeMember(m, now))}</li>`);
  if (agent) items.push(`<li data-presence-agent="${agent.working ? 'working' : 'parked'}">agent: ${escapeHtml(describeAgent(agent, now))}</li>`);
  if (items.length === 0) return '';
  return `<div class="lz-presence" data-lz-presence><h4>In this task now</h4><ul>${items.join('')}</ul></div>`;
}

function attachControlsHtml(name: string, taskSeg: string): string {
  const btn = (label: string, readonly: boolean, title: string) =>
    `<button type="button" class="btn btn-sm" data-lz-shell-attach="${escapeHtml(name)}"` +
    ` data-lz-shell-readonly="${readonly ? '1' : '0'}" data-lz-shell-for="${escapeHtml(taskSeg)}"` +
    ` title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
  return `<p class="lz-session-attach">` +
    btn('Attach', true, 'Watch this session live, without typing into it') + ' ' +
    btn('Take control', false, 'Type into this session. Everyone attached sees what you type.') +
    `</p>`;
}

/** The panel's body: the list and each session's block. */
export function taskSessionsFragmentHtml(input: SessionsFragmentInput): string {
  return presenceHtml(input.members ?? [], input.agent ?? null) + sessionsBodyHtml(input);
}

function sessionsBodyHtml(input: SessionsFragmentInput): string {
  switch (input.state) {
    case 'unreadable':
      return `<p class="rv-hint" data-lz-sessions-state="unreadable">The task's sessions could not be read just now${input.message ? `: ${escapeHtml(input.message)}` : ''}.</p>`;
    case 'not_running':
      return `<p class="rv-hint" data-lz-sessions-state="not_running">The task's environment is not running, so nothing is running in it.</p>`;
    case 'no_tmux':
      return `<p class="rv-hint" data-lz-sessions-state="no_tmux">This task's environment was built from an image without tmux, so it has no sessions. Restarting it on a current image adds them.</p>`;
  }
  const sessions = input.sessions ?? [];
  if (sessions.length === 0) {
    return `<p class="rv-hint" data-lz-sessions-state="empty">No sessions are running in the task's environment. Start services starts the <code>services</code> session.</p>`;
  }
  const rows = sessions.map(s =>
    `<tr data-session="${escapeHtml(s.name)}">` +
    `<td><a href="#task-session-${escapeHtml(s.name)}"><code>${escapeHtml(s.name)}</code></a></td>` +
    `<td data-session-state="${s.alive ? 'running' : 'exited'}">${escapeHtml(stateLabel(s))}</td>` +
    `<td>${s.alive ? escapeHtml(roughDuration(s.createdAt)) : '—'}</td>` +
    `<td>${s.lastOutputAt ? `${escapeHtml(roughDuration(s.lastOutputAt))} ago` : '—'}</td>` +
    `</tr>`).join('');
  const table = `<table class="lz-sessions-list" data-lz-sessions-list><thead><tr>` +
    `<th>Session</th><th>State</th><th>Up for</th><th>Last output</th></tr></thead><tbody>${rows}</tbody></table>`;
  const blocks = sessions.map(s => {
    const screen = s.readError
      ? `<p class="rv-hint">Its output could not be read just now: ${escapeHtml(s.readError)}</p>`
      : s.output && stripAnsi(s.output.screen)
        ? `<pre class="lz-session-screen" data-session-screen data-lz-session-scroll="screen">${escapeHtml(stripAnsi(s.output.screen))}</pre>`
        : `<p class="rv-hint">Nothing on its screen.</p>`;
    const log = s.output && stripAnsi(s.output.log)
      ? `<details data-session-log><summary>Log${s.output.logTruncated ? ' (last part)' : ''}</summary>` +
        `<pre class="lz-session-screen" data-lz-session-scroll="log">${escapeHtml(stripAnsi(s.output.log))}</pre></details>`
      : '';
    const attach = input.canAttach && s.alive ? attachControlsHtml(s.name, input.taskSeg) : '';
    return `<div class="lz-session" id="task-session-${escapeHtml(s.name)}" data-session="${escapeHtml(s.name)}" data-lz-shell-step>` +
      `<h4><code>${escapeHtml(s.name)}</code> <span class="text-muted">— ${escapeHtml(stateLabel(s))}</span></h4>` +
      `<div data-lz-session-live>${screen}${log}</div>` +
      attach +
      `<div class="lz-shell-mount" data-lz-shell-mount hidden></div>` +
      `</div>`;
  }).join('');
  return table + blocks;
}

/** Read everything the fragment shows. Never throws: an unreadable daemon read is a sentence. */
export async function loadTaskSessionsFragment(
  projectRoot: string,
  storage: Storage,
  taskId: string,
  opts: { taskSeg: string; canAttach: boolean; deps?: TaskSessionsDeps },
): Promise<string> {
  const deps: TaskSessionsDeps = { getStorage: async () => storage, ...opts.deps };
  try {
    const listed = await listTaskSessions(projectRoot, { taskId }, deps);
    const who = { members: listed.members, agent: listed.agent };
    if (!listed.running) return taskSessionsFragmentHtml({ state: 'not_running', taskSeg: opts.taskSeg, canAttach: false, ...who });
    if (listed.tmux === false) return taskSessionsFragmentHtml({ state: 'no_tmux', taskSeg: opts.taskSeg, canAttach: false, ...who });
    const sessions = [];
    for (const [i, s] of listed.sessions.entries()) {
      let output: SessionOutput | null = null;
      let readError: string | null = null;
      if (i < MAX_SCREENS) {
        try {
          output = (await readTaskSession(projectRoot, { taskId, name: s.name, lines: SCREEN_LINES, logBytes: LOG_BYTES }, deps)).output;
        } catch (err) {
          readError = err instanceof Error ? err.message : String(err);
        }
      }
      sessions.push({ ...s, output, readError });
    }
    return taskSessionsFragmentHtml({ state: 'available', sessions, taskSeg: opts.taskSeg, canAttach: opts.canAttach, ...who });
  } catch (err) {
    return taskSessionsFragmentHtml({
      state: 'unreadable',
      message: err instanceof Error ? err.message : String(err),
      taskSeg: opts.taskSeg,
      canAttach: false,
    });
  }
}

/**
 * Fills every panel on the page and asks again every few seconds. A session
 * block whose terminal is open (its mount visible) is kept as it is, so the
 * poll never closes a terminal; the rest of the panel is replaced, keeping
 * what the reader did with it — an opened Log stays open, and a screen stays
 * at its newest output unless the reader scrolled it up. Nothing is asked
 * while the panel cannot be seen (another tab, or the browser tab hidden).
 */
export function taskSessionsClientScript(): string {
  return `<script>
(() => {
  if (window.__lzSessionsWired) return;
  window.__lzSessionsWired = true;
  const POLL_MS = ${SESSIONS_POLL_SECONDS * 1000};
  function unseen(panel) {
    if (document.hidden) return true;
    const tabBody = panel.closest('[data-lz-tab-body]');
    return !!(tabBody && tabBody.hidden);
  }
  // Per session: is its log open, and how far up is each screen scrolled (null: at the bottom)?
  function capture(body) {
    const kept = {};
    body.querySelectorAll('[data-session][data-lz-shell-step]').forEach((el) => {
      const log = el.querySelector('details[data-session-log]');
      const scrolls = {};
      el.querySelectorAll('[data-lz-session-scroll]').forEach((pre) => {
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 4;
        scrolls[pre.getAttribute('data-lz-session-scroll')] = atBottom ? null : pre.scrollTop;
      });
      kept[el.getAttribute('data-session')] = { logOpen: !!(log && log.open), scrolls: scrolls };
    });
    return kept;
  }
  function restore(body, kept) {
    body.querySelectorAll('[data-session][data-lz-shell-step]').forEach((el) => {
      const was = kept[el.getAttribute('data-session')];
      const log = el.querySelector('details[data-session-log]');
      if (log && was && was.logOpen) log.open = true;
      el.querySelectorAll('[data-lz-session-scroll]').forEach((pre) => {
        const top = was && was.scrolls ? was.scrolls[pre.getAttribute('data-lz-session-scroll')] : undefined;
        pre.scrollTop = top == null ? pre.scrollHeight : top;
      });
    });
  }
  async function refresh(panel) {
    if (!panel.isConnected) return;
    const body = panel.querySelector('[data-lz-sessions-body]');
    if (panel.__lzPolled && unseen(panel)) { setTimeout(() => refresh(panel), POLL_MS); return; }
    panel.__lzPolled = true;
    try {
      const res = await fetch(panel.getAttribute('data-lz-sessions-url'), { headers: { Accept: 'text/html' } });
      if (res.ok) {
        const html = await res.text();
        const live = Array.from(body.querySelectorAll('[data-session][data-lz-shell-step]'))
          .filter((el) => { const m = el.querySelector('[data-lz-shell-mount]'); return m && !m.hidden; });
        const kept = capture(body);
        const next = document.createElement('div');
        next.innerHTML = html;
        // Keep a block with an open terminal as the element it is.
        for (const el of live) {
          const twin = next.querySelector('[data-lz-shell-step][data-session="' + (window.CSS && CSS.escape ? CSS.escape(el.getAttribute('data-session')) : el.getAttribute('data-session')) + '"]');
          if (twin) twin.replaceWith(el);
          else next.appendChild(el);
        }
        body.replaceChildren(...next.childNodes);
        restore(body, kept);
      }
    } catch (e) { /* the next poll asks again */ }
    setTimeout(() => refresh(panel), POLL_MS);
  }
  function wireAll() { document.querySelectorAll('[data-lz-sessions]').forEach((p) => { if (!p.__lzWired) { p.__lzWired = true; refresh(p); } }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireAll);
  else wireAll();
  // The tab body arrives by a fragment swap too.
  new MutationObserver(wireAll).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;
}
