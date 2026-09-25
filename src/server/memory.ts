/**
 * Shared memory — the web half of `lazy memory`.
 *
 * The daemon web UI's memory pages; Lazy Teams serves the same surface at
 * project scope (`MemoriesController`): list, read, create, update, delete,
 * and compact. Reads go through Storage; writes go
 * through `MemoryActions` (./memory-actions.ts), which the daemon implements.
 *
 * ONE VOCABULARY: every derived value on these pages comes from the modules
 * the CLI already reads — `elideMemoryDescription` / `recordsNewerThanCompact` /
 * `namesRemovedSinceCompact` (src/memory/) for the index and the compact
 * coverage, and src/memory/context-status.ts for the size-vs-threshold numbers
 * and their sentences (the same answer the `memoryStatus` RPC gives Teams). Nothing here re-derives a byte count or a
 * staleness rule, so `lazy memory list`, `lazy memory compact --show`, doctor,
 * Teams and this page cannot disagree about the same store.
 *
 * Compact POST streams HTML: the first bytes announce what is about to happen
 * BEFORE the model call, matching `lazy memory compact`. Returning a streaming
 * Response immediately also means the web-request deadline (which exists to
 * bound storage-proportional GETs) cannot kill a minutes-long LLM oneshot, and
 * the streamed chunks reset Bun.serve's idle timer.
 */

import type { MemoryRecord, MemoryEvent, MemoryCompact, MemoryType } from '../types';
import { VALID_MEMORY_TYPES } from '../types';
import {
  elideMemoryDescription,
  recordsNewerThanCompact,
  namesRemovedSinceCompact,
  isLiveMemory,
  MAX_MEMORY_DESCRIPTION_LENGTH,
} from '../memory';
import type { CompactMode, CompactProgressEvent, MemoryCompactRunResult } from '../memory/run-compact';
import {
  memoryContextStatus,
  memoryStatusPayload,
  compactRunSizeLine,
  formatMemoryDate,
  INDEX_DESCRIPTION_WIDTH,
} from '../memory/context-status';
import { layoutHtml, layoutOpenHtml, layoutCloseHtml } from './templates';
import { settingsPageHtml } from './settings';
import { escapeHtml } from './review-diff';
import { renderMarkdown } from './markdown';

const INTRO =
  'What Lazy remembers about how this team works. Agents see a one-line summary ' +
  'of each record when they start; open a record to read the full note and its ' +
  'write history.';

const TYPE_TONES: Record<string, string> = {
  user: 'tag-accent',
  feedback: 'tag-warning',
  project: 'tag-success',
  reference: 'tag-indigo',
};

const formatDate = formatMemoryDate;

/**
 * Who wrote something: the person when the write named one (name, else
 * address), otherwise the role it came through — which is all older rows and
 * unattributed installs carry.
 */
function byline(role: string, name?: string, email?: string): string {
  return name || email || role;
}

function typeBadge(type: string): string {
  const tone = TYPE_TONES[type] ?? 'tag-neutral';
  return `<span class="tag ${tone}">${escapeHtml(type)}</span>`;
}

function noticeHtml(notice?: { text: string; error?: boolean }): string {
  if (!notice) return '';
  return `<div class="msg-notice${notice.error ? ' msg-notice-error' : ''}" id="memory-notice">${escapeHtml(notice.text)}</div>`;
}

function recordHref(name: string): string {
  return `/memory/${encodeURIComponent(name)}`;
}

export { memoryContextStatus };

function compactBannerHtml(
  records: MemoryRecord[],
  compact: MemoryCompact | null,
  warnBytes: number,
): string {
  const status = memoryStatusPayload(records, compact, warnBytes);
  if (status.bannerText === null) return '';
  const over = status.overThreshold
    ? ' <span class="tag tag-warning">over threshold</span>'
    : '';
  return `<p class="text-muted mem-compact-banner" id="memory-compact-banner">
    ${escapeHtml(status.bannerText)}${over}
    <a href="/memory/compact">View compact</a>
  </p>`;
}

