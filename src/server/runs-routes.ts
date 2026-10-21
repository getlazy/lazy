/**
 * Routes behind the dashboard's Run pages (./runs-page.ts):
 *
 *   GET  /runs                              pick what to run; the runs that exist
 *   POST /runs                              runs.create
 *   GET  /runs/:id                          one run (where a dead service's navigation lands)
 *   POST /runs/:id/services/run             serve.run   (use_default_image=1 sets the image choice first)
 *   POST /runs/:id/services/stop            serve.stop
 *   POST /runs/:id/environment/stop         runs.stopContainer
 *   POST /runs/:id/image-choice             runs.setImageChoice
 *   POST /runs/:id/pull                     runs.pull   (confirm_discard=1 after a refusal)
 *   POST /runs/:id/remove                   runs.remove (confirm_discard=1 after a refusal)
 *   GET  /runs/:id/open/:service            "Open when it answers"
 *   GET  /runs/:id/action-runs/:actionId    the action dialog's poll
 *   POST /runs/:id/container/ensure, GET …/container/state   the shell's container start
 *
 * Every write goes through the RunActions port — i.e. the daemon's own
 * commit-run functions. Here: parse the form, call the port, and turn the
 * daemon's answer into a page, a redirect or the action dialog's JSON. The
 * daemon's structured refusals (a checkout somebody changed, an image that is
 * not ready) become a confirm-and-retry, in the dialog and without JS alike.
 *
 * Long actions (Run, Run services, Pull, Remove) run through the action
 * registry when the dialog asks (`x-lazy-action-dialog`), so a minutes-long
 * checkout or image build narrates its phases instead of hitting the web
 * request deadline. A plain POST (no JS) awaits the same call.
 */

import type { ProgressEmitter } from '../daemon/progress';
import { errorHtml } from './templates';
import { decodePathSegment } from './task-urls';
import { parseServeNotice } from './serve-notice';
import { displayUrlFor } from '../serve/subdomain';
import {
  actionRunJson,
  beginActionRun,
  getActionRun,
  wantsActionDialog,
  type ActionConfirm,
} from './action-run';
import { beginContainerStart, containerStartJson, getContainerStart } from './container-start';
import { dirtyItemsOf, runRefusalOf, type RunActions, type RunTarget } from './run-actions';
import { RUNS_INDEX_PATH, runActionKey, runPath } from './run-urls';
import { runPageHtml, runsIndexPageHtml, runWaitPageHtml, type RunFlash, type RunsIndexInput } from './runs-page';

