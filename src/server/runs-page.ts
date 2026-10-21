/**
 * The dashboard's Run pages — the product running at one commit without a
 * task (src/daemon/commit-run.ts, docs/design/run-any-commit.md):
 *
 *   - `/runs` picks what to run — the remote's default branch (preselected),
 *     any branch (task branches behind a toggle), or a commit id — and lists
 *     the runs that exist, each with the exact commit it serves;
 *   - `/runs/:id` is one run: the commit it serves, its Services card (the
 *     same renderer a task's uses), Run / Stop services, what is running in
 *     its environment, Pull latest, Remove, the image choice and a shell.
 *
 * RENDER ONLY. Everything here is drawn from what the daemon answered through
 * the RunActions port (./run-actions.ts); no rule about runs is decided here.
 * The routes are ./runs-routes.ts.
 *
 * INVARIANT: rendering starts NOTHING. Both pages are reached by GET — the
 * run page is where the service proxy sends a dead service's navigation — and
 * every start, pull or removal is a POST behind a button (the same CSRF
 * reasoning as ./serve-notice.ts).
 */

import type {
  RunBranch,
  RunBranchList,
  RunCommit,
  RunDetail,
  RunPerson,
  RunServeView,
  RunServicesRun,
  RunView,
} from './run-actions';
import type { ActionRunState } from './action-run';
import type { ServeNotice } from './serve-notice';
import type { ProgressEvent } from '../daemon/progress';
import { escapeHtml } from './escape';
import { layoutHtml } from './templates';
import { timestampHtml } from './timestamps';
import { servicesCardHtml } from './services-card';
import { shellPanelHtml, shellClientScript, type ShellAvailability } from './shell-ui';
import {
  actionDialogButtonHtml,
  actionDialogChromeHtml,
  actionDialogScript,
  actionDialogTemplateHtml,
} from './action-dialog';
import { displayUrlFor, serviceHostLabel } from '../serve/subdomain';
import { RUNS_INDEX_PATH, runPath } from './run-urls';

/** Seconds between reloads of a waiting page. */
export const RUN_WAIT_REFRESH_SECONDS = 2;

// --- Shared bits ---

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function whenHtml(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? timestampHtml(ts) : '';
}

function personHtml(person: RunPerson | null): string {
  if (!person) return '';
  const label = person.name || person.email;
  return label ? ` by <span title="${escapeHtml(person.email ?? '')}">${escapeHtml(label)}</span>` : '';
}

/** "branch main" / "commit 0123456789ab" — what a run follows or is pinned to. */
export function runTargetLabelHtml(run: Pick<RunView, 'target' | 'head_sha'>): string {
  return run.target.kind === 'branch'
    ? `branch <code>${escapeHtml(run.target.branch)}</code>`
    : `commit <code>${escapeHtml(shortSha(run.head_sha))}</code>`;
}

function commitHtml(commit: RunCommit | null, sha: string): string {
  if (!commit) {
    return `<code class="lz-run-sha">${escapeHtml(shortSha(sha))}</code> ` +
      `<span class="text-muted">(not readable in this clone)</span>`;
  }
  return `<code class="lz-run-sha" title="${escapeHtml(commit.sha)}">${escapeHtml(shortSha(commit.sha))}</code> ` +
    `<span class="lz-run-subject">${escapeHtml(commit.subject)}</span> ` +
    `<span class="text-muted">committed ${whenHtml(commit.committedAt)}</span>`;
}

/** A refusal or a finished action, said at the top of a page. */
export interface RunFlash {
  kind: 'error' | 'done';
  message: string;
  /** Files and commits the message is about (the ones a confirmation would discard). */
  items?: string[];
  /** A confirm-and-retry: the same POST again with `fields` added. */
  confirm?: { label: string; action: string; fields: Record<string, string> };
}

function flashHtml(flash: RunFlash | null | undefined): string {
  if (!flash) return '';
  const items = flash.items && flash.items.length
    ? `<ul class="lz-run-flash-items">${flash.items.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join('')}</ul>`
    : '';
  const confirm = flash.confirm
    ? `<form method="POST" action="${escapeHtml(flash.confirm.action)}" class="lz-inline-form">` +
      Object.entries(flash.confirm.fields)
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('') +
      `<button type="submit" class="btn btn-sm">${escapeHtml(flash.confirm.label)}</button></form>`
    : '';
  return `<div class="lz-run-flash lz-run-flash-${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">` +
    `<p>${escapeHtml(flash.message)}</p>${items}${confirm}</div>`;
}