export function memoryIndexHtml(
  records: MemoryRecord[],
  compact: MemoryCompact | null,
  warnBytes: number,
  options: { allView: boolean; notice?: { text: string; error?: boolean } } = { allView: false },
): string {
  const { allView, notice } = options;
  const filterBar = `<div class="filter-bar mem-toolbar">
    <a href="/settings/memory" class="btn btn-sm${allView ? '' : ' active'}">Live</a>
    <a href="/settings/memory?all=1" class="btn btn-sm${allView ? ' active' : ''}">All (incl. removed)</a>
    <a href="/memory/new" class="btn btn-sm btn-primary">New record</a>
    <a href="/memory/compact" class="btn btn-sm">Compact</a>
  </div>`;

  const live = records.filter(isLiveMemory);
  const empty = records.length === 0;

  let body: string;
  if (empty) {
    body = `<div class="empty-state" id="memory-empty">No memory records yet. Curated notes about this team appear here once someone saves them.</div>`;
  } else {
    const rows = records.map((r) => {
      const deleted = !isLiveMemory(r);
      const nameCell = deleted
        ? `<span class="mem-deleted">${escapeHtml(r.name)} (removed)</span>`
        : `<a href="${escapeHtml(recordHref(r.name))}">${escapeHtml(r.name)}</a>`;
      return `<tr class="mem-row${deleted ? ' mem-row-deleted' : ''}">
        <td class="mem-name">${nameCell}</td>
        <td>${typeBadge(r.type)}</td>
        <td class="mem-updated">${escapeHtml(formatDate(r.updated_at))}</td>
        <td class="wrap mem-desc">${escapeHtml(elideMemoryDescription(r.description, INDEX_DESCRIPTION_WIDTH))}</td>
      </tr>`;
    }).join('\n');
    body = `<p class="text-muted" id="memory-summary">${records.length} record${records.length === 1 ? '' : 's'}${allView ? '' : ` (${live.length} live)`}.</p>
      <table class="table mem-table" id="memory-index">
        <thead><tr><th>Name</th><th>Type</th><th>Updated</th><th>Description</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  return settingsPageHtml('Settings — Memories', 'memory', `
    <p class="text-muted mem-intro" id="memory-intro">${INTRO}</p>
    ${filterBar}
    ${noticeHtml(notice)}
    ${compactBannerHtml(records, compact, warnBytes)}
    ${body}
  `);
}

function historyListHtml(events: MemoryEvent[]): string {
  if (events.length === 0) {
    return `<div class="empty-state">No history yet. Writes to this record will appear here in order.</div>`;
  }
  const items = events.map((e) => {
    const meta = [`rev ${e.revision}`, `by ${byline(e.actor, e.actor_name, e.actor_email)}`, formatDate(e.timestamp)];
    if (e.description) meta.push(e.description);
    return `<li class="mem-history-item">
      <strong>${escapeHtml(e.action)}</strong>
      <span class="text-muted"> · ${escapeHtml(meta.join(' · '))}</span>
    </li>`;
  }).join('\n');
  return `<ol class="mem-history" id="memory-history">${items}</ol>`;
}

export function memoryShowHtml(
  record: MemoryRecord,
  events: MemoryEvent[],
  notice?: { text: string; error?: boolean },
): string {
  const name = escapeHtml(record.name);
  return layoutHtml(record.name, `
    <div class="breadcrumb"><a href="/settings/memory">Memories</a> &rsaquo; ${name}</div>
    <h1>${name} ${typeBadge(record.type)}</h1>
    ${noticeHtml(notice)}
    <dl class="mem-meta" id="memory-meta">
      <div><dt>Summary</dt><dd>${escapeHtml(record.description)}</dd></div>
      <div><dt>Type</dt><dd>${escapeHtml(record.type)}</dd></div>
      <div><dt>Revision</dt><dd>${record.revision}</dd></div>
      <div><dt>Last updated</dt><dd>${escapeHtml(formatDate(record.updated_at))} by ${escapeHtml(byline(record.updated_by, record.updated_by_name, record.updated_by_email))}</dd></div>
      <div><dt>Created</dt><dd>${escapeHtml(formatDate(record.created_at))} by ${escapeHtml(byline(record.created_by, record.created_by_name, record.created_by_email))}</dd></div>
    </dl>
    <h2>Body</h2>
    <div class="panel mem-body" id="memory-body"><div class="mem-prose">${renderMarkdown(record.body)}</div></div>
    <h2>Write history</h2>
    ${historyListHtml(events)}
    <h2>Edit</h2>
    ${memoryFormHtml({
      action: recordHref(record.name),
      name: record.name,
      nameLocked: true,
      type: record.type,
      description: record.description,
      body: record.body,
      submit: 'Save changes',
    })}
    <p class="mem-remove-link"><a href="${escapeHtml(recordHref(record.name))}/remove">Remove this record</a> — the write history is kept.</p>
  `);
}

export function memoryRemoveConfirmHtml(record: MemoryRecord): string {
  return layoutHtml(`Remove ${record.name}`, `
    <div class="breadcrumb"><a href="/settings/memory">Memories</a> &rsaquo; <a href="${escapeHtml(recordHref(record.name))}">${escapeHtml(record.name)}</a> &rsaquo; Remove</div>
    <h1>Remove ${escapeHtml(record.name)}?</h1>
    <p>This tombstones the record. It leaves the live index and is no longer injected, but its write history is preserved.</p>
    <p class="text-muted">${typeBadge(record.type)} ${escapeHtml(record.description)}</p>
    <form method="post" action="${escapeHtml(recordHref(record.name))}/remove" class="mem-form">
      <button class="btn btn-primary" type="submit">Remove record</button>
      <a class="btn" href="${escapeHtml(recordHref(record.name))}">Cancel</a>
    </form>
  `);
}

export interface MemoryFormState {
  action: string;
  name: string;
  nameLocked?: boolean;
  type: string;
  description: string;
  body: string;
  submit: string;
  error?: string;
}

export function memoryFormHtml(state: MemoryFormState): string {
  const types = VALID_MEMORY_TYPES.map((t: MemoryType) =>
    `<option value="${escapeHtml(t)}"${t === state.type ? ' selected' : ''}>${escapeHtml(t)}</option>`,
  ).join('');
  const nameField = state.nameLocked
    ? `<input class="input" type="text" name="name" value="${escapeHtml(state.name)}" readonly>`
    : `<input class="input" type="text" name="name" value="${escapeHtml(state.name)}" required
              maxlength="64" placeholder="vm-credentials-idea" aria-label="Record name">`;
  return `<form class="mem-form" method="post" action="${escapeHtml(state.action)}">
    ${state.error ? noticeHtml({ text: state.error, error: true }) : ''}
    <div class="field">
      <label>Name</label>
      ${nameField}
      <p class="hint">Normalized to a kebab-case slug. Updating an existing name overwrites that record.</p>
    </div>
    <div class="field">
      <label>Type</label>
      <select class="input" name="type" required>${types}</select>
    </div>
    <div class="field">
      <label>Description</label>
      <input class="input" type="text" name="description" value="${escapeHtml(state.description)}" required
             maxlength="${MAX_MEMORY_DESCRIPTION_LENGTH}"
             placeholder="One line — this is what the injected index shows">
      <p class="hint">At most ${MAX_MEMORY_DESCRIPTION_LENGTH} characters. Injected into every builder and agent launch.</p>
    </div>
    <div class="field">
      <label>Body</label>
      <textarea class="input" name="body" rows="12" required placeholder="The actual knowledge, in markdown.">${escapeHtml(state.body)}</textarea>
    </div>
    <button class="btn btn-primary" type="submit">${escapeHtml(state.submit)}</button>
    <a class="btn" href="${state.nameLocked ? escapeHtml(recordHref(state.name)) : '/settings/memory'}">Cancel</a>
  </form>`;
}

export function memoryNewHtml(state?: Partial<MemoryFormState>): string {
  return layoutHtml('New memory record', `
    <div class="breadcrumb"><a href="/settings/memory">Memories</a> &rsaquo; New</div>
    <h1>New memory record</h1>
    <p class="text-muted">Humans and the builder write these; task agents are read-only. A one-line description is injected into every launch.</p>
    ${memoryFormHtml({
      action: '/memory',
      name: state?.name ?? '',
      type: state?.type ?? 'project',
      description: state?.description ?? '',
      body: state?.body ?? '',
      submit: 'Save record',
      error: state?.error,
    })}
  `);
}

function coverageHtml(
  records: MemoryRecord[],
  compact: MemoryCompact,
): string {
  const newer = recordsNewerThanCompact(records, compact);
  const removed = namesRemovedSinceCompact(records, compact);
  const newerBlock = newer.length > 0
    ? `<p>Also injected — ${newer.length} record(s) written or updated since this compact (their live index line supersedes the summary):</p>
       <ul>${newer.map((r) => `<li><a href="${escapeHtml(recordHref(r.name))}"><code>${escapeHtml(r.name)}</code></a> (${escapeHtml(r.type)}) — ${escapeHtml(elideMemoryDescription(r.description, INDEX_DESCRIPTION_WIDTH))}</li>`).join('')}</ul>
       <p class="hint">Fold them in by running compact again.</p>`
    : `<p>Every live record is covered at its current revision — nothing is injected outside this summary.</p>`;
  const removedBlock = removed.length > 0
    ? `<p>Removed since this compact (injection flags them as gone): ${removed.map((n) => `<code>${escapeHtml(n)}</code>`).join(', ')}</p>`
    : '';
  return `<div class="mem-coverage" id="memory-coverage">${newerBlock}${removedBlock}</div>`;
}

export function memoryCompactHtml(
  records: MemoryRecord[],
  compact: MemoryCompact | null,
  warnBytes: number,
  options: {
    notice?: { text: string; error?: boolean };
    result?: MemoryCompactRunResult;
  } = {},
): string {
  const status = memoryStatusPayload(records, compact, warnBytes);
  const sizeLine = status.sizeLine;

  let artifact: string;
  if (!compact) {
    artifact = `<div class="empty-state" id="memory-compact-empty">No memory compact yet — the full index of ${status.liveCount} record(s) is injected as-is.</div>`;
  } else {
    artifact = `<p class="text-muted" id="memory-compact-meta">${escapeHtml(status.compactSummary)} by ${escapeHtml(byline(compact.generated_by, compact.generated_by_name, compact.generated_by_email))}${compact.model ? ` · ${escapeHtml(compact.model)}` : ''}.</p>
      <p class="text-muted">${escapeHtml(sizeLine)}${status.overThreshold ? ' <span class="tag tag-warning">over threshold</span>' : ''}</p>
      <div class="panel mem-compact-body" id="memory-compact-body"><div class="mem-prose">${renderMarkdown(compact.content)}</div></div>
      ${coverageHtml(records, compact)}`;
  }

  const resultBanner = options.result
    ? noticeHtml({
        text: options.result.message + (options.result.notes.length ? ` ${options.result.notes.join(' ')}` : ''),
        error: options.result.rejected,
      })
    : noticeHtml(options.notice);

  return layoutHtml('Memory compact', `
    <div class="breadcrumb"><a href="/settings/memory">Memories</a> &rsaquo; Compact</div>
    <h1>Memory compact</h1>
    <p class="text-muted mem-intro">A derived summary of the live records, injected instead of the full one-line index. Records are never modified; every run regenerates from them (never from the previous compact). Anything written since is injected as its live index line.</p>
    ${resultBanner}
    ${artifact}
    <h2>Regenerate</h2>
    ${compactRunFormHtml()}
    ${compact
      ? `<form method="post" action="/memory/compact/clear" class="mem-form mem-clear">
           <button class="btn" type="submit">Clear compact</button>
           <span class="hint">Injection falls back to the full index. Always safe — the compact is derived state.</span>
         </form>`
      : ''}
  `);
}

function compactRunFormHtml(mode: CompactMode = 'auto', model = ''): string {
  const modes: { value: CompactMode; label: string; hint: string }[] = [
    { value: 'auto', label: 'Auto', hint: 'LLM, falling back to mechanical' },
    { value: 'mechanical', label: 'Mechanical', hint: 'code-only; no model needed' },
    { value: 'llm', label: 'LLM', hint: 'require the model path; fail if unavailable' },
  ];
  const radios = modes.map((m) =>
    `<label class="mem-mode"><input type="radio" name="mode" value="${m.value}"${m.value === mode ? ' checked' : ''}> ${escapeHtml(m.label)} <span class="hint">${escapeHtml(m.hint)}</span></label>`,
  ).join('\n');
  return `<form class="mem-form" method="post" action="/memory/compact">
    <fieldset class="mem-modes">
      <legend>Mode</legend>
      ${radios}
    </fieldset>
    <div class="field">
      <label>Model (optional)</label>
      <input class="input" type="text" name="model" value="${escapeHtml(model)}" placeholder="Claude CLI default">
    </div>
    <button class="btn btn-primary" type="submit">Run compact</button>
    <p class="hint">The LLM path usually takes a few seconds. This page will show progress as it runs.</p>
  </form>`;
}

/** First bytes of a streaming compact POST — painted before the model call. */
export function memoryCompactStreamOpenHtml(): string {
  return layoutOpenHtml('Compacting memory') + `
    <div class="breadcrumb"><a href="/settings/memory">Memories</a> &rsaquo; <a href="/memory/compact">Compact</a> &rsaquo; Running</div>
    <h1>Compacting memory</h1>
    <p class="text-muted">Records are never modified. A candidate that would grow the injected context is not saved.</p>
    <div class="mem-progress-log" id="memory-compact-progress">`;
}

export function memoryCompactProgressLineHtml(event: CompactProgressEvent): string {
  const cls = `mem-progress mem-progress-${event.state}`;
  const detail = event.detail ? ` — ${escapeHtml(event.detail)}` : '';
  const verb = event.state === 'start' ? '…' : event.state === 'done' ? ' — done' : event.state === 'skipped' ? ' — skipped' : event.state === 'failed' ? ' — failed' : '';
  return `<p class="${cls}">${escapeHtml(event.label)}${verb}${detail}</p>`;
}

export function memoryCompactStreamResultHtml(
  records: MemoryRecord[],
  compact: MemoryCompact | null,
  _warnBytes: number,
  result: MemoryCompactRunResult,
): string {
  const size = compactRunSizeLine(result);
  const notes = result.notes.map((n) => `<p class="hint">${escapeHtml(n)}</p>`).join('');
  const body = compact
    ? `<div class="panel mem-compact-body"><div class="mem-prose">${renderMarkdown(compact.content)}</div></div>
       ${coverageHtml(records, compact)}`
    : '';
  return `</div>
    <div class="msg-notice${result.rejected ? ' msg-notice-error' : ''}" id="memory-compact-result">
      ${escapeHtml(result.message)} ${escapeHtml(size)}.
    </div>
    ${notes}
    ${body}
    <p><a class="btn btn-primary" href="/memory/compact">View compact</a> <a class="btn" href="/settings/memory">Back to records</a></p>
    ${layoutCloseHtml()}`;
}

export function memoryCompactStreamErrorHtml(message: string): string {
  return `</div>
    <div class="msg-notice msg-notice-error" id="memory-compact-error">${escapeHtml(message)}</div>
    <p><a class="btn" href="/memory/compact">Back to compact</a></p>
    ${layoutCloseHtml()}`;
}

/** The listing as JSON: index fields only, never bodies. */
export function memoryApiPayload(records: MemoryRecord[]) {
  return {
    total: records.length,
    records: records.map((r) => ({
      name: r.name,
      type: r.type,
      description: r.description,
      revision: r.revision,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
      deleted: !isLiveMemory(r),
    })),
  };
}

/** Pull a form field as a string; missing/non-string becomes ''. */
export function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
