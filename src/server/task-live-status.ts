/**
 * Live freshness payload + poll island for the task page.
 *
 * Watch streams agent output into an xterm; it never updates the page chrome
 * (status badge, action buttons, tab bodies). The old fix was a whole-page
 * `<meta http-equiv="refresh">` every 5s — that answered "has anything
 * changed?" and never "what is the agent doing", so Watch replaced it. This
 * island is the missing half: a cheap JSON poll that no-ops when nothing moved.
 *
 * The first version of the island had one token and one reaction, and both were
 * wrong in the same way — too coarse. Knowing and showing are separate now:
 *
 *  - KNOWING is per region (`src/server/task-live-regions.ts`): the payload
 *    carries one key per region, so a cluster task that stays `working` while it
 *    accepts subtasks moves the `subtasks` key even though the header is
 *    unchanged. That blindness is why the Subtasks tab never refreshed at all.
 *  - SHOWING is per tab, and the policy is stamped on the tab link, not coded
 *    here: morph in place, append with the viewport pinned, a pill the reader
 *    chooses to act on, or never touch it.
 *
 * Nothing is deleted-and-refetched any more. A hidden cached body whose region
 * moved is marked stale and refetched WHEN THE READER SWITCHES TO IT, and the
 * tab strip shows a dot so a stale Subtasks tab is visible from Changes.
 */

import type { Task, Session } from '../types';
import { scriptJson } from './escape';
import {
  buildLiveRegionKeys,
  liveKeysToken,
  TASK_LIVE_REGION_IDS,
  type TaskLiveRegionId,
  type TaskLiveRegionInput,
} from './task-live-regions';

/** Same shape the task page stamps for the working progress line. */
export interface TaskLiveProgress {
  message: string;
  recordedAt: string;
}

/** Wire shape of `GET /tasks/:id/live-status`. */
export interface TaskLiveStatusPayload {
  /** Opaque compare key over every region — change means something moved. */
  token: string;
  /** One freshness key per region; the client diffs these to decide what to do. */
  keys: Record<TaskLiveRegionId, string>;
  /** Raw task.status. */
  status: string;
  /** What the header badge shows (session outcome when present). */
  display_status: string;
  progress: { message: string; recorded_at: string } | null;
  turns: number;
  last_active_at: number | null;
}

export interface TaskLiveStatusInput {
  task: Task;
  session: Session | null;
  progress?: TaskLiveProgress | null;
  turns: number;
}

/** Everything the region keys need on top of the header inputs. */
export type TaskLiveRegionSources = Omit<TaskLiveRegionInput, 'headerKey'>;

/**
 * Same rule as `getTaskStatus` in templates.ts — duplicated here so this
 * module does not import the templates bag (which pulls mermaid and the rest
 * of the page renderers) just for three lines.
 */
function displayStatusOf(task: Task, session: Session | null): string {
  if (session) {
    return session.outcome ?? (session.ended_at ? 'ended' : task.status);
  }
  return task.status;
}

/**
 * The HEADER region's key: status badge, live progress line, turn/activity
 * counts. This is what the whole-page token used to be, and it is still
 * exactly the set of fields the always-on header renders.
 *
 * Deliberately a plain join (not a hash): tests assert equality and
 * inequality without round-tripping through a digest.
 */
export function buildLiveStatusToken(input: TaskLiveStatusInput): string {
  const display = displayStatusOf(input.task, input.session);
  const progress = input.progress;
  // No NUL / control bytes — the token is stamped into a data-* attribute.
  const progressPart = progress
    ? `${encodeURIComponent(progress.message)}@${progress.recordedAt}`
    : '';
  const lastActive =
    input.session?.last_interaction_at ?? input.session?.started_at ?? 0;
  return [
    input.task.status,
    display,
    progressPart,
    String(input.turns),
    String(lastActive),
  ].join('|');
}

