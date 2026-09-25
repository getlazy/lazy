/**
 * "Start container" — the dashboard's one way to bring a task's environment up
 * without asking anyone to do a turn.
 *
 * Two things drive the shape of this file.
 *
 * It is ASYNCHRONOUS. `ensureContainer` usually takes seconds, but resolving the
 * image can spend minutes in `docker build`, and a web request is capped well
 * below that (`WEB_REQUEST_DEADLINE_MS`). So the POST kicks the launch off,
 * records it here, and redirects immediately; the page then re-renders the live
 * state and follows along with a plain meta refresh. The registry is in-memory
 * and per-daemon on purpose — it is progress narration for a launch happening
 * right now, not state anyone should be able to read back tomorrow. (Where the
 * container actually got to is not stored here at all: that is `runner.isRunning`,
 * which the next render asks directly.)
 *
 * It NEVER starts from a page RENDER. A dashboard that spun up containers
 * because someone opened a tab would be a resource bomb and a surprise, so
 * nothing here runs on a GET of a task page. It does start from an explicit
 * USER ACTION: the Start container button's POST, and `POST
 * /tasks/:id/container/ensure`, which Watch / Shell / Pair / Chat call when the
 * human opens them. Opening a terminal into a task is a request for that task's
 * environment; making the human first read "container not running" and then
 * press a separate button was ceremony, not consent.
 *
 * One start, shared. Every entry point goes through `beginContainerStart`, which
 * hands back the in-flight start rather than launching a second one, so two
 * panels opened at once attach to the same launch and narrate the same lines.
 */

import type { TaskActions } from './task-actions';
import { escapeHtml } from './escape';

export type ContainerStartPhase = 'starting' | 'done' | 'failed';

export interface ContainerStartState {
  phase: ContainerStartPhase;
  /** Latest narration line from the launch — image resolution, build, start. */
  detail: string;
  /** Failure text, shown verbatim; the daemon's messages are written for humans. */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** How long a finished start stays visible on the page before it is forgotten. */
const TERMINAL_TTL_MS = 60_000;

/** Seconds between reloads while a start is in flight. */
export const CONTAINER_START_REFRESH_SECONDS = 3;

const starts = new Map<string, ContainerStartState>();

/**
 * The current start for this task, or null. Finished starts expire so a page
 * opened ten minutes later does not announce a launch nobody is waiting for.
 */
export function getContainerStart(taskId: string): ContainerStartState | null {
  const state = starts.get(taskId);
  if (!state) return null;
  if (state.phase !== 'starting' && state.endedAt && Date.now() - state.endedAt > TERMINAL_TTL_MS) {
    starts.delete(taskId);
    return null;
  }
  return state;
}

/**
 * Kick off a container start, or return the one already running.
 *
 * Idempotent while in flight: a double-clicked button, or a reload that
 * re-POSTs, must not launch a second `docker run` for the same task.
 */
export function beginContainerStart(taskId: string, actions: TaskActions): ContainerStartState {
  const existing = getContainerStart(taskId);
  if (existing && existing.phase === 'starting') return existing;

  const state: ContainerStartState = {
    phase: 'starting',
    detail: 'Starting the container…',
    startedAt: Date.now(),
  };
  starts.set(taskId, state);

  void actions
    .ensureContainer(taskId, (detail) => {
      // Narration from the launch itself: which image, why a rebuild, the
      // build's own output. Latest line wins — this is a status, not a log.
      if (detail.trim()) state.detail = detail.trim();
    })
    .then((result) => {
      state.phase = 'done';
      state.detail = result.alreadyRunning
        ? 'The container was already running.'
        : `Container ${result.containerName} is up.`;
      state.endedAt = Date.now();
    })
    .catch((err: unknown) => {
      state.phase = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      state.endedAt = Date.now();
    });

  return state;
}

/**
 * The wire shape a panel polls while it waits: the same three phases the button
 * renders, as JSON. `phase: 'idle'` is the one state the HTML has no equivalent
 * for — no start has been recorded (or the last one expired), which for a client
 * that already saw `done` just means "nothing in flight".
 */
export interface ContainerStartJson {
  phase: ContainerStartPhase | 'idle';
  detail: string;
  error?: string;
  startedAt?: number;
}

export function containerStartJson(state: ContainerStartState | null): ContainerStartJson {
  if (!state) return { phase: 'idle', detail: '' };
  return {
    phase: state.phase,
    detail: state.detail,
    ...(state.error ? { error: state.error } : {}),
    startedAt: state.startedAt,
  };
}

/** Test seam: drop all recorded starts. */
export function resetContainerStarts(): void {
  starts.clear();
}

/**
 * What a page knows about starting this task's container.
 *
 * `canStart` is the page's own gate — a non-terminal task, an injected action
 * port, and a place on the page that has actually established the container is
 * down (today only the Services tab, which probes ports anyway). The daemon
 * re-checks everything; this only decides whether offering the button would be
 * honest.
 *
 * It is deliberately narrow now that Watch / Shell / Pair / Chat start the
 * container themselves. The button is a REMEDY, not the normal route: a page
 * that sprinkled it next to every terminal control is what the engineer saw as
 * "multiple Start container buttons", and the answer to "the container is down"
 * on those controls is to bring it up, not to ask.
 */
export interface ContainerControls {
  canStart: boolean;
  start: ContainerStartState | null;
}

/** Nothing to offer — a page rendered without a daemon action port. */
export const NO_CONTAINER_CONTROLS: ContainerControls = { canStart: false, start: null };

/**
 * The Start container button, plus the live state of a start already running.
 *
 * A plain form POST — no JS needed to press it. While a start is in flight the
 * button is replaced by its progress line and a meta refresh: with scripting off
 * the page still follows the launch to its end.
 *
 * `refresh: false` keeps the progress line but drops that meta tag, for a page
 * that renders this button in more than one place. One refresh already reloads
 * the whole page; a second is redundant, and duplicate `<meta http-equiv>` tags
 * in a body are the kind of markup that behaves differently per browser.
 */
export function startContainerHtml(
  taskId: string,
  controls: ContainerControls,
  opts: { label?: string; refresh?: boolean } = {},
): string {
  const state = controls.start;

  if (state?.phase === 'starting') {
    const refreshHtml =
      opts.refresh === false
        ? ''
        // Deliberately in the body: this element is rendered by the card, not by
        // the page shell, and a meta refresh is the no-JS way to follow a launch
        // whose honest duration ranges from seconds to a whole image build.
        : `<meta http-equiv="refresh" content="${CONTAINER_START_REFRESH_SECONDS}">`;
    return `<span class="lz-container-start lz-container-starting">` +
      `<span class="lz-container-spinner" aria-hidden="true"></span>` +
      `<span class="text-muted">${escapeHtml(state.detail)}</span>` +
      refreshHtml +
      `</span>`;
  }

  if (!controls.canStart) return '';

  const failure = state?.phase === 'failed'
    ? `<span class="lz-container-error">${escapeHtml(state.error ?? 'Starting the container failed.')}</span>`
    : '';
  const label = opts.label ?? 'Start container';

  return `<span class="lz-container-start">` +
    `<form method="POST" action="/tasks/${escapeHtml(taskId)}/container/start" class="lz-inline-form">` +
    `<button type="submit" class="btn btn-sm">${escapeHtml(label)}</button>` +
    `</form>${failure}</span>`;
}