const DIALOG = (): string => `${actionDialogChromeHtml()}\n${actionDialogScript()}`;

// --- /runs ---

export interface RunsIndexInput {
  branches: RunBranchList | null;
  /** Why the branch list could not be read (offline, no remote). */
  branchesError: string | null;
  runs: RunView[];
  /** Show `lazy/*` task branches in the picker. */
  showTaskBranches: boolean;
  /** What was picked, kept across a refused submit: `default`, `branch:<name>` or `sha`. */
  choice: string;
  sha: string;
  flash?: RunFlash | null;
}

function branchOptionHtml(branch: RunBranch, input: RunsIndexInput, runFor: Map<string, RunView>): string {
  const value = `branch:${branch.name}`;
  const checked = input.choice === value ? ' checked' : '';
  const existing = runFor.get(branch.name);
  return `<li class="lz-run-option${branch.isTaskBranch ? ' lz-run-option-task' : ''}">` +
    `<label><input type="radio" name="target" value="${escapeHtml(value)}"${checked}> ` +
    `<span class="lz-run-branch">${escapeHtml(branch.name)}</span>` +
    (branch.isTaskBranch ? ` <span class="tag tag-neutral">task branch</span>` : '') +
    ` <code class="lz-run-sha" title="${escapeHtml(branch.sha)}">${escapeHtml(branch.sha.slice(0, 7))}</code>` +
    ` <span class="lz-run-subject">${escapeHtml(branch.subject)}</span>` +
    ` <span class="text-muted">${whenHtml(branch.committedAt)}</span></label>` +
    (existing ? ` <a class="lz-run-existing" href="${escapeHtml(runPath(existing.id))}">already running as ${escapeHtml(existing.slug)}</a>` : '') +
    `</li>`;
}

function pickerHtml(input: RunsIndexInput, runs: RunView[]): string {
  const runFor = new Map<string, RunView>();
  for (const r of runs) if (r.target.kind === 'branch') runFor.set(r.target.branch, r);
  const list = input.branches;
  const defaultName = list?.defaultBranch ?? null;
  const defaultBranch = list?.branches.find((b) => b.isDefault) ?? null;
  const others = (list?.branches ?? []).filter((b) => !b.isDefault);
  const taskBranches = others.filter((b) => b.isTaskBranch);
  const shown = others.filter((b) => !b.isTaskBranch || input.showTaskBranches);
  const defaultExisting = defaultName ? runFor.get(defaultName) : undefined;

  // The default branch is the first choice and preselected: running "what is
  // on main right now" is the reason this page exists.
  const defaultRow = `<li class="lz-run-option lz-run-option-default">` +
    `<label><input type="radio" name="target" value="default"${input.choice === 'default' ? ' checked' : ''}> ` +
    `<strong>The default branch</strong>` +
    (defaultName ? ` <span class="lz-run-branch">${escapeHtml(defaultName)}</span>` : '') +
    (defaultBranch
      ? ` <code class="lz-run-sha" title="${escapeHtml(defaultBranch.sha)}">${escapeHtml(defaultBranch.sha.slice(0, 7))}</code>` +
        ` <span class="lz-run-subject">${escapeHtml(defaultBranch.subject)}</span>` +
        ` <span class="text-muted">${whenHtml(defaultBranch.committedAt)}</span>`
      : ` <span class="text-muted">— its newest commit on the remote</span>`) +
    `</label>` +
    (defaultExisting ? ` <a class="lz-run-existing" href="${escapeHtml(runPath(defaultExisting.id))}">already running as ${escapeHtml(defaultExisting.slug)}</a>` : '') +
    `</li>`;

  const shaRow = `<li class="lz-run-option lz-run-option-sha">` +
    `<label><input type="radio" name="target" value="sha" data-lz-run-sha-choice${input.choice === 'sha' ? ' checked' : ''}> ` +
    `<strong>A commit</strong></label> ` +
    `<input class="input lz-run-sha-input" type="text" name="sha" value="${escapeHtml(input.sha)}" ` +
    `placeholder="commit id, 7 to 40 hex characters" autocomplete="off" spellcheck="false" ` +
    `pattern="[0-9a-fA-F]{7,40}" aria-label="Commit id" data-lz-run-sha>` +
    `<span class="rv-hint">It must be on one of the remote's branches.</span>` +
    `</li>`;

  const toggle = taskBranches.length === 0
    ? ''
    : input.showTaskBranches
      ? `<a href="${RUNS_INDEX_PATH}">Hide task branches (${taskBranches.length})</a>`
      : `<a href="${RUNS_INDEX_PATH}?task_branches=1">Show task branches (${taskBranches.length})</a>`;
  const fetchedNote = list
    ? (list.fetched ? `Fetched from <code>${escapeHtml(list.remote)}</code> just now.` : `Branches on <code>${escapeHtml(list.remote)}</code> as last fetched.`)
    : '';
  const refresh = `<a href="${RUNS_INDEX_PATH}?refresh=1${input.showTaskBranches ? '&amp;task_branches=1' : ''}" id="lz-runs-refresh">Fetch now</a>`;
  const branchesHead = `<p class="lz-run-branches-head text-muted">${fetchedNote} ${refresh}${toggle ? ` · ${toggle}` : ''}</p>`;
  const branchesError = input.branchesError
    ? `<p class="lz-run-flash lz-run-flash-error">${escapeHtml(input.branchesError)}</p>`
    : '';

  return `<section class="card lz-run-pick">` +
    `<h2>Run a commit</h2>` +
    `<form method="POST" action="${RUNS_INDEX_PATH}" id="lz-run-create" data-lz-action-form data-lz-action-when="always" data-lz-action-retry data-lz-action-title="Run">` +
    `<ul class="lz-run-options">${defaultRow}${shaRow}</ul>` +
    `<h3>Branches</h3>` +
    branchesHead + branchesError +
    (shown.length
      ? `<ul class="lz-run-options lz-run-branch-options">${shown.map((b) => branchOptionHtml(b, input, runFor)).join('')}</ul>`
      : list ? `<p class="text-muted">No other branches${taskBranches.length && !input.showTaskBranches ? ' besides task branches' : ''}.</p>` : '') +
    `<div class="lz-run-submit"><button type="submit" class="btn btn-primary" id="lz-run-submit">Run</button>` +
    `<span class="rv-hint">One run per branch and per commit, shared by everyone on the project: running one that exists opens it.</span></div>` +
    `</form>` +
    runShaChoiceScript() +
    `</section>`;
}

