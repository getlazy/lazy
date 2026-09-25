/**
 * Global command palette (Cmd/Ctrl+K) and command mode (Cmd/Ctrl+Shift+K).
 *
 * VS Code-shaped: one dialog for both modes. Plain query searches the project;
 * a leading `>` filters the static command list. Create-new-task opens a second
 * dialog over the current page so the engineer does not have to leave first.
 *
 * Emitted once from the shared layout so every dashboard page gets it — not
 * only pages that load the review/task navigation island.
 */

import { taskPath } from './task-urls';
import { scriptJson } from './escape';

/** One palette command. `href` navigates; `action: 'create-task'` opens the create dialog. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Extra words matched when filtering (not shown). */
  keywords?: string;
  href?: string;
  action?: 'create-task';
}

/**
 * Commands available under `>` mode.
 *
 * Keep this list short and navigation-heavy — the human named the destinations;
 * "etc." is a few adjacent pages, not a second CLI.
 */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  {
    id: 'create-task',
    label: 'Create new task',
    keywords: 'new add',
    action: 'create-task',
  },
  {
    id: 'dashboard',
    label: 'Navigate to dashboard',
    keywords: 'home',
    href: '/',
  },
  {
    id: 'clusters',
    label: 'Navigate to clusters',
    keywords: 'cluster loop driver subtasks',
    href: '/clusters',
  },
  {
    // The nav no longer carries a Search link — the box and this chord are the
    // two entry points, so the palette must be able to reach the full page or
    // the page becomes unreachable from the chrome.
    id: 'search',
    label: 'Navigate to full search',
    keywords: 'find query grammar syntax',
    href: '/search',
  },
  {
    id: 'tasks-active',
    label: 'Navigate to active tasks',
    keywords: 'list',
    href: '/tasks',
  },
  {
    id: 'tasks-all',
    label: 'Navigate to all tasks',
    keywords: 'every',
    href: '/tasks?filter=all',
  },
  {
    id: 'tasks-blocked',
    label: 'Navigate to blocked tasks',
    keywords: 'waiting review',
    href: '/tasks?filter=blocked',
  },
  {
    id: 'review',
    label: 'Navigate to review queue',
    keywords: 'reviews',
    href: '/review',
  },
  {
    id: 'inbox',
    label: 'Navigate to inbox',
    keywords: 'messages alerts',
    href: '/messages',
  },
  {
    id: 'raised-all',
    label: 'Navigate to all raised items',
    keywords: 'followups follow-ups',
    href: '/raised?all=1',
  },
  {
    id: 'raised-blocking',
    label: 'Navigate to blocking raised items',
    keywords: 'gate accept',
    href: '/raised?gate=blocking',
  },
  {
    id: 'conversations',
    label: 'Navigate to conversations',
    keywords: 'builder chat',
    href: '/conversations',
  },
  {
    id: 'settings',
    label: 'Navigate to settings',
    keywords: 'doctor memory',
    href: '/settings',
  },
];

/**
 * Destination URL for one search hit — same destinations the full `/search`
 * page should grow toward (conversations and memories are not task pages).
 *
 * Task links read the hit's task code, falling back to the id when the caller
 * hands in the duplicate set (from `/api/search`'s `duplicated_codes`) and the
 * code is shared by more than one task — a duplicated code would resolve to
 * the winner, a different task.
 */
export function searchResultHref(
  r: {
    entity_type: string;
    entity_id: string;
    task_id: string;
    task_code?: string | null;
    turn_sequence?: number;
  },
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const ref = { id: r.task_id, code: r.task_code ?? null };
  switch (r.entity_type) {
    case 'turn':
      if (r.turn_sequence !== undefined) {
        return `${taskPath(ref, duplicatedCodes)}/turns/${r.turn_sequence}`;
      }
      return taskPath(ref, duplicatedCodes);
    case 'conversation':
      return `/conversations/${encodeURIComponent(r.entity_id)}`;
    case 'memory':
      return `/memory/${encodeURIComponent(r.entity_id)}`;
    case 'raised':
      return `/raised/${encodeURIComponent(r.entity_id)}`;
    case 'scratch':
      return `/scratch/file?path=${encodeURIComponent(r.entity_id)}`;
    default:
      return taskPath(ref, duplicatedCodes);
  }
}