function html(content: string, status = 200): Response {
  return new Response(content, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The status a daemon refusal carries, else 500. */
function statusOf(err: unknown): number {
  return runRefusalOf(err).status ?? 500;
}

async function readForm(req: Request): Promise<FormData | null> {
  try {
    return await req.formData();
  } catch {
    return null;
  }
}

function confirmed(form: FormData | null, name: string): boolean {
  return form?.get(name) === '1';
}

/**
 * The confirm-and-retry a refusal allows, or none. Only two refusals have
 * one: a checkout holding somebody's changes (confirm the discard), and the
 * project's image not being ready (run on lazy's default image instead) —
 * docs/design/run-any-commit.md, "Refusals a client acts on".
 */
function confirmFor(err: unknown, verb: 'run' | 'pull' | 'remove' | 'services', action: string): (ActionConfirm & { action: string }) | null {
  const refusal = runRefusalOf(err);
  const items = dirtyItemsOf(refusal);
  if (items) {
    const label = verb === 'pull' ? 'Discard them and pull' : verb === 'remove' ? 'Discard them and remove' : 'Discard them and run';
    return { items, label, fields: { confirm_discard: '1' }, action };
  }
  if (refusal.code === 'runner_image_not_ready' && verb === 'services') {
    return { items: [], label: "Use lazy's default image and run services", fields: { use_default_image: '1' }, action };
  }
  return null;
}

/** The flash a no-JS page shows for a refusal, with its confirm form when it has one. */
function refusalFlash(err: unknown, confirm: (ActionConfirm & { action: string }) | null, carried: Record<string, string> = {}): RunFlash {
  return {
    kind: 'error',
    message: messageOf(err),
    ...(confirm && confirm.items.length ? { items: confirm.items } : {}),
    ...(confirm ? { confirm: { label: confirm.label, action: confirm.action, fields: { ...carried, ...confirm.fields } } } : {}),
  };
}

/**
 * Start an action in the registry and answer the dialog: 202 with the run's
 * JSON plus `followBase`, the page the dialog polls under. A refusal the
 * human can confirm past carries its confirm-and-retry (./action-run.ts).
 */
function startDialogAction(
  key: string,
  followBase: string,
  operation: string,
  work: (onProgress: ProgressEmitter, actionId: string) => Promise<{ redirect: string; notes?: string[] }>,
  confirmOf?: (err: unknown) => ActionConfirm | undefined,
): Response {
  const state = beginActionRun({ taskId: key, operation, work, ...(confirmOf ? { confirmOf } : {}) });
  return json({ ...actionRunJson(state), followBase }, 202);
}

function unavailable(dialog: boolean): Response {
  const msg = 'Runs are not available: this dashboard was started without a daemon action port.';
  return dialog ? json({ error: msg }, 503) : html(errorHtml('Unavailable', msg), 503);
}

// --- /runs ---

async function renderIndex(
  actions: RunActions,
  url: URL,
  extra: { choice?: string; sha?: string; flash?: RunFlash | null } = {},
  status = 200,
): Promise<Response> {
  const refresh = url.searchParams.get('refresh') === '1';
  let branches: RunsIndexInput['branches'] = null;
  let branchesError: string | null = null;
  try {
    branches = await actions.listBranches({ refresh });
  } catch (err) {
    branchesError = messageOf(err);
    // A failed fetch still has a last-fetched list worth showing.
    if (refresh) branches = await actions.listBranches({ refresh: false }).catch(() => null);
  }
  const runs = await actions.listRuns();
  return html(runsIndexPageHtml({
    branches,
    branchesError,
    runs,
    showTaskBranches: url.searchParams.get('task_branches') === '1',
    choice: extra.choice ?? 'default',
    sha: extra.sha ?? '',
    flash: extra.flash ?? null,
  }), status);
}

/** The picker's choice as a target: `default` → none (the remote's default branch). */
function parseTarget(form: FormData): { ok: true; target: RunTarget | null; choice: string; sha: string } | { ok: false; error: string; choice: string; sha: string } {
  const choice = String(form.get('target') ?? 'default');
  const sha = String(form.get('sha') ?? '').trim();
  if (choice === 'default') return { ok: true, target: null, choice, sha };
  if (choice.startsWith('branch:') && choice.length > 'branch:'.length) {
    return { ok: true, target: { kind: 'branch', branch: choice.slice('branch:'.length) }, choice, sha };
  }
  if (choice === 'sha') {
    // Shape only — whether the commit exists on the remote is the daemon's
    // answer, and its refusal is what the page shows.
    if (!sha) return { ok: false, error: 'Type the commit id to run.', choice, sha };
    return { ok: true, target: { kind: 'sha', sha }, choice, sha };
  }
  return { ok: false, error: `Unknown choice: ${choice}`, choice, sha };
}

async function handleCreate(actions: RunActions, req: Request, url: URL): Promise<Response> {
  const dialog = wantsActionDialog(req);
  const form = await readForm(req);
  if (!form) {
    const msg = 'The form body could not be read. Submit it again.';
    return dialog ? json({ error: msg }, 400) : renderIndex(actions, url, { flash: { kind: 'error', message: msg } }, 400);
  }
  const parsed = parseTarget(form);
  if (!parsed.ok) {
    return dialog
      ? json({ error: parsed.error }, 400)
      : renderIndex(actions, url, { choice: parsed.choice, sha: parsed.sha, flash: { kind: 'error', message: parsed.error } }, 400);
  }
  const confirmDiscard = confirmed(form, 'confirm_discard');
  const run = async (onProgress?: ProgressEmitter) => {
    const result = await actions.createRun({ target: parsed.target, confirmDiscard }, onProgress);
    return { redirect: runPath(result.run.id) };
  };
  // What was picked rides every confirmation: a confirm that re-posted only
  // `confirm_discard=1` would parse as the DEFAULT branch and discard changes
  // in a checkout nobody was shown.
  const carried: Record<string, string> = { target: parsed.choice, sha: parsed.sha };
  if (dialog) {
    // No run id yet: the action is keyed on a per-request id, as Link's is.
    const pending = `new-${crypto.randomUUID()}`;
    return startDialogAction(runActionKey(pending), runPath(pending), 'run-create', (p) => run(p),
      (err) => {
        const confirm = confirmFor(err, 'run', RUNS_INDEX_PATH);
        return confirm ? { ...confirm, fields: { ...carried, ...confirm.fields } } : undefined;
      });
  }
  try {
    return seeOther((await run()).redirect);
  } catch (err) {
    return renderIndex(actions, url, {
      choice: parsed.choice,
      sha: parsed.sha,
      flash: refusalFlash(err, confirmFor(err, 'run', RUNS_INDEX_PATH), carried),
    }, statusOf(err));
  }
}

// --- /runs/:id ---

async function renderRun(
  actions: RunActions,
  runId: string,
  url: URL | null,
  flash: RunFlash | null = null,
  status = 200,
): Promise<Response> {
  let run;
  try {
    run = await actions.showRun(runId);
  } catch (err) {
    const s = statusOf(err);
    return html(errorHtml(s === 404 ? 'Run not found' : 'Error', messageOf(err)), s);
  }
  let serve = null;
  let serveError: string | null = null;
  try {
    serve = await actions.serveState(run.id);
  } catch (err) {
    serveError = messageOf(err);
  }
  const actionId = url?.searchParams.get('action');
  const action = actionId ? getActionRun(actionId) : null;
  return html(runPageHtml({
    run,
    serve,
    serveError,
    notice: url ? parseServeNotice(url) : null,
    // Only an action this run's page started — never another page's by id.
    lastAction: action && action.taskId === runActionKey(run.id) ? action : null,
    flash,
  }), status);
}

/** Run services; `use_default_image=1` first records the image choice the refusal offered. */
async function handleRunServices(actions: RunActions, req: Request, runId: string): Promise<Response> {
  const dialog = wantsActionDialog(req);
  const form = await readForm(req);
  const useDefault = confirmed(form, 'use_default_image');
  const base = runPath(runId);
  const work = async (onProgress?: ProgressEmitter) => {
    if (useDefault) await actions.setImageChoice(runId, 'default');
    await actions.runServices(runId, onProgress);
  };
  if (dialog) {
    return startDialogAction(runActionKey(runId), base, 'run-services', async (p, id) => {
      await work(p);
      return { redirect: `${base}?action=${encodeURIComponent(id)}` };
    }, (err) => confirmFor(err, 'services', `${base}/services/run`) ?? undefined);
  }
  try {
    await work();
    return seeOther(base);
  } catch (err) {
    return renderRun(actions, runId, null, refusalFlash(err, confirmFor(err, 'services', `${base}/services/run`)), statusOf(err));
  }
}

/** What a finished Pull says, beside its phases. */
function pullNotes(r: Awaited<ReturnType<RunActions['pullRun']>>): string[] {
  const notes: string[] = [];
  notes.push(r.moved ? `Moved ${r.from.slice(0, 12)} → ${r.to.slice(0, 12)}.` : `Already at the branch's newest commit, ${r.to.slice(0, 12)}.`);
  if (r.discarded.length) notes.push(`Discarded: ${r.discarded.join(', ')}`);
  if (r.discardedCommits.length) notes.push(`Commits left behind: ${r.discardedCommits.join('; ')}`);
  if (r.kept.length) notes.push(`Kept (new files the newer commit does not have): ${r.kept.join(', ')}`);
  if (r.servicesRestarted) notes.push('Services were running and were started again on the new commit.');
  if (r.servicesRestartError) notes.push(`Services were not restarted: ${r.servicesRestartError}`);
  return notes;
}

async function handlePull(actions: RunActions, req: Request, runId: string): Promise<Response> {
  const dialog = wantsActionDialog(req);
  const form = await readForm(req);
  const confirmDiscard = confirmed(form, 'confirm_discard');
  const base = runPath(runId);
  if (dialog) {
    return startDialogAction(runActionKey(runId), base, 'run-pull', async (p, id) => {
      const result = await actions.pullRun(runId, { confirmDiscard }, p);
      return { redirect: `${base}?action=${encodeURIComponent(id)}`, notes: pullNotes(result) };
    }, (err) => confirmFor(err, 'pull', `${base}/pull`) ?? undefined);
  }
  try {
    const result = await actions.pullRun(runId, { confirmDiscard });
    const [head, ...rest] = pullNotes(result);
    return renderRun(actions, runId, null, { kind: 'done', message: `Pull latest: ${head}`, items: rest });
  } catch (err) {
    return renderRun(actions, runId, null, refusalFlash(err, confirmFor(err, 'pull', `${base}/pull`)), statusOf(err));
  }
}

async function handleRemove(actions: RunActions, req: Request, runId: string): Promise<Response> {
  const dialog = wantsActionDialog(req);
  const form = await readForm(req);
  const confirmDiscard = confirmed(form, 'confirm_discard');
  const base = runPath(runId);
  if (dialog) {
    return startDialogAction(runActionKey(runId), base, 'run-remove', async () => {
      await actions.removeRun(runId, { confirmDiscard });
      return { redirect: RUNS_INDEX_PATH };
    }, (err) => confirmFor(err, 'remove', `${base}/remove`) ?? undefined);
  }
  try {
    await actions.removeRun(runId, { confirmDiscard });
    return seeOther(RUNS_INDEX_PATH);
  } catch (err) {
    return renderRun(actions, runId, null, refusalFlash(err, confirmFor(err, 'remove', `${base}/remove`)), statusOf(err));
  }
}

/** A quick write with no phases: do it, go back to the page, or say why not there. */
async function handleQuick(actions: RunActions, runId: string, act: () => Promise<unknown>): Promise<Response> {
  try {
    await act();
    return seeOther(runPath(runId));
  } catch (err) {
    return renderRun(actions, runId, null, { kind: 'error', message: messageOf(err) }, statusOf(err));
  }
}

/**
 * "Open when it answers". A service that answers is redirected to straight
 * away; otherwise the waiting page reloads until it does. Starts nothing.
 */
async function handleOpen(actions: RunActions, runId: string, service: string): Promise<Response> {
  let run;
  let serve;
  try {
    run = await actions.showRun(runId);
    serve = await actions.serveState(run.id);
  } catch (err) {
    return html(errorHtml('Run not found', messageOf(err)), statusOf(err));
  }
  // Declared is the list to look in: the probed list is empty while the
  // environment is down, which is exactly when this page has most to say.
  const declared = serve.declared.find((s) => s.name === service);
  if (!declared) {
    return html(errorHtml('Unknown service', `The project declares no service named "${service}".`), 404);
  }
  const live = serve.services.find((s) => s.name === service);
  if (live?.listening === true) {
    const target = displayUrlFor(live) ?? live.url;
    if (target) return new Response(null, { status: 302, headers: { Location: target } });
  }
  return html(runWaitPageHtml({
    run,
    service: declared.name,
    port: declared.port,
    phase: serve.servicesRun?.phase ?? (serve.servicesRun?.state === 'running' ? 'running' : serve.servicesRun?.state ?? null),
    startedAt: serve.servicesRun?.startedAt ?? null,
  }));
}

async function handleContainer(actions: RunActions, req: Request, runId: string, op: 'ensure' | 'state'): Promise<Response> {
  const want = op === 'ensure' ? 'POST' : 'GET';
  if (req.method !== want) return json({ error: 'Method not allowed' }, 405);
  let run;
  try {
    run = await actions.showRun(runId);
  } catch (err) {
    return json({ error: messageOf(err) }, statusOf(err));
  }
  const key = runActionKey(run.id);
  if (op === 'state') return json(containerStartJson(getContainerStart(key)));
  return json(containerStartJson(beginContainerStart(key, actions, run.id)));
}

const RUN_SUBROUTE = /^\/runs\/([^/]+)(?:\/(.+))?$/;

/** Every `/runs…` request. `actions` absent → 503: a Storage-only dashboard cannot run anything. */
export async function handleRunsRoute(actions: RunActions | undefined, req: Request, url: URL, path: string): Promise<Response> {
  const dialog = wantsActionDialog(req);
  if (path === RUNS_INDEX_PATH) {
    if (!actions) return unavailable(dialog);
    if (req.method === 'GET') return renderIndex(actions, url);
    if (req.method === 'POST') return handleCreate(actions, req, url);
    return json({ error: 'Method not allowed' }, 405);
  }
  const m = RUN_SUBROUTE.exec(path);
  if (!m) return html(errorHtml('Not Found', 'Page not found'), 404);
  const runId = decodePathSegment(m[1]!);
  const rest = m[2] ?? '';

  // The dialog's poll needs no port: it reads the in-process registry, and
  // only an action this run's page started.
  const poll = /^action-runs\/([^/]+)$/.exec(rest);
  if (poll) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const action = getActionRun(decodePathSegment(poll[1]!));
    if (!action || action.taskId !== runActionKey(runId)) return json({ error: 'Action run not found' }, 404);
    return json(actionRunJson(action));
  }

  if (!actions) return unavailable(dialog);

  if (rest === '') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return renderRun(actions, runId, url);
  }
  const open = /^open\/([^/]+)$/.exec(rest);
  if (open) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return handleOpen(actions, runId, decodePathSegment(open[1]!));
  }
  if (rest === 'container/ensure') return handleContainer(actions, req, runId, 'ensure');
  if (rest === 'container/state') return handleContainer(actions, req, runId, 'state');

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  switch (rest) {
    case 'services/run': return handleRunServices(actions, req, runId);
    case 'services/stop': return handleQuick(actions, runId, () => actions.stopServices(runId));
    case 'environment/stop': return handleQuick(actions, runId, () => actions.stopEnvironment(runId));
    case 'image-choice': {
      const form = await readForm(req);
      const choice = form?.get('choice');
      if (choice !== 'default' && choice !== 'project') {
        return html(errorHtml('Bad Request', `'choice' must be 'default' or 'project', not ${String(choice)}.`), 400);
      }
      return handleQuick(actions, runId, () => actions.setImageChoice(runId, choice));
    }
    case 'pull': return handlePull(actions, req, runId);
    case 'remove': return handleRemove(actions, req, runId);
  }
  return html(errorHtml('Not Found', 'Page not found'), 404);
}