/**
 * Typing a commit id picks the commit option — otherwise the preselected
 * default branch would run instead of what was typed.
 */
export function runShaChoiceScript(): string {
  return `<script>
(function () {
  var input = document.querySelector('[data-lz-run-sha]');
  var choice = document.querySelector('[data-lz-run-sha-choice]');
  if (!input || !choice) return;
  input.addEventListener('focus', function () { choice.checked = true; });
  input.addEventListener('input', function () { if (input.value) choice.checked = true; });
})();
</script>`;
}

function runsTableHtml(runs: RunView[]): string {
  if (runs.length === 0) {
    return `<section class="card lz-run-list"><h2>Runs</h2><p class="text-muted" id="lz-runs-empty">Nothing is running yet.</p></section>`;
  }
  const rows = runs.map((run) => {
    const moved = run.checkout?.moved
      ? `<div class="lz-run-moved">checkout moved to ${commitHtml(run.checkout.commit, run.checkout.head)}</div>`
      : '';
    const behind = run.remote?.ahead ? ` <span class="tag tag-warning">${run.remote.ahead} newer on the branch</span>` : '';
    return `<tr data-run-id="${escapeHtml(run.id)}">` +
      `<td><a href="${escapeHtml(runPath(run.id))}"><strong>${escapeHtml(run.slug)}</strong></a></td>` +
      `<td>${runTargetLabelHtml(run)}</td>` +
      `<td class="wrap">${commitHtml(run.commit, run.head_sha)}${behind}${moved}</td>` +
      `<td>${whenHtml(run.created_at)}${personHtml(run.created_by)}</td>` +
      `</tr>`;
  }).join('');
  return `<section class="card lz-run-list"><h2>Runs</h2>` +
    `<table class="table"><thead><tr><th>Run</th><th>Follows</th><th>Serving</th><th>Created</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></section>`;
}