/** Every region key for a task, header included. */
export function buildLiveStatusKeys(
  input: TaskLiveStatusInput,
  sources: TaskLiveRegionSources,
): Record<TaskLiveRegionId, string> {
  return buildLiveRegionKeys({ ...sources, headerKey: buildLiveStatusToken(input) });
}

export function buildLiveStatusPayload(
  input: TaskLiveStatusInput,
  sources?: TaskLiveRegionSources,
): TaskLiveStatusPayload {
  const progress = input.progress ?? null;
  const empty: TaskLiveRegionSources = {
    children: [],
    turns: [],
    comments: [],
    journal: [],
    raised: [],
    commits: [],
    headSha: null,
  };
  const keys = buildLiveStatusKeys(input, sources ?? empty);
  return {
    token: sources ? liveKeysToken(keys) : buildLiveStatusToken(input),
    keys,
    status: input.task.status,
    display_status: displayStatusOf(input.task, input.session),
    progress: progress
      ? { message: progress.message, recorded_at: progress.recordedAt }
      : null,
    turns: input.turns,
    last_active_at:
      input.session?.last_interaction_at ?? input.session?.started_at ?? null,
  };
}

/**
 * Client island: poll the region keys, then apply each tab's own policy.
 *
 * Cadence mirrors the review island (3s while the task is moving, 10s
 * otherwise). A full-page reload is never used except the long-standing
 * "fragment shape drifted" fallback.
 */
