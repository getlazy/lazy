/**
 * `window.lzEnsureContainer(taskId, onProgress)` — the client half of "the
 * container is an implementation detail".
 *
 * Watch, Shell, Pair and Chat all want the same thing before they can connect:
 * this task's container, running. Rather than each panel checking, reporting
 * "container not running", and offering its own Start button — which is what put
 * several of them on one page — each panel calls this and narrates what comes
 * back into its own status line.
 *
 * It POSTs `/tasks/:id/container/ensure` (begin-or-join, so two panels opened
 * together attach to one launch) and then polls `/tasks/:id/container/state`
 * until the start settles. Polling rather than a socket because the honest
 * duration ranges from "already running" to a whole image build: a poll costs
 * one small JSON response every second and survives a daemon restart in the
 * middle, where a socket would just drop.
 *
 * One in-flight promise per task in this document as well, so Watch and Shell
 * opened in the same second share the narration and not just the launch.
 *
 * Resolves `{ ok: true }` or `{ ok: false, error }` — it never rejects. A panel
 * gets one thing to branch on, and the failure text is the daemon's own, written
 * for a human to read next to the retry button.
 */
export function containerEnsureClientScript(): string {
  return `<script>
(() => {
  if (window.lzEnsureContainer) return;

  const inflight = new Map();

  // taskId is the URL-ESCAPED segment the panels hand in — interpolate raw; a
  // second escape turns %20 into %2520, a different address.
  function poll(taskId) {
    return fetch('/tasks/' + taskId + '/container/state', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null));
  }

  async function ensure(taskId, onProgress) {
    const say = typeof onProgress === 'function' ? onProgress : function () {};
    say('Starting the container…');
    let res;
    try {
      res = await fetch('/tasks/' + taskId + '/container/ensure', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch (e) {
      return { ok: false, error: 'Could not reach the daemon to start the container.' };
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* refusals always carry JSON; a body-less one falls through */ }
    if (!res.ok) {
      return { ok: false, error: (body && body.error) || ('Starting the container failed (HTTP ' + res.status + ').') };
    }
    // A 200 that is not our JSON means the dashboard gate answered instead —
    // a signed-out session is served the sign-in page, and fetch follows the
    // redirect. Say so rather than polling a state endpoint that will never
    // answer either.
    if (!body || typeof body.phase !== 'string') {
      return { ok: false, error: 'The dashboard session has expired — reload the page and sign in again.' };
    }
    if (body && body.detail) say(body.detail);
    if (body && body.phase === 'done') return { ok: true };
    if (body && body.phase === 'failed') return { ok: false, error: body.error || 'Starting the container failed.' };

    // Poll until it settles. No deadline here on purpose: an image build is
    // allowed to take as long as it takes, and the panel is showing the launch's
    // own narration the whole time, so a human can see it is not stuck.
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      let state = null;
      try { state = await poll(taskId); } catch (e) { state = null; }
      if (!state) continue;
      if (state.detail) say(state.detail);
      if (state.phase === 'done') return { ok: true };
      if (state.phase === 'failed') return { ok: false, error: state.error || 'Starting the container failed.' };
      // 'idle' means the record expired (a start older than its TTL) — for a
      // caller that got here it can only mean the start already finished.
      if (state.phase === 'idle') return { ok: true };
    }
  }

  window.lzEnsureContainer = function (taskId, onProgress) {
    const running = inflight.get(taskId);
    if (running) {
      if (typeof onProgress === 'function') running.listeners.push(onProgress);
      return running.promise;
    }
    const listeners = typeof onProgress === 'function' ? [onProgress] : [];
    const entry = { listeners: listeners, promise: null };
    entry.promise = ensure(taskId, function (detail) {
      for (let i = 0; i < entry.listeners.length; i++) {
        try { entry.listeners[i](detail); } catch (e) { /* one panel's render must not stop the others */ }
      }
    }).then(
      (r) => { inflight.delete(taskId); return r; },
      (e) => {
        inflight.delete(taskId);
        return { ok: false, error: e && e.message ? e.message : String(e) };
      },
    );
    inflight.set(taskId, entry);
    return entry.promise;
  };
})();
</script>`;
}