/** Empty palette + create-task dialog chrome. Bodies fill on open. */
export function commandPaletteChromeHtml(): string {
  return `<dialog class="rv-dialog lz-palette" id="lz-palette" aria-label="Command palette">
    <form method="dialog" class="lz-palette-close">
      <button type="submit" class="rv-nav-btn" aria-label="Close">Close</button>
    </form>
    <div class="lz-palette-body">
      <input class="input lz-palette-input" id="lz-palette-input" type="text"
        placeholder="Search…  or type &gt; for commands"
        autocomplete="off" spellcheck="false" role="combobox"
        aria-autocomplete="list" aria-controls="lz-palette-results" aria-expanded="true" />
      <div class="lz-palette-hint" id="lz-palette-hint"></div>
      <ul class="lz-palette-results" id="lz-palette-results" role="listbox"></ul>
    </div>
  </dialog>
  <dialog class="rv-dialog lz-create-dialog" id="lz-create-dialog" aria-label="Create new task">
    <form method="dialog" class="lz-create-dialog-close">
      <button type="submit" class="rv-nav-btn" aria-label="Close">Close</button>
    </form>
    <div class="lz-create-dialog-body" id="lz-create-dialog-body"></div>
  </dialog>`;
}

/**
 * Global island: Cmd/Ctrl+K opens search mode; Cmd/Ctrl+Shift+K opens command
 * mode (query prefilled with `>`). Typing `>` at the start of the query also
 * switches to commands. Create-new-task fetches `/tasks/new?fragment=1`.
 */