export function taskLiveStatusScript(): string {
  return `<script>
(function () {
  if (window.__lzLiveStatusWired) return;
  window.__lzLiveStatusWired = true;

  var ROOT = '[data-lz-task-page]';
  var HEADER = '.lz-landing-header';
  var STRIP = '[data-lz-tab-strip]';
  var BODY = '[data-lz-tab-body]';
  var HOST = '[data-lz-tab-bodies]';
  var WATCH = '.lz-watch';
  var TERMINAL_STATUS = { complete: 1, abandoned: 1 };
  var REGION_IDS = ${scriptJson([...TASK_LIVE_REGION_IDS])};
  // How long after the reader's last scroll a region still counts as "being
  // read". Patching under a moving viewport is the jarring case this avoids.
  var SCROLL_QUIET_MS = 2000;
  var NEW_CONTENT = ' — new content';

  /** tabId -> 1 for tabs whose body is behind. Survives strip replacement. */
  var staleTabs = {};
  var lastScrollAt = 0;
  /** A body we fetched but could not apply yet because the reader was busy. */
  var deferred = null;
  var deferTimer = null;

  window.addEventListener('scroll', function () { lastScrollAt = Date.now(); }, true);

  function page() { return document.querySelector(ROOT); }

  // A tab body's identity is the task's CANONICAL segment — the code when the
  // code is unique, the id otherwise, the same value the server stamps into
  // data-lz-task-id and every data-lz-tab-path (task-page.ts) — never the
  // browser address. The task page is reachable at BOTH /tasks/<code> and
  // /tasks/<id> (an id permalink resolves; a code shared by two tasks falls
  // back to the id), and comparing a code-spelled link against a uuid-stamped
  // body — or the reverse — is exactly what made the first round-trip append
  // a second landing body and hide the original, with any live terminal,
  // drafts and the reading position in it. History entries keep their own
  // spelling (the address bar is never rewritten), so every comparison below
  // goes through this: swap the first /tasks/ segment for data-lz-task-id,
  // keep the rest. Keep in sync with the same helper in task-tabs.ts.
  function canonicalTaskPath(path) {
    var p = page();
    if (!p) return path;
    var seg = p.getAttribute('data-lz-task-id');
    if (!seg) return path;
    var m = path.match(/^\\/tasks\\/([^\\/?#]*)(.*)$/);
    if (!m) return path;
    return '/tasks/' + seg + (m[2] || '');
  }

  function fragmentUrl(href, wantBody) {
    var url = new URL(href, location.origin);
    url.searchParams.set('fragment', '1');
    // Ask for the header too — plain ?fragment=1 is strip+body for tab switch.
    url.searchParams.set('chrome', '1');
    // The Changes tab body is a full diff render. Asking for it on every
    // subtask accept, only to throw it away because the policy is "pill",
    // would make a background poll the most expensive request on the page.
    if (!wantBody) url.searchParams.set('body', '0');
    return url.pathname + url.search + url.hash;
  }

  function tabLinks() {
    return Array.prototype.slice.call(document.querySelectorAll('a[data-lz-tab]'));
  }

  function linkFor(tabId) {
    var links = tabLinks();
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-lz-tab') === tabId) return links[i];
    }
    return null;
  }

  function regionsFor(tabId) {
    var link = linkFor(tabId);
    var raw = link ? (link.getAttribute('data-lz-tab-regions') || '') : '';
    return raw ? raw.split(/\\s+/) : [];
  }

  function policyFor(tabId) {
    var link = linkFor(tabId);
    return (link && link.getAttribute('data-lz-tab-policy')) || 'morph';
  }

  function currentTabId() {
    var p = page();
    return p ? (p.getAttribute('data-lz-current-tab') || '') : '';
  }

  function intersects(list, changed) {
    for (var i = 0; i < list.length; i++) {
      if (changed[list[i]]) return true;
    }
    return false;
  }

  function storedKeys() {
    var p = page();
    if (!p) return {};
    try { return JSON.parse(p.getAttribute('data-lz-live-keys') || '{}') || {}; }
    catch (e) { return {}; }
  }

  function stampKeys(payload) {
    var p = page();
    if (!p || !payload) return;
    if (payload.token) p.setAttribute('data-lz-live-token', payload.token);
    if (payload.keys) p.setAttribute('data-lz-live-keys', JSON.stringify(payload.keys));
  }

  function changedSet(before, after) {
    var out = {};
    if (!after) return out;
    for (var i = 0; i < REGION_IDS.length; i++) {
      var id = REGION_IDS[i];
      if ((before[id] || '') !== (after[id] || '')) out[id] = 1;
    }
    return out;
  }

  /**
   * A body carrying a live shell session, whatever tab it lives on. Verify and
   * Shell already dodge this whole path via \`policy: 'never'\`, but the
   * down-service notice's own terminal mounts on the LANDING tab (serve-notice.ts),
   * which morphs on a poll like any other tab body — \`data-lz-live-children\`
   * (dom-morph.ts) makes a MORPH of such a body safe, but staleness marking
   * still led to it being torn down and refetched wholesale on a later tab
   * switch (task-tabs.ts's applyFragment), which a morph marker cannot help
   * with. So this body must never be stale-marked, and must never be treated
   * as "busy" purely because xterm's hidden helper textarea holds focus the
   * moment a terminal opens — it always morphs safely instead.
   */
  function hostsLiveShell(body) {
    return !!(body && body.querySelector && body.querySelector('.lz-shell-mount.is-live'));
  }

  // --- strip dots -----------------------------------------------------------

  function markStrip() {
    // The tab being READ never wears a dot: the pill is its affordance, and a
    // dot on the tab you are looking at says nothing you can act on. It stays
    // in staleTabs regardless, so leaving and coming back still refetches.
    var cur = currentTabId();
    var links = tabLinks();
    for (var i = 0; i < links.length; i++) {
      var tab = links[i].getAttribute('data-lz-tab') || '';
      if (staleTabs[tab] && tab !== cur) {
        links[i].setAttribute('data-lz-stale', '1');
        // markStrip runs again on every poll and on every tab switch, and the
        // strip is only sometimes replaced — appending unconditionally would
        // grow the tooltip a suffix at a time.
        var title = links[i].getAttribute('title') || tab;
        if (title.indexOf(NEW_CONTENT) === -1) links[i].setAttribute('title', title + NEW_CONTENT);
      } else {
        links[i].removeAttribute('data-lz-stale');
      }
    }
  }

  function markStaleBodies() {
    var host = document.querySelector(HOST);
    if (!host) return;
    var bodies = Array.prototype.slice.call(host.querySelectorAll(BODY));
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      var path = b.getAttribute('data-lz-tab-path') || '';
      var link = null;
      var links = tabLinks();
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute('href') || '';
        try {
          if (new URL(href, location.origin).pathname === path) { link = links[j]; break; }
        } catch (e) { /* a malformed tab href is not a body we can match */ }
      }
      if (!link) continue;
      var tab = link.getAttribute('data-lz-tab') || '';
      var policy = link.getAttribute('data-lz-tab-policy') || 'morph';
      // Shell and Verify host live terminals. Marking them stale would make
      // the next switch destroy a running session.
      if (policy === 'never') continue;
      // A morph-policy tab (landing) can ALSO host one now — the down-service
      // notice's own terminal. Same reasoning, same guard.
      if (hostsLiveShell(b)) continue;
      if (staleTabs[tab] && b.hidden) b.setAttribute('data-lz-stale', '1');
    }
  }

  function tabShown(tabId) {
    if (!tabId) return;
    delete staleTabs[tabId];
    markStrip();
    hidePill();
  }

  /**
   * The visible body now matches the server. Only the paths that actually
   * patched the DOM may call this.
   */
  function markCurrentFresh() {
    var cur = currentTabId();
    if (cur) delete staleTabs[cur];
    var body = document.querySelector(BODY + ':not([hidden])');
    if (body) body.removeAttribute('data-lz-stale');
    markStrip();
  }

  /**
   * The change was OFFERED but not applied — a pill the reader ignored, or an
   * update the interaction guard held back. The body is BEHIND, so say so.
   *
   * Forgetting this was the whole bug: the keys get stamped either way, so
   * \`changedRegions\` never names that region again for the same commit. A
   * reader who declined the reload on Changes and switched tabs came back to
   * the pre-change diff with no pill and no dot, and only a full page reload
   * healed it — the original complaint in a narrower form.
   */
  function markCurrentStale() {
    var cur = currentTabId();
    if (!cur || policyFor(cur) === 'never') return;
    var body = document.querySelector(BODY + ':not([hidden])');
    if (hostsLiveShell(body)) return;
    staleTabs[cur] = 1;
    if (body) body.setAttribute('data-lz-stale', '1');
    markStrip();
  }

  window.lzLiveRegions = { markStrip: markStrip, tabShown: tabShown };

  // --- the pill -------------------------------------------------------------

  function pillEl() {
    var el = document.querySelector('[data-lz-live-pill]');
    if (el) return el;
    el = document.createElement('button');
    el.type = 'button';
    el.className = 'lz-live-pill';
    el.setAttribute('data-lz-live-pill', '');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  function showPill(text, action) {
    var el = pillEl();
    el.textContent = text;
    el.hidden = false;
    el.onclick = function () {
      hidePill();
      if (action) action();
    };
  }

  function hidePill() {
    var el = document.querySelector('[data-lz-live-pill]');
    if (el) el.hidden = true;
  }

  function reloadCurrentTab() {
    var body = document.querySelector(BODY + ':not([hidden])');
    if (body) body.setAttribute('data-lz-stale', '1');
    if (typeof window.lzSwitchTaskTab === 'function') {
      window.lzSwitchTaskTab(location.pathname + location.search, false);
    }
  }

  // --- interaction guard ----------------------------------------------------

  /**
   * Is the reader working inside this region right now? Focus in a field, a
   * live text selection, or a scroll in the last couple of seconds all mean
   * "not now". A draft in a textarea is never worth a redraw.
   */
  function busy(el) {
    if (!el) return false;
    if (Date.now() - lastScrollAt < SCROLL_QUIET_MS) return true;
    var a = document.activeElement;
    if (a && a !== document.body && el.contains(a)) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) return true;
    }
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) return true;
    return false;
  }

  // --- morphing -------------------------------------------------------------

  /** Topmost item still on screen, so the viewport can be pinned to it. */
  function anchorOf(container) {
    var nodes = container.querySelectorAll('[data-viewed-key],[data-lz-key],[id]');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.bottom > 0) return { node: nodes[i], top: r.top };
    }
    return null;
  }

  function applyBody(body, nextBody, policy) {
    if (!body || !nextBody || typeof window.lzMorph !== 'function') return;
    var anchor = anchorOf(body);
    window.lzMorph(body, nextBody);
    var shifted = 0;
    if (anchor && anchor.node.isConnected) {
      shifted = anchor.node.getBoundingClientRect().top - anchor.top;
      // Items landed above what the reader was looking at (these lists are
      // newest-first). Pin the viewport rather than shoving it down.
      if (Math.abs(shifted) > 1) window.scrollBy(0, shifted);
    }
    // The morph wrote the SERVER's markup over a body other islands had
    // already written into. \`annotateProse\` adds \`.rv-prose-block\`, the
    // data-file/side/line attributes and the "Ask or comment on this line"
    // button; none of that is in the server's HTML, so the morph just removed
    // it. Re-running is how the "+" affordance and the thread anchors come
    // back — it is idempotent, and without it a reviewer on Summary silently
    // loses the ability to comment on a line and watches existing threads jump
    // into the orphan box.
    if (window.lzAnnotateProse) {
      try { window.lzAnnotateProse(); }
      catch (e) { if (window.console) console.warn('could not re-annotate prose after a live update', e); }
    }
    // The morph wrote the server's markup over an open comment box's DOM
    // too — restoreDrafts/unhidePresentAsk are what bring an in-progress
    // draft and its present-ask buttons back; without this they sit missing
    // until the next 10s poll tick does it instead.
    if (window.lzRestoreDrafts) {
      try { window.lzRestoreDrafts(); }
      catch (e) { if (window.console) console.warn('could not restore drafts after a live update', e); }
    }
    // A mermaid diagram's rendered SVG is not in the server's markup either
    // (mermaidEnhanceScript replaces the raw fence client-side) — the morph
    // reverts it to source, dropping the data-lz-mermaid-claimed marker
    // along with it, so re-running is what makes the diagram come back
    // rather than sitting as a code fence until the reader reloads.
    if (window.lzRefreshMermaid) {
      try { window.lzRefreshMermaid(); }
      catch (e) { if (window.console) console.warn('could not re-render diagrams after a live update', e); }
    }
    if (window.lzRefreshViewable) window.lzRefreshViewable();
    // The morph put the Subtasks rows back in server order and dropped the
    // header's aria-sort; re-apply the sort the reader chose.
    if (window.lzRefreshSubtasksSort) {
      try { window.lzRefreshSubtasksSort(); }
      catch (e) { if (window.console) console.warn('could not re-sort subtasks after a live update', e); }
    }
    if (policy === 'append' && Math.abs(shifted) > 1) {
      showPill('New content above', function () {
        body.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function scheduleDeferred() {
    if (deferTimer !== null) return;
    deferTimer = setTimeout(function () {
      deferTimer = null;
      flushDeferred();
    }, 1500);
  }

  function flushDeferred() {
    if (!deferred) return;
    var body = document.querySelector(BODY + ':not([hidden])');
    // Canonical on both sides: the reader may be sitting on the OTHER
    // spelling of the same tab (a /tasks/<uuid> entry reached by Back), and
    // dropping the parked fragment there would lose an update the reader is
    // exactly in place to receive. The tab it was parked for is marked stale
    // at defer time, so a genuine move-on still refetches on switch.
    if (!body || deferred.path !== canonicalTaskPath(location.pathname)) {
      // The reader moved on before we could apply it. Dropping the fragment
      // loses nothing: the tab it was parked for was marked stale when we
      // deferred, so switching back refetches it.
      deferred = null;
      return;
    }
    if (busy(body) && !document.hidden) { scheduleDeferred(); return; }
    var pending = deferred;
    deferred = null;
    hidePill();
    applyBody(body, pending.node, pending.policy);
    markCurrentFresh();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) flushDeferred();
  });

  // --- chrome ---------------------------------------------------------------

  /**
   * Swap the always-on header. An open Watch panel is transplanted so its
   * WebSocket and xterm survive; a closed Watch is left to the new markup
   * and re-wired below.
   */
  function swapHeader(nextHeader) {
    var cur = document.querySelector(HEADER);
    if (!cur || !nextHeader) return;
    var oldWatch = cur.querySelector(WATCH + '.is-open');
    cur.replaceWith(nextHeader);
    if (oldWatch) {
      var fresh = nextHeader.querySelector(WATCH);
      if (fresh) fresh.replaceWith(oldWatch);
      else nextHeader.querySelector('.action-links') &&
        nextHeader.querySelector('.action-links').appendChild(oldWatch);
    } else if (typeof window.lzWireWatch === 'function') {
      window.lzWireWatch();
    }
  }

  /**
   * Keep a badge the incoming strip does not carry.
   *
   * A \`body=0\` poll renders the strip WITHOUT the data the omitted body would
   * have loaded, and two badges are computed from exactly that data: the
   * region count, and the Verify x/y. Letting the new strip win made them
   * vanish a few seconds after opening those tabs — and an absent badge reads
   * as "none", which is worse than a slightly stale number. A badge the server
   * DID render always wins; this only fills a gap.
   */
  function carryBadgesForward(oldStrip, nextStrip) {
    if (!oldStrip || !nextStrip) return;
    var olds = oldStrip.querySelectorAll('a[data-lz-tab]');
    for (var i = 0; i < olds.length; i++) {
      var badge = olds[i].querySelector('.lz-tab-badge');
      if (!badge) continue;
      var tab = olds[i].getAttribute('data-lz-tab');
      if (!tab) continue;
      var fresh = nextStrip.querySelector('a[data-lz-tab="' + tab + '"]');
      if (!fresh || fresh.querySelector('.lz-tab-badge')) continue;
      fresh.appendChild(document.createTextNode(' '));
      fresh.appendChild(badge.cloneNode(true));
    }
  }

  function updateStatusBar(payload) {
    var el = document.querySelector('[data-rv-sb="status"]');
    if (el && payload && payload.display_status) {
      el.textContent = 'status: ' + payload.display_status;
    }
    var bar = document.getElementById('rv-statusbar');
    if (bar && payload && payload.status) {
      // Ask-availability flips with status; leave reason empty until the
      // review poll (when present) fills the precise refusal — better a
      // stale reason than a wrong one invented here.
      var askable = payload.status === 'blocked' || payload.status === 'conflict';
      bar.dataset.rvAskable = askable ? '1' : '0';
      if (askable) bar.dataset.rvAskReason = '';
    }
  }

  function applyChrome(html, payload, changed, wantBody) {
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var nextHeader = wrap.querySelector(HEADER);
    var nextStrip = wrap.querySelector(STRIP);
    var nextBody = wrap.querySelector(BODY);
    var curStrip = document.querySelector(STRIP);
    if (!nextHeader || !nextStrip || !curStrip || (wantBody && !nextBody)) {
      // Fragment shape drifted — fall back to a real navigation rather than
      // half-updating the page.
      location.reload();
      return;
    }
    var cur = currentTabId();
    swapHeader(nextHeader);
    carryBadgesForward(curStrip, nextStrip);
    curStrip.replaceWith(nextStrip);
    // The strip was just replaced and the header may have grown or shrunk, so
    // the height sticky card headers park under is re-measured — the same call
    // the tab-switch island makes after its own strip swap.
    if (window.lzRefreshStickyTop) window.lzRefreshStickyTop();
    var p = page();
    if (p) {
      stampKeys(payload);
      var currentTab = nextStrip.querySelector('.lz-tab-current');
      if (currentTab) {
        cur = currentTab.getAttribute('data-lz-tab') || cur;
        p.setAttribute('data-lz-current-tab', cur);
      }
    }
    updateStatusBar(payload);

    // Every tab but the one being read: remember it is behind, show a dot,
    // and let the switch refetch it. Nothing is deleted eagerly.
    var links = tabLinks();
    for (var i = 0; i < links.length; i++) {
      var tab = links[i].getAttribute('data-lz-tab') || '';
      if (tab === cur) continue;
      if (links[i].getAttribute('data-lz-tab-policy') === 'never') continue;
      var raw = links[i].getAttribute('data-lz-tab-regions') || '';
      if (raw && intersects(raw.split(/\\s+/), changed)) staleTabs[tab] = 1;
    }
    markStrip();
    markStaleBodies();

    // The tab being READ. Its staleness is cleared by ONE thing only —
    // actually patching the body — so a change the reader declined or that we
    // held back stays marked and the switch-time refetch heals it.
    if (!intersects(regionsFor(cur), changed)) return;
    var body = wantBody && nextBody
      ? document.querySelector(BODY + ':not([hidden])')
      : null;
    if (!body) {
      // A \`pill\` tab (never swapped under the reader), or a body we did not
      // fetch or cannot find. Either way this tab is behind.
      markCurrentStale();
      return;
    }
    var policy = policyFor(cur);
    // A live shell session's own xterm helper textarea holds focus the moment
    // the terminal opens, which busy()'s "focus is in a form field" rule reads
    // as "the reader is typing" — deferring behind a pill for a body that
    // data-lz-live-children already makes safe to morph outright.
    if (busy(body) && !document.hidden && !hostsLiveShell(body)) {
      deferred = { node: nextBody, policy: policy, path: canonicalTaskPath(location.pathname) };
      markCurrentStale();
      showPill('Updated — tap to refresh', flushDeferred);
      scheduleDeferred();
      return;
    }
    applyBody(body, nextBody, policy);
    markCurrentFresh();
  }

  function refreshChrome(payload, changed) {
    var cur = currentTabId();
    var policy = policyFor(cur);
    var regions = regionsFor(cur);
    // The visible body is only worth fetching when its own regions moved AND
    // its policy lets it be patched in place.
    var wantBody = (policy === 'morph' || policy === 'append') && intersects(regions, changed);
    if (policy === 'pill' && intersects(regions, changed)) {
      showPill(cur === 'changes' ? 'Changes updated — reload' : 'Updated — reload', reloadCurrentTab);
    }
    var href = location.pathname + location.search;
    return fetch(fragmentUrl(href, wantBody), {
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) { applyChrome(html, payload, changed, wantBody); });
  }

  // --- poll -----------------------------------------------------------------

  var timer = null;
  var inFlight = false;

  function schedule(fast) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(tick, fast ? 3000 : 10000);
  }

  function tick() {
    timer = null;
    var p = page();
    if (!p) return;
    var taskId = p.getAttribute('data-lz-task-id');
    if (!taskId) return;
    flushDeferred();
    if (inFlight) { schedule(false); return; }
    inFlight = true;
    // data-lz-task-id holds the URL-ESCAPED segment — interpolate raw; a
    // second escape turns %20 into %2520, a different address.
    fetch('/tasks/' + taskId + '/live-status', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        if (!payload || !payload.token) {
          inFlight = false;
          schedule(false);
          return;
        }
        var known = p.getAttribute('data-lz-live-token') || '';
        if (payload.token !== known) {
          var changed = changedSet(storedKeys(), payload.keys || {});
          return refreshChrome(payload, changed).then(function () {
            inFlight = false;
            if (TERMINAL_STATUS[payload.status]) return; // stop polling
            schedule(payload.status === 'working');
          }).catch(function () {
            inFlight = false;
            schedule(false);
          });
        }
        inFlight = false;
        if (TERMINAL_STATUS[payload.status]) return;
        schedule(payload.status === 'working' || !!payload.progress);
      })
      .catch(function () {
        inFlight = false;
        schedule(false);
      });
  }

  // Kick off after the rest of the page islands have wired (tab switch,
  // watch). A short delay also avoids racing the first paint.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { schedule(true); });
  } else {
    schedule(true);
  }
})();
</script>`;
}
