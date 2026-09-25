/**
 * Raised-item dialog on the Raised tab.
 *
 * Rows are real `/raised/:id` links. With JS, a click is intercepted into
 * `<dialog class="rv-dialog">` via `showModal()` — the same pattern as the
 * keyboard legend and the accept confirmation, so ESC closes without acting.
 * The body is fetched on open (`?fragment=1`), not inlined. `history.pushState`
 * makes the address bar read `/raised/:id`; Back closes the dialog.
 *
 * Intercepts only while the Raised tab is showing, so a permalink from Landing
 * is a real navigation to `/raised/:id` (which renders the Raised tab with the
 * dialog open). Task-code autolinks are `/tasks/:id` and are not intercepted.
 *
 * This script is page-level (not inside the tab-body fragment) so in-place tab
 * switches do not drop it; it live-queries the dialog node after each swap.
 */

/** Empty dialog chrome; body is filled on open (or pre-filled for a direct load). */
export function raisedDialogChromeHtml(options: {
  /** Pre-rendered panel when this page IS `/raised/:id`. */
  bodyHtml?: string;
  /** Direct load: native `open` so JS-off still sees the item. */
  open?: boolean;
}): string {
  const openAttr = options.open ? ' open' : '';
  const body = options.bodyHtml ?? '';
  return `<dialog class="rv-dialog lz-raised-dialog" id="lz-raised-dialog"${openAttr}>
    <form method="dialog" class="lz-raised-dialog-close">
      <button type="submit" class="rv-nav-btn" aria-label="Close">Close</button>
    </form>
    <div class="lz-raised-dialog-body" id="lz-raised-dialog-body">${body}</div>
  </dialog>`;
}

/**
 * Page-level island: intercept permalink clicks on the Raised tab, fetch the
 * panel, showModal, pushState. Direct-open pages call showModal on load.
 */
export function raisedDialogScript(): string {
  return `<script>
(function () {
  function dialogEl() { return document.getElementById('lz-raised-dialog'); }
  function bodyEl() { return document.getElementById('lz-raised-dialog-body'); }
  function page() { return document.querySelector('[data-lz-task-page]'); }
  function taskId() {
    var p = page();
    return p ? (p.getAttribute('data-lz-task-id') || '') : '';
  }
  function tabUrl() { return '/tasks/' + taskId() + '/raised'; }
  function onRaisedTab() {
    var p = page();
    return p && p.getAttribute('data-lz-current-tab') === 'raised';
  }
  function raisedIdFromPath(path) {
    var m = path.match(/^\\/raised\\/([^/]+)$/);
    return m ? m[1] : null;
  }

  var closingFromPop = false;

  function fillAndShow(html) {
    var dialog = dialogEl();
    var body = bodyEl();
    if (!dialog || !body || !dialog.showModal) return;
    body.innerHTML = html;
    if (!dialog.open) dialog.showModal();
    if (window.lzAnnotateProse) window.lzAnnotateProse();
  }

  function fetchPanel(id) {
    return fetch('/raised/' + encodeURIComponent(id) + '?fragment=1', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('not found')); });
  }

  function openRaised(id, push) {
    fetchPanel(id).then(function (html) {
      fillAndShow(html);
      if (push && location.pathname !== '/raised/' + id) {
        history.pushState({ lzRaised: id, lzRaisedPush: true }, '', '/raised/' + id);
      }
    }).catch(function () { location.href = '/raised/' + encodeURIComponent(id); });
  }

  document.addEventListener('click', function (e) {
    if (!onRaisedTab()) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.getAttribute('target') === '_blank') return;
    var href = a.getAttribute('href');
    if (!href) return;
    var path;
    try { path = new URL(href, location.origin).pathname; } catch (err) { return; }
    var id = raisedIdFromPath(path);
    if (!id) return;
    e.preventDefault();
    openRaised(id, true);
  });

  document.addEventListener('close', function (e) {
    if (e.target !== dialogEl()) return;
    if (closingFromPop) return;
    var id = raisedIdFromPath(location.pathname);
    if (!id) return;
    // replaceState, not back: the tab-switch island also listens to popstate
    // and would refetch the Raised tab out from under a history.back().
    history.replaceState({ lzRaised: null }, '', tabUrl());
  }, true);

  window.addEventListener('popstate', function (e) {
    var id = e.state && e.state.lzRaised;
    var dialog = dialogEl();
    if (id) {
      fetchPanel(id).then(fillAndShow).catch(function () {});
      return;
    }
    if (dialog && dialog.open) {
      closingFromPop = true;
      dialog.close();
      closingFromPop = false;
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('form.rv-raised-decide')) return;
    if (!dialogEl() || !dialogEl().contains(form)) return;
    var select = form.querySelector('select[name^="raised_action"]');
    var action = select ? select.value : '';
    if (action === 'promote_subtask' || action === 'promote_peer') return;
    e.preventDefault();
    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      credentials: 'same-origin',
      redirect: 'follow',
    }).then(function () {
      // Close first: the close handler replaceStates to the Raised tab URL.
      // Then refresh that tab in place so a web shell on this page survives.
      var dialog = dialogEl();
      if (dialog && dialog.open) dialog.close();
      if (window.lzSwitchTaskTab) window.lzSwitchTaskTab(tabUrl(), false);
      else location.assign(tabUrl());
    }).catch(function () { form.submit(); });
  });

  var dialog = dialogEl();
  // Native open attribute is in-flow (JS-off). Upgrade to a modal without
  // throwing InvalidStateError on an already-open dialog.
  if (dialog && dialog.showModal && (dialog.open || dialog.hasAttribute('open'))) {
    dialog.close();
    dialog.showModal();
    var current = raisedIdFromPath(location.pathname);
    if (current && !(history.state && history.state.lzRaised)) {
      history.replaceState({ lzRaised: current }, '', location.href);
    }
  }
})();
</script>`;
}