export function commandPaletteScript(): string {
  // Commands are serialised once so the island does not hardcode hrefs twice.
  const commandsJson = scriptJson(PALETTE_COMMANDS);
  return `<script>
(function () {
  var COMMANDS = ${commandsJson};
  var palette = document.getElementById('lz-palette');
  var input = document.getElementById('lz-palette-input');
  var resultsEl = document.getElementById('lz-palette-results');
  var hintEl = document.getElementById('lz-palette-hint');
  var createDialog = document.getElementById('lz-create-dialog');
  var createBody = document.getElementById('lz-create-dialog-body');
  if (!palette || !input || !resultsEl || !palette.showModal) return;

  var selected = 0;
  var items = [];
  var searchTimer = null;
  var searchSeq = 0;

  function isMod(ev) { return ev.metaKey || ev.ctrlKey; }

  function openPalette(commandMode) {
    if (createDialog && createDialog.open) createDialog.close();
    input.value = commandMode ? '>' : '';
    selected = 0;
    render();
    if (!palette.open) palette.showModal();
    // showModal focuses the dialog; put the caret in the input after that.
    setTimeout(function () {
      input.focus();
      if (commandMode) {
        try { input.setSelectionRange(1, 1); } catch (e) { /* ignore */ }
      }
    }, 0);
  }

  function closePalette() {
    if (palette.open) palette.close();
  }

  function commandQuery(raw) {
    if (raw.charAt(0) !== '>') return null;
    return raw.slice(1).trim().toLowerCase();
  }

  function filterCommands(q) {
    if (!q) return COMMANDS.slice();
    return COMMANDS.filter(function (c) {
      var hay = (c.label + ' ' + (c.keywords || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // Codes shared by more than one task, from the latest search response's
  // duplicated_codes: those links fall back to the id, like every other
  // surface, so they cannot land on the wrong task.
  var dupCodes = null;

  function searchHref(r) {
    var code = r.task_code;
    var seg = code && (!dupCodes || dupCodes.indexOf(code) === -1) ? code : r.task_id;
    if (r.entity_type === 'turn' && r.turn_sequence !== undefined) {
      return '/tasks/' + encodeURIComponent(seg) + '/turns/' + r.turn_sequence;
    }
    if (r.entity_type === 'conversation') {
      return '/conversations/' + encodeURIComponent(r.entity_id);
    }
    if (r.entity_type === 'memory') {
      return '/memory/' + encodeURIComponent(r.entity_id);
    }
    if (r.entity_type === 'raised') {
      return '/raised/' + encodeURIComponent(r.entity_id);
    }
    if (r.entity_type === 'scratch') {
      return '/scratch/file?path=' + encodeURIComponent(r.entity_id);
    }
    return '/tasks/' + encodeURIComponent(seg);
  }

  function setHint(text) {
    if (hintEl) hintEl.textContent = text || '';
  }

  function renderList() {
    resultsEl.innerHTML = '';
    if (items.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'lz-palette-empty';
      empty.textContent = commandQuery(input.value) !== null
        ? 'No matching commands'
        : (input.value.trim() ? 'No results' : 'Type to search, or > for commands');
      resultsEl.appendChild(empty);
      return;
    }
    if (selected < 0) selected = 0;
    if (selected >= items.length) selected = items.length - 1;
    items.forEach(function (item, i) {
      var li = document.createElement('li');
      li.className = 'lz-palette-item' + (i === selected ? ' lz-palette-item-active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      li.dataset.index = String(i);

      var primary = document.createElement('div');
      primary.className = 'lz-palette-item-primary';
      primary.textContent = item.label;

      var secondary = document.createElement('div');
      secondary.className = 'lz-palette-item-secondary';
      secondary.textContent = item.secondary || '';

      li.appendChild(primary);
      if (item.secondary) li.appendChild(secondary);
      li.addEventListener('mousedown', function (ev) {
        // mousedown so we run before the input blurs and loses selection.
        ev.preventDefault();
        selected = i;
        activateSelected();
      });
      resultsEl.appendChild(li);
    });
    var active = resultsEl.querySelector('.lz-palette-item-active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderCommands() {
    var q = commandQuery(input.value);
    setHint('Commands');
    items = filterCommands(q || '').map(function (c) {
      return {
        kind: 'command',
        label: c.label,
        secondary: c.href || 'Open dialog',
        command: c,
      };
    });
    renderList();
  }

  function renderSearchResults(results) {
    setHint(results.length ? (results.length + ' result' + (results.length === 1 ? '' : 's')) : 'No results');
    items = results.map(function (r) {
      var id = r.task_code || (r.task_id ? String(r.task_id).slice(0, 8) : '');
      var type = r.entity_type || 'result';
      if (r.entity_type === 'turn' && r.turn_sequence !== undefined) {
        type = 'turn #' + r.turn_sequence;
      }
      return {
        kind: 'search',
        label: type + ' — ' + id + (r.task_goal ? ' — ' + r.task_goal : ''),
        secondary: r.match_context || '',
        href: searchHref(r),
      };
    });
    // Last item, always: the palette shows a capped, flat list, so the full
    // page (filters, paging, the query-syntax panel) must be one Enter away.
    // With the Search link gone from the nav this is also how most people will
    // get there at all.
    var q = input.value.trim();
    if (q) {
      items.push({
        kind: 'search',
        label: 'Search everything for "' + q + '"',
        secondary: 'Open the full search page',
        href: '/search?q=' + encodeURIComponent(q),
      });
    }
    renderList();
  }

  function runSearch(q) {
    var seq = ++searchSeq;
    setHint('Searching…');
    fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) {
          throw new Error((d && d.error) || ('HTTP ' + r.status));
        });
        return r.json();
      })
      .then(function (d) {
        if (seq !== searchSeq) return;
        dupCodes = (d && d.duplicated_codes) || [];
        renderSearchResults((d && d.results) || []);
      })
      .catch(function (err) {
        if (seq !== searchSeq) return;
        setHint(err && err.message ? err.message : 'Search failed');
        items = [];
        renderList();
      });
  }

  function render() {
    var raw = input.value;
    if (commandQuery(raw) !== null) {
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      renderCommands();
      return;
    }
    var q = raw.trim();
    if (!q) {
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      setHint('Search tasks, turns, commits, conversations…');
      items = [];
      renderList();
      return;
    }
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { runSearch(q); }, 180);
  }

  function openCreateDialog() {
    closePalette();
    if (!createDialog || !createBody || !createDialog.showModal) {
      location.href = '/tasks/new';
      return;
    }
    createBody.innerHTML = '<p class="text-muted" style="padding:16px">Loading…</p>';
    createDialog.showModal();
    fetch('/tasks/new?fragment=1', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('Could not load the create form');
        return r.text();
      })
      .then(function (html) {
        createBody.innerHTML = html;
        var first = createBody.querySelector('#create-goal, input, textarea');
        if (first && first.focus) first.focus();
      })
      .catch(function () {
        createDialog.close();
        location.href = '/tasks/new';
      });
  }

  function activateSelected() {
    var item = items[selected];
    if (!item) return;
    if (item.kind === 'command' && item.command) {
      if (item.command.action === 'create-task') {
        openCreateDialog();
        return;
      }
      if (item.command.href) {
        if (window.lzNavProgress) window.lzNavProgress.start(null);
        location.assign(item.command.href);
        return;
      }
    }
    if (item.kind === 'search' && item.href) {
      if (window.lzNavProgress) window.lzNavProgress.start(null);
      location.assign(item.href);
    }
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.defaultPrevented) return;
    if (!isMod(ev)) return;
    if (String(ev.key).toLowerCase() !== 'k') return;
    // Claim the chord even when focus is in an input — that is the point of a
    // global palette. Skip the terminal so we do not steal Cmd+K from a shell.
    if (ev.target && ev.target.closest && ev.target.closest('.xterm')) return;
    ev.preventDefault();
    ev.stopPropagation();
    openPalette(!!ev.shiftKey);
  }, true);

  input.addEventListener('input', function () {
    selected = 0;
    render();
  });

  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (items.length) { selected = (selected + 1) % items.length; renderList(); }
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (items.length) { selected = (selected - 1 + items.length) % items.length; renderList(); }
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      activateSelected();
      return;
    }
    if (ev.key === 'Escape') {
      // Native dialog also closes on Escape; this just keeps focus tidy.
      closePalette();
    }
  });

  if (createDialog) {
    createDialog.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('data-lz-create-cancel') !== null) {
        ev.preventDefault();
        createDialog.close();
      }
    });
  }

  // Expose for tests / future nav affordances.
  window.lzOpenCommandPalette = openPalette;
})();
</script>`;
}