export function runsIndexPageHtml(input: RunsIndexInput): string {
  const content = `<div class="lz-runs-page">` +
    `<div class="page-head"><h1>Runs</h1></div>` +
    `<p class="text-muted lz-runs-intro">Run the product at any commit, without a task — the default branch as it stands, ` +
    `a colleague's branch, or the commit a bug report names. A run has the same services and shell as a task, ` +
    `and holds no agent credential.</p>` +
    flashHtml(input.flash) +
    pickerHtml(input, input.runs) +
    runsTableHtml(input.runs) +
    `</div>` + DIALOG();
  return layoutHtml('Runs', content);
}

// --- /runs/:id ---

export interface RunPageInput {
  run: RunDetail;
  serve: RunServeView | null;
  /** Why the services could not be read. */
  serveError: string | null;
  notice: ServeNotice | null;
  /** The last action this page started, when the redirect after it names it. */
  lastAction: ActionRunState | null;
  flash?: RunFlash | null;
}

const PHASE_LABEL: Record<string, string> = {
  starting: 'starting',
  running: 'running',
  exited: 'exited',
  stopped: 'stopped',
  never: 'not started',
};

/** What Start services is doing in the run's environment, read from the container. */
function inventoryHtml(run: RunServicesRun | null, serve: RunServeView | null): string {
  if (!serve || serve.unavailable === 'not-running') return '';
  if (!run) {
    return serve.containerRunning
      ? `<div class="lz-run-inventory" id="lz-run-inventory" data-phase="unknown"><h3>Running in this environment</h3>` +
        `<p class="text-muted">The environment did not say what is running in it.</p></div>`
      : '';
  }
  const phase = run.phase ?? (run.state === 'running' ? 'running' : run.state === 'stopped' ? 'stopped' : 'never');
  if (phase === 'never') {
    return `<div class="lz-run-inventory" id="lz-run-inventory" data-phase="never"><h3>Running in this environment</h3>` +
      `<p class="text-muted">The environment is up; Run services has not been started in it.</p></div>`;
  }
  const tone = phase === 'running' ? 'tag-success' : phase === 'starting' ? 'tag-warning' : phase === 'exited' ? 'tag-danger' : 'tag-neutral';
  const facts = [
    run.command ? `<dt>Command</dt><dd><code>${escapeHtml(run.command)}</code></dd>` : '',
    run.startedAt ? `<dt>Started</dt><dd>${whenHtml(run.startedAt)}</dd>` : '',
    phase === 'exited' && run.exitCode !== undefined && run.exitCode !== null ? `<dt>Exit code</dt><dd>${run.exitCode}</dd>` : '',
  ].join('');
  const procs = (run.processes ?? []).map((p) => {
    const ports = (p.services && p.services.length
      ? p.services.map((s) => `<span class="tag ${s.listening === true ? 'tag-success' : 'tag-neutral'}">${escapeHtml(s.name)} · port ${s.port}</span>`)
      : p.listeningPorts.map((port) => `<span class="tag tag-neutral">port ${port}</span>`)).join(' ');
    return `<li data-pid="${p.pid}"><span class="lz-run-pid">pid ${p.pid}</span>` +
      (p.wrapper ? ` <strong>Run services</strong>` : '') + ` ${ports}` +
      `<code class="lz-run-proc">${escapeHtml(p.command)}</code></li>`;
  }).join('');
  const log = run.log
    ? `<details class="lz-run-log" id="lz-run-log"><summary>Output${run.logTruncated ? ' (the last part)' : ''}</summary><pre>${escapeHtml(run.log)}</pre></details>`
    : '';
  return `<div class="lz-run-inventory" id="lz-run-inventory" data-phase="${escapeHtml(phase)}">` +
    `<h3>Running in this environment <span class="tag ${tone}">${escapeHtml(PHASE_LABEL[phase] ?? phase)}</span></h3>` +
    (facts ? `<dl class="lz-run-facts">${facts}</dl>` : '') +
    (procs ? `<ul class="lz-run-procs">${procs}</ul>` : '') +
    log +
    `</div>`;
}

function describeEvent(e: ProgressEvent): { label: string; state: string; detail: string } | null {
  if (e.kind !== 'phase') return null;
  return { label: e.label, state: e.state, detail: e.detail ?? '' };
}

/**
 * The last action this page started, read back from the in-process action
 * registry by the id its redirect carried — so what a Pull discarded, or why
 * the restart after it failed, is still on screen after the dialog closed.
 */
function lastActionHtml(action: ActionRunState | null): string {
  if (!action) return '';
  const latest = new Map<string, { label: string; state: string; detail: string }>();
  for (const e of action.events) {
    const d = describeEvent(e);
    if (!d || e.kind !== 'phase') continue;
    latest.set(e.id, d);
  }
  const steps = [...latest.values()].map((d) =>
    `<li data-state="${escapeHtml(d.state)}">${escapeHtml(d.label)} — ${escapeHtml(d.state === 'start' || d.state === 'progress' ? 'running' : d.state)}` +
    (d.detail ? `: ${escapeHtml(d.detail)}` : '') + `</li>`).join('');
  const notes = (action.notes ?? []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const title = ACTION_TITLES[action.operation] ?? action.operation;
  return `<div class="lz-run-last-action" id="lz-run-last-action" data-status="${escapeHtml(action.status)}">` +
    `<p><strong>${escapeHtml(title)}</strong> — ${escapeHtml(action.status === 'running' ? 'still running' : action.status)}</p>` +
    (steps ? `<ol>${steps}</ol>` : '') +
    (notes ? `<ul class="lz-run-notes">${notes}</ul>` : '') +
    (action.error ? `<p class="lz-run-flash-error">${escapeHtml(action.error)}</p>` : '') +
    `</div>`;
}

export const ACTION_TITLES: Record<string, string> = {
  'run-create': 'Run',
  'run-services': 'Run services',
  'run-pull': 'Pull latest',
  'run-remove': 'Remove',
};

/** Why a service did not answer, said about a run. Composed from the run's own state, never the URL. */
function noticeHtml(notice: ServeNotice, run: RunDetail, serve: RunServeView | null): string {
  const match = serve?.services.find((s) => serviceHostLabel(s) === notice.service);
  const port = match ? ` on port ${match.port}` : '';
  const why = {
    'not-running': 'the run’s environment is not running, so none of its ports are published.',
    'no-container-runner': 'this project runs without a container, so there is no port mapping to route through.',
    'unknown-service': 'the project declares no service by that name or port.',
    'not-published': 'the environment does not publish that port — it was started before the [serve] entry; stop the environment and run services again.',
    'not-listening': `nothing is listening${port} in the run’s environment — the port is published, but the server is not up.`,
  }[notice.reason];
  const retry = match ? (displayUrlFor(match) ?? match.url) : null;
  return `<div class="lz-serve-notice" id="lz-run-serve-notice">` +
    `<p class="lz-serve-notice-head" role="status">You opened <code>${escapeHtml(notice.service)}</code> on ` +
    `<code>${escapeHtml(run.slug)}</code>, but ${escapeHtml(why)}</p>` +
    `<p class="lz-serve-notice-actions">Run services below starts it` +
    (retry ? ` · <a class="lz-serve-retry" href="${escapeHtml(retry)}">Try again</a>` : '') + `</p>` +
    `</div>`;
}

function servicesControlsHtml(run: RunDetail, serve: RunServeView | null): string {
  const base = runPath(run.id);
  const cmd = serve?.startServicesCmd ?? '';
  const noContainer = serve?.unavailable === 'no-container-runner';
  const running = serve?.servicesRun?.state === 'running';
  if (noContainer) {
    return `<p class="rv-hint">This project runs on the ${escapeHtml(serve!.runnerType)} runner; runs need a container runtime (Docker or Podman).</p>`;
  }
  const what = cmd
    ? `<p class="lz-run-cmd">Run services runs <code>${escapeHtml(cmd)}</code> in the run's environment, ` +
      `starting the environment first if it is down${running ? ' (restarting the command, which is running now)' : ''}.</p>`
    : `<p class="rv-hint" id="lz-run-no-cmd">No Start services command is designated for this project, so there is nothing to run. ` +
      `<a href="/settings/services">Configure services</a> sets one for every task and run.</p>`;
  const runForm = cmd
    ? `<form method="POST" action="${escapeHtml(base)}/services/run" class="lz-inline-form" id="lz-run-services-form"` +
      ` data-lz-action-form data-lz-action-when="always" data-lz-action-retry data-lz-action-title="Run services">` +
      `<button type="submit" class="btn btn-primary btn-sm" id="lz-run-services">${running ? 'Restart services' : 'Run services'}</button></form>`
    : '';
  const stopForm = serve?.containerRunning
    ? `<form method="POST" action="${escapeHtml(base)}/services/stop" class="lz-inline-form">` +
      `<button type="submit" class="btn btn-sm" id="lz-run-stop-services">Stop services</button></form>` +
      `<form method="POST" action="${escapeHtml(base)}/environment/stop" class="lz-inline-form">` +
      `<button type="submit" class="btn btn-sm" id="lz-run-stop-env" title="Remove the run's environment; its checkout and record stay">Stop environment</button></form>`
    : '';
  return what + `<div class="lz-run-buttons">${runForm}${stopForm}</div>`;
}

function imageChoiceHtml(run: RunDetail): string {
  if (run.image_choice !== 'default') return '';
  return `<div class="lz-run-image" id="lz-run-image">Runs on lazy's default image — chosen while the project's own image was not ready. ` +
    `<form method="POST" action="${escapeHtml(runPath(run.id))}/image-choice" class="lz-inline-form">` +
    `<input type="hidden" name="choice" value="project">` +
    `<button type="submit" class="btn btn-sm">Use the project's image</button></form> ` +
    `<span class="rv-hint">Takes effect the next time the environment starts.</span></div>`;
}

function factsHtml(run: RunDetail): string {
  const rows: string[] = [];
  rows.push(`<dt>Serving</dt><dd id="lz-run-serving">${commitHtml(run.commit, run.head_sha)}</dd>`);
  if (run.checkout?.moved) {
    rows.push(`<dt>Checkout</dt><dd class="lz-run-moved" id="lz-run-moved">moved to ${commitHtml(run.checkout.commit, run.checkout.head)} ` +
      `<span class="rv-hint">— somebody checked out or committed something else in the run's shell</span></dd>`);
  } else if (!run.checkoutExists) {
    rows.push(`<dt>Checkout</dt><dd class="text-muted">missing — Run services checks the commit out again</dd>`);
  }
  if (run.target.kind === 'branch') {
    const ahead = run.remote?.ahead;
    const line = run.remote?.sha == null
      ? `<span class="text-muted">the branch is not in this clone's last fetch</span>`
      : ahead === 0
        ? `up to date with <code>${escapeHtml(run.target.branch)}</code> as last fetched`
        : ahead
          ? `<strong>${ahead} newer commit${ahead === 1 ? '' : 's'}</strong> on <code>${escapeHtml(run.target.branch)}</code> as last fetched`
          : `<code>${escapeHtml(run.target.branch)}</code> is at <code>${escapeHtml(shortSha(run.remote.sha))}</code> as last fetched`;
    rows.push(`<dt>Branch</dt><dd id="lz-run-remote">${line}</dd>`);
  } else {
    rows.push(`<dt>Pinned</dt><dd>to this commit — there is nothing to pull</dd>`);
  }
  rows.push(`<dt>Environment</dt><dd id="lz-run-env">${run.containerRunning ? 'running' : 'not running'}</dd>`);
  rows.push(`<dt>Created</dt><dd>${whenHtml(run.created_at)}${personHtml(run.created_by)}</dd>`);
  if (run.last_pulled_at) rows.push(`<dt>Last pulled</dt><dd>${whenHtml(run.last_pulled_at)}${personHtml(run.last_pulled_by)}</dd>`);
  return `<dl class="lz-run-facts">${rows.join('')}</dl>`;
}

function runActionsHtml(run: RunDetail): string {
  const base = runPath(run.id);
  const pull = run.canPull
    ? `<form method="POST" action="${escapeHtml(base)}/pull" class="lz-inline-form" id="lz-run-pull-form"` +
      ` data-lz-action-form data-lz-action-when="always" data-lz-action-retry data-lz-action-title="Pull latest">` +
      `<button type="submit" class="btn btn-sm" id="lz-run-pull" title="Move the run to the branch's newest commit on the remote">Pull latest</button></form>`
    : '';
  const removeForm = `<form method="POST" action="${escapeHtml(base)}/remove" class="lz-action-form" data-lz-action-form>` +
    `<p>Removes the run's environment (and everything running in it), its checkout and its record. ` +
    `Changes somebody made in its shell are listed first, and kept until you confirm.</p>` +
    `<div class="rv-form-actions"><button type="submit" class="btn btn-danger" id="lz-run-remove-confirm">Remove ${escapeHtml(run.slug)}</button></div>` +
    `</form>`;
  const remove = actionDialogButtonHtml({ verb: 'run-remove', label: 'Remove', title: `Remove ${run.slug}` }) +
    actionDialogTemplateHtml('run-remove', removeForm);
  return `<div class="lz-run-buttons lz-run-head-actions">${pull}${remove}</div>`;
}

export function runPageHtml(input: RunPageInput): string {
  const { run, serve } = input;
  const base = runPath(run.id);
  const startsServices = serve?.servicesRun?.phase === 'starting' || serve?.servicesRun?.phase === 'running' || serve?.servicesRun?.state === 'running';
  const card = serve
    ? servicesCardHtml({ id: run.id, code: run.slug }, serve, undefined, {
        subject: 'run',
        waitHref: startsServices ? (name) => `${base}/open/${encodeURIComponent(name)}` : undefined,
      })
    : `<p class="lz-run-flash lz-run-flash-error">The run's services could not be read: ${escapeHtml(input.serveError ?? 'unknown error')}</p>`;
  const shellAvail: ShellAvailability = serve?.unavailable === 'no-container-runner'
    ? { available: false, reason: `This project runs on the ${serve.runnerType} runner, which has no container to enter.`, code: 'no-container-runner' }
    : { available: true };
  const content = `<div class="lz-run-page" data-lz-run-id="${escapeHtml(run.id)}">` +
    `<p class="breadcrumb"><a href="${RUNS_INDEX_PATH}">Runs</a> / ${escapeHtml(run.slug)}</p>` +
    `<div class="page-head"><h1>${escapeHtml(run.slug)} <span class="lz-run-follows">${runTargetLabelHtml(run)}</span></h1>${runActionsHtml(run)}</div>` +
    (input.notice ? noticeHtml(input.notice, run, serve) : '') +
    flashHtml(input.flash) +
    lastActionHtml(input.lastAction) +
    factsHtml(run) +
    imageChoiceHtml(run) +
    card +
    `<section class="card lz-run-services" id="lz-run-services-section"><h2>Run services</h2>` +
    servicesControlsHtml(run, serve) +
    inventoryHtml(serve?.servicesRun ?? null, serve) +
    `</section>` +
    `<section class="card lz-run-shell"><h2>Shell</h2>` +
    `<p class="rv-hint">A shell in the run's environment, in its checkout — started if it is down. Shared: what one person starts there, everyone sees.</p>` +
    shellPanelHtml(run.id, shellAvail, { base }) +
    `</section>` +
    `</div>` + DIALOG() + (shellAvail.available ? shellClientScript() : '');
  return layoutHtml(`Run ${run.slug}`, content);
}

// --- /runs/:id/open/:service ---

export interface RunWaitInput {
  run: RunView;
  service: string;
  port: number | null;
  /** Start services' phase: the page keeps waiting only while it is starting or running. */
  phase: string | null;
  startedAt: string | null;
}

/**
 * "Open when it answers": a page that reloads until the service answers, and
 * is then redirected to it by the route. It waits only while Start services
 * runs — with nothing started, nothing will ever answer, and it says so.
 */
export function runWaitPageHtml(input: RunWaitInput): string {
  const back = `<a href="${escapeHtml(runPath(input.run.id))}">Back to ${escapeHtml(input.run.slug)}</a>`;
  const waiting = input.phase === 'starting' || input.phase === 'running';
  const body = waiting
    ? `<meta http-equiv="refresh" content="${RUN_WAIT_REFRESH_SECONDS}">` +
      `<p class="lz-run-wait" id="lz-run-wait" role="status"><span class="lz-container-spinner" aria-hidden="true"></span> ` +
      `Waiting for <code>${escapeHtml(input.service)}</code>${input.port ? ` on port ${input.port}` : ''} to answer` +
      (input.startedAt ? ` — Run services started ${whenHtml(input.startedAt)}` : '') +
      `. This page opens it as soon as it does.</p>`
    : `<p class="lz-run-flash lz-run-flash-error" id="lz-run-wait-stopped">Nothing will answer: Run services is not running in this run` +
      `${input.phase ? ` (it is ${escapeHtml(PHASE_LABEL[input.phase] ?? input.phase)})` : ''}. Start it from the run's page.</p>`;
  return layoutHtml(`Waiting for ${input.service}`, `<div class="lz-run-page">${body}<p>${back}</p></div>`);
}
